require('dotenv').config({ path: './summaries.env' });
const { google } = require('googleapis');
const axios = require('axios');
const cheerio = require('cheerio');
const { Octokit } = require('@octokit/rest');

const perplexityApiKey = process.env.PERPLEXITY_API_KEY;
const githubToken = process.env.GITHUB_TOKEN;

const owner = 'OnLi1971';
const repo = 'mounjaro-summaries';
const branch = 'main';
const summariesDir = 'summaries';

// Google Sheets nastavení (SHEET_NAME můžeš nechat prázdné => autodetekce)
const SPREADSHEET_ID = process.env.SHEET_ID || '1KgrYXHpVfTAGQZT6f15aARGCQ-qgNQZM4HWQCiqt14s';
const SHEET_NAME = process.env.SHEET_NAME || ''; // např. 'List1' nebo 'Sheet1'
const RANGE = 'D2:D'; // sloupec D od druhého řádku

// Service account přihlašování – soubor vytvoříš v GHA kroku
const auth = new google.auth.GoogleAuth({
  keyFile: 'google-service-account.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});

// --- Helpers pro bezpečný název listu a rozsah --------------------------------
function a1(title, range) {
  // escapujeme apostrofy a vždy název listu uzavřeme do apostrofů
  const safeTitle = String(title || '').replace(/'/g, "''");
  return `'${safeTitle}'!${range}`;
}

async function resolveSheetTitle(sheetsApi, spreadsheetId, preferredTitle) {
  const meta = await sheetsApi.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets(properties(title))',
  });
  const titles = meta.data.sheets?.map(s => s.properties.title) || [];
  if (!titles.length) throw new Error('Spreadsheet has no sheets.');

  // 1) Pokud je zadáno SHEET_NAME a existuje, použij ho
  if (preferredTitle && titles.includes(preferredTitle)) return preferredTitle;

  // 2) Zkus common názvy
  const common = titles.find(t => t === 'List1' || t === 'Sheet1');
  if (common) return common;

  // 3) Jinak první list
  return titles[0];
}
// -----------------------------------------------------------------------------

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
  const urls = rows
    .map(r => (r?.[0] || '').toString().trim())
    .filter(Boolean);

  return urls;
}

async function getArticleText(url) {
  const res = await axios.get(url, {
    // trochu šetrné UA – některé weby jinak vrací prázdno
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SummarizerBot/1.0)' },
    timeout: 20000,
  });
  const $ = cheerio.load(res.data);
  let text = '';
  $('p').each((_, el) => {
    text += $(el).text() + '\n';
  });
  // limit ať nekrmíme LLM megadaty
  return text.slice(0, 6000);
}

async function getSummaryPerplexity(text) {
  const prompt = `Shrň následující článek do 6–8 bodů v češtině:\n\n${text}`;
  const response = await axios.post(
    'https://api.perplexity.ai/v1/chat/completions',
    {
      model: 'pplx-7b-chat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 600,
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
  return response.data.choices[0].message.content;
}

async function saveToGitHub(summary, url) {
  const octokit = new Octokit({ auth: githubToken });
  const today = new Date().toISOString().replace(/T.*/, '');
  const randomStr = Math.random().toString(36).substring(2, 8);
  const fileName = `${summariesDir}/${today}-${randomStr}.md`;
  const content = Buffer.from(
    `# Shrnutí článku\n\nOriginál: [${url}](${url})\n\n${summary}`,
    'utf8'
  ).toString('base64');

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: fileName,
    message: `Automaticky přidáno shrnutí článku: ${url}`,
    content,
    branch,
  });

  return `https://github.com/${owner}/${repo}/blob/${branch}/${fileName}`;
}

async function run() {
  try {
    const urls = await getUrlsFromSheet();
    if (!urls.length) {
      console.log('Ve sloupci D nejsou žádné URL – končím.');
      return;
    }

    for (const url of urls) {
      if (!/^https?:\/\//i.test(url)) continue;
      try {
        console.log(`Stahuji článek: ${url}`);
        const text = await getArticleText(url);

        if (!text || text.trim().length < 200) {
          console.warn('Vytažený text je prázdný/krátký – přeskočeno.');
          continue;
        }

        console.log('Posílám na Perplexity API...');
        const summary = await getSummaryPerplexity(text);

        console.log('Ukládám na GitHub...');
        const fileUrl = await saveToGitHub(summary, url);
        console.log('Hotovo! Shrnutí na:', fileUrl);
      } catch (e) {
        console.error(`Chyba u ${url}:`, e?.message || e);
      }
    }
  } catch (e) {
    console.error('Fatal error:', e?.message || e);
    process.exit(1);
  }
}

run();
