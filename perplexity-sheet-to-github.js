require('dotenv').config({ path: './summaries.env' });
const { google } = require('googleapis');
const axios = require('axios');
const cheerio = require('cheerio');
const { Octokit } = require('@octokit/rest');

const perplexityApiKey = process.env.PERPLEXITY_API_KEY;
const githubToken = process.env.GITHUB_TOKEN;
const owner = "OnLi1971";
const repo = "mounjaro-summaries";
const branch = "main";
const summariesDir = "summaries";

// Google Sheets nastavení
const SPREADSHEET_ID = '1KgrYXHpVfTAGQZT6f15aARGCQ-qgNQZM4HWQCiqt14s';
const SHEET_NAME = 'List1';
const RANGE = 'D2:D'; // Sloupec D od druhé řádky

const auth = new google.auth.GoogleAuth({
  keyFile: 'google-service-account.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

async function getUrlsFromSheet() {
  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!${RANGE}`,
  });
  return res.data.values?.map(row => row[0]).filter(Boolean) || [];
}

async function getArticleText(url) {
  const res = await axios.get(url);
  const $ = cheerio.load(res.data);
  let text = '';
  $('p').each((_, el) => {
    text += $(el).text() + '\n';
  });
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
      temperature: 0.4
    },
    {
      headers: {
        Authorization: `Bearer ${perplexityApiKey}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return response.data.choices[0].message.content;
}

async function saveToGitHub(summary, url) {
  const octokit = new Octokit({ auth: githubToken });
  const today = new Date().toISOString().replace(/T.*/, "");
  const randomStr = Math.random().toString(36).substring(2, 8);
  const fileName = `${summariesDir}/${today}-${randomStr}.md`;
  const content = Buffer.from(`# Shrnutí článku\n\nOriginál: [${url}](${url})\n\n${summary}`, "utf8").toString("base64");

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
  const urls = await getUrlsFromSheet();
  for (const url of urls) {
    if (!url.startsWith('http')) continue;
    try {
      console.log(`Stahuji článek: ${url}`);
      const text = await getArticleText(url);
      console.log("Posílám na Perplexity API...");
      const summary = await getSummaryPerplexity(text);
      console.log("Ukládám na GitHub...");
      const fileUrl = await saveToGitHub(summary, url);
      console.log("Hotovo! Shrnutí na:", fileUrl);
    } catch (e) {
      console.error(`Chyba u ${url}:`, e.message);
    }
  }
}

run();
