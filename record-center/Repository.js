// Pola batch read/write ini sengaja identik dengan central-file/Repository.js
// (lihat §5.3 handoff: pola engineering wajib berlaku untuk CF maupun RC).
var rcSpreadsheetCache_ = null;
var rcHeaderCache_ = {};
var RC_INSTANCE_SPREADSHEET_PROPERTY_ = 'RC_INSTANCE_SPREADSHEET_ID';

function getInstanceSpreadsheetId_(allowMissing) {
  const spreadsheetId = cleanText_(
    PropertiesService.getScriptProperties().getProperty(RC_INSTANCE_SPREADSHEET_PROPERTY_),
    200
  );
  if (spreadsheetId) return spreadsheetId;
  if (allowMissing) return '';
  throw new Error(
    'Instance Record Center belum dikonfigurasi. Buka spreadsheet Record Center, lalu pilih ' +
    'Record Center → Instalasi & Reliability untuk menjalankan installer.'
  );
}

function setInstanceSpreadsheetId_(spreadsheetId) {
  spreadsheetId = cleanText_(requireValue_(spreadsheetId, 'ID spreadsheet instance'), 200);
  PropertiesService.getScriptProperties()
    .setProperty(RC_INSTANCE_SPREADSHEET_PROPERTY_, spreadsheetId);
  rcSpreadsheetCache_ = null;
  rcHeaderCache_ = {};
  return spreadsheetId;
}

function getInstallerSpreadsheet_() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  const installerId = cleanText_(
    PropertiesService.getUserProperties()
      .getProperty('RC_INSTALLER_ACTIVE_SPREADSHEET_ID'),
    200
  );
  if (installerId) return SpreadsheetApp.openById(installerId);
  const configuredId = getInstanceSpreadsheetId_(true);
  if (configuredId) return SpreadsheetApp.openById(configuredId);
  throw new Error(
    'Spreadsheet installer tidak ditemukan. Jalankan installer dari menu pada spreadsheet Record Center.'
  );
}

function getSpreadsheet_() {
  if (!rcSpreadsheetCache_) {
    rcSpreadsheetCache_ = SpreadsheetApp.openById(getInstanceSpreadsheetId_());
  }
  return rcSpreadsheetCache_;
}

function getSheetOrThrow_(sheetName) {
  const sheet = getSpreadsheet_().getSheetByName(sheetName);
  if (!sheet) throw new Error('Sheet tidak ditemukan: ' + sheetName);
  return sheet;
}

function getHeaders_(sheet) {
  const cacheKey = sheet.getSheetId() + ':' + sheet.getLastColumn();
  if (rcHeaderCache_[cacheKey]) return rcHeaderCache_[cacheKey].slice();
  const lastColumn = sheet.getLastColumn();
  if (lastColumn < 1) throw new Error('Header tidak ditemukan pada ' + sheet.getName());
  rcHeaderCache_[cacheKey] = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  return rcHeaderCache_[cacheKey].slice();
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

function readSettings_() {
  const result = {};
  readObjects_(RC_CONFIG.SHEETS.SETTINGS).forEach(row => {
    let value = row.VALUE;
    if (row.TYPE === 'BOOLEAN') value = String(value).toUpperCase() === 'TRUE';
    if (row.TYPE === 'NUMBER') value = Number(value);
    result[row.KEY] = value;
  });
  return result;
}
