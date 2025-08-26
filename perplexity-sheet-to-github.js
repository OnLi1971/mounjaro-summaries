require('dotenv').config({ path: './summaries.env' });
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const axios = require('axios');
const cheerio = require('cheerio');
const { Octokit } = require('@octokit/rest');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const normalizeUrl = require('normalize-url');

const perplexityApiKey = process.env.PERPLEXITY_API_KEY;
const githubToken = process.env.GITHUB_TOKEN;

const owner = 'OnLi1971';
const repo = 'mounjaro-summaries';
const branch = 'main';
const summariesDir = 'summaries';

// Google Sheets
const SPREADSHEET_ID = process.env.SHEET_ID || '1KgrYXHpVfTAGQZT6f15aARGCQ-qgNQZM4HWQCiqt14s';
const SHEET_NAME = process.env.SHEET_NAME || '';
const RANGE = 'D2:D';

// Auth (Sheets)
const auth = new google.auth.GoogleAuth({
  keyFile: 'google-service-account.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});

// ---------- Sheets helpers ----------
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
  const common = titles.find(t => t === 'List1' || t === 'List 1' || t === 'Sheet1');
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
// ------------------------------------

// ---------- Fetch & extract ----------
const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,cs;q=0.8',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Upgrade-Insecure-Requests': '1',
  'Referer': 'https://news.google.com/',
};

function buildUrlVariants(url) {
  const variants = new Set();
  try {
    variants.add(
      normalizeUrl(url, {
        removeTrailingSlash: false,
        stripHash: true,
        sortQueryParameters: false,
      })
    );
  } catch {
    variants.add(url);
  }
  const u = new URL([...variants][0]);
  const segs = u.pathname.split('/');
  const last = segs.filter(Boolean).pop() || '';
  const noExt = last && !last.includes('.');
  if (noExt && !u.pathname.endsWith('/')) {
    const u2 = new URL(u.toString());
    u2.pathname = u.pathname + '/';
    variants.add(u2.toString());
  }
  const u3 = new URL(u.toString());
  u3.searchParams.delete('rss');
  for (const k of Array.from(u3.searchParams.keys())) {
    if (k.startsWith('utm_') || k === 'fbclid' || k === 'gclid') u3.searchParams.delete(k);
  }
  variants.add(u3.toString());
  return [...variants];
}

async function fetchHtml(url) {
  const variants = buildUrlVariants(url);
  let lastErr;
  for (const v of variants) {
    try {
      const res = await axios.get(v, {
        headers: BROWSER_HEADERS,
        maxRedirects: 5,
        timeout: 30000,
        validateStatus: () => true,
      });
      if (res.status >= 200 && res.status < 300 && res.data) {
        return { html: res.data, finalUrl: v };
      }
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Fetch failed');
}

function extractArticle(html, baseUrl) {
  try {
    const dom = new JSDOM(html, { url: baseUrl });
    const doc = dom.window.document;
    const reader = new Readability(doc).parse();
    if (reader && reader.textContent && reader.textContent.trim().length > 400) {
      const title =
        reader.title?.trim() ||
        doc.querySelector('meta[property="og:title"]')?.content?.trim() ||
        doc.title?.trim() ||
        'Shrnutí článku';
      const text = reader.textContent.replace(/\n{3,}/g, '\n\n').trim();
      return { title, text };
    }
  } catch (_) {}
  const $ = cheerio.load(html);
  const title =
    $('meta[property="og:title"]').attr('content')?.trim() ||
    $('title').text().trim() ||
    'Shrnutí článku';
  let text = $('meta[name="description"]').attr('content')?.trim() || '';
  if (text.length < 400) {
    let acc = '';
    $('p').each((_, el) => {
      const t = $(el).text().trim();
      if (t) acc += t + '\n';
      if (acc.length > 7000) return false;
    });
    text = acc.trim();
  }
  return { title, text };
}

function splitSentences(str) {
  return String(str)
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-ZÁČĎÉĚÍĽĹŇÓÔŘŠŤÚŮÝŽ])/u)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

function fallbackFromText(title, text, url) {
  const sentences = splitSentences(text);
  // vyber 6–8 „delších“ vět
  const ranked = [...sentences].sort((a, b) => b.length - a.length).slice(0, 8);
  const teaser = sentences[0]?.slice(0, 200) || '';
  const markdown =
    (teaser ? `${teaser}\n\n` : '') + ranked.map(s => `- ${s}`).join('\n');
  return {
    title: title || `Shrnutí: ${domainFromUrl(url)}`,
    markdown,
  };
}
// ------------------------------------

// ---------- Perplexity ----------
async function getSummaryPerplexity(text) {
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
    parsed = { title: 'Shrnutí článku', bullets: raw.split('\n').filter(Boolean).slice(0, 8), teaser: '' };
  }
  const title = String(parsed.title || 'Shrnutí článku').trim();
  const bullets = Array.isArray(parsed.bullets) ? parsed.bullets : [];
  const teaser = String(parsed.teaser || '').trim();
  const markdown =
    (teaser ? `${teaser}\n\n` : '') + bullets.map(b => `- ${b}`.replace(/\s+/g, ' ')).join('\n');

  return { title, markdown };
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

// ---------- Static site (docs/) ----------
const DOCS_DIR = path.join(process.cwd(), 'docs');
const POSTS_JSON = path.join(DOCS_DIR, 'posts.json');
const INDEX_HTML = path.join(DOCS_DIR, 'index.html');
const STYLES_CSS = path.join(DOCS_DIR, 'styles.css');

function ensureDocs() {
  fs.mkdirSync(DOCS_DIR, { recursive: true });
  if (!fs.existsSync(STYLES_CSS)) {
    fs.writeFileSync(
      STYLES_CSS,
      'body{font:16px/1.6 system-ui,Segoe UI,Roboto,Arial;margin:0;padding:24px}\n.container{max-width:900px;margin:0 auto}\n.list{display:grid;gap:14px}\n.card{background:#fafafa;border:1px solid #eee;border-radius:14px;padding:16px}\n.card h2{margin:0 0 6px;font-size:18px}\n.card .meta{color:#666;font-size:13px;margin-bottom:8px}\n.card a.btn{display:inline-block;margin-right:8px;font-size:14px;padding:6px 10px;border-radius:10px;border:1px solid #ddd;text-decoration:none;color:#111}\n.card a.btn.primary{border-color:#2563eb;color:#2563eb}\n',
      'utf8'
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
  fs.writeFileSync(POSTS_JSON, JSON.stringify(posts.slice(0, 200), null, 2), 'utf8');
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderIndex(posts) {
  const cards = posts.map(p => `
  <article class="card">
    <h2>${escapeHtml(p.title)}</h2>
    <div class="meta">${p.date} · <a href="${p.sourceUrl}" target="_blank" rel="noopener">Zdroj</a></div>
    <div class="actions">
      <a class="btn primary" href="${p.sourceUrl}" target="_blank" rel="noopener">Přečíst zdroj</a>
      <a class="btn" href="${p.summaryUrl}" target="_blank" rel="noopener">Plné shrnutí (GitHub)</a>
    </div>
  </article>`).join('\n');

  const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agregátor shrnutí</title>
<link rel="stylesheet" href="./styles.css">
<div class="container">
  <h1>Agregátor shrnutí</h1>
  <div class="list">
    ${cards || '<p>Ještě tu nic není.</p>'}
  </div>
</div>`;
  fs.writeFileSync(INDEX_HTML, html, 'utf8');
}

async function updateWebsite({ title, sourceUrl, summaryUrl, date }) {
  ensureDocs();
  const posts = readPosts().filter(p => p.sourceUrl !== sourceUrl);
  posts.unshift({ title, sourceUrl, summaryUrl, date });
  writePosts(posts);
  renderIndex(posts);
}
// -----------------------------------------

function domainFromUrl(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; }
}

async function run() {
  // skeleton, ať Pages žije i bez nových článků
  ensureDocs();
  if (!fs.existsSync(POSTS_JSON)) fs.writeFileSync(POSTS_JSON, '[]', 'utf8');
  renderIndex(readPosts());

  const urls = await getUrlsFromSheet();
  if (!urls.length) {
    console.log('Ve sloupci D nejsou žádné URL – končím.');
    return;
  }

  for (const url of urls) {
    if (!/^https?:\/\//i.test(url)) continue;

    try {
      console.log(`Stahuji článek: ${url}`);
      const { html, finalUrl } = await fetchHtml(url);

      const { title: extractedTitle, text } = extractArticle(html, finalUrl);
      const targetUrl = finalUrl || url;

      let title, markdown;

      if (!text || text.trim().length < 300) {
        console.warn('Text prázdný/krátký – použiji fallback bez LLM.');
        ({ title, markdown } = fallbackFromText(extractedTitle, text || '', targetUrl));
      } else {
        console.log('Posílám na Perplexity API…');
        try {
          ({ title, markdown } = await getSummaryPerplexity(text));
        } catch (e) {
          console.warn('Perplexity selhalo – použiji fallback bez LLM:', e?.message || e);
          ({ title, markdown } = fallbackFromText(extractedTitle, text, targetUrl));
        }
      }

      console.log('Ukládám Markdown do repa…');
      const { webUrl } = await saveSummaryMarkdown({ title, markdown, url: targetUrl });

      console.log('Aktualizuji statický web (docs/)…');
      const todayISO = new Date().toISOString().slice(0, 10);
      await updateWebsite({
        title,
        sourceUrl: targetUrl,
        summaryUrl: webUrl,  // 🔗 vždy na existující .md
        date: todayISO,
      });

      console.log('Hotovo pro:', url);
    } catch (e) {
      console.error(`Chyba u ${url}:`, e?.message || e);
      // úplný fallback: vytvoř .md s informací o chybě, ať link nikdy nemíří na zdroj
      const title = `Odkaz: ${domainFromUrl(url)}`;
      const markdown = `Nepodařilo se stáhnout obsah článku pro automatické shrnutí.\n\nZkuste prosím původní zdroj: ${url}\n`;
      const { webUrl } = await saveSummaryMarkdown({ title, markdown, url });
      const todayISO = new Date().toISOString().slice(0, 10);
      await updateWebsite({
        title,
        sourceUrl: url,
        summaryUrl: webUrl,  // 🔗 na .md fallback
        date: todayISO,
      });
    }
  }
}

run();
