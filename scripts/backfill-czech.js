// scripts/backfill-czech.js
require('dotenv').config({ path: './summaries.env' });
const fs = require('fs');
const axios = require('axios');

const POSTS = 'docs/posts.json';
const API = 'https://api.perplexity.ai/chat/completions'; // správný endpoint
const KEY = process.env.PERPLEXITY_API_KEY;
const MODEL = 'sonar'; // můžeš zkusit i 'sonar-pro' pro lepší kvalitu

function looksCzech(s=''){
  return /[áéěíóúůýžščřďťňÁÉĚÍÓÚŮÝŽŠČŘĎŤŇ]/.test(s || '');
}

async function translateToCzech(text){
  const prompt = `Přelož do češtiny. Vrať jen čistý překlad, bez komentářů:\n\n${text}`;
  const res = await axios.post(
    API,
    {
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 900,
      temperature: 0.2,
    },
    {
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      timeout: 60_000,
      validateStatus: () => true,
    }
  );

  if (res.status !== 200) {
    const msg = res.data?.error || res.data || res.statusText;
    throw new Error(`HTTP ${res.status} ${JSON.stringify(msg).slice(0,200)}`);
  }

  const out = res.data?.choices?.[0]?.message?.content?.trim() || '';
  return out;
}

(async ()=>{
  let arr = [];
  try {
    arr = JSON.parse(fs.readFileSync(POSTS,'utf8'));
  } catch(e){
    console.error('Cannot read docs/posts.json:', e.message);
    process.exit(1);
  }

  const items = arr.filter(p => p?.summary && !looksCzech(p.summary));
  if (!items.length) {
    console.log('No English summaries to translate. No changes needed.');
    return;
  }

  const BATCH_LIMIT = 15;
  let changed = 0;

  for (const p of items.slice(0, BATCH_LIMIT)) {
    try{
      const cz = await translateToCzech(p.summary);
      if (cz && looksCzech(cz)) {
        p.summary = cz;
        changed++;
        console.log('Translated:', (p.title || '').slice(0,100));
        await new Promise(r => setTimeout(r, 500));
      } else {
        console.warn('Translation returned non-CZ or empty for:', (p.title || '').slice(0,100));
      }
    } catch(e){
      console.warn('Transl fail:', (p.title || '').slice(0,100), e.message);
    }
  }

  if (changed) {
    fs.writeFileSync(POSTS, JSON.stringify(arr, null, 2), 'utf8');
    console.log('Updated posts.json items:', changed);
  } else {
    console.log('No changes written.');
  }
})();
