// RC-00 — Fondasi instance Record Center.
// Cakupan: installer, folder terpisah, RC_SOURCE_REGISTRY, shared secret di
// Script Properties, health check, audit, backup. Lihat handoff §13.2 dan
// §14 (definition of done RC-00) serta docs/ADDENDUM_2026-08-20 untuk
// keputusan protokol yang melengkapi bagian ini.
//
// Sengaja TIDAK termasuk di sini: doPost/endpoint federatif, RC_INBOX_EVENTS,
// RC_DECISION_OUTBOX, dan sheet PENERIMAAN_USUL_* — itu scope RC-01, dibangun
// setelah kolomnya diselaraskan dengan payload aktual dari Central File.

var RC_SETTINGS_HEADERS_ = ['KEY', 'VALUE', 'TYPE', 'DESCRIPTION'];
var RC_SOURCE_REGISTRY_HEADERS_ = [
  'SOURCE_ID', 'SOURCE_UNIT_NAME', 'SOURCE_UNIT_CODE', 'SOURCE_ADMIN_EMAIL',
  'STATUS', 'SECRET_CONFIGURED', 'SECRET_UPDATED_AT',
  'REGISTERED_AT', 'REGISTERED_BY', 'UPDATED_AT', 'UPDATED_BY', 'NOTES'
];
var RC_AUDIT_HEADERS_ = [
  'LOG_ID', 'TIMESTAMP', 'USER_EMAIL', 'AKSI', 'MODUL', 'JENIS_OBJEK',
  'OBJEK_ID', 'RINGKASAN', 'ALASAN', 'REQUEST_ID', 'STATUS'
];
var RC_MIGRATION_HEADERS_ = [
  'MIGRATION_ID', 'SCHEMA_VERSION', 'RELEASE_VERSION', 'DESCRIPTION',
  'APPLIED_AT', 'APPLIED_BY', 'STATUS'
];
var RC_HEALTH_HEADERS_ = [
  'HEALTH_ID', 'CHECKED_AT', 'CHECKED_BY', 'RELEASE_VERSION',
  'SCHEMA_VERSION', 'OVERALL_STATUS', 'CHECKS_JSON'
];
var RC_BACKUP_HEADERS_ = [
  'BACKUP_ID', 'BACKUP_TYPE', 'STARTED_AT', 'COMPLETED_AT', 'CREATED_BY',
  'STATUS', 'SPREADSHEET_COPY_ID', 'SPREADSHEET_COPY_URL',
  'BACKUP_FOLDER_ID', 'BACKUP_FOLDER_URL', 'MANIFEST_FILE_ID',
  'DRIVE_FILE_COUNT', 'DRIVE_FOLDER_COUNT', 'NOTES'
];
var RC_TRIGGER_HANDLERS_ = ['scheduledDailyRcMaintenance'];
var RC_BACKUP_WARNING_HOURS_DEFAULT_ = 36;

function showRcInstallerDialog() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (spreadsheet) {
    PropertiesService.getUserProperties().setProperty(
      'RC_INSTALLER_ACTIVE_SPREADSHEET_ID', spreadsheet.getId());
  }
  const html = HtmlService.createHtmlOutputFromFile('AdminSetup')
    .setWidth(920)
    .setHeight(760);
  SpreadsheetApp.getUi().showModalDialog(html, 'Instalasi & Reliability — Record Center');
}

function getInstanceSetup_() {
  const spreadsheet = getInstallerSpreadsheet_();
  const configuredId = getInstanceSpreadsheetId_(true);
  const values = readSettingsFromSpreadsheet_(spreadsheet);
  const activeUser = getCurrentUser_();
  return {
    release: RC_RELEASE,
    spreadsheetId: spreadsheet.getId(),
    spreadsheetName: spreadsheet.getName(),
    configuredSpreadsheetId: configuredId,
    rebindRequired: Boolean(configuredId && configuredId !== spreadsheet.getId()),
    installed: configuredId === spreadsheet.getId() &&
      Boolean(values.RC_INSTANCE_ID && values.RC_ADMIN_EMAIL),
    defaults: {
      rcName: cleanText_(values.RC_NAME, 250) ||
        'Record Center Rektorat / Unit Kearsipan I UINSA',
      adminName: cleanText_(values.RC_ADMIN_NAME, 250),
      adminEmail: cleanText_(values.RC_ADMIN_EMAIL, 250) || activeUser,
      additionalAdminEmails: cleanText_(values.RC_ADDITIONAL_ADMIN_EMAILS, 1000),
      location: cleanText_(values.RC_LOCATION, 100) || 'Surabaya',
      rootFolderId: cleanText_(values.RC_ROOT_FOLDER_ID, 200)
    }
  };
}

function readSettingsFromSpreadsheet_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(RC_CONFIG.SHEETS.SETTINGS);
  if (!sheet || sheet.getLastRow() < 2) return {};
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getValues();
  const result = {};
  values.forEach(row => {
    if (!row[0]) return;
    let value = row[1];
    if (row[2] === 'BOOLEAN') value = String(value).toUpperCase() === 'TRUE';
    if (row[2] === 'NUMBER') value = Number(value);
    result[row[0]] = value;
  });
  return result;
}

function installRecordCenterInstance_(form) {
  form = form || {};
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const spreadsheet = getInstallerSpreadsheet_();
    const configuredId = getInstanceSpreadsheetId_(true);
    if (configuredId && configuredId !== spreadsheet.getId() &&
        !rcBoolean_(form.confirmRebind)) {
      throw new Error(
        'Spreadsheet ini masih menunjuk ke instance Record Center lain. ' +
        'Centang konfirmasi pengikatan ulang agar data tidak tercampur.'
      );
    }

    const rcName = cleanText_(requireValue_(form.rcName, 'Nama Record Center'), 250);
    const adminName = cleanText_(requireValue_(form.adminName, 'Nama administrator'), 250);
    const adminEmail = normalizeEmail_(requireValue_(form.adminEmail, 'Email administrator'));
    const additionalAdminEmails = String(form.additionalAdminEmails || '')
      .split(',').map(value => value.trim()).filter(Boolean)
      .map(value => normalizeEmail_(value)).join(', ');
    const location = cleanText_(form.location, 100) || 'Surabaya';
    const rootFolderId = cleanText_(
      requireValue_(form.rootFolderId, 'ID folder induk Record Center'), 200);
    const rootFolder = DriveApp.getFolderById(rootFolderId);

    setInstanceSpreadsheetId_(spreadsheet.getId());
    ensureRcSchema_();

    const existingSettings = readSettingsFromSpreadsheet_(spreadsheet);
    const transferInboxFolder = getOrCreateChildFolder_(
      rootFolder, RC_CONFIG.FOLDERS.TRANSFER_INBOX);
    const inactiveArchiveFolder = getOrCreateChildFolder_(
      rootFolder, RC_CONFIG.FOLDERS.INACTIVE_ARCHIVE);
    const quarantineFolder = getOrCreateChildFolder_(
      rootFolder, RC_CONFIG.FOLDERS.QUARANTINE);
    const backupFolder = getOrCreateChildFolder_(
      rootFolder, RC_CONFIG.FOLDERS.BACKUP);

    const properties = PropertiesService.getScriptProperties();
    const instanceId = properties.getProperty('RC_INSTANCE_ID') ||
      'RC-' + Utilities.getUuid();
    properties.setProperties({
      RC_INSTANCE_ID: instanceId,
      RC_RELEASE_VERSION: RC_RELEASE.VERSION,
      RC_SCHEMA_VERSION: String(RC_RELEASE.SCHEMA_VERSION)
    }, false);

    const settings = [
      ['RC_INSTANCE_ID', instanceId, 'STRING', 'ID unik instance Record Center'],
      ['RC_NAME', rcName, 'STRING', 'Nama resmi Record Center'],
      ['RC_ADMIN_NAME', adminName, 'STRING', 'Nama administrator instance'],
      ['RC_ADMIN_EMAIL', adminEmail, 'STRING', 'Email administrator utama (guard dashboard)'],
      ['RC_ADDITIONAL_ADMIN_EMAILS', additionalAdminEmails, 'STRING',
        'Email admin tambahan dipisah koma, opsional'],
      ['RC_LOCATION', location, 'STRING', 'Lokasi default dokumen'],
      ['RC_TIME_ZONE', RC_CONFIG.TIME_ZONE, 'STRING', 'Zona waktu instance'],
      ['RC_RELEASE_VERSION', RC_RELEASE.VERSION, 'STRING', 'Versi paket aplikasi'],
      ['RC_SCHEMA_VERSION', RC_RELEASE.SCHEMA_VERSION, 'NUMBER', 'Versi struktur database'],
      ['RC_ROOT_FOLDER_ID', rootFolder.getId(), 'STRING', 'Folder induk Record Center'],
      ['RC_ROOT_FOLDER_URL', rootFolder.getUrl(), 'URL', 'Tautan folder induk'],
      ['TRANSFER_INBOX_FOLDER_ID', transferInboxFolder.getId(), 'STRING',
        'Folder penerimaan usul pindah (dipakai mulai RC-01)'],
      ['TRANSFER_INBOX_FOLDER_URL', transferInboxFolder.getUrl(), 'URL', 'Tautan folder penerimaan usul pindah'],
      ['INACTIVE_ARCHIVE_FOLDER_ID', inactiveArchiveFolder.getId(), 'STRING',
        'Folder arsip inaktif (dipakai mulai RC-03)'],
      ['INACTIVE_ARCHIVE_FOLDER_URL', inactiveArchiveFolder.getUrl(), 'URL', 'Tautan folder arsip inaktif'],
      ['QUARANTINE_FOLDER_ID', quarantineFolder.getId(), 'STRING', 'Folder karantina file'],
      ['QUARANTINE_FOLDER_URL', quarantineFolder.getUrl(), 'URL', 'Tautan folder karantina'],
      ['BACKUP_FOLDER_ID', backupFolder.getId(), 'STRING', 'Folder backup instance'],
      ['BACKUP_FOLDER_URL', backupFolder.getUrl(), 'URL', 'Tautan folder backup'],
      ['BACKUP_WARNING_HOURS', RC_BACKUP_WARNING_HOURS_DEFAULT_, 'NUMBER',
        'Batas umur backup sebelum peringatan'],
      ['BACKUP_DAILY_ENABLED', true, 'BOOLEAN', 'Backup metadata harian']
    ];
    upsertRcSettingsBatch_(settings);
    applyRcMigrations_();
    installRcTriggers_();
    protectRcSheets_();

    audit_(
      'INSTALL', 'RELIABILITY', 'INSTANCE', instanceId,
      'Mengonfigurasi instance Record Center ' + rcName + ' pada rilis ' + RC_RELEASE.VERSION,
      'Installer RC-00; spreadsheet ' + spreadsheet.getId(),
      'SUCCESS'
    );
    const health = runRcHealthCheck_(true);
    return {
      ok: true,
      instanceId: instanceId,
      rcName: rcName,
      spreadsheetId: spreadsheet.getId(),
      transferInboxFolderUrl: transferInboxFolder.getUrl(),
      inactiveArchiveFolderUrl: inactiveArchiveFolder.getUrl(),
      quarantineFolderUrl: quarantineFolder.getUrl(),
      backupFolderUrl: backupFolder.getUrl(),
      health: health,
      message: 'Instance Record Center ' + rcName + ' berhasil dipasang (RC-00). ' +
        'Lanjutkan mendaftarkan sumber Central File dan jalankan Backup Sekarang.'
    };
  } finally {
    lock.releaseLock();
  }
}

function getOrCreateChildFolder_(parent, name) {
  const existing = parent.getFoldersByName(name);
  if (existing.hasNext()) return existing.next();
  return parent.createFolder(name);
}

function ensureRcSchema_() {
  ensureSystemSheet_(RC_CONFIG.SHEETS.SETTINGS, RC_SETTINGS_HEADERS_, [260, 340, 110, 420]);
  ensureSystemSheet_(RC_CONFIG.SHEETS.SOURCE_REGISTRY, RC_SOURCE_REGISTRY_HEADERS_,
    [200, 240, 140, 240, 110, 140, 190, 190, 240, 190, 240, 360]);
  ensureSystemSheet_(RC_CONFIG.SHEETS.AUDIT, RC_AUDIT_HEADERS_,
    [200, 190, 240, 120, 160, 160, 200, 360, 300, 200, 110]);
  ensureSystemSheet_(RC_CONFIG.SHEETS.SYSTEM_MIGRATIONS, RC_MIGRATION_HEADERS_,
    [200, 110, 110, 360, 190, 240, 110]);
  ensureSystemSheet_(RC_CONFIG.SHEETS.SYSTEM_HEALTH, RC_HEALTH_HEADERS_,
    [200, 190, 240, 110, 110, 130, 640]);
  ensureSystemSheet_(RC_CONFIG.SHEETS.SYSTEM_BACKUPS, RC_BACKUP_HEADERS_,
    [200, 150, 190, 190, 240, 120, 220, 260, 220, 260, 220, 130, 130, 360]);
  return true;
}

function ensureSystemSheet_(sheetName, headers, widths) {
  const spreadsheet = getSpreadsheet_();
  let sheet = spreadsheet.getSheetByName(sheetName);
  let changed = false;
  if (!sheet) {
    sheet = spreadsheet.insertSheet(sheetName);
    changed = true;
  }
  if (sheet.getMaxColumns() < headers.length) {
    sheet.insertColumnsAfter(
      sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
    changed = true;
  }
  const existing = sheet.getRange(
    1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getDisplayValues()[0];
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
    rcHeaderCache_ = {};
  }
  return sheet;
}

function upsertRcSettingsBatch_(rows) {
  ensureSystemSheet_(RC_CONFIG.SHEETS.SETTINGS, RC_SETTINGS_HEADERS_, [260, 340, 110, 420]);
  const existing = readObjects_(RC_CONFIG.SHEETS.SETTINGS);
  const byKey = {};
  existing.forEach(row => byKey[row.KEY] = row);
  const updates = [];
  const appends = [];
  rows.forEach(row => {
    const object = {KEY: row[0], VALUE: row[1], TYPE: row[2], DESCRIPTION: row[3]};
    const current = byKey[row[0]];
    if (current) updates.push({rowNumber: current._rowNumber, changes: object});
    else appends.push(object);
  });
  if (updates.length) updateObjectsAtRows_(RC_CONFIG.SHEETS.SETTINGS, updates);
  if (appends.length) appendObjects_(RC_CONFIG.SHEETS.SETTINGS, appends);
}

function applyRcMigrations_() {
  const migrations = [
    {
      id: 'RC-REL-001',
      version: 1,
      description: 'Fondasi instance RC-00: settings, source registry, audit, migrasi, health, backup'
    }
  ];
  const applied = readObjects_(RC_CONFIG.SHEETS.SYSTEM_MIGRATIONS);
  migrations.forEach(migration => {
    if (applied.some(row => String(row.MIGRATION_ID) === migration.id &&
        String(row.STATUS) === 'SUCCESS')) return;
    try {
      if (typeof migration.run === 'function') migration.run();
      appendObject_(RC_CONFIG.SHEETS.SYSTEM_MIGRATIONS, {
        MIGRATION_ID: migration.id,
        SCHEMA_VERSION: migration.version,
        RELEASE_VERSION: RC_RELEASE.VERSION,
        DESCRIPTION: migration.description,
        APPLIED_AT: nowIso_(),
        APPLIED_BY: getCurrentUser_(),
        STATUS: 'SUCCESS'
      });
    } catch (error) {
      appendObject_(RC_CONFIG.SHEETS.SYSTEM_MIGRATIONS, {
        MIGRATION_ID: migration.id,
        SCHEMA_VERSION: migration.version,
        RELEASE_VERSION: RC_RELEASE.VERSION,
        DESCRIPTION: migration.description + ' | ' + cleanText_(error.message, 500),
        APPLIED_AT: nowIso_(),
        APPLIED_BY: getCurrentUser_(),
        STATUS: 'FAILED'
      });
      throw error;
    }
  });
}

function protectRcSheets_() {
  const spreadsheet = getSpreadsheet_();
  Object.keys(RC_CONFIG.SHEETS).forEach(key => {
    const sheet = spreadsheet.getSheetByName(RC_CONFIG.SHEETS[key]);
    if (!sheet) return;
    const existing = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
    if (existing.length) return;
    try {
      sheet.protect()
        .setDescription('Sheet sistem RC-00 — ubah melalui menu Record Center, bukan manual.')
        .setWarningOnly(true);
    } catch (ignore) { /* protection API dapat dibatasi kebijakan domain; tidak fatal */ }
  });
}

function installRcTriggers_() {
  const existingHandlers = ScriptApp.getProjectTriggers().map(trigger => trigger.getHandlerFunction());
  if (existingHandlers.indexOf('scheduledDailyRcMaintenance') === -1) {
    ScriptApp.newTrigger('scheduledDailyRcMaintenance')
      .timeBased().everyDays(1).atHour(2).create();
  }
}

function getRcTriggerStatus_() {
  const existingHandlers = ScriptApp.getProjectTriggers().map(trigger => trigger.getHandlerFunction());
  return RC_TRIGGER_HANDLERS_.map(handler => ({
    handler: handler,
    installed: existingHandlers.indexOf(handler) !== -1
  }));
}

function scheduledDailyRcMaintenance() {
  try {
    runRcHealthCheck_(true);
    const settings = readSettings_();
    if (rcBoolean_(settings.BACKUP_DAILY_ENABLED)) startRcBackup_();
  } catch (error) {
    try {
      audit_('MAINTENANCE', 'RELIABILITY', 'SISTEM', '', 'Maintenance harian RC gagal',
        error.message, 'FAILED');
    } catch (ignore) { /* jangan sampai error audit menutupi error asli */ }
  }
}

function startRcBackup_() {
  const settings = readSettings_();
  const timestamp = nowIso_();
  const backupId = 'RCBAK-' + Utilities.getUuid();
  const backupFolder = DriveApp.getFolderById(
    requireValue_(settings.BACKUP_FOLDER_ID, 'BACKUP_FOLDER_ID'));
  const dateStamp = Utilities.formatDate(new Date(), RC_CONFIG.TIME_ZONE, 'yyyyMMdd_HHmmss');
  let copy;
  let manifestFile;
  let fileCount = 0;
  let folderCount = 0;
  try {
    copy = DriveApp.getFileById(getInstanceSpreadsheetId_())
      .makeCopy('RC_BACKUP_' + dateStamp + '_' + backupId.slice(6, 14), backupFolder);
    const counts = countFolderContents_(
      DriveApp.getFolderById(requireValue_(settings.RC_ROOT_FOLDER_ID, 'RC_ROOT_FOLDER_ID')));
    fileCount = counts.fileCount;
    folderCount = counts.folderCount;
    const manifestText = [
      'RC_BACKUP_ID: ' + backupId,
      'TIMESTAMP: ' + timestamp,
      'SPREADSHEET_COPY_ID: ' + copy.getId(),
      'DRIVE_FILE_COUNT: ' + fileCount,
      'DRIVE_FOLDER_COUNT: ' + folderCount
    ].join('\n');
    manifestFile = backupFolder.createFile(
      Utilities.newBlob(manifestText, 'text/plain',
        'MANIFEST_' + dateStamp + '_' + backupId.slice(6, 14) + '.txt'));
    appendObject_(RC_CONFIG.SHEETS.SYSTEM_BACKUPS, {
      BACKUP_ID: backupId,
      BACKUP_TYPE: 'METADATA_MANIFEST',
      STARTED_AT: timestamp,
      COMPLETED_AT: nowIso_(),
      CREATED_BY: getCurrentUser_(),
      STATUS: 'COMPLETE',
      SPREADSHEET_COPY_ID: copy.getId(),
      SPREADSHEET_COPY_URL: copy.getUrl(),
      BACKUP_FOLDER_ID: backupFolder.getId(),
      BACKUP_FOLDER_URL: backupFolder.getUrl(),
      MANIFEST_FILE_ID: manifestFile.getId(),
      DRIVE_FILE_COUNT: fileCount,
      DRIVE_FOLDER_COUNT: folderCount,
      NOTES: 'Backup sinkron RC-00. Untuk volume besar, adopsi pola job/queue ' +
        'seperti central-file/ReliabilityService.js.'
    });
    audit_('BACKUP', 'RELIABILITY', 'BACKUP', backupId,
      'Backup metadata RC berhasil (' + fileCount + ' file, ' + folderCount + ' folder)',
      '', 'SUCCESS');
    return {ok: true, backupId: backupId, spreadsheetCopyUrl: copy.getUrl(),
      manifestFileUrl: manifestFile.getUrl(), fileCount: fileCount, folderCount: folderCount};
  } catch (error) {
    appendObject_(RC_CONFIG.SHEETS.SYSTEM_BACKUPS, {
      BACKUP_ID: backupId,
      BACKUP_TYPE: 'METADATA_MANIFEST',
      STARTED_AT: timestamp,
      COMPLETED_AT: nowIso_(),
      CREATED_BY: getCurrentUser_(),
      STATUS: 'FAILED',
      NOTES: cleanText_(error.message, 500)
    });
    audit_('BACKUP', 'RELIABILITY', 'BACKUP', backupId, 'Backup metadata RC gagal',
      error.message, 'FAILED');
    throw error;
  }
}

function countFolderContents_(folder) {
  let fileCount = 0;
  let folderCount = 0;
  const files = folder.getFiles();
  while (files.hasNext()) { files.next(); fileCount++; }
  const folders = folder.getFolders();
  while (folders.hasNext()) {
    folderCount++;
    const counts = countFolderContents_(folders.next());
    fileCount += counts.fileCount;
    folderCount += counts.folderCount;
  }
  return {fileCount: fileCount, folderCount: folderCount};
}

function runRcHealthCheck_(persist) {
  ensureRcSchema_();
  const checks = [];
  const spreadsheet = getSpreadsheet_();
  const settings = readSettings_();
  const configuredId = getInstanceSpreadsheetId_(true);

  addRcCheck_(checks, 'INSTANCE_BINDING',
    configuredId === spreadsheet.getId() ? 'OK' : 'ERROR',
    configuredId === spreadsheet.getId()
      ? 'Spreadsheet terikat ke instance ini.'
      : 'ID spreadsheet tidak cocok dengan konfigurasi instance.');

  addRcCheck_(checks, 'SCHEMA_VERSION',
    Number(settings.RC_SCHEMA_VERSION || 0) === RC_RELEASE.SCHEMA_VERSION ? 'OK' : 'ERROR',
    'Schema ' + String(settings.RC_SCHEMA_VERSION || 'belum ada') +
      '; paket membutuhkan ' + RC_RELEASE.SCHEMA_VERSION + '.');

  const requiredSheets = Object.keys(RC_CONFIG.SHEETS).map(key => RC_CONFIG.SHEETS[key]);
  const sheetNames = spreadsheet.getSheets().map(sheet => sheet.getName());
  const missingSheets = requiredSheets.filter(name => sheetNames.indexOf(name) === -1);
  addRcCheck_(checks, 'REQUIRED_SHEETS', missingSheets.length ? 'ERROR' : 'OK',
    missingSheets.length ? 'Sheet hilang: ' + missingSheets.join(', ')
      : 'Seluruh sheet fondasi RC-00 tersedia.');

  [
    ['TRANSFER_INBOX_FOLDER_ID', 'Folder ' + RC_CONFIG.FOLDERS.TRANSFER_INBOX],
    ['INACTIVE_ARCHIVE_FOLDER_ID', 'Folder ' + RC_CONFIG.FOLDERS.INACTIVE_ARCHIVE],
    ['QUARANTINE_FOLDER_ID', 'Folder ' + RC_CONFIG.FOLDERS.QUARANTINE],
    ['BACKUP_FOLDER_ID', 'Folder ' + RC_CONFIG.FOLDERS.BACKUP]
  ].forEach(entry => {
    let status = 'OK';
    let detail = entry[1] + ' dapat diakses.';
    try {
      DriveApp.getFolderById(requireValue_(settings[entry[0]], entry[0]));
    } catch (error) {
      status = 'ERROR';
      detail = entry[1] + ' tidak dapat diakses: ' + error.message;
    }
    addRcCheck_(checks, entry[0], status, detail);
  });

  const adminConfigured = Boolean(settings.RC_ADMIN_EMAIL);
  addRcCheck_(checks, 'ADMIN_GUARD', adminConfigured ? 'OK' : 'ERROR',
    adminConfigured
      ? 'Dashboard dibatasi untuk ' + settings.RC_ADMIN_EMAIL +
        (settings.RC_ADDITIONAL_ADMIN_EMAILS ? ' + ' + settings.RC_ADDITIONAL_ADMIN_EMAILS : '')
      : 'Email administrator belum dikonfigurasi; dashboard tidak dapat memvalidasi akses.');

  const sources = readObjects_(RC_CONFIG.SHEETS.SOURCE_REGISTRY);
  const activeSources = sources.filter(row => String(row.STATUS).toUpperCase() === 'AKTIF');
  addRcCheck_(checks, 'SOURCE_REGISTRY', 'OK',
    activeSources.length + ' sumber Central File aktif terdaftar dari ' + sources.length + ' total.');

  const triggerStatus = getRcTriggerStatus_();
  const missingTriggers = triggerStatus.filter(item => !item.installed).map(item => item.handler);
  addRcCheck_(checks, 'TRIGGERS', missingTriggers.length ? 'WARNING' : 'OK',
    missingTriggers.length ? 'Trigger belum tersedia: ' + missingTriggers.join(', ')
      : 'Trigger maintenance harian aktif.');

  const backups = readObjects_(RC_CONFIG.SHEETS.SYSTEM_BACKUPS)
    .filter(row => row.STATUS === 'COMPLETE')
    .sort((a, b) => String(b.COMPLETED_AT).localeCompare(String(a.COMPLETED_AT)));
  if (!backups.length) {
    addRcCheck_(checks, 'LATEST_BACKUP', 'WARNING', 'Belum ada backup lengkap. Jalankan Backup Sekarang.');
  } else {
    const ageHours = Math.max(0, (Date.now() - new Date(backups[0].COMPLETED_AT).getTime()) / 3600000);
    const warningHours = Number(settings.BACKUP_WARNING_HOURS || RC_BACKUP_WARNING_HOURS_DEFAULT_);
    addRcCheck_(checks, 'LATEST_BACKUP', ageHours > warningHours ? 'WARNING' : 'OK',
      'Backup terakhir ' + Math.round(ageHours * 10) / 10 + ' jam lalu.');
  }

  addRcCheck_(checks, 'RC01_ENDPOINT_SCOPE', 'WARNING',
    'Endpoint federatif, RC_INBOX_EVENTS, RC_DECISION_OUTBOX, dan tabel penerimaan usul ' +
    'pindah belum dibangun. Ini scope RC-01, bukan kegagalan RC-00.');

  const status = checks.some(check => check.status === 'ERROR') ? 'ERROR'
    : (checks.some(check => check.status === 'WARNING') ? 'WARNING' : 'OK');
  const result = {
    ok: status !== 'ERROR',
    overallStatus: status,
    releaseVersion: RC_RELEASE.VERSION,
    schemaVersion: RC_RELEASE.SCHEMA_VERSION,
    checkedAt: nowIso_(),
    instance: getInstancePresentation_(),
    checks: checks
  };
  if (persist !== false) {
    appendObject_(RC_CONFIG.SHEETS.SYSTEM_HEALTH, {
      HEALTH_ID: 'RCHLT-' + Utilities.getUuid(),
      CHECKED_AT: result.checkedAt,
      CHECKED_BY: getCurrentUser_(),
      RELEASE_VERSION: RC_RELEASE.VERSION,
      SCHEMA_VERSION: RC_RELEASE.SCHEMA_VERSION,
      OVERALL_STATUS: status,
      CHECKS_JSON: JSON.stringify(checks)
    });
  }
  return result;
}

function addRcCheck_(checks, code, status, detail) {
  checks.push({code: code, status: status, detail: detail});
}

function getInstancePresentation_() {
  const settings = readSettings_();
  return {
    instanceId: cleanText_(settings.RC_INSTANCE_ID, 100),
    rcName: cleanText_(settings.RC_NAME, 250),
    adminName: cleanText_(settings.RC_ADMIN_NAME, 250),
    adminEmail: cleanText_(settings.RC_ADMIN_EMAIL, 250),
    releaseVersion: RC_RELEASE.VERSION,
    schemaVersion: RC_RELEASE.SCHEMA_VERSION
  };
}

function getRcDashboard_() {
  const setup = getInstanceSetup_();
  if (!setup.installed) return {setup: setup, installed: false};
  const health = runRcHealthCheck_(false);
  const sources = listSources_();
  const backups = readObjects_(RC_CONFIG.SHEETS.SYSTEM_BACKUPS)
    .filter(row => row.BACKUP_ID)
    .sort((a, b) => String(b.STARTED_AT).localeCompare(String(a.STARTED_AT)))
    .slice(0, 5);
  return {
    setup: setup,
    installed: true,
    instance: getInstancePresentation_(),
    health: health,
    sources: sources,
    recentBackups: backups
  };
}

// --- Registry sumber Central File -----------------------------------------

function registerSource_(form) {
  form = form || {};
  requireRecordCenterAdmin_();
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sourceId = cleanText_(requireValue_(form.sourceId, 'Instance ID Central File'), 150);
    const unitName = cleanText_(requireValue_(form.unitName, 'Nama unit'), 250);
    const unitCode = cleanText_(form.unitCode, 30);
    const adminEmail = normalizeEmail_(requireValue_(form.adminEmail, 'Email administrator unit'));
    const notes = cleanText_(form.notes, 500);
    const timestamp = nowIso_();
    const user = getCurrentUser_();

    const rows = readObjects_(RC_CONFIG.SHEETS.SOURCE_REGISTRY);
    const existing = rows.find(row => String(row.SOURCE_ID) === sourceId);

    let plainSecret = '';
    const shouldIssueSecret = rcBoolean_(form.generateNewSecret) || !existing;
    if (shouldIssueSecret) {
      plainSecret = Utilities.getUuid().replace(/-/g, '') +
        Utilities.getUuid().replace(/-/g, '');
      PropertiesService.getScriptProperties().setProperty(
        rcSourceSecretPropertyKey_(sourceId), plainSecret);
    }

    const record = {
      SOURCE_ID: sourceId,
      SOURCE_UNIT_NAME: unitName,
      SOURCE_UNIT_CODE: unitCode,
      SOURCE_ADMIN_EMAIL: adminEmail,
      STATUS: 'AKTIF',
      SECRET_CONFIGURED: true,
      SECRET_UPDATED_AT: shouldIssueSecret ? timestamp : (existing ? existing.SECRET_UPDATED_AT : timestamp),
      REGISTERED_AT: existing ? existing.REGISTERED_AT : timestamp,
      REGISTERED_BY: existing ? existing.REGISTERED_BY : user,
      UPDATED_AT: timestamp,
      UPDATED_BY: user,
      NOTES: notes
    };
    if (existing) updateObjectAtRow_(RC_CONFIG.SHEETS.SOURCE_REGISTRY, existing._rowNumber, record);
    else appendObject_(RC_CONFIG.SHEETS.SOURCE_REGISTRY, record);

    audit_(existing ? 'UPDATE' : 'REGISTER', 'SOURCE_REGISTRY', 'SOURCE', sourceId,
      (existing ? 'Memperbarui' : 'Mendaftarkan') + ' sumber Central File: ' + unitName +
      (shouldIssueSecret ? ' (secret baru diterbitkan)' : ''),
      '', 'SUCCESS');

    return {
      ok: true,
      sourceId: sourceId,
      secretIssued: shouldIssueSecret,
      // Secret plaintext HANYA muncul di respons ini, sekali, tepat setelah
      // diterbitkan — tidak pernah ditulis ke sheet (§20.3). Salin sekarang
      // ke installer Central File; tidak akan ditampilkan lagi setelah ini.
      secret: plainSecret,
      message: shouldIssueSecret
        ? 'Sumber terdaftar. Salin shared secret sekarang — tidak akan ditampilkan lagi.'
        : 'Sumber diperbarui tanpa mengubah shared secret.'
    };
  } finally {
    lock.releaseLock();
  }
}

function listSources_() {
  return readObjects_(RC_CONFIG.SHEETS.SOURCE_REGISTRY)
    .map(row => ({
      sourceId: row.SOURCE_ID,
      unitName: row.SOURCE_UNIT_NAME,
      unitCode: row.SOURCE_UNIT_CODE,
      adminEmail: row.SOURCE_ADMIN_EMAIL,
      status: row.STATUS,
      secretConfigured: rcBoolean_(row.SECRET_CONFIGURED),
      secretUpdatedAt: row.SECRET_UPDATED_AT,
      registeredAt: row.REGISTERED_AT,
      notes: row.NOTES
    }))
    .sort((a, b) => String(a.unitName).localeCompare(String(b.unitName)));
}

function deactivateSource_(form) {
  form = form || {};
  requireRecordCenterAdmin_();
  const sourceId = cleanText_(requireValue_(form.sourceId, 'Instance ID Central File'), 150);
  const reason = cleanText_(requireValue_(form.reason, 'Alasan nonaktifkan'), 500);
  if (reason.length < 10) throw new Error('Alasan minimal 10 karakter.');
  const rows = readObjects_(RC_CONFIG.SHEETS.SOURCE_REGISTRY);
  const existing = rows.find(row => String(row.SOURCE_ID) === sourceId);
  if (!existing) throw new Error('Sumber tidak ditemukan.');
  const timestamp = nowIso_();
  updateObjectAtRow_(RC_CONFIG.SHEETS.SOURCE_REGISTRY, existing._rowNumber, {
    STATUS: 'NONAKTIF', UPDATED_AT: timestamp, UPDATED_BY: getCurrentUser_(),
    NOTES: cleanText_((existing.NOTES ? existing.NOTES + ' | ' : '') + 'Nonaktif: ' + reason, 500)
  });
  audit_('DEACTIVATE', 'SOURCE_REGISTRY', 'SOURCE', sourceId,
    'Menonaktifkan sumber Central File', reason, 'SUCCESS');
  return {ok: true, message: 'Sumber dinonaktifkan. Event dari instance ini akan ditolak RC-01.'};
}

// Dipakai RC-01 nanti untuk memvalidasi source aktif + mengambil secret saat
// memverifikasi signature; disediakan sekarang karena registry-nya sudah ada.
function isSourceActive_(sourceId) {
  const rows = readObjects_(RC_CONFIG.SHEETS.SOURCE_REGISTRY);
  const row = rows.find(item => String(item.SOURCE_ID) === String(sourceId));
  return Boolean(row && String(row.STATUS).toUpperCase() === 'AKTIF');
}

function getSourceSecret_(sourceId) {
  return PropertiesService.getScriptProperties()
    .getProperty(rcSourceSecretPropertyKey_(sourceId)) || '';
}

function rcSourceSecretPropertyKey_(sourceId) {
  return 'SOURCE_SECRET_' + cleanText_(sourceId, 150);
}
