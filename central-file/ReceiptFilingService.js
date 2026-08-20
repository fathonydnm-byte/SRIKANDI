var RECEIPT_FILING_FAST_COLUMN_LIMIT_ = 'AZ';
var RECEIPT_FILING_DB_ITEM_HEADERS_ = [
  'ARSIP_ID',
  'SUMBER_REGISTRASI',
  'PENERIMAAN_ID',
  'PENERIMAAN_ITEM_ID',
  'NOMOR_TANDA_TERIMA_SNAPSHOT',
  'KONDISI_FISIK',
  'KLASIFIKASI_KEAMANAN_AKSES'
];

function ensureReceiptFilingSchema_() {
  ensureReceiptModule_();
  ensureColumnsOnSheet_(
    APP_CONFIG.SHEETS.ITEM,
    RECEIPT_FILING_DB_ITEM_HEADERS_,
    [190, 170, 190, 190, 170, 150, 190]
  );
  return {
    ok: true,
    receiptItemHeaders: RECEIPT_ITEM_HEADERS_.slice(),
    dbItemHeaders: RECEIPT_FILING_DB_ITEM_HEADERS_.slice()
  };
}

function ensureColumnsOnSheet_(sheetName, headers, widths) {
  const sheet = getSheetOrThrow_(sheetName);
  const existing = getHeaders_(sheet);
  const missing = (headers || []).filter(header =>
    existing.indexOf(header) === -1);
  if (!missing.length) return sheet;
  if (sheet.getMaxColumns() < existing.length + missing.length) {
    sheet.insertColumnsAfter(
      sheet.getMaxColumns(),
      existing.length + missing.length - sheet.getMaxColumns()
    );
  }
  const startColumn = existing.length + 1;
  sheet.getRange(1, startColumn, 1, missing.length).setValues([missing]);
  sheet.getRange(1, startColumn, 1, missing.length)
    .setFontWeight('bold')
    .setBackground('#143b5d')
    .setFontColor('#ffffff')
    .setWrap(true);
  missing.forEach((header, index) => {
    const sourceIndex = headers.indexOf(header);
    if (sourceIndex !== -1 && widths && widths[sourceIndex]) {
      sheet.setColumnWidth(startColumn + index, widths[sourceIndex]);
    }
  });
  headerCache_ = {};
  return sheet;
}

function backfillReceiptFilingSchema_() {
  ensureReceiptFilingSchema_();
  const receipts = readObjects_(RECEIPT_SHEET_);
  const receiptById = {};
  receipts.forEach(row => receiptById[String(row.PENERIMAAN_ID || '')] = row);
  const dbItems = readObjects_(APP_CONFIG.SHEETS.ITEM);
  const activeDbByReceiptItem = {};
  dbItems.forEach(row => {
    if (!isDeleted_(row) && row.PENERIMAAN_ITEM_ID) {
      activeDbByReceiptItem[String(row.PENERIMAAN_ITEM_ID)] = row;
    }
  });
  const timestamp = nowIso_();
  const user = getCurrentUser_();
  const receiptUpdates = [];
  readObjects_(RECEIPT_ITEM_SHEET_).forEach(row => {
    if (receiptBoolean_(row.IS_DELETED)) return;
    const changes = {};
    if (!cleanText_(row.ARSIP_ID, 90)) {
      changes.ARSIP_ID = 'ARS-' + Utilities.getUuid();
    }
    const parent = receiptById[String(row.PENERIMAAN_ID || '')];
    const activeDbItem =
      activeDbByReceiptItem[String(row.PENERIMAAN_ITEM_ID || '')];
    let status;
    if (parent && String(parent.STATUS || '').toUpperCase() ===
        RECEIPT_STATUS_CANCELLED_) {
      status = RECEIPT_FILING_CANCELLED_;
    } else if (activeDbItem) {
      status = RECEIPT_FILING_FILED_;
      changes.BERKAS_ID_TUJUAN = activeDbItem.BERKAS_ID || '';
      changes.ITEM_ID_DEFINITIF = activeDbItem.ITEM_ID || '';
      changes.NO_BERKAS_DEFINITIF_SNAPSHOT =
        activeDbItem.NO_BERKAS_SNAPSHOT || '';
      changes.NO_ITEM_DEFINITIF_SNAPSHOT =
        activeDbItem.NO_ITEM_DEFINITIF || '';
    } else {
      status = receiptItemMetadataComplete_(
        Object.assign({}, row, changes))
        ? RECEIPT_FILING_PENDING_
        : RECEIPT_FILING_INCOMPLETE_;
    }
    if (String(row.STATUS_PEMBERKASAN || '').toUpperCase() !== status) {
      changes.STATUS_PEMBERKASAN = status;
    }
    if (Object.keys(changes).length) {
      changes.UPDATED_AT = timestamp;
      changes.UPDATED_BY = user;
      receiptUpdates.push({
        rowNumber: row._rowNumber,
        changes: changes
      });
    }
  });
  updateObjectsAtRows_(RECEIPT_ITEM_SHEET_, receiptUpdates);

  const dbUpdates = [];
  dbItems.forEach(row => {
    const changes = {};
    if (!cleanText_(row.ARSIP_ID, 90)) {
      changes.ARSIP_ID = String(row.ITEM_ID || '');
    }
    if (!cleanText_(row.SUMBER_REGISTRASI, 50)) {
      changes.SUMBER_REGISTRASI = row.PENERIMAAN_ITEM_ID
        ? 'PENERIMAAN_ARSIP' : 'INPUT_MANUAL';
    }
    if (Object.keys(changes).length) {
      changes.UPDATED_AT = timestamp;
      changes.UPDATED_BY = user;
      dbUpdates.push({rowNumber: row._rowNumber, changes: changes});
    }
  });
  updateObjectsAtRows_(APP_CONFIG.SHEETS.ITEM, dbUpdates);
  CacheService.getScriptCache().remove('RECEIPT_MODULE_READY_V1');
  return {
    ok: true,
    receiptItemsUpdated: receiptUpdates.length,
    dbItemsUpdated: dbUpdates.length
  };
}

function assertReceiptFilingReady_() {
  assertReceiptModuleReady_();
  const receiptHeaders = getHeaders_(getSheetOrThrow_(RECEIPT_ITEM_SHEET_));
  const dbHeaders = getHeaders_(getSheetOrThrow_(APP_CONFIG.SHEETS.ITEM));
  const missing = [];
  RECEIPT_ITEM_HEADERS_.forEach(header => {
    if (receiptHeaders.indexOf(header) === -1) {
      missing.push(RECEIPT_ITEM_SHEET_ + '.' + header);
    }
  });
  RECEIPT_FILING_DB_ITEM_HEADERS_.forEach(header => {
    if (dbHeaders.indexOf(header) === -1) {
      missing.push(APP_CONFIG.SHEETS.ITEM + '.' + header);
    }
  });
  if (missing.length) {
    throw new Error(
      'Integrasi Penerimaan–Pemberkasan belum dipasang. Jalankan ' +
      'Arsip Aktif → Instalasi & Reliability. Kolom yang belum tersedia: ' +
      missing.slice(0, 8).join(', ') + (missing.length > 8 ? ', …' : '')
    );
  }
  return true;
}

function getReceiptFilingOptions_() {
  assertReceiptFilingReady_();
  const receipts = readObjects_(RECEIPT_SHEET_);
  const receiptById = {};
  receipts.forEach(row => receiptById[String(row.PENERIMAAN_ID || '')] = row);
  const allItems = readObjects_(RECEIPT_ITEM_SHEET_)
    .filter(row => !receiptBoolean_(row.IS_DELETED));
  let filed = 0;
  let pending = 0;
  let incomplete = 0;
  const queue = [];
  allItems.forEach(row => {
    const receipt = receiptById[String(row.PENERIMAAN_ID || '')];
    if (!receipt || String(receipt.STATUS || '').toUpperCase() !==
        RECEIPT_STATUS_ACTIVE_) return;
    const status = normalizeReceiptFilingStatus_(row);
    if (status === RECEIPT_FILING_FILED_) {
      filed++;
      return;
    }
    if (status === RECEIPT_FILING_INCOMPLETE_) incomplete++;
    else if (status === RECEIPT_FILING_PENDING_) pending++;
    else return;
    queue.push(receiptFilingQueuePresentation_(receipt, row, status));
  });
  queue.sort((a, b) => {
    const receiptCompare = String(a.receivedAt || '')
      .localeCompare(String(b.receivedAt || ''));
    return receiptCompare ||
      naturalCompare_(a.receiptNumber, b.receiptNumber) ||
      Number(a.receiptItemNumber || 0) - Number(b.receiptItemNumber || 0);
  });
  const limit = 500;
  return {
    ok: true,
    items: queue.slice(0, limit),
    totalQueue: queue.length,
    truncated: queue.length > limit,
    summary: {
      pending: pending,
      incomplete: incomplete,
      filed: filed
    },
    maxBatchSize: 100
  };
}

function receiptFilingQueuePresentation_(receipt, item, status) {
  return {
    id: String(item.PENERIMAAN_ITEM_ID || ''),
    archiveId: String(item.ARSIP_ID || ''),
    receiptId: String(receipt.PENERIMAAN_ID || ''),
    receiptNumber: String(receipt.NOMOR_TANDA_TERIMA || ''),
    receiptItemNumber: Number(item.NO_ITEM || 0),
    receivedAt: String(receipt.TANGGAL_WAKTU_TERIMA || ''),
    senderName: cleanText_(receipt.NAMA_PENYERAH_SNAPSHOT, 250),
    senderUnit: cleanText_(receipt.UNIT_PENYERAH_SNAPSHOT, 250),
    primaryLetterNumber: cleanText_(item.NO_SURAT_UTAMA, 250),
    alternateLetterNumber: cleanText_(item.NO_SURAT_ALTERNATIF, 250),
    documentDate: item.TANGGAL_NASKAH ? dateKey_(item.TANGGAL_NASKAH) : '',
    description: cleanText_(item.URAIAN_INFORMASI, 2000),
    pageCount: Number(item.JUMLAH_HALAMAN || 0),
    developmentLevel: String(item.TINGKAT_PERKEMBANGAN || '').toUpperCase(),
    condition: String(item.KONDISI || '').toUpperCase(),
    securityClassification: centralFileMetadataNormalizeSecurity_(
      item.KLASIFIKASI_KEAMANAN_AKSES),
    notes: cleanText_(item.CATATAN_ITEM, 1000),
    status: status,
    selectable: status === RECEIPT_FILING_PENDING_ &&
      receiptItemMetadataComplete_(item)
  };
}

function commitReceiptFiling_(form) {
  assertReceiptFilingReady_();
  form = form || {};
  const startedAt = Date.now();
  const lock = LockService.getScriptLock();
  const lockStartedAt = Date.now();
  lock.waitLock(30000);
  const lockWaitMs = Date.now() - lockStartedAt;
  let createdFolder = null;
  let committed = false;
  let filingRequestId = '';
  try {
    if (!canUseReceiptSheetsApiFastPath_()) {
      throw new Error(
        'Layanan batch Google Sheets belum tersedia. Jalankan apiHealthCheck ' +
        'dan pastikan Sheets API berstatus OK.'
      );
    }
    const requestId = normalizeReceiptFilingRequestId_(form.requestId);
    filingRequestId = requestId;
    const snapshot = readReceiptFilingFastSnapshot_();
    const selectedIds = normalizeReceiptFilingItemIds_(
      form.receiptItemIds);
    const recovered = recoverReceiptFilingFromRows_(
      requestId, selectedIds, snapshot.receiptItems);
    if (recovered) {
      recovered.durationMs = Date.now() - startedAt;
      recovered.performance = {
        path: 'SHEETS_API_BATCH',
        lockWaitMs: lockWaitMs,
        recovered: true
      };
      return recovered;
    }

    const timestamp = nowIso_();
    const user = getCurrentUser_();
    const context = normalizeReceiptFilingContext_(
      form, selectedIds, snapshot, timestamp);
    const plan = buildBatchNumberingPlan_(
      context.candidates,
      context.newBerkas,
      snapshot.berkas,
      snapshot.dbItems
    );
    plan.historyReason =
      'Penomoran ulang kronologis setelah pemberkasan item penerimaan';
    const operations = buildNumberingOperations_(plan, timestamp, user);
    const targetPlan = plan.parentPlans.find(parentPlan =>
      String(parentPlan.record.BERKAS_ID) === String(context.berkasId));
    if (!targetPlan) throw new Error('Rencana penomoran berkas tujuan tidak ditemukan.');

    let newParentRecord = null;
    if (context.newBerkas) {
      const settings = readSettings_();
      const archiveRoot = DriveApp.getFolderById(requireValue_(
        settings.ARCHIVE_FOLDER_ID, 'ARCHIVE_FOLDER_ID pada SETTINGS'));
      createdFolder = archiveRoot.createFolder(
        targetPlan.newNumber + '_' +
        cleanFileName_(context.newBerkas.title)
      );
      newParentRecord = buildReceiptFilingParentRecord_(
        context.newBerkas,
        targetPlan,
        createdFolder,
        operations,
        timestamp,
        user
      );
    }

    const dbItemRecords = context.selected.map((selection, index) =>
      buildReceiptFiledItemRecord_(
        selection,
        context.candidates[index],
        targetPlan,
        snapshot.receiptsById[selection.PENERIMAAN_ID],
        timestamp,
        user
      )
    );
    const sourceUpdates = context.selected.map((selection, index) => {
      const dbItem = dbItemRecords[index];
      return {
        rowNumber: selection._rowNumber,
        changes: {
          STATUS_PEMBERKASAN: RECEIPT_FILING_FILED_,
          BERKAS_ID_TUJUAN: context.berkasId,
          ITEM_ID_DEFINITIF: dbItem.ITEM_ID,
          NO_BERKAS_DEFINITIF_SNAPSHOT: dbItem.NO_BERKAS_SNAPSHOT,
          NO_ITEM_DEFINITIF_SNAPSHOT: dbItem.NO_ITEM_DEFINITIF,
          DIBERKASKAN_AT: timestamp,
          DIBERKASKAN_BY: user,
          PEMBERKASAN_REQUEST_ID: requestId,
          UPDATED_AT: timestamp,
          UPDATED_BY: user
        }
      };
    });

    const writeData = [];
    if (newParentRecord) {
      writeData.push(filingFastRowsUpdate_(
        snapshot.berkasTable,
        snapshot.berkasTable.nextRow,
        [newParentRecord]
      ));
    }
    writeData.push(filingFastRowsUpdate_(
      snapshot.dbItemTable,
      snapshot.dbItemTable.nextRow,
      dbItemRecords
    ));
    filingFastRowChanges_(
      snapshot.berkasTable,
      operations.parentUpdates.filter(update => Number(update.rowNumber) >= 2)
    ).forEach(update => writeData.push(update));
    filingFastRowChanges_(
      snapshot.dbItemTable,
      operations.itemUpdates.filter(update => Number(update.rowNumber) >= 2)
    ).forEach(update => writeData.push(update));
    filingFastRowChanges_(
      snapshot.receiptItemTable,
      sourceUpdates
    ).forEach(update => writeData.push(update));
    if (operations.histories.length) {
      writeData.push(filingFastRowsUpdate_(
        snapshot.historyTable,
        snapshot.historyTable.nextRow,
        operations.histories
      ));
    }
    writeData.push(filingFastRowsUpdate_(
      snapshot.auditTable,
      snapshot.auditTable.nextRow,
      [buildReceiptFilingAuditRecord_(
        requestId,
        context,
        targetPlan,
        timestamp,
        user
      )]
    ));

    receiptFastBatchUpdate_({
      valueInputOption: 'RAW',
      includeValuesInResponse: false,
      data: writeData
    });
    committed = true;

    const warnings = executeNumberingDriveRenames_(
      operations.driveRenames);
    if (warnings.length) {
      audit_(
        'WARNING',
        'PEMBERKASAN_PENERIMAAN',
        'BATCH',
        requestId,
        'Pemberkasan selesai dengan peringatan',
        warnings.join(' | '),
        'WARNING'
      );
    }
    return {
      ok: true,
      requestId: requestId,
      berkasId: context.berkasId,
      berkasNumber: targetPlan.newNumber,
      berkasTitle: targetPlan.record.JUDUL_BERKAS,
      itemCount: dbItemRecords.length,
      totalPages: dbItemRecords.reduce((sum, item) =>
        sum + Number(item.JUMLAH_HALAMAN || 0), 0),
      renumberedItemCount: plan.itemChanges.filter(change =>
        !change.isNew).length,
      renumberedBerkasCount: plan.parentChanges.filter(change =>
        String(change.id) !== String(context.berkasId) ||
        String(change.oldNumber) !== '–').length,
      items: dbItemRecords.map(item => ({
        receiptItemId: item.PENERIMAAN_ITEM_ID,
        itemId: item.ITEM_ID,
        berkasNumber: item.NO_BERKAS_SNAPSHOT,
        itemNumber: item.NO_ITEM_DEFINITIF,
        description: item.URAIAN_LENGKAP
      })),
      warnings: warnings,
      reportsPending: true,
      durationMs: Date.now() - startedAt,
      performance: {
        path: 'SHEETS_API_BATCH',
        lockWaitMs: lockWaitMs
      },
      message: dbItemRecords.length +
        ' item berhasil diberkaskan ke Berkas ' +
        targetPlan.newNumber + '.'
    };
  } catch (error) {
    if (!committed && filingRequestId) {
      try {
        const recovered = recoverReceiptFilingFromRows_(
          filingRequestId,
          normalizeReceiptFilingItemIds_(form.receiptItemIds),
          readObjects_(RECEIPT_ITEM_SHEET_)
        );
        if (recovered) {
          committed = true;
          recovered.durationMs = Date.now() - startedAt;
          recovered.warnings = [
            'Respons batch sempat terputus, tetapi commit berhasil diverifikasi.'
          ];
          return recovered;
        }
      } catch (ignoreRecovery) {}
    }
    if (createdFolder && !committed) {
      try {
        quarantineDriveObject_(
          'FOLDER',
          createdFolder.getId(),
          {
            module: 'PEMBERKASAN_PENERIMAAN',
            reason: 'Rollback sebelum commit: ' + error.message,
            relatedObjectId: cleanText_(form.newBerkasId, 80)
          }
        );
      } catch (ignore) {}
    }
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function refreshReceiptFilingReports_(requestId) {
  const normalizedRequestId = normalizeReceiptFilingRequestId_(requestId);
  try {
    const result = rebuildReports_();
    return {
      ok: true,
      requestId: normalizedRequestId,
      result: result,
      message: 'Laporan selesai disegarkan di latar belakang.'
    };
  } catch (error) {
    audit_(
      'REPORT_WARNING',
      'PEMBERKASAN_PENERIMAAN',
      'BATCH',
      normalizedRequestId,
      'Data utama tersimpan tetapi laporan gagal disegarkan',
      error.message,
      'WARNING'
    );
    throw error;
  }
}

function normalizeReceiptFilingRequestId_(requestId) {
  const value = cleanText_(requireValue_(
    requestId, 'ID permintaan pemberkasan'), 100).toUpperCase();
  if (!/^RBF-[A-Z0-9-]{8,96}$/.test(value)) {
    throw new Error(
      'ID permintaan pemberkasan tidak valid. Muat ulang halaman.'
    );
  }
  return value;
}

function normalizeReceiptFilingItemIds_(itemIds) {
  if (!Array.isArray(itemIds) || !itemIds.length) {
    throw new Error('Pilih minimal satu item dari Penerimaan Arsip.');
  }
  if (itemIds.length > 100) {
    throw new Error('Satu transaksi maksimal memuat 100 item arsip.');
  }
  const seen = {};
  return itemIds.map((id, index) => {
    const value = cleanText_(requireValue_(
      id, 'ID item ke-' + (index + 1)), 90);
    if (seen[value]) throw new Error('Item yang sama dipilih lebih dari satu kali.');
    seen[value] = true;
    return value;
  });
}

function normalizeReceiptFilingContext_(
    form, selectedIds, snapshot, timestamp) {
  const selectedSet = {};
  selectedIds.forEach(id => selectedSet[id] = true);
  const selected = snapshot.receiptItems.filter(row =>
    selectedSet[String(row.PENERIMAAN_ITEM_ID || '')]);
  if (selected.length !== selectedIds.length) {
    throw new Error(
      'Sebagian item tidak ditemukan. Segarkan antrean lalu pilih kembali.'
    );
  }
  selected.forEach(row => {
    const receipt = snapshot.receiptsById[String(row.PENERIMAAN_ID || '')];
    if (!receipt || String(receipt.STATUS || '').toUpperCase() !==
        RECEIPT_STATUS_ACTIVE_) {
      throw new Error('Tanda terima asal item sudah dibatalkan atau tidak tersedia.');
    }
    const status = normalizeReceiptFilingStatus_(row);
    if (status === RECEIPT_FILING_FILED_) {
      throw new Error(
        'Item ' + row.PENERIMAAN_ITEM_ID + ' sudah diberkaskan.'
      );
    }
    if (status !== RECEIPT_FILING_PENDING_ ||
        !receiptItemMetadataComplete_(row)) {
      throw new Error(
        'Metadata item ' + row.PENERIMAAN_ITEM_ID +
        ' belum lengkap. Lengkapi melalui Penerimaan Arsip.'
      );
    }
    const activeDuplicate = snapshot.dbItems.find(item =>
      !isDeleted_(item) &&
      (String(item.PENERIMAAN_ITEM_ID || '') ===
        String(row.PENERIMAAN_ITEM_ID || '') ||
       (cleanText_(row.ARSIP_ID, 90) &&
        String(item.ARSIP_ID || '') === String(row.ARSIP_ID)))
    );
    if (activeDuplicate) {
      throw new Error(
        'Item ' + row.PENERIMAAN_ITEM_ID +
        ' sudah memiliki arsip definitif aktif ' +
        String(activeDuplicate.NO_BERKAS_SNAPSHOT || '–') + '/' +
        String(activeDuplicate.NO_ITEM_DEFINITIF || '–') +
        '. Jalankan repairReceiptModule untuk menyinkronkan status.'
      );
    }
  });

  const mode = String(form.berkasMode || 'EXISTING').toUpperCase();
  if (['EXISTING', 'NEW'].indexOf(mode) === -1) {
    throw new Error('Mode berkas tidak valid.');
  }
  let berkasId = '';
  let newBerkas = null;
  if (mode === 'NEW') {
    berkasId = cleanText_(form.newBerkasId, 80) ||
      'BRK-' + Utilities.getUuid();
    newBerkas = normalizeNewBerkasPayload_(
      form, berkasId, timestamp);
  } else {
    berkasId = cleanText_(requireValue_(
      form.berkasId, 'Berkas tujuan'), 80);
    const parent = snapshot.berkas.find(row =>
      String(row.BERKAS_ID) === berkasId && !isDeleted_(row));
    if (!parent) throw new Error('Berkas tujuan tidak ditemukan.');
    if (String(parent.STATUS_PEMINDAHAN || '').toUpperCase() ===
        'SUDAH DIPINDAHKAN') {
      throw new Error(
        'Berkas sudah dipindahkan ke arsip inaktif dan tidak dapat menerima item.'
      );
    }
  }
  const candidates = selected.map((row, index) =>
    normalizeItemPayload_({
      itemId: 'ITM-' + Utilities.getUuid(),
      previewCreatedAt: cleanText_(
        row.CREATED_AT ||
        snapshot.receiptsById[row.PENERIMAAN_ID].TANGGAL_WAKTU_TERIMA,
        50
      ) + '-' + String(index + 1).padStart(3, '0'),
      berkasId: berkasId,
      primaryLetterNumber: row.NO_SURAT_UTAMA,
      alternateLetterNumber: row.NO_SURAT_ALTERNATIF,
      documentDate: dateKey_(row.TANGGAL_NASKAH),
      description: row.URAIAN_INFORMASI,
      pageCount: row.JUMLAH_HALAMAN,
      developmentLevel: row.TINGKAT_PERKEMBANGAN,
      securityClassification: row.KLASIFIKASI_KEAMANAN_AKSES,
      notes: row.CATATAN_ITEM
    })
  );
  return {
    mode: mode,
    berkasId: berkasId,
    newBerkas: newBerkas,
    selected: selected,
    candidates: candidates
  };
}

function buildReceiptFilingParentRecord_(
    newBerkas, targetPlan, folder, operations, timestamp, user) {
  const calculated = (operations.parentUpdates.find(update =>
    !Number(update.rowNumber) &&
    String(targetPlan.record.BERKAS_ID) === String(newBerkas.berkasId)
  ) || {}).changes || {};
  return Object.assign({
    BERKAS_ID: newBerkas.berkasId,
    JUDUL_BERKAS: newBerkas.title,
    KATEGORI_NASKAH_ID: '',
    POLA_PEMBERKASAN: '',
    KLASIFIKASI_ID: newBerkas.classificationId,
    KODE_KLASIFIKASI_SNAPSHOT: newBerkas.classificationCode,
    URAIAN_KLASIFIKASI_SNAPSHOT: newBerkas.classificationDescription,
    RETENSI_AKTIF_NILAI: newBerkas.activeRetentionValue,
    RETENSI_AKTIF_SATUAN: newBerkas.activeRetentionUnit,
    RETENSI_INAKTIF_NILAI: newBerkas.inactiveRetentionValue,
    RETENSI_INAKTIF_SATUAN: newBerkas.inactiveRetentionUnit,
    NASIB_AKHIR: newBerkas.finalDisposition,
    KLASIFIKASI_KEAMANAN_AKSES: 'BIASA/TERBUKA',
    STATUS_RETENSI: APP_CONFIG.STATUS.RETENSI_MENUNGGU_ITEM,
    NO_FILLING_KABINET: newBerkas.filingCabinet,
    NO_LACI: newBerkas.drawer,
    DRIVE_FOLDER_ID: folder.getId(),
    DRIVE_FOLDER_URL: folder.getUrl(),
    STATUS_PEMINJAMAN: APP_CONFIG.STATUS.PEMINJAMAN_TERSEDIA,
    STATUS_BERKAS: APP_CONFIG.STATUS.BERKAS_DRAFT,
    CATATAN: newBerkas.notes,
    CREATED_AT: newBerkas.createdAt,
    CREATED_BY: user,
    UPDATED_AT: timestamp,
    UPDATED_BY: user,
    VERSION: 1,
    IS_DELETED: false
  }, calculated, {
    DRIVE_FOLDER_ID: folder.getId(),
    DRIVE_FOLDER_URL: folder.getUrl(),
    CREATED_AT: newBerkas.createdAt,
    CREATED_BY: user,
    VERSION: 1,
    IS_DELETED: false
  });
}

function buildReceiptFiledItemRecord_(
    source, candidate, targetPlan, receipt, timestamp, user) {
  const plannedItem = targetPlan.items.find(item =>
    String(item.ITEM_ID) === String(candidate.itemId));
  if (!plannedItem) {
    throw new Error('Nomor definitif item tidak ditemukan dalam rencana.');
  }
  const cleanDescription = cleanFileName_(candidate.description);
  const fileName = targetPlan.newNumber + '_' +
    plannedItem._newNumber + '_' + cleanDescription + '.pdf';
  return {
    ITEM_ID: candidate.itemId,
    BERKAS_ID: candidate.berkasId,
    NO_ITEM_DEFINITIF: plannedItem._newNumber,
    JENIS_NASKAH_ID: '',
    SUBJENIS_NASKAH_ID: '',
    KELENGKAPAN: '',
    NO_SURAT_UTAMA: candidate.primaryLetterNumber,
    NO_SURAT_ALTERNATIF: candidate.alternateLetterNumber,
    NO_SURAT_DISPLAY: displayLetterNumber_(
      candidate.primaryLetterNumber,
      candidate.alternateLetterNumber
    ),
    TANGGAL_NASKAH: candidate.documentDate,
    TAHUN_KURUN_WAKTU: Number(candidate.documentDate.substring(0, 4)),
    URAIAN_LENGKAP: candidate.description,
    URAIAN_NAMA_FILE: cleanDescription,
    JUMLAH_HALAMAN: candidate.pageCount,
    TINGKAT_PERKEMBANGAN: candidate.developmentLevel,
    KLASIFIKASI_KEAMANAN_AKSES: candidate.securityClassification,
    KODE_KLASIFIKASI_SNAPSHOT:
      targetPlan.record.KODE_KLASIFIKASI_SNAPSHOT,
    NO_BERKAS_SNAPSHOT: targetPlan.newNumber,
    NAMA_FILE: fileName,
    DRIVE_FILE_ID: '',
    DRIVE_FILE_URL: '',
    MIME_TYPE: '',
    LAMPIRAN_JSON: '[]',
    STATUS_FILE: 'BELUM DIUNGGAH',
    STATUS_PEMINJAMAN: 'TERSEDIA',
    SORT_NO_SURAT_NORMALIZED: normalizedLetterNumber_(
      candidate.primaryLetterNumber,
      candidate.alternateLetterNumber
    ),
    SORT_CREATED_AT: candidate.previewCreatedAt,
    CATATAN: candidate.notes,
    CREATED_AT: timestamp,
    CREATED_BY: user,
    UPDATED_AT: timestamp,
    UPDATED_BY: user,
    VERSION: 1,
    IS_DELETED: false,
    ARSIP_ID: source.ARSIP_ID,
    SUMBER_REGISTRASI: 'PENERIMAAN_ARSIP',
    PENERIMAAN_ID: source.PENERIMAAN_ID,
    PENERIMAAN_ITEM_ID: source.PENERIMAAN_ITEM_ID,
    NOMOR_TANDA_TERIMA_SNAPSHOT:
      receipt.NOMOR_TANDA_TERIMA || '',
    KONDISI_FISIK: source.KONDISI || '',
    MEDIA_SUMBER: centralFileMetadataNormalizeMediaSource_(
      source.MEDIA_SUMBER || 'TEKSTUAL'),
    STATUS_BENTUK_DIGITAL: centralFileMetadataNormalizeDigitalForm_(
      source.STATUS_BENTUK_DIGITAL || 'TIDAK ADA'),
    STATUS_VERIFIKASI_METADATA: 'TERVERIFIKASI',
    METADATA_SCHEMA_VERSION: CF_METADATA_SCHEMA_VERSION_
  };
}

function buildReceiptFilingAuditRecord_(
    requestId, context, targetPlan, timestamp, user) {
  const receiptNumbers = {};
  context.selected.forEach(item => {
    receiptNumbers[String(item.PENERIMAAN_ID || '')] = true;
  });
  return {
    LOG_ID: 'LOG-' + Utilities.getUuid(),
    TIMESTAMP: timestamp,
    USER_EMAIL: user,
    AKSI: 'FILE_BATCH',
    MODUL: 'PEMBERKASAN_PENERIMAAN',
    JENIS_OBJEK: 'BATCH',
    OBJEK_ID: requestId,
    RINGKASAN: context.selected.length +
      ' item penerimaan masuk ke Berkas ' + targetPlan.newNumber,
    ALASAN: Object.keys(receiptNumbers).length +
      ' tanda terima · target ' + targetPlan.record.JUDUL_BERKAS,
    REQUEST_ID: requestId,
    STATUS: 'SUCCESS'
  };
}

function readReceiptFilingFastSnapshot_() {
  const ranges = [
    receiptFastSheetRange_(
      RECEIPT_SHEET_, 'A:' + RECEIPT_FILING_FAST_COLUMN_LIMIT_),
    receiptFastSheetRange_(
      RECEIPT_ITEM_SHEET_, 'A:' + RECEIPT_FILING_FAST_COLUMN_LIMIT_),
    receiptFastSheetRange_(
      APP_CONFIG.SHEETS.BERKAS,
      'A:' + RECEIPT_FILING_FAST_COLUMN_LIMIT_),
    receiptFastSheetRange_(
      APP_CONFIG.SHEETS.ITEM,
      'A:' + RECEIPT_FILING_FAST_COLUMN_LIMIT_),
    receiptFastSheetRange_(APP_CONFIG.SHEETS.AUDIT, '1:1'),
    receiptFastSheetRange_(APP_CONFIG.SHEETS.AUDIT, 'A:A'),
    receiptFastSheetRange_(APP_CONFIG.SHEETS.HISTORY, '1:1'),
    receiptFastSheetRange_(APP_CONFIG.SHEETS.HISTORY, 'A:A')
  ];
  const response = receiptFilingBatchGet_(ranges);
  const values = response.valueRanges || [];
  if (values.length !== ranges.length) {
    throw receiptFastTransportError_(
      'Sheets API tidak mengembalikan seluruh data pemberkasan.');
  }
  const receiptTable = receiptFastTable_(values[0], RECEIPT_SHEET_);
  const receiptItemTable = receiptFastTable_(
    values[1], RECEIPT_ITEM_SHEET_);
  const berkasTable = receiptFastTable_(
    values[2], APP_CONFIG.SHEETS.BERKAS);
  const dbItemTable = receiptFastTable_(
    values[3], APP_CONFIG.SHEETS.ITEM);
  const auditTable = receiptFastTable_(
    values[4], APP_CONFIG.SHEETS.AUDIT);
  auditTable.nextRow = Math.max(
    2, Number(values[5] && values[5].values &&
      values[5].values.length || 0) + 1);
  const historyTable = receiptFastTable_(
    values[6], APP_CONFIG.SHEETS.HISTORY);
  historyTable.nextRow = Math.max(
    2, Number(values[7] && values[7].values &&
      values[7].values.length || 0) + 1);
  RECEIPT_HEADERS_.forEach(header =>
    assertReceiptFastHeader_(receiptTable, header));
  RECEIPT_ITEM_HEADERS_.forEach(header =>
    assertReceiptFastHeader_(receiptItemTable, header));
  ['BERKAS_ID', 'JUDUL_BERKAS', 'KLASIFIKASI_ID',
    'KODE_KLASIFIKASI_SNAPSHOT', 'DRIVE_FOLDER_ID',
    'STATUS_PEMINDAHAN', 'IS_DELETED']
    .forEach(header => assertReceiptFastHeader_(berkasTable, header));
  ['ITEM_ID', 'BERKAS_ID', 'TANGGAL_NASKAH', 'URAIAN_LENGKAP',
    'JUMLAH_HALAMAN', 'NO_ITEM_DEFINITIF', 'IS_DELETED']
    .concat(RECEIPT_FILING_DB_ITEM_HEADERS_)
    .forEach(header => assertReceiptFastHeader_(dbItemTable, header));
  const receiptsById = {};
  receiptTable.objects.forEach(row =>
    receiptsById[String(row.PENERIMAAN_ID || '')] = row);
  return {
    receipts: receiptTable.objects,
    receiptsById: receiptsById,
    receiptItems: receiptItemTable.objects,
    berkas: berkasTable.objects,
    dbItems: dbItemTable.objects,
    receiptTable: receiptTable,
    receiptItemTable: receiptItemTable,
    berkasTable: berkasTable,
    dbItemTable: dbItemTable,
    auditTable: auditTable,
    historyTable: historyTable
  };
}

function receiptFilingBatchGet_(ranges) {
  if (typeof Sheets !== 'undefined' &&
      Sheets.Spreadsheets && Sheets.Spreadsheets.Values) {
    try {
      return Sheets.Spreadsheets.Values.batchGet(
        APP_CONFIG.SPREADSHEET_ID,
        {
          ranges: ranges,
          majorDimension: 'ROWS',
          valueRenderOption: 'UNFORMATTED_VALUE'
        }
      );
    } catch (error) {
      throw receiptFastTransportError_(
        'Sheets API gagal membaca antrean pemberkasan: ' + error.message);
    }
  }
  const query = ranges.map(range =>
    'ranges=' + encodeURIComponent(range)).join('&');
  return receiptFastApiFetch_(
    '/values:batchGet?majorDimension=ROWS&valueRenderOption=' +
    'UNFORMATTED_VALUE&' + query,
    'get'
  );
}

function filingFastRowsUpdate_(table, startRow, objects) {
  objects = objects || [];
  if (!objects.length) throw new Error('Data batch pemberkasan kosong.');
  const endRow = Number(startRow) + objects.length - 1;
  return {
    range: receiptFastSheetRange_(
      table.sheetName,
      'A' + Number(startRow) + ':' +
      receiptFastColumnLetter_(table.headers.length) + endRow
    ),
    majorDimension: 'ROWS',
    values: objects.map(object => table.headers.map(header =>
      filingFastScalar_(
        Object.prototype.hasOwnProperty.call(object, header)
          ? object[header] : ''
      )
    ))
  };
}

function filingFastScalar_(value) {
  if (value instanceof Date && !isNaN(value)) {
    return Utilities.formatDate(
      value, APP_CONFIG.TIME_ZONE, 'yyyy-MM-dd');
  }
  if (value === undefined || value === null) return '';
  return value;
}

function filingFastRowChanges_(table, updates) {
  return (updates || []).map(update => {
    const original = table.objects.find(row =>
      Number(row._rowNumber) === Number(update.rowNumber));
    if (!original) {
      throw new Error(
        'Baris ' + update.rowNumber + ' tidak ditemukan pada ' +
        table.sheetName + '.'
      );
    }
    return filingFastRowsUpdate_(
      table,
      update.rowNumber,
      [Object.assign({}, original, update.changes || {})]
    );
  });
}

function recoverReceiptFiling_(requestId, receiptItemIds) {
  assertReceiptFilingReady_();
  const normalizedRequestId = normalizeReceiptFilingRequestId_(requestId);
  const selectedIds = normalizeReceiptFilingItemIds_(receiptItemIds);
  const recovered = recoverReceiptFilingFromRows_(
    normalizedRequestId,
    selectedIds,
    readObjects_(RECEIPT_ITEM_SHEET_)
  );
  return recovered || {
    ok: true,
    found: false,
    requestId: normalizedRequestId
  };
}

function recoverReceiptFilingFromRows_(requestId, selectedIds, rows) {
  const selectedSet = {};
  selectedIds.forEach(id => selectedSet[id] = true);
  const matches = (rows || []).filter(row =>
    selectedSet[String(row.PENERIMAAN_ITEM_ID || '')] &&
    String(row.PEMBERKASAN_REQUEST_ID || '') === requestId &&
    normalizeReceiptFilingStatus_(row) === RECEIPT_FILING_FILED_
  );
  if (!matches.length) return null;
  if (matches.length !== selectedIds.length) {
    throw new Error(
      'Transaksi pemberkasan tersimpan sebagian. Jalankan Health Check ' +
      'sebelum mencoba kembali.'
    );
  }
  const berkasNumbers = {};
  matches.forEach(row =>
    berkasNumbers[String(row.NO_BERKAS_DEFINITIF_SNAPSHOT || '')] = true);
  return {
    ok: true,
    found: true,
    recovered: true,
    requestId: requestId,
    berkasId: String(matches[0].BERKAS_ID_TUJUAN || ''),
    berkasNumber: String(matches[0].NO_BERKAS_DEFINITIF_SNAPSHOT || ''),
    itemCount: matches.length,
    items: matches.map(row => ({
      receiptItemId: String(row.PENERIMAAN_ITEM_ID || ''),
      itemId: String(row.ITEM_ID_DEFINITIF || ''),
      berkasNumber: String(row.NO_BERKAS_DEFINITIF_SNAPSHOT || ''),
      itemNumber: String(row.NO_ITEM_DEFINITIF_SNAPSHOT || '')
    })),
    warnings: [],
    message: 'Pemberkasan sudah tersimpan dan dipulihkan tanpa data ganda.'
  };
}

function releaseReceiptItemsAfterDeletion_(dbItems, timestamp, user) {
  const linked = (dbItems || []).filter(item =>
    cleanText_(item.PENERIMAAN_ITEM_ID, 90));
  if (!linked.length) return {released: 0};
  const sourceById = {};
  readObjects_(RECEIPT_ITEM_SHEET_).forEach(row =>
    sourceById[String(row.PENERIMAAN_ITEM_ID || '')] = row);
  const updates = [];
  linked.forEach(dbItem => {
    const source = sourceById[String(dbItem.PENERIMAAN_ITEM_ID || '')];
    if (!source || receiptBoolean_(source.IS_DELETED)) return;
    const status = receiptItemMetadataComplete_(source)
      ? RECEIPT_FILING_PENDING_ : RECEIPT_FILING_INCOMPLETE_;
    updates.push({
      rowNumber: source._rowNumber,
      changes: {
        STATUS_PEMBERKASAN: status,
        BERKAS_ID_TUJUAN: '',
        ITEM_ID_DEFINITIF: '',
        NO_BERKAS_DEFINITIF_SNAPSHOT: '',
        NO_ITEM_DEFINITIF_SNAPSHOT: '',
        DIBERKASKAN_AT: '',
        DIBERKASKAN_BY: '',
        PEMBERKASAN_REQUEST_ID: '',
        UPDATED_AT: timestamp,
        UPDATED_BY: user
      }
    });
  });
  updateObjectsAtRows_(RECEIPT_ITEM_SHEET_, updates);
  return {released: updates.length};
}
