// perplexity-sheet-to-github.js
require('dotenv').config({ path: './summaries.env' });
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const axios = require('axios');
const cheerio = require('cheerio');
const { Octokit } = require('@octokit/rest');

/** ====== KONFIG ====== **/
const perplexityApiKey = process.env.PERPLEXITY_API_KEY;
const githubToken = process.env.GITHUB_TOKEN;

const owner = "OnLi1971";
const repo = "mounjaro-summaries";
const branch = "main";
const summariesDir = "summaries";

const MAX_PER_RUN = 2;             // publikuj max 1–2 články na běh
const KEEP_POSTS = 200;            // na webu drž posledních N karet

// Google Sheets
const SPREADSHEET_ID = "1KgrYXHpVfTAGQZT6f15aARGCQ-qgNQZM4HWQCiqt14s";
const SHEET_NAME = "List 1"; // přesný název listu
// Čteme D..J, ať víme URL i Status/MD/ProcessedAt
const READ_RANGE = `${SHEET_NAME}!D2:J`;
// Zápis do H (Status), I (MD URL), J (ProcessedAt)
const STATUS_COL_INDEX = 5; // v našem načteném rozsahu D..J je H na pozici 5 (D,E,F,G,**H**,I,J)
const MDURL_COL_INDEX = 6;
const PROCESSED_COL_INDEX = 7;

// Google auth
const auth = new google.auth.GoogleAuth({
  keyFile: 'google-service-account.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// Axios UA + timeouty
const http = axios.create({
  timeout: 20000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (NewsBot/1.0; +https://github.com/OnLi1971/mounjaro-summaries)'
  }
});

/** ====== SHEETS – UTIL ====== **/
async function getSheetsClient() {
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

/**
 * Načte řádky D..J a vrátí kandidáty {row, url}
 * Bereme jen ty, kde ve sloupci H (Status) nic není.
 */
async function getPendingUrlRows() {
  const sheets = await getSheetsClient();
  console.log(`Reading range: '${SHEET_NAME}'!D2:J`);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: READ_RANGE,
  });
  const values = res.data.values || [];
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const rowNum = 2 + i;
    const row = values[i];
    const url = (row[0] || '').toString().trim();        // D
    const status = (row[STATUS_COL_INDEX - 1] || '').toString().trim(); // H
    if (!url) continue;
    if (status) continue; // už zpracováno
    out.push({ row: rowNum, url });
  }
  return out;
}

/**
 * Zapíše do H–J (Status, MD URL, ProcessedAt) na daný řádek.
 */
async function writeBackStatus(row, status, mdUrl) {
  try {
    const sheets = await getSheetsClient();
    const range = `${SHEET_NAME}!H${row}:J${row}`;
    const values = [[status || '', mdUrl || '', new Date().toISOString()]];
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range,
      valueInputOption: 'RAW',
      requestBody: { values }
    });
  } catch (e) {
    console.error(`Sheets write error (row ${row}):`, e.response?.data || e.message);
  }
}

/** ====== EXTRAKCE OBSAHU ====== **/
async function fetchArticle(url) {
  try {
    const res = await http.get(url);
    const html = res.data;
    const $ = cheerio.load(html);

    // title
    const title =
      $('meta[property="og:title"]').attr('content') ||
      $('meta[name="twitter:title"]').attr('content') ||
      $('h1').first().text().trim() ||
      $('title').first().text().trim() ||
      'Bez názvu';

    // text
    let text = '';
    $('article p, main p, .content p, p').each((_, el) => {
      const t = $(el).text().trim();
      if (t) text += t + '\n';
    });
    text = text.replace(/\n{3,}/g, '\n\n').trim();

    // source host
    let host = '';
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch {}

    // published date (best effort)
    const pub =
      $('meta[property="article:published_time"]').attr('content') ||
      $('time[datetime]').attr('datetime') || '';

    return {
      title: title.slice(0, 180),
      text: text.slice(0, 6000),
      sourceHost: host,
      html,
      publishedAt: pub
    };
  } catch (e) {
    const code = e.response?.status || 'ERR';
    throw new Error(`FETCH_${code}`);
  }
}

/** ====== PERPLEXITY ====== **/
async function getSummaryPerplexity(text) {
  if (!perplexityApiKey) throw new Error('PERPLEXITY_NO_KEY');
  const prompt = `Shrň následující článek do 6–8 bodů v češtině (stručně, srozumitelně, bez přídavných meta komentářů):\n\n${text}`;
  try {
    const response = await axios.post(
      'https://api.perplexity.ai/v1/chat/completions',
      {
        model: 'pplx-7b-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 600,
        temperature: 0.3
      },
      {
        headers: {
          Authorization: `Bearer ${perplexityApiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 25000
      }
    );
    const out = response.data?.choices?.[0]?.message?.content || '';
    return out.trim();
  } catch (e) {
    const code = e.response?.status || 'ERR';
    throw new Error(`PERPLEXITY_${code}`);
  }
}

/** ====== GITHUB – ULOŽENÍ MD ====== **/
async function saveToGitHub(summary, url, meta) {
  const octokit = new Octokit({ auth: githubToken });
  const today = new Date().toISOString().replace(/T.*/, "");
  const randomStr = Math.random().toString(36).substring(2, 8);
  const fileName = `${summariesDir}/${today}-${randomStr}.md`;

  const titleLine = meta?.title ? `# ${meta.title}` : `# Shrnutí článku`;
  const sourceLine = `**Zdroj:** [${meta?.sourceHost || url}](${url})`;
  const dateLine = `**Datum:** ${new Date().toISOString().slice(0,10)}`;

  const md = [
    titleLine,
    '',
    sourceLine,
    dateLine,
    '',
    summary && summary.trim().length > 0 ? summary : "_Shrnutí nebylo k dispozici._"
  ].join('\n');

  const content = Buffer.from(md, "utf8").toString("base64");

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: fileName,
    message: `Add summary: ${meta?.sourceHost || url}`,
    content,
    branch,
  });

  return `https://github.com/${owner}/${repo}/blob/${branch}/${fileName}`;
}

/** ====== STATIC SITE (docs/) ====== **/
function ensureDocsScaffold() {
  fs.mkdirSync('docs', { recursive: true });
  // index.html – přepisujeme vždy, aby se UI sjednotilo
  fs.writeFileSync(
    path.join('docs', 'index.html'),
    INDEX_HTML_CONTENT,
    'utf8'
  );
  // style.css
  fs.writeFileSync(
    path.join('docs', 'style.css'),
    STYLE_CSS_CONTENT,
    'utf8'
  );
  // app.js
  fs.writeFileSync(
    path.join('docs', 'app.js'),
    APP_JS_CONTENT,
    'utf8'
  );
  // posts.json – pokud neexistuje, inicializuj
  const postsPath = path.join('docs', 'posts.json');
  if (!fs.existsSync(postsPath)) fs.writeFileSync(postsPath, '[]', 'utf8');
}

function loadPosts() {
  try {
    const raw = fs.readFileSync(path.join('docs', 'posts.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function savePosts(posts) {
  // seřadit nejnovější první
  posts.sort((a,b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  // limit
  if (posts.length > KEEP_POSTS) posts = posts.slice(0, KEEP_POSTS);
  fs.writeFileSync(path.join('docs','posts.json'), JSON.stringify(posts, null, 2), 'utf8');
  return posts;
}

/**
 * Přidá nový záznam do posts.json (deduplikace podle sourceUrl nebo mdUrl).
 */
function addPostCard({ title, dateISO, summary, sourceUrl, mdUrl, sourceHost }) {
  ensureDocsScaffold();
  const posts = loadPosts();

  const exists = posts.find(p => p.sourceUrl === sourceUrl || p.mdUrl === mdUrl);
  if (exists) return;

  posts.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
    title: title || 'Shrnutí',
    date: dateISO || new Date().toISOString(),
    summary: summary || '',
    sourceHost: sourceHost || '',
    sourceUrl: sourceUrl,
    mdUrl: mdUrl
  });

  savePosts(posts);
}

/** ====== MAIN ====== **/
async function run() {
  const candidates = await getPendingUrlRows();
  if (candidates.length === 0) {
    console.log('Žádné nové URL ke zpracování.');
    return;
  }

  // zpracuj max MAX_PER_RUN
  const pick = candidates.slice(0, MAX_PER_RUN);

  for (const { url, row } of pick) {
    if (!/^https?:\/\//i.test(url)) {
      await writeBackStatus(row, 'BAD_URL', '');
      continue;
    }

    try {
      console.log(`Stahuji článek: ${url}`);
      const meta = await fetchArticle(url);
      if (!meta.text || meta.text.trim().length < 80) {
        await writeBackStatus(row, 'TEXT_EMPTY', '');
        console.log('Vytažený text je prázdný/krátký – přeskočeno.');
        continue;
      }

      let summary = '';
      let status = 'OK';

      try {
        console.log('Posílám na Perplexity API…');
        summary = await getSummaryPerplexity(meta.text);
        status = 'OK';
      } catch (perr) {
        console.log(`Perplexity selhalo – fallback: ${perr.message}`);
        summary = simpleFallbackSummary(meta.text);
        status = 'OK_FALLBACK';
      }

      console.log('Ukládám Markdown do repa…');
      const mdUrl = await saveToGitHub(summary, url, meta);

      // přidej kartu na web
      addPostCard({
        title: meta.title,
        dateISO: new Date().toISOString(),
        summary,
        sourceUrl: url,
        mdUrl,
        sourceHost: meta.sourceHost
      });

      // zapiš do Sheets status
      await writeBackStatus(row, status, mdUrl);
      console.log(`Hotovo pro: ${url}`);

      // drobná pauza
      await sleep(800);

    } catch (e) {
      const msg = e.message || 'ERR';
      console.error(`Chyba u ${url}: ${msg}`);
      await writeBackStatus(row, msg.substring(0, 40), '');
      await sleep(400);
    }
  }
}

/** ====== HELPERS ====== **/
function simpleFallbackSummary(text) {
  const paras = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  if (paras[0]) {
    const p = paras[0].length > 700 ? paras[0].slice(0, 700) + '…' : paras[0];
    return p;
  }
  return text.slice(0, 700) + (text.length > 700 ? '…' : '');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** ====== UI ŠABLONY (docs/) ====== **/

const INDEX_HTML_CONTENT = `<!doctype html>
<html lang="cs">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Mounjaro Summaries</title>
  <meta name="description" content="Denní shrnutí článků o GLP-1 / Mounjaro.">
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <header class="site-header">
    <div class="wrap">
      <h1>Mounjaro Summaries</h1>
      <p class="subtitle">Denně 1–2 nové články • AI shrnutí • Přímý odkaz na zdroj</p>
    </div>
  </header>

  <main class="wrap">
    <div id="filters" class="filters">
      <input id="search" type="search" placeholder="Hledat v titulcích a shrnutí…" />
      <select id="source">
        <option value="">Všechny zdroje</option>
      </select>
    </div>

    <div id="list" class="grid"></div>

    <footer class="site-footer">
      <p>Publikováno automaticky • <a href="https://github.com/OnLi1971/mounjaro-summaries" target="_blank" rel="noopener">GitHub repo</a></p>
    </footer>
  </main>

  <script src="app.js"></script>
</body>
</html>
`;

const STYLE_CSS_CONTENT = `:root{
  --bg: #0b0f14;
  --card: #111824;
  --text: #e9eef5;
  --muted: #9fb0c1;
  --accent: #6ec1ff;
  --border: #1b2a3a;
  --chip: #162233;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,'Helvetica Neue',Arial}
.wrap{max-width:980px;margin:0 auto;padding:16px}
.site-header{border-bottom:1px solid var(--border);background:linear-gradient(180deg,#0b1017,#0b0f1400)}
.site-header h1{margin:12px 0 4px 0;font-weight:700;font-size:28px;letter-spacing:.2px}
.subtitle{margin:0 0 12px 0;color:var(--muted)}
.filters{display:flex;gap:12px;margin:16px 0}
.filters input,.filters select{flex:1;min-width:0;background:#0c141f;color:var(--text);border:1px solid var(--border);padding:10px 12px;border-radius:10px}
.grid{display:grid;grid-template-columns:repeat(1,1fr);gap:14px}
@media(min-width:680px){.grid{grid-template-columns:repeat(2,1fr)}}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:10px}
.card h3{margin:0;font-size:18px;line-height:1.35}
.meta{display:flex;gap:8px;flex-wrap:wrap;color:var(--muted);font-size:13px}
.chip{background:var(--chip);color:#bfe3ff;border:1px solid var(--border);padding:2px 8px;border-radius:999px}
.actions{display:flex;gap:10px;margin-top:6px}
.actions a{display:inline-block;text-decoration:none;color:var(--text);background:#0d1826;border:1px solid var(--border);padding:8px 10px;border-radius:10px}
.actions a:hover{border-color:#27425f}
.site-footer{margin:30px 0 10px 0;color:var(--muted);text-align:center}
.empty{opacity:.7;padding:24px;text-align:center;border:1px dashed var(--border);border-radius:12px}
`;

const APP_JS_CONTENT = `async function loadPosts(){
  const res = await fetch('posts.json',{cache:'no-store'});
  if(!res.ok) throw new Error('posts.json load failed');
  return await res.json();
}

function fmtDate(iso){
  try{ return new Date(iso).toLocaleDateString('cs-CZ',{year:'numeric',month:'2-digit',day:'2-digit'}); }
  catch{ return iso; }
}

function render(posts){
  const list = document.getElementById('list');
  const sourceSel = document.getElementById('source');
  list.innerHTML = '';

  // zdroje do filtru
  const sources = Array.from(new Set(posts.map(p=>p.sourceHost).filter(Boolean))).sort();
  sourceSel.innerHTML = '<option value=\"\">Všechny zdroje</option>' + sources.map(s=>'<option>'+s+'</option>').join('');

  const search = document.getElementById('search');
  function apply(){
    const q = (search.value||'').toLowerCase();
    const s = sourceSel.value||'';
    const rows = posts.filter(p=>{
      if(s && p.sourceHost!==s) return false;
      if(q && !(p.title||'').toLowerCase().includes(q) && !(p.summary||'').toLowerCase().includes(q)) return false;
      return true;
    });
    list.innerHTML = '';
    if(rows.length===0){
      list.innerHTML = '<div class=\"empty\">Žádné výsledky</div>';
      return;
    }
    rows.forEach(p=>{
      const el = document.createElement('div');
      el.className = 'card';
      el.innerHTML = \`
        <h3>\${p.title ? escapeHtml(p.title) : 'Shrnutí'}</h3>
        <div class="meta">
          <span>\${fmtDate(p.date)}</span>
          \${p.sourceHost ? '<span class="chip">'+escapeHtml(p.sourceHost)+'</span>' : ''}
        </div>
        <div class="summary">\${escapeHtml((p.summary||'').slice(0,600))}</div>
        <div class="actions">
          <a href="\${p.sourceUrl}" target="_blank" rel="noopener">Přečíst zdroj</a>
          <a href="\${p.mdUrl}" target="_blank" rel="noopener">Plné shrnutí (GitHub)</a>
        </div>\`;
      list.appendChild(el);
    })
  }
  search.oninput = apply;
  sourceSel.onchange = apply;
  apply();
}

function escapeHtml(s){return (s||'')
  .replace(/&/g,'&amp;')
  .replace(/</g,'&lt;')
  .replace(/>/g,'&gt;')
  .replace(/\"/g,'&quot;')
  .replace(/'/g,'&#39;');}

loadPosts().then(render).catch(err=>{
  document.getElementById('list').innerHTML='<div class="empty">Nelze načíst data.</div>';
  console.error(err);
});
`;


// Spusť
run().catch(e => {
  console.error(e);
  process.exit(1);
});
