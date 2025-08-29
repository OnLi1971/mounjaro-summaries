// perplexity-sheet-to-github.js
// v3.3 — Publikuje jen K=TRUE & J prázdné, a jen když je k dispozici české shrnutí.
// Do Sheets zapisuje H/I/J/L dávkově. Zamezí publikaci EN shrnutí (H=WAIT_CZ).

require('dotenv').config({ path: './summaries.env' });

const { google } = require('googleapis');
const axios = require('axios');
const cheerio = require('cheerio');
const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const path = require('path');

// ==== CONFIG ====
const SPREADSHEET_ID = '1KgrYXHpVfTAGQZT6f15aARGCQ-qgNQZM4HWQCiqt14s';
const SHEET_NAME = 'List 1';
const READ_RANGE = `'${SHEET_NAME}'!A:N`;

const COL = {
  DATE: 0,            // A
  SOURCE: 1,          // B
  TITLE: 2,           // C
  URL: 3,             // D
  FULLTEXT: 4,        // E (volitelné)
  TRANS_SUM: 5,       // F (případné starší přeložené shrnutí)
  IS_CZ: 6,           // G
  STATUS: 7,          // H
  MD_URL: 8,          // I
  PUBLISHED_AT: 9,    // J
  PUBLISH: 10,        // K (TRUE => publikovat)
  CZ_SUMMARY: 11      // L (české shrnutí)
};

const BLOCKED_DOMAINS = new Set([
  'thesun.co.uk',
  'uk.news.yahoo.com',
  'community.whattoexpect.com',
  'shefinds.com',
  'gwa-prod-pxm-api.s3.amazonaws.com',
  'the-independent.com',
  'theindependent.com'
]);

const DOCS_DIR = path.join(process.cwd(), 'docs');
const POSTS_JSON = path.join(DOCS_DIR, 'posts.json');

const GH_OWNER = 'OnLi1971';
const GH_REPO = 'mounjaro-summaries';
const GH_BRANCH = 'main';
const SUMMARIES_DIR = 'summaries';

const PPLX_KEY = process.env.PERPLEXITY_API_KEY;

// ==== AUTH ====
const auth = new google.auth.GoogleAuth({
  keyFile: 'google-service-account.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const octo = new Octokit({ auth: process.env.GITHUB_TOKEN });

// ==== UTILS ====
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();
const randId = (n=6) => Math.random().toString(36).slice(2, 2+n);
const normalizeBool = (v) => (typeof v === 'boolean') ? v : (typeof v === 'string' ? /^true$/i.test(v.trim()) : false);

function domainOf(url) { try { return new URL(url).hostname.replace(/^www\./,''); } catch { return ''; } }

function looksEnglish(s='') {
  if (!s) return false;
  const hasCz = /[áéěíóúůýžščřďťňÁÉĚÍÓÚŮÝŽŠČŘĎŤŇ]/.test(s);
  const hasLat = /[A-Za-z]/.test(s);
  return hasLat && !hasCz;
}

function cleanupText(html) {
  const $ = cheerio.load(html);
  $('script,style,noscript').remove();
  const txt = $('p').map((_,el)=>$(el).text().trim()).get().filter(Boolean).join('\n\n');
  return txt;
}

async function fetchArticle(url) {
  const UA='Mozilla/5.0 (compatible; MounjaroSummariesBot/1.0)';
  const res = await axios.get(url, { headers: { 'User-Agent': UA }, timeout: 20000 });
  const html = res.data || '';
  const $ = cheerio.load(html);
  const title = ($('meta[property="og:title"]').attr('content') || $('title').first().text() || '').trim();
  const text = cleanupText(html);
  return { title: title || url, text };
}

async function summarizeCzech(text) {
  if (!PPLX_KEY) return null;
  try {
    const resp = await axios.post(
      'https://api.perplexity.ai/v1/chat/completions',
      {
        model: 'pplx-7b-chat',
        messages: [
          { role:'system', content:'Jsi asistent, který stručně shrnuje články v češtině.' },
          { role:'user', content:`Shrň česky do 5–7 bodů (věcně, bez úvodu/závěru):\n\n${text.slice(0,6000)}` }
        ],
        max_tokens: 700,
        temperature: 0.3
      },
      { headers: { Authorization:`Bearer ${PPLX_KEY}`, 'Content-Type':'application/json' } }
    );
    return resp.data?.choices?.[0]?.message?.content?.trim() || null;
  } catch(e) {
    console.warn('Perplexity summarize error:', e?.response?.status || e.message);
    return null;
  }
}

async function translateToCzech(text) {
  if (!PPLX_KEY) return text;
  try {
    const resp = await axios.post(
      'https://api.perplexity.ai/v1/chat/completions',
      {
        model: 'pplx-7b-chat',
        messages: [
          { role:'system', content:'Jsi pečlivý překladatel EN→CS. Vrať jen přeložený text.' },
          { role:'user', content:`Přelož do češtiny:\n\n${text}` }
        ],
        max_tokens: 800,
        temperature: 0.2
      },
      { headers: { Authorization:`Bearer ${PPLX_KEY}`, 'Content-Type':'application/json' } }
    );
    return resp.data?.choices?.[0]?.message?.content?.trim() || text;
  } catch {
    return text;
  }
}

async function ensureCzechSummary(articleText, sheetL, sheetF) {
  // 1) ruční/už existující CZ shrnutí z L (ber jen pokud je opravdu CZ)
  if (sheetL && !looksEnglish(sheetL)) return sheetL.trim();

  // 2) případné starší překlady z F (Apps Script) – často už CZ
  if (sheetF && !looksEnglish(sheetF)) return sheetF.trim();

  // 3) zkus LLM česky
  let s = await summarizeCzech(articleText);

  // 4) pokud EN, přeložit
  if (s && looksEnglish(s)) {
    s = await translateToCzech(s);
  }

  // 5) fallback – aspoň první delší odstavec
  if (!s || s.length < 40) {
    const para = (articleText || '').split(/\n\s*\n/).map(t=>t.trim()).find(t=>t.length>80) || (articleText||'').slice(0,500);
    s = para ? `${para.slice(0,700)}${para.length>700?'…':''}` : '';
  }

  // 6) pokud je to pořád EN, vrať prázdné => nepustíme na web (WAIT_CZ)
  if (!s || looksEnglish(s)) return '';

  return s;
}

function readPostsJson() {
  try {
    if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive:true });
    if (!fs.existsSync(POSTS_JSON)) return [];
    const arr = JSON.parse(fs.readFileSync(POSTS_JSON,'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function writePostsJson(posts) {
  fs.writeFileSync(POSTS_JSON, JSON.stringify(posts, null, 2), 'utf8');
}

function upsertPost(posts, entry) {
  const i = posts.findIndex(p => (p.url||'').trim() === entry.url.trim());
  if (i >= 0) posts[i] = { ...posts[i], ...entry };
  else posts.push(entry);
}

async function saveMarkdownToGitHub(title, url, summaryCz) {
  const today = new Date().toISOString().slice(0,10);
  const fileName = `${today}-${randId(6)}.md`;
  const mdPath = `${SUMMARIES_DIR}/${fileName}`;
  const content = Buffer.from(
    `# Shrnutí (CZ)\n\n**Zdroj:** [${title}](${url})\n\n${summaryCz}\n`,
    'utf8'
  ).toString('base64');

  await octo.repos.createOrUpdateFileContents({
    owner: GH_OWNER,
    repo: GH_REPO,
    path: mdPath,
    message: `Add summary: ${title || url}`,
    content,
    branch: GH_BRANCH
  });

  return `https://github.com/${GH_OWNER}/${GH_REPO}/blob/${GH_BRANCH}/${mdPath}`;
}

async function getSheetValues() {
  const client = await auth.getClient();
  const sheets = google.sheets({ version:'v4', auth: client });
  console.log(`Reading range: ${READ_RANGE}`);
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: READ_RANGE });
  return { sheets, rows: res.data.values || [] };
}

async function batchUpdate(sheets, updates) {
  if (!updates.length) return;
  const CHUNK = 25;
  for (let i=0;i<updates.length;i+=CHUNK) {
    const part = updates.slice(i,i+CHUNK);
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption:'RAW', data: part }
    });
    await sleep(300);
  }
}

async function run() {
  console.log('== Manual publish v3.3 (CZ only) ==');
  console.log('PPLX key present:', !!PPLX_KEY);

  const { sheets, rows } = await getSheetValues();
  if (rows.length <= 1) { console.log('No data rows'); return; }

  const updates = [];
  const posts = readPostsJson();
  let processed = 0;

  for (let i=1;i<rows.length;i++) {
    const r = rows[i];
    const rowNum = i+1;

    const title0 = (r[COL.TITLE] || '').toString().trim();
    const url = (r[COL.URL] || '').toString().trim();
    const publish = normalizeBool(r[COL.PUBLISH]);
    const publishedAt = (r[COL.PUBLISHED_AT] || '').toString().trim();
    const lCz = (r[COL.CZ_SUMMARY] || '').toString();
    const fTrans = (r[COL.TRANS_SUM] || '').toString();

    if (!url) continue;
    if (!publish || publishedAt) continue;

    const dom = domainOf(url);
    if (BLOCKED_DOMAINS.has(dom)) {
      updates.push({ range:`'${SHEET_NAME}'!H${rowNum}:H${rowNum}`, values: [['SKIP_BLOCKED_DOMAIN']]});
      continue;
    }

    try {
      console.log(`Row ${rowNum}: fetch ${url}`);
      const { title, text } = await fetchArticle(url);
      const finalTitle = title0 || title || url;

      // zajisti české shrnutí
      const cz = await ensureCzechSummary(text, lCz, fTrans);

      if (!cz) {
        // Česky se nepodařilo – NEpublikujeme, počkáme na backfill/další pokus
        updates.push({
          range: `'${SHEET_NAME}'!H${rowNum}:L${rowNum}`,
          values: [['WAIT_CZ', '', '', lCz || fTrans || '']]
        });
        console.log(`Row ${rowNum}: WAIT_CZ (no Czech summary)`);
        continue;
      }

      // uložit MD
      const mdUrl = await saveMarkdownToGitHub(finalTitle, url, cz);

      // upsert karta na web
      upsertPost(posts, {
        title: finalTitle,
        url,
        date: nowIso(),
        source: dom,
        summary: cz
      });

      // updates: H/I/J + L (zapiš CZ shrnutí, ať ho vidíš v tabulce)
      updates.push({
        range: `'${SHEET_NAME}'!H${rowNum}:J${rowNum}`,
        values: [['OK', mdUrl, nowIso()]]
      });
      updates.push({
        range: `'${SHEET_NAME}'!L${rowNum}:L${rowNum}`,
        values: [[cz]]
      });

      processed += 1;
      await sleep(150);
    } catch(e) {
      console.error(`ERROR row ${rowNum}:`, e.message);
      updates.push({ range:`'${SHEET_NAME}'!H${rowNum}:H${rowNum}`, values: [['ERROR']]});
    }
  }

  if (processed > 0) {
    posts.sort((a,b)=> new Date(b.date) - new Date(a.date));
    fs.mkdirSync(DOCS_DIR, { recursive:true });
    writePostsJson(posts);
  }

  if (updates.length) await batchUpdate(sheets, updates);
  console.log(`Done. Published: ${processed}`);
}

run().catch(err => { console.error('FATAL:', err); process.exit(1); });
