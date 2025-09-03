// docs/app.js
// Jednoduchý klient pro vykreslení článků z docs/posts.json
// - zobrazuje jen schválené (approved/publish == true)
// - deduplikuje podle URL/title
// - max 3 články na den
// - žádné tlačítko na GitHub MD (odebráno)

const MAX_POSTS_PER_DAY = 3; // limit na den
const POSTS_URL = 'posts.json'; // generováno action / skriptem

document.addEventListener('DOMContentLoaded', init);

async function init() {
  const { listEl, searchEl, sourceEl } = bindUI();
  const allPosts = await safeLoadPosts();

  // naplň filtr zdrojů
  fillSourceFilter(sourceEl, allPosts);

  // první render (bez filtru)
  render(allPosts, { listEl, searchEl, sourceEl });

  // interakce
  searchEl.addEventListener('input', () => render(allPosts, { listEl, searchEl, sourceEl }));
  sourceEl.addEventListener('change', () => render(allPosts, { listEl, searchEl, sourceEl }));
}

// ---------- načtení a příprava dat ----------

async function safeLoadPosts() {
  try {
    const res = await fetch(`${POSTS_URL}?v=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!Array.isArray(json)) throw new Error('posts.json neobsahuje pole');
    // Schválené + seřazené + deduplikované + limitované na den
    const approved = json.filter(isApproved);
    const sorted = sortByDateDesc(approved);
    const deduped = deduplicate(sorted);
    const limited = limitPerDay(deduped, MAX_POSTS_PER_DAY);
    return limited;
  } catch (e) {
    console.error('Chyba načtení posts.json:', e);
    return [];
  }
}

function isApproved(post) {
  // robustní čtení příznaku schválení z různých názvů
  const candidates = [
    post.approved, post.publish, post.published, post.toPublish, post.ok, post.reviewPublish
  ];
  // převést stringy jako "TRUE"/"true"/"1"/"yes"/"ok" -> true
  for (const v of candidates) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      if (['true', '1', 'yes', 'ok', 'ano'].includes(s)) return true;
    }
  }
  // fallback: pokud existuje explicitní publishedAt, bereme jako schválené
  if (post.publishedAt) return true;
  return false;
}

function sortByDateDesc(items) {
  // datum bereme z publishedAt || date || createdAt
  return [...items].sort((a, b) => {
    const da = toDate(a.publishedAt || a.date || a.createdAt);
    const db = toDate(b.publishedAt || b.date || b.createdAt);
    return db - da;
  });
}

function deduplicate(items) {
  const seen = new Set();
  const out = [];
  for (const p of items) {
    const key = makeDedupKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function makeDedupKey(p) {
  const u = normalizeUrlPath(p.url || '');
  const t = normalizeTitle(p.title || '');
  return `${u}||${t}`;
}

function limitPerDay(items, maxPerDay) {
  if (maxPerDay <= 0) return items;
  const map = new Map(); // yyyy-mm-dd -> count
  const out = [];
  for (const p of items) {
    const d = toDate(p.publishedAt || p.date || p.createdAt);
    const dayKey = isoDay(d);
    const cnt = map.get(dayKey) || 0;
    if (cnt < maxPerDay) {
      out.push(p);
      map.set(dayKey, cnt + 1);
    }
  }
  return out;
}

// ---------- UI & render ----------

function bindUI() {
  const listEl = document.getElementById('list');
  const searchEl = document.getElementById('search');
  const sourceEl = document.getElementById('source');
  return { listEl, searchEl, sourceEl };
}

function fillSourceFilter(select, posts) {
  const domains = new Set();
  posts.forEach(p => domains.add(getDomain(p.url)));
  const sorted = [...domains].sort((a, b) => a.localeCompare(b));
  // reset
  select.innerHTML = '<option value="">Všechny zdroje</option>';
  sorted.forEach(d => {
    if (!d) return;
    const opt = document.createElement('option');
    opt.value = d;
    opt.textContent = d;
    select.appendChild(opt);
  });
}

function render(allPosts, { listEl, searchEl, sourceEl }) {
  const q = (searchEl.value || '').trim().toLowerCase();
  const source = sourceEl.value || '';

  const filtered = allPosts.filter(p => {
    if (source && getDomain(p.url) !== source) return false;
    if (!q) return true;
    const h = (p.title || '').toLowerCase();
    const s = stripHtml(p.summary || '').toLowerCase();
    return h.includes(q) || s.includes(q);
  });

  listEl.innerHTML = '';
  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="empty">Nic nenalezeno.</div>`;
    return;
  }

  for (const post of filtered) {
    listEl.appendChild(card(post));
  }
}

function card(p) {
  const el = document.createElement('article');
  el.className = 'card';

  const title = escapeHtml(p.title || '(bez názvu)');
  const url = p.url || '#';
  const domain = getDomain(url);
  const date = toDate(p.publishedAt || p.date || p.createdAt);
  const dateStr = humanDate(date);
  const summary = truncate(stripHtml(p.summary || ''), 800);

  el.innerHTML = `
    <div class="card-body">
      <h2 class="card-title">
        <a href="${url}" target="_blank" rel="noopener noreferrer">${title}</a>
      </h2>
      <div class="meta">${dateStr}${domain ? ' • ' + escapeHtml(domain) : ''}</div>
      <p class="summary">${escapeHtml(summary)}</p>
      <div class="actions">
        <a class="btn" href="${url}" target="_blank" rel="noopener noreferrer">Přečíst zdroj</a>
      </div>
    </div>
  `;
  return el;
}

// ---------- pomocné utility ----------

function stripHtml(html) {
  if (!html) return '';
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return (tmp.textContent || tmp.innerText || '').trim();
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function getDomain(u) {
  try {
    const url = new URL(u);
    return url.hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function toDate(v) {
  const d = v ? new Date(v) : new Date(0);
  return isNaN(d) ? new Date(0) : d;
}

function humanDate(d) {
  // formát: 29. 8. 2025
  return d.toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric' });
}

function isoDay(d) {
  // yyyy-mm-dd
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const da = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${da}`;
}

function normalizeTitle(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/["'’]/g, '')
    .replace(/[^a-z0-9\u00C0-\u017F]+/g, ' ')
    .trim();
}

function normalizeUrlPath(u) {
  try {
    const url = new URL(u);
    // dedup klíč: host + path bez závorek/trailing slashes, bez query
    const host = url.hostname.replace(/^www\./, '');
    let path = url.pathname.replace(/\/+$/, '');
    return `${host}${path}`;
  } catch {
    // fallback: prosté očištění
    return String(u || '').toLowerCase().replace(/\?.*$/, '').replace(/\/+$/, '');
  }
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
