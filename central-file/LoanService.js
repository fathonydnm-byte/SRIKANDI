var LOAN_UPLOAD_PROPERTY_PREFIX_ = 'LOAN_EVIDENCE_SESSION_';
var LOAN_UPLOAD_CHUNK_SIZE_ = 512 * 1024;
var LOAN_UPLOAD_MAX_SIZE_ = 25 * 1024 * 1024;
var LOAN_ACTIVE_STATUS_ = 'DIPINJAM';
var LOAN_RETURNED_STATUS_ = 'KEMBALI';
var LOAN_FAST_API_COLUMN_LIMIT_ = 'AZ';
var LOAN_MAX_ITEMS_PER_GROUP_ = 100;
var LOAN_OUT_INDICATOR_LOG_HEADERS_ = [
  'PRINT_ID', 'TIMESTAMP', 'USER_EMAIL', 'LOAN_GROUP_ID',
  'PEMINJAMAN_IDS', 'JENIS_OBJEK', 'BERKAS_ID',
  'NO_BERKAS_SNAPSHOT', 'LOKASI_ASAL_SNAPSHOT',
  'PDF_FILE_NAME', 'STATUS'
];
var LOAN_REQUIRED_HEADERS_ = [
  'PEMINJAMAN_ID', 'LOAN_GROUP_ID', 'JENIS_OBJEK', 'BERKAS_ID', 'ITEM_ID',
  'NO_BERKAS_SNAPSHOT', 'NO_ITEM_SNAPSHOT', 'URAIAN_OBJEK_SNAPSHOT',
  'NAMA_PEMINJAM', 'NIP_NIK', 'UNIT_KERJA', 'NO_WHATSAPP', 'KEPERLUAN',
  'TANGGAL_PINJAM', 'TANGGAL_WAJIB_KEMBALI', 'TANGGAL_KEMBALI',
  'JUMLAH_HALAMAN_ITEM', 'JUMLAH_HALAMAN_GRUP_SNAPSHOT',
  'LOKASI_ASAL_SNAPSHOT', 'NO_FILLING_KABINET_SNAPSHOT',
  'NO_LACI_SNAPSHOT', 'NO_FOLDER_SNAPSHOT', 'BUKTI_PERSETUJUAN_FILE_ID',
  'BUKTI_PERSETUJUAN_URL', 'STATUS', 'CATATAN',
  'CREATED_AT', 'CREATED_BY', 'UPDATED_AT', 'UPDATED_BY'
];

function getLoanOptions_() {
  ensureLoanSchema_();
  const berkas = readObjects_(APP_CONFIG.SHEETS.BERKAS)
    .filter(row => !isDeleted_(row) &&
      String(row.STATUS_PEMINDAHAN || '').toUpperCase() !== 'SUDAH DIPINDAHKAN')
    .sort((a, b) => naturalCompare_(a.NO_BERKAS_DEFINITIF || '999999', b.NO_BERKAS_DEFINITIF || '999999'));
  const activeBerkas = {};
  berkas.forEach(row => activeBerkas[row.BERKAS_ID] = row);
  const items = readObjects_(APP_CONFIG.SHEETS.ITEM)
    .filter(row => !isDeleted_(row) && activeBerkas[row.BERKAS_ID])
    .sort((a, b) => {
      const parentCompare = naturalCompare_(a.NO_BERKAS_SNAPSHOT || '999999', b.NO_BERKAS_SNAPSHOT || '999999');
      return parentCompare || naturalCompare_(a.NO_ITEM_DEFINITIF || '999999', b.NO_ITEM_DEFINITIF || '999999');
    });
  const loans = readObjects_(APP_CONFIG.SHEETS.PEMINJAMAN)
    .filter(row => cleanText_(row.PEMINJAMAN_ID, 80));
  const synchronization = synchronizeLoanObjectStatuses_(berkas, items, loans);
  const activeLoanRows = loans.filter(isActiveLoan_);
  const activity = loanActivityIndex_(activeLoanRows);
  const today = loanTodayKey_();
  const berkasById = {};
  const itemById = {};
  berkas.forEach(row => berkasById[row.BERKAS_ID] = row);
  items.forEach(row => itemById[row.ITEM_ID] = row);
  const itemsByBerkas = {};
  items.forEach(row => {
    if (!itemsByBerkas[row.BERKAS_ID]) itemsByBerkas[row.BERKAS_ID] = [];
    itemsByBerkas[row.BERKAS_ID].push(loanItemOption_(row, activity));
  });
  const presentedLoans = presentLoanGroups_(loans, berkasById, itemById, today)
    .sort((a, b) => {
      const activeRank = {OVERDUE: 0, ACTIVE: 1, RETURNED: 2};
      return activeRank[a.statusCode] - activeRank[b.statusCode] ||
        String(b.borrowDate || '').localeCompare(String(a.borrowDate || '')) ||
        String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });
  const summary = {
    active: presentedLoans.filter(row => row.statusCode !== 'RETURNED').length,
    overdue: presentedLoans.filter(row => row.statusCode === 'OVERDUE').length,
    borrowedBerkas: activeLoanRows.filter(row => loanObjectType_(row) === 'BERKAS').length,
    borrowedItems: activeLoanRows.filter(row => loanObjectType_(row) === 'ITEM').length,
    returned: presentedLoans.filter(row => row.statusCode === 'RETURNED').length
  };
  return {
    ok: true,
    today: today,
    summary: summary,
    berkas: berkas.map(row => loanBerkasOption_(row, itemsByBerkas[row.BERKAS_ID] || [], activity)),
    itemsByBerkas: itemsByBerkas,
    loans: presentedLoans,
    synchronizedObjects: synchronization.updated
  };
}

function loanBerkasOption_(row, itemOptions, activityOrLoans) {
  const activity = Array.isArray(activityOrLoans)
    ? loanActivityIndex_(activityOrLoans) : (activityOrLoans || loanActivityIndex_([]));
  const fullLoan = activity.wholeByBerkas[String(row.BERKAS_ID)] || null;
  const itemLoanCount = Number(activity.itemCountByBerkas[String(row.BERKAS_ID)] || 0);
  const status = fullLoan ? 'DIPINJAM' : itemLoanCount ? 'SEBAGIAN DIPINJAM' : 'TERSEDIA';
  const number = row.NO_BERKAS_DEFINITIF || '';
  return {
    id: row.BERKAS_ID,
    number: number,
    title: row.JUDUL_BERKAS || '',
    classificationCode: row.KODE_KLASIFIKASI_SNAPSHOT || '',
    location: loanLocationLabel_(row),
    itemCount: itemOptions.length,
    pageCount: itemOptions.reduce((sum, item) => sum + Number(item.pageCount || 0), 0),
    loanStatus: status,
    fullLoanBlocked: Boolean(fullLoan || itemLoanCount),
    fullLoanBlockingReason: fullLoan
      ? 'Berkas sudah mempunyai peminjaman aktif.'
      : itemLoanCount ? 'Satu atau lebih item dalam berkas sedang dipinjam.' : '',
    label: (number || 'DRAFT') + ' – ' + (row.JUDUL_BERKAS || 'Tanpa judul')
  };
}

function loanItemOption_(row, activityOrLoans) {
  const activity = Array.isArray(activityOrLoans)
    ? loanActivityIndex_(activityOrLoans) : (activityOrLoans || loanActivityIndex_([]));
  const wholeLoan = Boolean(activity.wholeByBerkas[String(row.BERKAS_ID)]);
  const itemLoan = Boolean(activity.itemById[String(row.ITEM_ID)]);
  const status = wholeLoan ? 'DIPINJAM DALAM BERKAS' : itemLoan ? 'DIPINJAM' : 'TERSEDIA';
  return {
    id: row.ITEM_ID,
    berkasId: row.BERKAS_ID,
    number: row.NO_ITEM_DEFINITIF || '',
    documentDate: row.TANGGAL_NASKAH ? dateKey_(row.TANGGAL_NASKAH) : '',
    description: row.URAIAN_LENGKAP || '',
    pageCount: Number(row.JUMLAH_HALAMAN || 0),
    loanStatus: status,
    label: (row.NO_ITEM_DEFINITIF || '–') + ' – ' + cleanText_(row.URAIAN_LENGKAP || 'Tanpa uraian', 160)
  };
}

function loanPresentation_(row, berkasById, itemById, today) {
  const objectType = loanObjectType_(row);
  const berkasId = loanBerkasId_(row);
  const itemId = loanItemId_(row);
  const parent = berkasById[berkasId] || {};
  const item = itemById[itemId] || {};
  const active = isActiveLoan_(row);
  const dueDate = row.TANGGAL_WAJIB_KEMBALI ? dateKey_(row.TANGGAL_WAJIB_KEMBALI) : '';
  const overdue = active && dueDate && dueDate < today;
  const statusCode = active ? (overdue ? 'OVERDUE' : 'ACTIVE') : 'RETURNED';
  const statusLabel = statusCode === 'OVERDUE' ? 'TERLAMBAT' :
    statusCode === 'ACTIVE' ? 'DIPINJAM' : 'SUDAH KEMBALI';
  const title = objectType === 'ITEM'
    ? cleanText_(row.URAIAN_OBJEK_SNAPSHOT || item.URAIAN_LENGKAP || 'Item arsip', 500)
    : cleanText_(row.URAIAN_OBJEK_SNAPSHOT || parent.JUDUL_BERKAS || 'Berkas arsip', 500);
  return {
    id: row.PEMINJAMAN_ID,
    groupId: loanGroupId_(row),
    objectType: objectType,
    berkasId: berkasId,
    itemId: itemId,
    berkasNumber: row.NO_BERKAS_SNAPSHOT || parent.NO_BERKAS_DEFINITIF || '',
    itemNumber: row.NO_ITEM_SNAPSHOT || item.NO_ITEM_DEFINITIF || '',
    title: title,
    borrowerName: row.NAMA_PEMINJAM || '',
    borrowerIdentity: row.NIP_NIK || '',
    borrowerUnit: row.UNIT_KERJA || '',
    whatsapp: row.NO_WHATSAPP || '',
    purpose: row.KEPERLUAN || '',
    borrowDate: row.TANGGAL_PINJAM ? dateKey_(row.TANGGAL_PINJAM) : '',
    dueDate: dueDate,
    returnedDate: row.TANGGAL_KEMBALI ? dateKey_(row.TANGGAL_KEMBALI) : '',
    pageCount: Number(row.JUMLAH_HALAMAN_ITEM || 0),
    groupPageCount: Number(row.JUMLAH_HALAMAN_GRUP_SNAPSHOT || row.JUMLAH_HALAMAN_ITEM || 0),
    originalLocation: row.LOKASI_ASAL_SNAPSHOT || loanLocationLabel_(parent),
    evidenceUrl: row.BUKTI_PERSETUJUAN_URL || '',
    notes: row.CATATAN || '',
    statusCode: statusCode,
    statusLabel: statusLabel,
    overdueDays: overdue ? Math.max(1, -retentionDayDifference_(today, dueDate)) : 0,
    createdAt: row.CREATED_AT || '',
    createdBy: row.CREATED_BY || '',
    updatedAt: row.UPDATED_AT || '',
    updatedBy: row.UPDATED_BY || ''
  };
}

function presentLoanGroups_(rows, berkasById, itemById, today) {
  const grouped = {};
  (rows || []).forEach(row => {
    const groupId = loanGroupId_(row);
    if (!grouped[groupId]) grouped[groupId] = [];
    grouped[groupId].push(row);
  });
  return Object.keys(grouped).map(groupId => {
    const records = grouped[groupId];
    const presented = records.map(row =>
      loanPresentation_(row, berkasById, itemById, today));
    const first = presented[0];
    const activeRows = presented.filter(row => row.statusCode !== 'RETURNED');
    const statusCode = activeRows.length
      ? (activeRows.some(row => row.statusCode === 'OVERDUE') ? 'OVERDUE' : 'ACTIVE')
      : 'RETURNED';
    const itemRows = presented.filter(row => row.objectType === 'ITEM');
    const itemNumbers = itemRows.map(row => row.itemNumber).filter(Boolean);
    const itemTitles = itemRows.map(row => row.title).filter(Boolean);
    const title = itemRows.length > 1
      ? itemRows.length + ' item arsip dalam berkas ' + (first.berkasNumber || '–')
      : first.title;
    return {
      id: groupId,
      groupId: groupId,
      loanIds: presented.map(row => row.id),
      objectType: first.objectType,
      berkasId: first.berkasId,
      itemId: itemRows.length === 1 ? itemRows[0].itemId : '',
      itemIds: itemRows.map(row => row.itemId),
      berkasNumber: first.berkasNumber,
      itemNumber: itemRows.length === 1 ? itemRows[0].itemNumber : '',
      itemNumbers: itemNumbers,
      itemCount: itemRows.length,
      itemTitles: itemTitles,
      title: title,
      borrowerName: first.borrowerName,
      borrowerIdentity: first.borrowerIdentity,
      borrowerUnit: first.borrowerUnit,
      whatsapp: first.whatsapp,
      purpose: first.purpose,
      borrowDate: first.borrowDate,
      dueDate: first.dueDate,
      returnedDate: statusCode === 'RETURNED'
        ? presented.map(row => row.returnedDate).filter(Boolean).sort().pop() || '' : '',
      pageCount: Number(first.groupPageCount ||
        presented.reduce((sum, row) => sum + Number(row.pageCount || 0), 0)),
      evidenceUrl: first.evidenceUrl,
      notes: first.notes,
      originalLocation: first.originalLocation,
      statusCode: statusCode,
      statusLabel: statusCode === 'OVERDUE' ? 'TERLAMBAT' :
        statusCode === 'ACTIVE' ? 'DIPINJAM' : 'SUDAH KEMBALI',
      overdueDays: statusCode === 'OVERDUE'
        ? Math.max.apply(null, activeRows.map(row => Number(row.overdueDays || 0))) : 0,
      createdAt: first.createdAt,
      createdBy: first.createdBy,
      updatedAt: presented.map(row => row.updatedAt).filter(Boolean).sort().pop() || '',
      updatedBy: first.updatedBy
    };
  });
}

function createLoan_(form, preUploadedEvidenceId, evidenceOriginalName) {
  const startedAt = Date.now();
  const performance = {
    path: 'SPREADSHEET_FALLBACK',
    lockWaitMs: 0,
    readMs: 0,
    validationMs: 0,
    evidenceMs: 0,
    writeMs: 0
  };
  const lock = LockService.getScriptLock();
  const lockStartedAt = Date.now();
  lock.waitLock(30000);
  performance.lockWaitMs = Date.now() - lockStartedAt;
  try {
    if (canUseLoanSheetsApiFastPath_()) {
      try {
        return createLoanWithSheetsApi_(form, preUploadedEvidenceId,
          evidenceOriginalName, startedAt, performance);
      } catch (fastError) {
        if (!fastError.loanFastPathTransportFailure) throw fastError;
        performance.path = 'SPREADSHEET_FALLBACK';
        performance.fastPathError = cleanText_(fastError.message, 300);
      }
    }
    return createLoanWithSpreadsheetService_(form, preUploadedEvidenceId,
      evidenceOriginalName, startedAt, performance);
  } catch (error) {
    audit_('BORROW', 'PEMINJAMAN', 'SISTEM', form && form.loanPreviewId || '',
      'Pencatatan peminjaman gagal', error.message, 'FAILED');
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function createLoanWithSheetsApi_(form, preUploadedEvidenceId, evidenceOriginalName,
    startedAt, performance) {
  performance.path = 'SHEETS_API_BATCH';
  const readStartedAt = Date.now();
  const snapshot = readLoanFastSnapshot_();
  performance.readMs = Date.now() - readStartedAt;
  const recovered = findCommittedLoanResult_(form && form.loanPreviewId, snapshot.loans);
  if (recovered) return enrichLoanPerformance_(recovered, startedAt, performance);

  const validationStartedAt = Date.now();
  const context = resolveLoanContext_(form, {
    loans: snapshot.loans,
    berkas: snapshot.berkas,
    items: snapshot.items
  });
  performance.validationMs = Date.now() - validationStartedAt;

  const evidenceStartedAt = Date.now();
  const evidence = saveLoanEvidence_(context, preUploadedEvidenceId, evidenceOriginalName);
  performance.evidenceMs = Date.now() - evidenceStartedAt;
  const timestamp = nowIso_();
  const user = getCurrentUser_();
  const records = buildLoanRecords_(context, evidence, timestamp, user);
  const statusPlan = planLoanObjectStatusUpdates_(
    [context.parent],
    context.allItems,
    snapshot.loans.concat(records)
  );
  const auditRecord = buildLoanAuditRecord_(context, evidence, timestamp, user);

  const writeStartedAt = Date.now();
  try {
    writeLoanFastBatch_(snapshot, records, statusPlan, auditRecord);
  } catch (error) {
    error.loanFastPathTransportFailure = true;
    throw error;
  }
  performance.writeMs = Date.now() - writeStartedAt;
  return buildLoanSuccessResult_(context, evidence, records, startedAt, performance);
}

function createLoanWithSpreadsheetService_(form, preUploadedEvidenceId,
    evidenceOriginalName, startedAt, performance) {
  ensureLoanSchema_();
  const readStartedAt = Date.now();
  const loanRows = readObjects_(APP_CONFIG.SHEETS.PEMINJAMAN);
  const recovered = findCommittedLoanResult_(form && form.loanPreviewId, loanRows);
  if (recovered) return enrichLoanPerformance_(recovered, startedAt, performance);
  const berkasRows = readObjects_(APP_CONFIG.SHEETS.BERKAS);
  const itemRows = readObjects_(APP_CONFIG.SHEETS.ITEM);
  performance.readMs = Date.now() - readStartedAt;

  const validationStartedAt = Date.now();
  const context = resolveLoanContext_(form, {
    loans: loanRows,
    berkas: berkasRows,
    items: itemRows
  });
  performance.validationMs = Date.now() - validationStartedAt;

  const evidenceStartedAt = Date.now();
  const evidence = saveLoanEvidence_(context, preUploadedEvidenceId, evidenceOriginalName);
  performance.evidenceMs = Date.now() - evidenceStartedAt;
  const timestamp = nowIso_();
  const user = getCurrentUser_();
  const records = buildLoanRecords_(context, evidence, timestamp, user);

  const writeStartedAt = Date.now();
  appendObjects_(APP_CONFIG.SHEETS.PEMINJAMAN, records);
  synchronizeLoanObjectStatuses_(
    [context.parent],
    context.allItems,
    loanRows.concat(records)
  );
  const auditRecord = buildLoanAuditRecord_(context, evidence, timestamp, user);
  audit_(auditRecord.AKSI, auditRecord.MODUL, auditRecord.JENIS_OBJEK,
    auditRecord.OBJEK_ID, auditRecord.RINGKASAN, auditRecord.ALASAN, auditRecord.STATUS);
  performance.writeMs = Date.now() - writeStartedAt;
  return buildLoanSuccessResult_(context, evidence, records, startedAt, performance);
}

function buildLoanRecords_(context, evidence, timestamp, user) {
  const targets = context.objectType === 'BERKAS' ? [null] : context.items;
  return targets.map((item, index) => ({
    PEMINJAMAN_ID: targets.length === 1
      ? context.loanGroupId
      : context.loanGroupId + '-' + String(index + 1).padStart(2, '0'),
    LOAN_GROUP_ID: context.loanGroupId,
    JENIS_OBJEK: context.objectType,
    BERKAS_ID: context.parent.BERKAS_ID,
    ITEM_ID: item ? item.ITEM_ID : '',
    NO_BERKAS_SNAPSHOT: context.parent.NO_BERKAS_DEFINITIF || '',
    NO_ITEM_SNAPSHOT: item ? item.NO_ITEM_DEFINITIF || '' : '',
    URAIAN_OBJEK_SNAPSHOT: item ? item.URAIAN_LENGKAP : context.parent.JUDUL_BERKAS,
    NAMA_PEMINJAM: context.borrowerName,
    NIP_NIK: context.identityNumber,
    UNIT_KERJA: context.workUnit,
    NO_WHATSAPP: context.whatsapp,
    KEPERLUAN: context.purpose,
    TANGGAL_PINJAM: context.borrowDate,
    TANGGAL_WAJIB_KEMBALI: context.dueDate,
    TANGGAL_KEMBALI: '',
    JUMLAH_HALAMAN_ITEM: item
      ? Number(item.JUMLAH_HALAMAN || 0) : context.automaticPages,
    JUMLAH_HALAMAN_GRUP_SNAPSHOT: context.pageCount,
    LOKASI_ASAL_SNAPSHOT: context.originalLocation,
    NO_FILLING_KABINET_SNAPSHOT: context.parent.NO_FILLING_KABINET || '',
    NO_LACI_SNAPSHOT: context.parent.NO_LACI || '',
    NO_FOLDER_SNAPSHOT: context.parent.NO_FOLDER || context.parent.NO_BERKAS_DEFINITIF || '',
    BUKTI_PERSETUJUAN_FILE_ID: evidence ? evidence.id : '',
    BUKTI_PERSETUJUAN_URL: evidence ? evidence.url : '',
    STATUS: LOAN_ACTIVE_STATUS_,
    CATATAN: context.notes,
    CREATED_AT: timestamp,
    CREATED_BY: user,
    UPDATED_AT: timestamp,
    UPDATED_BY: user
  }));
}

function buildLoanAuditRecord_(context, evidence, timestamp, user) {
  const objectNumber = context.objectType === 'BERKAS'
    ? (context.parent.NO_BERKAS_DEFINITIF || 'DRAFT')
    : (context.parent.NO_BERKAS_DEFINITIF || '–') + ' / item ' +
      context.items.map(item => item.NO_ITEM_DEFINITIF || '–').join(', ');
  return {
    LOG_ID: 'LOG-' + Utilities.getUuid(),
    TIMESTAMP: timestamp,
    USER_EMAIL: user,
    AKSI: 'BORROW',
    MODUL: 'PEMINJAMAN',
    JENIS_OBJEK: context.objectType === 'ITEM' && context.items.length > 1
      ? 'MULTI_ITEM' : context.objectType,
    OBJEK_ID: context.loanGroupId,
    RINGKASAN: 'Mencatat peminjaman ' + context.objectType.toLowerCase() +
      ' ' + objectNumber + ' oleh ' + context.borrowerName,
    ALASAN: context.purpose + (evidence ? ' | Bukti persetujuan: ' + evidence.url : ''),
    REQUEST_ID: 'REQ-' + Utilities.getUuid(),
    STATUS: 'SUCCESS'
  };
}

function buildLoanSuccessResult_(context, evidence, records, startedAt, performance) {
  const itemMap = {};
  context.items.forEach(item => itemMap[item.ITEM_ID] = item);
  const parentMap = {};
  parentMap[context.parent.BERKAS_ID] = context.parent;
  const presented = presentLoanGroups_(records, parentMap, itemMap, loanTodayKey_())[0];
  return enrichLoanPerformance_({
    ok: true,
    loanId: records[0].PEMINJAMAN_ID,
    loanGroupId: context.loanGroupId,
    loanIds: records.map(record => record.PEMINJAMAN_ID),
    berkasId: context.parent.BERKAS_ID,
    itemId: context.items.length === 1 ? context.items[0].ITEM_ID : '',
    itemIds: context.items.map(item => item.ITEM_ID),
    evidenceUrl: evidence ? evidence.url : '',
    loan: presented,
    message: 'Peminjaman berhasil dicatat dan status arsip diperbarui.'
  }, startedAt, performance);
}

function enrichLoanPerformance_(result, startedAt, performance) {
  result.durationMs = Date.now() - startedAt;
  result.performance = {
    path: performance.path,
    lockWaitMs: Number(performance.lockWaitMs || 0),
    readMs: Number(performance.readMs || 0),
    validationMs: Number(performance.validationMs || 0),
    evidenceMs: Number(performance.evidenceMs || 0),
    writeMs: Number(performance.writeMs || 0),
    totalMs: result.durationMs
  };
  if (performance.fastPathError) result.performance.fastPathError = performance.fastPathError;
  return result;
}

function canUseLoanSheetsApiFastPath_() {
  const advancedService = typeof Sheets !== 'undefined' &&
    Sheets.Spreadsheets && Sheets.Spreadsheets.Values;
  const directApi = typeof UrlFetchApp !== 'undefined' &&
    typeof ScriptApp !== 'undefined';
  return Boolean(APP_CONFIG && APP_CONFIG.SPREADSHEET_ID &&
    (advancedService || directApi));
}

function readLoanFastSnapshot_() {
  const ranges = [
    loanFastSheetRange_(APP_CONFIG.SHEETS.PEMINJAMAN, 'A:' + LOAN_FAST_API_COLUMN_LIMIT_),
    loanFastSheetRange_(APP_CONFIG.SHEETS.BERKAS, 'A:' + LOAN_FAST_API_COLUMN_LIMIT_),
    loanFastSheetRange_(APP_CONFIG.SHEETS.ITEM, 'A:' + LOAN_FAST_API_COLUMN_LIMIT_),
    loanFastSheetRange_(APP_CONFIG.SHEETS.AUDIT, '1:1'),
    loanFastSheetRange_(APP_CONFIG.SHEETS.AUDIT, 'A:A')
  ];
  const response = loanFastBatchGet_(ranges);
  const valueRanges = response.valueRanges || [];
  if (valueRanges.length !== ranges.length) {
    throw loanFastTransportError_('Sheets API tidak mengembalikan seluruh rentang transaksi.');
  }
  const loanTable = loanFastTable_(valueRanges[0], APP_CONFIG.SHEETS.PEMINJAMAN);
  const berkasTable = loanFastTable_(valueRanges[1], APP_CONFIG.SHEETS.BERKAS);
  const itemTable = loanFastTable_(valueRanges[2], APP_CONFIG.SHEETS.ITEM);
  const auditTable = loanFastTable_(valueRanges[3], APP_CONFIG.SHEETS.AUDIT);
  auditTable.nextRow = Math.max(
    2,
    Number(valueRanges[4] && valueRanges[4].values && valueRanges[4].values.length || 0) + 1
  );
  const missingLoanHeaders = LOAN_REQUIRED_HEADERS_
    .filter(header => loanTable.headers.indexOf(header) === -1);
  if (missingLoanHeaders.length) {
    throw new Error('Struktur sheet PEMINJAMAN belum lengkap. Kolom yang hilang: ' +
      missingLoanHeaders.join(', ') + '.');
  }
  assertLoanFastHeader_(berkasTable, 'BERKAS_ID');
  assertLoanFastHeader_(berkasTable, 'STATUS_PEMINJAMAN');
  assertLoanFastHeader_(itemTable, 'ITEM_ID');
  assertLoanFastHeader_(itemTable, 'BERKAS_ID');
  assertLoanFastHeader_(itemTable, 'STATUS_PEMINJAMAN');
  ['LOG_ID', 'TIMESTAMP', 'USER_EMAIL', 'AKSI', 'MODUL', 'JENIS_OBJEK',
    'OBJEK_ID', 'RINGKASAN', 'ALASAN', 'REQUEST_ID', 'STATUS']
    .forEach(header => assertLoanFastHeader_(auditTable, header));
  return {
    loans: loanTable.objects,
    berkas: berkasTable.objects,
    items: itemTable.objects,
    loanTable: loanTable,
    berkasTable: berkasTable,
    itemTable: itemTable,
    auditTable: auditTable
  };
}

function loanFastTable_(valueRange, sheetName) {
  const values = valueRange && valueRange.values || [];
  const headers = (values[0] || []).map(value => String(value || '').trim());
  if (!headers.length) throw new Error('Header tidak ditemukan pada ' + sheetName + '.');
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

function assertLoanFastHeader_(table, header) {
  if (table.headers.indexOf(header) === -1) {
    throw new Error('Kolom ' + header + ' tidak ditemukan pada sheet ' + table.sheetName + '.');
  }
}

function writeLoanFastBatch_(snapshot, records, statusPlan, auditRecord) {
  const data = (records || []).map((record, index) =>
    loanFastRowUpdate_(snapshot.loanTable, snapshot.loanTable.nextRow + index, record));
  data.push(loanFastRowUpdate_(snapshot.auditTable, snapshot.auditTable.nextRow, auditRecord));
  statusPlan.berkasUpdates.forEach(update => data.push(loanFastCellUpdate_(
    snapshot.berkasTable, update.rowNumber, 'STATUS_PEMINJAMAN',
    update.changes.STATUS_PEMINJAMAN
  )));
  statusPlan.itemUpdates.forEach(update => data.push(loanFastCellUpdate_(
    snapshot.itemTable, update.rowNumber, 'STATUS_PEMINJAMAN',
    update.changes.STATUS_PEMINJAMAN
  )));
  loanFastBatchUpdate_({
    valueInputOption: 'RAW',
    includeValuesInResponse: false,
    data: data
  });
}

function loanFastRowUpdate_(table, rowNumber, object) {
  const lastColumn = loanFastColumnLetter_(table.headers.length);
  return {
    range: loanFastSheetRange_(table.sheetName,
      'A' + rowNumber + ':' + lastColumn + rowNumber),
    majorDimension: 'ROWS',
    values: [table.headers.map(header =>
      Object.prototype.hasOwnProperty.call(object, header) ? object[header] : '')]
  };
}

function loanFastCellUpdate_(table, rowNumber, header, value) {
  const column = table.headers.indexOf(header) + 1;
  if (column < 1) throw new Error('Kolom ' + header + ' tidak ditemukan pada ' + table.sheetName + '.');
  const a1 = loanFastColumnLetter_(column) + Number(rowNumber);
  return {
    range: loanFastSheetRange_(table.sheetName, a1),
    majorDimension: 'ROWS',
    values: [[value]]
  };
}

function loanFastColumnLetter_(columnNumber) {
  let number = Number(columnNumber);
  if (!Number.isInteger(number) || number < 1) throw new Error('Nomor kolom tidak valid.');
  let result = '';
  while (number > 0) {
    const remainder = (number - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    number = Math.floor((number - 1) / 26);
  }
  return result;
}

function loanFastSheetRange_(sheetName, range) {
  return "'" + String(sheetName || '').replace(/'/g, "''") + "'!" + range;
}

function loanFastBatchGet_(ranges) {
  if (typeof Sheets !== 'undefined' &&
      Sheets.Spreadsheets && Sheets.Spreadsheets.Values) {
    try {
      return Sheets.Spreadsheets.Values.batchGet(APP_CONFIG.SPREADSHEET_ID, {
        ranges: ranges,
        majorDimension: 'ROWS',
        valueRenderOption: 'FORMATTED_VALUE'
      });
    } catch (error) {
      throw loanFastTransportError_('Layanan Sheets batch gagal membaca data: ' + error.message);
    }
  }
  const query = ranges.map(range => 'ranges=' + encodeURIComponent(range)).join('&');
  return loanFastApiFetch_(
    '/values:batchGet?majorDimension=ROWS&valueRenderOption=FORMATTED_VALUE&' + query,
    'get'
  );
}

function loanFastBatchUpdate_(payload) {
  if (typeof Sheets !== 'undefined' &&
      Sheets.Spreadsheets && Sheets.Spreadsheets.Values) {
    try {
      return Sheets.Spreadsheets.Values.batchUpdate(
        payload,
        APP_CONFIG.SPREADSHEET_ID
      );
    } catch (error) {
      throw loanFastTransportError_('Layanan Sheets batch gagal menulis data: ' + error.message);
    }
  }
  return loanFastApiFetch_('/values:batchUpdate', 'post', payload);
}

function loanFastApiFetch_(path, method, payload) {
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
    throw loanFastTransportError_('Koneksi batch Google Sheets gagal: ' + error.message);
  }
  const responseCode = response.getResponseCode();
  const responseText = response.getContentText();
  if (responseCode < 200 || responseCode >= 300) {
    let apiMessage = '';
    try {
      const parsed = JSON.parse(responseText);
      apiMessage = parsed && parsed.error && parsed.error.message || '';
    } catch (ignore) {}
    throw loanFastTransportError_('Google Sheets batch API HTTP ' + responseCode +
      (apiMessage ? ': ' + cleanText_(apiMessage, 250) : ''));
  }
  if (!responseText) return {};
  try {
    return JSON.parse(responseText);
  } catch (error) {
    throw loanFastTransportError_('Respons Google Sheets batch API tidak valid.');
  }
}

function loanFastTransportError_(message) {
  const error = new Error(message);
  error.loanFastPathTransportFailure = true;
  return error;
}

function resolveLoanContext_(form, data) {
  form = form || {};
  data = data || {};
  const objectType = String(requireValue_(form.loanObjectType, 'Objek peminjaman')).toUpperCase();
  if (['BERKAS', 'ITEM'].indexOf(objectType) === -1) throw new Error('Objek peminjaman tidak valid.');
  const loanGroupId = cleanText_(form.loanPreviewId, 70) || 'LOAN-' + Utilities.getUuid();
  const loanRows = data.loans || readObjects_(APP_CONFIG.SHEETS.PEMINJAMAN);
  const existing = loanRows.find(row => loanGroupId_(row) === loanGroupId ||
    String(row.PEMINJAMAN_ID) === loanGroupId);
  if (existing) throw new Error('Transaksi ini sudah tersimpan. Segarkan halaman untuk melihat status terbaru.');
  const berkasId = cleanText_(requireValue_(form.loanBerkasId, 'Berkas induk'), 80);
  const berkasRows = data.berkas || readObjects_(APP_CONFIG.SHEETS.BERKAS);
  const parent = berkasRows.find(row => row.BERKAS_ID === berkasId && !isDeleted_(row));
  if (!parent) throw new Error('Berkas tidak ditemukan atau sudah dihapus.');
  if (String(parent.STATUS_PEMINDAHAN || '').toUpperCase() === 'SUDAH DIPINDAHKAN') {
    throw new Error('Berkas sudah dipindahkan dari arsip aktif dan tidak dapat dipinjam melalui modul ini.');
  }
  const itemRows = data.items || readObjects_(APP_CONFIG.SHEETS.ITEM);
  const allItems = itemRows.filter(row => row.BERKAS_ID === berkasId && !isDeleted_(row));
  if (!allItems.length) throw new Error('Berkas belum mempunyai item aktif.');
  let item = null;
  let items = [];
  if (objectType === 'ITEM') {
    let requestedIds = [];
    if (form.loanItemIdsJson) {
      try {
        const parsed = JSON.parse(String(form.loanItemIdsJson));
        if (Array.isArray(parsed)) requestedIds = parsed;
      } catch (error) {
        throw new Error('Daftar item peminjaman tidak valid. Pilih ulang item arsip.');
      }
    }
    if (!requestedIds.length && form.loanItemId) requestedIds = [form.loanItemId];
    requestedIds = Array.from(new Set(requestedIds
      .map(value => cleanText_(value, 80)).filter(Boolean)));
    if (!requestedIds.length) throw new Error('Pilih minimal satu item arsip.');
    if (requestedIds.length > LOAN_MAX_ITEMS_PER_GROUP_) {
      throw new Error('Maksimal ' + LOAN_MAX_ITEMS_PER_GROUP_ +
        ' item dalam satu transaksi peminjaman.');
    }
    const byId = {};
    allItems.forEach(row => byId[String(row.ITEM_ID)] = row);
    const missingIds = requestedIds.filter(itemId => !byId[itemId]);
    if (missingIds.length) throw new Error('Sebagian item tidak ditemukan atau sudah dihapus.');
    items = requestedIds.map(itemId => byId[itemId]);
    item = items[0];
  }
  assertLoanAvailability_(objectType, parent, items, allItems, loanRows);
  const borrowerName = cleanText_(requireValue_(form.borrowerName, 'Nama peminjam'), 250);
  const workUnit = cleanText_(requireValue_(form.borrowerUnit, 'Unit kerja'), 250);
  const purpose = cleanText_(requireValue_(form.loanPurpose, 'Keperluan'), 1000);
  const borrowDate = loanDateKey_(requireValue_(form.loanDate, 'Tanggal pinjam'), 'Tanggal pinjam');
  const dueDate = loanDateKey_(requireValue_(form.loanDueDate, 'Tanggal wajib kembali'), 'Tanggal wajib kembali');
  if (borrowDate > loanTodayKey_()) throw new Error('Tanggal pinjam tidak boleh berada di masa depan.');
  if (dueDate < borrowDate) throw new Error('Tanggal wajib kembali tidak boleh lebih awal daripada tanggal pinjam.');
  const automaticPages = objectType === 'BERKAS'
    ? allItems.reduce((sum, row) => sum + Number(row.JUMLAH_HALAMAN || 0), 0)
    : items.reduce((sum, row) => sum + Number(row.JUMLAH_HALAMAN || 0), 0);
  const pageCount = positiveInteger_(requireValue_(form.loanPageCount, 'Jumlah halaman/item'), 'Jumlah halaman/item');
  if (pageCount < 1) throw new Error('Jumlah halaman/item yang dipinjam minimal 1.');
  return {
    form: form,
    loanId: loanGroupId,
    loanGroupId: loanGroupId,
    objectType: objectType,
    parent: parent,
    item: item,
    items: items,
    allItems: allItems,
    borrowerName: borrowerName,
    identityNumber: cleanText_(form.borrowerIdentity, 100),
    workUnit: workUnit,
    whatsapp: cleanText_(form.borrowerWhatsapp, 50),
    purpose: purpose,
    borrowDate: borrowDate,
    dueDate: dueDate,
    pageCount: pageCount,
    automaticPages: automaticPages,
    originalLocation: loanLocationLabel_(parent),
    notes: cleanText_(form.loanNotes, 2000)
  };
}

function assertLoanAvailability_(objectType, parent, selectedItems, allItems, loanRows) {
  const activeLoans = (loanRows || readObjects_(APP_CONFIG.SHEETS.PEMINJAMAN)).filter(isActiveLoan_);
  const berkasId = String(parent.BERKAS_ID);
  const wholeLoan = activeLoans.find(row =>
    loanObjectType_(row) === 'BERKAS' && loanBerkasId_(row) === berkasId);
  const activeItemLoans = activeLoans.filter(row =>
    loanObjectType_(row) === 'ITEM' && loanBerkasId_(row) === berkasId);
  if (wholeLoan) throw new Error('Berkas sedang dipinjam seluruhnya oleh ' + (wholeLoan.NAMA_PEMINJAM || 'peminjam lain') + '.');
  if (objectType === 'BERKAS' && activeItemLoans.length) {
    throw new Error('Berkas tidak dapat dipinjam seluruhnya karena ' + activeItemLoans.length + ' item masih dipinjam.');
  }
  if (objectType === 'ITEM') {
    const selectedIds = {};
    (selectedItems || []).forEach(item => selectedIds[String(item.ITEM_ID)] = true);
    const duplicates = activeItemLoans.filter(row => selectedIds[loanItemId_(row)]);
    if (duplicates.length) {
      const numbers = duplicates.map(row => row.NO_ITEM_SNAPSHOT || loanItemId_(row)).join(', ');
      throw new Error('Item ' + numbers + ' sedang dipinjam dan tidak dapat dicatat ulang.');
    }
  }
  if (String(parent.STATUS_PEMINJAMAN || 'TERSEDIA').toUpperCase() === 'DIPINJAM') {
    throw new Error('Status berkas menunjukkan sedang dipinjam. Segarkan menu Peminjaman untuk menyinkronkan data.');
  }
  if (objectType === 'ITEM') {
    const blocked = (selectedItems || []).filter(item =>
      String(item.STATUS_PEMINJAMAN || 'TERSEDIA').toUpperCase() !== 'TERSEDIA');
    if (blocked.length) {
      throw new Error('Status sebagian item menunjukkan sedang dipinjam. Segarkan menu Peminjaman untuk menyinkronkan data.');
    }
  }
}

function returnLoan_(form) {
  const startedAt = Date.now();
  ensureLoanSchema_();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    form = form || {};
    const loanGroupId = cleanText_(requireValue_(form.returnLoanId, 'Transaksi peminjaman'), 80);
    if (String(form.returnConfirmation || '').trim().toUpperCase() !== 'KEMBALIKAN') {
      throw new Error('Ketik KEMBALIKAN pada kolom konfirmasi.');
    }
    const loans = readObjects_(APP_CONFIG.SHEETS.PEMINJAMAN);
    const groupLoans = loans.filter(row => loanGroupId_(row) === loanGroupId ||
      String(row.PEMINJAMAN_ID) === loanGroupId);
    if (!groupLoans.length) throw new Error('Transaksi peminjaman tidak ditemukan.');
    const activeGroupLoans = groupLoans.filter(isActiveLoan_);
    if (!activeGroupLoans.length) {
      if (groupLoans.every(row => String(row.STATUS || '').toUpperCase() === LOAN_RETURNED_STATUS_)) {
        return {
          ok: true,
          loanId: loanGroupId,
          loanGroupId: loanGroupId,
          berkasId: loanBerkasId_(groupLoans[0]),
          message: 'Pengembalian sudah tersimpan. Status transaksi berhasil dipulihkan.'
        };
      }
      throw new Error('Transaksi peminjaman tidak lagi aktif.');
    }
    const returnDate = loanDateKey_(requireValue_(form.returnDate, 'Tanggal kembali'), 'Tanggal kembali');
    const borrowDate = loanDateKey_(groupLoans[0].TANGGAL_PINJAM, 'Tanggal pinjam');
    if (returnDate < borrowDate) throw new Error('Tanggal kembali tidak boleh lebih awal daripada tanggal pinjam.');
    if (returnDate > loanTodayKey_()) throw new Error('Tanggal kembali tidak boleh berada di masa depan.');
    const timestamp = nowIso_();
    const updatedBy = getCurrentUser_();
    updateObjectsAtRows_(APP_CONFIG.SHEETS.PEMINJAMAN,
      activeGroupLoans.map(loan => ({
        rowNumber: loan._rowNumber,
        changes: {
          TANGGAL_KEMBALI: returnDate,
          STATUS: LOAN_RETURNED_STATUS_,
          CATATAN: appendLoanReturnNote_(loan.CATATAN, form.returnNotes, returnDate),
          UPDATED_AT: timestamp,
          UPDATED_BY: updatedBy
        }
      })));
    const berkasId = loanBerkasId_(groupLoans[0]);
    activeGroupLoans.forEach(loan => {
      loan.STATUS = LOAN_RETURNED_STATUS_;
      loan.TANGGAL_KEMBALI = returnDate;
    });
    const berkasRows = readObjects_(APP_CONFIG.SHEETS.BERKAS)
      .filter(row => !isDeleted_(row) && String(row.BERKAS_ID) === String(berkasId));
    const itemRows = readObjects_(APP_CONFIG.SHEETS.ITEM)
      .filter(row => !isDeleted_(row) && String(row.BERKAS_ID) === String(berkasId));
    synchronizeLoanObjectStatuses_(berkasRows, itemRows, loans);
    const firstLoan = groupLoans[0];
    audit_('RETURN', 'PEMINJAMAN', groupLoans.length > 1 ? 'MULTI_ITEM' : loanObjectType_(firstLoan), loanGroupId,
      'Mencatat pengembalian ' + groupLoans.length + ' objek arsip dari ' +
        (firstLoan.NAMA_PEMINJAM || 'peminjam'),
      cleanText_(form.returnNotes, 1000) || 'Dikembalikan lengkap', 'SUCCESS');
    return {
      ok: true,
      loanId: loanGroupId,
      loanGroupId: loanGroupId,
      berkasId: berkasId,
      returnedDate: returnDate,
      durationMs: Date.now() - startedAt,
      message: 'Pengembalian berhasil dicatat dan status arsip diperbarui.'
    };
  } catch (error) {
    audit_('RETURN', 'PEMINJAMAN', 'SISTEM', form && form.returnLoanId || '',
      'Pencatatan pengembalian gagal', error.message, 'FAILED');
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function synchronizeLoanObjectStatuses_(berkas, items, loans) {
  const plan = planLoanObjectStatusUpdates_(berkas, items, loans);
  if (plan.berkasUpdates.length) {
    updateObjectsAtRows_(APP_CONFIG.SHEETS.BERKAS, plan.berkasUpdates);
  }
  if (plan.itemUpdates.length) {
    updateObjectsAtRows_(APP_CONFIG.SHEETS.ITEM, plan.itemUpdates);
  }
  return {updated: plan.berkasUpdates.length + plan.itemUpdates.length};
}

function planLoanObjectStatusUpdates_(berkas, items, loans) {
  const activeLoans = (loans || []).filter(isActiveLoan_);
  const activity = loanActivityIndex_(activeLoans);
  const berkasUpdates = [];
  const itemUpdates = [];
  (berkas || []).forEach(parent => {
    const berkasId = String(parent.BERKAS_ID);
    const wholeLoan = Boolean(activity.wholeByBerkas[berkasId]);
    const partialLoan = Number(activity.itemCountByBerkas[berkasId] || 0) > 0;
    const desired = wholeLoan ? 'DIPINJAM' : partialLoan ? 'SEBAGIAN DIPINJAM' : 'TERSEDIA';
    if (String(parent.STATUS_PEMINJAMAN || 'TERSEDIA').toUpperCase() !== desired) {
      berkasUpdates.push({rowNumber: parent._rowNumber, changes: {STATUS_PEMINJAMAN: desired}});
    }
  });
  (items || []).forEach(item => {
    const berkasId = String(item.BERKAS_ID);
    const wholeLoan = Boolean(activity.wholeByBerkas[berkasId]);
    const itemLoan = Boolean(activity.itemById[String(item.ITEM_ID)]);
    const desired = wholeLoan ? 'DIPINJAM DALAM BERKAS' : itemLoan ? 'DIPINJAM' : 'TERSEDIA';
    if (String(item.STATUS_PEMINJAMAN || 'TERSEDIA').toUpperCase() !== desired) {
      itemUpdates.push({rowNumber: item._rowNumber, changes: {STATUS_PEMINJAMAN: desired}});
    }
  });
  return {
    berkasUpdates: berkasUpdates,
    itemUpdates: itemUpdates
  };
}

function updateLoanObjectStatuses_(berkasId) {
  const berkas = readObjects_(APP_CONFIG.SHEETS.BERKAS)
    .filter(row => !isDeleted_(row) && String(row.BERKAS_ID) === String(berkasId));
  const items = readObjects_(APP_CONFIG.SHEETS.ITEM)
    .filter(row => !isDeleted_(row) && String(row.BERKAS_ID) === String(berkasId));
  const loans = readObjects_(APP_CONFIG.SHEETS.PEMINJAMAN);
  return synchronizeLoanObjectStatuses_(berkas, items, loans);
}

function isActiveLoan_(row) {
  return String(row && row.STATUS || '').toUpperCase() === LOAN_ACTIVE_STATUS_;
}

function loanActivityIndex_(activeLoans) {
  const index = {wholeByBerkas: {}, itemById: {}, itemCountByBerkas: {}};
  (activeLoans || []).forEach(loan => {
    const berkasId = loanBerkasId_(loan);
    if (!berkasId) return;
    if (loanObjectType_(loan) === 'BERKAS') {
      index.wholeByBerkas[berkasId] = loan;
      return;
    }
    const itemId = loanItemId_(loan);
    if (itemId) index.itemById[itemId] = loan;
    index.itemCountByBerkas[berkasId] = Number(index.itemCountByBerkas[berkasId] || 0) + 1;
  });
  return index;
}

function ensureLoanSchema_() {
  const sheet = getSheetOrThrow_(APP_CONFIG.SHEETS.PEMINJAMAN);
  let headers = getHeaders_(sheet);
  const missing = LOAN_REQUIRED_HEADERS_.filter(header => headers.indexOf(header) === -1);
  if (missing.length) {
    sheet.getRange(1, headers.length + 1, 1, missing.length).setValues([missing]);
    sheet.getRange(1, headers.length + 1, 1, missing.length)
      .setFontWeight('bold').setBackground('#143b5d').setFontColor('#ffffff');
    headerCache_ = {};
    headers = headers.concat(missing);
  }
  return {ok: true, headerCount: headers.length};
}

function backfillLoanCf03Schema_() {
  ensureLoanSchema_();
  ensureLoanOutIndicatorLogSchema_();
  const loans = readObjects_(APP_CONFIG.SHEETS.PEMINJAMAN);
  if (!loans.length) return {ok: true, updated: 0};
  const berkasById = {};
  readObjects_(APP_CONFIG.SHEETS.BERKAS).forEach(row =>
    berkasById[String(row.BERKAS_ID)] = row);
  const updates = [];
  loans.forEach(row => {
    const parent = berkasById[loanBerkasId_(row)] || {};
    const changes = {};
    if (!row.LOAN_GROUP_ID) changes.LOAN_GROUP_ID = row.PEMINJAMAN_ID;
    if (!row.JUMLAH_HALAMAN_GRUP_SNAPSHOT) {
      changes.JUMLAH_HALAMAN_GRUP_SNAPSHOT = Number(row.JUMLAH_HALAMAN_ITEM || 0);
    }
    if (!row.LOKASI_ASAL_SNAPSHOT) {
      changes.LOKASI_ASAL_SNAPSHOT = loanLocationLabel_(parent);
      changes.NO_FILLING_KABINET_SNAPSHOT = parent.NO_FILLING_KABINET || '';
      changes.NO_LACI_SNAPSHOT = parent.NO_LACI || '';
      changes.NO_FOLDER_SNAPSHOT = parent.NO_FOLDER || parent.NO_BERKAS_DEFINITIF || '';
    }
    if (Object.keys(changes).length) {
      updates.push({rowNumber: row._rowNumber, changes: changes});
    }
  });
  if (updates.length) updateObjectsAtRows_(APP_CONFIG.SHEETS.PEMINJAMAN, updates);
  return {ok: true, updated: updates.length};
}

function ensureLoanOutIndicatorLogSchema_() {
  const spreadsheet = getSpreadsheet_();
  let sheet = spreadsheet.getSheetByName(APP_CONFIG.SHEETS.LOAN_OUT_INDICATOR_LOG);
  if (!sheet) sheet = spreadsheet.insertSheet(APP_CONFIG.SHEETS.LOAN_OUT_INDICATOR_LOG);
  const existing = sheet.getLastColumn() > 0
    ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0] : [];
  const missing = LOAN_OUT_INDICATOR_LOG_HEADERS_
    .filter(header => existing.indexOf(header) === -1);
  if (missing.length) {
    sheet.getRange(1, existing.filter(Boolean).length + 1, 1, missing.length)
      .setValues([missing]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, LOAN_OUT_INDICATOR_LOG_HEADERS_.length)
      .setFontWeight('bold').setBackground('#143b5d').setFontColor('#ffffff');
    headerCache_ = {};
  }
  return sheet;
}

function prepareLoanOutIndicator_(loanGroupId) {
  ensureLoanSchema_();
  ensureLoanOutIndicatorLogSchema_();
  loanGroupId = cleanText_(requireValue_(loanGroupId, 'ID transaksi peminjaman'), 80);
  const allLoans = readObjects_(APP_CONFIG.SHEETS.PEMINJAMAN);
  const records = allLoans.filter(row => loanGroupId_(row) === loanGroupId ||
    String(row.PEMINJAMAN_ID) === loanGroupId);
  if (!records.length) throw new Error('Transaksi peminjaman tidak ditemukan.');
  const berkasId = loanBerkasId_(records[0]);
  const parent = readObjects_(APP_CONFIG.SHEETS.BERKAS)
    .find(row => String(row.BERKAS_ID) === berkasId) || {};
  const itemById = {};
  readObjects_(APP_CONFIG.SHEETS.ITEM)
    .filter(row => String(row.BERKAS_ID) === berkasId)
    .forEach(row => itemById[String(row.ITEM_ID)] = row);
  const parentById = {};
  parentById[berkasId] = parent;
  const presentation = presentLoanGroups_(
    records, parentById, itemById, loanTodayKey_())[0];
  const objectType = loanObjectType_(records[0]);
  const items = objectType === 'BERKAS'
    ? [{
        number: 'SELURUH BERKAS',
        description: records[0].URAIAN_OBJEK_SNAPSHOT || parent.JUDUL_BERKAS || 'Berkas arsip',
        pageCount: Number(records[0].JUMLAH_HALAMAN_GRUP_SNAPSHOT ||
          records[0].JUMLAH_HALAMAN_ITEM || 0)
      }]
    : records.map(row => {
        const currentItem = itemById[loanItemId_(row)] || {};
        return {
          number: row.NO_ITEM_SNAPSHOT || currentItem.NO_ITEM_DEFINITIF || '–',
          description: row.URAIAN_OBJEK_SNAPSHOT || currentItem.URAIAN_LENGKAP || 'Item arsip',
          pageCount: Number(row.JUMLAH_HALAMAN_ITEM || currentItem.JUMLAH_HALAMAN || 0)
        };
      }).sort((a, b) => naturalCompare_(a.number, b.number));
  const previousPrints = readObjects_(APP_CONFIG.SHEETS.LOAN_OUT_INDICATOR_LOG)
    .filter(row => String(row.LOAN_GROUP_ID) === loanGroupId);
  const printSequence = previousPrints.length + 1;
  const timestamp = nowIso_();
  const fileName = ('Out_Indicator_' + loanGroupId +
    (printSequence > 1 ? '_Cetak_Ulang_' + printSequence : '') + '.pdf')
    .replace(/[^A-Za-z0-9._-]+/g, '_');
  const location = records[0].LOKASI_ASAL_SNAPSHOT || loanLocationLabel_(parent);
  appendObject_(APP_CONFIG.SHEETS.LOAN_OUT_INDICATOR_LOG, {
    PRINT_ID: 'OUT-' + Utilities.getUuid(),
    TIMESTAMP: timestamp,
    USER_EMAIL: getCurrentUser_(),
    LOAN_GROUP_ID: loanGroupId,
    PEMINJAMAN_IDS: records.map(row => row.PEMINJAMAN_ID).join(', '),
    JENIS_OBJEK: records.length > 1 ? 'MULTI_ITEM' : objectType,
    BERKAS_ID: berkasId,
    NO_BERKAS_SNAPSHOT: records[0].NO_BERKAS_SNAPSHOT || parent.NO_BERKAS_DEFINITIF || '',
    LOKASI_ASAL_SNAPSHOT: location,
    PDF_FILE_NAME: fileName,
    STATUS: 'PDF_DIBUAT'
  });
  audit_('GENERATE_PDF', 'PEMINJAMAN', 'OUT_INDICATOR', loanGroupId,
    'Membuat Out Indicator A5 untuk transaksi peminjaman',
    location + ' · cetakan ke-' + printSequence, 'SUCCESS');
  const settings = readSettings_();
  return {
    ok: true,
    loanGroupId: loanGroupId,
    loanIds: records.map(row => row.PEMINJAMAN_ID),
    fileName: fileName,
    generatedAt: timestamp,
    printSequence: printSequence,
    isReprint: printSequence > 1,
    unitName: cleanText_(settings.UNIT_NAME, 250) || 'UIN SUNAN AMPEL SURABAYA',
    locationName: cleanText_(settings.INSTANCE_LOCATION, 100) || 'Surabaya',
    objectType: objectType,
    berkasNumber: presentation.berkasNumber,
    classificationCode: parent.KODE_KLASIFIKASI_SNAPSHOT || '',
    berkasTitle: parent.JUDUL_BERKAS || records[0].URAIAN_OBJEK_SNAPSHOT || '',
    originalLocation: location,
    borrowerName: presentation.borrowerName,
    borrowerIdentity: presentation.borrowerIdentity,
    borrowerUnit: presentation.borrowerUnit,
    whatsapp: presentation.whatsapp,
    purpose: presentation.purpose,
    borrowDate: presentation.borrowDate,
    dueDate: presentation.dueDate,
    statusCode: presentation.statusCode,
    statusLabel: presentation.statusLabel,
    pageCount: presentation.pageCount,
    items: items,
    layout: {paper: 'A5', orientation: 'PORTRAIT', widthMm: 148, heightMm: 210}
  };
}

function loanObjectType_(row) {
  return String(row && row.JENIS_OBJEK || '').toUpperCase() === 'ITEM' ? 'ITEM' : 'BERKAS';
}

function loanGroupId_(row) {
  return String(row && (row.LOAN_GROUP_ID || row.PEMINJAMAN_ID) || '');
}

function loanBerkasId_(row) {
  return String(row && (row.BERKAS_ID ||
    (loanObjectType_(row) === 'BERKAS' ? row.OBJEK_ID : '')) || '');
}

function loanItemId_(row) {
  return String(row && (row.ITEM_ID ||
    (loanObjectType_(row) === 'ITEM' ? row.OBJEK_ID : '')) || '');
}

function loanTodayKey_() {
  return Utilities.formatDate(new Date(), APP_CONFIG.TIME_ZONE, 'yyyy-MM-dd');
}

function loanDateKey_(value, label) {
  if (value instanceof Date && !isNaN(value)) return dateKey_(value);
  return dateKey_(parseLocalDate_(String(value || '').substring(0, 10), label || 'Tanggal'));
}

function loanLocationLabel_(row) {
  const parts = [];
  if (cleanText_(row.NO_FILLING_KABINET, 50)) parts.push('Kabinet ' + row.NO_FILLING_KABINET);
  if (cleanText_(row.NO_LACI, 50)) parts.push('Laci ' + row.NO_LACI);
  if (cleanText_(row.NO_FOLDER, 50) || cleanText_(row.NO_BERKAS_DEFINITIF, 50)) {
    parts.push('Folder ' + (row.NO_FOLDER || row.NO_BERKAS_DEFINITIF));
  }
  return parts.join(' · ') || 'Lokasi belum dicatat';
}

function appendLoanReturnNote_(existing, returnNotes, returnDate) {
  const prefix = cleanText_(existing, 1400);
  const suffix = '[KEMBALI ' + returnDate + '] ' +
    (cleanText_(returnNotes, 500) || 'Dikembalikan lengkap');
  return cleanText_(prefix ? prefix + ' | ' + suffix : suffix, 2000);
}

function saveLoanEvidence_(context, preUploadedEvidenceId, originalName) {
  if (!preUploadedEvidenceId) return null;
  const file = DriveApp.getFileById(preUploadedEvidenceId);
  const size = Number(file.getSize());
  const sourceName = String(originalName || file.getName() || 'bukti');
  const mimeType = String(file.getMimeType() || '').toLowerCase();
  validateLoanEvidenceFile_(sourceName, size, mimeType);
  const extension = (sourceName.match(/\.([^.]+)$/) || ['', 'bin'])[1].toLowerCase();
  const stamp = Utilities.formatDate(new Date(), APP_CONFIG.TIME_ZONE, 'yyyyMMdd-HHmmss');
  const objectNumber = context.objectType === 'BERKAS'
    ? (context.parent.NO_BERKAS_DEFINITIF || 'DRAFT')
    : (context.parent.NO_BERKAS_DEFINITIF || 'DRAFT') + '-' + (context.item.NO_ITEM_DEFINITIF || 'ITEM');
  const finalName = stamp + '_PEMINJAMAN_' + objectNumber + '_' +
    cleanFileName_(context.borrowerName) + '.' + extension;
  file.setName(finalName);
  return {id: file.getId(), url: file.getUrl(), name: file.getName()};
}

function validateLoanEvidenceFile_(fileName, fileSize, mimeType) {
  const extension = (String(fileName || '').match(/\.([^.]+)$/) || ['', ''])[1].toLowerCase();
  const normalizedType = String(mimeType || '').toLowerCase();
  if (['pdf', 'jpg', 'jpeg', 'png'].indexOf(extension) === -1) {
    throw new Error('Bukti persetujuan harus PDF, JPG, JPEG, atau PNG.');
  }
  if (normalizedType && ['application/pdf', 'image/jpeg', 'image/png', 'application/octet-stream'].indexOf(normalizedType) === -1) {
    throw new Error('Tipe bukti persetujuan tidak didukung.');
  }
  if (!Number.isInteger(Number(fileSize)) || Number(fileSize) < 1) throw new Error('Ukuran bukti persetujuan tidak valid.');
  if (Number(fileSize) > LOAN_UPLOAD_MAX_SIZE_) throw new Error('Ukuran bukti persetujuan maksimal 25 MB.');
}

function getLoanEvidenceFolder_() {
  const settings = readSettings_();
  const root = DriveApp.getFolderById(requireValue_(settings.ARCHIVE_FOLDER_ID, 'ARCHIVE_FOLDER_ID pada SETTINGS'));
  const matches = root.getFoldersByName('BUKTI PEMINJAMAN');
  return matches.hasNext() ? matches.next() : root.createFolder('BUKTI PEMINJAMAN');
}

function startLoanEvidenceUpload_(request) {
  ensureLoanSchema_();
  purgeOldUploadSessionsByPrefix_(LOAN_UPLOAD_PROPERTY_PREFIX_);
  request = request || {};
  const fileName = cleanText_(requireValue_(request.evidenceName, 'Nama bukti persetujuan'), 250);
  const fileSize = Number(request.evidenceSize);
  const mimeType = cleanText_(request.evidenceType || 'application/octet-stream', 100).toLowerCase();
  validateLoanEvidenceFile_(fileName, fileSize, mimeType);
  const form = sanitizeLoanForm_(request);
  resolveLoanContext_(form);
  const folder = getLoanEvidenceFolder_();
  const sessionId = 'LOANUPL-' + Utilities.getUuid();
  const extension = (fileName.match(/\.([^.]+)$/) || ['', 'bin'])[1].toLowerCase();
  const sessionUrl = initializeDriveResumableUpload_(
    'UPLOAD_BUKTI_' + sessionId + '.' + extension, fileSize, folder.getId(), mimeType);
  const session = {
    sessionId: sessionId,
    sessionUrl: sessionUrl,
    userEmail: getCurrentUser_(),
    fileName: fileName,
    fileSize: fileSize,
    mimeType: mimeType,
    uploadedBytes: 0,
    driveFileId: '',
    form: form,
    committed: false,
    commitResult: null,
    createdAt: nowIso_()
  };
  saveLoanUploadSession_(session);
  audit_('UPLOAD_START', 'PEMINJAMAN', 'BUKTI_PERSETUJUAN', sessionId,
    'Memulai upload bukti persetujuan: ' + fileName, fileSize + ' byte', 'SUCCESS');
  return loanUploadProgress_(session);
}

function uploadLoanEvidenceChunk_(request) {
  request = request || {};
  const session = getLoanUploadSession_(request.sessionId);
  if (session.driveFileId) return loanUploadProgress_(session);
  const total = Number(request.total);
  const start = Number(request.start);
  const endExclusive = Number(request.end);
  if (total !== Number(session.fileSize)) throw new Error('Ukuran bukti persetujuan berubah selama upload.');
  if (!Number.isInteger(start) || !Number.isInteger(endExclusive) ||
      start < 0 || endExclusive <= start || endExclusive > total) {
    throw new Error('Posisi potongan bukti persetujuan tidak valid.');
  }
  if (start !== Number(session.uploadedBytes || 0)) return loanUploadProgress_(session);
  const bytes = Utilities.base64Decode(String(request.base64 || ''));
  if (bytes.length !== endExclusive - start) throw new Error('Ukuran potongan bukti persetujuan tidak sesuai.');
  if (endExclusive < total && bytes.length % (256 * 1024) !== 0) {
    throw new Error('Potongan selain yang terakhir harus kelipatan 256 KB.');
  }
  const response = sendDriveResumableChunk_(
    session.sessionUrl, bytes, start, endExclusive, total, session.mimeType);
  if (response.complete) {
    session.uploadedBytes = total;
    session.driveFileId = response.fileId;
  } else {
    session.uploadedBytes = response.uploadedBytes;
  }
  saveLoanUploadSession_(session);
  return loanUploadProgress_(session);
}

function getLoanEvidenceUploadStatus_(sessionId) {
  const session = getLoanUploadSession_(sessionId);
  if (session.committed || session.driveFileId) return loanUploadProgress_(session);
  const response = queryDriveResumableStatus_(session.sessionUrl, session.fileSize, session.mimeType);
  if (response.complete) {
    session.uploadedBytes = session.fileSize;
    session.driveFileId = response.fileId;
  } else {
    session.uploadedBytes = response.uploadedBytes;
  }
  saveLoanUploadSession_(session);
  return loanUploadProgress_(session);
}

function finalizeLoanEvidenceUpload_(sessionId) {
  const session = getLoanUploadSession_(sessionId);
  if (session.committed && session.commitResult) return session.commitResult;
  const existing = findCommittedLoanResult_(session.form && session.form.loanPreviewId);
  if (existing) {
    session.committed = true;
    session.committedAt = nowIso_();
    session.commitResult = existing;
    saveLoanUploadSession_(session);
    return existing;
  }
  if (!session.driveFileId) {
    const status = getLoanEvidenceUploadStatus_(sessionId);
    if (!status.complete) throw new Error('UPLOAD_INCOMPLETE: Bukti persetujuan belum selesai diunggah.');
    Object.assign(session, getLoanUploadSession_(sessionId));
  }
  const result = createLoan_(session.form, session.driveFileId, session.fileName);
  session.committed = true;
  session.committedAt = nowIso_();
  session.commitResult = result;
  saveLoanUploadSession_(session);
  return result;
}

function cancelLoanEvidenceUpload_(sessionId) {
  const session = getLoanUploadSession_(sessionId);
  if (session.driveFileId && !session.committed) {
    try { DriveApp.getFileById(session.driveFileId).setTrashed(true); } catch (ignore) {}
  }
  PropertiesService.getScriptProperties().deleteProperty(loanUploadPropertyKey_(sessionId));
  return {ok: true};
}

function sanitizeLoanForm_(request) {
  const allowed = [
    'loanPreviewId', 'loanObjectType', 'loanBerkasId', 'loanItemId', 'loanItemIdsJson',
    'borrowerName', 'borrowerIdentity', 'borrowerUnit', 'borrowerWhatsapp',
    'loanPurpose', 'loanDate', 'loanDueDate', 'loanPageCount', 'loanNotes'
  ];
  const form = {};
  allowed.forEach(key => form[key] =
    request[key] === undefined || request[key] === null ? '' : String(request[key]));
  return form;
}

function loanUploadPropertyKey_(sessionId) {
  return LOAN_UPLOAD_PROPERTY_PREFIX_ + cleanText_(requireValue_(sessionId, 'ID sesi upload'), 90);
}

function saveLoanUploadSession_(session) {
  PropertiesService.getScriptProperties()
    .setProperty(loanUploadPropertyKey_(session.sessionId), JSON.stringify(session));
}

function getLoanUploadSession_(sessionId) {
  const value = PropertiesService.getScriptProperties().getProperty(loanUploadPropertyKey_(sessionId));
  if (!value) throw new Error('UPLOAD_SESSION_NOT_FOUND: Sesi upload bukti tidak ditemukan. Kirim kembali formulir untuk memulai ulang.');
  const session = JSON.parse(value);
  if (session.userEmail && session.userEmail !== getCurrentUser_()) {
    throw new Error('Sesi upload ini dibuat oleh pengguna lain.');
  }
  return session;
}

function loanUploadProgress_(session) {
  return {
    ok: true,
    sessionId: session.sessionId,
    chunkSize: LOAN_UPLOAD_CHUNK_SIZE_,
    uploadedBytes: Number(session.uploadedBytes || 0),
    fileSize: Number(session.fileSize || 0),
    complete: Boolean(session.driveFileId),
    committed: Boolean(session.committed),
    result: session.commitResult || null
  };
}

function findCommittedLoanResult_(loanId, loanRows) {
  loanId = cleanText_(loanId, 80);
  if (!loanId) return null;
  const records = (loanRows || readObjects_(APP_CONFIG.SHEETS.PEMINJAMAN))
    .filter(row => loanGroupId_(row) === loanId || String(row.PEMINJAMAN_ID) === loanId);
  if (!records.length) return null;
  const loan = records[0];
  return {
    ok: true,
    loanId: loan.PEMINJAMAN_ID,
    loanGroupId: loanGroupId_(loan),
    loanIds: records.map(row => row.PEMINJAMAN_ID),
    berkasId: loanBerkasId_(loan),
    itemId: records.length === 1 ? loanItemId_(loan) : '',
    itemIds: records.map(loanItemId_).filter(Boolean),
    evidenceUrl: loan.BUKTI_PERSETUJUAN_URL || '',
    message: 'Peminjaman sudah tersimpan. Status transaksi berhasil dipulihkan tanpa data ganda.'
  };
}
