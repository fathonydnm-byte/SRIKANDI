var MEDIA_UPLOAD_PROPERTY_PREFIX_ = 'MEDIA_ATTACHMENT_SESSION_';

function getMediaUploadOptions_() {
  const activeParents = readObjects_(APP_CONFIG.SHEETS.BERKAS)
    .filter(row => !isDeleted_(row));
  const parentById = {};
  activeParents.forEach(row => parentById[row.BERKAS_ID] = row);

  const itemsByBerkas = {};
  const missingItems = readObjects_(APP_CONFIG.SHEETS.ITEM)
    .filter(row => !isDeleted_(row) && parentById[row.BERKAS_ID] && !cleanText_(row.DRIVE_FILE_ID, 250))
    .sort((a, b) => {
      const parentCompare = naturalCompare_(a.NO_BERKAS_SNAPSHOT || '999999', b.NO_BERKAS_SNAPSHOT || '999999');
      return parentCompare || naturalCompare_(a.NO_ITEM_DEFINITIF || '999999', b.NO_ITEM_DEFINITIF || '999999');
    });

  missingItems.forEach(row => {
    if (!itemsByBerkas[row.BERKAS_ID]) itemsByBerkas[row.BERKAS_ID] = [];
    itemsByBerkas[row.BERKAS_ID].push({
      id: row.ITEM_ID,
      number: row.NO_ITEM_DEFINITIF || '',
      description: row.URAIAN_LENGKAP || '',
      documentDate: row.TANGGAL_NASKAH ? dateKey_(row.TANGGAL_NASKAH) : '',
      pageCount: Number(row.JUMLAH_HALAMAN || 0),
      fileStatus: row.STATUS_FILE || 'BELUM DIUNGGAH',
      plannedFileName: row.NAMA_FILE || '',
      label: (row.NO_ITEM_DEFINITIF || '–') + ' – ' + cleanText_(row.URAIAN_LENGKAP || 'Tanpa uraian', 140)
    });
  });

  const availableParents = activeParents
    .filter(row => itemsByBerkas[row.BERKAS_ID] && itemsByBerkas[row.BERKAS_ID].length)
    .sort((a, b) => naturalCompare_(a.NO_BERKAS_DEFINITIF || '999999', b.NO_BERKAS_DEFINITIF || '999999'))
    .map(row => ({
      id: row.BERKAS_ID,
      number: row.NO_BERKAS_DEFINITIF || '',
      title: row.JUDUL_BERKAS || '',
      label: (row.NO_BERKAS_DEFINITIF || 'DRAFT') + ' – ' + row.JUDUL_BERKAS + ' (' + itemsByBerkas[row.BERKAS_ID].length + ' belum ada PDF)'
    }));

  return {berkas: availableParents, itemsByBerkas: itemsByBerkas, totalMissing: missingItems.length};
}

function startMediaUpload_(request) {
  purgeOldUploadSessionsByPrefix_(MEDIA_UPLOAD_PROPERTY_PREFIX_);
  const context = validateMediaUploadRequest_(request);
  const sessionId = 'MEDIA-' + Utilities.getUuid();
  const temporaryName = 'UPLOAD_ALIH_MEDIA_' + sessionId + '.pdf';
  const sessionUrl = initializeDriveResumableUpload_(temporaryName, context.fileSize, context.folderId, 'application/pdf');
  const session = {
    sessionId: sessionId,
    sessionUrl: sessionUrl,
    userEmail: getCurrentUser_(),
    berkasId: context.berkasId,
    itemId: context.itemId,
    originalFileName: context.fileName,
    fileSize: context.fileSize,
    uploadedBytes: 0,
    driveFileId: '',
    committed: false,
    commitResult: null,
    createdAt: nowIso_()
  };
  saveMediaUploadSession_(session);
  audit_('UPLOAD_START', 'ALIH_MEDIA', 'ITEM', context.itemId, 'Memulai upload susulan PDF alih media', context.fileName + ' · ' + context.fileSize + ' byte', 'SUCCESS');
  return mediaUploadProgress_(session);
}

function uploadMediaChunk_(request) {
  request = request || {};
  const session = getMediaUploadSession_(request.sessionId);
  if (session.driveFileId) return mediaUploadProgress_(session);
  const total = Number(request.total);
  const start = Number(request.start);
  const endExclusive = Number(request.end);
  if (total !== Number(session.fileSize)) throw new Error('Ukuran PDF berubah selama upload. Pilih ulang PDF.');
  if (!Number.isInteger(start) || !Number.isInteger(endExclusive) || start < 0 || endExclusive <= start || endExclusive > total) {
    throw new Error('Posisi potongan PDF tidak valid.');
  }
  if (start !== Number(session.uploadedBytes || 0)) return mediaUploadProgress_(session);
  const bytes = Utilities.base64Decode(String(request.base64 || ''));
  if (bytes.length !== endExclusive - start) throw new Error('Ukuran potongan PDF tidak sesuai.');
  if (endExclusive < total && bytes.length % (256 * 1024) !== 0) throw new Error('Potongan selain yang terakhir harus kelipatan 256 KB.');
  const response = sendDriveResumableChunk_(session.sessionUrl, bytes, start, endExclusive, total, 'application/pdf');
  if (response.complete) {
    session.uploadedBytes = total;
    session.driveFileId = response.fileId;
  } else {
    session.uploadedBytes = response.uploadedBytes;
  }
  saveMediaUploadSession_(session);
  return mediaUploadProgress_(session);
}

function getMediaUploadStatus_(sessionId) {
  const session = getMediaUploadSession_(sessionId);
  if (session.committed && session.commitResult) return mediaUploadProgress_(session);
  if (session.driveFileId) return mediaUploadProgress_(session);
  const response = queryDriveResumableStatus_(session.sessionUrl, session.fileSize, 'application/pdf');
  if (response.complete) {
    session.uploadedBytes = session.fileSize;
    session.driveFileId = response.fileId;
  } else {
    session.uploadedBytes = response.uploadedBytes;
  }
  saveMediaUploadSession_(session);
  return mediaUploadProgress_(session);
}

function finalizeMediaUpload_(sessionId) {
  let session = getMediaUploadSession_(sessionId);
  if (session.committed && session.commitResult) return session.commitResult;
  const recovered = findCommittedMediaResult_(session);
  if (recovered) {
    const recoveryWarning = refreshReportAfterMediaUpload_(session.itemId);
    recovered.warnings = recoveryWarning ? [recoveryWarning] : [];
    recovered.message = recoveryWarning
      ? 'PDF alih media sudah terhubung, tetapi laporan belum dapat disegarkan. Jalankan repairReports.'
      : 'PDF alih media sudah terhubung dan laporan berhasil dipulihkan tanpa membuat file ganda.';
    session.committed = true;
    session.committedAt = nowIso_();
    session.commitResult = recovered;
    saveMediaUploadSession_(session);
    return recovered;
  }
  if (!session.driveFileId) {
    const status = getMediaUploadStatus_(sessionId);
    if (!status.complete) throw new Error('UPLOAD_INCOMPLETE: PDF baru terunggah ' + status.uploadedBytes + ' dari ' + status.fileSize + ' byte.');
    session = getMediaUploadSession_(sessionId);
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const parent = readObjects_(APP_CONFIG.SHEETS.BERKAS).find(row => row.BERKAS_ID === session.berkasId && !isDeleted_(row));
    if (!parent) throw new Error('Berkas induk tidak ditemukan atau sudah dihapus.');
    const item = readObjects_(APP_CONFIG.SHEETS.ITEM).find(row => row.ITEM_ID === session.itemId && row.BERKAS_ID === session.berkasId && !isDeleted_(row));
    if (!item) throw new Error('Item arsip tidak ditemukan atau sudah dihapus.');
    if (cleanText_(item.DRIVE_FILE_ID, 250)) {
      if (String(item.DRIVE_FILE_ID) === String(session.driveFileId)) return findCommittedMediaResult_(session);
      try { DriveApp.getFileById(session.driveFileId).setTrashed(true); } catch (ignore) {}
      throw new Error('Item ini sudah memiliki PDF. Gunakan menu Edit Arsip bila ingin mengganti file.');
    }
    assertItemAvailableForEdit_(parent, item);
    const parentNumber = item.NO_BERKAS_SNAPSHOT || parent.NO_BERKAS_DEFINITIF || '';
    const itemNumber = item.NO_ITEM_DEFINITIF || '';
    const safeDescription = item.URAIAN_NAMA_FILE || cleanFileName_(item.URAIAN_LENGKAP || 'arsip');
    const fileName = parentNumber + '_' + itemNumber + '_' + safeDescription + '.pdf';
    const file = DriveApp.getFileById(session.driveFileId);
    if (String(file.getMimeType() || '').toLowerCase() !== 'application/pdf') throw new Error('File hasil upload bukan PDF.');
    file.setName(fileName);
    const timestamp = nowIso_();
    const user = getCurrentUser_();
    updateObjectAtRow_(APP_CONFIG.SHEETS.ITEM, item._rowNumber, {
      NAMA_FILE: fileName,
      DRIVE_FILE_ID: file.getId(),
      DRIVE_FILE_URL: file.getUrl(),
      MIME_TYPE: 'application/pdf',
      STATUS_FILE: 'TERSEDIA',
      UPDATED_AT: timestamp,
      UPDATED_BY: user,
      VERSION: Number(item.VERSION || 0) + 1
    });
    const reportWarning = refreshReportAfterMediaUpload_(item.ITEM_ID);
    const result = {
      ok: true,
      berkasId: parent.BERKAS_ID,
      itemId: item.ITEM_ID,
      fileUrl: file.getUrl(),
      fileName: fileName,
      warnings: reportWarning ? [reportWarning] : [],
      message: reportWarning
        ? 'PDF berhasil dihubungkan, tetapi laporan belum dapat disegarkan. Jalankan repairReports.'
        : 'PDF alih media berhasil dihubungkan ke item ' + itemNumber + ' dan laporan telah diperbarui.'
    };
    audit_('UPLOAD', 'ALIH_MEDIA', 'ITEM', item.ITEM_ID, 'Melengkapi PDF alih media item yang sudah tersimpan', fileName, reportWarning ? 'WARNING' : 'SUCCESS');
    session.committed = true;
    session.committedAt = timestamp;
    session.commitResult = result;
    saveMediaUploadSession_(session);
    return result;
  } catch (error) {
    audit_('UPLOAD', 'ALIH_MEDIA', 'ITEM', session.itemId || '', 'Gagal melengkapi PDF alih media', error.message, 'FAILED');
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function refreshReportAfterMediaUpload_(itemId) {
  try {
    rebuildReports_();
    return '';
  } catch (error) {
    const warning = 'Laporan DAFTAR ISI BERKAS belum dapat disegarkan: ' + error.message;
    audit_('REPORT_WARNING', 'ALIH_MEDIA', 'ITEM', itemId || '', 'PDF sudah tersimpan tetapi laporan gagal disegarkan', error.message, 'WARNING');
    return warning;
  }
}

function cancelMediaUpload_(sessionId) {
  const session = getMediaUploadSession_(sessionId);
  if (session.driveFileId && !session.committed) {
    try { DriveApp.getFileById(session.driveFileId).setTrashed(true); } catch (ignore) {}
  }
  PropertiesService.getScriptProperties().deleteProperty(mediaUploadPropertyKey_(sessionId));
  return {ok: true};
}

function validateMediaUploadRequest_(request) {
  request = request || {};
  const berkasId = cleanText_(requireValue_(request.berkasId, 'Berkas induk'), 80);
  const itemId = cleanText_(requireValue_(request.itemId, 'Item arsip'), 80);
  const parent = readObjects_(APP_CONFIG.SHEETS.BERKAS).find(row => row.BERKAS_ID === berkasId && !isDeleted_(row));
  if (!parent) throw new Error('Berkas induk tidak ditemukan atau sudah dihapus.');
  const item = readObjects_(APP_CONFIG.SHEETS.ITEM).find(row => row.ITEM_ID === itemId && row.BERKAS_ID === berkasId && !isDeleted_(row));
  if (!item) throw new Error('Item arsip tidak ditemukan atau sudah dihapus.');
  if (cleanText_(item.DRIVE_FILE_ID, 250)) throw new Error('Item ini sudah memiliki PDF. Gunakan menu Edit Arsip untuk mengganti file.');
  assertItemAvailableForEdit_(parent, item);
  const fileName = cleanText_(requireValue_(request.fileName, 'Nama PDF'), 250);
  const fileSize = Number(request.fileSize);
  const mimeType = cleanText_(request.mimeType || 'application/pdf', 100).toLowerCase();
  if (!fileName.toLowerCase().endsWith('.pdf')) throw new Error('File alih media harus PDF.');
  if (['application/pdf', 'application/octet-stream', ''].indexOf(mimeType) === -1) throw new Error('File alih media harus PDF.');
  if (!Number.isInteger(fileSize) || fileSize < 1) throw new Error('Ukuran PDF tidak valid.');
  if (fileSize >= ITEM_UPLOAD_MAX_SIZE_) throw new Error('Ukuran PDF harus kurang dari 100 MB.');
  const folderId = cleanText_(requireValue_(parent.DRIVE_FOLDER_ID, 'Folder Drive berkas'), 250);
  DriveApp.getFolderById(folderId).getName();
  return {berkasId: berkasId, itemId: itemId, fileName: fileName, fileSize: fileSize, folderId: folderId};
}

function mediaUploadPropertyKey_(sessionId) {
  return MEDIA_UPLOAD_PROPERTY_PREFIX_ + cleanText_(requireValue_(sessionId, 'ID sesi alih media'), 90);
}

function saveMediaUploadSession_(session) {
  PropertiesService.getScriptProperties().setProperty(mediaUploadPropertyKey_(session.sessionId), JSON.stringify(session));
}

function getMediaUploadSession_(sessionId) {
  const value = PropertiesService.getScriptProperties().getProperty(mediaUploadPropertyKey_(sessionId));
  if (!value) throw new Error('UPLOAD_SESSION_NOT_FOUND: Sesi alih media tidak ditemukan. Tekan Upload Alih Media untuk memulai ulang.');
  const session = JSON.parse(value);
  if (session.userEmail && session.userEmail !== getCurrentUser_()) throw new Error('Sesi alih media dibuat oleh pengguna lain.');
  return session;
}

function mediaUploadProgress_(session) {
  return {
    ok: true,
    sessionId: session.sessionId,
    chunkSize: ITEM_UPLOAD_CHUNK_SIZE_,
    uploadedBytes: Number(session.uploadedBytes || 0),
    fileSize: Number(session.fileSize || 0),
    complete: Boolean(session.driveFileId),
    committed: Boolean(session.committed),
    result: session.commitResult || null
  };
}

function findCommittedMediaResult_(session) {
  if (!session.driveFileId) return null;
  const item = readObjects_(APP_CONFIG.SHEETS.ITEM).find(row => row.ITEM_ID === session.itemId && row.BERKAS_ID === session.berkasId && !isDeleted_(row));
  if (!item || String(item.DRIVE_FILE_ID || '') !== String(session.driveFileId)) return null;
  return {
    ok: true,
    berkasId: item.BERKAS_ID,
    itemId: item.ITEM_ID,
    fileUrl: item.DRIVE_FILE_URL || '',
    fileName: item.NAMA_FILE || '',
    message: 'PDF alih media sudah terhubung. Status dipulihkan tanpa membuat file ganda.'
  };
}
