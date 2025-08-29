// perplexity-sheet-to-github.js
// -------------------------------------------------------------
// Funkce:
// - čte z Google Sheet 'List 1' sloupce A (Datum) a D (URL)
// - filtruje: blocklist domén, minimální délka, deduplikace témat, agregátor vs preferovaný zdroj
// - MAX 3 články za den → další dostanou SKIP_DAY_LIMIT
// - vytvoří shrnutí (Perplexity → fallback) a vynutí češtinu (překlad, pokud je EN)
// - uloží MD do summaries/… na GitHubu
// - přidá kartu do docs/posts.json (web) s datem ze sloupce A
// - vrací stav do Sheetu: H=Status, I=MD URL, J=Poznámka
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
const SHEET_NAME     = 'List 1'; // POZOR: mezera v názvu
// Sloupce: A = Datum, D = URL, H = Status, I = MD URL, J = Poznámka

const auth = new google.auth.GoogleAuth({
  keyFile: 'google-service-account.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// ---- Heuristiky & limity ----
const MIN_CHARS   = 900;
const MAX_PER_DAY = 3;

const DOMAIN_BLOCKLIST = new Set([
  'gwa-prod-pxm-api.s3.amazonaws.com',
  'community.whattoexpect.com',
  'shefinds.com',
  'uk.news.yahoo.com',
  'thesun.co.uk',
  'the-independent.com',
]);

const DOMAIN_PREFERRED = new Set([
  'investor.lilly.com',
  'bbc.com',
  'cnbc.com',
  'drugtopics.com',
  'independent.co.uk',
]);

const DOMAIN_AGGREGATORS = new Set(['upday.com', 'gulfnews.com']);

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

// dedup: normalizace titulku + "topic bucket" pro jasné vzory
function normalizeTitle(t){
  return (t||'')
    .toLowerCase()
    .replace(/[“”"‘’'()]/g,' ')
    .replace(/[^a-z0-9\s-]/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}

function topicBucket(title){
  const t = (title||'').toLowerCase();
  if (/\bserena\s+williams\b/.test(t)) return 'topic:serena-williams';
  if (/\b(price\s+(rise|hike)|reimburse(ment)?|price(s)?|nhs)\b/.test(t) && /\b(uk|britain|england)\b/.test(t))
    return 'topic:uk-price';
  if (/\bshortage\b/.test(t) && /\b(uk|britain|england)\b/.test(t))
    return 'topic:uk-shortage';
  return normalizeTitle(title);
}

function jaccardSim(a, b){
  const A = new Set(a.split(' ').filter(Boolean));
  const B = new Set(b.split(' ').filter(Boolean));
  const inter = [...A].filter(x => B.has(x)).length;
  const uni = new Set([...A, ...B]).size || 1;
  return inter / uni;
}

// jazyk: jednoduchá detekce češtiny (alespoň 1 diakritika)
function isCzech(s = '') {
  return /[áéěíóúůýžščřďťňÁÉĚÍÓÚŮÝŽŠČŘĎŤŇ]/.test(s);
}

// -------------------------------------------------------------
// Sheets I/O
// -------------------------------------------------------------
async function getSheetRows(){
  const client = await auth.getClient();
  const sheets = google.sheets({ version:'v4', auth: client });

  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: SPREADSHEET_ID,
    ranges: [
      `${SHEET_NAME}!A2:A`,  // datum
      `${SHEET_NAME}!D2:D`,  // url
      `${SHEET_NAME}!H2:H`,  // status
      `${SHEET_NAME}!I2:I`,  // md url
    ],
  });

  const colA = res.data.valueRanges?.[0]?.values || [];
  const colD = res.data.valueRanges?.[1]?.values || [];
  const colH = res.data.valueRanges?.[2]?.values || [];
  const colI = res.data.valueRanges?.[3]?.values || [];

  const max = Math.max(colA.length, colD.length, colH.length, colI.length);
  const out = [];
  for (let i=0;i<max;i++){
    out.push({
      rowNumber: i+2,
      createdAtRaw: (colA[i]?.[0] || '').trim(),
      url: (colD[i]?.[0] || '').trim(),
      status: (colH[i]?.[0] || '').trim(),
      mdUrl: (colI[i]?.[0] || '').trim(),
    });
  }
  return out;
}

async function setSheetStatus(rowNumber, status, mdUrl='', note=''){
  try{
    const client = await auth.getClient();
    const sheets = google.sheets({ version:'v4', auth: client });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!H${rowNumber}:J${rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[status, mdUrl, note]] },
    });
  }catch(e){
    console.error(`Sheet update failed (row ${rowNumber}):`, e.message || e);
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
// Web (docs/) – přidání karty + denní limit
// -------------------------------------------------------------
function updateDocsSite({ title, dateISO, sourceUrl, sourceHost, mdUrl, summary }, existing){
  ensureDocsScaffold();
  const postsPath = path.join('docs','posts.json');

  let posts = [];
  try { posts = JSON.parse(fs.readFileSync(postsPath,'utf8')); } catch { posts = []; }

  // denní limit
  const day = toDayKey(dateISO);
  const countToday = posts.filter(p => toDayKey(p.date) === day).length;
  if (countToday >= MAX_PER_DAY) {
    return { added:false, reason:'DAY_LIMIT' };
  }

  // dedup (podle mdUrl/sourceUrl)
  if (posts.some(p => (p.mdUrl && p.mdUrl===mdUrl) || (p.sourceUrl && p.sourceUrl===sourceUrl))) {
    return { added:false, reason:'EXISTS' };
  }

  const card = {
    id: `${day}-${randId(6)}`,
    title: title || 'Shrnutí',
    date: new Date(dateISO).toISOString(),
    sourceUrl,
    sourceHost,
    mdUrl,
    summary: (summary || '').slice(0, 1200),
  };

  posts.unshift(card);
  if (posts.length > 200) posts = posts.slice(0,200);

  fs.writeFileSync(postsPath, JSON.stringify(posts, null, 2), 'utf8');
  // promítnout i do "existing" (pro dedup v rámci stejného běhu)
  existing && existing.unshift(card);
  return { added:true };
}

// -------------------------------------------------------------
// Hlavní běh
// -------------------------------------------------------------
async function run(){
  console.log(`Reading range: '${SHEET_NAME}'!A:D + H:I`);
  const rows = await getSheetRows();

  ensureDocsScaffold();
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync('docs/posts.json','utf8')); } catch { existing = []; }

  // Paměť témat (už existující + v průběhu runu)
  const seenTopics = new Set(existing.map(p => topicBucket(p.title || '')).filter(Boolean));

  for (const row of rows){
    const { rowNumber, createdAtRaw, url } = row;

    if (!url || !/^https?:\/\//i.test(url)){
      if (url) await setSheetStatus(rowNumber, 'SKIP_BAD_URL', '', 'Neplatná URL');
      continue;
    }
    if (row.status && row.status.toUpperCase().startsWith('OK') && row.mdUrl){
      // už zpracováno
      continue;
    }

    const host = hostOf(url);
    if (DOMAIN_BLOCKLIST.has(host)){
      await setSheetStatus(rowNumber, 'SKIP_BLOCKED_DOMAIN', '', host);
      continue;
    }

    // Datum karty = Datum z A (pokud jde přečíst), jinak dnešek
    const createdAt = parseSheetDate(createdAtRaw) || new Date();
    const dayKey = toDayKey(createdAt);

    // Denní limit předem – pokud už je den plný, přeskočme rychle
    const postsNow = (()=>{ try { return JSON.parse(fs.readFileSync('docs/posts.json','utf8')); } catch { return []; }})();
    const countForDay = postsNow.filter(p => toDayKey(p.date)===dayKey).length;
    if (countForDay >= MAX_PER_DAY){
      await setSheetStatus(rowNumber, 'SKIP_DAY_LIMIT', '', dayKey);
      continue;
    }

    try{
      console.log(`Stahuji článek: ${url}`);
      const { title, text } = await getArticleData(url);

      if (!text || text.length < MIN_CHARS){
        await setSheetStatus(rowNumber, 'SKIP_SHORT', '', `${text?.length||0} chars`);
        continue;
      }

      // dedup tématu (topic bucket + jaccard fallback)
      const bucket = topicBucket(title || '');
      if (bucket && seenTopics.has(bucket)){
        await setSheetStatus(rowNumber, 'SKIP_DUP_TOPIC', '', bucket);
        continue;
      }
      let dup = false;
      for (const p of existing){
        const sim = jaccardSim(normalizeTitle(title||''), normalizeTitle(p.title||''));
        if (sim >= 0.45){ dup = true; break; }
      }
      if (dup){
        await setSheetStatus(rowNumber, 'SKIP_DUP_TOPIC', '', 'SIM>=0.45');
        continue;
      }

      // agregátor vs preferovaný zdroj
      if (DOMAIN_AGGREGATORS.has(host)){
        const clash = existing.some(p =>
          jaccardSim(normalizeTitle(title||''), normalizeTitle(p.title||'')) >= 0.45 &&
          DOMAIN_PREFERRED.has(hostOf(p.sourceUrl||''))
        );
        if (clash){
          await setSheetStatus(rowNumber, 'SKIP_AGGREGATOR_DUP', '', host);
          continue;
        }
      }

      // --- shrnutí + vynucení češtiny ---
      let summary = '';
      let usedFallback = false;
      let usedTranslation = false;

      try{
        console.log('Posílám na Perplexity API…');
        summary = await getSummaryPerplexity(text);
        if (!isCzech(summary)) {
          try {
            summary = await translateToCzechWithPerplexity(summary || text.slice(0,1500));
            usedTranslation = true;
          } catch (e2) {
            console.log('Translate fallback selhal:', e2.message);
          }
        }
      }catch(e){
        console.log(`Perplexity selhalo – fallback: ${e.message}`);
        const sentences = text.split(/(?<=\.)\s+/).slice(0,3).join(' ');
        summary = sentences || text.slice(0,600);
        usedFallback = true;

        if (!isCzech(summary)) {
          try {
            summary = await translateToCzechWithPerplexity(summary);
            usedTranslation = true;
          } catch (e2) {
            console.log('Translate fallback selhal:', e2.message);
          }
        }
      }

      // MD na GitHub
      const mdUrl = await saveToGitHub({ title: title || 'Shrnutí článku', url, summary });

      // karta na web (s denním limitem)
      const res = updateDocsSite({
        title: title || 'Shrnutí',
        dateISO: createdAt.toISOString(),
        sourceUrl: url,
        sourceHost: host,
        mdUrl,
        summary,
      }, existing);

      if (!res.added && res.reason==='DAY_LIMIT'){
        await setSheetStatus(rowNumber, 'SKIP_DAY_LIMIT', mdUrl, dayKey);
        continue;
      }

      // zapsat OK/OK_FALLBACK + poznámku o překladu
      const note = usedTranslation ? 'translated to CS' : '';
      await setSheetStatus(rowNumber, usedFallback ? 'OK_FALLBACK' : 'OK', mdUrl, note);

      // přidat do paměti témat
      if (bucket) seenTopics.add(bucket);

      console.log(`Hotovo pro: ${url}`);
    }catch(e){
      await setSheetStatus(rowNumber, 'ERROR', '', e?.message || String(e));
      console.error(`Chyba u ${url}:`, e?.message || e);
    }
  }
}

// run
run().catch(err => { console.error('FATAL:', err); process.exit(1); });
