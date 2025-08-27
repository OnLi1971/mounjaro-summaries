// perplexity-sheet-to-github.js
require('dotenv').config({ path: './summaries.env' });

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const { google } = require('googleapis');
const { Octokit } = require('@octokit/rest');

// --- KONFIG ---
const perplexityApiKey = process.env.PERPLEXITY_API_KEY;
const githubToken = process.env.GITHUB_TOKEN;

const owner = 'OnLi1971';
const repo = 'mounjaro-summaries';
const branch = 'main';
const summariesDir = 'summaries';

// Google Sheets
const SPREADSHEET_ID = '1KgrYXHpVfTAGQZT6f15aARGCQ-qgNQZM4HWQCiqt14s';
const SHEET_NAME = 'List 1';        // POZOR: s mezerou
const RANGE = 'D2:D';               // URL ve sloupci D od řádku 2

const auth = new google.auth.GoogleAuth({
  keyFile: 'google-service-account.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});

// --- UTIL: Markdown šablona jen se shrnutím ---
function escapeMd(s = '') {
  return String(s).replace(/"/g, '\\"');
}

function markdownForPost({ title, url, dateIso, summaryCz, sourceHost }) {
  return `---
title: "${escapeMd(title)}"
date: ${dateIso}
source: "${escapeMd(sourceHost || '')}"
source_url: ${url}
---

## Shrnutí (CZ)
${summaryCz || '_Shrnutí se nepodařilo vygenerovat._'}

---

[Otevřít zdroj](${url})
`;
}

// --- DETEKCE ČEŠTINY ---
function looksCzech(s = '') {
  return /[áéěíóúůýžščřďťňÁÉĚÍÓÚŮÝŽŠČŘĎŤŇ]/.test(s);
}

// --- PERPLEXITY: Shrnutí rovnou v češtině ---
async function getSummaryPerplexityCz(text) {
  const prompt = [
    'Shrň následující článek do 5–8 vět v češtině.',
    'Piš plynule (bez odrážek), bez úvodů typu "Shrnutí:".',
    'Zůstaň věcný, žádná doporučení ohledně léčby.',
    '',
    text,
  ].join('\n');

  const response = await axios.post(
    'https://api.perplexity.ai/chat/completions',
    {
      model: 'pplx-7b-chat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 700,
      temperature: 0.3,
    },
    {
      headers: {
        Authorization: `Bearer ${perplexityApiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 60_000,
    }
  );

  const out = response.data?.choices?.[0]?.message?.content?.trim() || '';
  return out;
}

// --- PERPLEXITY: Překlad do češtiny (fallback) ---
async function translateToCzechViaPerplexity(text) {
  const prompt = `Přelož do češtiny. Vrať jen překlad, bez jakýchkoli poznámek:\n\n${text}`;
  const response = await axios.post(
    'https://api.perplexity.ai/chat/completions',
    {
      model: 'sonar', // nebo 'sonar-pro'
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 900,
      temperature: 0.2,
    },
    {
      headers: {
        Authorization: `Bearer ${perplexityApiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 60_000,
    }
  );
  return response.data?.choices?.[0]?.message?.content?.trim() || '';
}

// --- Fallback shrnutí bez LLM (anglicky) ---
function summarizeFallbackEn(text = '') {
  if (!text) return '';
  const paras = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  if (paras[0]?.length > 160) return paras[0].slice(0, 700);
  const sentences = (text.match(/[^.!?]+[.!?]+/g) || []).map(s => s.trim());
  return (sentences.slice(0, 3).join(' ')).slice(0, 700);
}

// --- Vytěžení HTML a textu článku ---
async function getArticle(textUrl) {
  const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/123.0 Safari/537.36';

  // 1) pokus s běžným UA
  try {
    const res = await axios.get(textUrl, { headers: { 'User-Agent': UA }, timeout: 30_000 });
    return extractFromHtml(res.data, textUrl);
  } catch (e1) {
    // 2) druhý pokus bez UA (někdy naopak pomůže)
    try {
      const res2 = await axios.get(textUrl, { timeout: 30_000 });
      return extractFromHtml(res2.data, textUrl);
    } catch (e2) {
      throw e1; // vrať původní chybu
    }
  }
}

function extractFromHtml(html, baseUrl) {
  const $ = cheerio.load(html);

  // Titulek: og:title → <title> → fallback hostname
  const og = $('meta[property="og:title"]').attr('content') || $('meta[name="og:title"]').attr('content');
  const rawTitle = og || $('title').first().text() || '';
  const title = rawTitle.replace(/\s+\|\s+.+$/, '').trim() || new URL(baseUrl).hostname;

  // Text: všechny <p> (bez nav/footer/script)
  $('script,noscript,style,header,footer,nav,form,aside').remove();
  let text = '';
  $('p').each((_, el) => {
    const t = $(el).text().trim();
    if (t && t.length > 2) text += t + '\n\n';
  });
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return { title, text };
}

// --- Uložení MD do repa (jen shrnutí) ---
async function saveToGitHub({ title, url, summaryCz, sourceHost }) {
  const octokit = new Octokit({ auth: githubToken });

  const today = new Date().toISOString().replace(/T.*/, '');
  const randomStr = Math.random().toString(36).slice(2, 8);
  const mdPath = `${summariesDir}/${today}-${randomStr}.md`;
  const dateIso = new Date().toISOString();

  const md = markdownForPost({
    title: title || 'Shrnutí článku',
    url,
    dateIso,
    summaryCz: summaryCz || '',
    sourceHost,
  });

  const contentB64 = Buffer.from(md, 'utf8').toString('base64');

  // create or update (řeší 409)
  try {
    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: mdPath,
      message: `Add summary: ${title || url}`,
      content: contentB64,
      branch,
    });
  } catch (e) {
    if (e.status === 409) {
      const { data } = await octokit.repos.getContent({ owner, repo, path: mdPath, ref: branch });
      const sha = Array.isArray(data) ? null : data.sha;
      await octokit.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: mdPath,
        message: `Update summary: ${title || url}`,
        content: contentB64,
        sha,
        branch,
      });
    } else {
      throw e;
    }
  }

  return `https://github.com/${owner}/${repo}/blob/${branch}/${mdPath}`;
}

// --- posts.json upsert + scaffold docs/ ---
function ensureDocsScaffold() {
  if (!fs.existsSync('docs')) fs.mkdirSync('docs');
  if (!fs.existsSync('docs/.nojekyll')) fs.writeFileSync('docs/.nojekyll', '');
  if (!fs.existsSync('docs/posts.json')) fs.writeFileSync('docs/posts.json', '[]', 'utf8');
}

function upsertPostsJson(existing, post) {
  const arr = Array.isArray(existing) ? existing.slice() : [];
  const i = arr.findIndex(x => x.sourceUrl === post.sourceUrl);
  if (i !== -1) arr.splice(i, 1);
  arr.unshift(post);
  return arr.slice(0, 200); // držíme posledních 200
}

// --- Sheets načtení URL ---
async function getUrlsFromSheet() {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!${RANGE}`,
  });

  const urls = (res.data.values || [])
    .map(r => (r && r[0] ? String(r[0]).trim() : ''))
    .filter(u => u && /^https?:\/\//i.test(u));

  return urls;
}

// --- MAIN ---
async function run() {
  console.log(`Reading range: '${SHEET_NAME}'!${RANGE}`);
  ensureDocsScaffold();

  const urls = await getUrlsFromSheet();

  for (const url of urls) {
    try {
      console.log(`Stahuji článek: ${url}`);

      // 1) článek
      const { title: extractedTitle, text } = await getArticle(url);
      if (!text || text.length < 200) {
        console.warn('Vytažený text je prázdný/krátký – přeskočeno.');
        continue;
      }

      // 2) shrnutí → čeština
      let summaryCz = '';
      try {
        console.log('Posílám na Perplexity API…');
        summaryCz = await getSummaryPerplexityCz(text);
      } catch (e) {
        console.warn('Perplexity summary failed, fallback:', e?.message || e);
      }

      if (!summaryCz) {
        // fallback EN → překlad
        const fb = summarizeFallbackEn(text);
        if (fb) {
          try {
            summaryCz = await translateToCzechViaPerplexity(fb);
          } catch (e2) {
            console.warn('Perplexity translate failed, ponechám EN fallback.');
            summaryCz = fb;
          }
        }
      }

      if (summaryCz && !looksCzech(summaryCz)) {
        try {
          summaryCz = await translateToCzechViaPerplexity(summaryCz);
        } catch {
          // necháme, jak je
        }
      }

      // 3) ulož MD (jen shrnutí)
      const sourceHost = new URL(url).hostname.replace(/^www\./, '');
      const mdUrl = await saveToGitHub({
        title: extractedTitle || 'Shrnutí článku',
        url,
        summaryCz,
        sourceHost,
      });

      // 4) upsert do docs/posts.json
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const postItem = {
        id,
        title: extractedTitle || 'Summary',
        date: new Date().toISOString(),
        summary: summaryCz,
        sourceHost,
        sourceUrl: url,
        mdUrl, // GitHub blob odkaz
      };

      let posts = [];
      try {
        posts = JSON.parse(fs.readFileSync('docs/posts.json', 'utf8'));
      } catch {}
      posts = upsertPostsJson(posts, postItem);
      fs.writeFileSync('docs/posts.json', JSON.stringify(posts, null, 2), 'utf8');

      console.log('Uloženo:', { mdUrl, sourceHost });
    } catch (e) {
      console.error(`Chyba u ${url}:`, e?.response?.status ? `HTTP ${e.response.status}` : (e?.message || e));
    }
  }
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
