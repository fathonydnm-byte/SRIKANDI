var RETENTION_TRANSFER_STATUS_DONE_ = 'SUDAH DIPINDAHKAN';
// Semua status lintas-instance yang belum berakhir tetap mengunci berkas dari
// usul lain. DITOLAK/DIBATALKAN menutup usul; TERTATA INAKTIF menjadi riwayat
// definitif di aplikasi Record Center pada sprint terpisah.
var RETENTION_CF04_OPEN_PROPOSAL_STATUSES_ = [
  'DRAFT', 'DIAJUKAN', 'DISETUJUI', 'DITERIMA RECORD CENTER'
];

var RETENTION_CF04_BERKAS_HEADERS_ = [
  'USUL_PINDAH_ID_AKTIF',
  'USUL_PINDAH_NO_AKTIF'
];

var RETENTION_CF04_PROPOSAL_HEADERS_ = [
  'USUL_PINDAH_ID', 'NO_USUL_PINDAH', 'JUDUL_USUL', 'STATUS_USUL',
  'UNIT_ID', 'UNIT_NAMA_SNAPSHOT', 'JUMLAH_BERKAS', 'JUMLAH_ITEM_SNAPSHOT',
  'CATATAN', 'CREATED_AT', 'CREATED_BY', 'UPDATED_AT', 'UPDATED_BY',
  'DIBATALKAN_AT', 'DIBATALKAN_BY', 'ALASAN_PEMBATALAN',
  'DAFTAR_PDF_FILE_ID', 'DAFTAR_PDF_FILE_URL',
  'DAFTAR_XLSX_FILE_ID', 'DAFTAR_XLSX_FILE_URL',
  'RIWAYAT_JRA_FILE_ID', 'RIWAYAT_JRA_FILE_URL',
  'OUTPUT_FOLDER_ID', 'OUTPUT_FOLDER_URL', 'OUTPUT_FINGERPRINT',
  'DOKUMEN_DIBUAT_AT', 'DOKUMEN_DIBUAT_BY',
  'NOTA_DINAS_FILE_ID', 'NOTA_DINAS_FILE_URL',
  'RECORD_CENTER_INSTANCE_ID', 'SUBMITTED_AT', 'SUBMITTED_BY'
];

var RETENTION_CF04_DETAIL_HEADERS_ = [
  'USUL_DETAIL_ID', 'USUL_PINDAH_ID', 'NO_USUL_PINDAH',
  'BERKAS_ID', 'NO_BERKAS_DEFINITIF', 'PENCIPTA_ARSIP_SNAPSHOT',
  'UNIT_PENCIPTA_ID', 'UNIT_PENCIPTA_SNAPSHOT', 'KODE_KLASIFIKASI_SNAPSHOT',
  'JUDUL_BERKAS_SNAPSHOT', 'KURUN_WAKTU_SNAPSHOT', 'JUMLAH_ITEM_SNAPSHOT',
  'MEDIA_BERKAS_SNAPSHOT', 'LOKASI_ASAL_CF_SNAPSHOT',
  'KLASIFIKASI_KEAMANAN_SNAPSHOT',
  'KATEGORI_ARSIP_SNAPSHOT', 'RETENSI_AKTIF_NILAI_SNAPSHOT',
  'RETENSI_AKTIF_SATUAN_SNAPSHOT', 'RETENSI_INAKTIF_NILAI_SNAPSHOT',
  'RETENSI_INAKTIF_SATUAN_SNAPSHOT', 'NASIB_AKHIR_SNAPSHOT',
  'TGL_ACUAN_RETENSI_SNAPSHOT', 'BATAS_AKTIF_SNAPSHOT',
  'JRA_ID_SNAPSHOT', 'JRA_DASAR_HUKUM_SNAPSHOT', 'JRA_VERSI_SNAPSHOT',
  'STATUS_DETAIL', 'SNAPSHOT_AT', 'SNAPSHOT_BY'
];

var RETENTION_CF05_ITEM_HEADERS_ = [
  'USUL_ITEM_ID', 'USUL_PINDAH_ID', 'NO_USUL_PINDAH', 'USUL_DETAIL_ID',
  'BERKAS_ID', 'NO_BERKAS_DEFINITIF', 'ITEM_ID', 'NO_ITEM_DEFINITIF',
  'NO_SURAT_UTAMA_SNAPSHOT', 'NO_SURAT_ALTERNATIF_SNAPSHOT',
  'NO_SURAT_DISPLAY_SNAPSHOT', 'TANGGAL_NASKAH_SNAPSHOT',
  'URAIAN_ITEM_SNAPSHOT', 'JUMLAH_HALAMAN_SNAPSHOT',
  'TINGKAT_PERKEMBANGAN_SNAPSHOT', 'KLASIFIKASI_KEAMANAN_SNAPSHOT',
  'MEDIA_SUMBER_SNAPSHOT', 'STATUS_BENTUK_DIGITAL_SNAPSHOT',
  'ALIH_MEDIA_FILE_ID_SNAPSHOT', 'ALIH_MEDIA_FILE_URL_SNAPSHOT',
  'STATUS_SNAPSHOT', 'SNAPSHOT_AT', 'SNAPSHOT_BY'
];

function ensureRetentionCf04Schema_() {
  ensureColumnsOnSheet_(
    APP_CONFIG.SHEETS.BERKAS,
    RETENTION_CF04_BERKAS_HEADERS_,
    [190, 170]
  );
  ensureSystemSheet_(
    APP_CONFIG.SHEETS.TRANSFER_PROPOSAL,
    RETENTION_CF04_PROPOSAL_HEADERS_,
    [190, 150, 330, 150, 130, 260, 110, 130, 300, 180, 220]
  );
  ensureSystemSheet_(
    APP_CONFIG.SHEETS.TRANSFER_PROPOSAL_DETAIL,
    RETENTION_CF04_DETAIL_HEADERS_,
    [190, 190, 150, 190, 130, 250, 140, 250, 170, 360, 140, 120]
  );
  ensureSystemSheet_(
    APP_CONFIG.SHEETS.TRANSFER_PROPOSAL_ITEM,
    RETENTION_CF05_ITEM_HEADERS_,
    [190, 190, 150, 190, 190, 130, 190, 120, 180, 180, 220, 140, 360]
  );
  if (typeof ensureTransferSubmissionSchema_ === 'function') {
    ensureTransferSubmissionSchema_();
  }
  return {ok: true};
}

function getRetentionCf04Health_() {
  const spreadsheet = getSpreadsheet_();
  const requirements = [
    [APP_CONFIG.SHEETS.BERKAS, RETENTION_CF04_BERKAS_HEADERS_],
    [APP_CONFIG.SHEETS.TRANSFER_PROPOSAL, RETENTION_CF04_PROPOSAL_HEADERS_],
    [APP_CONFIG.SHEETS.TRANSFER_PROPOSAL_DETAIL, RETENTION_CF04_DETAIL_HEADERS_],
    [APP_CONFIG.SHEETS.TRANSFER_PROPOSAL_ITEM, RETENTION_CF05_ITEM_HEADERS_]
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
  return {ok: missing.length === 0, missing: missing};
}

function getRetentionOptions_() {
  ensureRetentionCf04Schema_();
  const todayKey = retentionTodayKey_();
  const sourceRows = readObjects_(APP_CONFIG.SHEETS.BERKAS)
    .filter(row => !isDeleted_(row) && cleanText_(row.BATAS_AKTIF, 50));
  const itemRows = readObjects_(APP_CONFIG.SHEETS.ITEM)
    .filter(row => !isDeleted_(row));
  const loanRows = readObjects_(APP_CONFIG.SHEETS.PEMINJAMAN);
  const proposalRows = readObjects_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL);
  const detailRows = readObjects_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL_DETAIL);
  const context = retentionCf04BuildContext_(
    itemRows, loanRows, proposalRows, detailRows);
  const rows = sourceRows.map(row =>
    retentionPresentation_(row, todayKey, context)
  ).sort((a, b) => {
    const rank = {EXPIRED: 0, DUE: 1, PROPOSED: 2, ACTIVE: 3, TRANSFERRED: 4};
    return (rank[a.statusCode] || 9) - (rank[b.statusCode] || 9) ||
      String(a.activeLimit || '').localeCompare(String(b.activeLimit || '')) ||
      naturalCompare_(a.number || '999999', b.number || '999999');
  });
  const syncResult = syncRetentionStatuses_(sourceRows, todayKey, context);
  const summary = {active: 0, dueSoon: 0, expired: 0, proposed: 0, transferred: 0};
  rows.forEach(row => {
    if (row.statusCode === 'ACTIVE') summary.active++;
    if (row.statusCode === 'DUE') summary.dueSoon++;
    if (row.statusCode === 'EXPIRED') summary.expired++;
    if (row.statusCode === 'PROPOSED') summary.proposed++;
    if (row.statusCode === 'TRANSFERRED') summary.transferred++;
  });
  return {
    ok: true,
    today: todayKey,
    total: rows.length,
    summary: summary,
    berkas: rows,
    proposals: retentionCf04ProposalPresentations_(proposalRows, detailRows),
    synchronizedStatuses: syncResult.updated,
    release: APP_RELEASE.VERSION
  };
}

function retentionCf04BuildContext_(itemRows, loanRows, proposalRows, detailRows) {
  const itemCounts = {};
  const borrowedBerkasIds = {};
  (itemRows || []).forEach(item => {
    const berkasId = String(item.BERKAS_ID || '');
    if (!berkasId) return;
    itemCounts[berkasId] = Number(itemCounts[berkasId] || 0) + 1;
    if (String(item.STATUS_PEMINJAMAN || 'TERSEDIA').toUpperCase() !== 'TERSEDIA') {
      borrowedBerkasIds[berkasId] = true;
    }
  });
  (loanRows || []).forEach(loan => {
    if (String(loan.STATUS || '').toUpperCase() !== 'DIPINJAM') return;
    const berkasId = String(loan.BERKAS_ID ||
      (String(loan.JENIS_OBJEK || '').toUpperCase() === 'BERKAS' ? loan.OBJEK_ID : '') || '');
    if (berkasId) borrowedBerkasIds[berkasId] = true;
  });
  const openProposalIds = {};
  (proposalRows || []).forEach(proposal => {
    const status = String(proposal.STATUS_USUL || '').toUpperCase();
    if (RETENTION_CF04_OPEN_PROPOSAL_STATUSES_.indexOf(status) !== -1) {
      openProposalIds[String(proposal.USUL_PINDAH_ID || '')] = proposal;
    }
  });
  const proposalByBerkas = {};
  (detailRows || []).forEach(detail => {
    const proposal = openProposalIds[String(detail.USUL_PINDAH_ID || '')];
    if (!proposal || String(detail.STATUS_DETAIL || 'AKTIF').toUpperCase() === 'DIBATALKAN') return;
    proposalByBerkas[String(detail.BERKAS_ID || '')] = proposal;
  });
  return {
    itemCounts: itemCounts,
    borrowedBerkasIds: borrowedBerkasIds,
    proposalByBerkas: proposalByBerkas
  };
}

function syncRetentionStatuses_(sourceRows, todayKey, context) {
  const updates = [];
  (sourceRows || []).forEach(row => {
    const view = retentionPresentation_(row, todayKey, context);
    const desired = view.statusCode === 'TRANSFERRED' ? 'INAKTIF' :
      view.statusCode === 'PROPOSED' ? 'DALAM USUL PEMINDAHAN' :
      view.statusCode === 'EXPIRED' ? 'HABIS AKTIF – KANDIDAT USUL PINDAH' :
      view.statusCode === 'DUE' ? 'H-' + view.daysToActiveLimit : 'AKTIF';
    if (String(row.STATUS_RETENSI || '') !== desired) {
      updates.push({rowNumber: row._rowNumber, changes: {STATUS_RETENSI: desired}});
    }
  });
  if (!updates.length) return {updated: 0};
  updateObjectsAtRows_(APP_CONFIG.SHEETS.BERKAS, updates);
  try { rebuildReports_(); }
  catch (error) {
    audit_('REPORT_WARNING', 'USUL_PEMINDAHAN', 'BATCH', '',
      'Status retensi diperbarui tetapi laporan gagal disegarkan', error.message, 'WARNING');
  }
  return {updated: updates.length};
}

function retentionPresentation_(row, todayKey, context) {
  context = context || {itemCounts: {}, borrowedBerkasIds: {}, proposalByBerkas: {}};
  const activeLimit = dateKey_(row.BATAS_AKTIF);
  const referenceDate = row.TGL_ACUAN_RETENSI ? dateKey_(row.TGL_ACUAN_RETENSI) : '';
  const inactiveLimit = row.BATAS_INAKTIF ? dateKey_(row.BATAS_INAKTIF) : '';
  const transferred = String(row.STATUS_PEMINDAHAN || '').toUpperCase() ===
    RETENTION_TRANSFER_STATUS_DONE_;
  const proposal = context.proposalByBerkas[String(row.BERKAS_ID || '')] || null;
  const borrowed = Boolean(context.borrowedBerkasIds[String(row.BERKAS_ID || '')]) ||
    String(row.STATUS_PEMINJAMAN || 'TERSEDIA').toUpperCase() !== 'TERSEDIA';
  const daysToActiveLimit = retentionDayDifference_(todayKey, activeLimit);
  let statusCode = 'ACTIVE';
  let statusLabel = 'AKTIF';
  if (transferred) {
    statusCode = 'TRANSFERRED';
    statusLabel = 'INAKTIF – RIWAYAT LAMA';
  } else if (proposal) {
    statusCode = 'PROPOSED';
    statusLabel = String(proposal.STATUS_USUL || 'DRAFT') + ' USUL PINDAH';
  } else if (daysToActiveLimit < 0) {
    statusCode = 'EXPIRED';
    statusLabel = 'HABIS AKTIF – KANDIDAT USUL PINDAH';
  } else if (daysToActiveLimit <= 7) {
    statusCode = 'DUE';
    statusLabel = daysToActiveLimit === 0 ? 'BERAKHIR HARI INI' : 'H-' + daysToActiveLimit;
  }
  const metadataVerified = String(row.STATUS_VERIFIKASI_METADATA || '').toUpperCase() ===
    'TERVERIFIKASI';
  const eligibleToPropose = statusCode === 'EXPIRED' && !borrowed && metadataVerified;
  const canVerifyMetadata = statusCode === 'EXPIRED' && !borrowed &&
    !metadataVerified;
  let blockingReason = '';
  if (!eligibleToPropose) {
    blockingReason = statusCode === 'TRANSFERRED' ? 'Berkas sudah menjadi riwayat pemindahan lama.' :
      statusCode === 'PROPOSED' ? 'Berkas sudah berada dalam ' + (proposal.NO_USUL_PINDAH || 'usul lain') + '.' :
      statusCode !== 'EXPIRED' ? 'Masa retensi aktif belum berakhir.' :
      borrowed ? 'Berkas atau salah satu itemnya sedang dipinjam.' :
      'Metadata CF-02 belum terverifikasi.';
  }
  return {
    id: row.BERKAS_ID,
    number: row.NO_BERKAS_DEFINITIF || '',
    title: row.JUDUL_BERKAS || '',
    classificationCode: row.KODE_KLASIFIKASI_SNAPSHOT || '',
    archiveCreator: row.PENCIPTA_ARSIP_SNAPSHOT || '',
    creatorUnit: row.UNIT_PENCIPTA_SNAPSHOT || '',
    securityClassification: row.KLASIFIKASI_KEAMANAN_AKSES || '',
    archiveMedia: row.MEDIA_BERKAS || '',
    referenceDate: referenceDate,
    activeLimit: activeLimit,
    inactiveLimit: inactiveLimit,
    activeRetention: retentionDurationLabel_(row.RETENSI_AKTIF_NILAI, row.RETENSI_AKTIF_SATUAN),
    inactiveRetention: retentionDurationLabel_(row.RETENSI_INAKTIF_NILAI, row.RETENSI_INAKTIF_SATUAN),
    finalDisposition: row.NASIB_AKHIR || '',
    statusCode: statusCode,
    statusLabel: statusLabel,
    daysToActiveLimit: daysToActiveLimit,
    location: archiveLocationLabel_(row),
    folderUrl: row.DRIVE_FOLDER_URL || '',
    itemCount: Number(context.itemCounts[String(row.BERKAS_ID || '')] || 0),
    loanStatus: borrowed ? 'DIPINJAM' : 'TERSEDIA',
    metadataVerified: metadataVerified,
    canVerifyMetadata: canVerifyMetadata,
    eligibleToPropose: eligibleToPropose,
    blockingReason: blockingReason,
    proposalId: proposal ? proposal.USUL_PINDAH_ID || '' : '',
    proposalNumber: proposal ? proposal.NO_USUL_PINDAH || '' : ''
  };
}

function verifyRetentionCandidateMetadata_(berkasId) {
  const id = cleanText_(requireValue_(berkasId, 'ID berkas'), 100);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    ensureCentralFileMetadataSchema_();
    const berkas = readObjects_(APP_CONFIG.SHEETS.BERKAS)
      .find(row => !isDeleted_(row) && String(row.BERKAS_ID || '') === id);
    if (!berkas) throw new Error('Berkas tidak ditemukan atau sudah dibatalkan.');

    const items = readObjects_(APP_CONFIG.SHEETS.ITEM)
      .filter(row => !isDeleted_(row) && String(row.BERKAS_ID || '') === id);
    const settings = readSettings_();
    const issues = retentionMetadataVerificationIssues_(berkas, items, settings);
    if (issues.length) {
      throw new Error('Metadata belum dapat diverifikasi: ' +
        issues.slice(0, 6).join('; ') +
        (issues.length > 6 ? '; dan ' + (issues.length - 6) + ' masalah lain.' : '.'));
    }

    const loanRows = readObjects_(APP_CONFIG.SHEETS.PEMINJAMAN);
    const proposalRows = readObjects_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL);
    const detailRows = readObjects_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL_DETAIL);
    const context = retentionCf04BuildContext_(items, loanRows, proposalRows, detailRows);
    const view = retentionPresentation_(berkas, retentionTodayKey_(), context);
    if (view.statusCode !== 'EXPIRED') {
      throw new Error(view.blockingReason || 'Berkas bukan kandidat habis aktif.');
    }
    if (view.loanStatus !== 'TERSEDIA') {
      throw new Error('Berkas atau salah satu itemnya sedang dipinjam.');
    }

    const timestamp = nowIso_();
    const user = getCurrentUser_();
    const normalizedItems = items.map(item => Object.assign({}, item, {
      KLASIFIKASI_KEAMANAN_AKSES: centralFileMetadataNormalizeSecurity_(
        item.KLASIFIKASI_KEAMANAN_AKSES),
      MEDIA_SUMBER: centralFileMetadataNormalizeMediaSource_(item.MEDIA_SUMBER),
      STATUS_BENTUK_DIGITAL: centralFileMetadataNormalizeDigitalForm_(
        item.STATUS_BENTUK_DIGITAL)
    }));
    const summary = centralFileMetadataSummarizeItems_(normalizedItems);
    const itemUpdates = normalizedItems.map(item => ({
      rowNumber: item._rowNumber,
      changes: {
        KLASIFIKASI_KEAMANAN_AKSES: item.KLASIFIKASI_KEAMANAN_AKSES,
        MEDIA_SUMBER: item.MEDIA_SUMBER,
        STATUS_BENTUK_DIGITAL: item.STATUS_BENTUK_DIGITAL,
        STATUS_VERIFIKASI_METADATA: 'TERVERIFIKASI',
        METADATA_SCHEMA_VERSION: CF_METADATA_SCHEMA_VERSION_,
        UPDATED_AT: timestamp,
        UPDATED_BY: user,
        VERSION: Number(item.VERSION || 0) + 1
      }
    }));
    updateObjectsAtRows_(APP_CONFIG.SHEETS.ITEM, itemUpdates);

    const creator = cleanText_(berkas.PENCIPTA_ARSIP_SNAPSHOT, 250) ||
      cleanText_(settings.ARCHIVE_CREATOR_NAME, 250) ||
      CF_METADATA_DEFAULT_CREATOR_;
    const unitId = cleanText_(berkas.UNIT_PENCIPTA_ID, 80) ||
      cleanText_(settings.UNIT_ID, 80);
    const unitName = cleanText_(berkas.UNIT_PENCIPTA_SNAPSHOT, 250) ||
      cleanText_(settings.UNIT_NAME, 250);
    updateObjectAtRow_(APP_CONFIG.SHEETS.BERKAS, berkas._rowNumber, {
      PENCIPTA_ARSIP_SNAPSHOT: creator,
      UNIT_PENCIPTA_ID: unitId,
      UNIT_PENCIPTA_SNAPSHOT: unitName,
      KLASIFIKASI_KEAMANAN_AKSES: summary.securityClassification,
      MEDIA_BERKAS: summary.mediaBerkas,
      JUMLAH_ITEM_FISIK: summary.physicalCount,
      JUMLAH_ITEM_BORN_DIGITAL: summary.bornDigitalCount,
      JUMLAH_ITEM_ALIH_MEDIA: summary.mediaCopyCount,
      STATUS_VERIFIKASI_METADATA: 'TERVERIFIKASI',
      METADATA_SCHEMA_VERSION: CF_METADATA_SCHEMA_VERSION_,
      UPDATED_AT: timestamp,
      UPDATED_BY: user,
      VERSION: Number(berkas.VERSION || 0) + 1
    });
    audit_('VERIFY', 'USUL_PEMINDAHAN', 'BERKAS', id,
      'Metadata berkas dan ' + items.length + ' item diverifikasi sebelum usul pindah',
      'Pencipta: ' + creator + ' | Unit: ' + unitName +
        ' | Keamanan: ' + summary.securityClassification +
        ' | Media: ' + summary.mediaBerkas,
      'SUCCESS');
    return {
      ok: true,
      berkasId: id,
      itemCount: items.length,
      message: 'Metadata berkas dan ' + items.length +
        ' item telah diverifikasi. Checkbox kandidat sekarang dapat dipilih.'
    };
  } finally {
    lock.releaseLock();
  }
}

function retentionMetadataVerificationIssues_(berkas, items, settings) {
  settings = settings || {};
  const issues = [];
  if (!cleanText_(berkas.PENCIPTA_ARSIP_SNAPSHOT, 250) &&
      !cleanText_(settings.ARCHIVE_CREATOR_NAME, 250) &&
      !cleanText_(CF_METADATA_DEFAULT_CREATOR_, 250)) {
    issues.push('pencipta arsip belum tersedia');
  }
  if ((!cleanText_(berkas.UNIT_PENCIPTA_ID, 80) &&
       !cleanText_(settings.UNIT_ID, 80)) ||
      (!cleanText_(berkas.UNIT_PENCIPTA_SNAPSHOT, 250) &&
       !cleanText_(settings.UNIT_NAME, 250))) {
    issues.push('unit pencipta belum tersedia');
  }
  if (!cleanText_(berkas.KODE_KLASIFIKASI_SNAPSHOT, 80)) {
    issues.push('kode klasifikasi berkas kosong');
  }
  if (!items.length) issues.push('berkas belum mempunyai item aktif');
  items.forEach((item, index) => {
    const label = 'item ' + (item.NO_ITEM_DEFINITIF || index + 1);
    if (!dateKey_(item.TANGGAL_NASKAH)) issues.push(label + ': tanggal naskah kosong');
    if (!cleanText_(item.URAIAN_LENGKAP, 2000)) issues.push(label + ': uraian kosong');
    if (!(Number(item.JUMLAH_HALAMAN) > 0)) issues.push(label + ': jumlah halaman tidak valid');
    if (!cleanText_(item.TINGKAT_PERKEMBANGAN, 50)) {
      issues.push(label + ': tingkat perkembangan kosong');
    }
    const security = cleanText_(item.KLASIFIKASI_KEAMANAN_AKSES, 50).toUpperCase();
    if (CF_METADATA_SECURITY_LEVELS_.indexOf(security) === -1) {
      issues.push(label + ': klasifikasi keamanan belum valid');
    }
    const media = cleanText_(item.MEDIA_SUMBER, 50).toUpperCase();
    if (CF_METADATA_MEDIA_SOURCES_.indexOf(media) === -1) {
      issues.push(label + ': media sumber belum valid');
    }
    const digitalForm = cleanText_(item.STATUS_BENTUK_DIGITAL, 50).toUpperCase();
    if (CF_METADATA_DIGITAL_FORMS_.indexOf(digitalForm) === -1) {
      issues.push(label + ': bentuk digital belum valid');
    }
  });
  return issues;
}

function createTransferProposalDraft_(form) {
  form = form || {};
  const ids = retentionCf04ParseIds_(form.berkasIds);
  if (!ids.length) throw new Error('Pilih minimal satu berkas kandidat.');
  if (ids.length > 200) throw new Error('Satu draft maksimal memuat 200 berkas.');
  const title = cleanText_(form.proposalTitle, 300) ||
    'Usul Pemindahan Arsip Inaktif';
  const notes = cleanText_(form.proposalNotes, 2000);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    ensureRetentionCf04Schema_();
    const todayKey = retentionTodayKey_();
    const berkasRows = readObjects_(APP_CONFIG.SHEETS.BERKAS)
      .filter(row => !isDeleted_(row));
    const itemRows = readObjects_(APP_CONFIG.SHEETS.ITEM)
      .filter(row => !isDeleted_(row));
    const loanRows = readObjects_(APP_CONFIG.SHEETS.PEMINJAMAN);
    const proposalRows = readObjects_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL);
    const detailRows = readObjects_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL_DETAIL);
    const context = retentionCf04BuildContext_(itemRows, loanRows, proposalRows, detailRows);
    const byId = {};
    berkasRows.forEach(row => byId[String(row.BERKAS_ID || '')] = row);
    const selected = ids.map(id => {
      const row = byId[id];
      if (!row) throw new Error('Berkas ' + id + ' tidak ditemukan.');
      const view = retentionPresentation_(row, todayKey, context);
      if (!view.eligibleToPropose) {
        throw new Error((row.NO_BERKAS_DEFINITIF || id) + ': ' + view.blockingReason);
      }
      return {row: row, view: view};
    });
    const settings = readSettings_();
    const timestamp = nowIso_();
    const user = getCurrentUser_();
    const proposalId = 'USP-' + Utilities.getUuid();
    const proposalNumber = retentionCf04NextProposalNumber_(proposalRows, todayKey);
    const totalItems = selected.reduce((sum, entry) => sum + entry.view.itemCount, 0);
    const detailObjects = selected.map(entry =>
      retentionCf04SnapshotDetail_(entry.row, entry.view, proposalId,
        proposalNumber, timestamp, user)
    );
    const itemSnapshotObjects = retentionCf05SnapshotItems_(
      selected, itemRows, detailObjects, proposalId, proposalNumber,
      timestamp, user);
    if (itemSnapshotObjects.length !== totalItems) {
      throw new Error('Jumlah snapshot item tidak konsisten. Muat ulang data lalu coba kembali.');
    }
    appendObject_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL, {
      USUL_PINDAH_ID: proposalId,
      NO_USUL_PINDAH: proposalNumber,
      JUDUL_USUL: title,
      STATUS_USUL: 'DRAFT',
      UNIT_ID: settings.UNIT_ID || '',
      UNIT_NAMA_SNAPSHOT: settings.UNIT_NAME || '',
      JUMLAH_BERKAS: selected.length,
      JUMLAH_ITEM_SNAPSHOT: totalItems,
      CATATAN: notes,
      CREATED_AT: timestamp,
      CREATED_BY: user,
      UPDATED_AT: timestamp,
      UPDATED_BY: user
    });
    appendObjects_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL_DETAIL, detailObjects);
    if (itemSnapshotObjects.length) {
      appendObjects_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL_ITEM, itemSnapshotObjects);
    }
    updateObjectsAtRows_(APP_CONFIG.SHEETS.BERKAS, selected.map(entry => ({
      rowNumber: entry.row._rowNumber,
      changes: {
        USUL_PINDAH_ID_AKTIF: proposalId,
        USUL_PINDAH_NO_AKTIF: proposalNumber,
        STATUS_RETENSI: 'DALAM DRAFT USUL PEMINDAHAN',
        UPDATED_AT: timestamp,
        UPDATED_BY: user,
        VERSION: Number(entry.row.VERSION || 0) + 1
      }
    })));
    audit_('CREATE_DRAFT', 'USUL_PEMINDAHAN', 'USUL_PINDAH', proposalId,
      'Membuat draft ' + proposalNumber,
      selected.length + ' berkas · ' + totalItems + ' item snapshot', 'SUCCESS');
    return {
      ok: true,
      proposalId: proposalId,
      proposalNumber: proposalNumber,
      berkasCount: selected.length,
      itemCount: totalItems,
      message: proposalNumber + ' dibuat sebagai DRAFT. Fase seluruh berkas tetap AKTIF.'
    };
  } catch (error) {
    audit_('CREATE_DRAFT', 'USUL_PEMINDAHAN', 'USUL_PINDAH', '',
      'Pembuatan draft usul gagal', error.message, 'FAILED');
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function cancelTransferProposalDraft_(form) {
  form = form || {};
  const proposalId = cleanText_(requireValue_(form.proposalId, 'ID usul'), 100);
  const reason = cleanText_(requireValue_(form.cancelReason, 'Alasan pembatalan'), 1000);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    ensureRetentionCf04Schema_();
    const proposals = readObjects_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL);
    const proposal = proposals.find(row => String(row.USUL_PINDAH_ID) === proposalId);
    if (!proposal) throw new Error('Draft usul tidak ditemukan.');
    const previousStatus = String(proposal.STATUS_USUL || '').toUpperCase();
    if (['DRAFT', 'DIAJUKAN'].indexOf(previousStatus) === -1) {
      throw new Error('Hanya draft atau pengajuan yang belum diputus Record Center yang dapat dibatalkan.');
    }
    const details = readObjects_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL_DETAIL)
      .filter(row => String(row.USUL_PINDAH_ID) === proposalId &&
        String(row.STATUS_DETAIL || 'AKTIF').toUpperCase() !== 'DIBATALKAN');
    const itemSnapshots = readObjects_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL_ITEM)
      .filter(row => String(row.USUL_PINDAH_ID) === proposalId &&
        String(row.STATUS_SNAPSHOT || 'AKTIF').toUpperCase() !== 'DIBATALKAN');
    const berkasRows = readObjects_(APP_CONFIG.SHEETS.BERKAS);
    const byId = {};
    berkasRows.forEach(row => byId[String(row.BERKAS_ID || '')] = row);
    const timestamp = nowIso_();
    const user = getCurrentUser_();
    updateObjectAtRow_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL, proposal._rowNumber, {
      STATUS_USUL: 'DIBATALKAN',
      DIBATALKAN_AT: timestamp,
      DIBATALKAN_BY: user,
      ALASAN_PEMBATALAN: reason,
      UPDATED_AT: timestamp,
      UPDATED_BY: user
    });
    updateObjectsAtRows_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL_DETAIL,
      details.map(detail => ({
        rowNumber: detail._rowNumber,
        changes: {STATUS_DETAIL: 'DIBATALKAN'}
      })));
    updateObjectsAtRows_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL_ITEM,
      itemSnapshots.map(item => ({
        rowNumber: item._rowNumber,
        changes: {STATUS_SNAPSHOT: 'DIBATALKAN'}
      })));
    const berkasUpdates = [];
    details.forEach(detail => {
      const parent = byId[String(detail.BERKAS_ID || '')];
      if (!parent || String(parent.USUL_PINDAH_ID_AKTIF || '') !== proposalId) return;
      berkasUpdates.push({
        rowNumber: parent._rowNumber,
        changes: {
          USUL_PINDAH_ID_AKTIF: '',
          USUL_PINDAH_NO_AKTIF: '',
          STATUS_RETENSI: 'HABIS AKTIF – KANDIDAT USUL PINDAH',
          UPDATED_AT: timestamp,
          UPDATED_BY: user,
          VERSION: Number(parent.VERSION || 0) + 1
        }
      });
    });
    updateObjectsAtRows_(APP_CONFIG.SHEETS.BERKAS, berkasUpdates);
    audit_('CANCEL_DRAFT', 'USUL_PEMINDAHAN', 'USUL_PINDAH', proposalId,
      'Membatalkan ' + (proposal.NO_USUL_PINDAH || proposalId), reason, 'SUCCESS');
    let cancellationDispatch = null;
    if (previousStatus === 'DIAJUKAN' &&
        typeof queueTransferCancellation_ === 'function') {
      cancellationDispatch = queueTransferCancellation_(
        proposal, reason, timestamp, user);
    }
    return {
      ok: true,
      message: (proposal.NO_USUL_PINDAH || 'Usul') + ' dibatalkan.' +
        (previousStatus === 'DIAJUKAN'
          ? ' Pembatalan dicatat pada antrean Record Center.' : ''),
      cancellationOutboxStatus: cancellationDispatch &&
        cancellationDispatch.status || ''
    };
  } finally {
    lock.releaseLock();
  }
}

function retentionCf04ParseIds_(value) {
  let ids = value;
  if (typeof value === 'string') {
    try { ids = JSON.parse(value); }
    catch (ignore) { ids = value.split(','); }
  }
  if (!Array.isArray(ids)) ids = [];
  const seen = {};
  return ids.map(id => cleanText_(id, 100)).filter(id => {
    if (!id || seen[id]) return false;
    seen[id] = true;
    return true;
  });
}

function retentionCf04NextProposalNumber_(proposalRows, todayKey) {
  const year = String(todayKey || '').slice(0, 4);
  const prefix = 'UP-' + year + '-';
  let max = 0;
  (proposalRows || []).forEach(row => {
    const value = String(row.NO_USUL_PINDAH || '');
    if (value.indexOf(prefix) !== 0) return;
    const sequence = Number(value.slice(prefix.length));
    if (Number.isInteger(sequence) && sequence > max) max = sequence;
  });
  return prefix + String(max + 1).padStart(4, '0');
}

function retentionCf04SnapshotDetail_(row, view, proposalId, proposalNumber,
    timestamp, user) {
  const category = row.ARSIP_VITAL === true || String(row.ARSIP_VITAL).toUpperCase() === 'YA'
    ? 'VITAL' : row.ARSIP_TERJAGA === true || String(row.ARSIP_TERJAGA).toUpperCase() === 'YA'
      ? 'TERJAGA' : 'BIASA';
  return {
    USUL_DETAIL_ID: 'USPD-' + Utilities.getUuid(),
    USUL_PINDAH_ID: proposalId,
    NO_USUL_PINDAH: proposalNumber,
    BERKAS_ID: row.BERKAS_ID || '',
    NO_BERKAS_DEFINITIF: row.NO_BERKAS_DEFINITIF || '',
    PENCIPTA_ARSIP_SNAPSHOT: row.PENCIPTA_ARSIP_SNAPSHOT || '',
    UNIT_PENCIPTA_ID: row.UNIT_PENCIPTA_ID || '',
    UNIT_PENCIPTA_SNAPSHOT: row.UNIT_PENCIPTA_SNAPSHOT || '',
    KODE_KLASIFIKASI_SNAPSHOT: row.KODE_KLASIFIKASI_SNAPSHOT || '',
    JUDUL_BERKAS_SNAPSHOT: row.JUDUL_BERKAS || '',
    KURUN_WAKTU_SNAPSHOT: row.KURUN_WAKTU || row.TAHUN || '',
    JUMLAH_ITEM_SNAPSHOT: view.itemCount,
    MEDIA_BERKAS_SNAPSHOT: row.MEDIA_BERKAS || '',
    LOKASI_ASAL_CF_SNAPSHOT: view.location || '',
    KLASIFIKASI_KEAMANAN_SNAPSHOT: row.KLASIFIKASI_KEAMANAN_AKSES || '',
    KATEGORI_ARSIP_SNAPSHOT: category,
    RETENSI_AKTIF_NILAI_SNAPSHOT: row.RETENSI_AKTIF_NILAI || '',
    RETENSI_AKTIF_SATUAN_SNAPSHOT: row.RETENSI_AKTIF_SATUAN || '',
    RETENSI_INAKTIF_NILAI_SNAPSHOT: row.RETENSI_INAKTIF_NILAI || '',
    RETENSI_INAKTIF_SATUAN_SNAPSHOT: row.RETENSI_INAKTIF_SATUAN || '',
    NASIB_AKHIR_SNAPSHOT: row.NASIB_AKHIR || '',
    TGL_ACUAN_RETENSI_SNAPSHOT: row.TGL_ACUAN_RETENSI || '',
    BATAS_AKTIF_SNAPSHOT: row.BATAS_AKTIF || '',
    JRA_ID_SNAPSHOT: row.JRA_ID || row.JRA_ID_SNAPSHOT || '',
    JRA_DASAR_HUKUM_SNAPSHOT: row.JRA_DASAR_HUKUM ||
      row.DASAR_HUKUM_JRA || row.JRA_DASAR_HUKUM_SNAPSHOT || '',
    JRA_VERSI_SNAPSHOT: row.JRA_VERSI || row.VERSI_JRA ||
      row.JRA_VERSI_SNAPSHOT || '',
    STATUS_DETAIL: 'AKTIF',
    SNAPSHOT_AT: timestamp,
    SNAPSHOT_BY: user
  };
}

function retentionCf04ProposalPresentations_(proposalRows, detailRows) {
  const counts = {};
  (detailRows || []).forEach(detail => {
    const id = String(detail.USUL_PINDAH_ID || '');
    if (!id || String(detail.STATUS_DETAIL || '').toUpperCase() === 'DIBATALKAN') return;
    counts[id] = Number(counts[id] || 0) + 1;
  });
  return (proposalRows || []).map(row => ({
    id: row.USUL_PINDAH_ID || '',
    number: row.NO_USUL_PINDAH || '',
    title: row.JUDUL_USUL || '',
    status: row.STATUS_USUL || '',
    berkasCount: Number(row.JUMLAH_BERKAS || counts[row.USUL_PINDAH_ID] || 0),
    itemCount: Number(row.JUMLAH_ITEM_SNAPSHOT || 0),
    createdAt: row.CREATED_AT || '',
    createdBy: row.CREATED_BY || '',
    notes: row.CATATAN || '',
    cancelReason: row.ALASAN_PEMBATALAN || '',
    pdfUrl: row.DAFTAR_PDF_FILE_URL || '',
    xlsxUrl: row.DAFTAR_XLSX_FILE_URL || '',
    jraUrl: row.RIWAYAT_JRA_FILE_URL || '',
    documentsCreatedAt: row.DOKUMEN_DIBUAT_AT || '',
    hasDocuments: Boolean(row.DAFTAR_PDF_FILE_ID &&
      row.DAFTAR_XLSX_FILE_ID && row.RIWAYAT_JRA_FILE_ID),
    notaDinasUrl: row.NOTA_DINAS_FILE_URL || '',
    payloadUrl: row.SUBMISSION_PAYLOAD_FILE_URL || '',
    submittedAt: row.SUBMITTED_AT || '',
    submittedBy: row.SUBMITTED_BY || '',
    recordCenterName: row.RECORD_CENTER_NAME_SNAPSHOT || '',
    recordCenterEmail: row.RECORD_CENTER_EMAIL_SNAPSHOT || '',
    outboxStatus: row.OUTBOX_STATUS || '',
    outboxLastError: row.OUTBOX_LAST_ERROR || '',
    canGenerateDocuments: String(row.STATUS_USUL || '').toUpperCase() === 'DRAFT',
    canSubmit: String(row.STATUS_USUL || '').toUpperCase() === 'DRAFT' &&
      Boolean(row.DAFTAR_PDF_FILE_ID && row.DAFTAR_XLSX_FILE_ID &&
        row.RIWAYAT_JRA_FILE_ID),
    canRetrySubmission: String(row.STATUS_USUL || '').toUpperCase() === 'DIAJUKAN' &&
      ['SENT'].indexOf(String(row.OUTBOX_STATUS || '').toUpperCase()) === -1,
    canCancel: ['DRAFT', 'DIAJUKAN'].indexOf(
      String(row.STATUS_USUL || '').toUpperCase()) !== -1
  })).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function retentionCf05SnapshotItems_(selected, itemRows, detailObjects,
    proposalId, proposalNumber, timestamp, user) {
  const selectedById = {};
  (selected || []).forEach(entry => {
    selectedById[String(entry.row.BERKAS_ID || '')] = entry;
  });
  const detailByBerkas = {};
  (detailObjects || []).forEach(detail => {
    detailByBerkas[String(detail.BERKAS_ID || '')] = detail;
  });
  return (itemRows || []).filter(item =>
    Boolean(selectedById[String(item.BERKAS_ID || '')])
  ).sort((a, b) => {
    const parentA = selectedById[String(a.BERKAS_ID || '')];
    const parentB = selectedById[String(b.BERKAS_ID || '')];
    return naturalCompare_(
      parentA && parentA.row.NO_BERKAS_DEFINITIF || '',
      parentB && parentB.row.NO_BERKAS_DEFINITIF || '') ||
      naturalCompare_(a.NO_ITEM_DEFINITIF || '', b.NO_ITEM_DEFINITIF || '');
  }).map(item => {
    const detail = detailByBerkas[String(item.BERKAS_ID || '')] || {};
    return {
      USUL_ITEM_ID: 'USPI-' + Utilities.getUuid(),
      USUL_PINDAH_ID: proposalId,
      NO_USUL_PINDAH: proposalNumber,
      USUL_DETAIL_ID: detail.USUL_DETAIL_ID || '',
      BERKAS_ID: item.BERKAS_ID || '',
      NO_BERKAS_DEFINITIF: detail.NO_BERKAS_DEFINITIF || '',
      ITEM_ID: item.ITEM_ID || '',
      NO_ITEM_DEFINITIF: item.NO_ITEM_DEFINITIF || '',
      NO_SURAT_UTAMA_SNAPSHOT: item.NO_SURAT_UTAMA || '',
      NO_SURAT_ALTERNATIF_SNAPSHOT: item.NO_SURAT_ALTERNATIF || '',
      NO_SURAT_DISPLAY_SNAPSHOT: item.NO_SURAT_DISPLAY || '',
      TANGGAL_NASKAH_SNAPSHOT: item.TANGGAL_NASKAH || '',
      URAIAN_ITEM_SNAPSHOT: item.URAIAN_LENGKAP || '',
      JUMLAH_HALAMAN_SNAPSHOT: item.JUMLAH_HALAMAN || '',
      TINGKAT_PERKEMBANGAN_SNAPSHOT: item.TINGKAT_PERKEMBANGAN || '',
      KLASIFIKASI_KEAMANAN_SNAPSHOT: item.KLASIFIKASI_KEAMANAN_AKSES || '',
      MEDIA_SUMBER_SNAPSHOT: item.MEDIA_SUMBER || '',
      STATUS_BENTUK_DIGITAL_SNAPSHOT: item.STATUS_BENTUK_DIGITAL || '',
      ALIH_MEDIA_FILE_ID_SNAPSHOT: item.DRIVE_FILE_ID || '',
      ALIH_MEDIA_FILE_URL_SNAPSHOT: item.DRIVE_FILE_URL || '',
      STATUS_SNAPSHOT: 'AKTIF',
      SNAPSHOT_AT: timestamp,
      SNAPSHOT_BY: user
    };
  });
}

function markBerkasTransferred_() {
  throw new Error(
    'CF-04 menonaktifkan pemindahan langsung dari Central File. ' +
    'Berkas harus dibuatkan usul dan tetap berfase AKTIF sampai diterima Record Center.'
  );
}

function startRetentionTransferEvidenceUpload_() { return markBerkasTransferred_(); }
function uploadRetentionTransferEvidenceChunk_() { return markBerkasTransferred_(); }
function getRetentionTransferEvidenceUploadStatus_() { return markBerkasTransferred_(); }
function finalizeRetentionTransferEvidenceUpload_() { return markBerkasTransferred_(); }
function cancelRetentionTransferEvidenceUpload_() { return {ok: true}; }

function retentionDurationLabel_(value, unit) {
  const number = Number(value || 0);
  const normalizedUnit = String(unit || '').toUpperCase();
  if (!normalizedUnit) return '–';
  return number + ' ' + (normalizedUnit === 'TAHUN' ? 'tahun' : 'bulan');
}

function retentionTodayKey_() {
  return Utilities.formatDate(new Date(), APP_CONFIG.TIME_ZONE, 'yyyy-MM-dd');
}

function retentionDayDifference_(todayKey, limitKey) {
  const today = parseLocalDate_(todayKey, 'Hari ini');
  const limit = parseLocalDate_(limitKey, 'Batas aktif');
  return Math.round((limit.getTime() - today.getTime()) / 86400000);
}
