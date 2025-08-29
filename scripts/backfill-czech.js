// scripts/backfill-czech.js
// v1.2 — doplní L (CZ_SUMMARY) tam, kde je prázdné nebo anglické. Nepublikuje.

const { google } = require('googleapis');
const axios = require('axios');
const cheerio = require('cheerio');

const SPREADSHEET_ID = '1KgrYXHpVfTAGQZT6f15aARGCQ-qgNQZM4HWQCiqt14s';
const SHEET_NAME = 'List 1';
const READ_RANGE = `'${SHEET_NAME}'!A:N`;

const COL = { URL:3, TRANS_SUM:5, CZ_SUMMARY:11 };

const auth = new google.auth.GoogleAuth({
  keyFile: 'google-service-account.json',
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const PPLX_KEY = process.env.PERPLEXITY_API_KEY;

function looksEnglish(s=''){const cz=/[áéěíóúůýžščřďťňÁÉĚÍÓÚŮÝŽŠČŘĎŤŇ]/.test(s);const lat=/[A-Za-z]/.test(s);return lat&&!cz;}
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

function cleanupText(html){
  const $=cheerio.load(html);
  $('script,style,noscript').remove();
  return $('p').map((_,el)=>$(el).text().trim()).get().filter(Boolean).join('\n\n');
}

async function fetchText(url){
  const UA='Mozilla/5.0 (compatible; BackfillBot/1.0)';
  const res = await axios.get(url, { headers:{'User-Agent':UA}, timeout:20000 });
  return cleanupText(res.data||'');
}

async function summarizeCzech(text){
  if(!PPLX_KEY) return '';
  try{
    const resp=await axios.post('https://api.perplexity.ai/v1/chat/completions',{
      model:'pplx-7b-chat',
      messages:[
        {role:'system',content:'Shrň text v češtině, věcně, 4–6 vět.'},
        {role:'user',content:text.slice(0,2500)}
      ],
      max_tokens:500,temperature:0.3
    },{headers:{Authorization:`Bearer ${PPLX_KEY}`,'Content-Type':'application/json'}});
    return resp.data?.choices?.[0]?.message?.content?.trim()||'';
  }catch{return '';}
}

async function translateToCzech(text){
  if(!PPLX_KEY) return text;
  try{
    const resp=await axios.post('https://api.perplexity.ai/v1/chat/completions',{
      model:'pplx-7b-chat',
      messages:[
        {role:'system',content:'Přelož do češtiny. Vrať jen text.'},
        {role:'user',content:text}
      ],
      max_tokens:700,temperature:0.2
    },{headers:{Authorization:`Bearer ${PPLX_KEY}`,'Content-Type':'application/json'}});
    return resp.data?.choices?.[0]?.message?.content?.trim()||text;
  }catch{return text;}
}

async function run(){
  const client=await auth.getClient();
  const sheets=google.sheets({version:'v4',auth:client});
  console.log('Backfill CZ summaries…');

  const res=await sheets.spreadsheets.values.get({ spreadsheetId:SPREADSHEET_ID, range:READ_RANGE });
  const rows=res.data.values||[];
  if(rows.length<=1){console.log('No data');return;}
  const updates=[];

  for(let i=1;i<rows.length;i++){
    const rowNum=i+1;
    const r=rows[i];
    const url=(r[COL.URL]||'').toString().trim();
    let L=(r[COL.CZ_SUMMARY]||'').toString();
    const F=(r[COL.TRANS_SUM]||'').toString();

    if(!url) continue;
    if(L && !looksEnglish(L)) continue; // už je CZ

    // použij F, pokud je CZ
    if(F && !looksEnglish(F)){
      updates.push({ range:`'${SHEET_NAME}'!L${rowNum}:L${rowNum}`, values:[[F]] });
      continue;
    }

    try{
      const text = await fetchText(url);
      let cz = await summarizeCzech(text);
      if(cz && looksEnglish(cz)) cz = await translateToCzech(cz);
      if(!cz || looksEnglish(cz)){
        const para=(text||'').split(/\n\s*\n/).map(t=>t.trim()).find(t=>t.length>80)||(text||'').slice(0,500);
        cz = para ? `${para.slice(0,700)}${para.length>700?'…':''}` : '';
      }
      if(cz && !looksEnglish(cz)){
        updates.push({ range:`'${SHEET_NAME}'!L${rowNum}:L${rowNum}`, values:[[cz]] });
      }
      await sleep(120);
    }catch(e){
      console.log(`Row ${rowNum} backfill err:`, e.message);
    }
  }

  // batch
  const CHUNK=25;
  for(let i=0;i<updates.length;i+=CHUNK){
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId:SPREADSHEET_ID,
      requestBody:{ valueInputOption:'RAW', data: updates.slice(i,i+CHUNK) }
    });
    await sleep(300);
  }
  console.log(`Backfill done. Updated rows: ${updates.length}`);
}

run().catch(e=>{ console.error(e); process.exit(1); });
