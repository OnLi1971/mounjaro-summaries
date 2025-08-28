async function loadPosts(){
  const res = await fetch('posts.json',{cache:'no-store'});
  if(!res.ok) throw new Error('posts.json load failed');
  return await res.json();
}

function fmtDate(iso){
  try{ return new Date(iso).toLocaleDateString('cs-CZ',{year:'numeric',month:'2-digit',day:'2-digit'}); }
  catch{ return iso; }
}

function render(posts){
  const list = document.getElementById('list');
  const sourceSel = document.getElementById('source');
  list.innerHTML = '';

  // zdroje do filtru
  const sources = Array.from(new Set(posts.map(p=>p.sourceHost).filter(Boolean))).sort();
  sourceSel.innerHTML = '<option value="">Všechny zdroje</option>' + sources.map(s=>'<option>'+s+'</option>').join('');

  const search = document.getElementById('search');
  function apply(){
    const q = (search.value||'').toLowerCase();
    const s = sourceSel.value||'';
    const rows = posts.filter(p=>{
      if(s && p.sourceHost!==s) return false;
      if(q && !(p.title||'').toLowerCase().includes(q) && !(p.summary||'').toLowerCase().includes(q)) return false;
      return true;
    });
    list.innerHTML = '';
    if(rows.length===0){
      list.innerHTML = '<div class="empty">Žádné výsledky</div>';
      return;
    }
    rows.forEach(p=>{
      const el = document.createElement('div');
      el.className = 'card';
      el.innerHTML = `
        <h3>${p.title ? escapeHtml(p.title) : 'Shrnutí'}</h3>
        <div class="meta">
          <span>${fmtDate(p.date)}</span>
          ${p.sourceHost ? '<span class="chip">'+escapeHtml(p.sourceHost)+'</span>' : ''}
        </div>
        <div class="summary">${escapeHtml((p.summary||'').slice(0,600))}</div>
        <div class="actions">
  ${p.sourceUrl ? `<a class="primary" href="${p.sourceUrl}" target="_blank" rel="noopener">Přečíst zdroj</a>` : ''}
</div>
      list.appendChild(el);
    })
  }
  search.oninput = apply;
  sourceSel.onchange = apply;
  apply();
}

function escapeHtml(s){return (s||'')
  .replace(/&/g,'&amp;')
  .replace(/</g,'&lt;')
  .replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;')
  .replace(/'/g,'&#39;');}

loadPosts().then(render).catch(err=>{
  document.getElementById('list').innerHTML='<div class="empty">Nelze načíst data.</div>';
  console.error(err);
});
