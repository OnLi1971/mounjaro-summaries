// scripts/summarize-and-publish.js
// Publikuje schválené články (K=TRUE & L prázdné) z Google Sheet do docs/posts.json
// a označí je ve Sheet jako publikované (L=publishedAt, M=slug).

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const axios = require('axios');

// ==== KONFIG ====
const SPREADSHEET_ID = process.env.SHEETS_ID || '1KgrYXHpVfTAGQZT6f15aARGCQ-qgNQZM4HWQCiqt14s';
const SHEET_NAME = process.env.SHEETS_TAB || 'List 1';
const POSTS_JSON = path.join(process.cwd(), 'docs', 'posts.json');
const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY || '';
const PERPLEXITY_URL = 'https://api.perplexity.ai/v1/chat/completions';

// Sloupečky (0-based)
const COL = {
  date: 0,       // A
  source: 1,     // B
  title: 2,      // C
  url: 3,        // D
  fullText: 4,   // E
  summary: 5,    // F (preferovaně CZ už z GAS; jinak Perplexity fallback)
  image: 6,      // G
  status: 7,     // H
  mdUrl: 8,      // I
  mdTime: 9,     // J
  publishFlag: 10,  // K (TRUE => publikovat)
  publishedAt: 11,  // L (ISO čas publikace)
  slug: 12,         // M (interní id/slug)
  extra: 13,        // N
};

// ==== Pomocné funkce ====
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function ensurePostsFile() {
  if (!fs.existsSync(path.dirname(POSTS_JSON))) {
    fs.mkdirSync(path.dirname(POSTS_JSON), { recursive: true });
  }
  if (!fs.existsSync(POSTS_JSON)) {
    fs.writeFileSync(POSTS_JSON, '[]', 'utf8');
  }
}

function loadPosts() {
  ensurePostsFile();
  try {
    const raw = fs.readFileSync(POSTS_JSON, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function savePosts(posts) {
  // seřadit nejnovější první
  posts.sort((a, b) => new Date(b.publishedAt || b.date) - new Date(a.publishedAt || a.date));
  fs.writeFileSync(POSTS_JSON, JSON.stringify(posts, null, 2), 'utf8');
}

function getDomain(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function normBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return ['true','1','yes','ok','ano','y'].includes(s);
  }
  return false;
}

function makeSlug(title, url) {
  const base = (title || getDomain(url) || 'post')
    .toLowerCase()
    .replace(/["'’]+/g, '')
    .replace(/[^a-z0-9\u00C0-\u017F]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${base || 'post'}-${rnd}`;
}

async function perplexityCzechSummary(url) {
  if (!PERPLEXITY_API_KEY) return '';
  const payload = {
    model: 'pplx-70b-online',
    messages: [
      { role: 'system', content: 'Jsi asistent, který stručně shrnuje články česky.' },
      { role: 'user', content: `Prosím shrň česky hlavní body článku (max ~4–6 vět): ${url}` }
    ],
    temperature: 0.3,
    max_tokens: 450
  };
  try {
    const r = await axios.post(PERPLEXITY_URL, payload, {
      headers: {
        Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      timeout: 20000
    });
    const content = r.data?.choices?.[0]?.message?.content?.trim() || '';
    return content;
  } catch (e) {
    console.warn('Perplexity fallback selhal:', e?.response?.status || e.message);
    return '';
  }
}

// ==== Google Sheets ====
async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: 'google-service-account.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

async function readSheetRows(sheets) {
  const range = `${SHEET_NAME}!A:N`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range
  });
  const values = res.data.values || [];
  return values; // [ [A..N], [A..N] ... ]
}

async function writePublishedMarks(sheets, rowUpdates) {
  // rowUpdates: array of { rowIndex1based, publishedAt, slug }
  if (rowUpdates.length === 0) return;
  const data = [];
  for (const u of rowUpdates) {
    data.push({
      range: `${SHEET_NAME}!L${u.row} : M${u.row}`,
      values: [[u.publishedAt, u.slug]]
    });
  }
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      valueInputOption: 'RAW',
      data
    }
  });
}

// ==== Hlavní běh ====
(async function run() {
  console.log('== summarize-and-publish.js ==');
  ensurePostsFile();
  const sheets = await getSheetsClient();

  const rows = await readSheetRows(sheets);
  if (rows.length <= 1) {
    console.log('Sheet je prázdný (jen hlavička).');
    return;
  }
  const header = rows[0];
  const body = rows.slice(1);

  // Připrav stávající posts.json
  const posts = loadPosts();
  const knownUrls = new Set(posts.map(p => (p.url || '').trim()));

  const toPublish = [];
  const marks = [];

  for (let i = 0; i < body.length; i++) {
    const r = body[i];
    const rowNum = i + 2; // 1-based index plus hlavička

    const title = r[COL.title] || '';
    const url = r[COL.url] || '';
    const publishFlag = normBool(r[COL.publishFlag]);
    const alreadyPublished = (r[COL.publishedAt] || '').toString().trim() !== '';

    if (!url || !publishFlag || alreadyPublished) continue;
    if (knownUrls.has(url.trim())) {
      // už máme v posts.json – jen dopiš L/M do Sheets
      const existing = posts.find(p => (p.url || '').trim() === url.trim());
      const publishAt = existing?.publishedAt || new Date().toISOString();
      const slug = existing?.slug || makeSlug(title, url);
      marks.push({ row: rowNum, publishedAt: publishAt, slug });
      continue;
    }

    let summary = (r[COL.summary] || '').toString().trim();
    if (!summary) {
      summary = await perplexityCzechSummary(url);
      // ochrana před rate-limitem
      await sleep(2300);
    }

    const publishedAt = new Date().toISOString();
    const slug = makeSlug(title, url);
    const item = {
      title: title || '(bez názvu)',
      url,
      summary: summary || '(Shrnutí není k dispozici.)',
      publishedAt,
      source: r[COL.source] || getDomain(url)
    };
    toPublish.push(item);
    marks.push({ row: rowNum, publishedAt, slug });
  }

  if (toPublish.length === 0 && marks.length === 0) {
    console.log('Nic nového k publikaci.');
    return;
  }

  // Ulož do posts.json
  const merged = posts.concat(toPublish);

  // deduplikace podle URL
  const seen = new Set();
  const dedup = [];
  for (const p of merged) {
    const key = (p.url || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    dedup.push(p);
  }
  savePosts(dedup);

  // Zapiš publishedAt/slug do Sheet
  await writePublishedMarks(sheets, marks);

  console.log(`Hotovo. Přidáno do posts.json: ${toPublish.length}, označeno v Sheets: ${marks.length}`);
})().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
