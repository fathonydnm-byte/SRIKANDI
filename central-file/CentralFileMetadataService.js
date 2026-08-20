var CF_METADATA_SCHEMA_VERSION_ = 4;
var CF_METADATA_DEFAULT_CREATOR_ = 'UIN Sunan Ampel Surabaya';

var CF_METADATA_SECURITY_LEVELS_ = [
  'BIASA/TERBUKA', 'TERBATAS', 'RAHASIA', 'SANGAT RAHASIA'
];
var CF_METADATA_MEDIA_SOURCES_ = [
  'TEKSTUAL', 'AUDIO VISUAL', 'DIGITAL'
];
var CF_METADATA_DIGITAL_FORMS_ = [
  'TIDAK ADA', 'ALIH MEDIA', 'BORN DIGITAL'
];
var CF_METADATA_VERIFICATION_STATUSES_ = [
  'PERLU VERIFIKASI', 'TERVERIFIKASI'
];

var CF_METADATA_BERKAS_HEADERS_ = [
  'PENCIPTA_ARSIP_SNAPSHOT',
  'UNIT_PENCIPTA_ID',
  'UNIT_PENCIPTA_SNAPSHOT',
  'KLASIFIKASI_KEAMANAN_AKSES',
  'ARSIP_VITAL',
  'ARSIP_TERJAGA',
  'MEDIA_BERKAS',
  'JUMLAH_ITEM_FISIK',
  'JUMLAH_ITEM_BORN_DIGITAL',
  'JUMLAH_ITEM_ALIH_MEDIA',
  'STATUS_VERIFIKASI_METADATA',
  'METADATA_SCHEMA_VERSION'
];

var CF_METADATA_ITEM_HEADERS_ = [
  'KLASIFIKASI_KEAMANAN_AKSES',
  'MEDIA_SUMBER',
  'STATUS_BENTUK_DIGITAL',
  'CATATAN_MEDIA',
  'STATUS_VERIFIKASI_METADATA',
  'METADATA_SCHEMA_VERSION'
];

var CF_METADATA_RECEIPT_ITEM_HEADERS_ = [
  'KLASIFIKASI_KEAMANAN_AKSES',
  'MEDIA_SUMBER',
  'STATUS_BENTUK_DIGITAL',
  'CATATAN_MEDIA',
  'FILE_DIGITAL_ID',
  'FILE_DIGITAL_URL',
  'FILE_DIGITAL_MIME_TYPE',
  'STATUS_VERIFIKASI_METADATA',
  'METADATA_SCHEMA_VERSION'
];

function ensureCentralFileMetadataSchema_() {
  ensureReceiptModule_();
  ensureColumnsOnSheet_(
    APP_CONFIG.SHEETS.BERKAS,
    CF_METADATA_BERKAS_HEADERS_,
    [220, 170, 260, 190, 100, 100, 150, 120, 150, 140, 170, 120]
  );
  ensureColumnsOnSheet_(
    APP_CONFIG.SHEETS.ITEM,
    CF_METADATA_ITEM_HEADERS_,
    [190, 150, 170, 320, 170, 120]
  );
  ensureColumnsOnSheet_(
    RECEIPT_ITEM_SHEET_,
    CF_METADATA_RECEIPT_ITEM_HEADERS_,
    [190, 150, 170, 320, 190, 260, 180, 170, 120]
  );
  return {
    ok: true,
    schemaVersion: CF_METADATA_SCHEMA_VERSION_,
    berkasHeaders: CF_METADATA_BERKAS_HEADERS_.slice(),
    itemHeaders: CF_METADATA_ITEM_HEADERS_.slice(),
    receiptItemHeaders: CF_METADATA_RECEIPT_ITEM_HEADERS_.slice()
  };
}

function backfillCentralFileMetadataSchema_() {
  ensureCentralFileMetadataSchema_();
  const settings = readSettings_();
  const creatorName = cleanText_(
    settings.ARCHIVE_CREATOR_NAME || CF_METADATA_DEFAULT_CREATOR_, 250);
  const unitId = cleanText_(settings.UNIT_ID, 80);
  const unitName = cleanText_(settings.UNIT_NAME, 250);
  const timestamp = nowIso_();
  const user = getCurrentUser_();

  const dbItemUpdates = [];
  const normalizedItems = [];
  readObjects_(APP_CONFIG.SHEETS.ITEM).forEach(row => {
    const normalized = centralFileMetadataInferItem_(row);
    normalizedItems.push(Object.assign({}, row, normalized.values));
    if (normalized.changed) {
      const changes = Object.assign({}, normalized.values, {
        UPDATED_AT: timestamp,
        UPDATED_BY: user
      });
      dbItemUpdates.push({rowNumber: row._rowNumber, changes: changes});
    }
  });
  updateObjectsAtRows_(APP_CONFIG.SHEETS.ITEM, dbItemUpdates);

  const receiptItemUpdates = [];
  readObjects_(RECEIPT_ITEM_SHEET_).forEach(row => {
    const normalized = centralFileMetadataInferReceiptItem_(row);
    if (normalized.changed) {
      const changes = Object.assign({}, normalized.values, {
        UPDATED_AT: timestamp,
        UPDATED_BY: user
      });
      receiptItemUpdates.push({rowNumber: row._rowNumber, changes: changes});
    }
  });
  updateObjectsAtRows_(RECEIPT_ITEM_SHEET_, receiptItemUpdates);

  const itemsByBerkas = {};
  normalizedItems.forEach(item => {
    if (isDeleted_(item)) return;
    const berkasId = String(item.BERKAS_ID || '');
    if (!berkasId) return;
    if (!itemsByBerkas[berkasId]) itemsByBerkas[berkasId] = [];
    itemsByBerkas[berkasId].push(item);
  });

  const berkasUpdates = [];
  readObjects_(APP_CONFIG.SHEETS.BERKAS).forEach(row => {
    const changes = {};
    centralFileMetadataSetIfBlank_(
      changes, row, 'PENCIPTA_ARSIP_SNAPSHOT', creatorName);
    centralFileMetadataSetIfBlank_(
      changes, row, 'UNIT_PENCIPTA_ID', unitId);
    centralFileMetadataSetIfBlank_(
      changes, row, 'UNIT_PENCIPTA_SNAPSHOT', unitName);
    centralFileMetadataSetIfBlank_(
      changes, row, 'KLASIFIKASI_KEAMANAN_AKSES', 'BIASA/TERBUKA');
    centralFileMetadataSetIfBlank_(changes, row, 'ARSIP_VITAL', false);
    centralFileMetadataSetIfBlank_(changes, row, 'ARSIP_TERJAGA', false);
    centralFileMetadataSetIfBlank_(
      changes, row, 'STATUS_VERIFIKASI_METADATA', 'PERLU VERIFIKASI');
    if (Number(row.METADATA_SCHEMA_VERSION || 0) <
        CF_METADATA_SCHEMA_VERSION_) {
      changes.METADATA_SCHEMA_VERSION = CF_METADATA_SCHEMA_VERSION_;
    }

    const summary = centralFileMetadataSummarizeItems_(
      itemsByBerkas[String(row.BERKAS_ID || '')] || []);
    const security = mostRestrictiveArchiveSecurity_([
      row.KLASIFIKASI_KEAMANAN_AKSES,
      summary.securityClassification
    ]);
    if (String(row.KLASIFIKASI_KEAMANAN_AKSES || '') !== security) {
      changes.KLASIFIKASI_KEAMANAN_AKSES = security;
    }
    if (String(row.MEDIA_BERKAS || '') !== summary.mediaBerkas) {
      changes.MEDIA_BERKAS = summary.mediaBerkas;
    }
    if (Number(row.JUMLAH_ITEM_FISIK || 0) !== summary.physicalCount) {
      changes.JUMLAH_ITEM_FISIK = summary.physicalCount;
    }
    if (Number(row.JUMLAH_ITEM_BORN_DIGITAL || 0) !==
        summary.bornDigitalCount) {
      changes.JUMLAH_ITEM_BORN_DIGITAL = summary.bornDigitalCount;
    }
    if (Number(row.JUMLAH_ITEM_ALIH_MEDIA || 0) !==
        summary.mediaCopyCount) {
      changes.JUMLAH_ITEM_ALIH_MEDIA = summary.mediaCopyCount;
    }

    if (Object.keys(changes).length) {
      changes.UPDATED_AT = timestamp;
      changes.UPDATED_BY = user;
      berkasUpdates.push({rowNumber: row._rowNumber, changes: changes});
    }
  });
  updateObjectsAtRows_(APP_CONFIG.SHEETS.BERKAS, berkasUpdates);

  CacheService.getScriptCache().remove('CF_METADATA_READY_V4');
  return {
    ok: true,
    schemaVersion: CF_METADATA_SCHEMA_VERSION_,
    berkasUpdated: berkasUpdates.length,
    itemsUpdated: dbItemUpdates.length,
    receiptItemsUpdated: receiptItemUpdates.length,
    defaults: {
      creatorName: creatorName,
      unitId: unitId,
      unitName: unitName,
      security: 'BIASA/TERBUKA',
      verification: 'PERLU VERIFIKASI'
    }
  };
}

function centralFileMetadataInferItem_(row) {
  row = row || {};
  const values = {};
  centralFileMetadataSetIfDifferent_(
    values, row, 'KLASIFIKASI_KEAMANAN_AKSES',
    centralFileMetadataNormalizeSecurity_(
      row.KLASIFIKASI_KEAMANAN_AKSES || 'BIASA/TERBUKA'));
  const digitalForm = centralFileMetadataNormalizeDigitalForm_(
    row.STATUS_BENTUK_DIGITAL ||
      (row.DRIVE_FILE_ID || row.DRIVE_FILE_URL ? 'ALIH MEDIA' : 'TIDAK ADA')
  );
  const mediaSource = digitalForm === 'BORN DIGITAL'
    ? 'DIGITAL'
    : centralFileMetadataNormalizeMediaSource_(
      row.MEDIA_SUMBER || 'TEKSTUAL');
  centralFileMetadataSetIfDifferent_(
    values, row, 'MEDIA_SUMBER', mediaSource);
  centralFileMetadataSetIfDifferent_(
    values, row, 'STATUS_BENTUK_DIGITAL', digitalForm);
  centralFileMetadataSetIfBlank_(
    values, row, 'STATUS_VERIFIKASI_METADATA', 'PERLU VERIFIKASI');
  if (Number(row.METADATA_SCHEMA_VERSION || 0) <
      CF_METADATA_SCHEMA_VERSION_) {
    values.METADATA_SCHEMA_VERSION = CF_METADATA_SCHEMA_VERSION_;
  }
  return {changed: Object.keys(values).length > 0, values: values};
}

function centralFileMetadataInferReceiptItem_(row) {
  row = row || {};
  const values = {};
  centralFileMetadataSetIfDifferent_(
    values, row, 'KLASIFIKASI_KEAMANAN_AKSES',
    centralFileMetadataNormalizeSecurity_(
      row.KLASIFIKASI_KEAMANAN_AKSES || 'BIASA/TERBUKA'));
  const hasDigitalFile = Boolean(row.FILE_DIGITAL_ID || row.FILE_DIGITAL_URL);
  const digitalForm = centralFileMetadataNormalizeDigitalForm_(
    row.STATUS_BENTUK_DIGITAL || (hasDigitalFile ? 'ALIH MEDIA' : 'TIDAK ADA')
  );
  const mediaSource = digitalForm === 'BORN DIGITAL'
    ? 'DIGITAL'
    : centralFileMetadataNormalizeMediaSource_(
      row.MEDIA_SUMBER || 'TEKSTUAL');
  centralFileMetadataSetIfDifferent_(
    values, row, 'MEDIA_SUMBER', mediaSource);
  centralFileMetadataSetIfDifferent_(
    values, row, 'STATUS_BENTUK_DIGITAL', digitalForm);
  centralFileMetadataSetIfBlank_(
    values, row, 'STATUS_VERIFIKASI_METADATA', 'PERLU VERIFIKASI');
  if (Number(row.METADATA_SCHEMA_VERSION || 0) <
      CF_METADATA_SCHEMA_VERSION_) {
    values.METADATA_SCHEMA_VERSION = CF_METADATA_SCHEMA_VERSION_;
  }
  return {changed: Object.keys(values).length > 0, values: values};
}

function centralFileMetadataSummarizeItems_(items) {
  const activeItems = (items || []).filter(item => !isDeleted_(item));
  const media = {};
  const securities = [];
  let physicalCount = 0;
  let bornDigitalCount = 0;
  let mediaCopyCount = 0;
  activeItems.forEach(item => {
    securities.push(item.KLASIFIKASI_KEAMANAN_AKSES);
    const source = centralFileMetadataNormalizeMediaSource_(
      item.MEDIA_SUMBER || 'TEKSTUAL');
    const digitalForm = centralFileMetadataNormalizeDigitalForm_(
      item.STATUS_BENTUK_DIGITAL || 'TIDAK ADA');
    media[source] = true;
    if (digitalForm === 'BORN DIGITAL') bornDigitalCount++;
    else physicalCount++;
    if (digitalForm === 'ALIH MEDIA') mediaCopyCount++;
  });
  const mediaList = Object.keys(media);
  return {
    mediaBerkas: !activeItems.length
      ? 'BELUM DITETAPKAN'
      : mediaList.length === 1 ? mediaList[0] : 'KOMBINASI',
    securityClassification: mostRestrictiveArchiveSecurity_(securities),
    itemCount: activeItems.length,
    physicalCount: physicalCount,
    bornDigitalCount: bornDigitalCount,
    mediaCopyCount: mediaCopyCount
  };
}

function centralFileMetadataNormalizeMediaSource_(value) {
  const normalized = cleanText_(value, 40).toUpperCase()
    .replace(/[-_]+/g, ' ');
  if (normalized === 'AUDIOVISUAL') return 'AUDIO VISUAL';
  if (normalized === 'BORN DIGITAL') return 'DIGITAL';
  return CF_METADATA_MEDIA_SOURCES_.indexOf(normalized) !== -1
    ? normalized : 'TEKSTUAL';
}

function centralFileMetadataNormalizeDigitalForm_(value) {
  const normalized = cleanText_(value, 40).toUpperCase()
    .replace(/[-_]+/g, ' ');
  if (normalized === 'BORNDIGITAL') return 'BORN DIGITAL';
  return CF_METADATA_DIGITAL_FORMS_.indexOf(normalized) !== -1
    ? normalized : 'TIDAK ADA';
}

function centralFileMetadataNormalizeSecurity_(value) {
  const normalized = cleanText_(value, 50).toUpperCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (['BIASA', 'TERBUKA', 'BIASA TERBUKA', 'BIASA/TERBUKA']
      .indexOf(normalized) !== -1) return 'BIASA/TERBUKA';
  return CF_METADATA_SECURITY_LEVELS_.indexOf(normalized) !== -1
    ? normalized : 'BIASA/TERBUKA';
}

function validateArchiveSecurityClassification_(value, label) {
  const raw = cleanText_(requireValue_(
    value, label || 'Klasifikasi keamanan dan akses arsip'), 50);
  const normalized = centralFileMetadataNormalizeSecurity_(raw);
  const recognized = CF_METADATA_SECURITY_LEVELS_.indexOf(
    String(raw).toUpperCase()) !== -1 ||
    ['BIASA', 'TERBUKA', 'BIASA TERBUKA', 'BIASA/TERBUKA']
      .indexOf(String(raw).toUpperCase().replace(/[-_]+/g, ' ')) !== -1;
  if (!recognized) {
    throw new Error((label || 'Klasifikasi keamanan dan akses arsip') +
      ' tidak valid.');
  }
  return normalized;
}

function archiveSecurityRank_(value) {
  const normalized = centralFileMetadataNormalizeSecurity_(value);
  return {
    'BIASA/TERBUKA': 1,
    'TERBATAS': 2,
    'RAHASIA': 3,
    'SANGAT RAHASIA': 4
  }[normalized] || 1;
}

function mostRestrictiveArchiveSecurity_(values) {
  let result = 'BIASA/TERBUKA';
  (values || []).forEach(value => {
    const normalized = centralFileMetadataNormalizeSecurity_(value);
    if (archiveSecurityRank_(normalized) > archiveSecurityRank_(result)) {
      result = normalized;
    }
  });
  return result;
}

function centralFileMetadataSetIfBlank_(changes, row, key, value) {
  if (row[key] === '' || row[key] === null || row[key] === undefined) {
    changes[key] = value;
  }
}

function centralFileMetadataSetIfDifferent_(changes, row, key, value) {
  if (String(row[key] === undefined || row[key] === null ? '' : row[key]) !==
      String(value)) {
    changes[key] = value;
  }
}

function getCentralFileMetadataHealth_() {
  const spreadsheet = getSpreadsheet_();
  const requirements = [
    [APP_CONFIG.SHEETS.BERKAS, CF_METADATA_BERKAS_HEADERS_],
    [APP_CONFIG.SHEETS.ITEM, CF_METADATA_ITEM_HEADERS_],
    [RECEIPT_ITEM_SHEET_, CF_METADATA_RECEIPT_ITEM_HEADERS_]
  ];
  const missing = [];
  requirements.forEach(entry => {
    const sheet = spreadsheet.getSheetByName(entry[0]);
    if (!sheet) {
      missing.push(entry[0] + '.*');
      return;
    }
    const headers = getHeaders_(sheet);
    entry[1].forEach(header => {
      if (headers.indexOf(header) === -1) missing.push(entry[0] + '.' + header);
    });
  });
  let needsVerification = 0;
  if (!missing.length) {
    needsVerification += readObjects_(APP_CONFIG.SHEETS.BERKAS)
      .filter(row => !isDeleted_(row) &&
        String(row.STATUS_VERIFIKASI_METADATA || '').toUpperCase() ===
          'PERLU VERIFIKASI').length;
    needsVerification += readObjects_(APP_CONFIG.SHEETS.ITEM)
      .filter(row => !isDeleted_(row) &&
        String(row.STATUS_VERIFIKASI_METADATA || '').toUpperCase() ===
          'PERLU VERIFIKASI').length;
    needsVerification += readObjects_(RECEIPT_ITEM_SHEET_)
      .filter(row => !isDeleted_(row) &&
        String(row.STATUS_VERIFIKASI_METADATA || '').toUpperCase() ===
          'PERLU VERIFIKASI').length;
  }
  return {
    ok: missing.length === 0,
    missing: missing,
    needsVerification: needsVerification
  };
}

function assertCentralFileMetadataReady_() {
  const cache = CacheService.getScriptCache();
  if (cache.get('CF_METADATA_READY_V4') === 'TRUE') return true;
  const health = getCentralFileMetadataHealth_();
  if (!health.ok) {
    throw new Error(
      'Metadata Central File belum dipasang. Kolom yang hilang: ' +
      health.missing.slice(0, 10).join(', ') +
      (health.missing.length > 10 ? ', …' : '')
    );
  }
  cache.put('CF_METADATA_READY_V4', 'TRUE', 600);
  return true;
}

function repairCentralFileMetadata() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    ensureReliabilitySchema_();
    const result = backfillCentralFileMetadataSchema_();
    const settings = readSettings_();
    upsertReliabilitySettingsBatch_([
      ['APP_RELEASE_VERSION', APP_RELEASE.VERSION, 'STRING', 'Versi paket aplikasi'],
      ['SCHEMA_VERSION', APP_RELEASE.SCHEMA_VERSION, 'NUMBER', 'Versi struktur database'],
      ['ARCHIVE_CREATOR_NAME',
        cleanText_(settings.ARCHIVE_CREATOR_NAME, 250) ||
          CF_METADATA_DEFAULT_CREATOR_, 'STRING',
        'Nama resmi pencipta arsip tingkat institusi']
    ]);
    // Catat migrasi Central File yang belum ada pada jalur pemulihan manual.
    // bersifat idempoten, sehingga pemanggilan ulang tidak membuat baris ganda.
    applyReliabilityMigrations_();
    PropertiesService.getScriptProperties().setProperties({
      INSTANCE_RELEASE_VERSION: APP_RELEASE.VERSION,
      INSTANCE_SCHEMA_VERSION: String(APP_RELEASE.SCHEMA_VERSION)
    }, false);
    audit_(
      'REPAIR', 'CENTRAL_FILE_METADATA', 'SCHEMA',
      'SCHEMA-' + CF_METADATA_SCHEMA_VERSION_,
      'Memasang dan memigrasikan metadata Central File schema ' +
        CF_METADATA_SCHEMA_VERSION_,
      JSON.stringify(result), 'SUCCESS'
    );
    return result;
  } finally {
    lock.releaseLock();
  }
}
