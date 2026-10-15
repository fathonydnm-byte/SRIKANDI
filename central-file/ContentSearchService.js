function getContentSearchOptions_() {
  assertContentDocumentSchema_();
  return {berkas: contentReadObjects_(APP_CONFIG.SHEETS.BERKAS).filter(row => !isDeleted_(row))
    .sort((a, b) => naturalCompare_(a.NO_BERKAS_DEFINITIF || '999999', b.NO_BERKAS_DEFINITIF || '999999'))
    .map(row => ({id: String(row.BERKAS_ID), label: (row.NO_BERKAS_DEFINITIF || 'DRAFT') + ' — ' + row.JUDUL_BERKAS})),
    maxWordBytes: CONTENT_TEXT_LIMITS_.fileBytes};
}

function getContentBerkas_(berkasId) {
  assertContentDocumentSchema_();
  const context = contentArchiveContext_(cleanText_(berkasId, 80));
  const latest = contentLatestDocuments_(contentReadObjects_(APP_CONFIG.SHEETS.CONTENT_DOCUMENTS));
  const items = context.items.sort((a, b) => naturalCompare_(a.NO_ITEM_DEFINITIF, b.NO_ITEM_DEFINITIF))
    .map(item => {
      const document = latest[item.ITEM_ID], status = contentDocumentStatus_(item, document);
      return {id: String(item.ITEM_ID), label: (item.NO_ITEM_DEFINITIF || '–') + ' — ' + cleanText_(item.URAIAN_LENGKAP, 180),
        status: status, hasPdf: Boolean(item.DRIVE_FILE_ID), pdfId: String(item.DRIVE_FILE_ID || ''), documentId: document ? document.DOCUMENT_ID : '',
        wordName: document ? document.WORD_NAME : '', error: document ? document.ERROR_MESSAGE || '' : '',
        wordUrl: document ? contentWordUrl_(document.WORD_FILE_ID) : '',
        characters: document ? Number(document.CHAR_COUNT || 0) : 0};
    });
  return {berkasId: String(context.parent.BERKAS_ID), title: context.parent.JUDUL_BERKAS,
    items: items, ready: items.filter(item => item.status === 'READY').length, total: items.length};
}

function contentWordUrl_(fileId) {
  return fileId ? 'https://drive.google.com/file/d/' + encodeURIComponent(String(fileId)) + '/view' : '';
}

function contentNormalizeText_(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function contentSearchSnapshot_(berkasId, itemId, query, items, latest) {
  const data = [berkasId, itemId, query, items.map(item => {
    const doc = latest[item.ITEM_ID];
    return [String(item.ITEM_ID), String(item.DRIVE_FILE_ID || ''),
      doc ? [doc.DOCUMENT_ID, doc.SOURCE_PDF_ID, doc.STATUS, doc.INDEX_FILE_ID || ''] : []];
  })];
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(data)));
}

function readContentTextIndex_(document) {
  const key = 'CONTENT_INDEX:' + document.INDEX_FILE_ID;
  let serialized = '', cache = null;
  try {cache = CacheService.getScriptCache(); serialized = cache.get(key) || '';}
  catch (ignore) {} // Cache is optional; Drive is the durable source.
  if (!serialized) {
    const file = DriveApp.getFileById(document.INDEX_FILE_ID);
    if (file.getSize() > 8 * 1024 * 1024) throw new Error('Indeks teks melampaui batas pembacaan.');
    serialized = file.getBlob().getDataAsString('UTF-8');
    // JSON is immutable per document version. Respect CacheService's per-entry byte limit.
    if (cache && serialized.length < 15000) {
      try {cache.put(key, serialized, 300);} catch (ignore) {}
    }
  }
  const index = JSON.parse(serialized);
  if (index.version !== 1 || index.documentId !== document.DOCUMENT_ID || String(index.pdfId) !== String(document.SOURCE_PDF_ID) ||
      !Array.isArray(index.paragraphs) || index.paragraphs.length > CONTENT_TEXT_LIMITS_.paragraphs) {
    throw new Error('Indeks teks tidak sesuai dengan dokumen sumber. Unggah ulang Word.');
  }
  return index;
}

function searchContentBerkas_(criteria) {
  criteria = criteria || {};
  assertContentDocumentSchema_();
  const started = Date.now(), berkasId = cleanText_(criteria.berkasId, 80), itemId = cleanText_(criteria.itemId, 80);
  const rawQuery = String(criteria.query || '').trim();
  if (rawQuery.length < 2 || rawQuery.length > 120) throw new Error('Kata atau frasa pencarian harus 2–120 karakter.');
  const query = contentNormalizeText_(rawQuery);
  const context = contentArchiveContext_(berkasId, itemId);
  const latest = contentLatestDocuments_(contentReadObjects_(APP_CONFIG.SHEETS.CONTENT_DOCUMENTS));
  const items = context.items.filter(item => !itemId || String(item.ITEM_ID) === itemId)
    .sort((a, b) => String(a.ITEM_ID).localeCompare(String(b.ITEM_ID)));
  const ready = items.filter(item => contentDocumentStatus_(item, latest[item.ITEM_ID]) === 'READY');
  const snapshot = contentSearchSnapshot_(berkasId, itemId, query, items, latest);
  const cursor = criteria.cursor || {document: 0, paragraph: 0, snapshot: snapshot};
  if (cursor.snapshot !== snapshot) throw new Error('Dokumen berubah sejak pencarian dimulai. Jalankan Cari kembali untuk hasil terbaru.');
  let d = Number(cursor.document), p = Number(cursor.paragraph);
  if (!Number.isInteger(d) || !Number.isInteger(p) || d < 0 || d > ready.length || p < 0 || p > CONTENT_TEXT_LIMITS_.paragraphs) {
    throw new Error('Posisi pencarian tidak valid. Jalankan Cari kembali.');
  }
  const results = [], errors = [];
  let loaded = 0;
  // Bound each call, never present an incomplete scan as a final zero-result search.
  while (d < ready.length && results.length < 20 && loaded < 3 && Date.now() - started < 15000) {
    const item = ready[d], document = latest[item.ITEM_ID];
    let index;
    loaded++;
    try {index = readContentTextIndex_(document);}
    catch (error) {errors.push({itemId: String(item.ITEM_ID), message: cleanText_(error.message, 400)}); d++; p = 0; continue;}
    if (p > index.paragraphs.length) throw new Error('Posisi paragraf tidak valid.');
    while (p < index.paragraphs.length && results.length < 20 && Date.now() - started < 15000) {
      const position = p++, paragraph = index.paragraphs[position];
      if (contentNormalizeText_(paragraph.text).indexOf(query) < 0) continue;
      const before = index.paragraphs[position - 1], after = index.paragraphs[position + 1];
      results.push({key: document.DOCUMENT_ID + ':' + position, itemId: String(item.ITEM_ID),
        itemLabel: (item.NO_ITEM_DEFINITIF || '–') + ' — ' + cleanText_(item.URAIAN_LENGKAP, 220),
        paragraph: paragraph.paragraph, part: paragraph.part, section: paragraph.section,
        text: paragraph.text, before: before && before.section === paragraph.section ? before.text : '',
        after: after && after.section === paragraph.section ? after.text : '',
        pdfUrl: String(item.DRIVE_FILE_URL || ''), wordUrl: contentWordUrl_(document.WORD_FILE_ID), page: null});
    }
    if (p === index.paragraphs.length) {d++; p = 0;}
  }
  // Fail closed if PDF, deletion, or active text version changed during a Drive read.
  const check = contentArchiveContext_(berkasId, itemId);
  const currentItems = check.items.filter(item => !itemId || String(item.ITEM_ID) === itemId)
    .sort((a, b) => String(a.ITEM_ID).localeCompare(String(b.ITEM_ID)));
  const currentLatest = contentLatestDocuments_(contentReadObjects_(APP_CONFIG.SHEETS.CONTENT_DOCUMENTS));
  if (snapshot !== contentSearchSnapshot_(berkasId, itemId, query, currentItems, currentLatest)) {
    throw new Error('Dokumen berubah saat pencarian. Jalankan Cari kembali.');
  }
  return {results: results, errors: errors, done: d >= ready.length,
    cursor: d >= ready.length ? null : {document: d, paragraph: p, snapshot: snapshot},
    coverage: {total: items.length, ready: ready.length, scanned: d}, elapsedMs: Date.now() - started};
}
