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

// Google Sheets
const SPREADSHEET_ID = "1KgrYXHpVfTAGQZT6f15aARGCQ-qgNQZM4HWQCiqt14s";
const SHEET_NAME = "List 1";              // přesný název listu
const URL_COL = "D";                       // odkud čteme URL
const STATUS_COL = "H";                    // zpětný zápis statusu
const MD_URL_COL = "I";                    // zpětný zápis MD URL
const PROCESSED_AT_COL = "J";              // zpětný zápis času
const URL_RANGE = `${SHEET_NAME}!${URL_COL}2:${URL_COL}`;

// Google auth
const auth = new google.auth.GoogleAuth({
  keyFile: 'google-service-account.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// Axios UA + timeouty, ať máme menší šanci na 403
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
 * Načte D-sloupec s URL a vrátí {url, row} – row je skutečné číslo řádku v listu.
 */
async function getUrlRows() {
  const sheets = await getSheetsClient();
  console.log(`Reading range: '${SHEET_NAME}'!${URL_COL}2:${URL_COL}`);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: URL_RANGE,
  });
  const values = res.data.values || [];
  const rows = [];
  for (let i = 0; i < values.length; i++) {
    const raw = (values[i][0] || '').toString().trim();
    if (!raw) continue;
    const rowNumber = 2 + i; // protože začínáme na řádku 2
    rows.push({ url: raw, row: rowNumber });
  }
  return rows;
}

/**
 * Zapíše do H–J (Status, MD URL, ProcessedAt) na daný řádek.
 */
async function writeBackStatus(row, status, mdUrl) {
  try {
    const sheets = await getSheetsClient();
    const range = `${SHEET_NAME}!${STATUS_COL}${row}:${PROCESSED_AT_COL}${row}`;
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

/** ====== TEXT EXTRAKCE ====== **/
async function getArticleText(url) {
  try {
    const res = await http.get(url);
    const $ = cheerio.load(res.data);
    // Zkusíme základ – všechny <p>
    let text = '';
    $('p').each((_, el) => {
      const t = $(el).text().trim();
      if (t && t.length > 0) {
        text += t + '\n';
      }
    });
    text = text.replace(/\n{3,}/g, '\n\n').trim();
    if (text.length < 200) {
      // fallback: vezmeme i headings a meta-desc
      const heads = [];
      $('h1,h2,h3').each((_, el) => {
        const t = $(el).text().trim();
        if (t) heads.push(t);
      });
      const metaDesc = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';
      const extra = (heads.join(' • ') + '\n' + metaDesc).trim();
      text = (text + '\n' + extra).trim();
    }
    return text.slice(0, 6000);
  } catch (e) {
    // Prohoď status nahoru – volající si ho zpracuje
    const code = e.response?.status || 'ERR';
    throw new Error(`FETCH_${code}`);
  }
}

/** ====== PERPLEXITY ====== **/
async function getSummaryPerplexity(text) {
  if (!perplexityApiKey) {
    throw new Error('PERPLEXITY_NO_KEY');
  }
  const prompt = `Shrň následující článek do 6–8 bodů v češtině:\n\n${text}`;
  try {
    const response = await axios.post(
      'https://api.perplexity.ai/v1/chat/completions',
      {
        model: 'pplx-7b-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 600,
        temperature: 0.4
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
async function saveToGitHub(summary, url) {
  const octokit = new Octokit({ auth: githubToken });
  const today = new Date().toISOString().replace(/T.*/, "");
  const randomStr = Math.random().toString(36).substring(2, 8);
  const fileName = `${summariesDir}/${today}-${randomStr}.md`;
  const titleHost = (() => {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
  })();

  const md = [
    `# Shrnutí článku`,
    ``,
    `**Zdroj:** [${titleHost}](${url})`,
    ``,
    summary && summary.trim().length > 0 ? summary : "_Shrnutí nebylo k dispozici._"
  ].join('\n');

  const content = Buffer.from(md, "utf8").toString("base64");

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: fileName,
    message: `Add summary: ${titleHost}`,
    content,
    branch,
  });

  return `https://github.com/${owner}/${repo}/blob/${branch}/${fileName}`;
}

/** ====== (VOLITELNÉ) – aktualizace statického webu v docs/ ======
 * Pokud už to máš hotové ve zvláštním kroku, nech to jak je.
 * Tady je minimalistický no-op – doplň podle své verze.
 */
async function updateStaticSiteMinimal() {
  // Pokud máš vlastní generátor posts.json / index.html, nechej svou verzi.
  return;
}

/** ====== MAIN ====== **/
async function run() {
  const urlRows = await getUrlRows();

  for (const { url, row } of urlRows) {
    if (!/^https?:\/\//i.test(url)) {
      await writeBackStatus(row, 'BAD_URL', '');
      continue;
    }

    try {
      console.log(`Stahuji článek: ${url}`);
      const text = await getArticleText(url);
      if (!text || text.trim().length < 80) {
        await writeBackStatus(row, 'TEXT_EMPTY', '');
        console.log('Vytažený text je prázdný/krátký – přeskočeno.');
        continue;
      }

      let summary = '';
      let status = 'OK';

      try {
        console.log('Posílám na Perplexity API…');
        summary = await getSummaryPerplexity(text);
        status = 'OK';
      } catch (perr) {
        console.log(`Perplexity selhalo – použiji fallback bez LLM: ${perr.message}`);
        // Fallback bez LLM: první odstavec / několik vět
        summary = simpleFallbackSummary(text);
        status = 'OK_FALLBACK';
      }

      console.log('Ukládám Markdown do repa…');
      const mdUrl = await saveToGitHub(summary, url);

      // (volitelně) update webu
      await updateStaticSiteMinimal();

      // Zapis do Sheets
      await writeBackStatus(row, status, mdUrl);
      console.log(`Hotovo pro: ${url}`);

      // malá pauza mezi články, ať nejsme podezřelí
      await sleep(800);

    } catch (e) {
      const msg = e.message || 'ERR';
      console.error(`Chyba u ${url}: ${msg}`);
      // Zapsat status do Sheets i při chybě
      await writeBackStatus(row, msg.substring(0, 40), '');
      await sleep(400);
    }
  }
}

/** ====== HELPERS ====== **/
function simpleFallbackSummary(text) {
  const paras = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  if (paras[0]) {
    const p = paras[0].length > 600 ? paras[0].slice(0, 600) + '…' : paras[0];
    return p;
  }
  // fallback: první 600 znaků
  return text.slice(0, 600) + (text.length > 600 ? '…' : '');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Spusť
run().catch(e => {
  console.error(e);
  process.exit(1);
});
