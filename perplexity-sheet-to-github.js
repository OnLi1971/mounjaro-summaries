// perplexity-sheet-to-github.js
require('dotenv').config({ path: './summaries.env' });

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const { google } = require('googleapis');
const { Octokit } = require('@octokit/rest');

// === KONFIGURACE ===
const perplexityApiKey = process.env.PERPLEXITY_API_KEY;
const githubToken = process.env.GITHUB_TOKEN;

const owner = 'OnLi1971';
const repo = 'mounjaro-summaries';
const branch = 'main';
const summariesDir = 'summaries';

// Google Sheets
const SPREADSHEET_ID = '1KgrYXHpVfTAGQZT6f15aARGCQ-qgNQZM4HWQCiqt14s';
const SHEET_NAME = 'List 1'; // přesný název listu
const RANGE = 'D2:D';        // URL ve sloupci D

// Výběr článků
const DAILY_LIMIT = 2;       // kolik “top” článků za den poslat na homepage
const MIN_TEXT_CHARS = 800;  // minimální délka vytaženého textu pro úvahu

// Host blocklist (nepublikovat)
const BLOCKED_HOSTS = new Set([
  'youtube.com', 'm.youtube.com', 'youtu.be',
  'community.whattoexpect.com',
  's3.amazonaws.com', 'gwa-prod-pxm-api.s3.amazonaws.com',
  'thesun.co.uk', 'www.thesun.co.uk',
  'dailymail.co.uk', 'www.dailymail.co.uk',
  'pressreader.com', 'www.pressreader.com',
  'facebook.com', 'x.com', 'twitter.com', 't.co',
]);

// Host váhy (vyšší = důvěryhodnější)
const HOST_WEIGHTS = {
  'nejm.org': 10,
  'thelancet.com': 9,
  'jamanetwork.com': 9,
  'nature.com': 8,
  'sciencedirect.com': 7,
  'diabetesjournals.org': 8, // Diabetes Care
  'ema.europa.eu': 9,
  'fda.gov': 9,
  'reuters.com': 7,
  'apnews.com': 7,
  'bloomberg.com': 7,
  'statnews.com': 7,
  'fiercepharma.com': 6,
  'pharmacytimes.com': 6,
  'hcplive.com': 6,
  'medpagetoday.com': 6,
  'cnn.com': 5,
  'bbc.com': 5,
  'empr.com': 5,
  'thelilly.com': 6, 'lilly.com': 6, 'investor.lilly.com': 6,
  'novonordisk.com': 6, 'novonordisk-us.com': 6,
};

// Klíčová slova (pozitivní/negativní body)
const KEYWORD_WEIGHTS = [
  { re: /\bphase\s*3\b/i, w: 4 },
  { re: /\brandomi[sz]ed\b/i, w: 3 },
  { re: /\btrial(s)?\b/i, w: 2 },
  { re: /\bapproval|approved|authori[sz]ation|submission\b/i, w: 4 },
  { re: /\bFDA|EMA|MHRA|NICE\b/i, w: 4 },
  { re: /\bGLP-?1\b/i, w: 2 },
  { re: /\bGIP\b/i, w: 1 },
  { re: /\bobesity|type 2 diabetes|T2D\b/i, w: 2 },
  { re: /\btirzepatide|semaglutide|orforglipron|retatrutide\b/i, w: 3 },
  { re: /\bpress release\b/i, w: 1 },
];

const NEGATIVE_WEIGHTS = [
  { re: /\bcelebrity|gossip|influencer\b/i, w: -4 },
  { re: /\bforum|thread|discussion\b/i, w: -3 },
  { re: /\bopinion|op-ed|commentary\b/i, w: -2 },
  { re: /\bvideo|podcast\b/i, w: -1 },
];

// === Google Auth ===
const auth = new google.auth.GoogleAuth({
  keyFile: 'google-service-account.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});

// === Pomocné ===
function escapeMd(s = '') {
  return String(s).replace(/"/g, '\\"');
}
function looksCzech(s = '') {
  return /[áéěíóúůýžščřďťňÁÉĚÍÓÚŮÝŽŠČŘĎŤŇ]/.test(s);
}
function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
}
function normalizeUrl(u) {
  try {
    // rozbal Google redirect
    if (/^https:\/\/(www\.)?google\.com\/url\?/.test(u)) {
      const urlParam = new URL(u).searchParams.get('url') || new URL(u).searchParams.get('q');
      if (urlParam) u = decodeURIComponent(urlParam);
    }
    const url = new URL(u);
    // odstranit běžné tracking parametry
    ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','gclid','fbclid'].forEach(p => url.searchParams.delete(p));
    return url.toString();
  } catch {
    return u;
  }
}
function sameDayISO(isoA, isoB) {
  return (isoA || '').slice(0,10) === (isoB || '').slice(0,10);
}

// === Frontend scaffolding ===
function ensureDocsScaffold() {
  if (!fs.existsSync('docs')) fs.mkdirSync('docs');
  if (!fs.existsSync('docs/.nojekyll')) fs.writeFileSync('docs/.nojekyll', '');
  if (!fs.existsSync('docs/posts.json')) fs.writeFileSync('docs/posts.json', '[]', 'utf8');
}

// === HTML → title+text ===
async function fetchHtml(url) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36';
  try {
    return (await axios.get(url, { headers: { 'User-Agent': UA }, timeout: 30_000 })).data;
  } catch (e1) {
    return (await axios.get(url, { timeout: 30_000 })).data; // druhý pokus
  }
}
function extractFromHtml(html, baseUrl) {
  const $ = cheerio.load(html);
  const og = $('meta[property="og:title"]').attr('content') || $('meta[name="og:title"]').attr('content');
  const rawTitle = og || $('title').first().text() || '';
  const title = rawTitle.replace(/\s+\|\s+.+$/, '').trim() || hostOf(baseUrl);

  $('script,noscript,style,header,footer,nav,form,aside').remove();
  let text = '';
  $('p').each((_, el) => {
    const t = $(el).text().trim();
    if (t && t.length > 2) text += t + '\n\n';
  });
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  return { title, text };
}

// === Skórování článku ===
function scoreArticle({ title = '', text = '', url = '' }) {
  const h = hostOf(url);
  let score = 0;

  // host weight
  if (HOST_WEIGHTS[h] != null) score += HOST_WEIGHTS[h];

  // block host → -999
  if (BLOCKED_HOSTS.has(h)) score -= 999;

  // minimální délka
  if ((text || '').length < MIN_TEXT_CHARS) score -= 3;

  const hay = `${title}\n${text}`.toLowerCase();

  // pozitivní
  KEYWORD_WEIGHTS.forEach(({ re, w }) => { if (re.test(hay)) score += w; });
  // negativní
  NEGATIVE_WEIGHTS.forEach(({ re, w }) => { if (re.test(hay)) score += w; });

  return score;
}

// === Perplexity (CZ shrnutí) ===
const PPLX_API = 'https://api.perplexity.ai/chat/completions';
const PPLX_MODEL = 'sonar'; // případně 'sonar-pro'

async function getSummaryPerplexityCz(text) {
  const prompt = [
    'Shrň následující článek do 5–8 vět v češtině.',
    'Piš plynule (bez odrážek), bez úvodů typu "Shrnutí:".',
    'Buď věcný, bez lékařských doporučení.',
    '',
    text,
  ].join('\n');

  const res = await axios.post(
    PPLX_API,
    { model: PPLX_MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 700, temperature: 0.3 },
    { headers: { Authorization: `Bearer ${perplexityApiKey}`, 'Content-Type': 'application/json' }, timeout: 60_000, validateStatus: () => true }
  );
  if (res.status !== 200) throw new Error(`Perplexity summary HTTP ${res.status}: ${JSON.stringify(res.data).slice(0,180)}`);
  return (res.data?.choices?.[0]?.message?.content || '').trim();
}
async function translateToCzechViaPerplexity(text) {
  const prompt = `Přelož do češtiny. Vrať jen čistý překlad, bez komentářů:\n\n${text}`;
  const res = await axios.post(
    PPLX_API,
    { model: PPLX_MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 900, temperature: 0.2 },
    { headers: { Authorization: `Bearer ${perplexityApiKey}`, 'Content-Type': 'application/json' }, timeout: 60_000, validateStatus: () => true }
  );
  if (res.status !== 200) throw new Error(`Perplexity translate HTTP ${res.status}: ${JSON.stringify(res.data).slice(0,180)}`);
  return (res.data?.choices?.[0]?.message?.content || '').trim();
}
function summarizeFallbackEn(text = '') {
  if (!text) return '';
  const paras = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  if (paras[0]?.length > 160) return paras[0].slice(0, 700);
  const sentences = (text.match(/[^.!?]+[.!?]+/g) || []).map(s => s.trim());
  return (sentences.slice(0, 3).join(' ')).slice(0, 700);
}

// === Markdown šablona (jen shrnutí) ===
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

// === GitHub MD save ===
async function saveToGitHub({ title, url, summaryCz, sourceHost }) {
  const octokit = new Octokit({ auth: githubToken });
  const today = new Date().toISOString().slice(0,10);
  const randomStr = Math.random().toString(36).slice(2, 8);
  const mdPath = `${summariesDir}/${today}-${randomStr}.md`;
  const dateIso = new Date().toISOString();

  const md = markdownForPost({ title: title || 'Shrnutí článku', url, dateIso, summaryCz: summaryCz || '', sourceHost });
  const contentB64 = Buffer.from(md, 'utf8').toString('base64');

  try {
    await octokit.repos.createOrUpdateFileContents({
      owner, repo, path: mdPath, branch,
      message: `Add summary: ${title || url}`, content: contentB64,
    });
  } catch (e) {
    if (e.status === 409) {
      const { data } = await octokit.repos.getContent({ owner, repo, path: mdPath, ref: branch });
      const sha = Array.isArray(data) ? null : data.sha;
      await octokit.repos.createOrUpdateFileContents({
        owner, repo, path: mdPath, branch, sha,
        message: `Update summary: ${title || url}`, content: contentB64,
      });
    } else { throw e; }
  }
  return `https://github.com/${owner}/${repo}/blob/${branch}/${mdPath}`;
}

// === posts.json helpery ===
function readPostsJson() {
  try { return JSON.parse(fs.readFileSync('docs/posts.json','utf8')); } catch { return []; }
}
function writePostsJson(arr) {
  fs.writeFileSync('docs/posts.json', JSON.stringify(arr, null, 2), 'utf8');
}
function upsertPostsJson(existing, post) {
  const arr = Array.isArray(existing) ? existing.slice() : [];
  const i = arr.findIndex(x => x.sourceUrl === post.sourceUrl);
  if (i !== -1) arr.splice(i, 1);
  arr.unshift(post);
  return arr.slice(0, 200);
}
function countTodayPosts(posts) {
  const today = new Date().toISOString().slice(0,10);
  return posts.filter(p => sameDayISO(p.date, `${today}T00:00:00.000Z`)).length;
}

// === Sheets ===
async function getUrlsFromSheet() {
  const client = await auth.getClient();
  const sheets = google.sheets({ version: 'v4', auth: client });
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!${RANGE}` });
  const urls = (res.data.values || [])
    .map(r => (r && r[0] ? String(r[0]).trim() : ''))
    .filter(Boolean)
    .map(normalizeUrl);
  return urls;
}

// === Hlavní běh: sběr → skóre → výběr → publikace ===
async function run() {
  console.log(`Reading range: '${SHEET_NAME}'!${RANGE}`);
  ensureDocsScaffold();

  // 1) načti existující homepage položky (kvůli dennímu limitu)
  let posts = readPostsJson();
  const alreadyToday = countTodayPosts(posts);
  let remaining = Math.max(0, DAILY_LIMIT - alreadyToday);
  console.log(`Homepage slots today: used=${alreadyToday}, remaining=${remaining}`);

  // 2) načti URL z Sheets
  const urlsRaw = await getUrlsFromSheet();

  // 3) kandidáti se skóre
  const candidates = [];
  for (const raw of urlsRaw) {
    const url = normalizeUrl(raw);
    const h = hostOf(url);
    if (!/^https?:\/\//i.test(url)) continue;
    if (BLOCKED_HOSTS.has(h)) { console.log(`Skip host (blocked): ${h}`); continue; }

    try {
      const html = await fetchHtml(url);
      const { title, text } = extractFromHtml(html, url);
      if (!text || text.length < MIN_TEXT_CHARS) { console.log(`Too short: ${h}`); continue; }

      const score = scoreArticle({ title, text, url });
      candidates.push({ url, host: h, title, text, score });
    } catch (e) {
      console.warn(`Fetch/extract failed for ${h}:`, e.message || e);
    }
  }

  // 4) seřadit dle skóre
  candidates.sort((a,b) => b.score - a.score);

  // 5) vyber top N pro dnešek
  const chosen = candidates.slice(0, Math.max(0, remaining));
  console.log(`Chosen ${chosen.length} for publish today (limit ${DAILY_LIMIT})`);

  // (Volitelné) ostatní jen uložit MD? ⇒ necháme teď jen publish top N.

  // 6) publikace: shrnutí → MD → posts.json
  for (const c of chosen) {
    try {
      let summaryCz = '';
      try {
        console.log('Perplexity summary…', c.host);
        summaryCz = await getSummaryPerplexityCz(c.text);
      } catch (e) {
        console.warn('Perplexity summary failed, fallback:', e.message || e);
      }
      if (!summaryCz) {
        const fb = summarizeFallbackEn(c.text);
        try { summaryCz = await translateToCzechViaPerplexity(fb); } catch { summaryCz = fb; }
      }
      if (summaryCz && !looksCzech(summaryCz)) {
        try { summaryCz = await translateToCzechViaPerplexity(summaryCz); } catch {}
      }

      const sourceHost = c.host;
      const mdUrl = await saveToGitHub({ title: c.title, url: c.url, summaryCz, sourceHost });

      const postItem = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
        title: c.title || 'Summary',
        date: new Date().toISOString(),
        summary: summaryCz,
        sourceHost,
        sourceUrl: c.url,
        mdUrl,
      };

      posts = upsertPostsJson(posts, postItem);
      writePostsJson(posts);
      console.log('Published:', { host: sourceHost, mdUrl });
    } catch (e) {
      console.error('Publish failed:', c.url, e.message || e);
    }
  }
}

run().catch(err => { console.error('Fatal error:', err); process.exit(1); });