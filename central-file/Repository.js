var spreadsheetCache_ = null;
var headerCache_ = {};
var INSTANCE_SPREADSHEET_PROPERTY_ = 'INSTANCE_SPREADSHEET_ID';

function getInstanceSpreadsheetId_(allowMissing) {
  const spreadsheetId = cleanText_(
    PropertiesService.getScriptProperties().getProperty(INSTANCE_SPREADSHEET_PROPERTY_),
    200
  );
  if (spreadsheetId) return spreadsheetId;
  if (allowMissing) return '';
  throw new Error(
    'Instance aplikasi belum dikonfigurasi. Buka spreadsheet template, lalu pilih ' +
    'Arsip Aktif → Instalasi & Reliability untuk menjalankan installer unit.'
  );
}

function setInstanceSpreadsheetId_(spreadsheetId) {
  spreadsheetId = cleanText_(requireValue_(spreadsheetId, 'ID spreadsheet instance'), 200);
  PropertiesService.getScriptProperties()
    .setProperty(INSTANCE_SPREADSHEET_PROPERTY_, spreadsheetId);
  spreadsheetCache_ = null;
  headerCache_ = {};
  return spreadsheetId;
}

function getInstallerSpreadsheet_() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  const installerId = cleanText_(
    PropertiesService.getUserProperties()
      .getProperty('INSTALLER_ACTIVE_SPREADSHEET_ID'),
    200
  );
  if (installerId) return SpreadsheetApp.openById(installerId);
  const configuredId = getInstanceSpreadsheetId_(true);
  if (configuredId) return SpreadsheetApp.openById(configuredId);
  throw new Error(
    'Spreadsheet installer tidak ditemukan. Jalankan installer dari menu pada spreadsheet template.'
  );
}

function getSpreadsheet_() {
  if (!spreadsheetCache_) {
    spreadsheetCache_ = SpreadsheetApp.openById(getInstanceSpreadsheetId_());
  }
  return spreadsheetCache_;
}

function getSheetOrThrow_(sheetName) {
  const sheet = getSpreadsheet_().getSheetByName(sheetName);
  if (!sheet) throw new Error('Sheet tidak ditemukan: ' + sheetName);
  return sheet;
}

function getHeaders_(sheet) {
  const cacheKey = sheet.getSheetId() + ':' + sheet.getLastColumn();
  if (headerCache_[cacheKey]) return headerCache_[cacheKey].slice();
  const lastColumn = sheet.getLastColumn();
  if (lastColumn < 1) throw new Error('Header tidak ditemukan pada ' + sheet.getName());
  headerCache_[cacheKey] = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  return headerCache_[cacheKey].slice();
}

function readObjects_(sheetName) {
  const sheet = getSheetOrThrow_(sheetName);
  const headers = getHeaders_(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
  return values
    .filter(row => row.some(value => value !== '' && value !== null))
    .map((row, index) => {
      const object = {_rowNumber: index + 2};
      headers.forEach((header, column) => object[header] = row[column]);
      return object;
    });
}

function appendObject_(sheetName, object) {
  const sheet = getSheetOrThrow_(sheetName);
  const headers = getHeaders_(sheet);
  const row = headers.map(header => Object.prototype.hasOwnProperty.call(object, header) ? object[header] : '');
  sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length).setValues([row]);
  return object;
}

function appendObjects_(sheetName, objects) {
  if (!objects || objects.length === 0) return [];
  const sheet = getSheetOrThrow_(sheetName);
  const headers = getHeaders_(sheet);
  const rows = objects.map(object => headers.map(header =>
    Object.prototype.hasOwnProperty.call(object, header) ? object[header] : ''
  ));
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, headers.length).setValues(rows);
  return objects;
}

function updateObjectAtRow_(sheetName, rowNumber, changes) {
  const sheet = getSheetOrThrow_(sheetName);
  const headers = getHeaders_(sheet);
  const range = sheet.getRange(rowNumber, 1, 1, headers.length);
  const row = range.getValues()[0];
  headers.forEach((header, index) => {
    if (Object.prototype.hasOwnProperty.call(changes, header)) row[index] = changes[header];
  });
  range.setValues([row]);
  return changes;
}

function updateObjectsAtRows_(sheetName, updates) {
  updates = (updates || []).filter(update => update && Number(update.rowNumber) >= 2);
  if (!updates.length) return [];
  const sheet = getSheetOrThrow_(sheetName);
  const headers = getHeaders_(sheet);
  const rowNumbers = updates.map(update => Number(update.rowNumber));
  const firstRow = Math.min.apply(null, rowNumbers);
  const lastRow = Math.max.apply(null, rowNumbers);
  const range = sheet.getRange(firstRow, 1, lastRow - firstRow + 1, headers.length);
  const values = range.getValues();
  updates.forEach(update => {
    const row = values[Number(update.rowNumber) - firstRow];
    headers.forEach((header, index) => {
      if (Object.prototype.hasOwnProperty.call(update.changes || {}, header)) row[index] = update.changes[header];
    });
  });
  range.setValues(values);
  return updates;
}

function replaceReportRows_(sheetName, startRow, columnCount, rows) {
  const sheet = getSheetOrThrow_(sheetName);
  const requiredLastRow = startRow + Math.max(rows.length, 1) - 1;
  if (requiredLastRow > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), requiredLastRow - sheet.getMaxRows());
  const previousDataRows = Math.max(sheet.getLastRow() - startRow + 1, 0);
  const clearRows = Math.max(previousDataRows, rows.length);
  if (clearRows) sheet.getRange(startRow, 1, clearRows, columnCount).clearContent();
  if (rows.length) sheet.getRange(startRow, 1, rows.length, columnCount).setValues(rows);
}

function readSettings_() {
  const result = {};
  readObjects_(APP_CONFIG.SHEETS.SETTINGS).forEach(row => {
    let value = row.VALUE;
    if (row.TYPE === 'BOOLEAN') value = String(value).toUpperCase() === 'TRUE';
    if (row.TYPE === 'NUMBER') value = Number(value);
    result[row.KEY] = value;
  });
  return result;
}
