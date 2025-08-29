// --- 1) zajisti kvalitní CS shrnutí v L ---
let finalSummary = csSummary ? stripHtml(csSummary) : '';
const summaryBad = !finalSummary || looksHtml(csSummary)
  || !isCzech(finalSummary) || finalSummary.length < 120;

if (summaryBad) {
  try {
    console.log(`Generuji/opravuji shrnutí (CS): ${url}`);
    const { title, text } = await getArticleData(url);
    if (!text || text.length < MIN_CHARS) {
      await setRow(false, rowNumber, { status:'SKIP_SHORT', mdUrl:'', note:`${text?.length||0} chars` });
      continue;
    }
    // shrnutí + vynucení češtiny
    let summary = '';
    try {
      summary = await getSummaryPerplexity(text);
      if (!isCzech(summary)) {
        summary = await translateToCzechWithPerplexity(summary || text.slice(0,1500));
      }
    } catch {
      const sentences = text.split(/(?<=\.)\s+/).slice(0,3).join(' ');
      summary = sentences || text.slice(0,600);
      if (!isCzech(summary)) {
        try { summary = await translateToCzechWithPerplexity(summary); } catch {}
      }
    }
    finalSummary = stripHtml(summary);
    await setRow(true, rowNumber, {
      status: 'REVIEW',
      mdUrl: '',
      note: '',
      publishAt: '',
      cardId: '',
      csSummary: finalSummary
    });
  } catch(e) {
    await setRow(false, rowNumber, { status:'ERROR', mdUrl:'', note:e?.message || String(e) });
    continue;
  }
}

// --- 2) publikace, když chceš (K=TRUE) a ještě není zveřejněno ---
if (publishFlag && !publishedAt) {
  try {
    console.log(`Publikace na web: ${url}`);
    let title = '';
    try { title = (await getArticleData(url)).title || ''; } catch {}
    const mdLink = await saveToGitHub({
      title: title || 'Shrnutí článku',
      url,
      summary: finalSummary
    });
    const createdAt = parseSheetDate(createdAtRaw) || new Date();
    const upd = updateDocsSite({
      title: title || 'Shrnutí',
      dateISO: createdAt.toISOString(),
      sourceUrl: url,
      sourceHost: hostOf(url),
      mdUrl: mdLink,
      summary: finalSummary,
    });
    if (!upd.added){
      await setRow(false, rowNumber, {
        status: 'ERROR',
        mdUrl: mdLink,
        note: upd.reason || 'unknown'
      });
      continue;
    }
    await setRow(true, rowNumber, {
      status    : 'PUBLISHED',
      mdUrl     : mdLink,
      note      : '',
      publishAt : new Date().toISOString(),
      cardId    : upd.id,
      csSummary : finalSummary
    });
  } catch(e){
    await setRow(false, rowNumber, { status:'ERROR', mdUrl:'', note:e?.message || String(e) });
  }
} else {
  // necháme v REVIEW a čekáme na klik
  if (!status || status === 'REVIEW'){
    await setRow(false, rowNumber, { status:'REVIEW', mdUrl: mdUrl || '', note: 'čeká na publikaci' });
  }
}
