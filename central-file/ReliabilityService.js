var RELIABILITY_MIGRATION_HEADERS_ = [
  'MIGRATION_ID', 'SCHEMA_VERSION', 'RELEASE_VERSION', 'DESCRIPTION',
  'APPLIED_AT', 'APPLIED_BY', 'STATUS'
];
var RELIABILITY_BACKUP_HEADERS_ = [
  'BACKUP_ID', 'BACKUP_TYPE', 'STARTED_AT', 'COMPLETED_AT', 'CREATED_BY',
  'STATUS', 'SPREADSHEET_COPY_ID', 'SPREADSHEET_COPY_URL',
  'BACKUP_FOLDER_ID', 'BACKUP_FOLDER_URL', 'MANIFEST_FILE_ID',
  'DRIVE_FILE_COUNT', 'DRIVE_FOLDER_COUNT', 'COPIED_FILE_COUNT',
  'ERROR_COUNT', 'NOTES'
];
var RELIABILITY_JOB_HEADERS_ = [
  'JOB_ID', 'JOB_TYPE', 'BACKUP_ID', 'STATUS', 'STARTED_AT', 'UPDATED_AT',
  'COMPLETED_AT', 'CREATED_BY', 'RECORDS_PROCESSED', 'ERROR_COUNT', 'MESSAGE'
];
var RELIABILITY_QUEUE_HEADERS_ = [
  'QUEUE_ID', 'JOB_ID', 'SOURCE_FOLDER_ID', 'SOURCE_PATH',
  'DESTINATION_FOLDER_ID', 'STAGE', 'FILE_TOKEN', 'FOLDER_TOKEN',
  'STATUS', 'CREATED_AT', 'UPDATED_AT'
];
var RELIABILITY_HEALTH_HEADERS_ = [
  'HEALTH_ID', 'CHECKED_AT', 'CHECKED_BY', 'RELEASE_VERSION',
  'SCHEMA_VERSION', 'OVERALL_STATUS', 'CHECKS_JSON'
];
var RELIABILITY_QUARANTINE_HEADERS_ = [
  'QUARANTINE_ID', 'TIMESTAMP', 'USER_EMAIL', 'OBJECT_TYPE', 'OBJECT_ID',
  'ORIGINAL_NAME', 'ORIGINAL_URL', 'ORIGINAL_PARENT_IDS',
  'QUARANTINE_FOLDER_ID', 'QUARANTINE_URL', 'MODULE', 'REASON',
  'STATUS', 'NOTES'
];

var RELIABILITY_TRIGGER_HANDLERS_ = [
  'scheduledDailyReliabilityMaintenance',
  'scheduledMonthlyFullBackup',
  'continuePendingReliabilityJobs'
];
var RELIABILITY_BACKUP_TYPES_ = ['METADATA_MANIFEST', 'FULL_COPY'];
var RELIABILITY_JOB_MAX_MS_ = 230000;
var RELIABILITY_JOB_MAX_FILES_PER_RUN_ = 350;
var RELIABILITY_JOB_MAX_FOLDERS_PER_RUN_ = 250;

function showReliabilityDialog() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (spreadsheet) {
    PropertiesService.getUserProperties().setProperty(
      'INSTALLER_ACTIVE_SPREADSHEET_ID', spreadsheet.getId());
  }
  const html = HtmlService.createHtmlOutputFromFile('AdminSetup')
    .setWidth(920)
    .setHeight(720);
  SpreadsheetApp.getUi().showModalDialog(html, 'Instalasi & Reliability');
}

function getUnitSetup_() {
  const spreadsheet = getInstallerSpreadsheet_();
  const configuredId = getInstanceSpreadsheetId_(true);
  const values = readSettingsFromSpreadsheet_(spreadsheet);
  const activeUser = getCurrentUser_();
  const scriptProperties = PropertiesService.getScriptProperties();
  const rootFolderId = cleanText_(values.UNIT_ROOT_FOLDER_ID, 200);
  return {
    release: APP_RELEASE,
    spreadsheetId: spreadsheet.getId(),
    spreadsheetName: spreadsheet.getName(),
    configuredSpreadsheetId: configuredId,
    rebindRequired: Boolean(configuredId && configuredId !== spreadsheet.getId()),
    installed: configuredId === spreadsheet.getId() &&
      Boolean(values.INSTANCE_ID && values.UNIT_ID),
    defaults: {
      unitId: cleanText_(values.UNIT_ID, 50),
      unitCode: cleanText_(values.UNIT_CODE, 30),
      unitName: cleanText_(values.UNIT_NAME, 250),
      administratorName: cleanText_(values.UNIT_ADMIN_NAME, 250),
      administratorEmail: cleanText_(values.UNIT_ADMIN_EMAIL, 250) || activeUser,
      receiverName: cleanText_(values.RECEIPT_RECEIVER_NAME, 250),
      receiverUnit: cleanText_(values.RECEIPT_RECEIVER_UNIT, 250),
      location: cleanText_(values.INSTANCE_LOCATION, 100) || 'Surabaya',
      unitRootFolderId: rootFolderId,
      recordCenterName: cleanText_(values.RECORD_CENTER_NAME, 250) ||
        'Record Center Rektorat / Unit Kearsipan I',
      recordCenterEmail: cleanText_(values.RECORD_CENTER_EMAIL, 250),
      recordCenterInstanceId: cleanText_(values.RECORD_CENTER_INSTANCE_ID, 150),
      recordCenterEndpointUrl: cleanText_(values.RECORD_CENTER_ENDPOINT_URL, 1000),
      recordCenterSecretConfigured: Boolean(
        scriptProperties.getProperty('RECORD_CENTER_SHARED_SECRET') ||
        values.RECORD_CENTER_SHARED_SECRET)
    }
  };
}

function installUnitInstance_(form) {
  form = form || {};
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const spreadsheet = getInstallerSpreadsheet_();
    const configuredId = getInstanceSpreadsheetId_(true);
    if (configuredId && configuredId !== spreadsheet.getId() &&
        !reliabilityBoolean_(form.confirmRebind)) {
      throw new Error(
        'Salinan spreadsheet terdeteksi masih menunjuk ke instance lain. ' +
        'Centang konfirmasi pengikatan ulang agar data unit tidak tercampur.'
      );
    }

    const unitId = normalizeUnitCode_(
      requireValue_(form.unitId, 'ID unit'), 50, 'ID unit');
    const unitCode = normalizeUnitCode_(
      requireValue_(form.unitCode, 'Kode singkat unit'), 30, 'Kode singkat unit');
    const unitName = cleanText_(requireValue_(form.unitName, 'Nama unit'), 250);
    const administratorName = cleanText_(
      requireValue_(form.administratorName, 'Nama administrator'), 250);
    const administratorEmail = normalizeEmail_(
      requireValue_(form.administratorEmail, 'Email administrator'));
    const receiverName = cleanText_(form.receiverName, 250);
    const receiverUnit = cleanText_(form.receiverUnit, 250) || unitName;
    const location = cleanText_(form.location, 100) || 'Surabaya';
    const unitRootFolderId = cleanText_(
      requireValue_(form.unitRootFolderId, 'ID folder induk unit'), 200);

    validateBaseTemplate_(spreadsheet);
    const existingSettings = readSettingsFromSpreadsheet_(spreadsheet);
    const secretProperties = PropertiesService.getScriptProperties();
    const recordCenterName = cleanText_(form.recordCenterName, 250) ||
      cleanText_(existingSettings.RECORD_CENTER_NAME, 250) ||
      'Record Center Rektorat / Unit Kearsipan I';
    const recordCenterEmailValue = cleanText_(form.recordCenterEmail, 250) ||
      cleanText_(existingSettings.RECORD_CENTER_EMAIL, 250);
    const recordCenterEmail = recordCenterEmailValue
      ? normalizeEmail_(recordCenterEmailValue) : '';
    const recordCenterInstanceId = cleanText_(form.recordCenterInstanceId, 150) ||
      cleanText_(existingSettings.RECORD_CENTER_INSTANCE_ID, 150);
    const recordCenterEndpointUrl = cleanText_(form.recordCenterEndpointUrl, 1000) ||
      cleanText_(existingSettings.RECORD_CENTER_ENDPOINT_URL, 1000);
    const recordCenterSharedSecret = String(form.recordCenterSharedSecret || '') ||
      String(secretProperties.getProperty('RECORD_CENTER_SHARED_SECRET') || '') ||
      String(existingSettings.RECORD_CENTER_SHARED_SECRET || '');
    if (recordCenterEndpointUrl &&
        !/^https:\/\/script\.google\.com\//i.test(recordCenterEndpointUrl)) {
      throw new Error('Endpoint Record Center harus berupa URL Web App Apps Script.');
    }
    if (form.recordCenterSharedSecret &&
        String(form.recordCenterSharedSecret).length < 32) {
      throw new Error('Shared secret Record Center minimal 32 karakter.');
    }
    const rootFolder = DriveApp.getFolderById(unitRootFolderId);
    setInstanceSpreadsheetId_(spreadsheet.getId());
    ensureReliabilitySchema_();
    ensureReceiptModule_();
    ensureReceiptFilingSchema_();
    ensureCentralFileMetadataSchema_();
    ensureRetentionCf04Schema_();

    const archiveFolder = resolveUnitDataFolder_(
      rootFolder, existingSettings.ARCHIVE_FOLDER_ID, '01 ARSIP AKTIF');
    const quarantineFolder = resolveUnitDataFolder_(
      rootFolder, existingSettings.QUARANTINE_FOLDER_ID, '90 KARANTINA APLIKASI');
    const backupFolder = resolveUnitDataFolder_(
      rootFolder, existingSettings.BACKUP_FOLDER_ID, '99 BACKUP APLIKASI');
    const properties = secretProperties;
    const instanceId = properties.getProperty('INSTANCE_ID') ||
      'INS-' + Utilities.getUuid();
    properties.setProperties({
      INSTANCE_ID: instanceId,
      INSTANCE_UNIT_ID: unitId,
      INSTANCE_RELEASE_VERSION: APP_RELEASE.VERSION,
      INSTANCE_SCHEMA_VERSION: String(APP_RELEASE.SCHEMA_VERSION)
    }, false);
    if (recordCenterSharedSecret) {
      properties.setProperty(
        'RECORD_CENTER_SHARED_SECRET', recordCenterSharedSecret);
    }

    const settings = [
      ['INSTANCE_ID', instanceId, 'STRING', 'ID unik instance aplikasi lintas unit'],
      ['UNIT_ID', unitId, 'STRING', 'ID unit pemilik data'],
      ['UNIT_CODE', unitCode, 'STRING', 'Kode singkat unit untuk nama backup'],
      ['UNIT_NAME', unitName, 'STRING', 'Nama resmi unit kerja'],
      ['UNIT_ADMIN_NAME', administratorName, 'STRING', 'Nama administrator instance'],
      ['UNIT_ADMIN_EMAIL', administratorEmail, 'STRING', 'Email administrator instance'],
      ['INSTANCE_LOCATION', location, 'STRING', 'Lokasi default dokumen'],
      ['INSTANCE_TIME_ZONE', APP_CONFIG.TIME_ZONE, 'STRING', 'Zona waktu instance'],
      ['APP_RELEASE_VERSION', APP_RELEASE.VERSION, 'STRING', 'Versi paket aplikasi'],
      ['SCHEMA_VERSION', APP_RELEASE.SCHEMA_VERSION, 'NUMBER', 'Versi struktur database'],
      ['UNIT_ROOT_FOLDER_ID', rootFolder.getId(), 'STRING', 'Folder induk unit'],
      ['UNIT_ROOT_FOLDER_URL', rootFolder.getUrl(), 'URL', 'Tautan folder induk unit'],
      ['ARCHIVE_FOLDER_ID', archiveFolder.getId(), 'STRING', 'Folder data arsip aktif'],
      ['ARCHIVE_FOLDER_URL', archiveFolder.getUrl(), 'URL', 'Tautan folder data arsip aktif'],
      ['QUARANTINE_FOLDER_ID', quarantineFolder.getId(), 'STRING', 'Folder karantina file'],
      ['QUARANTINE_FOLDER_URL', quarantineFolder.getUrl(), 'URL', 'Tautan folder karantina'],
      ['BACKUP_FOLDER_ID', backupFolder.getId(), 'STRING', 'Folder backup instance'],
      ['BACKUP_FOLDER_URL', backupFolder.getUrl(), 'URL', 'Tautan folder backup'],
      ['BACKUP_DAILY_ENABLED', true, 'BOOLEAN', 'Backup metadata harian'],
      ['BACKUP_MONTHLY_FULL_ENABLED', true, 'BOOLEAN', 'Backup penuh bulanan'],
      ['BACKUP_WARNING_HOURS', 36, 'NUMBER', 'Batas umur backup sebelum peringatan'],
      ['AUDIT_LOG_YEAR', Number(Utilities.formatDate(
        new Date(), APP_CONFIG.TIME_ZONE, 'yyyy')), 'NUMBER', 'Tahun Audit Log aktif'],
      ['ALLOW_PILOT_RESET', false, 'BOOLEAN', 'Penghapusan data pilot dinonaktifkan'],
      ['RECEIPT_RECEIVER_NAME', receiverName, 'STRING', 'Nama penerima default'],
      ['RECEIPT_RECEIVER_UNIT', receiverUnit, 'STRING', 'Unit penerima default'],
      ['ARCHIVE_CREATOR_NAME',
        cleanText_(existingSettings.ARCHIVE_CREATOR_NAME, 250) ||
          CF_METADATA_DEFAULT_CREATOR_,
        'STRING', 'Nama resmi pencipta arsip tingkat institusi'],
      ['RECEIPT_PROOF_FOLDER_ID', '', 'STRING', 'Dibuat ulang pada folder unit'],
      ['RECEIPT_PROOF_FOLDER_URL', '', 'URL', 'Dibuat ulang pada folder unit'],
      ['DELETION_EVIDENCE_FOLDER_ID', '', 'STRING', 'Dibuat ulang pada folder unit'],
      ['RECORD_CENTER_NAME', recordCenterName,
        'STRING', 'Tujuan pengajuan usul pemindahan'],
      ['RECORD_CENTER_EMAIL', recordCenterEmail,
        'STRING', 'Email aplikasi/petugas Record Center'],
      ['RECORD_CENTER_INSTANCE_ID', recordCenterInstanceId,
        'STRING', 'ID instance aplikasi Record Center'],
      ['RECORD_CENTER_ENDPOINT_URL', recordCenterEndpointUrl,
        'URL', 'Endpoint federatif aplikasi Record Center'],
      ['RECORD_CENTER_SHARED_SECRET', '',
        'SECRET', 'Disimpan pada Script Properties; nilai tidak ditampilkan di sheet']
    ];
    upsertReliabilitySettingsBatch_(settings);

    applyReliabilityMigrations_();
    installReliabilityTriggers_();
    protectReliabilitySheets_();
    CacheService.getScriptCache().remove('RECEIPT_MODULE_READY_V1');

    audit_(
      'INSTALL',
      'RELIABILITY',
      'INSTANCE',
      instanceId,
      'Mengonfigurasi instance ' + unitName + ' pada rilis ' + APP_RELEASE.VERSION,
      'Installer unit; spreadsheet ' + spreadsheet.getId(),
      'SUCCESS'
    );
    const health = runReliabilityHealthCheck_(true);
    return {
      ok: true,
      instanceId: instanceId,
      unitId: unitId,
      unitName: unitName,
      spreadsheetId: spreadsheet.getId(),
      archiveFolderUrl: archiveFolder.getUrl(),
      quarantineFolderUrl: quarantineFolder.getUrl(),
      backupFolderUrl: backupFolder.getUrl(),
      health: health,
      message:
        'Instance ' + unitName + ' berhasil dipasang tanpa perubahan kode. ' +
        'Jalankan Backup Metadata Sekarang sebelum deployment produksi.'
    };
  } finally {
    lock.releaseLock();
  }
}

function ensureReliabilitySchema_() {
  ensureSystemSheet_(
    APP_CONFIG.SHEETS.SYSTEM_MIGRATIONS,
    RELIABILITY_MIGRATION_HEADERS_,
    [200, 110, 110, 360, 190, 240, 110]
  );
  ensureSystemSheet_(
    APP_CONFIG.SHEETS.SYSTEM_BACKUPS,
    RELIABILITY_BACKUP_HEADERS_,
    [200, 150, 190, 190, 240, 120, 220, 260, 220, 260, 220, 120, 120, 120, 110, 360]
  );
  ensureSystemSheet_(
    APP_CONFIG.SHEETS.SYSTEM_JOBS,
    RELIABILITY_JOB_HEADERS_,
    [200, 140, 200, 120, 190, 190, 190, 240, 140, 110, 420]
  );
  ensureSystemSheet_(
    APP_CONFIG.SHEETS.SYSTEM_JOB_QUEUE,
    RELIABILITY_QUEUE_HEADERS_,
    [200, 200, 220, 360, 220, 110, 260, 260, 110, 190, 190]
  );
  ensureSystemSheet_(
    APP_CONFIG.SHEETS.SYSTEM_HEALTH,
    RELIABILITY_HEALTH_HEADERS_,
    [200, 190, 240, 110, 110, 130, 640]
  );
  ensureSystemSheet_(
    APP_CONFIG.SHEETS.SYSTEM_QUARANTINE,
    RELIABILITY_QUARANTINE_HEADERS_,
    [200, 190, 240, 120, 220, 320, 260, 300, 220, 260, 160, 360, 110, 360]
  );
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
    headerCache_ = {};
  }
  return sheet;
}

function applyReliabilityMigrations_() {
  const migrations = [
    {
      id: 'REL-001',
      version: 1,
      description: 'Membuat registry migrasi, backup, job, health, dan karantina'
    },
    {
      id: 'REL-002',
      version: 1,
      description: 'Memindahkan konfigurasi instance dari source code ke Script Properties'
    },
    {
      id: 'REL-003',
      version: 1,
      description: 'Mengaktifkan backup terjadwal, Audit Log tahunan, dan karantina'
    },
    {
      id: 'REL-004',
      version: 2,
      description: 'Menghubungkan registrasi Penerimaan Arsip dengan pemberkasan item',
      run: function() {
        ensureReceiptFilingSchema_();
        backfillReceiptFilingSchema_();
      }
    },
    {
      id: 'REL-005',
      version: 3,
      description: 'Menambahkan metadata pencipta, keamanan, vital/terjaga, dan media sumber Central File',
      run: function() {
        ensureCentralFileMetadataSchema_();
        backfillCentralFileMetadataSchema_();
      }
    },
    {
      id: 'REL-006',
      version: 4,
      description: 'Meregistrasikan klasifikasi keamanan dan akses sejak penerimaan dan input item',
      run: function() {
        ensureCentralFileMetadataSchema_();
        backfillCentralFileMetadataSchema_();
      }
    },
    {
      id: 'REL-007',
      version: 5,
      description: 'Menambahkan grup peminjaman multi-item, snapshot lokasi, dan log Out Indicator A5',
      run: function() {
        backfillLoanCf03Schema_();
      }
    },
    {
      id: 'REL-008',
      version: 6,
      description: 'Menambahkan kandidat retensi aktif, draft usul pindah, dan snapshot JRA CF-04',
      run: function() {
        ensureRetentionCf04Schema_();
      }
    },
    {
      id: 'REL-009',
      version: 7,
      description: 'Menambahkan snapshot item dan keluaran PDF/XLSX usul pindah serta Riwayat JRA CF-05',
      run: function() {
        ensureRetentionCf04Schema_();
      }
    },
    {
      id: 'REL-010',
      version: 8,
      description: 'Menambahkan Nota Dinas, paket pengajuan, dan outbox federatif Record Center CF-06',
      run: function() {
        ensureTransferSubmissionSchema_();
      }
    },
    {
      id: 'REL-011',
      version: 9,
      description: 'Menambahkan sinkronisasi keputusan Record Center (poll QUERY_DECISION) CF-06.1',
      run: function() {
        ensureTransferDecisionSyncSchema_();
      }
    },
    {
      id: 'REL-012',
      version: 10,
      description: 'Menambahkan data petugas/kondisi fisik peminjaman dan Berita Acara Pinjam/Kembali (Google Docs)',
      run: function() {
        ensureLoanSchema_();
        ensureLoanBeritaAcaraLogSchema_();
        upsertReliabilitySettingsBatch_([
          ['BA_PETUGAS_CF_NAMA', '', 'STRING', 'Default nama petugas Central File pada Berita Acara'],
          ['BA_PETUGAS_CF_NIP', '', 'STRING', 'Default NIP petugas Central File pada Berita Acara'],
          ['BA_PETUGAS_CF_JABATAN', '', 'STRING', 'Default jabatan petugas Central File pada Berita Acara'],
          ['BA_PIMPINAN_NAMA', '', 'STRING', 'Nama pimpinan unit kerja yang menandatangani Berita Acara'],
          ['BA_PIMPINAN_NIP', '', 'STRING', 'NIP pimpinan unit kerja yang menandatangani Berita Acara']
        ]);
      }
    }
  ];
  const applied = readObjects_(APP_CONFIG.SHEETS.SYSTEM_MIGRATIONS);
  migrations.forEach(migration => {
    if (applied.some(row => String(row.MIGRATION_ID) === migration.id &&
        String(row.STATUS) === 'SUCCESS')) return;
    try {
      if (typeof migration.run === 'function') migration.run();
      appendObject_(APP_CONFIG.SHEETS.SYSTEM_MIGRATIONS, {
        MIGRATION_ID: migration.id,
        SCHEMA_VERSION: migration.version,
        RELEASE_VERSION: APP_RELEASE.VERSION,
        DESCRIPTION: migration.description,
        APPLIED_AT: nowIso_(),
        APPLIED_BY: getCurrentUser_(),
        STATUS: 'SUCCESS'
      });
    } catch (error) {
      appendObject_(APP_CONFIG.SHEETS.SYSTEM_MIGRATIONS, {
        MIGRATION_ID: migration.id,
        SCHEMA_VERSION: migration.version,
        RELEASE_VERSION: APP_RELEASE.VERSION,
        DESCRIPTION: migration.description + ' | ' + cleanText_(error.message, 500),
        APPLIED_AT: nowIso_(),
        APPLIED_BY: getCurrentUser_(),
        STATUS: 'FAILED'
      });
      throw error;
    }
  });
}

function validateBaseTemplate_(spreadsheet) {
  const required = [
    APP_CONFIG.SHEETS.BERKAS,
    APP_CONFIG.SHEETS.ITEM,
    APP_CONFIG.SHEETS.KLASIFIKASI,
    APP_CONFIG.SHEETS.PEMINJAMAN,
    APP_CONFIG.SHEETS.AUDIT,
    APP_CONFIG.SHEETS.SETTINGS,
    APP_CONFIG.SHEETS.HISTORY,
    APP_CONFIG.SHEETS.REPORT_BERKAS,
    APP_CONFIG.SHEETS.REPORT_ITEM
  ];
  const existing = spreadsheet.getSheets().map(sheet => sheet.getName());
  const missing = required.filter(name => existing.indexOf(name) === -1);
  if (missing.length) {
    throw new Error(
      'Spreadsheet ini bukan template resmi atau belum lengkap. Sheet yang hilang: ' +
      missing.join(', ') + '.'
    );
  }
}

function readSettingsFromSpreadsheet_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName('SETTINGS');
  if (!sheet || sheet.getLastRow() < 2) return {};
  const headers = sheet.getRange(
    1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  const keyColumn = headers.indexOf('KEY');
  const valueColumn = headers.indexOf('VALUE');
  if (keyColumn === -1 || valueColumn === -1) return {};
  const rows = sheet.getRange(
    2, 1, sheet.getLastRow() - 1, headers.length).getValues();
  const result = {};
  rows.forEach(row => {
    if (row[keyColumn] !== '') result[String(row[keyColumn])] = row[valueColumn];
  });
  return result;
}

function upsertReliabilitySetting_(key, value, type, description) {
  const rows = readObjects_(APP_CONFIG.SHEETS.SETTINGS);
  const existing = rows.find(row => String(row.KEY) === String(key));
  const changes = {
    VALUE: value,
    TYPE: type || 'STRING',
    DESCRIPTION: description || ''
  };
  if (existing) {
    updateObjectAtRow_(
      APP_CONFIG.SHEETS.SETTINGS, existing._rowNumber, changes);
  } else {
    appendObject_(APP_CONFIG.SHEETS.SETTINGS, {
      KEY: key,
      VALUE: value,
      TYPE: type || 'STRING',
      DESCRIPTION: description || ''
    });
  }
}

function upsertReliabilitySettingsBatch_(settings) {
  settings = settings || [];
  if (!settings.length) return;
  const sheet = getSheetOrThrow_(APP_CONFIG.SHEETS.SETTINGS);
  const headers = getHeaders_(sheet);
  const keyColumn = headers.indexOf('KEY');
  const valueColumn = headers.indexOf('VALUE');
  const typeColumn = headers.indexOf('TYPE');
  const descriptionColumn = headers.indexOf('DESCRIPTION');
  if (keyColumn === -1 || valueColumn === -1 ||
      typeColumn === -1 || descriptionColumn === -1) {
    throw new Error(
      'Header SETTINGS harus memuat KEY, VALUE, TYPE, dan DESCRIPTION.');
  }
  const existingRowCount = Math.max(sheet.getLastRow() - 1, 0);
  const rows = existingRowCount
    ? sheet.getRange(2, 1, existingRowCount, headers.length).getValues()
    : [];
  const rowByKey = {};
  rows.forEach(row => {
    if (row[keyColumn] !== '') rowByKey[String(row[keyColumn])] = row;
  });
  settings.forEach(setting => {
    const key = String(setting[0]);
    let row = rowByKey[key];
    if (!row) {
      row = new Array(headers.length).fill('');
      row[keyColumn] = key;
      rows.push(row);
      rowByKey[key] = row;
    }
    row[valueColumn] = setting[1];
    row[typeColumn] = setting[2] || 'STRING';
    row[descriptionColumn] = setting[3] || '';
  });
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }
}

function getOrCreateChildFolder_(parent, name) {
  const matches = parent.getFoldersByName(name);
  return matches.hasNext() ? matches.next() : parent.createFolder(name);
}

function resolveUnitDataFolder_(rootFolder, existingFolderId, defaultName) {
  if (existingFolderId) {
    try {
      const existing = DriveApp.getFolderById(String(existingFolderId));
      if (isFolderWithinRoot_(existing, rootFolder.getId())) return existing;
    } catch (ignore) {}
  }
  return getOrCreateChildFolder_(rootFolder, defaultName);
}

function isFolderWithinRoot_(folder, rootFolderId) {
  if (folder.getId() === rootFolderId) return true;
  let frontier = [folder];
  const visited = {};
  for (let depth = 0; depth < 20 && frontier.length; depth++) {
    const next = [];
    for (let index = 0; index < frontier.length; index++) {
      const current = frontier[index];
      if (visited[current.getId()]) continue;
      visited[current.getId()] = true;
      const parents = current.getParents();
      while (parents.hasNext()) {
        const parent = parents.next();
        if (parent.getId() === rootFolderId) return true;
        next.push(parent);
      }
    }
    frontier = next;
  }
  return false;
}

function normalizeUnitCode_(value, maxLength, label) {
  const result = cleanText_(value, maxLength)
    .toUpperCase()
    .replace(/[^A-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!result) throw new Error(label + ' hanya boleh berisi huruf, angka, - atau _.');
  return result;
}

function normalizeEmail_(value) {
  const email = cleanText_(value, 250).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Format email administrator tidak valid.');
  }
  return email;
}

function reliabilityBoolean_(value) {
  return value === true || String(value || '').toUpperCase() === 'TRUE' ||
    String(value || '') === '1' || String(value || '').toUpperCase() === 'ON';
}

function protectReliabilitySheets_() {
  [
    APP_CONFIG.SHEETS.SYSTEM_MIGRATIONS,
    APP_CONFIG.SHEETS.SYSTEM_BACKUPS,
    APP_CONFIG.SHEETS.SYSTEM_JOBS,
    APP_CONFIG.SHEETS.SYSTEM_JOB_QUEUE,
    APP_CONFIG.SHEETS.SYSTEM_HEALTH,
    APP_CONFIG.SHEETS.SYSTEM_QUARANTINE,
    APP_CONFIG.SHEETS.TRANSFER_OUTBOX,
    APP_CONFIG.SHEETS.AUDIT,
    APP_CONFIG.SHEETS.LOAN_OUT_INDICATOR_LOG
  ].forEach(sheetName => {
    const sheet = getSpreadsheet_().getSheetByName(sheetName);
    if (!sheet) return;
    const description = 'UINSA_ARCHIVE_SYSTEM_' + sheetName;
    const existing = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET)
      .find(protection => protection.getDescription() === description);
    const protection = existing || sheet.protect().setDescription(description);
    protection.setWarningOnly(true);
  });
}

function installReliabilityTriggers_() {
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (RELIABILITY_TRIGGER_HANDLERS_.indexOf(
        trigger.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger('scheduledDailyReliabilityMaintenance')
    .timeBased().atHour(1).everyDays(1).create();
  ScriptApp.newTrigger('scheduledMonthlyFullBackup')
    .timeBased().onMonthDay(1).atHour(2).create();
  ScriptApp.newTrigger('continuePendingReliabilityJobs')
    .timeBased().everyMinutes(10).create();
  return getReliabilityTriggerStatus_();
}

function getReliabilityTriggerStatus_() {
  const handlers = ScriptApp.getProjectTriggers()
    .map(trigger => trigger.getHandlerFunction());
  return RELIABILITY_TRIGGER_HANDLERS_.map(handler => ({
    handler: handler,
    installed: handlers.indexOf(handler) !== -1
  }));
}

function scheduledDailyReliabilityMaintenance() {
  try {
    rolloverAuditLogIfNeeded_();
    const settings = readSettings_();
    if (settings.BACKUP_DAILY_ENABLED !== false &&
        !hasRunningReliabilityBackup_()) {
      startReliabilityBackup_({backupType: 'METADATA_MANIFEST', scheduled: true});
    }
    runReliabilityHealthCheck_(true);
  } catch (error) {
    recordReliabilityJobError_('DAILY_MAINTENANCE', error);
    throw error;
  }
}

function scheduledMonthlyFullBackup() {
  try {
    const settings = readSettings_();
    if (settings.BACKUP_MONTHLY_FULL_ENABLED !== false &&
        !hasRunningReliabilityBackup_()) {
      startReliabilityBackup_({backupType: 'FULL_COPY', scheduled: true});
    }
  } catch (error) {
    recordReliabilityJobError_('MONTHLY_FULL_BACKUP', error);
    throw error;
  }
}

function startReliabilityBackup_(request) {
  request = request || {};
  const type = String(request.backupType || 'METADATA_MANIFEST').toUpperCase();
  if (RELIABILITY_BACKUP_TYPES_.indexOf(type) === -1) {
    throw new Error('Jenis backup tidak valid.');
  }
  const lock = LockService.getScriptLock();
  let backupId = '';
  let jobId = '';
  lock.waitLock(30000);
  try {
    ensureReliabilitySchema_();
    const running = readObjects_(APP_CONFIG.SHEETS.SYSTEM_JOBS)
      .find(row => String(row.JOB_TYPE) === 'BACKUP' &&
        ['RUNNING', 'QUEUED'].indexOf(String(row.STATUS)) !== -1);
    if (running) {
      return {
        ok: true,
        alreadyRunning: true,
        jobId: running.JOB_ID,
        backupId: running.BACKUP_ID,
        message: 'Backup sebelumnya masih berjalan dan akan dilanjutkan otomatis.'
      };
    }

    const settings = readSettings_();
    const backupRoot = DriveApp.getFolderById(
      requireValue_(settings.BACKUP_FOLDER_ID, 'BACKUP_FOLDER_ID'));
    const archiveRoot = DriveApp.getFolderById(
      requireValue_(settings.ARCHIVE_FOLDER_ID, 'ARCHIVE_FOLDER_ID'));
    const timestamp = new Date();
    const timeKey = Utilities.formatDate(
      timestamp, APP_CONFIG.TIME_ZONE, 'yyyyMMdd_HHmmss');
    const unitCode = normalizeUnitCode_(
      settings.UNIT_CODE || settings.UNIT_ID || 'UNIT', 30, 'Kode unit');
    backupId = 'BKP-' + Utilities.getUuid();
    jobId = 'JOB-' + Utilities.getUuid();
    const sessionFolder = backupRoot.createFolder(
      'BACKUP_' + unitCode + '_' + timeKey + '_' + type);
    const spreadsheet = getSpreadsheet_();
    const spreadsheetCopy = DriveApp.getFileById(spreadsheet.getId())
      .makeCopy(
        'SNAPSHOT_' + unitCode + '_' + timeKey + '_' + spreadsheet.getName(),
        sessionFolder
      );
    const fileBackupRoot = type === 'FULL_COPY'
      ? sessionFolder.createFolder('ARSIP_FILES')
      : null;
    const manifest = buildBackupMetadataManifest_(
      backupId, type, spreadsheetCopy, archiveRoot);
    const manifestFile = sessionFolder.createFile(
      Utilities.newBlob(
        JSON.stringify(manifest, null, 2),
        'application/json',
        'BACKUP_METADATA.json'
      )
    );
    const startedAt = nowIso_();
    appendObject_(APP_CONFIG.SHEETS.SYSTEM_BACKUPS, {
      BACKUP_ID: backupId,
      BACKUP_TYPE: type,
      STARTED_AT: startedAt,
      COMPLETED_AT: '',
      CREATED_BY: getCurrentUser_(),
      STATUS: 'RUNNING',
      SPREADSHEET_COPY_ID: spreadsheetCopy.getId(),
      SPREADSHEET_COPY_URL: spreadsheetCopy.getUrl(),
      BACKUP_FOLDER_ID: sessionFolder.getId(),
      BACKUP_FOLDER_URL: sessionFolder.getUrl(),
      MANIFEST_FILE_ID: manifestFile.getId(),
      DRIVE_FILE_COUNT: 0,
      DRIVE_FOLDER_COUNT: 0,
      COPIED_FILE_COUNT: 0,
      ERROR_COUNT: 0,
      NOTES: request.scheduled ? 'Dibuat oleh trigger terjadwal' : 'Dibuat manual'
    });
    appendObject_(APP_CONFIG.SHEETS.SYSTEM_JOBS, {
      JOB_ID: jobId,
      JOB_TYPE: 'BACKUP',
      BACKUP_ID: backupId,
      STATUS: 'RUNNING',
      STARTED_AT: startedAt,
      UPDATED_AT: startedAt,
      COMPLETED_AT: '',
      CREATED_BY: getCurrentUser_(),
      RECORDS_PROCESSED: 0,
      ERROR_COUNT: 0,
      MESSAGE: 'Menyiapkan manifest folder arsip'
    });
    appendObject_(APP_CONFIG.SHEETS.SYSTEM_JOB_QUEUE, {
      QUEUE_ID: 'QUE-' + Utilities.getUuid(),
      JOB_ID: jobId,
      SOURCE_FOLDER_ID: archiveRoot.getId(),
      SOURCE_PATH: '/' + archiveRoot.getName(),
      DESTINATION_FOLDER_ID: fileBackupRoot ? fileBackupRoot.getId() : '',
      STAGE: 'FILES',
      FILE_TOKEN: '',
      FOLDER_TOKEN: '',
      STATUS: 'PENDING',
      CREATED_AT: startedAt,
      UPDATED_AT: startedAt
    });
    audit_(
      'BACKUP_START',
      'RELIABILITY',
      'BACKUP',
      backupId,
      'Memulai backup ' + type,
      'Job ' + jobId,
      'SUCCESS'
    );
  } finally {
    lock.releaseLock();
  }

  const result = continueReliabilityBackupJob_(jobId, 18000);
  return {
    ok: true,
    backupId: backupId,
    jobId: jobId,
    status: result.status,
    message: result.status === 'COMPLETE'
      ? 'Backup selesai dan telah diverifikasi.'
      : 'Snapshot spreadsheet selesai. Manifest file Drive dilanjutkan otomatis di latar belakang.'
  };
}

function buildBackupMetadataManifest_(backupId, type, spreadsheetCopy, archiveRoot) {
  const spreadsheet = getSpreadsheet_();
  const settings = readSettings_();
  return {
    manifestVersion: 1,
    backupId: backupId,
    backupType: type,
    createdAt: nowIso_(),
    createdBy: getCurrentUser_(),
    releaseVersion: APP_RELEASE.VERSION,
    schemaVersion: APP_RELEASE.SCHEMA_VERSION,
    instance: {
      instanceId: settings.INSTANCE_ID || '',
      unitId: settings.UNIT_ID || '',
      unitCode: settings.UNIT_CODE || '',
      unitName: settings.UNIT_NAME || '',
      spreadsheetId: spreadsheet.getId(),
      spreadsheetCopyId: spreadsheetCopy.getId(),
      archiveFolderId: archiveRoot.getId()
    },
    sheets: spreadsheet.getSheets().map(sheet => ({
      name: sheet.getName(),
      sheetId: sheet.getSheetId(),
      lastRow: sheet.getLastRow(),
      lastColumn: sheet.getLastColumn(),
      headerFingerprint: sheet.getLastColumn() > 0
        ? reliabilityFingerprint_(
          sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0])
        : ''
    })),
    driveManifest: {
      status: 'RUNNING',
      format: 'CSV chunks',
      copiesFiles: type === 'FULL_COPY'
    }
  };
}

function reliabilityFingerprint_(value) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    JSON.stringify(value),
    Utilities.Charset.UTF_8
  );
  return bytes.map(byte => {
    const normalized = byte < 0 ? byte + 256 : byte;
    return ('0' + normalized.toString(16)).slice(-2);
  }).join('');
}

function continuePendingReliabilityJobs() {
  const jobs = readObjects_(APP_CONFIG.SHEETS.SYSTEM_JOBS)
    .filter(row => String(row.JOB_TYPE) === 'BACKUP' &&
      ['RUNNING', 'QUEUED'].indexOf(String(row.STATUS)) !== -1)
    .sort((a, b) => String(a.STARTED_AT).localeCompare(String(b.STARTED_AT)));
  if (!jobs.length) return {ok: true, message: 'Tidak ada job tertunda.'};
  return continueReliabilityBackupJob_(jobs[0].JOB_ID);
}

function continueReliabilityBackupJob_(jobId, maxMs) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    return {ok: true, status: 'RUNNING', message: 'Job sedang diproses eksekusi lain.'};
  }
  const started = Date.now();
  const deadline = started + Math.min(
    Number(maxMs || RELIABILITY_JOB_MAX_MS_), RELIABILITY_JOB_MAX_MS_);
  let job;
  try {
    job = readObjects_(APP_CONFIG.SHEETS.SYSTEM_JOBS)
      .find(row => String(row.JOB_ID) === String(jobId));
    if (!job) throw new Error('Job backup tidak ditemukan: ' + jobId);
    if (String(job.STATUS) === 'COMPLETE') {
      return {ok: true, status: 'COMPLETE', jobId: jobId};
    }
    const backup = readObjects_(APP_CONFIG.SHEETS.SYSTEM_BACKUPS)
      .find(row => String(row.BACKUP_ID) === String(job.BACKUP_ID));
    if (!backup) throw new Error('Registry backup tidak ditemukan: ' + job.BACKUP_ID);
    const isFull = String(backup.BACKUP_TYPE) === 'FULL_COPY';
    let processedFiles = 0;
    let processedFolders = 0;
    let copiedFiles = Number(backup.COPIED_FILE_COUNT || 0);
    let errorCount = Number(backup.ERROR_COUNT || 0);

    while (Date.now() < deadline &&
        processedFiles < RELIABILITY_JOB_MAX_FILES_PER_RUN_ &&
        processedFolders < RELIABILITY_JOB_MAX_FOLDERS_PER_RUN_) {
      const queue = nextReliabilityQueueRow_(jobId);
      if (!queue) {
        finalizeReliabilityBackup_(job, backup, {
          fileCount: Number(backup.DRIVE_FILE_COUNT || 0) + processedFiles,
          folderCount: Number(backup.DRIVE_FOLDER_COUNT || 0) + processedFolders,
          copiedFileCount: copiedFiles,
          errorCount: errorCount
        });
        return {ok: true, status: 'COMPLETE', jobId: jobId};
      }
      const sourceFolder = DriveApp.getFolderById(queue.SOURCE_FOLDER_ID);
      let stage = String(queue.STAGE || 'FILES');
      if (stage === 'FILES') {
        const fileResult = processReliabilityQueueFiles_(
          queue, sourceFolder, backup, isFull,
          Math.min(
            RELIABILITY_JOB_MAX_FILES_PER_RUN_ - processedFiles,
            120
          ),
          deadline
        );
        processedFiles += fileResult.fileCount;
        copiedFiles += fileResult.copiedCount;
        errorCount += fileResult.errorCount;
        if (!fileResult.complete) break;
        stage = 'FOLDERS';
      }
      if (stage === 'FOLDERS' && Date.now() < deadline) {
        const folderResult = processReliabilityQueueFolders_(
          queue, sourceFolder, backup, isFull,
          Math.min(
            RELIABILITY_JOB_MAX_FOLDERS_PER_RUN_ - processedFolders,
            100
          ),
          deadline
        );
        processedFolders += folderResult.folderCount;
        errorCount += folderResult.errorCount;
        if (!folderResult.complete) break;
      }
    }

    const fileTotal = Number(backup.DRIVE_FILE_COUNT || 0) + processedFiles;
    const folderTotal = Number(backup.DRIVE_FOLDER_COUNT || 0) + processedFolders;
    updateObjectAtRow_(APP_CONFIG.SHEETS.SYSTEM_BACKUPS, backup._rowNumber, {
      DRIVE_FILE_COUNT: fileTotal,
      DRIVE_FOLDER_COUNT: folderTotal,
      COPIED_FILE_COUNT: copiedFiles,
      ERROR_COUNT: errorCount,
      STATUS: 'RUNNING',
      NOTES: 'Manifest berlanjut otomatis; terakhir ' + nowIso_()
    });
    updateObjectAtRow_(APP_CONFIG.SHEETS.SYSTEM_JOBS, job._rowNumber, {
      STATUS: 'RUNNING',
      UPDATED_AT: nowIso_(),
      RECORDS_PROCESSED: Number(job.RECORDS_PROCESSED || 0) +
        processedFiles + processedFolders,
      ERROR_COUNT: errorCount,
      MESSAGE: 'Manifest: ' + fileTotal + ' file, ' + folderTotal + ' folder'
    });
    return {
      ok: true,
      status: 'RUNNING',
      jobId: jobId,
      fileCount: fileTotal,
      folderCount: folderTotal,
      copiedFileCount: copiedFiles,
      errorCount: errorCount
    };
  } catch (error) {
    if (job) {
      updateObjectAtRow_(APP_CONFIG.SHEETS.SYSTEM_JOBS, job._rowNumber, {
        STATUS: 'FAILED',
        UPDATED_AT: nowIso_(),
        COMPLETED_AT: nowIso_(),
        MESSAGE: cleanText_(error.message, 1000)
      });
      const backup = readObjects_(APP_CONFIG.SHEETS.SYSTEM_BACKUPS)
        .find(row => String(row.BACKUP_ID) === String(job.BACKUP_ID));
      if (backup) updateObjectAtRow_(
        APP_CONFIG.SHEETS.SYSTEM_BACKUPS, backup._rowNumber, {
          STATUS: 'FAILED',
          COMPLETED_AT: nowIso_(),
          NOTES: cleanText_(error.message, 1000)
        });
    }
    recordReliabilityJobError_('BACKUP_JOB', error);
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function nextReliabilityQueueRow_(jobId) {
  return readObjects_(APP_CONFIG.SHEETS.SYSTEM_JOB_QUEUE)
    .filter(row => String(row.JOB_ID) === String(jobId) &&
      ['PENDING', 'PROCESSING'].indexOf(String(row.STATUS)) !== -1)
    .sort((a, b) => Number(a._rowNumber) - Number(b._rowNumber))[0] || null;
}

function processReliabilityQueueFiles_(
  queue, sourceFolder, backup, isFull, limit, deadline) {
  let iterator = queue.FILE_TOKEN
    ? DriveApp.continueFileIterator(String(queue.FILE_TOKEN))
    : sourceFolder.getFiles();
  const destination = isFull && queue.DESTINATION_FOLDER_ID
    ? DriveApp.getFolderById(queue.DESTINATION_FOLDER_ID)
    : null;
  const rows = [];
  let fileCount = 0;
  let copiedCount = 0;
  let errorCount = 0;
  while (iterator.hasNext() && fileCount < Math.max(1, limit) &&
      Date.now() < deadline - 3000) {
    const file = iterator.next();
    let copyId = '';
    let copyUrl = '';
    let copyStatus = isFull ? 'FAILED' : 'NOT_REQUESTED';
    let notes = '';
    if (isFull) {
      try {
        if (!destination) throw new Error('Folder tujuan backup tidak tersedia.');
        const copyName = 'SRC_' + file.getId() + '__' +
          cleanFileName_(file.getName());
        const existingCopies = destination.getFilesByName(copyName);
        const reused = existingCopies.hasNext();
        const copy = reused
          ? existingCopies.next()
          : file.makeCopy(copyName, destination);
        copyId = copy.getId();
        copyUrl = copy.getUrl();
        copyStatus = reused ? 'REUSED' : 'COPIED';
        copiedCount++;
      } catch (error) {
        errorCount++;
        notes = cleanText_(error.message, 500);
      }
    }
    rows.push([
      file.getId(),
      file.getName(),
      file.getMimeType(),
      file.getSize(),
      file.getLastUpdated().toISOString(),
      queue.SOURCE_PATH,
      file.getUrl(),
      copyId,
      copyUrl,
      copyStatus,
      '',
      notes
    ]);
    fileCount++;
  }
  if (rows.length) writeReliabilityManifestChunk_(backup, rows);
  const hasMore = iterator.hasNext();
  updateObjectAtRow_(APP_CONFIG.SHEETS.SYSTEM_JOB_QUEUE, queue._rowNumber, {
    STATUS: 'PROCESSING',
    STAGE: hasMore ? 'FILES' : 'FOLDERS',
    FILE_TOKEN: hasMore ? iterator.getContinuationToken() : '',
    UPDATED_AT: nowIso_()
  });
  return {
    complete: !hasMore,
    fileCount: fileCount,
    copiedCount: copiedCount,
    errorCount: errorCount
  };
}

function processReliabilityQueueFolders_(
  queue, sourceFolder, backup, isFull, limit, deadline) {
  let iterator = queue.FOLDER_TOKEN
    ? DriveApp.continueFolderIterator(String(queue.FOLDER_TOKEN))
    : sourceFolder.getFolders();
  const destination = isFull && queue.DESTINATION_FOLDER_ID
    ? DriveApp.getFolderById(queue.DESTINATION_FOLDER_ID)
    : null;
  const newQueueRows = [];
  let folderCount = 0;
  let errorCount = 0;
  while (iterator.hasNext() && folderCount < Math.max(1, limit) &&
      Date.now() < deadline - 3000) {
    const child = iterator.next();
    let childDestinationId = '';
    if (destination) {
      try {
        const destinationName = 'SRC_' + child.getId() + '__' +
          cleanFileName_(child.getName());
        childDestinationId = getOrCreateChildFolder_(
          destination, destinationName).getId();
      } catch (error) {
        errorCount++;
      }
    } else if (isFull) {
      errorCount++;
    }
    newQueueRows.push({
      QUEUE_ID: 'QUE-' + Utilities.getUuid(),
      JOB_ID: queue.JOB_ID,
      SOURCE_FOLDER_ID: child.getId(),
      SOURCE_PATH: String(queue.SOURCE_PATH || '') + '/' + child.getName(),
      DESTINATION_FOLDER_ID: childDestinationId,
      STAGE: 'FILES',
      FILE_TOKEN: '',
      FOLDER_TOKEN: '',
      STATUS: 'PENDING',
      CREATED_AT: nowIso_(),
      UPDATED_AT: nowIso_()
    });
    folderCount++;
  }
  if (newQueueRows.length) {
    appendObjects_(APP_CONFIG.SHEETS.SYSTEM_JOB_QUEUE, newQueueRows);
  }
  const hasMore = iterator.hasNext();
  updateObjectAtRow_(APP_CONFIG.SHEETS.SYSTEM_JOB_QUEUE, queue._rowNumber, {
    STATUS: hasMore ? 'PROCESSING' : 'DONE',
    STAGE: 'FOLDERS',
    FOLDER_TOKEN: hasMore ? iterator.getContinuationToken() : '',
    UPDATED_AT: nowIso_()
  });
  return {
    complete: !hasMore,
    folderCount: folderCount,
    errorCount: errorCount
  };
}

function writeReliabilityManifestChunk_(backup, rows) {
  const folder = DriveApp.getFolderById(backup.BACKUP_FOLDER_ID);
  const sequence = Number(backup.DRIVE_FILE_COUNT || 0) +
    Number(rows.length || 0) + Date.now();
  const name = 'DRIVE_MANIFEST_' + String(sequence) + '.csv';
  const header = [
    'SOURCE_FILE_ID', 'NAME', 'MIME_TYPE', 'SIZE_BYTES', 'LAST_UPDATED',
    'SOURCE_PATH', 'SOURCE_URL', 'COPY_FILE_ID', 'COPY_URL', 'COPY_STATUS',
    'CHECKSUM_IF_AVAILABLE', 'NOTES'
  ];
  const csv = [header].concat(rows)
    .map(row => row.map(reliabilityCsvCell_).join(',')).join('\r\n');
  folder.createFile(Utilities.newBlob(csv, 'text/csv', name));
}

function reliabilityCsvCell_(value) {
  const text = String(value === undefined || value === null ? '' : value);
  return '"' + text.replace(/"/g, '""') + '"';
}

function finalizeReliabilityBackup_(job, backup, counts) {
  const status = counts.errorCount ? 'WARNING' : 'COMPLETE';
  const folder = DriveApp.getFolderById(backup.BACKUP_FOLDER_ID);
  folder.createFile(Utilities.newBlob(
    JSON.stringify({
      backupId: backup.BACKUP_ID,
      status: status,
      completedAt: nowIso_(),
      driveFileCount: counts.fileCount,
      driveFolderCount: counts.folderCount,
      copiedFileCount: counts.copiedFileCount,
      errorCount: counts.errorCount,
      releaseVersion: APP_RELEASE.VERSION,
      schemaVersion: APP_RELEASE.SCHEMA_VERSION
    }, null, 2),
    'application/json',
    'BACKUP_COMPLETE.json'
  ));
  updateObjectAtRow_(APP_CONFIG.SHEETS.SYSTEM_BACKUPS, backup._rowNumber, {
    COMPLETED_AT: nowIso_(),
    STATUS: status,
    DRIVE_FILE_COUNT: counts.fileCount,
    DRIVE_FOLDER_COUNT: counts.folderCount,
    COPIED_FILE_COUNT: counts.copiedFileCount,
    ERROR_COUNT: counts.errorCount,
    NOTES: counts.errorCount
      ? 'Backup selesai dengan ' + counts.errorCount + ' peringatan.'
      : 'Backup selesai dan memiliki completion marker.'
  });
  updateObjectAtRow_(APP_CONFIG.SHEETS.SYSTEM_JOBS, job._rowNumber, {
    STATUS: 'COMPLETE',
    UPDATED_AT: nowIso_(),
    COMPLETED_AT: nowIso_(),
    ERROR_COUNT: counts.errorCount,
    MESSAGE: 'Selesai: ' + counts.fileCount + ' file, ' +
      counts.folderCount + ' folder'
  });
  deleteReliabilityQueueRows_(job.JOB_ID);
  audit_(
    'BACKUP_COMPLETE',
    'RELIABILITY',
    'BACKUP',
    backup.BACKUP_ID,
    'Backup selesai: ' + counts.fileCount + ' file, ' +
      counts.folderCount + ' folder',
    counts.copiedFileCount + ' file disalin; ' +
      counts.errorCount + ' peringatan',
    status === 'COMPLETE' ? 'SUCCESS' : 'WARNING'
  );
}

function deleteReliabilityQueueRows_(jobId) {
  const sheet = getSheetOrThrow_(APP_CONFIG.SHEETS.SYSTEM_JOB_QUEUE);
  const rows = readObjects_(APP_CONFIG.SHEETS.SYSTEM_JOB_QUEUE)
    .filter(row => String(row.JOB_ID) === String(jobId))
    .map(row => row._rowNumber)
    .sort((a, b) => b - a);
  rows.forEach(rowNumber => sheet.deleteRow(rowNumber));
}

function hasRunningReliabilityBackup_() {
  if (!getSpreadsheet_().getSheetByName(APP_CONFIG.SHEETS.SYSTEM_JOBS)) return false;
  return readObjects_(APP_CONFIG.SHEETS.SYSTEM_JOBS)
    .some(row => String(row.JOB_TYPE) === 'BACKUP' &&
      ['RUNNING', 'QUEUED'].indexOf(String(row.STATUS)) !== -1);
}

function verifyReliabilityBackup_(backupId) {
  const rows = readObjects_(APP_CONFIG.SHEETS.SYSTEM_BACKUPS)
    .filter(row => row.BACKUP_ID);
  const backup = backupId
    ? rows.find(row => String(row.BACKUP_ID) === String(backupId))
    : rows.sort((a, b) => String(b.STARTED_AT).localeCompare(
      String(a.STARTED_AT)))[0];
  if (!backup) throw new Error('Belum ada backup yang dapat diverifikasi.');
  const checks = [];
  try {
    const copy = DriveApp.getFileById(backup.SPREADSHEET_COPY_ID);
    checks.push({
      name: 'Spreadsheet snapshot',
      ok: !copy.isTrashed(),
      detail: copy.getName()
    });
  } catch (error) {
    checks.push({name: 'Spreadsheet snapshot', ok: false, detail: error.message});
  }
  try {
    const folder = DriveApp.getFolderById(backup.BACKUP_FOLDER_ID);
    const marker = folder.getFilesByName('BACKUP_COMPLETE.json');
    checks.push({
      name: 'Completion marker',
      ok: marker.hasNext(),
      detail: folder.getUrl()
    });
  } catch (error) {
    checks.push({name: 'Completion marker', ok: false, detail: error.message});
  }
  const ok = checks.every(check => check.ok) &&
    ['COMPLETE', 'WARNING'].indexOf(String(backup.STATUS)) !== -1;
  return {
    ok: ok,
    backupId: backup.BACKUP_ID,
    status: backup.STATUS,
    type: backup.BACKUP_TYPE,
    completedAt: backup.COMPLETED_AT,
    folderUrl: backup.BACKUP_FOLDER_URL,
    checks: checks,
    message: ok
      ? 'Backup dapat dibuka dan memiliki completion marker.'
      : 'Backup belum lengkap atau tidak dapat diakses.'
  };
}

function runReliabilityHealthCheck_(persist) {
  ensureReliabilitySchema_();
  const checks = [];
  const spreadsheet = getSpreadsheet_();
  const settings = readSettings_();
  const configuredId = getInstanceSpreadsheetId_(true);
  addReliabilityCheck_(
    checks,
    'INSTANCE_BINDING',
    configuredId === spreadsheet.getId() ? 'OK' : 'ERROR',
    configuredId === spreadsheet.getId()
      ? 'Spreadsheet terikat ke instance ini.'
      : 'ID spreadsheet tidak cocok dengan konfigurasi instance.'
  );
  addReliabilityCheck_(
    checks,
    'SCHEMA_VERSION',
    Number(settings.SCHEMA_VERSION || 0) === APP_RELEASE.SCHEMA_VERSION
      ? 'OK' : 'ERROR',
    'Schema ' + String(settings.SCHEMA_VERSION || 'belum ada') +
      '; paket membutuhkan ' + APP_RELEASE.SCHEMA_VERSION + '.'
  );

  const requiredSheets = Object.keys(APP_CONFIG.SHEETS)
    .map(key => APP_CONFIG.SHEETS[key]);
  const sheetNames = spreadsheet.getSheets().map(sheet => sheet.getName());
  const missingSheets = requiredSheets.filter(name =>
    sheetNames.indexOf(name) === -1);
  addReliabilityCheck_(
    checks,
    'REQUIRED_SHEETS',
    missingSheets.length ? 'ERROR' : 'OK',
    missingSheets.length
      ? 'Sheet hilang: ' + missingSheets.join(', ')
      : 'Seluruh sheet wajib tersedia.'
  );
  const integrationMissing = [];
  if (sheetNames.indexOf(RECEIPT_ITEM_SHEET_) !== -1) {
    const receiptItemHeaders = getHeaders_(
      spreadsheet.getSheetByName(RECEIPT_ITEM_SHEET_));
    RECEIPT_ITEM_HEADERS_.forEach(header => {
      if (receiptItemHeaders.indexOf(header) === -1) {
        integrationMissing.push(RECEIPT_ITEM_SHEET_ + '.' + header);
      }
    });
  }
  if (sheetNames.indexOf(APP_CONFIG.SHEETS.ITEM) !== -1) {
    const dbItemHeaders = getHeaders_(
      spreadsheet.getSheetByName(APP_CONFIG.SHEETS.ITEM));
    RECEIPT_FILING_DB_ITEM_HEADERS_.forEach(header => {
      if (dbItemHeaders.indexOf(header) === -1) {
        integrationMissing.push(APP_CONFIG.SHEETS.ITEM + '.' + header);
      }
    });
  }
  addReliabilityCheck_(
    checks,
    'RECEIPT_FILING_SCHEMA',
    integrationMissing.length ? 'ERROR' : 'OK',
    integrationMissing.length
      ? 'Kolom integrasi hilang: ' + integrationMissing.slice(0, 8).join(', ') +
        (integrationMissing.length > 8 ? ', …' : '')
      : 'Schema Penerimaan–Pemberkasan lengkap.'
  );

  const centralFileMetadataHealth = getCentralFileMetadataHealth_();
  addReliabilityCheck_(
    checks,
    'CENTRAL_FILE_METADATA_SCHEMA',
    centralFileMetadataHealth.ok
      ? (centralFileMetadataHealth.needsVerification ? 'WARNING' : 'OK')
      : 'ERROR',
    centralFileMetadataHealth.ok
      ? (centralFileMetadataHealth.needsVerification
        ? centralFileMetadataHealth.needsVerification +
          ' rekod lama perlu verifikasi metadata pada CF-02.'
        : 'Schema dan metadata Central File lengkap.')
      : 'Kolom metadata hilang: ' +
        centralFileMetadataHealth.missing.slice(0, 8).join(', ') +
        (centralFileMetadataHealth.missing.length > 8 ? ', …' : '')
  );

  const loanHeaders = sheetNames.indexOf(APP_CONFIG.SHEETS.PEMINJAMAN) === -1
    ? [] : getHeaders_(spreadsheet.getSheetByName(APP_CONFIG.SHEETS.PEMINJAMAN));
  const missingLoanHeaders = LOAN_REQUIRED_HEADERS_
    .filter(header => loanHeaders.indexOf(header) === -1);
  addReliabilityCheck_(
    checks,
    'ACTIVE_LOAN_CF03_SCHEMA',
    missingLoanHeaders.length ? 'ERROR' : 'OK',
    missingLoanHeaders.length
      ? 'Kolom CF-03 hilang: ' + missingLoanHeaders.join(', ')
      : 'Schema grup peminjaman, snapshot lokasi, dan Out Indicator lengkap.'
  );

  const retentionCf04Health = getRetentionCf04Health_();
  addReliabilityCheck_(
    checks,
    'ACTIVE_RETENTION_CF05_SCHEMA',
    retentionCf04Health.ok ? 'OK' : 'ERROR',
    retentionCf04Health.ok
      ? 'Schema kandidat, snapshot berkas/item, dokumen usul, Riwayat JRA, dan guardrail fase aktif lengkap.'
      : 'Kolom CF-05 hilang: ' + retentionCf04Health.missing.slice(0, 8).join(', ') +
        (retentionCf04Health.missing.length > 8 ? ', …' : '')
  );

  const transferSubmissionHealth = getTransferSubmissionHealth_();
  addReliabilityCheck_(
    checks,
    'TRANSFER_SUBMISSION_CF06_SCHEMA',
    transferSubmissionHealth.ok ? 'OK' : 'ERROR',
    transferSubmissionHealth.ok
      ? 'Schema Nota Dinas, paket pengajuan, integritas payload, dan outbox Record Center lengkap.'
      : 'Kolom CF-06 hilang: ' +
        transferSubmissionHealth.missing.slice(0, 8).join(', ') +
        (transferSubmissionHealth.missing.length > 8 ? ', …' : '')
  );

  const recordCenterReady = Boolean(settings.RECORD_CENTER_INSTANCE_ID &&
    settings.RECORD_CENTER_ENDPOINT_URL &&
    (PropertiesService.getScriptProperties()
      .getProperty('RECORD_CENTER_SHARED_SECRET') ||
      settings.RECORD_CENTER_SHARED_SECRET));
  addReliabilityCheck_(
    checks,
    'RECORD_CENTER_CONNECTION',
    recordCenterReady ? 'OK' : 'WARNING',
    recordCenterReady
      ? 'Endpoint federatif Record Center telah dikonfigurasi.'
      : 'Paket CF-06 tetap tersimpan di outbox; koneksi diaktifkan setelah aplikasi Record Center dipasang.'
  );

  if (typeof getTransferDecisionSyncHealth_ === 'function') {
    const decisionSyncHealth = getTransferDecisionSyncHealth_();
    addReliabilityCheck_(
      checks,
      'TRANSFER_DECISION_SYNC_CF061_SCHEMA',
      decisionSyncHealth.ok ? 'OK' : 'ERROR',
      decisionSyncHealth.ok
        ? 'Schema sinkronisasi keputusan Record Center (CF-06.1) lengkap.'
        : 'Kolom CF-06.1 hilang: ' + decisionSyncHealth.missing.slice(0, 8).join(', ') +
          (decisionSyncHealth.missing.length > 8 ? ', …' : '')
    );
    const pollTriggerInstalled = ScriptApp.getProjectTriggers()
      .some(trigger => trigger.getHandlerFunction() === 'scheduledTransferDecisionPoll');
    const pendingDecisionCount = typeof listDiajukanSentProposalsForPoll_ === 'function'
      ? listDiajukanSentProposalsForPoll_().length : 0;
    addReliabilityCheck_(
      checks,
      'RECORD_CENTER_DECISION_POLL_TRIGGER',
      pollTriggerInstalled ? 'OK' : 'WARNING',
      (pollTriggerInstalled
        ? 'Trigger polling keputusan RC aktif.'
        : 'Trigger belum aktif — jalankan menu "Aktifkan Polling Otomatis Keputusan RC".') +
        ' ' + pendingDecisionCount + ' usul menunggu keputusan disinkronkan.'
    );
  }

  if (typeof getBeritaAcaraTemplateDocId_ === 'function') {
    const officerConfigured = Boolean(cleanText_(settings.BA_PETUGAS_CF_NAMA, 250));
    const pimpinanConfigured = Boolean(cleanText_(settings.BA_PIMPINAN_NAMA, 250));
    addReliabilityCheck_(
      checks,
      'BERITA_ACARA_PEMINJAMAN_DEFAULTS',
      officerConfigured && pimpinanConfigured ? 'OK' : 'WARNING',
      officerConfigured && pimpinanConfigured
        ? 'Default petugas Central File dan pimpinan unit kerja sudah diatur untuk Berita Acara.'
        : 'Default petugas Central File dan/atau pimpinan belum diatur — jalankan menu ' +
          '"Atur Data Petugas & Pimpinan (Berita Acara)…" agar tidak perlu diketik manual setiap transaksi.'
    );
  }

  [
    ['ARCHIVE_FOLDER_ID', 'Folder arsip'],
    ['QUARANTINE_FOLDER_ID', 'Folder karantina'],
    ['BACKUP_FOLDER_ID', 'Folder backup']
  ].forEach(entry => {
    let status = 'OK';
    let detail = entry[1] + ' dapat diakses.';
    try {
      DriveApp.getFolderById(requireValue_(settings[entry[0]], entry[0]));
    } catch (error) {
      status = 'ERROR';
      detail = entry[1] + ' tidak dapat diakses: ' + error.message;
    }
    addReliabilityCheck_(checks, entry[0], status, detail);
  });

  const triggerStatus = getReliabilityTriggerStatus_();
  const missingTriggers = triggerStatus.filter(item => !item.installed)
    .map(item => item.handler);
  addReliabilityCheck_(
    checks,
    'TRIGGERS',
    missingTriggers.length ? 'WARNING' : 'OK',
    missingTriggers.length
      ? 'Trigger belum tersedia: ' + missingTriggers.join(', ')
      : 'Backup, maintenance, dan continuation trigger aktif.'
  );

  const backups = readObjects_(APP_CONFIG.SHEETS.SYSTEM_BACKUPS)
    .filter(row => ['COMPLETE', 'WARNING'].indexOf(String(row.STATUS)) !== -1)
    .sort((a, b) => String(b.COMPLETED_AT).localeCompare(String(a.COMPLETED_AT)));
  if (!backups.length) {
    addReliabilityCheck_(
      checks, 'LATEST_BACKUP', 'WARNING',
      'Belum ada backup lengkap. Jalankan Backup Metadata Sekarang.');
  } else {
    const backupAgeHours = Math.max(
      0, (Date.now() - new Date(backups[0].COMPLETED_AT).getTime()) / 3600000);
    const warningHours = Number(settings.BACKUP_WARNING_HOURS || 36);
    addReliabilityCheck_(
      checks,
      'LATEST_BACKUP',
      backupAgeHours > warningHours ? 'WARNING' : 'OK',
      'Backup terakhir ' + Math.round(backupAgeHours * 10) / 10 +
        ' jam lalu (' + backups[0].BACKUP_TYPE + ').'
    );
  }

  const failedJobs = readObjects_(APP_CONFIG.SHEETS.SYSTEM_JOBS)
    .filter(row => String(row.STATUS) === 'FAILED').length;
  addReliabilityCheck_(
    checks,
    'FAILED_JOBS',
    failedJobs ? 'WARNING' : 'OK',
    failedJobs ? failedJobs + ' job gagal perlu ditinjau.' : 'Tidak ada job gagal.'
  );

  const usage = spreadsheet.getSheets().reduce((summary, sheet) => {
    const usedCells = Math.max(0, sheet.getLastRow()) *
      Math.max(0, sheet.getLastColumn());
    summary.usedCells += usedCells;
    if (sheet.getLastRow() >= 100000) {
      summary.largeSheets.push(sheet.getName() + ' (' + sheet.getLastRow() + ' baris)');
    }
    return summary;
  }, {usedCells: 0, largeSheets: []});
  const usageStatus = usage.usedCells >= 5000000 || usage.largeSheets.length
    ? 'WARNING' : 'OK';
  addReliabilityCheck_(
    checks,
    'DATA_GROWTH',
    usageStatus,
    'Perkiraan sel terpakai ' + usage.usedCells +
      (usage.largeSheets.length
        ? '; tabel besar: ' + usage.largeSheets.join(', ')
        : '; belum melewati ambang review internal.')
  );

  const status = checks.some(check => check.status === 'ERROR')
    ? 'ERROR'
    : (checks.some(check => check.status === 'WARNING') ? 'WARNING' : 'OK');
  const result = {
    ok: status !== 'ERROR',
    overallStatus: status,
    releaseVersion: APP_RELEASE.VERSION,
    schemaVersion: APP_RELEASE.SCHEMA_VERSION,
    checkedAt: nowIso_(),
    instance: getInstancePresentation_(),
    checks: checks
  };
  if (persist !== false) {
    appendObject_(APP_CONFIG.SHEETS.SYSTEM_HEALTH, {
      HEALTH_ID: 'HLT-' + Utilities.getUuid(),
      CHECKED_AT: result.checkedAt,
      CHECKED_BY: getCurrentUser_(),
      RELEASE_VERSION: APP_RELEASE.VERSION,
      SCHEMA_VERSION: APP_RELEASE.SCHEMA_VERSION,
      OVERALL_STATUS: status,
      CHECKS_JSON: JSON.stringify(checks)
    });
  }
  return result;
}

function addReliabilityCheck_(checks, code, status, detail) {
  checks.push({code: code, status: status, detail: detail});
}

function getInstancePresentation_() {
  const settings = readSettings_();
  return {
    instanceId: cleanText_(settings.INSTANCE_ID, 100),
    unitId: cleanText_(settings.UNIT_ID, 50),
    unitCode: cleanText_(settings.UNIT_CODE, 30),
    unitName: cleanText_(settings.UNIT_NAME, 250),
    administratorName: cleanText_(settings.UNIT_ADMIN_NAME, 250),
    administratorEmail: cleanText_(settings.UNIT_ADMIN_EMAIL, 250),
    releaseVersion: APP_RELEASE.VERSION,
    schemaVersion: APP_RELEASE.SCHEMA_VERSION
  };
}

function getReliabilityDashboard_() {
  const setup = getUnitSetup_();
  if (!setup.installed) return {setup: setup, installed: false};
  const backups = readObjects_(APP_CONFIG.SHEETS.SYSTEM_BACKUPS)
    .filter(row => row.BACKUP_ID)
    .sort((a, b) => String(b.STARTED_AT).localeCompare(String(a.STARTED_AT)))
    .slice(0, 20)
    .map(row => ({
      id: row.BACKUP_ID,
      type: row.BACKUP_TYPE,
      status: row.STATUS,
      startedAt: row.STARTED_AT,
      completedAt: row.COMPLETED_AT,
      folderUrl: row.BACKUP_FOLDER_URL,
      fileCount: Number(row.DRIVE_FILE_COUNT || 0),
      copiedFileCount: Number(row.COPIED_FILE_COUNT || 0),
      errorCount: Number(row.ERROR_COUNT || 0)
    }));
  return {
    installed: true,
    setup: setup,
    instance: getInstancePresentation_(),
    health: runReliabilityHealthCheck_(false),
    backups: backups,
    triggers: getReliabilityTriggerStatus_(),
    runningBackup: hasRunningReliabilityBackup_()
  };
}

function createDistributionTemplate_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const settings = readSettings_();
    const backupRoot = DriveApp.getFolderById(
      requireValue_(settings.BACKUP_FOLDER_ID, 'BACKUP_FOLDER_ID'));
    const distributionFolder = getOrCreateChildFolder_(
      backupRoot, 'TEMPLATE DISTRIBUSI');
    const source = getSpreadsheet_();
    const timeKey = Utilities.formatDate(
      new Date(), APP_CONFIG.TIME_ZONE, 'yyyyMMdd_HHmmss');
    const file = DriveApp.getFileById(source.getId()).makeCopy(
      'TEMPLATE_UINSA_ARSIP_AKTIF_v' + APP_RELEASE.VERSION + '_' + timeKey,
      distributionFolder
    );
    const template = SpreadsheetApp.openById(file.getId());
    const rowTwoSheets = [
      APP_CONFIG.SHEETS.BERKAS,
      APP_CONFIG.SHEETS.ITEM,
      APP_CONFIG.SHEETS.PEMINJAMAN,
      APP_CONFIG.SHEETS.AUDIT,
      APP_CONFIG.SHEETS.HISTORY,
      APP_CONFIG.SHEETS.RECEIPT,
      APP_CONFIG.SHEETS.RECEIPT_ITEM,
      APP_CONFIG.SHEETS.EMPLOYEE,
      APP_CONFIG.SHEETS.RECEIPT_PRINT_LOG,
      APP_CONFIG.SHEETS.LOAN_OUT_INDICATOR_LOG,
      APP_CONFIG.SHEETS.TRANSFER_PROPOSAL,
      APP_CONFIG.SHEETS.TRANSFER_PROPOSAL_DETAIL,
      APP_CONFIG.SHEETS.TRANSFER_PROPOSAL_ITEM,
      APP_CONFIG.SHEETS.TRANSFER_OUTBOX,
      APP_CONFIG.SHEETS.SYSTEM_MIGRATIONS,
      APP_CONFIG.SHEETS.SYSTEM_BACKUPS,
      APP_CONFIG.SHEETS.SYSTEM_JOBS,
      APP_CONFIG.SHEETS.SYSTEM_JOB_QUEUE,
      APP_CONFIG.SHEETS.SYSTEM_HEALTH,
      APP_CONFIG.SHEETS.SYSTEM_QUARANTINE,
      'LOG_CETAK_LIDAH'
    ];
    rowTwoSheets.forEach(name => clearTemplateDataRows_(template, name, 2));
    clearTemplateDataRows_(template, APP_CONFIG.SHEETS.REPORT_BERKAS, 13);
    clearTemplateDataRows_(template, APP_CONFIG.SHEETS.REPORT_ITEM, 13);
    sanitizeTemplateSettings_(template);
    SpreadsheetApp.flush();
    audit_(
      'CREATE_TEMPLATE',
      'RELIABILITY',
      'DISTRIBUTION_TEMPLATE',
      file.getId(),
      'Membuat template distribusi bersih rilis ' + APP_RELEASE.VERSION,
      'Data operasional, identitas unit, folder ID, backup, dan log dibersihkan pada salinan',
      'SUCCESS'
    );
    return {
      ok: true,
      fileId: file.getId(),
      fileUrl: file.getUrl(),
      fileName: file.getName(),
      message:
        'Template distribusi bersih berhasil dibuat. Bagikan salinan template ini, ' +
        'bukan spreadsheet produksi.'
    };
  } finally {
    lock.releaseLock();
  }
}

function clearTemplateDataRows_(spreadsheet, sheetName, startRow) {
  const sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) return;
  const count = sheet.getLastRow() - Number(startRow) + 1;
  if (count > 0 && sheet.getLastColumn() > 0) {
    sheet.getRange(
      Number(startRow), 1, count, sheet.getLastColumn()).clearContent();
  }
}

function sanitizeTemplateSettings_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(APP_CONFIG.SHEETS.SETTINGS);
  if (!sheet || sheet.getLastRow() < 2) return;
  const headers = sheet.getRange(
    1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
  const keyColumn = headers.indexOf('KEY');
  const valueColumn = headers.indexOf('VALUE');
  if (keyColumn === -1 || valueColumn === -1) return;
  const range = sheet.getRange(
    2, 1, sheet.getLastRow() - 1, headers.length);
  const rows = range.getValues();
  const explicitClear = [
    'INSTANCE_ID', 'UNIT_ID', 'UNIT_CODE', 'UNIT_NAME',
    'UNIT_ADMIN_NAME', 'UNIT_ADMIN_EMAIL', 'UNIT_ROOT_FOLDER_ID',
    'UNIT_ROOT_FOLDER_URL', 'ARCHIVE_FOLDER_ID', 'ARCHIVE_FOLDER_URL',
    'QUARANTINE_FOLDER_ID', 'QUARANTINE_FOLDER_URL',
    'BACKUP_FOLDER_ID', 'BACKUP_FOLDER_URL',
    'RECEIPT_RECEIVER_NAME', 'RECEIPT_RECEIVER_UNIT',
    'RECORD_CENTER_NAME', 'RECORD_CENTER_EMAIL',
    'RECORD_CENTER_INSTANCE_ID', 'RECORD_CENTER_ENDPOINT_URL',
    'RECORD_CENTER_SHARED_SECRET'
  ];
  rows.forEach(row => {
    const key = String(row[keyColumn] || '');
    if (explicitClear.indexOf(key) !== -1 ||
        /(?:EVIDENCE|PROOF)_FOLDER_(?:ID|URL)$/.test(key)) {
      row[valueColumn] = '';
    }
    if (key === 'APP_RELEASE_VERSION') row[valueColumn] = APP_RELEASE.VERSION;
    if (key === 'SCHEMA_VERSION') row[valueColumn] = APP_RELEASE.SCHEMA_VERSION;
    if (key === 'ALLOW_PILOT_RESET') row[valueColumn] = false;
  });
  range.setValues(rows);
}

function rolloverAuditLogIfNeeded_() {
  const settings = readSettings_();
  const currentYear = Number(Utilities.formatDate(
    new Date(), APP_CONFIG.TIME_ZONE, 'yyyy'));
  const auditYear = Number(settings.AUDIT_LOG_YEAR || currentYear);
  if (auditYear >= currentYear) return {
    ok: true, rolledOver: false, auditYear: auditYear
  };
  const spreadsheet = getSpreadsheet_();
  const auditSheet = getSheetOrThrow_(APP_CONFIG.SHEETS.AUDIT);
  const archiveName = 'AUDIT_LOG_' + auditYear;
  if (spreadsheet.getSheetByName(archiveName)) {
    throw new Error(
      'Rollover Audit Log dihentikan karena sheet ' + archiveName +
      ' sudah tersedia. Administrator perlu memeriksa duplikasi.'
    );
  }
  auditSheet.setName(archiveName);
  headerCache_ = {};
  const newAudit = spreadsheet.insertSheet(APP_CONFIG.SHEETS.AUDIT);
  const headers = getHeadersFromSheet_(auditSheet);
  newAudit.getRange(1, 1, 1, headers.length).setValues([headers]);
  newAudit.setFrozenRows(1);
  newAudit.setHiddenGridlines(true);
  newAudit.getRange(1, 1, 1, headers.length)
    .setFontWeight('bold')
    .setBackground('#143b5d')
    .setFontColor('#ffffff');
  upsertReliabilitySetting_(
    'AUDIT_LOG_YEAR', currentYear, 'NUMBER', 'Tahun Audit Log aktif');
  audit_(
    'AUDIT_ROLLOVER',
    'RELIABILITY',
    'AUDIT_LOG',
    archiveName,
    'Memindahkan Audit Log ' + auditYear + ' ke ' + archiveName,
    'Rollover tahunan otomatis',
    'SUCCESS'
  );
  protectReliabilitySheets_();
  return {ok: true, rolledOver: true, archiveName: archiveName};
}

function getHeadersFromSheet_(sheet) {
  if (sheet.getLastColumn() < 1) return [];
  return sheet.getRange(
    1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0]
    .filter(Boolean);
}

function quarantineDriveObject_(objectType, objectId, context) {
  context = context || {};
  const settings = readSettings_();
  const quarantineRoot = DriveApp.getFolderById(
    requireValue_(settings.QUARANTINE_FOLDER_ID, 'QUARANTINE_FOLDER_ID'));
  const timeKey = Utilities.formatDate(
    new Date(), APP_CONFIG.TIME_ZONE, 'yyyyMMdd_HHmmss');
  const caseId = 'QRT-' + Utilities.getUuid();
  const moduleName = cleanFileName_(context.module || 'SISTEM');
  const caseFolder = quarantineRoot.createFolder(
    timeKey + '_' + moduleName + '_' + caseId.slice(4, 12));
  let object;
  let originalName = '';
  let originalUrl = '';
  let parentIds = [];
  try {
    if (String(objectType).toUpperCase() === 'FOLDER') {
      object = DriveApp.getFolderById(objectId);
    } else {
      object = DriveApp.getFileById(objectId);
    }
    originalName = object.getName();
    originalUrl = object.getUrl();
    const parents = object.getParents();
    while (parents.hasNext()) parentIds.push(parents.next().getId());
    object.moveTo(caseFolder);
    const metadata = {
      quarantineId: caseId,
      quarantinedAt: nowIso_(),
      quarantinedBy: getCurrentUser_(),
      objectType: String(objectType).toUpperCase(),
      objectId: objectId,
      originalName: originalName,
      originalUrl: originalUrl,
      originalParentIds: parentIds,
      module: context.module || '',
      reason: context.reason || '',
      relatedObjectId: context.relatedObjectId || ''
    };
    caseFolder.createFile(Utilities.newBlob(
      JSON.stringify(metadata, null, 2),
      'application/json',
      'QUARANTINE_METADATA.json'
    ));
    appendObject_(APP_CONFIG.SHEETS.SYSTEM_QUARANTINE, {
      QUARANTINE_ID: caseId,
      TIMESTAMP: metadata.quarantinedAt,
      USER_EMAIL: metadata.quarantinedBy,
      OBJECT_TYPE: metadata.objectType,
      OBJECT_ID: objectId,
      ORIGINAL_NAME: originalName,
      ORIGINAL_URL: originalUrl,
      ORIGINAL_PARENT_IDS: parentIds.join(','),
      QUARANTINE_FOLDER_ID: caseFolder.getId(),
      QUARANTINE_URL: caseFolder.getUrl(),
      MODULE: context.module || '',
      REASON: context.reason || '',
      STATUS: 'QUARANTINED',
      NOTES: context.notes || ''
    });
    return {
      ok: true,
      quarantineId: caseId,
      folderId: caseFolder.getId(),
      folderUrl: caseFolder.getUrl(),
      originalName: originalName
    };
  } catch (error) {
    try {
      appendObject_(APP_CONFIG.SHEETS.SYSTEM_QUARANTINE, {
        QUARANTINE_ID: caseId,
        TIMESTAMP: nowIso_(),
        USER_EMAIL: getCurrentUser_(),
        OBJECT_TYPE: String(objectType).toUpperCase(),
        OBJECT_ID: objectId,
        ORIGINAL_NAME: originalName,
        ORIGINAL_URL: originalUrl,
        ORIGINAL_PARENT_IDS: parentIds.join(','),
        QUARANTINE_FOLDER_ID: caseFolder.getId(),
        QUARANTINE_URL: caseFolder.getUrl(),
        MODULE: context.module || '',
        REASON: context.reason || '',
        STATUS: 'FAILED',
        NOTES: cleanText_(error.message, 1000)
      });
    } catch (ignore) {}
    return {
      ok: false,
      error: cleanText_(error.message, 1000),
      warning: 'Objek tidak dipindahkan ke karantina: ' + error.message
    };
  }
}

function recordReliabilityJobError_(moduleName, error) {
  try {
    audit_(
      'SYSTEM_ERROR',
      'RELIABILITY',
      'JOB',
      moduleName,
      cleanText_(error && error.message || error, 1000),
      'Eksekusi terjadwal',
      'FAILED'
    );
  } catch (ignore) {}
}
