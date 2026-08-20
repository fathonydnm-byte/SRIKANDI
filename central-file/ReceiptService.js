var RECEIPT_SHEET_ = 'PENERIMAAN_ARSIP';
var RECEIPT_ITEM_SHEET_ = 'PENERIMAAN_ITEM';
var RECEIPT_EMPLOYEE_SHEET_ = 'MASTER_PEGAWAI';
var RECEIPT_PRINT_LOG_SHEET_ = 'LOG_CETAK_PENERIMAAN';
var RECEIPT_UPLOAD_PROPERTY_PREFIX_ = 'RECEIPT_EVIDENCE_SESSION_';
var RECEIPT_UPLOAD_CHUNK_SIZE_ = 512 * 1024;
var RECEIPT_UPLOAD_MAX_SIZE_ = 10 * 1024 * 1024;
var RECEIPT_FAST_API_COLUMN_LIMIT_ = 'AZ';
var RECEIPT_STATUS_ACTIVE_ = 'AKTIF';
var RECEIPT_STATUS_CANCELLED_ = 'DIBATALKAN';
var RECEIPT_FILING_PENDING_ = 'BELUM DIBERKASKAN';
var RECEIPT_FILING_FILED_ = 'SUDAH DIBERKASKAN';
var RECEIPT_FILING_INCOMPLETE_ = 'PERLU DILENGKAPI';
var RECEIPT_FILING_CANCELLED_ = 'DIBATALKAN';
var RECEIPT_DEVELOPMENT_LEVELS_ = ['ASLI', 'COPY'];
var RECEIPT_CONDITIONS_ = ['BAIK', 'RUSAK RINGAN', 'RUSAK SEDANG', 'RUSAK BERAT'];

var RECEIPT_HEADERS_ = [
  'PENERIMAAN_ID', 'NOMOR_TANDA_TERIMA', 'TAHUN', 'TANGGAL_WAKTU_TERIMA',
  'PENYERAH_PEGAWAI_ID', 'NAMA_PENYERAH_SNAPSHOT', 'UNIT_PENYERAH_SNAPSHOT',
  'NAMA_PENERIMA', 'UNIT_PENERIMA', 'LOKASI', 'CATATAN_UMUM',
  'JUMLAH_ITEM', 'TOTAL_HALAMAN', 'STATUS',
  'BUKTI_TTD_FILE_ID', 'BUKTI_TTD_URL', 'BUKTI_TTD_NAMA',
  'BUKTI_TTD_UPLOADED_AT', 'BUKTI_TTD_UPLOADED_BY',
  'ALASAN_PEMBATALAN', 'BATAL_BUKTI_FILE_ID', 'BATAL_BUKTI_URL',
  'BATAL_BUKTI_NAMA', 'DIBATALKAN_AT', 'DIBATALKAN_BY',
  'CREATED_AT', 'CREATED_BY', 'UPDATED_AT', 'UPDATED_BY', 'VERSION'
];

var RECEIPT_ITEM_HEADERS_ = [
  'PENERIMAAN_ITEM_ID', 'PENERIMAAN_ID', 'NO_ITEM',
  'URAIAN_INFORMASI', 'JUMLAH_HALAMAN', 'TINGKAT_PERKEMBANGAN', 'KONDISI',
  'KLASIFIKASI_KEAMANAN_AKSES',
  'CREATED_AT', 'CREATED_BY', 'UPDATED_AT', 'UPDATED_BY',
  'IS_DELETED', 'DELETED_AT', 'DELETED_BY',
  'ARSIP_ID', 'NO_SURAT_UTAMA', 'NO_SURAT_ALTERNATIF', 'TANGGAL_NASKAH',
  'CATATAN_ITEM', 'STATUS_PEMBERKASAN', 'BERKAS_ID_TUJUAN',
  'ITEM_ID_DEFINITIF', 'NO_BERKAS_DEFINITIF_SNAPSHOT',
  'NO_ITEM_DEFINITIF_SNAPSHOT', 'DIBERKASKAN_AT', 'DIBERKASKAN_BY',
  'PEMBERKASAN_REQUEST_ID'
];

var RECEIPT_EMPLOYEE_HEADERS_ = [
  'PEGAWAI_ID', 'NAMA_PEGAWAI', 'UNIT_KERJA', 'AKTIF',
  'CREATED_AT', 'CREATED_BY', 'UPDATED_AT', 'UPDATED_BY'
];

var RECEIPT_PRINT_LOG_HEADERS_ = [
  'CETAK_ID', 'PENERIMAAN_ID', 'NOMOR_TANDA_TERIMA_SNAPSHOT',
  'PRINT_TOKEN', 'CETAK_KE', 'JENIS_CETAK', 'STATUS_SNAPSHOT',
  'TIMESTAMP', 'USER_EMAIL', 'PDF_FILE_NAME'
];

function ensureReceiptModule_() {
  ensureReceiptSheet_(RECEIPT_SHEET_, RECEIPT_HEADERS_, [
    190, 150, 70, 170, 190, 190, 190, 190, 190, 90, 260,
    90, 100, 110, 190, 240, 220, 170, 190, 260, 190, 240,
    220, 170, 190, 170, 190, 170, 190, 80
  ]);
  ensureReceiptSheet_(RECEIPT_ITEM_SHEET_, RECEIPT_ITEM_HEADERS_, [
    190, 190, 70, 420, 110, 150, 150, 190, 170, 190, 170, 190, 90, 170, 190,
    190, 220, 220, 130, 320, 170, 190, 190, 130, 130, 180, 210, 210
  ]);
  ensureReceiptSheet_(RECEIPT_EMPLOYEE_SHEET_, RECEIPT_EMPLOYEE_HEADERS_, [
    190, 240, 260, 80, 170, 190, 170, 190
  ]);
  ensureReceiptSheet_(RECEIPT_PRINT_LOG_SHEET_, RECEIPT_PRINT_LOG_HEADERS_, [
    190, 190, 150, 190, 80, 110, 110, 170, 190, 240
  ]);
  ensureReceiptSettings_();
  return {
    ok: true,
    sheets: [
      RECEIPT_SHEET_, RECEIPT_ITEM_SHEET_,
      RECEIPT_EMPLOYEE_SHEET_, RECEIPT_PRINT_LOG_SHEET_
    ]
  };
}

function assertReceiptModuleReady_() {
  const cache = CacheService.getScriptCache();
  if (cache.get('RECEIPT_MODULE_READY_V1') === 'TRUE') return true;
  const spreadsheet = getSpreadsheet_();
  const required = [
    RECEIPT_SHEET_,
    RECEIPT_ITEM_SHEET_,
    RECEIPT_EMPLOYEE_SHEET_,
    RECEIPT_PRINT_LOG_SHEET_
  ];
  const missing = required.filter(name => !spreadsheet.getSheetByName(name));
  if (missing.length) {
    throw new Error(
      'Modul Penerimaan Arsip belum lengkap. Jalankan repairReceiptModule satu kali. Sheet yang belum tersedia: ' +
      missing.join(', ') + '.'
    );
  }
  cache.put('RECEIPT_MODULE_READY_V1', 'TRUE', 600);
  return true;
}

function ensureReceiptSheet_(sheetName, headers, widths) {
  const spreadsheet = getSpreadsheet_();
  let sheet = spreadsheet.getSheetByName(sheetName);
  let changed = false;
  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
    changed = true;
  }
  if (sheet.getMaxColumns() < headers.length) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
    changed = true;
  }
  const lastColumn = Math.max(sheet.getLastColumn(), 1);
  const existing = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  const missing = headers.filter(header => existing.indexOf(header) === -1);
  if (missing.length) {
    const startColumn = existing.filter(Boolean).length + 1;
    sheet.getRange(1, startColumn, 1, missing.length).setValues([missing]);
    changed = true;
  }
  if (changed) {
    sheet.setFrozenRows(1);
    sheet.setHiddenGridlines(true);
    sheet.getRange(1, 1, 1, headers.length)
      .setFontWeight('bold')
      .setBackground('#143b5d')
      .setFontColor('#ffffff')
      .setWrap(true);
    (widths || []).forEach((width, index) => {
      if (index < headers.length) sheet.setColumnWidth(index + 1, width);
    });
    headerCache_ = {};
  }
  return sheet;
}

function ensureReceiptSettings_() {
  const defaults = [
    {
      KEY: 'RECEIPT_RECEIVER_NAME',
      VALUE: '',
      TYPE: 'STRING',
      DESCRIPTION: 'Nama penerima arsip default; tetap dapat diubah pada formulir'
    },
    {
      KEY: 'RECEIPT_RECEIVER_UNIT',
      VALUE: 'Bagian Umum Kantor Pusat - Biro AUPK',
      TYPE: 'STRING',
      DESCRIPTION: 'Unit kerja penerima arsip default; tetap dapat diubah pada formulir'
    },
    {
      KEY: 'RECEIPT_PROOF_FOLDER_ID',
      VALUE: '',
      TYPE: 'STRING',
      DESCRIPTION: 'Folder bukti tanda terima dan pembatalan penerimaan arsip'
    },
    {
      KEY: 'RECEIPT_PROOF_FOLDER_URL',
      VALUE: '',
      TYPE: 'URL',
      DESCRIPTION: 'Tautan folder bukti penerimaan arsip'
    }
  ];
  const existing = readObjects_(APP_CONFIG.SHEETS.SETTINGS);
  defaults.forEach(setting => {
    if (!existing.some(row => String(row.KEY) === setting.KEY)) {
      appendObject_(APP_CONFIG.SHEETS.SETTINGS, setting);
    }
  });
}

function getReceiptOptions_() {
  assertReceiptModuleReady_();
  const employees = readObjects_(RECEIPT_EMPLOYEE_SHEET_)
    .filter(row => receiptBoolean_(row.AKTIF))
    .sort((a, b) => receiptNaturalCompare_(a.NAMA_PEGAWAI, b.NAMA_PEGAWAI))
    .map(receiptEmployeeOption_);
  const receipts = readObjects_(RECEIPT_SHEET_);
  const itemRows = readObjects_(RECEIPT_ITEM_SHEET_)
    .filter(row => !receiptBoolean_(row.IS_DELETED));
  const itemsByReceipt = {};
  itemRows.forEach(row => {
    const id = String(row.PENERIMAAN_ID || '');
    if (!itemsByReceipt[id]) itemsByReceipt[id] = [];
    itemsByReceipt[id].push(receiptItemPresentation_(row));
  });
  Object.keys(itemsByReceipt).forEach(id => itemsByReceipt[id].sort((a, b) => a.number - b.number));
  const presentations = receipts
    .filter(row => row.PENERIMAAN_ID)
    .map(row => receiptPresentation_(row, itemsByReceipt[row.PENERIMAAN_ID] || []))
    .sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)));
  const settings = readSettings_();
  return {
    ok: true,
    employees: employees,
    receipts: presentations,
    defaults: {
      receiverName: cleanText_(settings.RECEIPT_RECEIVER_NAME, 250),
      receiverUnit: cleanText_(settings.RECEIPT_RECEIVER_UNIT, 250),
      location: 'Surabaya'
    },
    developmentLevels: RECEIPT_DEVELOPMENT_LEVELS_.slice(),
    conditions: RECEIPT_CONDITIONS_.slice(),
    securityClassifications: CF_METADATA_SECURITY_LEVELS_.slice(),
    summary: {
      total: presentations.length,
      active: presentations.filter(row => row.status === RECEIPT_STATUS_ACTIVE_).length,
      withEvidence: presentations.filter(row => row.evidenceUrl).length,
      cancelled: presentations.filter(row => row.status === RECEIPT_STATUS_CANCELLED_).length
    }
  };
}

function addReceiptEmployee_(form) {
  assertReceiptModuleReady_();
  const name = cleanText_(requireValue_(form && form.employeeName, 'Nama pegawai'), 250);
  const unit = cleanText_(requireValue_(form && form.employeeUnit, 'Unit kerja pegawai'), 250);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const rows = readObjects_(RECEIPT_EMPLOYEE_SHEET_);
    const existing = rows.find(row =>
      receiptSearchKey_(row.NAMA_PEGAWAI) === receiptSearchKey_(name) &&
      receiptSearchKey_(row.UNIT_KERJA) === receiptSearchKey_(unit)
    );
    const timestamp = nowIso_();
    const user = getCurrentUser_();
    if (existing) {
      if (!receiptBoolean_(existing.AKTIF)) {
        updateObjectAtRow_(RECEIPT_EMPLOYEE_SHEET_, existing._rowNumber, {
          AKTIF: true,
          UPDATED_AT: timestamp,
          UPDATED_BY: user
        });
      }
      return {
        ok: true,
        employee: receiptEmployeeOption_(Object.assign({}, existing, {AKTIF: true})),
        message: 'Pegawai sudah tersedia dan dipilih.'
      };
    }
    const record = {
      PEGAWAI_ID: 'PGW-' + Utilities.getUuid(),
      NAMA_PEGAWAI: name,
      UNIT_KERJA: unit,
      AKTIF: true,
      CREATED_AT: timestamp,
      CREATED_BY: user,
      UPDATED_AT: timestamp,
      UPDATED_BY: user
    };
    appendObject_(RECEIPT_EMPLOYEE_SHEET_, record);
    audit_('CREATE', 'PENERIMAAN_ARSIP', 'PEGAWAI', record.PEGAWAI_ID,
      'Menambah pegawai penyerah: ' + name, unit, 'SUCCESS');
    return {
      ok: true,
      employee: receiptEmployeeOption_(record),
      message: 'Pegawai berhasil ditambahkan dan dipilih.'
    };
  } finally {
    lock.releaseLock();
  }
}

function saveReceipt_(form) {
  const startedAt = Date.now();
  const performance = {
    path: 'SPREADSHEET_FALLBACK',
    lockWaitMs: 0,
    readMs: 0,
    validationMs: 0,
    writeMs: 0
  };
  const lock = LockService.getScriptLock();
  const lockStartedAt = Date.now();
  lock.waitLock(30000);
  performance.lockWaitMs = Date.now() - lockStartedAt;
  try {
    if (canUseReceiptSheetsApiFastPath_()) {
      try {
        return saveReceiptWithSheetsApi_(form, startedAt, performance);
      } catch (fastError) {
        if (!fastError.receiptFastPathTransportFailure) throw fastError;
        performance.path = 'SPREADSHEET_FALLBACK';
        performance.fastPathError = cleanText_(fastError.message, 300);
      }
    }
    return saveReceiptWithSpreadsheetService_(form, startedAt, performance);
  } finally {
    lock.releaseLock();
  }
}

function saveReceiptWithSheetsApi_(form, startedAt, performance) {
  performance.path = 'SHEETS_API_BATCH';
  const readStartedAt = Date.now();
  const snapshot = readReceiptFastSnapshot_();
  performance.readMs = Date.now() - readStartedAt;
  const requestId = receiptRequestId_(form);
  if (!cleanText_(form && form.receiptId, 90) && requestId) {
    const recovered = snapshot.receipts.find(row =>
      String(row.PENERIMAAN_ID || '') === requestId);
    if (recovered) {
      return buildRecoveredReceiptResult_(recovered, startedAt, performance);
    }
  }

  const validationStartedAt = Date.now();
  const normalized = normalizeReceiptForm_(form, snapshot.receipts, snapshot.employees);
  performance.validationMs = Date.now() - validationStartedAt;
  const timestamp = nowIso_();
  const user = getCurrentUser_();
  const writeData = [];
  let result;

  if (normalized.existing) {
    const existing = normalized.existing;
    const oldItems = snapshot.items.filter(row =>
      String(row.PENERIMAAN_ID || '') === String(existing.PENERIMAAN_ID) &&
      !receiptBoolean_(row.IS_DELETED));
    const editPlan = buildReceiptEditPlan_(
      existing, oldItems, normalized, timestamp, user);
    editPlan.itemUpdates.forEach(update => writeData.push(
      receiptFastRowUpdate_(
        snapshot.itemTable,
        update.rowNumber,
        Object.assign({}, update.original, update.changes)
      )
    ));
    if (editPlan.itemAppends.length) {
      writeData.push(receiptFastRowsUpdate_(
        snapshot.itemTable,
        snapshot.itemTable.nextRow,
        editPlan.itemAppends
      ));
    }
    const updatedReceipt = Object.assign(
      {}, existing, editPlan.receiptChanges);
    writeData.push(receiptFastRowUpdate_(
      snapshot.receiptTable, existing._rowNumber, updatedReceipt));
    writeData.push(receiptFastRowUpdate_(
      snapshot.auditTable,
      snapshot.auditTable.nextRow,
      buildReceiptAuditRecord_(
        'UPDATE',
        existing.PENERIMAAN_ID,
        'Memperbarui ' + existing.NOMOR_TANDA_TERIMA,
        normalized.items.length + ' item · ' + normalized.totalPages + ' halaman',
        timestamp,
        user
      )
    ));
    result = {
      ok: true,
      receiptId: existing.PENERIMAAN_ID,
      number: existing.NOMOR_TANDA_TERIMA,
      isUpdate: true,
      message: 'Tanda terima berhasil diperbarui.'
    };
  } else {
    const year = Number(Utilities.formatDate(new Date(), APP_CONFIG.TIME_ZONE, 'yyyy'));
    const receiptId = requestId || 'RCV-' + Utilities.getUuid();
    const number = nextReceiptNumber_(snapshot.receipts, year);
    const record = buildReceiptRecord_(
      receiptId, number, year, normalized, timestamp, user);
    const items = buildReceiptItemRecords_(
      receiptId, normalized.items, timestamp, user);
    writeData.push(receiptFastRowUpdate_(
      snapshot.receiptTable, snapshot.receiptTable.nextRow, record));
    writeData.push(receiptFastRowsUpdate_(
      snapshot.itemTable, snapshot.itemTable.nextRow, items));
    writeData.push(receiptFastRowUpdate_(
      snapshot.auditTable,
      snapshot.auditTable.nextRow,
      buildReceiptAuditRecord_(
        'CREATE',
        receiptId,
        'Membuat ' + number + ' dari ' + normalized.employee.NAMA_PEGAWAI,
        normalized.items.length + ' item · ' + normalized.totalPages + ' halaman',
        timestamp,
        user
      )
    ));
    result = {
      ok: true,
      receiptId: receiptId,
      number: number,
      isUpdate: false,
      message: 'Penerimaan arsip berhasil dicatat.'
    };
  }

  const writeStartedAt = Date.now();
  try {
    receiptFastBatchUpdate_({
      valueInputOption: 'RAW',
      includeValuesInResponse: false,
      data: writeData
    });
  } catch (error) {
    error.receiptFastPathTransportFailure = true;
    throw error;
  }
  performance.writeMs = Date.now() - writeStartedAt;
  return enrichReceiptPerformance_(result, startedAt, performance);
}

function saveReceiptWithSpreadsheetService_(form, startedAt, performance) {
  assertReceiptModuleReady_();
  const readStartedAt = Date.now();
  const receiptRows = readObjects_(RECEIPT_SHEET_);
  const requestId = receiptRequestId_(form);
  if (!cleanText_(form && form.receiptId, 90) && requestId) {
    const recovered = receiptRows.find(row =>
      String(row.PENERIMAAN_ID || '') === requestId);
    if (recovered) {
      performance.readMs = Date.now() - readStartedAt;
      return buildRecoveredReceiptResult_(recovered, startedAt, performance);
    }
  }
  const employeeRows = readObjects_(RECEIPT_EMPLOYEE_SHEET_);
  const itemRows = readObjects_(RECEIPT_ITEM_SHEET_);
  performance.readMs = Date.now() - readStartedAt;
  const validationStartedAt = Date.now();
  const normalized = normalizeReceiptForm_(form, receiptRows, employeeRows);
  performance.validationMs = Date.now() - validationStartedAt;
  const timestamp = nowIso_();
  const user = getCurrentUser_();
  const writeStartedAt = Date.now();
  let result;

  if (normalized.existing) {
    const existing = normalized.existing;
    const oldItems = itemRows.filter(row =>
      String(row.PENERIMAAN_ID || '') === String(existing.PENERIMAAN_ID) &&
      !receiptBoolean_(row.IS_DELETED));
    const editPlan = buildReceiptEditPlan_(
      existing, oldItems, normalized, timestamp, user);
    updateObjectsAtRows_(RECEIPT_ITEM_SHEET_, editPlan.itemUpdates);
    appendObjects_(RECEIPT_ITEM_SHEET_, editPlan.itemAppends);
    updateObjectAtRow_(
      RECEIPT_SHEET_, existing._rowNumber, editPlan.receiptChanges);
    audit_('UPDATE', 'PENERIMAAN_ARSIP', 'TANDA_TERIMA', existing.PENERIMAAN_ID,
      'Memperbarui ' + existing.NOMOR_TANDA_TERIMA,
      normalized.items.length + ' item · ' + normalized.totalPages + ' halaman', 'SUCCESS');
    result = {
      ok: true,
      receiptId: existing.PENERIMAAN_ID,
      number: existing.NOMOR_TANDA_TERIMA,
      isUpdate: true,
      message: 'Tanda terima berhasil diperbarui.'
    };
  } else {
    const year = Number(Utilities.formatDate(new Date(), APP_CONFIG.TIME_ZONE, 'yyyy'));
    const receiptId = requestId || 'RCV-' + Utilities.getUuid();
    const number = nextReceiptNumber_(receiptRows, year);
    appendObject_(RECEIPT_SHEET_,
      buildReceiptRecord_(receiptId, number, year, normalized, timestamp, user));
    appendObjects_(RECEIPT_ITEM_SHEET_,
      buildReceiptItemRecords_(receiptId, normalized.items, timestamp, user));
    audit_('CREATE', 'PENERIMAAN_ARSIP', 'TANDA_TERIMA', receiptId,
      'Membuat ' + number + ' dari ' + normalized.employee.NAMA_PEGAWAI,
      normalized.items.length + ' item · ' + normalized.totalPages + ' halaman', 'SUCCESS');
    result = {
      ok: true,
      receiptId: receiptId,
      number: number,
      isUpdate: false,
      message: 'Penerimaan arsip berhasil dicatat.'
    };
  }
  performance.writeMs = Date.now() - writeStartedAt;
  return enrichReceiptPerformance_(result, startedAt, performance);
}

function buildReceiptRecord_(receiptId, number, year, normalized, timestamp, user) {
  return {
    PENERIMAAN_ID: receiptId,
    NOMOR_TANDA_TERIMA: number,
    TAHUN: year,
    TANGGAL_WAKTU_TERIMA: timestamp,
    PENYERAH_PEGAWAI_ID: normalized.employee.PEGAWAI_ID,
    NAMA_PENYERAH_SNAPSHOT: normalized.employee.NAMA_PEGAWAI,
    UNIT_PENYERAH_SNAPSHOT: normalized.employee.UNIT_KERJA,
    NAMA_PENERIMA: normalized.receiverName,
    UNIT_PENERIMA: normalized.receiverUnit,
    LOKASI: 'Surabaya',
    CATATAN_UMUM: normalized.notes,
    JUMLAH_ITEM: normalized.items.length,
    TOTAL_HALAMAN: normalized.totalPages,
    STATUS: RECEIPT_STATUS_ACTIVE_,
    CREATED_AT: timestamp,
    CREATED_BY: user,
    UPDATED_AT: timestamp,
    UPDATED_BY: user,
    VERSION: 1
  };
}

function buildReceiptAuditRecord_(action, receiptId, summary, reason, timestamp, user) {
  return {
    LOG_ID: 'LOG-' + Utilities.getUuid(),
    TIMESTAMP: timestamp,
    USER_EMAIL: user,
    AKSI: action,
    MODUL: 'PENERIMAAN_ARSIP',
    JENIS_OBJEK: 'TANDA_TERIMA',
    OBJEK_ID: receiptId,
    RINGKASAN: summary,
    ALASAN: reason || '',
    REQUEST_ID: 'REQ-' + Utilities.getUuid(),
    STATUS: 'SUCCESS'
  };
}

function validateEditableReceipt_(existing) {
  if (String(existing.STATUS || RECEIPT_STATUS_ACTIVE_) !== RECEIPT_STATUS_ACTIVE_) {
    throw new Error('Tanda terima yang dibatalkan tidak dapat diedit.');
  }
}

function buildReceiptEditPlan_(existing, oldItems, normalized, timestamp, user) {
  validateEditableReceipt_(existing);
  oldItems = oldItems || [];
  const oldById = {};
  oldItems.forEach(row => oldById[String(row.PENERIMAAN_ITEM_ID || '')] = row);
  const hasEvidence = Boolean(
    existing.BUKTI_TTD_FILE_ID || existing.BUKTI_TTD_URL);
  const hasFiledItem = oldItems.some(row =>
    normalizeReceiptFilingStatus_(row) === RECEIPT_FILING_FILED_);
  const headerChanged =
    String(existing.PENYERAH_PEGAWAI_ID || '') !==
      String(normalized.employee.PEGAWAI_ID || '') ||
    cleanText_(existing.NAMA_PENYERAH_SNAPSHOT, 250) !==
      cleanText_(normalized.employee.NAMA_PEGAWAI, 250) ||
    cleanText_(existing.UNIT_PENYERAH_SNAPSHOT, 250) !==
      cleanText_(normalized.employee.UNIT_KERJA, 250) ||
    cleanText_(existing.NAMA_PENERIMA, 250) !== normalized.receiverName ||
    cleanText_(existing.UNIT_PENERIMA, 250) !== normalized.receiverUnit ||
    cleanText_(existing.CATATAN_UMUM, 2000) !== normalized.notes;
  if ((hasEvidence || hasFiledItem) && headerChanged) {
    throw new Error(
      'Identitas dan catatan umum terkunci karena tanda terima sudah ' +
      (hasEvidence ? 'memiliki bukti tertandatangani.' :
        'memiliki item yang sudah diberkaskan.')
    );
  }

  const submittedIds = {};
  const existingById = {};
  oldItems.forEach(row => existingById[row.PENERIMAAN_ITEM_ID] = row);
  const records = buildReceiptItemRecords_(
    existing.PENERIMAAN_ID,
    normalized.items,
    timestamp,
    user,
    existingById
  );
  const itemUpdates = [];
  const itemAppends = [];

  records.forEach((record, index) => {
    const item = normalized.items[index];
    const itemId = String(item.receiptItemId || '');
    if (!itemId) {
      if (hasEvidence) {
        throw new Error(
          'Item baru tidak dapat ditambahkan setelah bukti tertandatangani diunggah.'
        );
      }
      record.STATUS_PEMBERKASAN = receiptItemMetadataComplete_(record)
        ? RECEIPT_FILING_PENDING_ : RECEIPT_FILING_INCOMPLETE_;
      itemAppends.push(record);
      return;
    }
    if (submittedIds[itemId]) {
      throw new Error('Item penerimaan yang sama terkirim lebih dari satu kali.');
    }
    submittedIds[itemId] = true;
    const old = oldById[itemId];
    if (!old) {
      throw new Error('Item penerimaan tidak ditemukan atau sudah dihapus.');
    }
    if (item.archiveId && old.ARSIP_ID &&
        String(item.archiveId) !== String(old.ARSIP_ID)) {
      throw new Error('Identitas arsip tidak cocok. Muat ulang halaman.');
    }
    const status = normalizeReceiptFilingStatus_(old);
    if (status === RECEIPT_FILING_FILED_ &&
        !receiptItemRecordEquals_(old, record, false)) {
      throw new Error(
        'Item ' + Number(old.NO_ITEM || index + 1) +
        ' sudah diberkaskan dan tidak dapat diubah dari Penerimaan Arsip.'
      );
    }
    if (hasEvidence &&
        !receiptItemRecordEquals_(old, record, true)) {
      throw new Error(
        'Data yang tercetak pada item ' + Number(old.NO_ITEM || index + 1) +
        ' terkunci karena bukti tertandatangani sudah diunggah.'
      );
    }
    if (hasEvidence && status !== RECEIPT_FILING_INCOMPLETE_ &&
        !receiptItemRecordEquals_(old, record, false)) {
      throw new Error(
        'Metadata item ' + Number(old.NO_ITEM || index + 1) +
        ' sudah lengkap dan terkunci oleh bukti tertandatangani.'
      );
    }
    record.STATUS_PEMBERKASAN = status === RECEIPT_FILING_FILED_
      ? RECEIPT_FILING_FILED_
      : (receiptItemMetadataComplete_(record)
        ? RECEIPT_FILING_PENDING_ : RECEIPT_FILING_INCOMPLETE_);
    itemUpdates.push({
      rowNumber: old._rowNumber,
      original: old,
      changes: record
    });
  });

  oldItems.forEach(old => {
    const itemId = String(old.PENERIMAAN_ITEM_ID || '');
    if (submittedIds[itemId]) return;
    const status = normalizeReceiptFilingStatus_(old);
    if (status === RECEIPT_FILING_FILED_) {
      throw new Error(
        'Item ' + Number(old.NO_ITEM || 0) +
        ' sudah diberkaskan dan tidak dapat dihapus dari tanda terima.'
      );
    }
    if (hasEvidence) {
      throw new Error(
        'Item tidak dapat dihapus setelah bukti tertandatangani diunggah.'
      );
    }
    itemUpdates.push({
      rowNumber: old._rowNumber,
      original: old,
      changes: {
        IS_DELETED: true,
        DELETED_AT: timestamp,
        DELETED_BY: user,
        UPDATED_AT: timestamp,
        UPDATED_BY: user
      }
    });
  });

  return {
    itemUpdates: itemUpdates,
    itemAppends: itemAppends,
    receiptChanges: {
      PENYERAH_PEGAWAI_ID: normalized.employee.PEGAWAI_ID,
      NAMA_PENYERAH_SNAPSHOT: normalized.employee.NAMA_PEGAWAI,
      UNIT_PENYERAH_SNAPSHOT: normalized.employee.UNIT_KERJA,
      NAMA_PENERIMA: normalized.receiverName,
      UNIT_PENERIMA: normalized.receiverUnit,
      CATATAN_UMUM: normalized.notes,
      JUMLAH_ITEM: normalized.items.length,
      TOTAL_HALAMAN: normalized.totalPages,
      UPDATED_AT: timestamp,
      UPDATED_BY: user,
      VERSION: Number(existing.VERSION || 1) + 1
    }
  };
}

function receiptItemMetadataComplete_(row) {
  return Boolean(
    cleanText_(row && row.ARSIP_ID, 90) &&
    cleanText_(row && row.TANGGAL_NASKAH, 30) &&
    cleanText_(row && row.URAIAN_INFORMASI, 2000) &&
    Number(row && row.JUMLAH_HALAMAN || 0) >= 1 &&
    cleanText_(row && row.TINGKAT_PERKEMBANGAN, 30) &&
    cleanText_(row && row.KONDISI, 50) &&
    cleanText_(row && row.KLASIFIKASI_KEAMANAN_AKSES, 50)
  );
}

function receiptItemRecordEquals_(oldRow, newRow, printedOnly) {
  const printedEqual =
    cleanText_(oldRow.URAIAN_INFORMASI, 2000) ===
      cleanText_(newRow.URAIAN_INFORMASI, 2000) &&
    Number(oldRow.JUMLAH_HALAMAN || 0) ===
      Number(newRow.JUMLAH_HALAMAN || 0) &&
    String(oldRow.TINGKAT_PERKEMBANGAN || '').toUpperCase() ===
      String(newRow.TINGKAT_PERKEMBANGAN || '').toUpperCase() &&
    String(oldRow.KONDISI || '').toUpperCase() ===
      String(newRow.KONDISI || '').toUpperCase();
  if (printedOnly) return printedEqual;
  return printedEqual &&
    cleanText_(oldRow.NO_SURAT_UTAMA, 250) ===
      cleanText_(newRow.NO_SURAT_UTAMA, 250) &&
    cleanText_(oldRow.NO_SURAT_ALTERNATIF, 250) ===
      cleanText_(newRow.NO_SURAT_ALTERNATIF, 250) &&
    dateKey_(oldRow.TANGGAL_NASKAH) === dateKey_(newRow.TANGGAL_NASKAH) &&
    cleanText_(oldRow.CATATAN_ITEM, 1000) ===
      cleanText_(newRow.CATATAN_ITEM, 1000) &&
    centralFileMetadataNormalizeSecurity_(
      oldRow.KLASIFIKASI_KEAMANAN_AKSES) ===
      centralFileMetadataNormalizeSecurity_(
        newRow.KLASIFIKASI_KEAMANAN_AKSES);
}

function receiptRequestId_(form) {
  const requestId = cleanText_(form && form.requestId, 100).toUpperCase();
  if (!requestId) return '';
  if (!/^RCV-[A-Z0-9-]{8,96}$/.test(requestId)) {
    throw new Error('ID permintaan penerimaan tidak valid. Muat ulang halaman lalu coba kembali.');
  }
  return requestId;
}

function enrichReceiptPerformance_(result, startedAt, performance) {
  result.durationMs = Date.now() - startedAt;
  result.path = performance.path;
  result.performance = {
    path: performance.path,
    lockWaitMs: Number(performance.lockWaitMs || 0),
    readMs: Number(performance.readMs || 0),
    validationMs: Number(performance.validationMs || 0),
    writeMs: Number(performance.writeMs || 0),
    totalMs: result.durationMs
  };
  if (performance.fastPathError) {
    result.performance.fastPathError = performance.fastPathError;
  }
  return result;
}

function buildRecoveredReceiptResult_(receipt, startedAt, performance) {
  return enrichReceiptPerformance_({
    ok: true,
    found: true,
    recovered: true,
    receiptId: receipt.PENERIMAAN_ID,
    number: receipt.NOMOR_TANDA_TERIMA,
    isUpdate: false,
    message: 'Penerimaan arsip sudah tersimpan dan berhasil dipulihkan tanpa data ganda.'
  }, startedAt, performance);
}

function recoverReceiptSave_(requestId) {
  const startedAt = Date.now();
  requestId = receiptRequestId_({requestId: requestId});
  let rows;
  let path = 'SPREADSHEET_FALLBACK';
  if (canUseReceiptSheetsApiFastPath_()) {
    try {
      const range = receiptFastSheetRange_(
        RECEIPT_SHEET_, 'A:' + RECEIPT_FAST_API_COLUMN_LIMIT_);
      const response = receiptFastBatchGet_([range]);
      const valueRange = response.valueRanges && response.valueRanges[0] || {};
      rows = receiptFastTable_(valueRange, RECEIPT_SHEET_).objects;
      path = 'SHEETS_API_BATCH';
    } catch (error) {
      if (!error.receiptFastPathTransportFailure) throw error;
    }
  }
  if (!rows) rows = readObjects_(RECEIPT_SHEET_);
  const receipt = rows.find(row =>
    String(row.PENERIMAAN_ID || '') === requestId);
  if (!receipt) {
    return {
      ok: true,
      found: false,
      receiptId: requestId,
      durationMs: Date.now() - startedAt,
      path: path
    };
  }
  return buildRecoveredReceiptResult_(receipt, startedAt, {
    path: path,
    readMs: Date.now() - startedAt
  });
}

function canUseReceiptSheetsApiFastPath_() {
  const advancedService = typeof Sheets !== 'undefined' &&
    Sheets.Spreadsheets && Sheets.Spreadsheets.Values;
  const directApi = typeof UrlFetchApp !== 'undefined' &&
    typeof ScriptApp !== 'undefined';
  return Boolean(APP_CONFIG && APP_CONFIG.SPREADSHEET_ID &&
    (advancedService || directApi));
}

function readReceiptFastSnapshot_() {
  const ranges = [
    receiptFastSheetRange_(RECEIPT_SHEET_, 'A:' + RECEIPT_FAST_API_COLUMN_LIMIT_),
    receiptFastSheetRange_(RECEIPT_ITEM_SHEET_, 'A:' + RECEIPT_FAST_API_COLUMN_LIMIT_),
    receiptFastSheetRange_(RECEIPT_EMPLOYEE_SHEET_, 'A:' + RECEIPT_FAST_API_COLUMN_LIMIT_),
    receiptFastSheetRange_(APP_CONFIG.SHEETS.AUDIT, '1:1'),
    receiptFastSheetRange_(APP_CONFIG.SHEETS.AUDIT, 'A:A')
  ];
  const response = receiptFastBatchGet_(ranges);
  const valueRanges = response.valueRanges || [];
  if (valueRanges.length !== ranges.length) {
    throw receiptFastTransportError_(
      'Sheets API tidak mengembalikan seluruh rentang Penerimaan Arsip.');
  }
  const receiptTable = receiptFastTable_(valueRanges[0], RECEIPT_SHEET_);
  const itemTable = receiptFastTable_(valueRanges[1], RECEIPT_ITEM_SHEET_);
  const employeeTable = receiptFastTable_(valueRanges[2], RECEIPT_EMPLOYEE_SHEET_);
  const auditTable = receiptFastTable_(valueRanges[3], APP_CONFIG.SHEETS.AUDIT);
  auditTable.nextRow = Math.max(
    2,
    Number(valueRanges[4] && valueRanges[4].values &&
      valueRanges[4].values.length || 0) + 1
  );
  RECEIPT_HEADERS_.forEach(header => assertReceiptFastHeader_(receiptTable, header));
  RECEIPT_ITEM_HEADERS_.forEach(header => assertReceiptFastHeader_(itemTable, header));
  RECEIPT_EMPLOYEE_HEADERS_.forEach(header => assertReceiptFastHeader_(employeeTable, header));
  ['LOG_ID', 'TIMESTAMP', 'USER_EMAIL', 'AKSI', 'MODUL', 'JENIS_OBJEK',
    'OBJEK_ID', 'RINGKASAN', 'ALASAN', 'REQUEST_ID', 'STATUS']
    .forEach(header => assertReceiptFastHeader_(auditTable, header));
  return {
    receipts: receiptTable.objects,
    items: itemTable.objects,
    employees: employeeTable.objects,
    receiptTable: receiptTable,
    itemTable: itemTable,
    employeeTable: employeeTable,
    auditTable: auditTable
  };
}

function receiptFastTable_(valueRange, sheetName) {
  const values = valueRange && valueRange.values || [];
  const headers = (values[0] || []).map(value => String(value || '').trim());
  if (!headers.length) {
    throw new Error('Header tidak ditemukan pada ' + sheetName + '. Jalankan repairReceiptModule satu kali.');
  }
  const objects = values.slice(1)
    .map((row, index) => {
      const object = {_rowNumber: index + 2};
      headers.forEach((header, column) => object[header] =
        row[column] === undefined || row[column] === null ? '' : row[column]);
      return object;
    })
    .filter(row => headers.some(header => row[header] !== ''));
  return {
    sheetName: sheetName,
    headers: headers,
    objects: objects,
    nextRow: Math.max(2, values.length + 1)
  };
}

function assertReceiptFastHeader_(table, header) {
  if (table.headers.indexOf(header) === -1) {
    throw new Error('Kolom ' + header + ' tidak ditemukan pada sheet ' +
      table.sheetName + '. Jalankan repairReceiptModule satu kali.');
  }
}

function receiptFastRowUpdate_(table, rowNumber, object) {
  return receiptFastRowsUpdate_(table, rowNumber, [object]);
}

function receiptFastRowsUpdate_(table, startRow, objects) {
  objects = objects || [];
  if (!objects.length) {
    throw new Error('Data baris Penerimaan Arsip kosong.');
  }
  const endRow = Number(startRow) + objects.length - 1;
  const lastColumn = receiptFastColumnLetter_(table.headers.length);
  return {
    range: receiptFastSheetRange_(
      table.sheetName,
      'A' + Number(startRow) + ':' + lastColumn + endRow
    ),
    majorDimension: 'ROWS',
    values: objects.map(object => table.headers.map(header =>
      Object.prototype.hasOwnProperty.call(object, header) ? object[header] : ''))
  };
}

function receiptFastColumnLetter_(columnNumber) {
  let number = Number(columnNumber);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error('Nomor kolom Penerimaan Arsip tidak valid.');
  }
  let result = '';
  while (number > 0) {
    const remainder = (number - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    number = Math.floor((number - 1) / 26);
  }
  return result;
}

function receiptFastSheetRange_(sheetName, range) {
  return "'" + String(sheetName || '').replace(/'/g, "''") + "'!" + range;
}

function receiptFastBatchGet_(ranges) {
  if (typeof Sheets !== 'undefined' &&
      Sheets.Spreadsheets && Sheets.Spreadsheets.Values) {
    try {
      return Sheets.Spreadsheets.Values.batchGet(APP_CONFIG.SPREADSHEET_ID, {
        ranges: ranges,
        majorDimension: 'ROWS',
        valueRenderOption: 'FORMATTED_VALUE'
      });
    } catch (error) {
      throw receiptFastTransportError_(
        'Layanan Sheets batch gagal membaca Penerimaan Arsip: ' + error.message);
    }
  }
  const query = ranges.map(range =>
    'ranges=' + encodeURIComponent(range)).join('&');
  return receiptFastApiFetch_(
    '/values:batchGet?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE&' + query,
    'get'
  );
}

function receiptFastBatchUpdate_(payload) {
  if (typeof Sheets !== 'undefined' &&
      Sheets.Spreadsheets && Sheets.Spreadsheets.Values) {
    try {
      return Sheets.Spreadsheets.Values.batchUpdate(
        payload,
        APP_CONFIG.SPREADSHEET_ID
      );
    } catch (error) {
      throw receiptFastTransportError_(
        'Layanan Sheets batch gagal menulis Penerimaan Arsip: ' + error.message);
    }
  }
  return receiptFastApiFetch_('/values:batchUpdate', 'post', payload);
}

function receiptFastApiFetch_(path, method, payload) {
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' +
    encodeURIComponent(APP_CONFIG.SPREADSHEET_ID) + path;
  const options = {
    method: method || 'get',
    headers: {Authorization: 'Bearer ' + ScriptApp.getOAuthToken()},
    muteHttpExceptions: true
  };
  if (payload !== undefined) {
    options.contentType = 'application/json';
    options.payload = JSON.stringify(payload);
  }
  let response;
  try {
    response = UrlFetchApp.fetch(url, options);
  } catch (error) {
    throw receiptFastTransportError_(
      'Koneksi batch Google Sheets gagal: ' + error.message);
  }
  const responseCode = response.getResponseCode();
  const responseText = response.getContentText();
  if (responseCode < 200 || responseCode >= 300) {
    let apiMessage = '';
    try {
      const parsed = JSON.parse(responseText);
      apiMessage = parsed && parsed.error && parsed.error.message || '';
    } catch (ignore) {}
    throw receiptFastTransportError_(
      'Google Sheets batch API HTTP ' + responseCode +
      (apiMessage ? ': ' + cleanText_(apiMessage, 250) : '')
    );
  }
  if (!responseText) return {};
  try {
    return JSON.parse(responseText);
  } catch (error) {
    throw receiptFastTransportError_(
      'Respons Google Sheets batch API tidak valid.');
  }
}

function receiptFastTransportError_(message) {
  const error = new Error(message);
  error.receiptFastPathTransportFailure = true;
  return error;
}

function normalizeReceiptForm_(form, receiptRows, employeeRows) {
  form = form || {};
  const receiptId = cleanText_(form.receiptId, 90);
  const existing = receiptId
    ? (receiptRows || []).find(row => String(row.PENERIMAAN_ID) === receiptId)
    : null;
  if (receiptId && !existing) throw new Error('Tanda terima yang akan diedit tidak ditemukan.');
  const employeeId = cleanText_(requireValue_(form.senderEmployeeId, 'Pegawai penyerah'), 90);
  const employee = (employeeRows || readObjects_(RECEIPT_EMPLOYEE_SHEET_))
    .find(row => String(row.PEGAWAI_ID) === employeeId && receiptBoolean_(row.AKTIF));
  if (!employee) throw new Error('Pegawai penyerah tidak aktif atau tidak ditemukan.');
  const receiverName = cleanText_(requireValue_(form.receiverName, 'Nama penerima arsip'), 250);
  const receiverUnit = cleanText_(requireValue_(form.receiverUnit, 'Unit kerja penerima'), 250);
  const items = normalizeReceiptItems_(form.items);
  return {
    existing: existing,
    employee: employee,
    receiverName: receiverName,
    receiverUnit: receiverUnit,
    notes: cleanText_(form.receiptNotes, 2000),
    items: items,
    totalPages: items.reduce((sum, item) => sum + item.pageCount, 0)
  };
}

function normalizeReceiptItems_(items) {
  if (!Array.isArray(items) || !items.length) throw new Error('Minimal satu item arsip wajib diisi.');
  if (items.length > 100) throw new Error('Satu tanda terima maksimal memuat 100 item arsip.');
  return items.map((item, index) => {
    item = item || {};
    const pageCount = Number(item.pageCount);
    if (!Number.isInteger(pageCount) || pageCount < 1) {
      throw new Error('Jumlah halaman item ' + (index + 1) + ' harus bilangan bulat minimal 1.');
    }
    const development = String(requireValue_(item.developmentLevel,
      'Tingkat perkembangan item ' + (index + 1))).toUpperCase();
    if (RECEIPT_DEVELOPMENT_LEVELS_.indexOf(development) === -1) {
      throw new Error('Tingkat perkembangan item ' + (index + 1) + ' tidak valid.');
    }
    const condition = String(requireValue_(item.condition,
      'Kondisi item ' + (index + 1))).toUpperCase();
    if (RECEIPT_CONDITIONS_.indexOf(condition) === -1) {
      throw new Error('Kondisi item ' + (index + 1) + ' tidak valid.');
    }
    const securityClassification = validateArchiveSecurityClassification_(
      item.securityClassification,
      'Klasifikasi keamanan dan akses item ' + (index + 1));
    const documentDate = dateKey_(parseLocalDate_(
      requireValue_(item.documentDate, 'Tanggal naskah item ' + (index + 1)),
      'Tanggal naskah item ' + (index + 1)
    ));
    return {
      receiptItemId: cleanText_(item.receiptItemId, 90),
      archiveId: cleanText_(item.archiveId, 90),
      description: cleanText_(requireValue_(item.description,
        'Uraian item ' + (index + 1)), 2000),
      pageCount: pageCount,
      developmentLevel: development,
      condition: condition,
      securityClassification: securityClassification,
      primaryLetterNumber: cleanText_(item.primaryLetterNumber, 250),
      alternateLetterNumber: cleanText_(item.alternateLetterNumber, 250),
      documentDate: documentDate,
      notes: cleanText_(item.notes, 1000)
    };
  });
}

function buildReceiptItemRecords_(receiptId, items, timestamp, user, existingById) {
  existingById = existingById || {};
  return items.map((item, index) => ({
    PENERIMAAN_ITEM_ID: item.receiptItemId || 'RCVI-' + Utilities.getUuid(),
    PENERIMAAN_ID: receiptId,
    NO_ITEM: index + 1,
    URAIAN_INFORMASI: item.description,
    JUMLAH_HALAMAN: item.pageCount,
    TINGKAT_PERKEMBANGAN: item.developmentLevel,
    KONDISI: item.condition,
    KLASIFIKASI_KEAMANAN_AKSES: item.securityClassification,
    MEDIA_SUMBER: 'TEKSTUAL',
    STATUS_BENTUK_DIGITAL: 'TIDAK ADA',
    STATUS_VERIFIKASI_METADATA: 'TERVERIFIKASI',
    METADATA_SCHEMA_VERSION: CF_METADATA_SCHEMA_VERSION_,
    CREATED_AT: existingById[item.receiptItemId]
      ? existingById[item.receiptItemId].CREATED_AT : timestamp,
    CREATED_BY: existingById[item.receiptItemId]
      ? existingById[item.receiptItemId].CREATED_BY : user,
    UPDATED_AT: timestamp,
    UPDATED_BY: user,
    IS_DELETED: false,
    ARSIP_ID: item.archiveId ||
      (existingById[item.receiptItemId] &&
        existingById[item.receiptItemId].ARSIP_ID) ||
      'ARS-' + Utilities.getUuid(),
    NO_SURAT_UTAMA: item.primaryLetterNumber,
    NO_SURAT_ALTERNATIF: item.alternateLetterNumber,
    TANGGAL_NASKAH: item.documentDate,
    CATATAN_ITEM: item.notes,
    STATUS_PEMBERKASAN: existingById[item.receiptItemId]
      ? normalizeReceiptFilingStatus_(existingById[item.receiptItemId])
      : RECEIPT_FILING_PENDING_,
    BERKAS_ID_TUJUAN: existingById[item.receiptItemId]
      ? existingById[item.receiptItemId].BERKAS_ID_TUJUAN : '',
    ITEM_ID_DEFINITIF: existingById[item.receiptItemId]
      ? existingById[item.receiptItemId].ITEM_ID_DEFINITIF : '',
    NO_BERKAS_DEFINITIF_SNAPSHOT: existingById[item.receiptItemId]
      ? existingById[item.receiptItemId].NO_BERKAS_DEFINITIF_SNAPSHOT : '',
    NO_ITEM_DEFINITIF_SNAPSHOT: existingById[item.receiptItemId]
      ? existingById[item.receiptItemId].NO_ITEM_DEFINITIF_SNAPSHOT : '',
    DIBERKASKAN_AT: existingById[item.receiptItemId]
      ? existingById[item.receiptItemId].DIBERKASKAN_AT : '',
    DIBERKASKAN_BY: existingById[item.receiptItemId]
      ? existingById[item.receiptItemId].DIBERKASKAN_BY : '',
    PEMBERKASAN_REQUEST_ID: existingById[item.receiptItemId]
      ? existingById[item.receiptItemId].PEMBERKASAN_REQUEST_ID : ''
  }));
}

function normalizeReceiptFilingStatus_(row) {
  const value = String(row && row.STATUS_PEMBERKASAN || '').toUpperCase();
  if ([
    RECEIPT_FILING_PENDING_,
    RECEIPT_FILING_FILED_,
    RECEIPT_FILING_INCOMPLETE_,
    RECEIPT_FILING_CANCELLED_
  ].indexOf(value) !== -1) return value;
  return row && row.TANGGAL_NASKAH
    ? RECEIPT_FILING_PENDING_ : RECEIPT_FILING_INCOMPLETE_;
}

function nextReceiptNumber_(rows, year) {
  const prefix = 'TRM-' + year + '-';
  let maximum = 0;
  (rows || []).forEach(row => {
    const value = String(row.NOMOR_TANDA_TERIMA || '');
    if (value.indexOf(prefix) !== 0) return;
    const sequence = Number(value.substring(prefix.length));
    if (Number.isInteger(sequence) && sequence > maximum) maximum = sequence;
  });
  return prefix + String(maximum + 1).padStart(4, '0');
}

function prepareReceiptPrint_(receiptId) {
  assertReceiptModuleReady_();
  const context = getReceiptContext_(receiptId);
  const logs = readObjects_(RECEIPT_PRINT_LOG_SHEET_)
    .filter(row => String(row.PENERIMAAN_ID) === String(context.receipt.PENERIMAAN_ID));
  const printCount = logs.length;
  return {
    ok: true,
    printToken: 'RCPRINT-' + Utilities.getUuid(),
    receiptId: context.receipt.PENERIMAAN_ID,
    number: context.receipt.NOMOR_TANDA_TERIMA,
    receivedAt: String(context.receipt.TANGGAL_WAKTU_TERIMA || ''),
    senderName: context.receipt.NAMA_PENYERAH_SNAPSHOT || '',
    senderUnit: context.receipt.UNIT_PENYERAH_SNAPSHOT || '',
    receiverName: context.receipt.NAMA_PENERIMA || '',
    receiverUnit: context.receipt.UNIT_PENERIMA || '',
    location: context.receipt.LOKASI || 'Surabaya',
    notes: context.receipt.CATATAN_UMUM || '',
    status: context.receipt.STATUS || RECEIPT_STATUS_ACTIVE_,
    cancellationReason: context.receipt.ALASAN_PEMBATALAN || '',
    cancelledAt: context.receipt.DIBATALKAN_AT || '',
    isReprint: printCount > 0,
    printNumber: printCount + 1,
    generatedAt: nowIso_(),
    fileName: cleanFileName_(context.receipt.NOMOR_TANDA_TERIMA) +
      '_Tanda-Terima-Penyerahan-Arsip.pdf',
    items: context.items.map(receiptItemPresentation_)
  };
}

function confirmReceiptPrint_(request) {
  assertReceiptModuleReady_();
  request = request || {};
  const receiptId = cleanText_(requireValue_(request.receiptId, 'ID tanda terima'), 90);
  const printToken = cleanText_(requireValue_(request.printToken, 'Token cetak'), 100);
  const context = getReceiptContext_(receiptId);
  const logs = readObjects_(RECEIPT_PRINT_LOG_SHEET_);
  const duplicate = logs.find(row => String(row.PRINT_TOKEN) === printToken);
  if (duplicate) return {ok: true, printCount: Number(duplicate.CETAK_KE || 1)};
  const printCount = logs.filter(row => String(row.PENERIMAAN_ID) === receiptId).length + 1;
  const fileName = cleanText_(request.fileName, 250) ||
    cleanFileName_(context.receipt.NOMOR_TANDA_TERIMA) + '_Tanda-Terima-Penyerahan-Arsip.pdf';
  appendObject_(RECEIPT_PRINT_LOG_SHEET_, {
    CETAK_ID: 'RCPL-' + Utilities.getUuid(),
    PENERIMAAN_ID: receiptId,
    NOMOR_TANDA_TERIMA_SNAPSHOT: context.receipt.NOMOR_TANDA_TERIMA,
    PRINT_TOKEN: printToken,
    CETAK_KE: printCount,
    JENIS_CETAK: printCount > 1 ? 'CETAK ULANG' : 'PERTAMA',
    STATUS_SNAPSHOT: context.receipt.STATUS || RECEIPT_STATUS_ACTIVE_,
    TIMESTAMP: nowIso_(),
    USER_EMAIL: getCurrentUser_(),
    PDF_FILE_NAME: fileName
  });
  audit_('GENERATE_PDF', 'PENERIMAAN_ARSIP', 'TANDA_TERIMA', receiptId,
    'Mencetak ' + context.receipt.NOMOR_TANDA_TERIMA,
    (printCount > 1 ? 'CETAK ULANG ke-' + printCount : 'Cetak pertama') +
      ' · ' + fileName, 'SUCCESS');
  return {ok: true, printCount: printCount};
}

function cancelReceipt_(form, preUploadedEvidenceId, originalName) {
  assertReceiptModuleReady_();
  form = form || {};
  const receiptId = cleanText_(requireValue_(form.cancelReceiptId, 'Tanda terima'), 90);
  const reason = cleanText_(requireValue_(form.cancelReason, 'Alasan pembatalan'), 2000);
  if (reason.length < 10) throw new Error('Alasan pembatalan minimal 10 karakter.');
  if (String(form.cancelConfirmation || '').trim().toUpperCase() !== 'BATALKAN') {
    throw new Error('Ketik BATALKAN pada kolom konfirmasi.');
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const row = readObjects_(RECEIPT_SHEET_)
      .find(item => String(item.PENERIMAAN_ID) === receiptId);
    if (!row) throw new Error('Tanda terima tidak ditemukan.');
    if (String(row.STATUS) === RECEIPT_STATUS_CANCELLED_) {
      return {
        ok: true,
        receiptId: receiptId,
        message: 'Tanda terima sudah dibatalkan sebelumnya.'
      };
    }
    const activeLinkedItems = readObjects_(APP_CONFIG.SHEETS.ITEM)
      .filter(item =>
        !isDeleted_(item) &&
        String(item.PENERIMAAN_ID || '') === receiptId
      );
    if (activeLinkedItems.length) {
      const references = activeLinkedItems.slice(0, 5).map(item =>
        String(item.NO_BERKAS_SNAPSHOT || '–') + '/' +
        String(item.NO_ITEM_DEFINITIF || '–')
      );
      throw new Error(
        'Tanda terima belum dapat dibatalkan karena ' +
        activeLinkedItems.length + ' item masih berada di dalam berkas (' +
        references.join(', ') +
        (activeLinkedItems.length > references.length ? ', …' : '') +
        '). Hapus item terkait melalui menu Penghapusan terlebih dahulu.'
      );
    }
    const proof = preUploadedEvidenceId
      ? finalizeReceiptEvidenceFile_(row, 'CANCEL', preUploadedEvidenceId, originalName)
      : null;
    const timestamp = nowIso_();
    const user = getCurrentUser_();
    updateObjectAtRow_(RECEIPT_SHEET_, row._rowNumber, {
      STATUS: RECEIPT_STATUS_CANCELLED_,
      ALASAN_PEMBATALAN: reason,
      BATAL_BUKTI_FILE_ID: proof ? proof.id : '',
      BATAL_BUKTI_URL: proof ? proof.url : '',
      BATAL_BUKTI_NAMA: proof ? proof.name : '',
      DIBATALKAN_AT: timestamp,
      DIBATALKAN_BY: user,
      UPDATED_AT: timestamp,
      UPDATED_BY: user,
      VERSION: Number(row.VERSION || 1) + 1
    });
    const receiptItems = readObjects_(RECEIPT_ITEM_SHEET_)
      .filter(item =>
        String(item.PENERIMAAN_ID || '') === receiptId &&
        !receiptBoolean_(item.IS_DELETED)
      );
    updateObjectsAtRows_(RECEIPT_ITEM_SHEET_, receiptItems.map(item => ({
      rowNumber: item._rowNumber,
      changes: {
        STATUS_PEMBERKASAN: RECEIPT_FILING_CANCELLED_,
        UPDATED_AT: timestamp,
        UPDATED_BY: user
      }
    })));
    audit_('CANCEL', 'PENERIMAAN_ARSIP', 'TANDA_TERIMA', receiptId,
      'Membatalkan ' + row.NOMOR_TANDA_TERIMA,
      reason + (proof ? ' · Bukti: ' + proof.url : ''), 'SUCCESS');
    return {
      ok: true,
      receiptId: receiptId,
      proofUrl: proof ? proof.url : '',
      message: 'Tanda terima berhasil dibatalkan. Bukti tertandatangani yang sudah ada tetap disimpan.'
    };
  } finally {
    lock.releaseLock();
  }
}

function attachReceiptSignedEvidence_(receiptId, preUploadedEvidenceId, originalName) {
  assertReceiptModuleReady_();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const row = readObjects_(RECEIPT_SHEET_)
      .find(item => String(item.PENERIMAAN_ID) === String(receiptId));
    if (!row) throw new Error('Tanda terima tidak ditemukan.');
    if (row.BUKTI_TTD_FILE_ID || row.BUKTI_TTD_URL) {
      return {
        ok: true,
        receiptId: row.PENERIMAAN_ID,
        evidenceUrl: row.BUKTI_TTD_URL || '',
        message: 'Bukti tanda terima tertandatangani sudah tersimpan.'
      };
    }
    const proof = finalizeReceiptEvidenceFile_(row, 'SIGNED', preUploadedEvidenceId, originalName);
    const timestamp = nowIso_();
    const user = getCurrentUser_();
    updateObjectAtRow_(RECEIPT_SHEET_, row._rowNumber, {
      BUKTI_TTD_FILE_ID: proof.id,
      BUKTI_TTD_URL: proof.url,
      BUKTI_TTD_NAMA: proof.name,
      BUKTI_TTD_UPLOADED_AT: timestamp,
      BUKTI_TTD_UPLOADED_BY: user,
      UPDATED_AT: timestamp,
      UPDATED_BY: user,
      VERSION: Number(row.VERSION || 1) + 1
    });
    audit_('UPLOAD', 'PENERIMAAN_ARSIP', 'BUKTI_TTD', row.PENERIMAAN_ID,
      'Mengunggah bukti tertandatangani ' + row.NOMOR_TANDA_TERIMA,
      proof.url, 'SUCCESS');
    return {
      ok: true,
      receiptId: row.PENERIMAAN_ID,
      evidenceUrl: proof.url,
      message: 'Bukti tanda terima tertandatangani berhasil disimpan.'
    };
  } finally {
    lock.releaseLock();
  }
}

function startReceiptEvidenceUpload_(request) {
  assertReceiptModuleReady_();
  purgeOldUploadSessionsByPrefix_(RECEIPT_UPLOAD_PROPERTY_PREFIX_);
  request = request || {};
  const uploadType = String(requireValue_(request.uploadType, 'Jenis upload')).toUpperCase();
  if (['SIGNED', 'CANCEL'].indexOf(uploadType) === -1) throw new Error('Jenis upload bukti tidak valid.');
  const receiptId = cleanText_(requireValue_(request.receiptId || request.cancelReceiptId,
    'Tanda terima'), 90);
  const context = getReceiptContext_(receiptId);
  if (uploadType === 'SIGNED' &&
      (context.receipt.BUKTI_TTD_FILE_ID || context.receipt.BUKTI_TTD_URL)) {
    throw new Error('Bukti tertandatangani sudah tersimpan.');
  }
  const fileName = cleanText_(requireValue_(request.evidenceName, 'Nama file bukti'), 250);
  const fileSize = Number(request.evidenceSize);
  const mimeType = cleanText_(request.evidenceType || 'application/pdf', 100).toLowerCase();
  validateReceiptEvidenceFile_(fileName, fileSize, mimeType);
  const form = uploadType === 'CANCEL' ? {
    cancelReceiptId: receiptId,
    cancelReason: cleanText_(request.cancelReason, 2000),
    cancelConfirmation: cleanText_(request.cancelConfirmation, 30)
  } : {receiptId: receiptId};
  if (uploadType === 'CANCEL') {
    if (form.cancelReason.length < 10) throw new Error('Alasan pembatalan minimal 10 karakter.');
    if (form.cancelConfirmation.toUpperCase() !== 'BATALKAN') {
      throw new Error('Ketik BATALKAN pada kolom konfirmasi.');
    }
  }
  const folder = getReceiptEvidenceFolder_();
  const sessionId = 'RCPUPL-' + Utilities.getUuid();
  const sessionUrl = initializeDriveResumableUpload_(
    'UPLOAD_' + uploadType + '_' + sessionId + '.pdf',
    fileSize, folder.getId(), 'application/pdf'
  );
  const session = {
    sessionId: sessionId,
    sessionUrl: sessionUrl,
    uploadType: uploadType,
    userEmail: getCurrentUser_(),
    fileName: fileName,
    fileSize: fileSize,
    mimeType: 'application/pdf',
    uploadedBytes: 0,
    driveFileId: '',
    form: form,
    committed: false,
    commitResult: null,
    createdAt: nowIso_()
  };
  saveReceiptUploadSession_(session);
  audit_('UPLOAD_START', 'PENERIMAAN_ARSIP',
    uploadType === 'SIGNED' ? 'BUKTI_TTD' : 'BUKTI_PEMBATALAN',
    sessionId, 'Memulai upload bukti: ' + fileName,
    fileSize + ' byte', 'SUCCESS');
  return receiptUploadProgress_(session);
}

function uploadReceiptEvidenceChunk_(request) {
  request = request || {};
  const session = getReceiptUploadSession_(request.sessionId);
  if (session.driveFileId) return receiptUploadProgress_(session);
  const total = Number(request.total);
  const start = Number(request.start);
  const endExclusive = Number(request.end);
  if (total !== Number(session.fileSize)) throw new Error('Ukuran bukti berubah selama upload.');
  if (!Number.isInteger(start) || !Number.isInteger(endExclusive) ||
      start < 0 || endExclusive <= start || endExclusive > total) {
    throw new Error('Posisi potongan bukti tidak valid.');
  }
  if (start !== Number(session.uploadedBytes || 0)) return receiptUploadProgress_(session);
  const bytes = Utilities.base64Decode(String(request.base64 || ''));
  if (bytes.length !== endExclusive - start) throw new Error('Ukuran potongan bukti tidak sesuai.');
  if (endExclusive < total && bytes.length % (256 * 1024) !== 0) {
    throw new Error('Potongan selain yang terakhir harus kelipatan 256 KB.');
  }
  const response = sendDriveResumableChunk_(
    session.sessionUrl, bytes, start, endExclusive, total, 'application/pdf');
  if (response.complete) {
    session.uploadedBytes = total;
    session.driveFileId = response.fileId;
  } else {
    session.uploadedBytes = response.uploadedBytes;
  }
  saveReceiptUploadSession_(session);
  return receiptUploadProgress_(session);
}

function getReceiptEvidenceUploadStatus_(sessionId) {
  const session = getReceiptUploadSession_(sessionId);
  if (session.committed || session.driveFileId) return receiptUploadProgress_(session);
  const response = queryDriveResumableStatus_(
    session.sessionUrl, session.fileSize, 'application/pdf');
  if (response.complete) {
    session.uploadedBytes = session.fileSize;
    session.driveFileId = response.fileId;
  } else {
    session.uploadedBytes = response.uploadedBytes;
  }
  saveReceiptUploadSession_(session);
  return receiptUploadProgress_(session);
}

function finalizeReceiptEvidenceUpload_(sessionId) {
  const session = getReceiptUploadSession_(sessionId);
  if (session.committed && session.commitResult) return session.commitResult;
  if (!session.driveFileId) {
    const status = getReceiptEvidenceUploadStatus_(sessionId);
    if (!status.complete) throw new Error('UPLOAD_INCOMPLETE: Bukti belum selesai diunggah.');
    Object.assign(session, getReceiptUploadSession_(sessionId));
  }
  const result = session.uploadType === 'CANCEL'
    ? cancelReceipt_(session.form, session.driveFileId, session.fileName)
    : attachReceiptSignedEvidence_(session.form.receiptId, session.driveFileId, session.fileName);
  session.committed = true;
  session.committedAt = nowIso_();
  session.commitResult = result;
  saveReceiptUploadSession_(session);
  return result;
}

function cancelReceiptEvidenceUpload_(sessionId) {
  const session = getReceiptUploadSession_(sessionId);
  if (session.driveFileId && !session.committed) {
    try { DriveApp.getFileById(session.driveFileId).setTrashed(true); } catch (ignore) {}
  }
  PropertiesService.getScriptProperties().deleteProperty(receiptUploadPropertyKey_(sessionId));
  return {ok: true};
}

function finalizeReceiptEvidenceFile_(receipt, uploadType, driveFileId, originalName) {
  const file = DriveApp.getFileById(requireValue_(driveFileId, 'File bukti'));
  validateReceiptEvidenceFile_(originalName || file.getName(), Number(file.getSize()),
    file.getMimeType());
  const number = cleanFileName_(receipt.NOMOR_TANDA_TERIMA || 'Tanda-Terima');
  const finalName = uploadType === 'CANCEL'
    ? number + '_Bukti-Pembatalan.pdf'
    : number + '_Tanda-Terima-Tertandatangani.pdf';
  file.setName(finalName);
  return {id: file.getId(), url: file.getUrl(), name: file.getName()};
}

function validateReceiptEvidenceFile_(fileName, fileSize, mimeType) {
  const extension = (String(fileName || '').match(/\.([^.]+)$/) || ['', ''])[1].toLowerCase();
  const normalizedType = String(mimeType || '').toLowerCase();
  if (extension !== 'pdf') throw new Error('Bukti penerimaan harus berformat PDF.');
  if (normalizedType &&
      ['application/pdf', 'application/octet-stream'].indexOf(normalizedType) === -1) {
    throw new Error('Tipe bukti penerimaan harus PDF.');
  }
  if (!Number.isInteger(Number(fileSize)) || Number(fileSize) < 1) {
    throw new Error('Ukuran bukti penerimaan tidak valid.');
  }
  if (Number(fileSize) > RECEIPT_UPLOAD_MAX_SIZE_) {
    throw new Error('Ukuran bukti penerimaan maksimal 10 MB.');
  }
}

function getReceiptEvidenceFolder_() {
  const settings = readSettings_();
  if (settings.RECEIPT_PROOF_FOLDER_ID) {
    try { return DriveApp.getFolderById(settings.RECEIPT_PROOF_FOLDER_ID); } catch (ignore) {}
  }
  const root = DriveApp.getFolderById(
    requireValue_(settings.ARCHIVE_FOLDER_ID, 'ARCHIVE_FOLDER_ID pada SETTINGS'));
  const matches = root.getFoldersByName('BUKTI PENERIMAAN ARSIP');
  const folder = matches.hasNext() ? matches.next() : root.createFolder('BUKTI PENERIMAAN ARSIP');
  updateReceiptSetting_('RECEIPT_PROOF_FOLDER_ID', folder.getId());
  updateReceiptSetting_('RECEIPT_PROOF_FOLDER_URL', folder.getUrl());
  return folder;
}

function updateReceiptSetting_(key, value) {
  const row = readObjects_(APP_CONFIG.SHEETS.SETTINGS)
    .find(item => String(item.KEY) === String(key));
  if (row) updateObjectAtRow_(APP_CONFIG.SHEETS.SETTINGS, row._rowNumber, {VALUE: value});
}

function receiptUploadPropertyKey_(sessionId) {
  return RECEIPT_UPLOAD_PROPERTY_PREFIX_ +
    cleanText_(requireValue_(sessionId, 'ID sesi upload bukti'), 100);
}

function saveReceiptUploadSession_(session) {
  PropertiesService.getScriptProperties()
    .setProperty(receiptUploadPropertyKey_(session.sessionId), JSON.stringify(session));
}

function getReceiptUploadSession_(sessionId) {
  const value = PropertiesService.getScriptProperties()
    .getProperty(receiptUploadPropertyKey_(sessionId));
  if (!value) {
    throw new Error('UPLOAD_SESSION_NOT_FOUND: Sesi upload bukti tidak ditemukan. Mulai ulang upload.');
  }
  const session = JSON.parse(value);
  if (session.userEmail && session.userEmail !== getCurrentUser_()) {
    throw new Error('Sesi upload bukti dibuat oleh pengguna lain.');
  }
  return session;
}

function receiptUploadProgress_(session) {
  return {
    ok: true,
    sessionId: session.sessionId,
    chunkSize: RECEIPT_UPLOAD_CHUNK_SIZE_,
    uploadedBytes: Number(session.uploadedBytes || 0),
    fileSize: Number(session.fileSize || 0),
    complete: Boolean(session.driveFileId),
    committed: Boolean(session.committed),
    result: session.commitResult || null
  };
}

function getReceiptContext_(receiptId) {
  const id = cleanText_(requireValue_(receiptId, 'ID tanda terima'), 90);
  const receipt = readObjects_(RECEIPT_SHEET_)
    .find(row => String(row.PENERIMAAN_ID) === id);
  if (!receipt) throw new Error('Tanda terima tidak ditemukan.');
  const items = readObjects_(RECEIPT_ITEM_SHEET_)
    .filter(row => String(row.PENERIMAAN_ID) === id && !receiptBoolean_(row.IS_DELETED))
    .sort((a, b) => Number(a.NO_ITEM || 0) - Number(b.NO_ITEM || 0));
  if (!items.length) throw new Error('Tanda terima tidak memiliki item aktif.');
  return {receipt: receipt, items: items};
}

function receiptEmployeeOption_(row) {
  return {
    id: String(row.PEGAWAI_ID || ''),
    name: cleanText_(row.NAMA_PEGAWAI, 250),
    unit: cleanText_(row.UNIT_KERJA, 250),
    label: cleanText_(row.NAMA_PEGAWAI, 250) + ' — ' + cleanText_(row.UNIT_KERJA, 250)
  };
}

function receiptItemPresentation_(row) {
  const filingStatus = normalizeReceiptFilingStatus_(row);
  return {
    id: String(row.PENERIMAAN_ITEM_ID || ''),
    archiveId: String(row.ARSIP_ID || ''),
    number: Number(row.NO_ITEM || 0),
    description: cleanText_(row.URAIAN_INFORMASI, 2000),
    pageCount: Number(row.JUMLAH_HALAMAN || 0),
    developmentLevel: String(row.TINGKAT_PERKEMBANGAN || '').toUpperCase(),
    condition: String(row.KONDISI || '').toUpperCase(),
    securityClassification: centralFileMetadataNormalizeSecurity_(
      row.KLASIFIKASI_KEAMANAN_AKSES),
    primaryLetterNumber: cleanText_(row.NO_SURAT_UTAMA, 250),
    alternateLetterNumber: cleanText_(row.NO_SURAT_ALTERNATIF, 250),
    documentDate: row.TANGGAL_NASKAH ? dateKey_(row.TANGGAL_NASKAH) : '',
    notes: cleanText_(row.CATATAN_ITEM, 1000),
    filingStatus: filingStatus,
    filedBerkasId: String(row.BERKAS_ID_TUJUAN || ''),
    filedItemId: String(row.ITEM_ID_DEFINITIF || ''),
    filedBerkasNumber: String(row.NO_BERKAS_DEFINITIF_SNAPSHOT || ''),
    filedItemNumber: String(row.NO_ITEM_DEFINITIF_SNAPSHOT || ''),
    metadataComplete: receiptItemMetadataComplete_(row),
    canEdit: filingStatus !== RECEIPT_FILING_FILED_ &&
      filingStatus !== RECEIPT_FILING_CANCELLED_
  };
}

function receiptPresentation_(row, items) {
  const status = String(row.STATUS || RECEIPT_STATUS_ACTIVE_).toUpperCase();
  const evidenceUrl = String(row.BUKTI_TTD_URL || '');
  const filedCount = items.filter(item =>
    item.filingStatus === RECEIPT_FILING_FILED_).length;
  const incompleteCount = items.filter(item =>
    item.filingStatus === RECEIPT_FILING_INCOMPLETE_).length;
  const pendingCount = items.filter(item =>
    item.filingStatus === RECEIPT_FILING_PENDING_).length;
  const canCompleteMetadata = status === RECEIPT_STATUS_ACTIVE_ &&
    incompleteCount > 0;
  const hasEditableUnfiledItem = pendingCount > 0 || incompleteCount > 0;
  return {
    id: String(row.PENERIMAAN_ID || ''),
    number: String(row.NOMOR_TANDA_TERIMA || ''),
    year: Number(row.TAHUN || 0),
    receivedAt: String(row.TANGGAL_WAKTU_TERIMA || ''),
    senderEmployeeId: String(row.PENYERAH_PEGAWAI_ID || ''),
    senderName: cleanText_(row.NAMA_PENYERAH_SNAPSHOT, 250),
    senderUnit: cleanText_(row.UNIT_PENYERAH_SNAPSHOT, 250),
    receiverName: cleanText_(row.NAMA_PENERIMA, 250),
    receiverUnit: cleanText_(row.UNIT_PENERIMA, 250),
    location: cleanText_(row.LOKASI || 'Surabaya', 100),
    notes: cleanText_(row.CATATAN_UMUM, 2000),
    itemCount: Number(row.JUMLAH_ITEM || items.length),
    totalPages: Number(row.TOTAL_HALAMAN || items.reduce((sum, item) => sum + item.pageCount, 0)),
    status: status,
    statusLabel: status === RECEIPT_STATUS_CANCELLED_ ? 'DIBATALKAN' : 'AKTIF',
    evidenceUrl: evidenceUrl,
    evidenceName: String(row.BUKTI_TTD_NAMA || ''),
    cancellationReason: cleanText_(row.ALASAN_PEMBATALAN, 2000),
    cancellationProofUrl: String(row.BATAL_BUKTI_URL || ''),
    cancelledAt: String(row.DIBATALKAN_AT || ''),
    filedCount: filedCount,
    pendingCount: pendingCount,
    incompleteCount: incompleteCount,
    filingProgressLabel: filedCount + ' dari ' + items.length +
      ' item sudah diberkaskan',
    canEditHeader: status === RECEIPT_STATUS_ACTIVE_ &&
      !evidenceUrl && !row.BUKTI_TTD_FILE_ID && filedCount === 0,
    canEdit: status === RECEIPT_STATUS_ACTIVE_ &&
      (canCompleteMetadata ||
        ((!evidenceUrl && !row.BUKTI_TTD_FILE_ID) &&
          hasEditableUnfiledItem)),
    canCompleteMetadata: canCompleteMetadata,
    items: items
  };
}

function receiptBoolean_(value) {
  return value === true || String(value || '').toUpperCase() === 'TRUE';
}

function receiptSearchKey_(value) {
  return String(value || '').toUpperCase().replace(/\s+/g, ' ').trim();
}

function receiptNaturalCompare_(a, b) {
  return String(a || '').localeCompare(String(b || ''), 'id', {
    numeric: true,
    sensitivity: 'base'
  });
}
