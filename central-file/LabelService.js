const FOLDER_LABEL_LOG_SHEET_ = 'LOG_CETAK_LIDAH';
const FOLDER_LABEL_LOG_HEADERS_ = Object.freeze([
  'PRINT_ID',
  'TIMESTAMP',
  'USER_EMAIL',
  'BATCH_ID',
  'BERKAS_ID',
  'NO_BERKAS_SNAPSHOT',
  'KODE_KLASIFIKASI_SNAPSHOT',
  'JUDUL_BERKAS_SNAPSHOT',
  'START_SLOT',
  'PDF_FILE_NAME',
  'STATUS'
]);

function getFolderLabelOptions_() {
  const latestPrintByBerkas = latestFolderLabelPrints_();
  const rows = readObjects_(APP_CONFIG.SHEETS.BERKAS)
    .filter(row => !isDeleted_(row) && row.NO_BERKAS_DEFINITIF !== '' && row.NO_BERKAS_DEFINITIF !== null)
    .sort((a, b) => naturalCompare_(a.NO_BERKAS_DEFINITIF, b.NO_BERKAS_DEFINITIF))
    .map(row => folderLabelOption_(row, latestPrintByBerkas[row.BERKAS_ID]));
  return {
    berkas: rows,
    total: rows.length,
    statusCounts: rows.reduce((counts, row) => {
      counts[row.printStatus] = (counts[row.printStatus] || 0) + 1;
      return counts;
    }, {BELUM_DICETAK: 0, SUDAH_DICETAK: 0, PERLU_CETAK_ULANG: 0}),
    layout: {
      paper: 'A4',
      columns: 2,
      rows: 7,
      labelsPerPage: 14,
      labelWidthMm: 70,
      labelHeightMm: 30
    }
  };
}

function prepareFolderLabels_(request) {
  request = request || {};
  const ids = Array.from(new Set((request.berkasIds || []).map(id => cleanText_(id, 100)).filter(Boolean)));
  if (!ids.length) throw new Error('Pilih minimal satu berkas untuk dicetak.');
  if (ids.length > 500) throw new Error('Maksimal 500 lidah folder dalam satu PDF. Pecah pilihan menjadi beberapa batch.');
  const startSlot = Number(request.startSlot || 1);
  if (!Number.isInteger(startSlot) || startSlot < 1 || startSlot > 14) {
    throw new Error('Posisi awal label harus antara 1 sampai 14.');
  }

  const activeById = {};
  readObjects_(APP_CONFIG.SHEETS.BERKAS)
    .filter(row => !isDeleted_(row))
    .forEach(row => activeById[row.BERKAS_ID] = row);
  const missing = ids.filter(id => {
    const row = activeById[id];
    return !row || row.NO_BERKAS_DEFINITIF === '' || row.NO_BERKAS_DEFINITIF === null;
  });
  if (missing.length) throw new Error('Sebagian berkas tidak lagi aktif atau belum mempunyai nomor definitif. Muat ulang daftar lalu pilih kembali.');

  const labels = ids.map(id => activeById[id])
    .sort((a, b) => naturalCompare_(a.NO_BERKAS_DEFINITIF, b.NO_BERKAS_DEFINITIF))
    .map(row => ({
      berkasId: row.BERKAS_ID,
      number: String(row.NO_BERKAS_DEFINITIF),
      classificationCode: cleanText_(row.KODE_KLASIFIKASI_SNAPSHOT, 80) || 'TANPA KODE',
      title: cleanText_(row.JUDUL_BERKAS, 500) || 'Tanpa Judul',
      location: archiveLocationLabel_(row)
    }));

  const timestamp = nowIso_();
  const batchId = 'LBL-' + Utilities.getUuid();
  const fileName = 'Lidah_Folder_' + Utilities.formatDate(new Date(), APP_CONFIG.TIME_ZONE, 'yyyyMMdd_HHmmss') + '.pdf';
  const user = getCurrentUser_();
  const logRows = labels.map(label => ({
    PRINT_ID: 'PRN-' + Utilities.getUuid(),
    TIMESTAMP: timestamp,
    USER_EMAIL: user,
    BATCH_ID: batchId,
    BERKAS_ID: label.berkasId,
    NO_BERKAS_SNAPSHOT: label.number,
    KODE_KLASIFIKASI_SNAPSHOT: label.classificationCode,
    JUDUL_BERKAS_SNAPSHOT: label.title,
    START_SLOT: startSlot,
    PDF_FILE_NAME: fileName,
    STATUS: 'PDF_DIBUAT'
  }));
  appendFolderLabelLogRows_(logRows);
  audit_(
    'GENERATE_PDF',
    'CETAK_LIDAH_FOLDER',
    'BATCH',
    batchId,
    'Membuat PDF lidah folder untuk ' + labels.length + ' berkas',
    'Posisi awal ' + startSlot + ' · ' + labels.map(label => label.classificationCode + ' | ' + label.number).join(', '),
    'SUCCESS'
  );

  return {
    ok: true,
    batchId: batchId,
    generatedAt: timestamp,
    fileName: fileName,
    startSlot: startSlot,
    labels: labels,
    pageCount: Math.ceil((startSlot - 1 + labels.length) / 14),
    layout: {
      paper: 'A4',
      columns: 2,
      rows: 7,
      labelsPerPage: 14,
      labelWidthMm: 70,
      labelHeightMm: 30
    }
  };
}

function folderLabelOption_(row, latestPrint) {
  const currentNumber = String(row.NO_BERKAS_DEFINITIF || '');
  const currentCode = cleanText_(row.KODE_KLASIFIKASI_SNAPSHOT, 80);
  const currentTitle = cleanText_(row.JUDUL_BERKAS, 500);
  let printStatus = 'BELUM_DICETAK';
  let printStatusLabel = 'Belum dicetak';
  let lastPrintedAt = '';
  if (latestPrint) {
    lastPrintedAt = latestPrint.TIMESTAMP || '';
    const unchanged = String(latestPrint.NO_BERKAS_SNAPSHOT || '') === currentNumber &&
      cleanText_(latestPrint.KODE_KLASIFIKASI_SNAPSHOT, 80) === currentCode &&
      cleanText_(latestPrint.JUDUL_BERKAS_SNAPSHOT, 500) === currentTitle;
    printStatus = unchanged ? 'SUDAH_DICETAK' : 'PERLU_CETAK_ULANG';
    printStatusLabel = unchanged ? 'Sudah dibuatkan PDF' : 'Perlu cetak ulang';
  }
  return {
    id: row.BERKAS_ID,
    number: currentNumber,
    classificationCode: currentCode,
    title: currentTitle,
    location: archiveLocationLabel_(row),
    folderUrl: row.DRIVE_FOLDER_URL || '',
    printStatus: printStatus,
    printStatusLabel: printStatusLabel,
    lastPrintedAt: lastPrintedAt
  };
}

function latestFolderLabelPrints_() {
  const sheet = getSpreadsheet_().getSheetByName(FOLDER_LABEL_LOG_SHEET_);
  if (!sheet || sheet.getLastRow() < 2) return {};
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, headers.length).getValues();
  const latest = {};
  values.forEach(row => {
    const object = {};
    headers.forEach((header, index) => object[header] = row[index]);
    if (object.BERKAS_ID) latest[object.BERKAS_ID] = object;
  });
  return latest;
}

function appendFolderLabelLogRows_(rows) {
  if (!rows || !rows.length) return;
  const sheet = getOrCreateFolderLabelLogSheet_();
  const values = rows.map(row => FOLDER_LABEL_LOG_HEADERS_.map(header =>
    Object.prototype.hasOwnProperty.call(row, header) ? row[header] : ''
  ));
  sheet.getRange(sheet.getLastRow() + 1, 1, values.length, FOLDER_LABEL_LOG_HEADERS_.length).setValues(values);
}

function getOrCreateFolderLabelLogSheet_() {
  const spreadsheet = getSpreadsheet_();
  let sheet = spreadsheet.getSheetByName(FOLDER_LABEL_LOG_SHEET_);
  if (sheet) return sheet;
  sheet = spreadsheet.insertSheet(FOLDER_LABEL_LOG_SHEET_);
  sheet.getRange(1, 1, 1, FOLDER_LABEL_LOG_HEADERS_.length).setValues([FOLDER_LABEL_LOG_HEADERS_]);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, FOLDER_LABEL_LOG_HEADERS_.length)
    .setFontWeight('bold')
    .setBackground('#143b5d')
    .setFontColor('#ffffff');
  sheet.autoResizeColumns(1, FOLDER_LABEL_LOG_HEADERS_.length);
  return sheet;
}

function clearFolderLabelPilotLog_() {
  const sheet = getSpreadsheet_().getSheetByName(FOLDER_LABEL_LOG_SHEET_);
  if (!sheet) return;
  const rowCount = sheet.getLastRow() - 1;
  if (rowCount > 0) sheet.getRange(2, 1, rowCount, sheet.getLastColumn()).clearContent();
}
