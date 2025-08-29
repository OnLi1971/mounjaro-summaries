// perplexity-sheet-to-github.js
// -------------------------------------------------------------
// Manuální publikace:
// - Každému řádku nejdřív ověříme/vyrobíme české shrnutí v L (CS_SUMMARY)
//   a nastavíme status REVIEW.
// - Publikujeme POUZE řádky s K (PUBLISH?) = TRUE a prázdným M (PUBLISHED_AT).
// - Po publikaci: H=PUBLISHED, I=MD URL, M=timestamp, N=CARD_ID, J=NOTE.
// - Zápisy do Sheets jsou frontované (batchUpdate) s retry/backoff.
// -------------------------------------------------------------

require('dotenv').config({ path: './summaries.env' });

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const axios = require('axios');
const cheerio = require('cheerio');
const { Octokit } = require('@octokit/rest');

// ---- Konfigurace env / repozitáře ----
const perplexityApiKey = process.env.PERPLEXITY_API_KEY || '';
const githubToken = process.env.GITHUB_TOKEN;

const owner = 'OnLi1971';
const repo  = 'mounjaro-summaries';
const branch = 'main';
const summariesDir = 'summaries';

// ---- Google Sheets ----
const SPREADSHEET_ID = '1KgrYXHpVfTAGQZT6f15aARGCQ-qgNQZM4HWQCiqt14s';
const SHEET_NAME     = 'List 1'; // přesně takhle (s mezerou)

// Sloupce:
// A = Datum
// D = URL
// H = Status (REVIEW | PUBLISHED | ERROR | SKIP_...)
// I = MD URL
// J = NOTE
// K = PUBLISH? (TRUE/FALSE)  ← klikáš ručně
// L = CS_SUMMARY (náhled shrnutí v češtině)
// M = PUBLISHED_AT (ISO timestamp)  ← vyplní skript
// N = CARD_ID (id karty na webu)    ← vyplní skript

const auth = new google.auth.GoogleAuth({
  keyFile: 'google-service-account.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// ---- Heuristiky & limity ----
const MIN_CHARS   = 900;
const RESPECT_DAY_LIMIT = false; // manuální režim: denní limit vypnutý
const MAX_PER_DAY = 2;

// Blokované domény (nepublikovat)
const DOMAIN_BLOCKLIST = new Set([
  'gwa-prod-pxm-api.s3.amazonaws.com',
  'community.whattoexpect.com',
  'shefinds.com',
  'uk.news.yahoo.com',
  'thesun.co.uk',
  'the-independent.com',
]);

// -------------------------------------------------------------
// Pomocné funkce
// -------------------------------------------------------------
function hostOf(u){ try { return new URL(u).hostname.replace(/^www\./,''); } catch { return ''; } }
function randId(n=6){ return Math.random().toString(36).slice(2, 2+n); }

function ensureDocsScaffold(){
  if (!fs.existsSync('docs')) fs.mkdirSync('docs', { recursive:true });
  const postsPath = path.join('docs','posts.json');
  if (!fs.existsSync(postsPath)) fs.writeFileSync(postsPath, '[]', 'utf8');
}

function toDayKey(date){
  const d = (date instanceof Date) ? date : new Date(date);
  return isNaN(d) ? new Date().toISOString().slice(0,10) : d.toISOString().slice(0,10);
}

function parseSheetDate(s){
  if (!s) return null;
  if (typeof s === 'number'){ // Google seriálové číslo
    const epoch = new Date(Math.round((s - 25569) * 86400 * 1000));
    return isNaN(epoch) ? null : epoch;
  }
  const m = String(s).trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return null;
  const [ , dd, mm, yyyy, hh='12', mi='00', ss='00'] = m;
  const d = new Date(Number(yyyy), Number(mm)-1, Number(dd), Number(hh), Number(mi), Number(ss));
  return isNaN(d) ? null : d;
}

function isCzech(s = '') {
  return /[áéěíóúůýžščřďťňÁÉĚÍÓÚŮÝŽŠČŘĎŤŇ]/.test(s);
}
function looksHtml(s=''){ return /<[^>]+>/.test(s); }
function stripHtml(s=''){ return s.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim(); }

// -------------------------------------------------------------
// Sheets write queue (batchUpdate + backoff) — proti HTTP 429
// -------------------------------------------------------------
const SHEET_BATCH_SIZE = 50;
const SHEET_MAX_RETRIES = 6;
const SHEET_QUEUE = [];

async function sheetsClient(){
  const client = await auth.getClient();
  return google.sheets({ version:'v4', auth: client });
}

async function queueSheetUpdate(range, valuesArr) {
  SHEET_QUEUE.push({ range, values: valuesArr });
  if (SHEET_QUEUE.length >= SHEET_BATCH_SIZE) {
    await flushSheetUpdates();
  }
}

async function flushSheetUpdates() {
  if (SHEET_QUEUE.length === 0) return;
  const svc = await sheetsClient();

  while (SHEET_QUEUE.length) {
    const chunk = SHEET_QUEUE.splice(0, SHEET_BATCH_SIZE);
    const data = chunk.map(u => ({ range: u.range, values: [u.values] })); // 1 řádek per range

    let attempt = 0;
    for (;;) {
      try {
        await svc.spreadsheets.values.batchUpdate({
          spreadsheetId: SPREADSHEET_ID,
          valueInputOption: 'RAW',
          requestBody: { data },
        });
        break; // OK
      } catch (e) {
        const status = e?.response?.status || e?.code;
        if (status === 429 || status === 503) {
          const retryAfter = parseInt(e?.response?.headers?.['retry-after'] || '0', 10);
          const delay = retryAfter > 0 ? retryAfter * 1000 : Math.min(32000, 1000 * Math.pow(2, attempt));
          attempt++;
          if (attempt > SHEET_MAX_RETRIES) {
            console.error('Sheets batchUpdate exceeded retries; failing chunk.', e.message || e);
            throw e;
          }
          console.warn(`Sheets ${status} — retrying in ${Math.round(delay/1000)}s (attempt ${attempt})`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw e; // jiná chyba
      }
    }
  }
}

// -------------------------------------------------------------
// Sheets I/O — načtení řádků a zapisovací helper
// -------------------------------------------------------------
async function getSheetRows(){
  const svc = await sheetsClient();

  const res = await svc.spreadsheets.values.batchGet({
    spreadsheetId: SPREADSHEET_ID,
    ranges: [
      `${SHEET_NAME}!A2:A`,  // datum
      `${SHEET_NAME}!D2:D`,  // url
      `${SHEET_NAME}!H2:H`,  // status
      `${SHEET_NAME}!I2:I`,  // md url
      `${SHEET_NAME}!J2:J`,  // note
      `${SHEET_NAME}!K2:K`,  // publish?
      `${SHEET_NAME}!L2:L`,  // cs_summary
      `${SHEET_NAME}!M2:M`,  // published_at
      `${SHEET_NAME}!N2:N`,  // card_id
    ],
  });

  const A = res.data.valueRanges?.[0]?.values || [];
  const D = res.data.valueRanges?.[1]?.values || [];
  const H = res.data.valueRanges?.[2]?.values || [];
  const I = res.data.valueRanges?.[3]?.values || [];
  const J = res.data.valueRanges?.[4]?.values || [];
  const K = res.data.valueRanges?.[5]?.values || [];
  const L = res.data.valueRanges?.[6]?.values || [];
  const M = res.data.valueRanges?.[7]?.values || [];
  const N = res.data.valueRanges?.[8]?.values || [];

  const max = Math.max(A.length,D.length,H.length,I.length,J.length,K.length,L.length,M.length,N.length);
  const out = [];
  for (let i=0;i<max;i++){
    out.push({
      rowNumber   : i+2,
      createdAtRaw: (A[i]?.[0] || '').trim(),
      url         : (D[i]?.[0] || '').trim(),
      status      : (H[i]?.[0] || '').trim(),
      mdUrl       : (I[i]?.[0] || '').trim(),
      note        : (J[i]?.[0] || '').trim(),
      publishFlag : (K[i]?.[0] || '').toString().toUpperCase() === 'TRUE',
      csSummary   : (L[i]?.[0] || '').trim(),
      publishedAt : (M[i]?.[0] || '').trim(),
      cardId      : (N[i]?.[0] || '').trim(),
    });
  }
  return out;
}

// zapisuje do H..J a/nebo L..N přes frontu
async function setRow(rangeFromColHtoN, rowNumber, { status, mdUrl='', note='', publishAt='', cardId='', csSummary=null }){
  if (rangeFromColHtoN){
    // H..J (status, mdUrl, note)
    await queueSheetUpdate(`${SHEET_NAME}!H${rowNumber}:J${rowNumber}`, [status, mdUrl, note]);
    // L..N (csSummary, publishedAt, cardId) — K (checkbox) nenecháváme měnit
    await queueSheetUpdate(`${SHEET_NAME}!L${rowNumber}:N${rowNumber}`, [csSummary ?? '', publishAt, cardId]);
  } else {
    // jen H..J
    await queueSheetUpdate(`${SHEET_NAME}!H${rowNumber}:J${rowNumber}`, [status, mdUrl, note]);
  }
}

// -------------------------------------------------------------
// Scraping & shrnutí
// -------------------------------------------------------------
async function getArticleData(url){
  const res = await axios.get(url, {
    headers:{
      'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
      'Accept-Language':'en;q=0.8,en-GB;q=0.7,cs;q=0.6',
    },
    timeout: 15000,
    maxRedirects: 5,
    validateStatus: s => (s>=200 && s<400) || s===403 || s===404,
  });

  if (res.status===403) throw new Error('HTTP 403');
  if (res.status===404) throw new Error('HTTP 404');

  const html = res.data;
  const $ = cheerio.load(html);

  const title =
    $('meta[property="og:title"]').attr('content')?.trim()
    || $('meta[name="twitter:title"]').attr('content')?.trim()
    || $('title').first().text().trim()
    || '';

  let text = '';
  $('p').each((_, el) => {
    const t = $(el).text().replace(/\s+/g,' ').trim();
    if (t) text += t + '\n';
  });
  text = text.trim();

  return { title, text: text.slice(0,8000) };
}

async function getSummaryPerplexity(text){
  if (!perplexityApiKey) throw new Error('Missing PERPLEXITY_API_KEY');
  const prompt = `Shrň česky do 6–8 odrážek.
- Odpovídej **pouze česky**.
- Žádný úvod ani závěr, jen odrážky.
---
${text}`;
  const resp = await axios.post(
    'https://api.perplexity.ai/v1/chat/completions',
    {
      model: 'pplx-7b-chat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 650,
      temperature: 0.2,
    },
    {
      headers: { Authorization: `Bearer ${perplexityApiKey}`, 'Content-Type': 'application/json' },
      timeout: 20000,
    }
  );
  return resp.data?.choices?.[0]?.message?.content?.trim() || '';
}

async function translateToCzechWithPerplexity(text) {
  if (!perplexityApiKey) throw new Error('Missing PERPLEXITY_API_KEY');
  const prompt = `Přelož následující text do **češtiny** a zachovej odrážky/strukturu. Vrať **jen text**, bez úvodu:\n\n${text}`;
  const resp = await axios.post(
    'https://api.perplexity.ai/v1/chat/completions',
    {
      model: 'pplx-7b-chat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 700,
      temperature: 0.1,
    },
    {
      headers: { Authorization: `Bearer ${perplexityApiKey}`, 'Content-Type': 'application/json' },
      timeout: 20000,
    }
  );
  return resp.data?.choices?.[0]?.message?.content?.trim() || '';
}

// -------------------------------------------------------------
// GitHub MD
// -------------------------------------------------------------
async function saveToGitHub({ title, url, summary }){
  const octokit = new Octokit({ auth: githubToken });
  const date = new Date().toISOString().slice(0,10);
  const baseName = `${date}-${randId(6)}`;
  const mdPath = `${summariesDir}/${baseName}.md`;

  const body = [
    `# ${title || 'Shrnutí článku'}`,
    ``,
    `Zdroj: [${url}](${url})`,
    ``,
    `${summary || ''}`,
    ``,
  ].join('\n');

  const content = Buffer.from(body,'utf8').toString('base64');

  try{
    await octokit.repos.createOrUpdateFileContents({
      owner, repo, path: mdPath, message: `Add summary: ${title || url}`, content, branch,
    });
    return `https://github.com/${owner}/${repo}/blob/${branch}/${mdPath}`;
  }catch(e){
    if (e?.status===409){
      const altPath = `${summariesDir}/${date}-${randId(8)}.md`;
      await octokit.repos.createOrUpdateFileContents({
        owner, repo, path: altPath, message: `Add summary: ${title || url}`, content, branch,
      });
      return `https://github.com/${owner}/${repo}/blob/${branch}/${altPath}`;
    }
    throw e;
  }
}

// -------------------------------------------------------------
// Web (docs/) – přidání karty; vrací {added, id, reason}
// -------------------------------------------------------------
function updateDocsSite({ title, dateISO, sourceUrl, sourceHost, mdUrl, summary }){
  ensureDocsScaffold();
  const postsPath = path.join('docs','posts.json');

  let posts = [];
  try { posts = JSON.parse(fs.readFileSync(postsPath,'utf8')); } catch { posts = []; }

  // neduplikovat stejné mdUrl/sourceUrl
  if (posts.some(p => (p.mdUrl && p.mdUrl===mdUrl) || (p.sourceUrl && p.sourceUrl===sourceUrl))) {
    return { added:false, reason:'EXISTS' };
  }

  if (RESPECT_DAY_LIMIT){
    const day = toDayKey(dateISO);
    const countToday = posts.filter(p => toDayKey(p.date) === day).length;
    if (countToday >= MAX_PER_DAY) {
      return { added:false, reason:'DAY_LIMIT' };
    }
  }

  const id = `${toDayKey(dateISO)}-${randId(6)}`;
  const card = {
    id,
    title: title || 'Shrnutí',
    date: new Date(dateISO).toISOString(),
    sourceUrl,
    sourceHost,
    mdUrl,
    summary: (summary || '').slice(0, 1200),
  };

  posts.unshift(card);
  if (posts.length > 400) posts = posts.slice(0,400);

  fs.writeFileSync(postsPath, JSON.stringify(posts, null, 2), 'utf8');
  return { added:true, id };
}

// -------------------------------------------------------------
// Hlavní běh
// -------------------------------------------------------------
async function run(){
  console.log(`Reading range: '${SHEET_NAME}'!A,D,H..N`);
  const rows = await getSheetRows();

  ensureDocsScaffold();

  try {
    for (const row of rows){
      const { rowNumber, createdAtRaw, url, status, mdUrl, publishFlag, csSummary, publishedAt } = row;

      if (!url || !/^https?:\/\//i.test(url)){
        if (url) await setRow(false, rowNumber, { status:'SKIP_BAD_URL', mdUrl:'', note:'Neplatná URL' });
        continue;
      }

      const host = hostOf(url);
      if (DOMAIN_BLOCKLIST.has(host)){
        await setRow(false, rowNumber, { status:'SKIP_BLOCKED_DOMAIN', mdUrl:'', note:host });
        continue;
      }

      // --- 1) zajisti kvalitní CS shrnutí v L ---
      let finalSummary = csSummary ? stripHtml(csSummary) : '';
      const summaryBad = !finalSummary || looksHtml(csSummary)
        || !isCzech(finalSummary) || finalSummary.length < 120;

      if (summaryBad) {
        try {
          console.log(`Generuji/opravuji shrnutí (CS): ${url}`);
          const { title: _t, text } = await getArticleData(url);
          if (!text || text.length < MIN_CHARS) {
            await setRow(false, rowNumber, { status:'SKIP_SHORT', mdUrl:'', note:`${text?.length||0} chars` });
            continue;
          }
          let summary = '';
          try {
            summary = await getSummaryPerplexity(text);
            if (!isCzech(summary)) {
              summary = await translateToCzechWithPerplexity(summary || text.slice(0,1500));
            }
          } catch {
            const sentences = text.split(/(?<=\.)\s+/).slice(0,3).join(' ');
            summary = sentences || text.slice(0,600);
            if (!isCzech(summary)) {
              try { summary = await translateToCzechWithPerplexity(summary); } catch {}
            }
          }
          finalSummary = stripHtml(summary);
          await setRow(true, rowNumber, {
            status: 'REVIEW',
            mdUrl: '',
            note: '',
            publishAt: '',
            cardId: '',
            csSummary: finalSummary
          });
        } catch(e) {
          await setRow(false, rowNumber, { status:'ERROR', mdUrl:'', note:e?.message || String(e) });
          continue;
        }
      }

      // --- 2) publikace, když chceš (K=TRUE) a ještě není zveřejněno ---
      if (publishFlag && !publishedAt) {
        try {
          console.log(`Publikace na web: ${url}`);
          let title = '';
          try { title = (await getArticleData(url)).title || ''; } catch {}
          const mdLink = await saveToGitHub({
            title: title || 'Shrnutí článku',
            url,
            summary: finalSummary
          });
          const createdAt = parseSheetDate(createdAtRaw) || new Date();
          const upd = updateDocsSite({
            title: title || 'Shrnutí',
            dateISO: createdAt.toISOString(),
            sourceUrl: url,
            sourceHost: host,
            mdUrl: mdLink,
            summary: finalSummary,
          });
          if (!upd.added){
            await setRow(false, rowNumber, {
              status: 'ERROR',
              mdUrl: mdLink,
              note: upd.reason || 'unknown'
            });
            continue;
          }
          await setRow(true, rowNumber, {
            status    : 'PUBLISHED',
            mdUrl     : mdLink,
            note      : '',
            publishAt : new Date().toISOString(),
            cardId    : upd.id,
            csSummary : finalSummary
          });
        } catch(e){
          await setRow(false, rowNumber, { status:'ERROR', mdUrl:'', note:e?.message || String(e) });
        }
      } else {
        // necháme v REVIEW a čekáme na klik
        if (!status || status === 'REVIEW'){
          await setRow(false, rowNumber, { status:'REVIEW', mdUrl: mdUrl || '', note: 'čeká na publikaci' });
        }
      }
    }
  } finally {
    // vždy vyprázdni frontu zápisů (i když se něco pokazí)
    await flushSheetUpdates();
  }
}

// run
run().catch(err => { console.error('FATAL:', err); process.exit(1); });
