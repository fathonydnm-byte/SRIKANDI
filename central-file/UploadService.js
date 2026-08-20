var ITEM_UPLOAD_CHUNK_SIZE_ = 512 * 1024;
var ITEM_UPLOAD_MAX_SIZE_ = 100 * 1024 * 1024;
var DELETION_EVIDENCE_UPLOAD_MAX_SIZE_ = 25 * 1024 * 1024;
var ITEM_UPLOAD_PROPERTY_PREFIX_ = 'ITEM_UPLOAD_SESSION_';
var DELETION_UPLOAD_PROPERTY_PREFIX_ = 'DELETION_EVIDENCE_SESSION_';
var EDIT_UPLOAD_PROPERTY_PREFIX_ = 'EDIT_REPLACEMENT_SESSION_';
var DRIVE_RESUMABLE_UPLOAD_URL_ = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,mimeType,size,parents';

function startItemUpload_(request) {
  purgeOldItemUploadSessions_();
  const normalized = validateItemUploadRequest_(request);
  const settings = readSettings_();
  const archiveFolderId = cleanText_(requireValue_(settings.ARCHIVE_FOLDER_ID, 'ARCHIVE_FOLDER_ID pada SETTINGS'), 200);
  DriveApp.getFolderById(archiveFolderId).getName();

  const sessionId = 'UPL-' + Utilities.getUuid();
  const temporaryName = 'UPLOAD_' + sessionId + '.pdf';
  const sessionUrl = initializeDriveResumableUpload_(temporaryName, normalized.fileSize, archiveFolderId, 'application/pdf');
  const session = {
    sessionId: sessionId,
    sessionUrl: sessionUrl,
    userEmail: getCurrentUser_(),
    fileName: normalized.fileName,
    fileSize: normalized.fileSize,
    uploadedBytes: 0,
    driveFileId: '',
    form: normalized.form,
    createdAt: nowIso_()
  };
  saveItemUploadSession_(session);
  audit_('UPLOAD_START', 'ITEM', 'UPLOAD', sessionId, 'Memulai upload PDF bertahap: ' + normalized.fileName, normalized.fileSize + ' byte', 'SUCCESS');
  return itemUploadProgress_(session);
}

function uploadItemChunk_(request) {
  request = request || {};
  const session = getItemUploadSession_(request.sessionId);
  if (session.driveFileId) return itemUploadProgress_(session);

  const total = Number(request.total);
  const start = Number(request.start);
  const endExclusive = Number(request.end);
  if (total !== session.fileSize) throw new Error('Ukuran PDF berubah selama upload. Pilih ulang PDF lalu coba lagi.');
  if (!Number.isInteger(start) || !Number.isInteger(endExclusive) || start < 0 || endExclusive <= start || endExclusive > total) {
    throw new Error('Posisi potongan upload tidak valid.');
  }
  if (start !== Number(session.uploadedBytes || 0)) return itemUploadProgress_(session);

  const bytes = Utilities.base64Decode(String(request.base64 || ''));
  if (bytes.length !== endExclusive - start) throw new Error('Ukuran potongan PDF tidak sesuai. Ulangi upload.');
  if (endExclusive < total && bytes.length % (256 * 1024) !== 0) {
    throw new Error('Potongan PDF selain potongan terakhir harus merupakan kelipatan 256 KB.');
  }

  const response = sendDriveResumableChunk_(session.sessionUrl, bytes, start, endExclusive, total, 'application/pdf');
  if (response.complete) {
    session.uploadedBytes = total;
    session.driveFileId = response.fileId;
  } else {
    session.uploadedBytes = response.uploadedBytes;
  }
  saveItemUploadSession_(session);
  return itemUploadProgress_(session);
}

function getItemUploadStatus_(sessionId) {
  const session = getItemUploadSession_(sessionId);
  if (session.committed && session.commitResult) return itemUploadProgress_(session);
  if (session.driveFileId) return itemUploadProgress_(session);
  const response = queryDriveResumableStatus_(session.sessionUrl, session.fileSize, 'application/pdf');
  if (response.complete) {
    session.uploadedBytes = session.fileSize;
    session.driveFileId = response.fileId;
  } else {
    session.uploadedBytes = response.uploadedBytes;
  }
  saveItemUploadSession_(session);
  return itemUploadProgress_(session);
}

function finalizeItemUpload_(sessionId) {
  const session = getItemUploadSession_(sessionId);
  if (session.committed && session.commitResult) return session.commitResult;

  const previouslyCommitted = findCommittedItemResult_(session.form && session.form.previewItemId);
  if (previouslyCommitted) {
    session.committed = true;
    session.committedAt = nowIso_();
    session.commitResult = previouslyCommitted;
    saveItemUploadSession_(session);
    return previouslyCommitted;
  }
  if (!session.driveFileId) {
    const status = getItemUploadStatus_(sessionId);
    if (!status.complete) throw new Error('UPLOAD_INCOMPLETE: PDF baru terunggah ' + status.uploadedBytes + ' dari ' + status.fileSize + ' byte.');
    Object.assign(session, getItemUploadSession_(sessionId));
  }

  try {
    const result = commitItem_(session.form, session.driveFileId);
    session.committed = true;
    session.committedAt = nowIso_();
    session.commitResult = result;
    saveItemUploadSession_(session);
    return result;
  } catch (error) {
    throw error;
  }
}

function cancelItemUpload_(sessionId) {
  const session = getItemUploadSession_(sessionId);
  if (session.driveFileId) {
    try { DriveApp.getFileById(session.driveFileId).setTrashed(true); } catch (ignore) {}
  }
  deleteItemUploadSession_(sessionId);
  audit_('UPLOAD_CANCEL', 'ITEM', 'UPLOAD', sessionId, 'Membatalkan upload PDF bertahap', '', 'SUCCESS');
  return {ok: true};
}

function validateItemUploadRequest_(request) {
  request = request || {};
  const fileName = cleanText_(requireValue_(request.pdfName, 'Nama PDF'), 250);
  const fileType = cleanText_(request.pdfType || 'application/pdf', 100).toLowerCase();
  const fileSize = Number(request.pdfSize);
  if (!fileName.toLowerCase().endsWith('.pdf')) throw new Error('Berkas utama harus berformat PDF.');
  if (!['application/pdf', 'application/octet-stream', ''].includes(fileType)) throw new Error('Tipe berkas utama harus PDF.');
  if (!Number.isInteger(fileSize) || fileSize < 1) throw new Error('Ukuran PDF tidak valid.');
  if (fileSize >= ITEM_UPLOAD_MAX_SIZE_) throw new Error('Ukuran PDF harus kurang dari 100 MB.');

  const form = sanitizeItemUploadForm_(request);
  const mode = String(form.berkasMode || 'EXISTING').toUpperCase();
  const operationCreatedAt = cleanText_(form.previewCreatedAt, 50) || nowIso_();
  form.previewCreatedAt = operationCreatedAt;
  const newBerkasId = mode === 'NEW' ? (cleanText_(form.newBerkasId, 80) || 'BRK-' + Utilities.getUuid()) : '';
  if (mode === 'NEW') form.newBerkasId = newBerkasId;
  const itemId = cleanText_(form.previewItemId, 80) || 'ITM-' + Utilities.getUuid();
  form.previewItemId = itemId;
  const newBerkas = mode === 'NEW' ? normalizeNewBerkasPayload_(form, newBerkasId, operationCreatedAt) : null;
  const candidate = normalizeItemPayload_({
    itemId: itemId,
    previewCreatedAt: operationCreatedAt,
    berkasId: mode === 'NEW' ? newBerkasId : form.berkasId,
    primaryLetterNumber: form.primaryLetterNumber,
    alternateLetterNumber: form.alternateLetterNumber,
    documentDate: form.documentDate,
    description: form.description,
    pageCount: form.pageCount,
    developmentLevel: form.developmentLevel,
    securityClassification: form.securityClassification,
    notes: form.itemNotes
  });
  buildNumberingPlan_(candidate, newBerkas);
  return {form: form, fileName: fileName, fileSize: fileSize};
}

function sanitizeItemUploadForm_(request) {
  const allowed = [
    'berkasMode', 'newBerkasId', 'previewItemId', 'previewCreatedAt', 'berkasId',
    'title', 'classificationId', 'activeRetentionValue', 'activeRetentionUnit',
    'inactiveRetentionValue', 'inactiveRetentionUnit', 'finalDisposition',
    'filingCabinet', 'drawer', 'berkasNotes', 'primaryLetterNumber',
    'alternateLetterNumber', 'documentDate', 'pageCount', 'developmentLevel',
    'securityClassification', 'description', 'itemNotes'
  ];
  const form = {};
  allowed.forEach(key => form[key] = request[key] === undefined || request[key] === null ? '' : String(request[key]));
  return form;
}

function startDeletionEvidenceUpload_(request) {
  purgeOldDeletionUploadSessions_();
  const normalized = validateDeletionUploadRequest_(request);
  const folder = getDeletionEvidenceFolder_();
  const sessionId = 'DELUPL-' + Utilities.getUuid();
  const extension = (normalized.fileName.match(/\.([^.]+)$/) || ['', 'bin'])[1].toLowerCase();
  const temporaryName = 'UPLOAD_BUKTI_' + sessionId + '.' + extension;
  const sessionUrl = initializeDriveResumableUpload_(temporaryName, normalized.fileSize, folder.getId(), normalized.mimeType);
  const session = {
    sessionId: sessionId,
    sessionUrl: sessionUrl,
    userEmail: getCurrentUser_(),
    fileName: normalized.fileName,
    fileSize: normalized.fileSize,
    mimeType: normalized.mimeType,
    uploadedBytes: 0,
    driveFileId: '',
    form: normalized.form,
    committed: false,
    commitResult: null,
    createdAt: nowIso_()
  };
  saveDeletionUploadSession_(session);
  audit_('UPLOAD_START', 'PENGHAPUSAN', 'BUKTI_DISPOSISI', sessionId,
    'Memulai upload bertahap bukti disposisi: ' + normalized.fileName,
    normalized.fileSize + ' byte', 'SUCCESS');
  return deletionUploadProgress_(session);
}

function uploadDeletionEvidenceChunk_(request) {
  request = request || {};
  const session = getDeletionUploadSession_(request.sessionId);
  if (session.driveFileId) return deletionUploadProgress_(session);
  const total = Number(request.total);
  const start = Number(request.start);
  const endExclusive = Number(request.end);
  if (total !== session.fileSize) throw new Error('Ukuran bukti disposisi berubah selama upload. Pilih ulang file.');
  if (!Number.isInteger(start) || !Number.isInteger(endExclusive) || start < 0 || endExclusive <= start || endExclusive > total) {
    throw new Error('Posisi potongan bukti disposisi tidak valid.');
  }
  if (start !== Number(session.uploadedBytes || 0)) return deletionUploadProgress_(session);
  const bytes = Utilities.base64Decode(String(request.base64 || ''));
  if (bytes.length !== endExclusive - start) throw new Error('Ukuran potongan bukti disposisi tidak sesuai.');
  if (endExclusive < total && bytes.length % (256 * 1024) !== 0) throw new Error('Potongan selain yang terakhir harus kelipatan 256 KB.');
  const response = sendDriveResumableChunk_(session.sessionUrl, bytes, start, endExclusive, total, session.mimeType);
  if (response.complete) {
    session.uploadedBytes = total;
    session.driveFileId = response.fileId;
  } else {
    session.uploadedBytes = response.uploadedBytes;
  }
  saveDeletionUploadSession_(session);
  return deletionUploadProgress_(session);
}

function getDeletionEvidenceUploadStatus_(sessionId) {
  const session = getDeletionUploadSession_(sessionId);
  if (session.committed && session.commitResult) return deletionUploadProgress_(session);
  if (session.driveFileId) return deletionUploadProgress_(session);
  const response = queryDriveResumableStatus_(session.sessionUrl, session.fileSize, session.mimeType);
  if (response.complete) {
    session.uploadedBytes = session.fileSize;
    session.driveFileId = response.fileId;
  } else {
    session.uploadedBytes = response.uploadedBytes;
  }
  saveDeletionUploadSession_(session);
  return deletionUploadProgress_(session);
}

function finalizeDeletionEvidenceUpload_(sessionId) {
  const session = getDeletionUploadSession_(sessionId);
  if (session.committed && session.commitResult) return session.commitResult;
  const previouslyCommitted = findCommittedDeletionResult_(session.form);
  if (previouslyCommitted) {
    session.committed = true;
    session.committedAt = nowIso_();
    session.commitResult = previouslyCommitted;
    saveDeletionUploadSession_(session);
    return previouslyCommitted;
  }
  if (!session.driveFileId) {
    const status = getDeletionEvidenceUploadStatus_(sessionId);
    if (!status.complete) throw new Error('UPLOAD_INCOMPLETE: Bukti disposisi baru terunggah ' + status.uploadedBytes + ' dari ' + status.fileSize + ' byte.');
    Object.assign(session, getDeletionUploadSession_(sessionId));
  }
  const result = deleteArchive_(session.form, session.driveFileId, session.fileName);
  session.committed = true;
  session.committedAt = nowIso_();
  session.commitResult = result;
  saveDeletionUploadSession_(session);
  return result;
}

function cancelDeletionEvidenceUpload_(sessionId) {
  const session = getDeletionUploadSession_(sessionId);
  if (session.driveFileId && !session.committed) {
    try { DriveApp.getFileById(session.driveFileId).setTrashed(true); } catch (ignore) {}
  }
  deleteDeletionUploadSession_(sessionId);
  return {ok: true};
}

function validateDeletionUploadRequest_(request) {
  request = request || {};
  const form = sanitizeDeletionUploadForm_(request);
  resolveDeletionContext_(form);
  const fileName = cleanText_(requireValue_(request.evidenceName, 'Nama bukti disposisi'), 250);
  const fileSize = Number(request.evidenceSize);
  const extension = (fileName.match(/\.([^.]+)$/) || ['', ''])[1].toLowerCase();
  if (['pdf', 'jpg', 'jpeg', 'png'].indexOf(extension) === -1) throw new Error('Bukti disposisi harus PDF, JPG, JPEG, atau PNG.');
  if (!Number.isInteger(fileSize) || fileSize < 1) throw new Error('Ukuran bukti disposisi tidak valid.');
  if (fileSize > DELETION_EVIDENCE_UPLOAD_MAX_SIZE_) throw new Error('Ukuran bukti disposisi maksimal 25 MB.');
  let mimeType = cleanText_(request.evidenceType || '', 100).toLowerCase();
  if (!mimeType || mimeType === 'application/octet-stream') {
    mimeType = extension === 'pdf' ? 'application/pdf' : extension === 'png' ? 'image/png' : 'image/jpeg';
  }
  if (['application/pdf', 'image/jpeg', 'image/png'].indexOf(mimeType) === -1) throw new Error('Tipe bukti disposisi tidak didukung.');
  return {form: form, fileName: fileName, fileSize: fileSize, mimeType: mimeType};
}

function sanitizeDeletionUploadForm_(request) {
  const allowed = ['deletionScope', 'deletionBerkasId', 'deletionItemId', 'deletionReason', 'deletionConfirmation'];
  const form = {};
  allowed.forEach(key => form[key] = request[key] === undefined || request[key] === null ? '' : String(request[key]));
  return form;
}

function deletionUploadPropertyKey_(sessionId) {
  return DELETION_UPLOAD_PROPERTY_PREFIX_ + cleanText_(requireValue_(sessionId, 'ID sesi bukti disposisi'), 90);
}

function saveDeletionUploadSession_(session) {
  PropertiesService.getScriptProperties().setProperty(deletionUploadPropertyKey_(session.sessionId), JSON.stringify(session));
}

function getDeletionUploadSession_(sessionId) {
  const value = PropertiesService.getScriptProperties().getProperty(deletionUploadPropertyKey_(sessionId));
  if (!value) throw new Error('UPLOAD_SESSION_NOT_FOUND: Sesi bukti disposisi tidak ditemukan. Klik kembali tombol penghapusan untuk memulai ulang.');
  const session = JSON.parse(value);
  if (session.userEmail && session.userEmail !== getCurrentUser_()) throw new Error('Sesi bukti disposisi dibuat oleh pengguna lain.');
  return session;
}

function deleteDeletionUploadSession_(sessionId) {
  PropertiesService.getScriptProperties().deleteProperty(deletionUploadPropertyKey_(sessionId));
}

function deletionUploadProgress_(session) {
  return {
    ok: true,
    sessionId: session.sessionId,
    chunkSize: ITEM_UPLOAD_CHUNK_SIZE_,
    uploadedBytes: Number(session.uploadedBytes || 0),
    fileSize: Number(session.fileSize),
    complete: Boolean(session.driveFileId),
    committed: Boolean(session.committed),
    result: session.commitResult || null
  };
}

function findCommittedDeletionResult_(form) {
  form = form || {};
  const scope = String(form.deletionScope || '').toUpperCase();
  const berkasId = cleanText_(form.deletionBerkasId, 80);
  const parent = readObjects_(APP_CONFIG.SHEETS.BERKAS).find(row => row.BERKAS_ID === berkasId);
  if (scope === 'BERKAS' && parent && isDeleted_(parent)) {
    return {ok: true, scope: scope, berkasId: berkasId, itemId: '', warnings: [], message: 'Berkas sudah dihapus. Status transaksi berhasil dipulihkan.'};
  }
  if (scope === 'ITEM') {
    const itemId = cleanText_(form.deletionItemId, 80);
    const item = readObjects_(APP_CONFIG.SHEETS.ITEM).find(row => row.ITEM_ID === itemId && row.BERKAS_ID === berkasId);
    if (item && isDeleted_(item)) return {ok: true, scope: scope, berkasId: berkasId, itemId: itemId, warnings: [], message: 'Item sudah dihapus. Status transaksi berhasil dipulihkan.'};
  }
  return null;
}

function startEditReplacementUpload_(request) {
  purgeOldEditUploadSessions_();
  const normalized = validateEditUploadRequest_(request);
  const sessionId = 'EDITUPL-' + Utilities.getUuid();
  const temporaryName = 'TMP_EDIT_' + sessionId + '.pdf';
  const sessionUrl = initializeDriveResumableUpload_(temporaryName, normalized.fileSize, normalized.folderId, 'application/pdf');
  const session = {
    sessionId: sessionId,
    sessionUrl: sessionUrl,
    userEmail: getCurrentUser_(),
    fileName: normalized.fileName,
    fileSize: normalized.fileSize,
    mimeType: 'application/pdf',
    uploadedBytes: 0,
    driveFileId: '',
    form: normalized.form,
    committed: false,
    commitResult: null,
    createdAt: nowIso_()
  };
  saveEditUploadSession_(session);
  audit_('UPLOAD_START', 'EDIT_ARSIP', 'PDF_PENGGANTI', sessionId,
    'Memulai upload bertahap PDF pengganti: ' + normalized.fileName,
    normalized.fileSize + ' byte', 'SUCCESS');
  return editUploadProgress_(session);
}

function uploadEditReplacementChunk_(request) {
  request = request || {};
  const session = getEditUploadSession_(request.sessionId);
  if (session.driveFileId) return editUploadProgress_(session);
  const total = Number(request.total);
  const start = Number(request.start);
  const endExclusive = Number(request.end);
  if (total !== session.fileSize) throw new Error('Ukuran PDF pengganti berubah selama upload.');
  if (!Number.isInteger(start) || !Number.isInteger(endExclusive) || start < 0 || endExclusive <= start || endExclusive > total) throw new Error('Posisi potongan PDF pengganti tidak valid.');
  if (start !== Number(session.uploadedBytes || 0)) return editUploadProgress_(session);
  const bytes = Utilities.base64Decode(String(request.base64 || ''));
  if (bytes.length !== endExclusive - start) throw new Error('Ukuran potongan PDF pengganti tidak sesuai.');
  if (endExclusive < total && bytes.length % (256 * 1024) !== 0) throw new Error('Potongan selain yang terakhir harus kelipatan 256 KB.');
  const response = sendDriveResumableChunk_(session.sessionUrl, bytes, start, endExclusive, total, 'application/pdf');
  if (response.complete) {
    session.uploadedBytes = total;
    session.driveFileId = response.fileId;
  } else {
    session.uploadedBytes = response.uploadedBytes;
  }
  saveEditUploadSession_(session);
  return editUploadProgress_(session);
}

function getEditReplacementUploadStatus_(sessionId) {
  const session = getEditUploadSession_(sessionId);
  if (session.committed && session.commitResult) return editUploadProgress_(session);
  if (session.driveFileId) return editUploadProgress_(session);
  const response = queryDriveResumableStatus_(session.sessionUrl, session.fileSize, 'application/pdf');
  if (response.complete) {
    session.uploadedBytes = session.fileSize;
    session.driveFileId = response.fileId;
  } else {
    session.uploadedBytes = response.uploadedBytes;
  }
  saveEditUploadSession_(session);
  return editUploadProgress_(session);
}

function finalizeEditReplacementUpload_(sessionId) {
  const session = getEditUploadSession_(sessionId);
  if (session.committed && session.commitResult) return session.commitResult;
  const previouslyCommitted = findCommittedEditResult_(session);
  if (previouslyCommitted) {
    session.committed = true;
    session.committedAt = nowIso_();
    session.commitResult = previouslyCommitted;
    saveEditUploadSession_(session);
    return previouslyCommitted;
  }
  if (!session.driveFileId) {
    const status = getEditReplacementUploadStatus_(sessionId);
    if (!status.complete) throw new Error('UPLOAD_INCOMPLETE: PDF pengganti baru terunggah ' + status.uploadedBytes + ' dari ' + status.fileSize + ' byte.');
    Object.assign(session, getEditUploadSession_(sessionId));
  }
  const result = updateArchiveItem_(session.form, session.driveFileId);
  session.committed = true;
  session.committedAt = nowIso_();
  session.commitResult = result;
  saveEditUploadSession_(session);
  return result;
}

function cancelEditReplacementUpload_(sessionId) {
  const session = getEditUploadSession_(sessionId);
  if (session.driveFileId && !session.committed) {
    try { DriveApp.getFileById(session.driveFileId).setTrashed(true); } catch (ignore) {}
  }
  deleteEditUploadSession_(sessionId);
  return {ok: true};
}

function validateEditUploadRequest_(request) {
  request = request || {};
  const form = sanitizeEditUploadForm_(request);
  const berkasId = cleanText_(requireValue_(form.editBerkasId, 'Berkas induk'), 80);
  const itemId = cleanText_(requireValue_(form.editItemId, 'Item arsip'), 80);
  const reason = cleanText_(requireValue_(form.editReason, 'Alasan perubahan'), 2000);
  if (reason.length < 10) throw new Error('Alasan perubahan minimal 10 karakter.');
  const parent = readObjects_(APP_CONFIG.SHEETS.BERKAS).find(row => row.BERKAS_ID === berkasId && !isDeleted_(row));
  if (!parent) throw new Error('Berkas induk tidak ditemukan atau sudah dihapus.');
  const item = readObjects_(APP_CONFIG.SHEETS.ITEM).find(row => row.ITEM_ID === itemId && row.BERKAS_ID === berkasId && !isDeleted_(row));
  if (!item) throw new Error('Item arsip tidak ditemukan atau sudah dihapus.');
  assertItemAvailableForEdit_(parent, item);
  requireValue_(form.editDescription, 'Uraian informasi arsip');
  const pages = positiveInteger_(requireValue_(form.editPageCount, 'Jumlah halaman'), 'Jumlah halaman');
  if (pages < 1) throw new Error('Jumlah halaman minimal 1.');
  parseLocalDate_(requireValue_(form.editDocumentDate, 'Tanggal naskah'), 'Tanggal naskah');
  if (['ASLI', 'COPY'].indexOf(String(form.editDevelopmentLevel).toUpperCase()) === -1) throw new Error('Tingkat perkembangan harus ASLI atau COPY.');
  const fileName = cleanText_(requireValue_(request.replacementName, 'Nama PDF pengganti'), 250);
  const fileSize = Number(request.replacementSize);
  const mimeType = cleanText_(request.replacementType || 'application/pdf', 100).toLowerCase();
  if (!fileName.toLowerCase().endsWith('.pdf')) throw new Error('File alih media pengganti harus PDF.');
  if (!['application/pdf', 'application/octet-stream', ''].includes(mimeType)) throw new Error('File alih media pengganti harus PDF.');
  if (!Number.isInteger(fileSize) || fileSize < 1) throw new Error('Ukuran PDF pengganti tidak valid.');
  if (fileSize >= ITEM_UPLOAD_MAX_SIZE_) throw new Error('Ukuran PDF pengganti harus kurang dari 100 MB.');
  return {form: form, fileName: fileName, fileSize: fileSize, folderId: requireValue_(parent.DRIVE_FOLDER_ID, 'Folder Drive berkas')};
}

function sanitizeEditUploadForm_(request) {
  const allowed = ['editBerkasId', 'editItemId', 'editDocumentDate', 'editPageCount', 'editDevelopmentLevel', 'editDescription', 'editReason'];
  const form = {};
  allowed.forEach(key => form[key] = request[key] === undefined || request[key] === null ? '' : String(request[key]));
  return form;
}

function editUploadPropertyKey_(sessionId) {
  return EDIT_UPLOAD_PROPERTY_PREFIX_ + cleanText_(requireValue_(sessionId, 'ID sesi PDF pengganti'), 90);
}

function saveEditUploadSession_(session) {
  PropertiesService.getScriptProperties().setProperty(editUploadPropertyKey_(session.sessionId), JSON.stringify(session));
}

function getEditUploadSession_(sessionId) {
  const value = PropertiesService.getScriptProperties().getProperty(editUploadPropertyKey_(sessionId));
  if (!value) throw new Error('UPLOAD_SESSION_NOT_FOUND: Sesi PDF pengganti tidak ditemukan. Klik Simpan Perubahan untuk memulai ulang.');
  const session = JSON.parse(value);
  if (session.userEmail && session.userEmail !== getCurrentUser_()) throw new Error('Sesi PDF pengganti dibuat oleh pengguna lain.');
  return session;
}

function deleteEditUploadSession_(sessionId) {
  PropertiesService.getScriptProperties().deleteProperty(editUploadPropertyKey_(sessionId));
}

function editUploadProgress_(session) {
  return {
    ok: true,
    sessionId: session.sessionId,
    chunkSize: ITEM_UPLOAD_CHUNK_SIZE_,
    uploadedBytes: Number(session.uploadedBytes || 0),
    fileSize: Number(session.fileSize),
    complete: Boolean(session.driveFileId),
    committed: Boolean(session.committed),
    result: session.commitResult || null
  };
}

function findCommittedEditResult_(session) {
  if (!session.driveFileId) return null;
  const form = session.form || {};
  const item = readObjects_(APP_CONFIG.SHEETS.ITEM).find(row => row.ITEM_ID === form.editItemId && row.BERKAS_ID === form.editBerkasId && !isDeleted_(row));
  if (!item || String(item.DRIVE_FILE_ID || '') !== String(session.driveFileId)) return null;
  const matches = cleanText_(item.URAIAN_LENGKAP, 2000) === cleanText_(form.editDescription, 2000) &&
    Number(item.JUMLAH_HALAMAN || 0) === Number(form.editPageCount) &&
    dateKey_(item.TANGGAL_NASKAH) === dateKey_(form.editDocumentDate) &&
    String(item.TINGKAT_PERKEMBANGAN || '').toUpperCase() === String(form.editDevelopmentLevel || '').toUpperCase();
  if (!matches) return null;
  return {ok: true, berkasId: item.BERKAS_ID, itemId: item.ITEM_ID, warnings: [], message: 'Perubahan item sudah tersimpan. Status transaksi berhasil dipulihkan.'};
}

function initializeDriveResumableUpload_(fileName, fileSize, parentFolderId, mimeType) {
  mimeType = mimeType || 'application/pdf';
  const response = UrlFetchApp.fetch(DRIVE_RESUMABLE_UPLOAD_URL_, {
    method: 'post',
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      'X-Upload-Content-Type': mimeType,
      'X-Upload-Content-Length': String(fileSize)
    },
    contentType: 'application/json; charset=UTF-8',
    payload: JSON.stringify({name: fileName, mimeType: mimeType, parents: [parentFolderId]}),
    muteHttpExceptions: true
  });
  const code = response.getResponseCode();
  if (code !== 200 && code !== 201) throw driveUploadError_('Membuka sesi upload', response);
  const location = responseHeader_(response, 'location');
  if (!location) throw new Error('Drive tidak mengembalikan alamat sesi upload. Jalankan Uji Jalur Upload PDF dari menu spreadsheet.');
  return location;
}

function sendDriveResumableChunk_(sessionUrl, bytes, start, endExclusive, total, mimeType) {
  const response = UrlFetchApp.fetch(sessionUrl, {
    method: 'put',
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      'Content-Range': 'bytes ' + start + '-' + (endExclusive - 1) + '/' + total
    },
    contentType: mimeType || 'application/pdf',
    payload: bytes,
    muteHttpExceptions: true
  });
  return parseDriveUploadResponse_(response, endExclusive);
}

function queryDriveResumableStatus_(sessionUrl, total, mimeType) {
  const response = UrlFetchApp.fetch(sessionUrl, {
    method: 'put',
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      'Content-Range': 'bytes */' + total
    },
    contentType: mimeType || 'application/pdf',
    payload: [],
    muteHttpExceptions: true
  });
  return parseDriveUploadResponse_(response, 0);
}

function parseDriveUploadResponse_(response, fallbackUploadedBytes) {
  const code = response.getResponseCode();
  if (code === 200 || code === 201) {
    let body = {};
    try { body = JSON.parse(response.getContentText() || '{}'); } catch (ignore) {}
    if (!body.id) throw new Error('Drive menyelesaikan upload tetapi tidak mengembalikan ID file.');
    return {complete: true, fileId: body.id, uploadedBytes: fallbackUploadedBytes};
  }
  if (code === 308) {
    const range = responseHeader_(response, 'range');
    const match = String(range || '').match(/bytes=0-(\d+)/i);
    return {complete: false, fileId: '', uploadedBytes: match ? Number(match[1]) + 1 : 0};
  }
  if (code === 404 || code === 410) throw new Error('UPLOAD_SESSION_EXPIRED: Sesi upload Drive sudah kedaluwarsa. Klik Coba Upload Lagi untuk memulai ulang.');
  if (code >= 500) throw new Error('UPLOAD_RETRYABLE: Drive sementara tidak dapat menerima potongan PDF (HTTP ' + code + '). Klik Coba Upload Lagi.');
  throw driveUploadError_('Mengirim potongan PDF', response);
}

function responseHeader_(response, name) {
  const headers = response.getAllHeaders ? response.getAllHeaders() : response.getHeaders();
  const wanted = String(name).toLowerCase();
  const key = Object.keys(headers || {}).find(headerName => String(headerName).toLowerCase() === wanted);
  if (!key) return '';
  const value = headers[key];
  return Array.isArray(value) ? value[0] : value;
}

function driveUploadError_(action, response) {
  const body = cleanText_(response.getContentText() || '', 600);
  return new Error(action + ' gagal di Google Drive (HTTP ' + response.getResponseCode() + ')' + (body ? ': ' + body : '.'));
}

function itemUploadPropertyKey_(sessionId) {
  return ITEM_UPLOAD_PROPERTY_PREFIX_ + cleanText_(requireValue_(sessionId, 'ID sesi upload'), 80);
}

function saveItemUploadSession_(session) {
  PropertiesService.getScriptProperties().setProperty(itemUploadPropertyKey_(session.sessionId), JSON.stringify(session));
}

function getItemUploadSession_(sessionId) {
  const key = itemUploadPropertyKey_(sessionId);
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (!value) throw new Error('UPLOAD_SESSION_NOT_FOUND: Sesi upload tidak ditemukan. Klik Coba Upload Lagi untuk memulai ulang.');
  const session = JSON.parse(value);
  if (session.userEmail && session.userEmail !== getCurrentUser_()) throw new Error('Sesi upload ini dibuat oleh pengguna lain.');
  return session;
}

function deleteItemUploadSession_(sessionId) {
  PropertiesService.getScriptProperties().deleteProperty(itemUploadPropertyKey_(sessionId));
}

function itemUploadProgress_(session) {
  return {
    ok: true,
    sessionId: session.sessionId,
    chunkSize: ITEM_UPLOAD_CHUNK_SIZE_,
    uploadedBytes: Number(session.uploadedBytes || 0),
    fileSize: Number(session.fileSize),
    complete: Boolean(session.driveFileId),
    committed: Boolean(session.committed),
    result: session.commitResult || null
  };
}

function findCommittedItemResult_(itemId) {
  itemId = cleanText_(itemId, 80);
  if (!itemId) return null;
  const item = readObjects_(APP_CONFIG.SHEETS.ITEM).find(row => row.ITEM_ID === itemId && !isDeleted_(row));
  if (!item) return null;
  return {
    ok: true,
    itemId: item.ITEM_ID,
    berkasId: item.BERKAS_ID,
    fileUrl: item.DRIVE_FILE_URL || '',
    message: 'Item sudah tersimpan. Status upload dipulihkan tanpa membuat data ganda.'
  };
}

function purgeOldItemUploadSessions_() {
  purgeOldUploadSessionsByPrefix_(ITEM_UPLOAD_PROPERTY_PREFIX_);
}

function purgeOldDeletionUploadSessions_() {
  purgeOldUploadSessionsByPrefix_(DELETION_UPLOAD_PROPERTY_PREFIX_);
}

function purgeOldEditUploadSessions_() {
  purgeOldUploadSessionsByPrefix_(EDIT_UPLOAD_PROPERTY_PREFIX_);
}

function purgeOldUploadSessionsByPrefix_(prefix) {
  const properties = PropertiesService.getScriptProperties();
  const all = properties.getProperties();
  const now = Date.now();
  Object.keys(all).filter(key => key.indexOf(prefix) === 0).forEach(key => {
    try {
      const session = JSON.parse(all[key]);
      const referenceTime = new Date(session.committedAt || session.createdAt || 0).getTime();
      const maxAge = session.committed ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
      if (referenceTime && now - referenceTime > maxAge) properties.deleteProperty(key);
    } catch (ignore) {
      properties.deleteProperty(key);
    }
  });
}

function runUploadPipelineDiagnostic_() {
  const settings = readSettings_();
  const folderId = cleanText_(requireValue_(settings.ARCHIVE_FOLDER_ID, 'ARCHIVE_FOLDER_ID pada SETTINGS'), 200);
  const pdfText = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF';
  const bytes = Utilities.newBlob(pdfText, 'application/pdf').getBytes();
  let fileId = '';
  try {
    const sessionUrl = initializeDriveResumableUpload_('DIAGNOSTIK_UPLOAD_' + Utilities.formatDate(new Date(), APP_CONFIG.TIME_ZONE, 'yyyyMMdd_HHmmss') + '.pdf', bytes.length, folderId, 'application/pdf');
    const result = sendDriveResumableChunk_(sessionUrl, bytes, 0, bytes.length, bytes.length, 'application/pdf');
    if (!result.complete || !result.fileId) throw new Error('Upload diagnostik tidak selesai.');
    fileId = result.fileId;
    const file = DriveApp.getFileById(fileId);
    const resultSize = Number(file.getSize());
    const resultMime = file.getMimeType();
    file.setTrashed(true);
    audit_('UPLOAD_DIAGNOSTIC', 'SISTEM', 'FILE', fileId, 'Uji jalur upload PDF berhasil', resultSize + ' byte; ' + resultMime, 'SUCCESS');
    return {ok: true, fileId: fileId, size: resultSize, mimeType: resultMime, message: 'Jalur upload PDF berhasil diuji. File diagnostik sudah dipindahkan ke Trash.'};
  } catch (error) {
    if (fileId) try { DriveApp.getFileById(fileId).setTrashed(true); } catch (ignore) {}
    audit_('UPLOAD_DIAGNOSTIC', 'SISTEM', 'FILE', fileId, 'Uji jalur upload PDF gagal', error.message, 'FAILED');
    throw error;
  }
}

function runDeletionEvidenceUploadDiagnostic_() {
  const folder = getDeletionEvidenceFolder_();
  const pdfText = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF';
  const bytes = Utilities.newBlob(pdfText, 'application/pdf').getBytes();
  let fileId = '';
  try {
    const fileName = 'DIAGNOSTIK_BUKTI_PENGHAPUSAN_' + Utilities.formatDate(new Date(), APP_CONFIG.TIME_ZONE, 'yyyyMMdd_HHmmss') + '.pdf';
    const sessionUrl = initializeDriveResumableUpload_(fileName, bytes.length, folder.getId(), 'application/pdf');
    const result = sendDriveResumableChunk_(sessionUrl, bytes, 0, bytes.length, bytes.length, 'application/pdf');
    if (!result.complete || !result.fileId) throw new Error('Upload diagnostik bukti disposisi tidak selesai.');
    fileId = result.fileId;
    const file = DriveApp.getFileById(fileId);
    const resultSize = Number(file.getSize());
    const resultMime = file.getMimeType();
    file.setTrashed(true);
    audit_('UPLOAD_DIAGNOSTIC', 'PENGHAPUSAN', 'BUKTI_DISPOSISI', fileId,
      'Uji upload bukti disposisi berhasil', resultSize + ' byte; ' + resultMime, 'SUCCESS');
    return {ok: true, fileId: fileId, size: resultSize, mimeType: resultMime, message: 'Jalur upload bukti disposisi berhasil. File diagnostik sudah dipindahkan ke Trash.'};
  } catch (error) {
    if (fileId) try { DriveApp.getFileById(fileId).setTrashed(true); } catch (ignore) {}
    audit_('UPLOAD_DIAGNOSTIC', 'PENGHAPUSAN', 'BUKTI_DISPOSISI', fileId,
      'Uji upload bukti disposisi gagal', error.message, 'FAILED');
    throw error;
  }
}
