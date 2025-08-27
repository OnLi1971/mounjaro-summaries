require('dotenv').config({ path: './summaries.env' });
const fs = require('fs');
const axios = require('axios');

const POSTS = 'docs/posts.json';
const API = 'https://api.perplexity.ai/v1/chat/completions';
const KEY = process.env.PERPLEXITY_API_KEY;

function looksCzech(s=''){ return /[áéěíóúůýžščřďťňÁÉĚÍÓÚŮÝŽŠČŘĎŤŇ]/.test(s); }

async function translateToCzech(text){
  const prompt = `Přelož do češtiny. Vrať jen překlad, bez komentářů:\n\n${text}`;
  const res = await axios.post(API, {
    model: 'pplx-7b-chat',
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 900,
    temperature: 0.2
  }, { headers: { Authorization: `Bearer ${KEY}`, 'Content-Type':'application/json' }, timeout: 60000 });
  return res.data?.choices?.[0]?.message?.content?.trim() || '';
}

(async ()=>{
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(POSTS,'utf8')); } catch(e){ console.error('Cannot read posts.json', e); process.exit(1); }

  let changed = 0;
  for (const p of arr){
    if (!p.summary) continue;
    if (looksCzech(p.summary)) continue;

    try{
      const cz = await translateToCzech(p.summary);
      if (cz && looksCzech(cz)){
        p.summary = cz;
        changed++;
        console.log('Translated:', p.title?.slice(0,80));
      }
    }catch(e){
      console.warn('Transl fail:', p.title, e?.message || e);
    }
  }

  if (changed){
    fs.writeFileSync(POSTS, JSON.stringify(arr, null, 2), 'utf8');
    console.log('Updated posts.json items:', changed);
  }else{
    console.log('No changes needed.');
  }
})();
