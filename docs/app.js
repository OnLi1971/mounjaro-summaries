const PER_PAGE = 12;

async function loadPosts(){
  const res = await fetch('posts.json?cb=' + Date.now(), { cache:'no-store' });
  if(!res.ok) throw new Error('posts.json load failed');
  return await res.json();
}

function fmtDate(iso){
  try{
    return new Date(iso).toLocaleDateString('cs-CZ',{year:'numeric',month:'2-digit',day:'2-digit'});
  }catch{
    return iso;
  }
}

function escapeHtml(s){return (s||'')
  .replace(/&/g,'&amp;')
  .replace(/</g,'&lt;')
  .replace(/>/g,'&gt;')
  .replace(/\"/g,'&quot;')
  .replace(/'/g,'&#39;');}

// Když máme staré relativní mdUrl ("summaries/....md"), převeď na GitHub blob URL.
// Když nepoznáme formát, vrať prázdný řetězec (nechceme falešný odkaz).
function normalizeMdUrl(u){
  if(!u) return '';
  if(/^https?:\/\//i.test(u)) return u;             // už je absolutní
  if(u.startsWith('summaries/')) {
    return `https://github.com/OnLi1971/mounjaro-summaries/blob/main/${u}`;
  }
  return ''; // neznámé -> žádný link
}

function fillSkeleton(){
  const list = document.getElementById('list');
  if (!list) return;
  list.innerHTML = '';
  for(let i=0;i<6;i++){
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `
      <div class="skel" style="height:22px;width:80%"></div>
      <div class="meta">
        <span class="skel" style="height:16px;width:90px;border-radius:999px"></span>
        <span class="skel" style="height:16px;width:120px;border-radius:999px"></span>
      </div>
      <div class="skel" style="height:14px;width:100%"></div>
      <div class="skel" style="height:14px;width:95%"></div>
      <div class="skel" style="height:14px;width:85%"></div>
      <div class="actions">
        <span class="skel" style="height:36px;width:120px;border-radius:10px"></span>
        <span class="skel" style="height:36px;width:170px;border-radius:10px"></span>
      </div>`;
    list.appendChild(el);
  }
}

function buildFilters(posts){
  const sel = document.getElementById('source');
  if(!sel) return;
  const sources = Array.from(new Set(posts.map(p=>p.sourceHost).filter(Boolean))).sort();
  sel.innerHTML = '<option value="">Všechny zdroje</option>' + sources.map(s=>'<option>'+escapeHtml(s)+'</option>').join('');
}

function applyFilters(posts, {q, src, sort}){
  let rows = posts.slice();

  if (src) rows = rows.filter(p => p.sourceHost === src);

  if (q){
    const qq = q.toLowerCase();
    rows = rows.filter(p =>
      (p.title||'').toLowerCase().includes(qq) ||
      (p.summary||'').toLowerCase().includes(qq)
    );
  }

  rows.sort((a,b)=>{
    const da = new Date(a.date).getTime() || 0;
    const db = new Date(b.date).getTime() || 0;
    return sort === 'old' ? (da - db) : (db - da);
  });

  return rows;
}

function renderPage(rows, page){
  const list = document.getElementById('list');
  const count = document.getElementById('count');
  const prev = document.getElementById('prev');
  const next = document.getElementById('next');
  const pageinfo = document.getElementById('pageinfo');

  if(!list) return;

  const total = rows.length;
  if (count) count.textContent = `${total} ${pluralCZ(total,'záznam','záznamy','záznamů')}`;

  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  page = Math.min(Math.max(1,page), pages);

  const start = (page-1) * PER_PAGE;
  const slice = rows.slice(start, start + PER_PAGE);

  list.innerHTML = '';
  if (slice.length === 0){
    list.innerHTML = '<div class="empty">Žádné výsledky</div>';
  } else {
    slice.forEach(p=>{
      const el = document.createElement('div');
      el.className = 'card';

      // HREF pro „Plné shrnutí“: preferuj detailUrl, jinak GitHub blob
      const summaryHref = (p.detailUrl && p.detailUrl.trim()) ? p.detailUrl.trim() : normalizeMdUrl(p.mdUrl);

      el.innerHTML = `
        <h3>${escapeHtml(p.title || 'Shrnutí')}</h3>
        <div class="meta">
          <span>${fmtDate(p.date)}</span>
          ${p.sourceHost ? `<span class="chip">${escapeHtml(p.sourceHost)}</span>` : ''}
        </div>
        <div class="summary">${escapeHtml((p.summary||'').slice(0, 800))}</div>
        <div class="actions">
          ${p.sourceUrl ? `<a class="primary" href="${p.sourceUrl}" target="_blank" rel="noopener">Přečíst zdroj</a>` : ''}
          ${summaryHref ? `<a href="${summaryHref}" target="_blank" rel="noopener">Plné shrnutí</a>` : ''}
        </div>`;
      list.appendChild(el);
    });
  }

  if (prev) prev.disabled = page<=1;
  if (next) next.disabled = page>=pages;
  if (pageinfo) pageinfo.textContent = `${page} / ${pages}`;

  if (prev) prev.onclick = () => renderPage(rows, page-1);
  if (next) next.onclick = () => renderPage(rows, page+1);
}

function pluralCZ(n, s1, s2, s5){
  const mod10 = n % 10, mod100 = n % 100;
  if(mod10===1 && mod100!==11) return s1;
  if(mod10>=2 && mod10<=4 && (mod100<10 || mod100>=20)) return s2;
  return s5;
}

(async function init(){
  fillSkeleton();
  try{
    const posts = await loadPosts();
    buildFilters(posts);

    const search = document.getElementById('search');
    const source = document.getElementById('source');
    const sort = document.getElementById('sort');

    let state = { q:'', src:'', sort:'new' };

    function update(){
      const rows = applyFilters(posts, state);
      renderPage(rows, 1);
    }

    if (search) search.addEventListener('input', e => {
      state.q = e.target.value || '';
      update();
    });
    if (source) source.addEventListener('change', e => {
      state.src = e.target.value || '';
      update();
    });
    if (sort) sort.addEventListener('change', e => {
      state.sort = e.target.value || 'new';
      update();
    });

    update();
  }catch(err){
    console.error(err);
    const list = document.getElementById('list');
    if (list) list.innerHTML = '<div class="empty">Nelze načíst data.</div>';
  }
})();
