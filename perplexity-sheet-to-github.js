// perplexity-sheet-to-github.js
// -------------------------------------------------------------
// Režim "schvaluju ručně":
// - Skript nejdřív připraví náhled (CS_SUMMARY do sloupce L) a nastaví H=REVIEW.
// - Na web zveřejní jen řádky s K (PUBLISH?) = TRUE a M je prázdné.
// - Po zveřejnění vyplní H=PUBLISHED, I=MD URL, M=timestamp, N=CARD_ID, J=pozn.
// - Vynucuje češtinu (případně přeloží přes Perplexity).
// - Blokuje nevhodné domény, kontroluje minimální délku textu.
// - Denní limit v manuálním režimu defaultně nevynucuje (RESPECT_DAY_LIMIT=false).
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

// Sloupce:
// A = Datum
// D = URL
// H = Status (REVIEW | PUBLISHED | ERROR | SKIP_...)
// I = MD URL
// J = NOTE
// K = PUBLISH? (TRUE/FALSE)
// L = CS_SUMMARY (náhled shrnutí v češtině)
// M = PUBLISHED_AT (ISO timestamp)
// N = CARD_ID (id karty na webu)

const auth = new google.auth.GoogleAuth({
  keyFile: 'google-service-account.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// ---- Heuristiky & limity ----
const MIN_CHARS   = 900;
const RESPECT_DAY_LIMIT = false; // ruční režim: nechat false
const MAX_PER_DAY = 3;

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

async function setRow(rangeFromColHtoN, rowNumber, { status, mdUrl='', note='', publishAt='', cardId='', csSummary=null }){
  // rangeFromColHtoN = true → zapisujeme H..N, jinak jen H..J
  const client = await auth.getClient();
  const sheets = google.sheets({ version:'v4', auth: client });

  let values;
  let range;
  if (rangeFromColHtoN){
    // H I J K L M N – K (checkbox) necháme prázdné, protože si ho klikáš ručně
    // Zapíšeme: H=status, I=mdUrl, J=note, K= (no change), L=csSummary?, M=publishAt, N=cardId
    // Abychom K nepřepsali, použijeme dva write calls: H..J a L..N
    // 1) H..J
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!H${rowNumber}:J${rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[status, mdUrl, note]] },
    });
    // 2) L..N
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!L${rowNumber}:N${rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[csSummary ?? '', publishAt, cardId]] },
    });
    return;
  } else {
    // jen H..J (status, md, note)
    values = [[status, mdUrl, note]];
    range  = `${SHEET_NAME}!H${rowNumber}:J${rowNumber}`;
  }

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueInputOption: 'RAW',
    requestBody: { values },
  });
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

  // nepřidávej duplicitní stejný sourceUrl/mdUrl
  if (posts.some(p => (p.mdUrl && p.mdUrl===mdUrl) || (p.sourceUrl && p.sourceUrl===sourceUrl))) {
    return { added:false, reason:'EXISTS' };
  }

  // případný denní limit (v manuálním režimu defaultně vypnuto)
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

  for (const row of rows){
    const { rowNumber, createdAtRaw, url, status, mdUrl, publishFlag, csSummary, publishedAt, cardId } = row;

    if (!url || !/^https?:\/\//i.test(url)){
      if (url) await setRow(false, rowNumber, { status:'SKIP_BAD_URL', mdUrl:'', note:'Neplatná URL' });
      continue;
    }

    const host = hostOf(url);
    if (DOMAIN_BLOCKLIST.has(host)){
      // Pokud je bloklá doména, jen zapiš SKIP
      await setRow(false, rowNumber, { status:'SKIP_BLOCKED_DOMAIN', mdUrl:'', note:host });
      continue;
    }

    // 1) PŘÍPRAVA NÁHLEDU (shrnutí do L), pokud chybí
    if (!csSummary){
      try{
        console.log(`Náhled shrnutí: ${url}`);
        const { title, text } = await getArticleData(url);
        if (!text || text.length < MIN_CHARS){
          await setRow(false, rowNumber, { status:'SKIP_SHORT', mdUrl:'', note:`${text?.length||0} chars` });
          continue;
        }

        // shrnutí + vynucení češtiny
        let summary = '';
        try{
          summary = await getSummaryPerplexity(text);
          if (!isCzech(summary)){
            summary = await translateToCzechWithPerplexity(summary || text.slice(0,1500));
          }
        }catch(e){
          // fallback + překlad
          const sentences = text.split(/(?<=\.)\s+/).slice(0,3).join(' ');
          summary = sentences || text.slice(0,600);
          if (!isCzech(summary)){
            try { summary = await translateToCzechWithPerplexity(summary); } catch {}
          }
        }

        // Zapiš shrnutí do L + status REVIEW (připraveno ke schválení)
        await setRow(true, rowNumber, {
          status: 'REVIEW',
          mdUrl: '',
          note: '',
          publishAt: '',
          cardId: '',
          csSummary: summary
        });
        // nepokračuj na publikaci v tomto průchodu – čekáme na klik v K
        continue;
      }catch(e){
        await setRow(false, rowNumber, { status:'ERROR', mdUrl:'', note:e?.message || String(e) });
        continue;
      }
    }

    // 2) PUBLIKACE – pouze pokud je K=TRUE a zatím nebylo publikováno (M prázdné)
    if (publishFlag && !publishedAt){
      try{
        console.log(`Publikace na web: ${url}`);
        // Stáhni titulek (když ho nemáme) – text už máme shrnutý v L
        let title = '';
        try { title = (await getArticleData(url)).title || ''; } catch { title = ''; }

        // Ulož MD do GitHubu
        const mdLink = await saveToGitHub({
          title: title || 'Shrnutí článku',
          url,
          summary: csSummary
        });

        // Přidej kartu na web
        const createdAt = parseSheetDate(createdAtRaw) || new Date();
        const upd = updateDocsSite({
          title: title || 'Shrnutí',
          dateISO: createdAt.toISOString(),
          sourceUrl: url,
          sourceHost: host,
          mdUrl: mdLink,
          summary: csSummary,
        });

        if (!upd.added){
          await setRow(false, rowNumber, {
            status: 'ERROR',
            mdUrl: mdLink,
            note: upd.reason || 'unknown'
          });
          continue;
        }

        // Zapiš PUBLISHED + metadata
        await setRow(true, rowNumber, {
          status    : 'PUBLISHED',
          mdUrl     : mdLink,
          note      : '',
          publishAt : new Date().toISOString(),
          cardId    : upd.id,
          csSummary : csSummary // ponecháme pro tebe k náhledu
        });

      }catch(e){
        await setRow(false, rowNumber, { status:'ERROR', mdUrl:'', note:e?.message || String(e) });
      }
    } else {
      // nic – shrnutí je připravené a čekáme na K=TRUE
      if (!status || status === 'REVIEW'){
        await setRow(false, rowNumber, { status:'REVIEW', mdUrl: mdUrl || '', note: 'čeká na publikaci' });
      }
    }
  }
}

// run
run().catch(err => { console.error('FATAL:', err); process.exit(1); });
