var CONTENT_DOCUMENT_HEADERS_ = [
  'DOCUMENT_ID', 'BERKAS_ID', 'ITEM_ID', 'SOURCE_PDF_ID', 'WORD_FILE_ID', 'WORD_NAME',
  'INDEX_FILE_ID', 'STATUS', 'CHAR_COUNT', 'PARAGRAPH_COUNT', 'ERROR_MESSAGE',
  'CREATED_AT', 'CREATED_BY', 'UPDATED_AT', 'LEASE_ID', 'LEASE_AT', 'ATTEMPT_COUNT'
];
var CONTENT_UPLOAD_PREFIX_ = 'CONTENT_WORD_UPLOAD_';
var CONTENT_WORKER_HANDLER_ = 'continueContentDocumentJobs';

function ensureContentDocumentSchema_() {
  ensureSystemSheet_(APP_CONFIG.SHEETS.CONTENT_DOCUMENTS, CONTENT_DOCUMENT_HEADERS_, []);
  if (!ScriptApp.getProjectTriggers().some(trigger => trigger.getHandlerFunction() === CONTENT_WORKER_HANDLER_)) {
    ScriptApp.newTrigger(CONTENT_WORKER_HANDLER_).timeBased().everyMinutes(1).create();
  }
}

function assertContentDocumentSchema_() {
  const sheet = getSpreadsheet_().getSheetByName(APP_CONFIG.SHEETS.CONTENT_DOCUMENTS);
  if (!sheet || CONTENT_DOCUMENT_HEADERS_.some(header => getHeaders_(sheet).indexOf(header) < 0)) {
    throw new Error('Fitur isi dokumen belum dipasang. Jalankan migrasi REL-013 dari menu Arsip Aktif di spreadsheet.');
  }
}

function contentReadObjects_(sheetName) {
  // Keep physical row numbers even if a sheet contains blank rows.
  const sheet = getSheetOrThrow_(sheetName), headers = getHeaders_(sheet), last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, headers.length).getValues().map((row, index) => {
    const object = {_rowNumber: index + 2};
    headers.forEach((header, column) => object[header] = row[column]);
    return object;
  }).filter(row => headers.some(header => row[header] !== '' && row[header] !== null));
}

function contentArchiveContext_(berkasId, itemId) {
  const parent = contentReadObjects_(APP_CONFIG.SHEETS.BERKAS).find(row =>
    String(row.BERKAS_ID) === String(berkasId) && !isDeleted_(row));
  if (!parent) throw new Error('Berkas tidak ditemukan atau sudah dibatalkan.');
  const items = contentReadObjects_(APP_CONFIG.SHEETS.ITEM).filter(row =>
    String(row.BERKAS_ID) === String(berkasId) && !isDeleted_(row));
  const item = itemId ? items.find(row => String(row.ITEM_ID) === String(itemId)) : null;
  if (itemId && !item) throw new Error('Item tidak ditemukan dalam berkas ini.');
  return {parent: parent, items: items, item: item};
}

function contentLatestDocuments_(rows) {
  const latest = {};
  rows.forEach(row => latest[String(row.ITEM_ID)] = row);
  return latest;
}

function contentDocumentStatus_(item, document) {
  if (!item.DRIVE_FILE_ID) return 'NO_PDF';
  if (!document) return 'MISSING';
  if (String(document.SOURCE_PDF_ID) !== String(item.DRIVE_FILE_ID)) return 'STALE';
  return String(document.STATUS || 'FAILED');
}

function contentFolder_(parent) {
  const root = DriveApp.getFolderById(requireValue_(parent.DRIVE_FOLDER_ID, 'Folder berkas'));
  const found = root.getFoldersByName('_TEKS_PENCARIAN');
  return found.hasNext() ? found.next() : root.createFolder('_TEKS_PENCARIAN');
}

function startContentWordUpload_(request) {
  request = request || {};
  assertContentDocumentSchema_();
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    purgeOldUploadSessionsByPrefix_(CONTENT_UPLOAD_PREFIX_);
    const context = contentArchiveContext_(cleanText_(request.berkasId, 80), cleanText_(request.itemId, 80));
    if (!context.item || !context.item.DRIVE_FILE_ID) throw new Error('Pilih item yang sudah memiliki PDF alih media.');
    if (String(request.pdfId || '') !== String(context.item.DRIVE_FILE_ID)) throw new Error('PDF berubah sejak formulir dimuat. Segarkan status lalu pilih Word dari PDF terbaru.');
    assertItemAvailableForEdit_(context.parent, context.item);
    if (request.confirmCurrentPdf !== true) throw new Error('Konfirmasikan bahwa Word berasal dari PDF alih media yang sedang berlaku.');
    const size = Number(request.fileSize), name = cleanText_(request.fileName, 240);
    if (!/\.docx$/i.test(name) || !Number.isInteger(size) || size < 22 || size > CONTENT_TEXT_LIMITS_.fileBytes) {
      throw new Error('Pilih Word DOCX hasil OCR, maksimal 10 MiB.');
    }
    const id = 'TEXT-' + Utilities.getUuid();
    const folder = contentFolder_(context.parent);
    const session = {sessionId: id, berkasId: String(context.parent.BERKAS_ID), itemId: String(context.item.ITEM_ID),
      pdfId: String(context.item.DRIVE_FILE_ID), fileSize: size, fileName: name, userEmail: getCurrentUser_(),
      folderId: folder.getId(), uploadedBytes: 0, driveFileId: '', committed: false, createdAt: nowIso_()};
    session.sessionUrl = initializeDriveResumableUpload_('UPLOAD_' + id + '.docx', size, folder.getId(), CONTENT_DOCX_MIME_);
    saveContentUploadSession_(session);
    return contentUploadProgress_(session);
  } finally {lock.releaseLock();}
}

function saveContentUploadSession_(session) {
  PropertiesService.getScriptProperties().setProperty(CONTENT_UPLOAD_PREFIX_ + session.sessionId, JSON.stringify(session));
}

function getContentUploadSession_(sessionId) {
  sessionId = cleanText_(sessionId, 100);
  const value = PropertiesService.getScriptProperties().getProperty(CONTENT_UPLOAD_PREFIX_ + sessionId);
  if (!value) throw new Error('Sesi Word tidak ditemukan atau kedaluwarsa. Mulai unggah kembali.');
  const session = JSON.parse(value);
  if (session.userEmail !== getCurrentUser_()) throw new Error('Sesi Word dimiliki pengguna lain.');
  return session;
}

function contentUploadProgress_(session) {
  return {sessionId: session.sessionId, uploadedBytes: Number(session.uploadedBytes),
    fileSize: Number(session.fileSize), complete: Boolean(session.driveFileId), committed: Boolean(session.committed)};
}

function uploadContentWordChunk_(request) {
  request = request || {};
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const session = getContentUploadSession_(request.sessionId);
    if (session.driveFileId || session.committed) return contentUploadProgress_(session);
    const start = Number(request.start), end = Number(request.end), total = Number(request.total);
    if (total !== session.fileSize || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start ||
        end > total || end - start > 512 * 1024) throw new Error('Posisi atau ukuran potongan Word tidak valid.');
    if (start !== session.uploadedBytes) return contentUploadProgress_(session);
    const bytes = Utilities.base64Decode(String(request.base64 || ''));
    if (bytes.length !== end - start || (end < total && bytes.length % (256 * 1024))) throw new Error('Potongan Word tidak lengkap.');
    const response = sendDriveResumableChunk_(session.sessionUrl, bytes, start, end, total, CONTENT_DOCX_MIME_);
    session.uploadedBytes = response.complete ? total : response.uploadedBytes;
    if (response.complete) session.driveFileId = response.fileId;
    saveContentUploadSession_(session);
    return contentUploadProgress_(session);
  } finally {lock.releaseLock();}
}

function getContentWordUploadStatus_(sessionId) {
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const session = getContentUploadSession_(sessionId);
    if (!session.driveFileId && !session.committed) {
      const response = queryDriveResumableStatus_(session.sessionUrl, session.fileSize, CONTENT_DOCX_MIME_);
      session.uploadedBytes = response.complete ? session.fileSize : response.uploadedBytes;
      if (response.complete) session.driveFileId = response.fileId;
      saveContentUploadSession_(session);
    }
    return contentUploadProgress_(session);
  } finally {lock.releaseLock();}
}

function finalizeContentWordUpload_(sessionId) {
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const session = getContentUploadSession_(sessionId);
    const existing = contentReadObjects_(APP_CONFIG.SHEETS.CONTENT_DOCUMENTS).find(row => row.DOCUMENT_ID === session.sessionId);
    if (existing) {
      session.committed = true; session.committedAt = nowIso_(); saveContentUploadSession_(session);
      return {ok: true, documentId: existing.DOCUMENT_ID, status: existing.STATUS};
    }
    if (!session.driveFileId) throw new Error('Unggah Word belum lengkap. Lanjutkan unggah sebelum menyimpan.');
    const context = contentArchiveContext_(session.berkasId, session.itemId);
    assertItemAvailableForEdit_(context.parent, context.item);
    if (String(context.item.DRIVE_FILE_ID) !== session.pdfId) throw new Error('PDF telah berubah selama unggah. Batalkan lalu gunakan Word dari PDF terbaru.');
    const file = DriveApp.getFileById(session.driveFileId);
    if (file.getSize() !== session.fileSize || file.getMimeType() !== CONTENT_DOCX_MIME_) throw new Error('File Word hasil unggah tidak sesuai.');
    file.setName(session.sessionId + '_' + session.fileName);
    appendObject_(APP_CONFIG.SHEETS.CONTENT_DOCUMENTS, {
      DOCUMENT_ID: session.sessionId, BERKAS_ID: session.berkasId, ITEM_ID: session.itemId,
      SOURCE_PDF_ID: session.pdfId, WORD_FILE_ID: session.driveFileId,
      WORD_NAME: /^[=+@-]/.test(session.fileName) ? "'" + session.fileName : session.fileName,
      STATUS: 'QUEUED', CREATED_AT: nowIso_(), CREATED_BY: session.userEmail, UPDATED_AT: nowIso_()
    });
    session.committed = true; session.committedAt = nowIso_(); saveContentUploadSession_(session);
    contentAudit_('UPLOAD', session.sessionId, 'Word pendamping tersimpan; menunggu ekstraksi.', 'SUCCESS');
    return {ok: true, documentId: session.sessionId, status: 'QUEUED'};
  } finally {lock.releaseLock();}
}

function cancelContentWordUpload_(sessionId) {
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const session = getContentUploadSession_(sessionId);
    const committed = contentReadObjects_(APP_CONFIG.SHEETS.CONTENT_DOCUMENTS).some(row => row.DOCUMENT_ID === session.sessionId);
    if (!committed && session.driveFileId) DriveApp.getFileById(session.driveFileId).setTrashed(true);
    PropertiesService.getScriptProperties().deleteProperty(CONTENT_UPLOAD_PREFIX_ + session.sessionId);
    return {ok: true, committed: committed};
  } finally {lock.releaseLock();}
}

function contentAudit_(action, id, summary, status) {
  // Failure to append an audit must not turn a committed job into a duplicate retry.
  try {audit_(action, 'PENCARIAN_ISI', 'DOKUMEN_TEKS', id, summary, '', status);}
  catch (error) {console.error('PENCARIAN_ISI audit gagal untuk ' + id);}
}

function retryContentDocument_(documentId) {
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const rows = contentReadObjects_(APP_CONFIG.SHEETS.CONTENT_DOCUMENTS);
    const document = rows.find(row => row.DOCUMENT_ID === String(documentId));
    if (!document || contentLatestDocuments_(rows)[document.ITEM_ID].DOCUMENT_ID !== document.DOCUMENT_ID) throw new Error('Versi Word ini sudah digantikan.');
    const context = contentArchiveContext_(document.BERKAS_ID, document.ITEM_ID);
    assertItemAvailableForEdit_(context.parent, context.item);
    if (contentDocumentStatus_(context.item, document) !== 'FAILED') throw new Error('Hanya ekstraksi gagal pada PDF terkini yang dapat dicoba ulang.');
    updateObjectAtRow_(APP_CONFIG.SHEETS.CONTENT_DOCUMENTS, document._rowNumber,
      {STATUS: 'QUEUED', ERROR_MESSAGE: '', LEASE_ID: '', LEASE_AT: '', ATTEMPT_COUNT: 0, UPDATED_AT: nowIso_()});
    contentAudit_('RETRY', document.DOCUMENT_ID, 'Mengantrekan ulang ekstraksi Word.', 'SUCCESS');
    return {ok: true};
  } finally {lock.releaseLock();}
}

function claimContentDocumentJob_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return null;
  try {
    if (!getSpreadsheet_().getSheetByName(APP_CONFIG.SHEETS.CONTENT_DOCUMENTS)) return null;
    const rows = contentReadObjects_(APP_CONFIG.SHEETS.CONTENT_DOCUMENTS), latest = contentLatestDocuments_(rows);
    const candidate = rows.find(row => latest[row.ITEM_ID] === row &&
      (row.STATUS === 'QUEUED' || (row.STATUS === 'PROCESSING' &&
        (!Date.parse(row.LEASE_AT) || Date.now() - Date.parse(row.LEASE_AT) > 10 * 60000))));
    if (!candidate) return null;
    if (Number(candidate.ATTEMPT_COUNT || 0) >= 3) {
      updateObjectAtRow_(APP_CONFIG.SHEETS.CONTENT_DOCUMENTS, candidate._rowNumber,
        {STATUS: 'FAILED', ERROR_MESSAGE: 'Ekstraksi terhenti tiga kali. Periksa ukuran/struktur Word sebelum mencoba ulang.',
          LEASE_ID: '', LEASE_AT: '', UPDATED_AT: nowIso_()});
      contentAudit_('EXTRACT_FAILED', candidate.DOCUMENT_ID, 'Ekstraksi terhenti tiga kali.', 'FAILED');
      return null;
    }
    const changes = {STATUS: 'PROCESSING', LEASE_ID: Utilities.getUuid(), LEASE_AT: nowIso_(),
      ATTEMPT_COUNT: Number(candidate.ATTEMPT_COUNT || 0) + 1, UPDATED_AT: nowIso_()};
    updateObjectAtRow_(APP_CONFIG.SHEETS.CONTENT_DOCUMENTS, candidate._rowNumber, changes);
    return Object.assign({}, candidate, changes);
  } finally {lock.releaseLock();}
}

function continueContentDocumentJobs() {
  const job = claimContentDocumentJob_();
  if (!job) return;
  let indexFile = null, result = null, failure = '';
  try {
    const context = contentArchiveContext_(job.BERKAS_ID, job.ITEM_ID);
    if (String(context.item.DRIVE_FILE_ID) !== String(job.SOURCE_PDF_ID)) throw new Error('PDF sumber sudah diganti. Unggah Word terbaru.');
    const file = DriveApp.getFileById(job.WORD_FILE_ID);
    if (file.getSize() > CONTENT_TEXT_LIMITS_.fileBytes) throw new Error('Ukuran Word melebihi 10 MiB.');
    result = extractContentDocx_(file.getBlob());
    result.documentId = job.DOCUMENT_ID; result.pdfId = String(job.SOURCE_PDF_ID);
    const folder = file.getParents().next();
    indexFile = folder.createFile(Utilities.newBlob(JSON.stringify(result), 'application/json', job.DOCUMENT_ID + '_index.json'));
  } catch (error) {failure = cleanText_(error.message || 'Ekstraksi gagal.', 700);}
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const rows = contentReadObjects_(APP_CONFIG.SHEETS.CONTENT_DOCUMENTS);
    const current = rows.find(row => row.DOCUMENT_ID === job.DOCUMENT_ID);
    if (!current || current.LEASE_ID !== job.LEASE_ID || contentLatestDocuments_(rows)[job.ITEM_ID].DOCUMENT_ID !== job.DOCUMENT_ID) {
      if (indexFile) indexFile.setTrashed(true); // Never published; safe temporary output.
      if (current && current.LEASE_ID === job.LEASE_ID) {
        updateObjectAtRow_(APP_CONFIG.SHEETS.CONTENT_DOCUMENTS, current._rowNumber,
          {STATUS: 'SUPERSEDED', LEASE_ID: '', LEASE_AT: '', UPDATED_AT: nowIso_()});
      }
      return;
    }
    let stale = false;
    try {stale = String(contentArchiveContext_(job.BERKAS_ID, job.ITEM_ID).item.DRIVE_FILE_ID) !== String(job.SOURCE_PDF_ID);}
    catch (error) {stale = true;}
    if (stale) failure = 'PDF sumber berubah atau item dibatalkan. Unggah Word terbaru.';
    updateObjectAtRow_(APP_CONFIG.SHEETS.CONTENT_DOCUMENTS, current._rowNumber, {
      STATUS: stale ? 'STALE' : failure ? 'FAILED' : 'READY', ERROR_MESSAGE: failure,
      INDEX_FILE_ID: indexFile ? indexFile.getId() : '', CHAR_COUNT: result ? result.characters : 0,
      PARAGRAPH_COUNT: result ? result.paragraphs.length : 0, UPDATED_AT: nowIso_(), LEASE_ID: '', LEASE_AT: ''
    });
    contentAudit_(failure ? 'EXTRACT_FAILED' : 'EXTRACT_READY', job.DOCUMENT_ID,
      failure || 'Teks siap dicari: ' + result.characters + ' karakter.', failure ? 'FAILED' : 'SUCCESS');
  } finally {lock.releaseLock();}
}
