function addDuration_(dateValue, amount, unit) {
  const date = parseLocalDate_(dateKey_(dateValue), 'Tanggal retensi');
  if (String(unit).toUpperCase() === 'TAHUN') date.setFullYear(date.getFullYear() + Number(amount));
  else date.setMonth(date.getMonth() + Number(amount));
  return date;
}

function retentionStatus_(activeLimit) {
  const today = parseLocalDate_(Utilities.formatDate(new Date(), APP_CONFIG.TIME_ZONE, 'yyyy-MM-dd'), 'Hari ini');
  const limit = parseLocalDate_(dateKey_(activeLimit), 'Batas aktif');
  const days = Math.floor((limit.getTime() - today.getTime()) / 86400000);
  if (days < 0) return 'HABIS AKTIF – PERLU PERSETUJUAN PEMINDAHAN';
  if (days <= 7) return 'H-' + days;
  return 'AKTIF';
}

function displayLetterNumber_(primary, alternate) {
  if (primary && alternate) return primary + ' atau ' + alternate;
  return primary || alternate || '';
}

function commitItem_(form, preUploadedFileId, allowMissingPdf) {
  const startedAt = Date.now();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let createdFile = null;
  let createdFolder = null;
  let newParentRow = null;
  let newItemRow = null;
  try {
    const mode = String(form.berkasMode || 'EXISTING').toUpperCase();
    const operationCreatedAt = cleanText_(form.previewCreatedAt, 50) || nowIso_();
    const newBerkasId = mode === 'NEW' ? (cleanText_(form.newBerkasId, 80) || 'BRK-' + Utilities.getUuid()) : '';
    const itemId = cleanText_(form.previewItemId, 80) || 'ITM-' + Utilities.getUuid();
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
    const plan = buildNumberingPlan_(candidate, newBerkas);

    const blob = preUploadedFileId ? null : form.pdfFile;
    if (preUploadedFileId) {
      createdFile = DriveApp.getFileById(preUploadedFileId);
      const uploadedMime = String(createdFile.getMimeType() || '').toLowerCase();
      if (uploadedMime !== 'application/pdf') throw new Error('File hasil upload bukan PDF.');
    } else if (!allowMissingPdf) {
      if (!blob || typeof blob.getBytes !== 'function') throw new Error('PDF utama wajib dipilih.');
      const originalName = String(blob.getName() || 'dokumen.pdf');
      const contentType = String(blob.getContentType() || '').toLowerCase();
      if (!originalName.toLowerCase().endsWith('.pdf') || (contentType && !['application/pdf','application/octet-stream'].includes(contentType))) {
        throw new Error('Berkas utama harus berformat PDF.');
      }
      if (blob.getBytes().length >= ITEM_UPLOAD_MAX_SIZE_) throw new Error('Ukuran PDF harus kurang dari 100 MB.');
    }

    const targetPlan = plan.parentPlans.find(parentPlan => parentPlan.record.BERKAS_ID === candidate.berkasId);
    const targetItem = targetPlan.items.find(item => item.ITEM_ID === candidate.itemId);
    const parent = targetPlan.record;
    const timestamp = nowIso_();
    const user = getCurrentUser_();
    if (mode === 'NEW') {
      const settings = readSettings_();
      const archiveRoot = DriveApp.getFolderById(requireValue_(settings.ARCHIVE_FOLDER_ID, 'ARCHIVE_FOLDER_ID pada SETTINGS'));
      createdFolder = archiveRoot.createFolder(targetPlan.newNumber + '_' + cleanFileName_(newBerkas.title));
      newParentRow = getSheetOrThrow_(APP_CONFIG.SHEETS.BERKAS).getLastRow() + 1;
      appendObject_(APP_CONFIG.SHEETS.BERKAS, {
        BERKAS_ID: newBerkas.berkasId, JUDUL_BERKAS: newBerkas.title,
        KATEGORI_NASKAH_ID: '', POLA_PEMBERKASAN: '',
        KLASIFIKASI_ID: newBerkas.classificationId,
        KODE_KLASIFIKASI_SNAPSHOT: newBerkas.classificationCode,
        URAIAN_KLASIFIKASI_SNAPSHOT: newBerkas.classificationDescription,
        RETENSI_AKTIF_NILAI: newBerkas.activeRetentionValue,
        RETENSI_AKTIF_SATUAN: newBerkas.activeRetentionUnit,
        RETENSI_INAKTIF_NILAI: newBerkas.inactiveRetentionValue,
        RETENSI_INAKTIF_SATUAN: newBerkas.inactiveRetentionUnit,
        NASIB_AKHIR: newBerkas.finalDisposition,
        KLASIFIKASI_KEAMANAN_AKSES: candidate.securityClassification,
        STATUS_RETENSI: APP_CONFIG.STATUS.RETENSI_MENUNGGU_ITEM,
        NO_FILLING_KABINET: newBerkas.filingCabinet, NO_LACI: newBerkas.drawer,
        DRIVE_FOLDER_ID: createdFolder.getId(), DRIVE_FOLDER_URL: createdFolder.getUrl(),
        STATUS_PEMINJAMAN: APP_CONFIG.STATUS.PEMINJAMAN_TERSEDIA,
        STATUS_BERKAS: APP_CONFIG.STATUS.BERKAS_DRAFT, CATATAN: newBerkas.notes,
        STATUS_VERIFIKASI_METADATA: 'TERVERIFIKASI',
        METADATA_SCHEMA_VERSION: CF_METADATA_SCHEMA_VERSION_,
        CREATED_AT: newBerkas.createdAt, CREATED_BY: user, UPDATED_AT: timestamp, UPDATED_BY: user,
        VERSION: 1, IS_DELETED: false
      });
      parent._rowNumber = newParentRow;
      parent.DRIVE_FOLDER_ID = createdFolder.getId();
      parent.DRIVE_FOLDER_URL = createdFolder.getUrl();
      parent.VERSION = 1;
    }
    const folder = mode === 'NEW' ? createdFolder : DriveApp.getFolderById(parent.DRIVE_FOLDER_ID);
    const cleanDescription = cleanFileName_(candidate.description);
    const fileName = targetPlan.newNumber + '_' + targetItem._newNumber + '_' + cleanDescription + '.pdf';
    folder.setName(targetPlan.newNumber + '_' + cleanFileName_(parent.JUDUL_BERKAS));
    if (createdFile) createdFile.moveTo(folder).setName(fileName);
    else if (blob) createdFile = folder.createFile(blob).setName(fileName);

    const itemSheet = getSheetOrThrow_(APP_CONFIG.SHEETS.ITEM);
    const newRowNumber = itemSheet.getLastRow() + 1;
    newItemRow = newRowNumber;
    appendObject_(APP_CONFIG.SHEETS.ITEM, {
      ITEM_ID: candidate.itemId,
      BERKAS_ID: candidate.berkasId,
      NO_ITEM_DEFINITIF: targetItem._newNumber,
      JENIS_NASKAH_ID: '',
      SUBJENIS_NASKAH_ID: '',
      KELENGKAPAN: '',
      NO_SURAT_UTAMA: candidate.primaryLetterNumber,
      NO_SURAT_ALTERNATIF: candidate.alternateLetterNumber,
      NO_SURAT_DISPLAY: displayLetterNumber_(candidate.primaryLetterNumber, candidate.alternateLetterNumber),
      TANGGAL_NASKAH: parseLocalDate_(candidate.documentDate, 'Tanggal naskah'),
      TAHUN_KURUN_WAKTU: Number(candidate.documentDate.substring(0, 4)),
      URAIAN_LENGKAP: candidate.description,
      URAIAN_NAMA_FILE: cleanDescription,
      JUMLAH_HALAMAN: candidate.pageCount,
      TINGKAT_PERKEMBANGAN: candidate.developmentLevel,
      KLASIFIKASI_KEAMANAN_AKSES: candidate.securityClassification,
      KODE_KLASIFIKASI_SNAPSHOT: parent.KODE_KLASIFIKASI_SNAPSHOT,
      NO_BERKAS_SNAPSHOT: targetPlan.newNumber,
      NAMA_FILE: fileName,
      DRIVE_FILE_ID: createdFile ? createdFile.getId() : '',
      DRIVE_FILE_URL: createdFile ? createdFile.getUrl() : '',
      MIME_TYPE: createdFile ? 'application/pdf' : '',
      LAMPIRAN_JSON: '[]',
      STATUS_FILE: createdFile ? 'TERSEDIA' : 'BELUM DIUNGGAH',
      STATUS_PEMINJAMAN: 'TERSEDIA',
      SORT_NO_SURAT_NORMALIZED: normalizedLetterNumber_(candidate.primaryLetterNumber, candidate.alternateLetterNumber),
      SORT_CREATED_AT: candidate.previewCreatedAt,
      CATATAN: candidate.notes,
      CREATED_AT: timestamp,
      CREATED_BY: user,
      UPDATED_AT: timestamp,
      UPDATED_BY: user,
      VERSION: 1,
      IS_DELETED: false,
      ARSIP_ID: candidate.itemId,
      SUMBER_REGISTRASI: 'INPUT_MANUAL',
      PENERIMAAN_ID: '',
      PENERIMAAN_ITEM_ID: '',
      NOMOR_TANDA_TERIMA_SNAPSHOT: '',
      KONDISI_FISIK: '',
      MEDIA_SUMBER: 'TEKSTUAL',
      STATUS_BENTUK_DIGITAL: createdFile ? 'ALIH MEDIA' : 'TIDAK ADA',
      STATUS_VERIFIKASI_METADATA: 'TERVERIFIKASI',
      METADATA_SCHEMA_VERSION: CF_METADATA_SCHEMA_VERSION_
    });
    targetItem._rowNumber = newRowNumber;
    targetItem.DRIVE_FILE_ID = createdFile ? createdFile.getId() : '';
    targetItem.URAIAN_NAMA_FILE = cleanDescription;
    targetItem.URAIAN_LENGKAP = candidate.description;
    targetItem.NAMA_FILE = fileName;
    targetItem.NO_ITEM_DEFINITIF = targetItem._newNumber;
    targetItem.NO_BERKAS_SNAPSHOT = targetPlan.newNumber;
    targetItem.VERSION = 1;

    applyNumberingPlan_(plan, timestamp, user);
    try { rebuildReports_(); }
    catch (reportError) { audit_('REPORT_WARNING', 'LAPORAN', 'ITEM', candidate.itemId, 'Item tersimpan tetapi laporan gagal disegarkan', reportError.message, 'WARNING'); }
    audit_('CREATE', 'ITEM', 'ITEM', candidate.itemId, 'Menyimpan item arsip dan menerapkan penomoran definitif', createdFile ? 'PDF alih media tersedia' : 'PDF alih media belum diunggah', 'SUCCESS');
    return {
      ok: true,
      itemId: candidate.itemId,
      berkasId: candidate.berkasId,
      fileUrl: createdFile ? createdFile.getUrl() : '',
      fileStatus: createdFile ? 'TERSEDIA' : 'BELUM DIUNGGAH',
      durationMs: Date.now() - startedAt,
      message: createdFile
        ? 'Item berhasil disimpan dan berkas tetap terpilih untuk input berikutnya.'
        : 'Metadata item berhasil disimpan tanpa PDF. Alih media dapat dilengkapi kemudian.'
    };
  } catch (error) {
    if (createdFile) {
      try { createdFile.setTrashed(true); } catch (cleanupError) {}
    }
    if (newItemRow) {
      try { updateObjectAtRow_(APP_CONFIG.SHEETS.ITEM, newItemRow, {IS_DELETED: true, STATUS_FILE: 'GAGAL', CATATAN: 'Rollback: ' + error.message}); } catch (cleanupError) {}
    }
    if (newParentRow) {
      try { updateObjectAtRow_(APP_CONFIG.SHEETS.BERKAS, newParentRow, {IS_DELETED: true, STATUS_BERKAS: 'GAGAL', CATATAN: 'Rollback: ' + error.message}); } catch (cleanupError) {}
    }
    if (createdFolder) {
      try { createdFolder.setTrashed(true); } catch (cleanupError) {}
    }
    audit_('CREATE', 'ITEM', 'ITEM', form && form.previewItemId || '', 'Gagal menyimpan item arsip', error.message, 'FAILED');
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function applyNumberingPlan_(plan, timestamp, user) {
  const operations = buildNumberingOperations_(plan, timestamp, user);
  updateObjectsAtRows_(
    APP_CONFIG.SHEETS.BERKAS, operations.parentUpdates);
  updateObjectsAtRows_(
    APP_CONFIG.SHEETS.ITEM, operations.itemUpdates);
  const driveWarnings = executeNumberingDriveRenames_(
    operations.driveRenames);
  appendObjects_(APP_CONFIG.SHEETS.HISTORY, operations.histories);
  if (driveWarnings.length) {
    audit_(
      'RENAME_WARNING',
      'PENOMORAN',
      'BATCH',
      '',
      'Sebagian nama Drive gagal diperbarui',
      driveWarnings.join(' | '),
      'WARNING'
    );
  }
  return {
    histories: operations.histories,
    parentUpdates: operations.parentUpdates,
    itemUpdates: operations.itemUpdates,
    driveWarnings: driveWarnings
  };
}

function buildNumberingOperations_(plan, timestamp, user) {
  const histories = [];
  const parentUpdates = [];
  const itemUpdates = [];
  const driveRenames = [];
  const affectedBerkasIds = plan.affectedBerkasIds ||
    (plan.candidate ? [plan.candidate.berkasId] : []);
  plan.parentPlans.forEach(parentPlan => {
    const parent = parentPlan.record;
    const oldParentNumber = parent.NO_BERKAS_DEFINITIF || '';
    const parentNumberChanged = String(oldParentNumber) !== String(parentPlan.newNumber);
    const isTargetParent = affectedBerkasIds.indexOf(parent.BERKAS_ID) !== -1;
    if (!isTargetParent && !parentNumberChanged) return;
    const activeLimit = addDuration_(parentPlan.latest, parent.RETENSI_AKTIF_NILAI, parent.RETENSI_AKTIF_SATUAN);
    const inactiveLimit = addDuration_(activeLimit, parent.RETENSI_INAKTIF_NILAI, parent.RETENSI_INAKTIF_SATUAN);
    const years = parentPlan.items.map(item => Number(dateKey_(item.TANGGAL_NASKAH).substring(0, 4)));
    const minYear = Math.min.apply(null, years);
    const maxYear = Math.max.apply(null, years);
    const securityClassification = mostRestrictiveArchiveSecurity_(
      parentPlan.items.map(item =>
      item.KLASIFIKASI_KEAMANAN_AKSES ||
      (item._candidatePayload &&
        item._candidatePayload.securityClassification)
    ));
    parentUpdates.push({rowNumber: parent._rowNumber, changes: {
      NO_BERKAS_DEFINITIF: parentPlan.newNumber,
      TGL_ITEM_AWAL: parseLocalDate_(parentPlan.earliest, 'Tanggal item awal'),
      TGL_ITEM_AKHIR: parseLocalDate_(parentPlan.latest, 'Tanggal item akhir'),
      TGL_URUT_BERKAS: parseLocalDate_(parentPlan.earliest, 'Tanggal urut'),
      TGL_ACUAN_RETENSI: parseLocalDate_(parentPlan.latest, 'Tanggal retensi'),
      BATAS_AKTIF: activeLimit,
      BATAS_INAKTIF: inactiveLimit,
      STATUS_RETENSI: retentionStatus_(activeLimit),
      JUMLAH_ITEM: parentPlan.items.length,
      TOTAL_HALAMAN: parentPlan.items.reduce((sum, item) =>
        sum + Number(
          item.JUMLAH_HALAMAN ||
          (item._candidatePayload && item._candidatePayload.pageCount) ||
          0
        ), 0),
      KURUN_WAKTU: minYear === maxYear ? String(minYear) : minYear + '–' + maxYear,
      KLASIFIKASI_KEAMANAN_AKSES: securityClassification,
      NO_FOLDER: parentPlan.newNumber,
      STATUS_BERKAS: 'AKTIF',
      UPDATED_AT: timestamp,
      UPDATED_BY: user,
      VERSION: Number(parent.VERSION || 0) + 1
    }});
    if (parentNumberChanged) {
      histories.push(historyRecord_('BERKAS', parent.BERKAS_ID, parent.BERKAS_ID, oldParentNumber, parentPlan.newNumber, parent.JUDUL_BERKAS, parent.JUDUL_BERKAS, timestamp, user, plan.historyReason));
    }
    if (parentNumberChanged && !parent._virtual) {
      driveRenames.push({type: 'FOLDER', id: parent.DRIVE_FOLDER_ID, name: parentPlan.newNumber + '_' + cleanFileName_(parent.JUDUL_BERKAS), objectId: parent.BERKAS_ID});
    }

    parentPlan.items.forEach(item => {
      const rowNumber = item._rowNumber;
      const oldItemNumber = item.NO_ITEM_DEFINITIF || '';
      const descriptionForFile = item.URAIAN_NAMA_FILE ||
        cleanFileName_(
          item.URAIAN_LENGKAP ||
          (item._candidatePayload && item._candidatePayload.description) ||
          'Tanpa Judul'
        );
      const newName = parentPlan.newNumber + '_' + item._newNumber + '_' + descriptionForFile + '.pdf';
      const itemNumberChanged = String(oldItemNumber) !== String(item._newNumber);
      const parentSnapshotChanged = String(item.NO_BERKAS_SNAPSHOT || '') !== String(parentPlan.newNumber);
      const fileNameChanged = String(item.NAMA_FILE || '') !== newName;
      if (!itemNumberChanged && !parentSnapshotChanged && !fileNameChanged) return;
      if (rowNumber) {
        itemUpdates.push({rowNumber: rowNumber, changes: {
          NO_ITEM_DEFINITIF: item._newNumber,
          NO_BERKAS_SNAPSHOT: parentPlan.newNumber,
          NAMA_FILE: newName,
          UPDATED_AT: timestamp,
          UPDATED_BY: user,
          VERSION: Number(item.VERSION || 0) + 1
        }});
      }
      if (itemNumberChanged) {
        histories.push(historyRecord_('ITEM', item.ITEM_ID, item.BERKAS_ID, oldItemNumber, item._newNumber, item.NAMA_FILE || '', newName, timestamp, user, plan.historyReason));
      }
      if (item.DRIVE_FILE_ID && fileNameChanged) {
        driveRenames.push({type: 'FILE', id: item.DRIVE_FILE_ID, name: newName, objectId: item.ITEM_ID});
      }
    });
  });
  return {
    histories: histories,
    parentUpdates: parentUpdates,
    itemUpdates: itemUpdates,
    driveRenames: driveRenames
  };
}

function executeNumberingDriveRenames_(driveRenames) {
  const renames = driveRenames || [];
  const driveWarnings = [];
  if (!renames.length) return driveWarnings;
  // Penomoran ulang kronologis bisa memicu banyak folder/file Drive yang perlu
  // di-rename sekaligus (setiap berkas sesudah titik perubahan ikut bergeser
  // nomornya). Untuk >1 rename, coba kirim sebagai satu batch HTTP ke Drive API
  // v3 dulu (jauh lebih cepat daripada memanggil DriveApp per objek satu per
  // satu). Bila batch gagal dengan cara apa pun (kuota, jaringan, format
  // respons tak terduga), SEMUA rename yang belum terkonfirmasi otomatis
  // dikerjakan ulang lewat jalur DriveApp lama di bawah — jadi hasil akhirnya
  // tidak pernah lebih buruk dari sebelum optimisasi ini, hanya berpotensi
  // lebih cepat.
  const pending = renames.length > 1 ? applyDriveRenamesViaBatchApi_(renames) : renames;
  pending.forEach(rename => {
    try {
      if (rename.type === 'FOLDER') DriveApp.getFolderById(rename.id).setName(rename.name);
      else DriveApp.getFileById(rename.id).setName(rename.name);
    } catch (error) {
      driveWarnings.push(rename.objectId + ': ' + error.message);
    }
  });
  return driveWarnings;
}

var DRIVE_BATCH_CHUNK_SIZE_ = 90;
var DRIVE_BATCH_ENDPOINT_ = 'https://www.googleapis.com/batch/drive/v3';

// Mengirim rename folder/file Drive sebagai batch HTTP (Drive API v3),
// dipecah per DRIVE_BATCH_CHUNK_SIZE_ agar tetap di bawah batas jumlah
// sub-request per batch. Mengembalikan daftar rename yang BELUM terkonfirmasi
// berhasil (baik karena batch itu sendiri gagal, atau karena satu-dua item di
// dalamnya ditolak Drive) — item-item ini lalu dikerjakan ulang lewat DriveApp
// biasa oleh pemanggil, sehingga rename yang idempotent (nama tujuan sama)
// aman diulang tanpa efek samping.
function applyDriveRenamesViaBatchApi_(renames) {
  const pending = [];
  for (let start = 0; start < renames.length; start += DRIVE_BATCH_CHUNK_SIZE_) {
    const chunk = renames.slice(start, start + DRIVE_BATCH_CHUNK_SIZE_);
    let confirmed = null;
    try {
      confirmed = sendDriveRenameBatch_(chunk);
    } catch (error) {
      confirmed = null;
    }
    if (!confirmed) {
      chunk.forEach(rename => pending.push(rename));
      continue;
    }
    chunk.forEach((rename, index) => {
      if (!confirmed[index]) pending.push(rename);
    });
  }
  return pending;
}

// Mengirim satu batch (maks DRIVE_BATCH_CHUNK_SIZE_ item) sebagai satu
// request multipart/mixed ke endpoint batch Drive API v3. Mengembalikan array
// boolean sepanjang chunk.length (true = rename item itu terkonfirmasi
// berhasil), atau null bila responsnya tidak bisa dipastikan (network error,
// status bukan 200, atau format multipart tak terduga) sehingga pemanggil
// tahu harus menganggap SEMUA item di chunk ini belum berhasil.
function sendDriveRenameBatch_(chunk) {
  const boundary = 'srikandi_batch_' + Utilities.getUuid().replace(/-/g, '');
  const parts = chunk.map((rename, index) => {
    const body = JSON.stringify({name: rename.name});
    return '--' + boundary + '\r\n' +
      'Content-Type: application/http\r\n' +
      'Content-ID: <rename-' + index + '>\r\n\r\n' +
      'PATCH /drive/v3/files/' + encodeURIComponent(rename.id) + '?fields=id HTTP/1.1\r\n' +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      body + '\r\n';
  });
  const payload = parts.join('') + '--' + boundary + '--';
  const response = UrlFetchApp.fetch(DRIVE_BATCH_ENDPOINT_, {
    method: 'post',
    contentType: 'multipart/mixed; boundary=' + boundary,
    payload: payload,
    headers: {Authorization: 'Bearer ' + ScriptApp.getOAuthToken()},
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) return null;
  const headers = response.getHeaders() || {};
  const contentType = headers['Content-Type'] || headers['content-type'] || '';
  return parseDriveBatchResponse_(contentType, response.getContentText(), chunk.length);
}

function parseDriveBatchResponse_(contentType, text, expectedCount) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType || ''));
  const boundary = boundaryMatch ? (boundaryMatch[1] || boundaryMatch[2]) : '';
  if (!boundary) return null;
  const results = [];
  String(text || '').split('--' + boundary).forEach(part => {
    const trimmed = part.trim();
    if (!trimmed || trimmed === '--') return;
    const statusMatch = /HTTP\/1\.[01]\s+(\d{3})/.exec(trimmed);
    results.push(Boolean(statusMatch) && statusMatch[1].charAt(0) === '2');
  });
  return results.length === expectedCount ? results : null;
}

function historyRecord_(type, objectId, berkasId, oldNumber, newNumber, oldName, newName, timestamp, user, reason) {
  return {
    RIWAYAT_ID: 'HIS-' + Utilities.getUuid(), JENIS_OBJEK: type, OBJEK_ID: objectId, BERKAS_ID: berkasId,
    NOMOR_LAMA: oldNumber, NOMOR_BARU: newNumber, NAMA_LAMA: oldName, NAMA_BARU: newName,
    ALASAN: reason || 'Penomoran ulang kronologis setelah penambahan item', BATCH_RENUMBER_ID: 'REN-' + timestamp,
    DIKONFIRMASI_OLEH: user, DIKONFIRMASI_AT: timestamp, CREATED_AT: timestamp, CREATED_BY: user
  };
}
