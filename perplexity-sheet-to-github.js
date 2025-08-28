// perplexity-sheet-to-github.js
// -------------------------------------------------------------
// 1) Načte URL z Google Sheet ('List 1'!D2:D) + existující statusy (H–I)
// 2) Filtrovaně stáhne články, vygeneruje shrnutí (Perplexity -> fallback)
// 3) Uloží Markdown do repa (summaries/…) a přidá kartu do docs/posts.json
// 4) Zapíše výsledek zpět do Sheet (H:Status, I:MD URL, J:Poznámka)
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
const repo = 'mounjaro-summaries';
const branch = 'main';
const summariesDir = 'summaries';     // Markdown soubory

// ---- Google Sheets ----
const SPREADSHEET_ID = '1KgrYXHpVfTAGQZT6f15aARGCQ-qgNQZM4HWQCiqt14s';
const SHEET_NAME     = 'List 1';         // pozor na mezeru v názvu
// Sloupce: D = URL, H = Status, I = MD URL, J = Poznámka

const auth = new google.auth.GoogleAuth({
  keyFile: 'google-service-account.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// ---- Filtry & heuristiky kvality ----
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

const DOMAIN_AGGREGATORS = new Set([
  'upday.com',
  'gulfnews.com',
]);

const MIN_CHARS = 900; // minimální délka textu po scrapu

// -------------------------------------------------------------
// Pomocné funkce
// -------------------------------------------------------------
function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./,''); }
  catch { return ''; }
}

function normalizeTitle(t) {
  return (t || '')
    .toLowerCase()
    .replace(/[“”"‘’'()]/g,' ')
    .replace(/[^a-z0-9\s-]/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}

function jaccardSim(a, b) {
  const A = new Set(a.split(' ').filter(Boolean));
  const B = new Set(b.split(' ').filter(Boolean));
  const inter = [...A].filter(x => B.has(x)).length;
  const union = new Set([...A, ...B]).size || 1;
  return inter / union;
}

function randId(n = 6) {
  return Math.random().toString(36).slice(2, 2 + n);
}

function todayISO() {
  return new Date().toISOString().slice(0,10);
}

function ensureDocsScaffold() {
  if (!fs.existsSync('docs')) fs.mkdirSync('docs', { recursive: true });
  const postsPath = path.join('docs', 'posts.json');
  if (!fs.existsSync(postsPath)) fs.writeFileSync(postsPath, '[]', 'utf8');
}

// -------------------------------------------------------------
// Google Sheets I/O
// -------------------------------------------------------------
async function getSheetRows() {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  // Potřebujeme D (URL), H (Status), I (MD URL)
  const res = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: SPREADSHEET_ID,
    ranges: [
      `${SHEET_NAME}!D2:D`,
      `${SHEET_NAME}!H2:H`,
      `${SHEET_NAME}!I2:I`,
    ],
  });

  const colD = res.data.valueRanges?.[0]?.values || [];
  const colH = res.data.valueRanges?.[1]?.values || [];
  const colI = res.data.valueRanges?.[2]?.values || [];

  const max = Math.max(colD.length, colH.length, colI.length);
  const rows = [];
  for (let i = 0; i < max; i++) {
    rows.push({
      rowNumber: i + 2,
      url:     (colD[i]?.[0] || '').trim(),
      status:  (colH[i]?.[0] || '').trim(),
      mdUrl:   (colI[i]?.[0] || '').trim(),
    });
  }
  return rows;
}

async function setSheetStatus(rowNumber, status, mdUrl = '', note = '') {
  try {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_NAME}!H${rowNumber}:J${rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[status, mdUrl, note]] },
    });
  } catch (e) {
    console.error(`Sheet update failed (row ${rowNumber}):`, e.message || e);
  }
}

// -------------------------------------------------------------
// Scraping & summarization
// -------------------------------------------------------------
async function getArticleData(url) {
  const res = await axios.get(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'en;q=0.8,en-GB;q=0.7,cs;q=0.6',
    },
    timeout: 15000,
    maxRedirects: 5,
    validateStatus: s => (s >= 200 && s < 400) || s === 403 || s === 404,
  });

  if (res.status === 403) throw new Error('HTTP 403');
  if (res.status === 404) throw new Error('HTTP 404');

  const html = res.data;
  const $ = cheerio.load(html);

  // Titulek
  const title =
    $('meta[property="og:title"]').attr('content')?.trim() ||
    $('meta[name="twitter:title"]').attr('content')?.trim() ||
    $('title').first().text().trim() ||
    '';

  // Text (p tagy)
  let text = '';
  $('p').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t) text += t + '\n';
  });
  text = text.trim();

  return { title, text: text.slice(0, 8000) };
}

async function getSummaryPerplexity(text) {
  if (!perplexityApiKey) throw new Error('Missing PERPLEXITY_API_KEY');
  const prompt = `Stručně v češtině shrň hlavní body článku (6–8 odrážek). Buď věcný.
---
${text}`;

  const resp = await axios.post(
    'https://api.perplexity.ai/v1/chat/completions',
    {
      model: 'pplx-7b-chat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 600,
      temperature: 0.2,
    },
    {
      headers: {
        Authorization: `Bearer ${perplexityApiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 20000,
    }
  );

  return resp.data?.choices?.[0]?.message?.content?.trim() || '';
}

// -------------------------------------------------------------
// GitHub: uložení Markdownu
// -------------------------------------------------------------
async function saveToGitHub({ title, url, summary }) {
  const octokit = new Octokit({ auth: githubToken });
  const date = todayISO();
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

  const content = Buffer.from(body, 'utf8').toString('base64');

  try {
    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: mdPath,
      message: `Add summary: ${title || url}`,
      content,
      branch,
    });
  } catch (e) {
    // když náhodou kolize názvu – zkusíme nový název ještě jednou
    if (e?.status === 409) {
      const altPath = `${summariesDir}/${date}-${randId(8)}.md`;
      await octokit.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: altPath,
        message: `Add summary: ${title || url}`,
        content,
        branch,
      });
      return `https://github.com/${owner}/${repo}/blob/${branch}/${altPath}`;
    }
    throw e;
  }

  return `https://github.com/${owner}/${repo}/blob/${branch}/${mdPath}`;
}

// -------------------------------------------------------------
// Web (docs/) – přidání karty do posts.json
// -------------------------------------------------------------
function updateDocsSite({ title, date, sourceUrl, sourceHost, mdUrl, summary }) {
  ensureDocsScaffold();
  const postsPath = path.join('docs', 'posts.json');

  let posts = [];
  try { posts = JSON.parse(fs.readFileSync(postsPath, 'utf8')); }
  catch { posts = []; }

  // deduplikace podle mdUrl/sourceUrl
  const exists = posts.find(
    p => (p.mdUrl && p.mdUrl === mdUrl) || (p.sourceUrl && p.sourceUrl === sourceUrl)
  );
  if (exists) return; // nic nepřidávat

  const id = `${date}-${randId(6)}`;
  const card = {
    id,
    title: title || 'Shrnutí',
    date,
    sourceUrl,
    sourceHost,
    mdUrl,
    summary: (summary || '').slice(0, 1200),
  };

  posts.unshift(card);

  // limit
  if (posts.length > 200) posts = posts.slice(0, 200);

  fs.writeFileSync(postsPath, JSON.stringify(posts, null, 2), 'utf8');
}

// -------------------------------------------------------------
// Hlavní běh
// -------------------------------------------------------------
async function run() {
  console.log(`Reading range: '${SHEET_NAME}'!D2:D`);
  const rows = await getSheetRows();

  // Přednačti existující karty kvůli deduplikační paměti témat
  ensureDocsScaffold();
  let existing = [];
  try { existing = JSON.parse(fs.readFileSync('docs/posts.json','utf8')); }
  catch { existing = []; }

  const seenTopics = new Set(
    existing.map(p => normalizeTitle(p.title || '')).filter(Boolean)
  );

  for (const row of rows) {
    const { rowNumber, url } = row;
    if (!url || !/^https?:\/\//i.test(url)) {
      if (url) await setSheetStatus(rowNumber, 'SKIP_BAD_URL', '', 'Neplatná URL');
      continue;
    }

    // Nepřepisuj již hotové záznamy
    if (row.status && row.status.toUpperCase().startsWith('OK') && row.mdUrl) {
      continue;
    }

    const host = hostOf(url);
    if (DOMAIN_BLOCKLIST.has(host)) {
      console.log(`Skip (blocked domain): ${host}`);
      await setSheetStatus(rowNumber, 'SKIP_BLOCKED_DOMAIN', '', host);
      continue;
    }

    try {
      console.log(`Stahuji článek: ${url}`);
      const { title, text } = await getArticleData(url);

      if (!text || text.length < MIN_CHARS) {
        console.log(`Skip (short content: ${text?.length || 0} chars)`);
        await setSheetStatus(rowNumber, 'SKIP_SHORT', '', `${text?.length || 0} chars`);
        continue;
      }

      const topicKey = normalizeTitle(title || '');
      let isDup = false;
      for (const s of seenTopics) {
        if (jaccardSim(topicKey, s) >= 0.6) { isDup = true; break; }
      }
      if (isDup) {
        console.log(`Skip (duplicate topic): ${title}`);
        await setSheetStatus(rowNumber, 'SKIP_DUP_TOPIC', '', '');
        continue;
      }

      // Agregátory vs preferované zdroje (kolize tématu s již existující kartou)
      if (DOMAIN_AGGREGATORS.has(host)) {
        let clashWithPreferred = false;
        for (const p of existing) {
          if (
            jaccardSim(topicKey, normalizeTitle(p.title || '')) >= 0.6 &&
            DOMAIN_PREFERRED.has(hostOf(p.sourceUrl || ''))
          ) {
            clashWithPreferred = true;
            break;
          }
        }
        if (clashWithPreferred) {
          console.log(`Skip (aggregator vs preferred duplicate)`);
          await setSheetStatus(rowNumber, 'SKIP_AGGREGATOR_DUP', '', host);
          continue;
        }
      }

      // Shrnutí
      let summary = '';
      try {
        console.log('Posílám na Perplexity API…');
        summary = await getSummaryPerplexity(text);
      } catch (e) {
        console.log(`Perplexity selhalo – použiji fallback: ${e.message}`);
        // fallback: první 2–3 věty
        const sentences = text.split(/(?<=\.)\s+/).slice(0, 3).join(' ');
        summary = sentences || text.slice(0, 600);
      }

      // Ulož MD do GitHubu
      console.log('Ukládám Markdown do repa…');
      const mdUrl = await saveToGitHub({
        title: title || 'Shrnutí článku',
        url,
        summary,
      });

      // Karta na web
      console.log('Aktualizuji statický web (docs/)…');
      updateDocsSite({
        title: title || 'Shrnutí',
        date: new Date().toISOString(),
        sourceUrl: url,
        sourceHost: host,
        mdUrl,
        summary,
      });

      // Zapíšeme status do sheetu
      await setSheetStatus(rowNumber, 'OK', mdUrl, '');

      // do dedup paměti
      if (topicKey) seenTopics.add(topicKey);

      console.log(`Hotovo pro: ${url}`);
    } catch (e) {
      const msg = e?.message || String(e);
      console.error(`Chyba u ${url}: ${msg}`);
      await setSheetStatus(rowNumber, 'ERROR', '', msg);
    }
  }
}

// Spusť
run().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
