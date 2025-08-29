// perplexity-sheet-to-github.js
// RUNNING manual-gate v3.2 – K=TRUE + J empty => publish; L (CZ_SUMMARY) se vždy snažíme mít česky

require('dotenv').config({ path: './summaries.env' });

const { google } = require('googleapis');
const axios = require('axios');
const cheerio = require('cheerio');
const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const path = require('path');

// ==== CONFIG =================================================================

const SPREADSHEET_ID = '1KgrYXHpVfTAGQZT6f15aARGCQ-qgNQZM4HWQCiqt14s';
const SHEET_NAME = 'List 1'; // přesný název listu
const READ_RANGE = `'${SHEET_NAME}'!A:N`; // bereme souvislý blok A..N

// Indexy sloupců (0-based)
const COL = {
  DATE: 0,            // A
  SOURCE: 1,          // B
  TITLE: 2,           // C
  URL: 3,             // D
  FULLTEXT: 4,        // E (nepovinné)
  TRANS_SUM: 5,       // F (nepovinné)
  IS_CZ: 6,           // G
  STATUS: 7,          // H (OK / OK_FALLBACK / ERROR / SKIP_…)
  MD_URL: 8,          // I (GitHub MD soubor)
  PUBLISHED_AT: 9,    // J
  PUBLISH: 10,        // K (TRUE => publikovat)
  CZ_SUMMARY: 11      // L (české shrnutí pro rozhodování i web)
};

// seznam domén, které nechceme publikovat
const BLOCKED_DOMAINS = new Set([
  'thesun.co.uk',
  'uk.news.yahoo.com',
  'community.whattoexpect.com',
  'shefinds.com',
  'gwa-prod-pxm-api.s3.amazonaws.com',
  'the-independent.com',
  'theindependent.com'
]);

// Web output (statický web)
const DOCS_DIR = path.join(process.cwd(), 'docs');
const POSTS_JSON = path.join(DOCS_DIR, 'posts.json');

// GitHub output (Markdown soubory)
const GH_OWNER = 'OnLi1971';
const GH_REPO = 'mounjaro-summaries';
const GH_BRANCH = 'main';
const SUMMARIES_DIR = 'summaries';

// Perplexity
const PPLX_KEY = process.env.PERPLEXITY_API_KEY;

// ==== AUTH ===================================================================

const auth = new google.auth.GoogleAuth({
  keyFile: 'google-service-account.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

function octokit() {
  return new Octokit({ auth: process.env.GITHUB_TOKEN });
}

// ==== UTILS ==================================================================

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function nowIso() { return new Date().toISOString(); }

function randId(n = 6) {
  return Math.random().toString(36).slice(2, 2 + n);
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch { return ''; }
}

function normalizeBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return /^true$/i.test(v.trim());
  return false;
}

function looksEnglish(s = '') {
  if (!s) return false;
  const hasCz = /[áéěíóúůýžščřďťňÁÉĚÍÓÚŮÝŽŠČŘĎŤŇ]/.test(s);
  const hasLat = /[A-Za-z]/.test(s);
  return hasLat && !hasCz;
}

function cleanupText(html) {
  const $ = cheerio.load(html);
  // odstraníme skripty, styly
  $('script, style, noscript').remove();
  // posbíráme odstavce
  const paras = $('p').map((_, el) => $(el).text().trim()).get();
  const text = paras.filter(Boolean).join('\n\n');
  return text;
}

async function fetchArticle(url) {
  const UA = 'Mozilla/5.0 (compatible; MounjaroSummariesBot/1.0; +https://github.com/OnLi1971/mounjaro-summaries)';
  const res = await axios.get(url, { headers: { 'User-Agent': UA }, timeout: 20000 });
  const html = res.data || '';
  const $ = cheerio.load(html);
  const title = ($('meta[property="og:title"]').attr('content')
    || $('title').first().text()
    || '').trim();
  const text = cleanupText(html);
  return { title: title || url, text };
}

async function summarizeCzech(text) {
  if (!PPLX_KEY) return null;
  const prompt = `Shrň následující text česky do 5–7 stručných bodů (bez úvodu a závěru, bez emotikonů). Zachovej fakta.

${text.slice(0, 6000)}`;
  try {
    const resp = await axios.post(
      'https://api.perplexity.ai/v1/chat/completions',
      {
        model: 'pplx-7b-chat',
        messages: [
          { role: 'system', content: 'Jsi asistent, který stručně shrnuje články v češtině.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 700,
        temperature: 0.3
      },
      { headers: { Authorization: `Bearer ${PPLX_KEY}`, 'Content-Type': 'application/json' } }
    );
    return resp.data?.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
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
          { role: 'system', content: 'Jsi pečlivý překladatel EN->CS. Vrať jen přeložený text bez komentářů.' },
          { role: 'user', content: `Přelož do češtiny:\n\n${text}` }
        ],
        max_tokens: 800,
        temperature: 0.2
      },
      { headers: { Authorization: `Bearer ${PPLX_KEY}`, 'Content-Type': 'application/json' } }
    );
    return resp.data?.choices?.[0]?.message?.content?.trim() || text;
  } catch {
    return text;
  }
}

async function ensureCzechSummary(articleText, sheetSummaryCz) {
  // 1) ruční shrnutí z L v tabulce má prioritu (když je česky)
  if (sheetSummaryCz && !looksEnglish(sheetSummaryCz)) {
    return sheetSummaryCz.trim();
  }

  // 2) zkus rovnou česky shrnout
  let s = await summarizeCzech(articleText);

  // 3) pokud výstup působí EN, rychle přeložit
  if (s && looksEnglish(s)) {
    s = await translateToCzech(s);
  }

  // 4) nouzový výcuc – první delší odstavec nebo první znaky
  if (!s || s.length < 40) {
    const para = (articleText || '')
      .split(/\n\s*\n/).map(t => t.trim()).find(t => t.length > 80)
      || (articleText || '').slice(0, 500);
    s = para ? `${para.slice(0, 700)}${para.length > 700 ? '…' : ''}` : 'Shrnutí není dostupné.';
  }

  return s;
}

function readPostsJson() {
  try {
    if (!fs.existsSync(DOCS_DIR)) fs.mkdirSync(DOCS_DIR, { recursive: true });
    if (!fs.existsSync(POSTS_JSON)) return [];
    const raw = fs.readFileSync(POSTS_JSON, 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writePostsJson(posts) {
  const pretty = JSON.stringify(posts, null, 2);
  fs.writeFileSync(POSTS_JSON, pretty, 'utf8');
}

function upsertPost(posts, entry) {
  // De-dupe podle URL
  const idx = posts.findIndex(p => (p.url || '').trim() === entry.url.trim());
  if (idx >= 0) {
    posts[idx] = { ...posts[idx], ...entry };
  } else {
    posts.push(entry);
  }
}

// ==== GITHUB (MD) ============================================================

async function saveMarkdownToGitHub(title, url, summaryCz) {
  const octo = octokit();
  const today = new Date().toISOString().slice(0, 10);
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

// ==== SHEETS I/O =============================================================

async function getSheetValues() {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  console.log(`Reading range: ${READ_RANGE}`);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: READ_RANGE
  });
  const rows = res.data.values || [];
  return { sheets, rows };
}

async function batchUpdate(sheets, updates) {
  if (updates.length === 0) return;
  // posílejme po menších dávkách, abychom nevyčerpali per-minute limit
  const CHUNK = 25;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        valueInputOption: 'RAW',
        data: chunk
      }
    });
    // drobné zpoždění
    await sleep(300);
  }
}

// ==== MAIN ===================================================================

async function run() {
  console.log('== Mounjaro manual publish (K=TRUE & J empty) v3.2 ==');

  const { sheets, rows } = await getSheetValues();
  if (rows.length <= 1) {
    console.log('No data rows.');
    return;
  }

  const header = rows[0];
  const updates = []; // batch for H/I/J/L
  const posts = readPostsJson();

  let processed = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const rowNum = i + 1; // 1-based index in Sheets

    const title = (r[COL.TITLE] || '').toString().trim();
    const url = (r[COL.URL] || '').toString().trim();
    const publish = normalizeBool(r[COL.PUBLISH]);
    const publishedAt = (r[COL.PUBLISHED_AT] || '').toString().trim();
    let czSummarySheet = (r[COL.CZ_SUMMARY] || '').toString();

    if (!url) continue;

    // publikujeme jen ručně povolené a dosud nepublikované
    if (!publish || publishedAt) continue;

    // blokované domény ven
    const d = domainOf(url);
    if (BLOCKED_DOMAINS.has(d)) {
      console.log(`SKIP_BLOCKED_DOMAIN ${d} @ row ${rowNum}`);
      // zapiš stav
      updates.push({
        range: `'${SHEET_NAME}'!H${rowNum}:H${rowNum}`,
        values: [['SKIP_BLOCKED_DOMAIN']]
      });
      continue;
    }

    try {
      console.log(`Processing row ${rowNum}: ${url}`);
      // načíst článek
      const { title: fetchedTitle, text } = await fetchArticle(url);
      const finalTitle = title || fetchedTitle || url;

      // zajistit české shrnutí (L)
      const summaryCz = await ensureCzechSummary(text, czSummarySheet);
      const usedFallback = !PPLX_KEY || looksEnglish(czSummarySheet);

      // uložit MD do GitHubu
      const mdUrl = await saveMarkdownToGitHub(finalTitle, url, summaryCz);

      // přidat do webu (posts.json)
      upsertPost(posts, {
        title: finalTitle,
        url,
        date: nowIso(),
        source: d,
        summary: summaryCz
      });

      // připravit update do Sheets – H/I/J + L (pokud L bylo prázdné nebo EN, přepiš česky)
      const status = usedFallback ? 'OK_FALLBACK' : 'OK';
      const setL = (!czSummarySheet || looksEnglish(czSummarySheet)) ? summaryCz : czSummarySheet;

      updates.push({
        range: `'${SHEET_NAME}'!H${rowNum}:J${rowNum}`,
        values: [[status, mdUrl, nowIso()]]
      });
      updates.push({
        range: `'${SHEET_NAME}'!L${rowNum}:L${rowNum}`,
        values: [[setL]]
      });

      processed += 1;
      // malý delay mezi doménami (opatrnost vůči rate-limitům webů)
      await sleep(200);

    } catch (e) {
      console.error(`ERROR row ${rowNum}:`, e.message);
      updates.push({
        range: `'${SHEET_NAME}'!H${rowNum}:H${rowNum}`,
        values: [[`ERROR`]]
      });
      // pokračuj dál
    }
  }

  // zapiš posts.json
  if (processed > 0) {
    // volitelně: seřaď podle data desc
    posts.sort((a, b) => (new Date(b.date)) - (new Date(a.date)));
    writePostsJson(posts);
  }

  // proveď batch update do Sheets
  if (updates.length > 0) {
    await batchUpdate(sheets, updates);
  }

  console.log(`Done. Published rows: ${processed}`);
}

run().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
