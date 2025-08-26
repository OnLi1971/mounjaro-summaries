require('dotenv').config({ path: './summaries.env' });
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const axios = require('axios');
const cheerio = require('cheerio');
const { Octokit } = require('@octokit/rest');

const perplexityApiKey = process.env.PERPLEXITY_API_KEY;
const githubToken = process.env.GITHUB_TOKEN;

const owner = 'OnLi1971';
const repo = 'mounjaro-summaries';
const branch = 'main';
const summariesDir = 'summaries';

// Google Sheets (SHEET_NAME volitelně; když prázdné, autodetekce)
const SPREADSHEET_ID = process.env.SHEET_ID || '1KgrYXHpVfTAGQZT6f15aARGCQ-qgNQZM4HWQCiqt14s';
const SHEET_NAME = process.env.SHEET_NAME || '';
const RANGE = 'D2:D'; // URL ve sloupci D od řádku 2

// Service account JSON je v rootu jako google-service-account.json (viz workflow)
const auth = new google.auth.GoogleAuth({
  keyFile: 'google-service-account.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});

// ---------- Google Sheets helpers ----------
function a1(title, range) {
  const safe = String(title || '').replace(/'/g, "''");
  return `'${safe}'!${range}`;
}
async function resolveSheetTitle(sheetsApi, spreadsheetId, preferredTitle) {
  const meta = await sheetsApi.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets(properties(title))',
  });
  const titles = meta.data.sheets?.map(s => s.properties.title) || [];
  if (!titles.length) throw new Error('Spreadsheet has no sheets.');
  if (preferredTitle && titles.includes(preferredTitle)) return preferredTitle;
  const common = titles.find(t => t === 'List1' || t === 'Sheet1');
  return common || titles[0];
}
async function getUrlsFromSheet() {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const title = await resolveSheetTitle(sheets, SPREADSHEET_ID, SHEET_NAME);
  const range = a1(title, RANGE);
  console.log('Reading range:', range);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
    majorDimension: 'ROWS',
  });
  const rows = res.data.values || [];
  return rows.map(r => (r?.[0] || '').toString().trim()).filter(Boolean);
}
// ------------------------------------------

// ---------- Scrape + LLM ----------
async function getArticleText(url) {
  const res = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SummarizerBot/1.0)' },
    timeout: 20000,
  });
  const $ = cheerio.load(res.data);
  let text = '';
  $('p').each((_, el) => (text += $(el).text() + '\n'));
  return text.slice(0, 6000);
}

async function getSummaryPerplexity(text) {
  // Požádáme o STROHÝ JSON: title + bullets + teaser
  const prompt = `
Vrátíš POUZE validní JSON bez jakéhokoli komentáře/markdownu ve tvaru:
{"title": "...", "bullets": ["...", "..."], "teaser": "..."}

Požadavky:
- "title": 1 stručný český nadpis (max 90 znaků, bez tečky na konci).
- "bullets": 6–8 stručných bodů (česky), bez číslování, bez odrážek v textu.
- "teaser": 1–2 věty (max 200 znaků) jako perex.
Text článku:
${text}
`.trim();

  const response = await axios.post(
    'https://api.perplexity.ai/v1/chat/completions',
    {
      model: 'pplx-7b-chat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 700,
      temperature: 0.4,
    },
    {
      headers: {
        Authorization: `Bearer ${perplexityApiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 60000,
    }
  );

  const raw = response.data.choices?.[0]?.message?.content ?? '';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // fallback: uděláme prostý titulek a body z textu, když JSON selže
    parsed = {
      title: 'Shrnutí článku',
      bullets: raw.split('\n').filter(Boolean).slice(0, 8),
      teaser: '',
    };
  }
  const title = String(parsed.title || 'Shrnutí článku').trim();
  const bullets = Array.isArray(parsed.bullets) ? parsed.bullets : [];
  const teaser = String(parsed.teaser || '').trim();
  const markdown =
    (teaser ? `${teaser}\n\n` : '') +
    bullets.map(b => `- ${b}`.replace(/\s+/g, ' ')).join('\n');

  return { title, bullets, teaser, markdown };
}
// -----------------------------------

// ---------- GitHub save ----------
const octokit = new Octokit({ auth: githubToken });

async function saveSummaryMarkdown({ title, markdown, url }) {
  const todayISO = new Date().toISOString().slice(0, 10);
  const randomStr = Math.random().toString(36).slice(2, 8);
  const fileName = `${summariesDir}/${todayISO}-${randomStr}.md`;

  const md = `# ${title}\n\nZdroj: [${url}](${url})\n\n${markdown}\n`;
  const content = Buffer.from(md, 'utf8').toString('base64');

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: fileName,
    message: `Add summary: ${title}`,
    content,
    branch,
  });

  return { fileName, webUrl: `https://github.com/${owner}/${repo}/blob/${branch}/${fileName}` };
}
// ----------------------------------

// ---------- Simple static site (docs/) ----------
const DOCS_DIR = path.join(process.cwd(), 'docs');
const POSTS_JSON = path.join(DOCS_DIR, 'posts.json');
const INDEX_HTML = path.join(DOCS_DIR, 'index.html');
const STYLES_CSS = path.join(DOCS_DIR, 'styles.css');

function ensureDocs() {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  if (!fs.existsSync(STYLES_CSS)) {
    fs.writeFileSync(
      STYLES_CSS,
      `
:root{--fg:#111;--muted:#666;--bg:#fff;--card:#fafafa;--accent:#2563eb;}
*{box-sizing:border-box}body{margin:0;font:16px/1.6 system-ui,Segoe UI,Roboto,Arial;color:var(--fg);background:var(--bg)}
.container{max-width:900px;margin:40px auto;padding:0 16px}
header{margin-bottom:24px}
h1{font-size:28px;margin:0 0 8px}
.list{display:grid;gap:14px}
.card{background:var(--card);border:1px solid #eee;border-radius:14px;padding:16px}
.card h2{margin:0 0 6px;font-size:18px}
.card .meta{color:var(--muted);font-size:13px;margin-bottom:8px}
.card a.btn{display:inline-block;margin-right:8px;font-size:14px;padding:6px 10px;border-radius:10px;border:1px solid #ddd;text-decoration:none;color:var(--fg)}
.card a.btn.primary{border-color:var(--accent);color:var(--accent)}
footer{margin:24px 0;color:var(--muted);font-size:13px}
      `.trim()
    );
  }
}

function readPosts() {
  if (!fs.existsSync(POSTS_JSON)) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(POSTS_JSON, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writePosts(posts) {
  // keep latest 200
  const trimmed = posts.slice(0, 200);
  fs.writeFileSync(POSTS_JSON, JSON.stringify(trimmed, null, 2), 'utf8');
}

function renderIndex(posts) {
  const cards = posts
    .map(
      p => `
  <article class="card">
    <h2>${escapeHtml(p.title)}</h2>
    <div class="meta">${p.date} · <a href="${p.sourceUrl}" target="_blank" rel="noopener">Zdroj</a></div>
    <div class="actions">
      <a class="btn primary" href="${p.sourceUrl}" target="_blank" rel="noopener">Přečíst zdroj</a>
      <a class="btn" href="${p.summaryUrl}" target="_blank" rel="noopener">Plné shrnutí (GitHub)</a>
    </div>
  </article>`
    )
    .join('\n');

  const html = `<!doctype html>
<html lang="cs">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agregátor shrnutí</title>
<link rel="stylesheet" href="./styles.css">
<body>
  <div class="container">
    <header>
      <h1>Agregátor shrnutí</h1>
      <div class="meta">Denní výběr článků s rychlým shrnutím</div>
    </header>
    <section class="list">
      ${cards || '<p>Ještě tu nic není.</p>'}
    </section>
    <footer>
      Generováno automaticky • <a href="https://github.com/${owner}/${repo}">repo</a>
    </footer>
  </div>
</body>
</html>`;
  fs.writeFileSync(INDEX_HTML, html, 'utf8');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function updateWebsite({ title, sourceUrl, summaryUrl, date }) {
  ensureDocs();
  const posts = readPosts();

  // dedupe podle sourceUrl (nejnovější na začátek)
  const filtered = posts.filter(p => p.sourceUrl !== sourceUrl);
  filtered.unshift({ title, sourceUrl, summaryUrl, date });

  writePosts(filtered);
  renderIndex(filtered);
}
// ---------------------------------------------

async function run() {
  const urls = await getUrlsFromSheet();
  if (!urls.length) {
    console.log('Ve sloupci D nejsou žádné URL – končím.');
    return;
  }

  for (const url of urls) {
    if (!/^https?:\/\//i.test(url)) continue;
    try {
      console.log(`Stahuji článek: ${url}`);
      const text = await getArticleText(url);

      if (!text || text.trim().length < 200) {
        console.warn('Vytažený text je prázdný/krátký – přeskočeno.');
        continue;
      }

      console.log('Posílám na Perplexity API…');
      const { title, markdown } = await getSummaryPerplexity(text);

      console.log('Ukládám Markdown do repa…');
      const { fileName, webUrl } = await saveSummaryMarkdown({ title, markdown, url });

      console.log('Aktualizuji statický web (docs/)…');
      const todayISO = new Date().toISOString().slice(0, 10);
      await updateWebsite({
        title,
        sourceUrl: url,
        summaryUrl: webUrl,
        date: todayISO,
      });

      // Commit index.html / posts.json / styles.css do repa přes API:
      // (nejjednodušší je přidat je do samotného repa a commitnout přes Actions git,
      // ale zůstanu u jednodušší varianty: necháme to na běžném git commit v jobu)
      console.log('Hotovo pro:', url, '→', fileName);
    } catch (e) {
      console.error(`Chyba u ${url}:`, e?.message || e);
    }
  }
}

run();
