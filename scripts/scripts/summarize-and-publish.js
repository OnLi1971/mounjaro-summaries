// scripts/summarize-and-publish.js
// Čte řádky z Google Sheets, pro chybějící shrnutí zavolá Perplexity (česky),
// vrátí shrnutí zpět do Sheets (F), a z řádků s K=TRUE vytvoří docs/posts.json.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const axios = require('axios');

// ==== Nastavení ====
// ID tabulky a název listu
const SHEET_ID = process.env.SHEET_ID || '1KgrYXHpVfTAGQZT6f15aARGCQ-qgNQZM4HWQCiqt14s';
const SHEET_NAME = process.env.SHEET_NAME || 'List 1';

// Perplexity
const PPLX_KEY = process.env.PERPLEXITY_API_KEY || '';
const PPLX_URL = 'https://api.perplexity.ai/v1/chat/completions';

// GitHub Pages data soubor
const POSTS_JSON = path.join('docs', 'posts.json');

// Mapování sloupců podle hlaviček (bez závislosti na pořadí)
const COLS = {
  DATE: 'Datum',
  SOURCE: 'Zdroj',
  TITLE: 'Název článku',
  URL: 'URL',
  TEXT: 'Text článku',           // volitelné
  SUMMARY: 'Shrnutí',            // česky (cílový sloupec)
  IMAGE: 'Obrázek',              // volitelné
  STATUS: 'Status',              // volitelné (log)
  MD_URL: 'MD_URL',              // volitelné
  TS: 'Timestamp',               // volitelné (ISO)
  PUBLISH: 'Publish',            // TRUE / FALSE
  PUBLISH_DATE: 'Publish_Date'   // yyyy-mm-dd (doplníme při 1. publikaci)
};

// Pomoc: normalizace hodnoty Publish
function isPublishTrue(val) {
  if (val == null) return false;
  const s = String(val).trim().toLowerCase();
  return ['true', 'ano', 'ok', '1', 'y', 'yes'].includes(s);
}

// Google Auth – čte service account JSON z env
function getGoogleClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON secret.');
  let creds;
  try {
    creds = JSON.parse(raw);
  } catch (e) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.');
  }
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

// Načti všechna data z listu
async function readSheet(sheets) {
  const range = `${SHEET_NAME}!A1:Z`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
  });
  const rows = res.data.values || [];
  if (rows.length === 0) return { headers: [], data: [] };

  const headers = rows[0].map(h => (h || '').trim());
  const data = rows.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, i) => (obj[h] = r[i] ?? ''));
    return obj;
  });
  return { headers, data };
}

// Zapiš změny do konkrétních buněk pomocí batchUpdate
async function writeSheetBatch(sheets, updates /* array of {rowIndex, colHeader, value} */) {
  if (updates.length === 0) return;
  // Zjistíme indexy sloupců dle hlavičky
  const { headers } = await readSheet(sheets);
  const headerIndex = {};
  headers.forEach((h, i) => (headerIndex[h] = i));

  const dataByRange = [];
  for (const u of updates) {
    const col = headerIndex[u.colHeader];
    if (col == null) continue; // neznámý sloupec
    // +2: 1 na hlavičku, 1 na převod z 0-based na 1-based
    const a1 = `${colToLetter(col + 1)}${u.rowIndex + 2}`;
    dataByRange.push({
      range: `${SHEET_NAME}!${a1}`,
      values: [[u.value]],
    });
  }

  // Dávkujeme po 100 zápisech pro jistotu proti rate-limitům
  const chunk = 100;
  for (let i = 0; i < dataByRange.length; i += chunk) {
    const part = dataByRange.slice(i, i + chunk);
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        valueInputOption: 'RAW',
        data: part,
      },
    });
  }
}

// Pomoc: číslo sloupce -> písmeno (A1)
function colToLetter(n) {
  let s = '';
  while (n > 0) {
    let m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - m) / 26);
  }
  return s;
}

// Perplexity dotaz – vždy česky
async function summarizeWithPerplexity(url) {
  if (!PPLX_KEY) return '';
  const payload = {
    model: 'pplx-70b-online',
    messages: [
      { role: 'system', content: 'Jsi novinář. Piš česky, věcně a srozumitelně.' },
      { role: 'user', content: `Stručně česky shrň obsah článku (3–5 vět, max 600 znaků). URL: ${url}` },
    ],
    temperature: 0.2,
    max_tokens: 512,
  };
  const res = await axios.post(PPLX_URL, payload, {
    headers: {
      Authorization: `Bearer ${PPLX_KEY}`,
      'Content-Type': 'application/json',
    },
    timeout: 28000,
    validateStatus: () => true,
  });
  if (res.status !== 200) return '';
  return (res.data?.choices?.[0]?.message?.content || '').trim();
}

// Heuristický fallback – vezme čitelný snapshot přes r.jina.ai a uřízne 1. odstavec
async function summarizeFallbackCz(url) {
  try {
    const proxied = 'https://r.jina.ai/http/' + url.replace(/^https?:\/\//, '');
    const r = await axios.get(proxied, { timeout: 20000, validateStatus: () => true });
    if (r.status !== 200 || !r.data) return '';
    const text = String(r.data || '')
      .replace(/\r/g, '')
      .split('\n')
      .map(x => x.trim())
      .filter(Boolean)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n');
    if (text.length < 180) return '';
    const para = (text.split(/\n\s*\n/).find(p => p.length > 150) || text).slice(0, 600);
    // Požádáme opět Perplexity, ale přímo s textem – důraz na češtinu
    if (PPLX_KEY) {
      const payload = {
        model: 'pplx-70b-online',
        messages: [
          { role: 'system', content: 'Jsi novinář. Piš česky, věcně a srozumitelně.' },
          { role: 'user', content: `Shrň česky následující text (3–5 vět, max 600 znaků):\n\n${para}` },
        ],
        temperature: 0.2,
        max_tokens: 512,
      };
      const res = await axios.post(PPLX_URL, payload, {
        headers: {
          Authorization: `Bearer ${PPLX_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 28000,
        validateStatus: () => true,
      });
      if (res.status === 200) {
        return (res.data?.choices?.[0]?.message?.content || '').trim();
      }
    }
    // když to taky nevyjde, vrať aspoň ustřižený text
    return para;
  } catch {
    return '';
  }
}

// 1) Doplnění shrnutí do Sheets (jen prázdné F)
async function backfillSummaries(sheets) {
  const { headers, data } = await readSheet(sheets);
  if (headers.length === 0) return { wrote: 0 };

  const idx = name => headers.indexOf(name);
  const iURL = idx(COLS.URL);
  const iSUM = idx(COLS.SUMMARY);
  const iSTATUS = idx(COLS.STATUS);
  const iTS = idx(COLS.TS);

  const updates = [];
  let wrote = 0;

  for (let rowIndex = 0; rowIndex < data.length; rowIndex++) {
    const row = data[rowIndex];
    const url = (row[COLS.URL] || '').toString().trim();
    const sum = (row[COLS.SUMMARY] || '').toString().trim();

    if (!url || !iSUM || iSUM < 0) continue;
    if (sum) continue; // už máme shrnutí

    // Zkus Perplexity → pak fallback → pokud nic, nech prázdné
    let out = await summarizeWithPerplexity(url);
    if (!out) out = await summarizeFallbackCz(url);

    if (out) {
      updates.push({ rowIndex, colHeader: COLS.SUMMARY, value: out });
      if (iTS >= 0) updates.push({ rowIndex, colHeader: COLS.TS, value: new Date().toISOString() });
      if (iSTATUS >= 0) updates.push({ rowIndex, colHeader: COLS.STATUS, value: 'OK' });
      wrote++;
      // šetrné tempo vůči API
      await new Promise(r => setTimeout(r, 1200));
    } else {
      if (iSTATUS >= 0) updates.push({ rowIndex, colHeader: COLS.STATUS, value: 'NO_SUMMARY' });
    }
  }

  if (updates.length) await writeSheetBatch(sheets, updates);
  return { wrote };
}

// 2) Vygeneruj docs/posts.json z řádků s Publish=TRUE
async function buildPostsJson(sheets) {
  const { headers, data } = await readSheet(sheets);
  if (headers.length === 0) return 0;

  // indexery podle hlaviček (kvůli případnému jinému pořadí)
  const get = (row, name) => (row[name] == null ? '' : String(row[name]));

  const selected = [];
  const now = new Date();

  for (let r = 0; r < data.length; r++) {
    const row = data[r];
    const url = get(row, COLS.URL).trim();
    const title = get(row, COLS.TITLE).trim();
    const summary = get(row, COLS.SUMMARY).trim();
    const src = get(row, COLS.SOURCE).trim();
    const dateCell = get(row, COLS.DATE).trim();
    const publish = isPublishTrue(row[COLS.PUBLISH]);

    if (!publish) continue;
    if (!url || !title || !summary) continue;

    // publikované datum – vezmeme buď A (Datum) nebo dnešek
    let publishedAt = dateCell ? new Date(dateCell) : now;
    if (isNaN(publishedAt.getTime())) publishedAt = now;

    selected.push({
      date: publishedAt.toISOString(),
      source: src || '',
      title,
      summary,
      url,
    });
  }

  // řaď nejnovější první
  selected.sort((a, b) => new Date(b.date) - new Date(a.date));

  // ulož JSON
  fs.mkdirSync(path.dirname(POSTS_JSON), { recursive: true });
  fs.writeFileSync(POSTS_JSON, JSON.stringify(selected, null, 2), 'utf8');

  return selected.length;
}

// === Main ===
(async function run() {
  try {
    console.log('== Summarize & Publish (CZ) ==');
    console.log('Sheet:', SHEET_ID, '/', SHEET_NAME);

    const auth = await getGoogleClient().getClient();
    const sheets = google.sheets({ version: 'v4', auth });

    const backfill = await backfillSummaries(sheets);
    console.log('Backfilled summaries:', backfill.wrote);

    const count = await buildPostsJson(sheets);
    console.log('posts.json items:', count);
  } catch (e) {
    console.error('FATAL:', e?.stack || e);
    process.exit(1);
  }
})();
