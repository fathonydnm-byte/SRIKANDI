var RETENTION_CF05_OUTPUT_FOLDER_NAME_ = '02 USUL PEMINDAHAN';
var RETENTION_CF05_DAUP_BERKAS_SHEET_ = 'Daftar Berkas';
var RETENTION_CF05_DAUP_ITEM_SHEET_ = 'Daftar Isi Berkas';
var RETENTION_CF05_JRA_SHEET_ = 'Riwayat JRA';

function generateTransferProposalDocuments_(proposalId) {
  proposalId = cleanText_(requireValue_(proposalId, 'ID usul'), 100);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let daupSpreadsheetId = '';
  let jraSpreadsheetId = '';
  try {
    ensureRetentionCf04Schema_();
    const proposals = readObjects_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL);
    const proposal = proposals.find(row =>
      String(row.USUL_PINDAH_ID || '') === proposalId);
    if (!proposal) throw new Error('Draft usul pemindahan tidak ditemukan.');

    const existing = retentionCf05ExistingDocuments_(proposal);
    if (existing.complete) {
      return Object.assign({
        ok: true,
        reused: true,
        message: (proposal.NO_USUL_PINDAH || 'Dokumen usul') +
          ' sudah tersedia; sistem menggunakan file yang sama.'
      }, existing);
    }
    if (String(proposal.STATUS_USUL || '').toUpperCase() !== 'DRAFT') {
      throw new Error('Dokumen baru hanya dapat dibuat saat usul berstatus DRAFT.');
    }

    const details = readObjects_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL_DETAIL)
      .filter(row => String(row.USUL_PINDAH_ID || '') === proposalId &&
        String(row.STATUS_DETAIL || 'AKTIF').toUpperCase() !== 'DIBATALKAN');
    const itemSnapshots = readObjects_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL_ITEM)
      .filter(row => String(row.USUL_PINDAH_ID || '') === proposalId &&
        String(row.STATUS_SNAPSHOT || 'AKTIF').toUpperCase() !== 'DIBATALKAN');
    retentionCf05AssertSnapshotComplete_(proposal, details, itemSnapshots);

    const settings = readSettings_();
    const fingerprint = retentionCf05Fingerprint_(proposal, details, itemSnapshots);
    const folder = retentionCf05OutputFolder_(proposal, settings);
    const safeNumber = cleanFileName_(proposal.NO_USUL_PINDAH || proposalId);
    const daupBaseName = safeNumber + '_Daftar-Arsip-Usul-Pindah';
    const jraFileName = safeNumber + '_Riwayat-JRA.pdf';

    const daupBook = retentionCf05BuildDaupWorkbook_(
      proposal, details, itemSnapshots, settings);
    daupSpreadsheetId = daupBook.getId();
    const daupPdfBlob = retentionCf05ExportSpreadsheet_(
      daupSpreadsheetId, 'pdf', daupBaseName + '.pdf', {portrait: false});
    const daupXlsxBlob = retentionCf05ExportSpreadsheet_(
      daupSpreadsheetId, 'xlsx', daupBaseName + '.xlsx');

    const jraBook = retentionCf05BuildJraWorkbook_(proposal, details, settings);
    jraSpreadsheetId = jraBook.getId();
    const jraPdfBlob = retentionCf05ExportSpreadsheet_(
      jraSpreadsheetId, 'pdf', jraFileName, {portrait: false});

    const pdfFile = retentionCf05CreateOrReuseFile_(
      folder, daupBaseName + '.pdf', daupPdfBlob,
      proposal.DAFTAR_PDF_FILE_ID);
    const xlsxFile = retentionCf05CreateOrReuseFile_(
      folder, daupBaseName + '.xlsx', daupXlsxBlob,
      proposal.DAFTAR_XLSX_FILE_ID);
    const jraFile = retentionCf05CreateOrReuseFile_(
      folder, jraFileName, jraPdfBlob, proposal.RIWAYAT_JRA_FILE_ID);
    const timestamp = nowIso_();
    const user = getCurrentUser_();
    updateObjectAtRow_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL,
      proposal._rowNumber, {
        DAFTAR_PDF_FILE_ID: pdfFile.getId(),
        DAFTAR_PDF_FILE_URL: pdfFile.getUrl(),
        DAFTAR_XLSX_FILE_ID: xlsxFile.getId(),
        DAFTAR_XLSX_FILE_URL: xlsxFile.getUrl(),
        RIWAYAT_JRA_FILE_ID: jraFile.getId(),
        RIWAYAT_JRA_FILE_URL: jraFile.getUrl(),
        OUTPUT_FOLDER_ID: folder.getId(),
        OUTPUT_FOLDER_URL: folder.getUrl(),
        OUTPUT_FINGERPRINT: fingerprint,
        DOKUMEN_DIBUAT_AT: timestamp,
        DOKUMEN_DIBUAT_BY: user,
        UPDATED_AT: timestamp,
        UPDATED_BY: user
      });
    audit_('GENERATE_DOCUMENTS', 'USUL_PEMINDAHAN', 'USUL_PINDAH',
      proposalId, 'Membuat paket dokumen ' + proposal.NO_USUL_PINDAH,
      details.length + ' berkas · ' + itemSnapshots.length + ' item', 'SUCCESS');
    return {
      ok: true,
      reused: false,
      pdfUrl: pdfFile.getUrl(),
      xlsxUrl: xlsxFile.getUrl(),
      jraUrl: jraFile.getUrl(),
      folderUrl: folder.getUrl(),
      fingerprint: fingerprint,
      message: proposal.NO_USUL_PINDAH +
        ' berhasil dibuat dalam PDF, XLSX, dan Riwayat JRA.'
    };
  } catch (error) {
    audit_('GENERATE_DOCUMENTS', 'USUL_PEMINDAHAN', 'USUL_PINDAH',
      proposalId || '', 'Pembuatan paket dokumen usul gagal',
      error.message, 'FAILED');
    throw error;
  } finally {
    [daupSpreadsheetId, jraSpreadsheetId].forEach(id => {
      if (!id) return;
      try { DriveApp.getFileById(id).setTrashed(true); } catch (ignore) {}
    });
    lock.releaseLock();
  }
}

function retentionCf05AssertSnapshotComplete_(proposal, details, itemSnapshots) {
  const expectedBerkas = Number(proposal.JUMLAH_BERKAS || 0);
  const expectedItems = Number(proposal.JUMLAH_ITEM_SNAPSHOT || 0);
  if (!details.length || details.length !== expectedBerkas) {
    throw new Error('Snapshot berkas tidak lengkap. Batalkan draft dan buat ulang.');
  }
  if (itemSnapshots.length !== expectedItems) {
    throw new Error(
      'Draft dibuat sebelum snapshot item CF-05 tersedia. ' +
      'Batalkan draft lalu buat ulang agar Daftar Isi Berkas dapat dibekukan.');
  }
}

function retentionCf05ExistingDocuments_(proposal) {
  const pdf = retentionCf05DriveFile_(proposal.DAFTAR_PDF_FILE_ID);
  const xlsx = retentionCf05DriveFile_(proposal.DAFTAR_XLSX_FILE_ID);
  const jra = retentionCf05DriveFile_(proposal.RIWAYAT_JRA_FILE_ID);
  return {
    complete: Boolean(pdf && xlsx && jra),
    pdfUrl: pdf ? pdf.getUrl() : '',
    xlsxUrl: xlsx ? xlsx.getUrl() : '',
    jraUrl: jra ? jra.getUrl() : '',
    folderUrl: proposal.OUTPUT_FOLDER_URL || ''
  };
}

function retentionCf05DriveFile_(fileId) {
  fileId = cleanText_(fileId, 250);
  if (!fileId) return null;
  try {
    const file = DriveApp.getFileById(fileId);
    return file.isTrashed() ? null : file;
  } catch (ignore) {
    return null;
  }
}

function retentionCf05OutputFolder_(proposal, settings) {
  const rootId = cleanText_(settings.UNIT_ROOT_FOLDER_ID ||
    settings.ARCHIVE_FOLDER_ID, 250);
  const root = DriveApp.getFolderById(requireValue_(rootId,
    'UNIT_ROOT_FOLDER_ID/ARCHIVE_FOLDER_ID pada SETTINGS'));
  const outputRoot = getOrCreateChildFolder_(
    root, RETENTION_CF05_OUTPUT_FOLDER_NAME_);
  const proposalFolderName = cleanFileName_(
    (proposal.NO_USUL_PINDAH || proposal.USUL_PINDAH_ID) + '_' +
    (proposal.JUDUL_USUL || 'Usul Pemindahan'));
  return getOrCreateChildFolder_(outputRoot, proposalFolderName);
}

function retentionCf05CreateOrReuseFile_(folder, fileName, blob, knownFileId) {
  const known = retentionCf05DriveFile_(knownFileId);
  if (known) return known;
  const matches = folder.getFilesByName(fileName);
  if (matches.hasNext()) return matches.next();
  return folder.createFile(blob.setName(fileName));
}

function retentionCf05BuildDaupWorkbook_(proposal, details, items, settings) {
  const book = SpreadsheetApp.create(
    'TEMP_' + cleanFileName_(proposal.NO_USUL_PINDAH || proposal.USUL_PINDAH_ID));
  const berkasSheet = book.getSheets()[0];
  berkasSheet.setName(RETENTION_CF05_DAUP_BERKAS_SHEET_);
  retentionCf05WriteSheet_(berkasSheet, proposal, settings,
    'DAFTAR ARSIP USUL PINDAH', 'DAFTAR BERKAS',
    retentionCf05BerkasHeaders_(), retentionCf05BerkasRows_(details),
    [45, 90, 95, 250, 90, 70, 100, 130, 100, 100, 100, 105, 110, 100, 100]);
  const itemSheet = book.insertSheet(RETENTION_CF05_DAUP_ITEM_SHEET_);
  retentionCf05WriteSheet_(itemSheet, proposal, settings,
    'DAFTAR ARSIP USUL PINDAH', 'DAFTAR ISI BERKAS',
    retentionCf05ItemHeaders_(), retentionCf05ItemRows_(items),
    [45, 80, 70, 120, 110, 250, 70, 95, 110, 110, 110, 160]);
  SpreadsheetApp.flush();
  return book;
}

function retentionCf05BuildJraWorkbook_(proposal, details, settings) {
  const book = SpreadsheetApp.create(
    'TEMP_JRA_' + cleanFileName_(proposal.NO_USUL_PINDAH || proposal.USUL_PINDAH_ID));
  const sheet = book.getSheets()[0];
  sheet.setName(RETENTION_CF05_JRA_SHEET_);
  retentionCf05WriteSheet_(sheet, proposal, settings,
    'RIWAYAT JRA YANG DIGUNAKAN', 'SNAPSHOT SAAT USUL DIBUAT',
    retentionCf05JraHeaders_(), retentionCf05JraRows_(details),
    [45, 90, 95, 230, 100, 180, 100, 90, 90, 100, 100, 105, 130]);
  SpreadsheetApp.flush();
  return book;
}

function retentionCf05WriteSheet_(sheet, proposal, settings, title, subtitle,
    headers, rows, widths) {
  const columnCount = headers.length;
  const metaRows = [
    [title],
    [subtitle],
    ['Nomor usul', proposal.NO_USUL_PINDAH || ''],
    ['Unit pengolah', proposal.UNIT_NAMA_SNAPSHOT || settings.UNIT_NAME || ''],
    ['Tanggal snapshot', retentionCf05TimestampText_(proposal.CREATED_AT)],
    ['Jumlah', Number(proposal.JUMLAH_BERKAS || 0) + ' berkas · ' +
      Number(proposal.JUMLAH_ITEM_SNAPSHOT || 0) + ' item']
  ];
  sheet.clear();
  sheet.getRange(1, 1, 1, columnCount).merge();
  sheet.getRange(1, 1).setValue(metaRows[0][0]);
  sheet.getRange(2, 1, 1, columnCount).merge();
  sheet.getRange(2, 1).setValue(metaRows[1][0]);
  for (let index = 2; index < metaRows.length; index++) {
    sheet.getRange(index + 1, 1).setValue(metaRows[index][0]);
    sheet.getRange(index + 1, 2, 1, Math.max(1, columnCount - 1)).merge();
    sheet.getRange(index + 1, 2).setValue(metaRows[index][1]);
  }
  const headerRow = 8;
  sheet.getRange(headerRow, 1, 1, columnCount).setValues([headers]);
  if (rows.length) {
    sheet.getRange(headerRow + 1, 1, rows.length, columnCount).setValues(rows);
  }
  sheet.getRange(1, 1, 1, columnCount)
    .setBackground('#143b5d').setFontColor('#ffffff')
    .setFontWeight('bold').setFontSize(15).setHorizontalAlignment('center');
  sheet.getRange(2, 1, 1, columnCount)
    .setBackground('#dceaf5').setFontColor('#143b5d')
    .setFontWeight('bold').setHorizontalAlignment('center');
  sheet.getRange(3, 1, 4, 1).setFontWeight('bold');
  sheet.getRange(headerRow, 1, 1, columnCount)
    .setBackground('#1f6fae').setFontColor('#ffffff')
    .setFontWeight('bold').setHorizontalAlignment('center')
    .setVerticalAlignment('middle').setWrap(true);
  if (rows.length) {
    sheet.getRange(headerRow + 1, 1, rows.length, columnCount)
      .setVerticalAlignment('top').setWrap(true)
      .setBorder(true, true, true, true, true, true, '#9fb3c3',
        SpreadsheetApp.BorderStyle.SOLID);
  }
  sheet.getRange(headerRow, 1, Math.max(1, rows.length + 1), columnCount)
    .setBorder(true, true, true, true, true, true, '#7890a4',
      SpreadsheetApp.BorderStyle.SOLID);
  (widths || []).forEach((width, index) =>
    sheet.setColumnWidth(index + 1, width));
  sheet.setFrozenRows(headerRow);
  sheet.setHiddenGridlines(true);
  sheet.getDataRange().setFontFamily('Arial').setFontSize(9);
  sheet.getRange(1, 1, 1, columnCount).setFontSize(15);
  sheet.setRowHeight(1, 30);
  sheet.setRowHeight(2, 24);
}

function retentionCf05BerkasHeaders_() {
  return [
    'No.', 'No. Berkas', 'Kode Klasifikasi', 'Uraian Informasi Arsip',
    'Kurun Waktu', 'Jumlah Item', 'Pencipta Arsip', 'Unit Pencipta',
    'Media Arsip', 'Lokasi Asal CF', 'Retensi Aktif', 'Retensi Inaktif',
    'Nasib Akhir', 'Keamanan Akses', 'Kategori Arsip'
  ];
}

function retentionCf05BerkasRows_(details) {
  return (details || []).slice().sort((a, b) => naturalCompare_(
    a.NO_BERKAS_DEFINITIF || '', b.NO_BERKAS_DEFINITIF || '')
  ).map((row, index) => [
    index + 1,
    row.NO_BERKAS_DEFINITIF || '',
    row.KODE_KLASIFIKASI_SNAPSHOT || '',
    row.JUDUL_BERKAS_SNAPSHOT || '',
    row.KURUN_WAKTU_SNAPSHOT || '',
    Number(row.JUMLAH_ITEM_SNAPSHOT || 0),
    row.PENCIPTA_ARSIP_SNAPSHOT || '',
    row.UNIT_PENCIPTA_SNAPSHOT || '',
    row.MEDIA_BERKAS_SNAPSHOT || '',
    row.LOKASI_ASAL_CF_SNAPSHOT || '',
    retentionDurationLabel_(row.RETENSI_AKTIF_NILAI_SNAPSHOT,
      row.RETENSI_AKTIF_SATUAN_SNAPSHOT),
    retentionDurationLabel_(row.RETENSI_INAKTIF_NILAI_SNAPSHOT,
      row.RETENSI_INAKTIF_SATUAN_SNAPSHOT),
    row.NASIB_AKHIR_SNAPSHOT || '',
    row.KLASIFIKASI_KEAMANAN_SNAPSHOT || '',
    row.KATEGORI_ARSIP_SNAPSHOT || ''
  ]);
}

function retentionCf05ItemHeaders_() {
  return [
    'No.', 'No. Berkas', 'No. Item', 'Nomor Surat', 'Tanggal Naskah',
    'Uraian Informasi Arsip', 'Jumlah Halaman', 'Tingkat Perkembangan',
    'Keamanan Akses', 'Media Sumber', 'Status Digital', 'Link Alih Media'
  ];
}

function retentionCf05ItemRows_(items) {
  return (items || []).slice().sort((a, b) =>
    naturalCompare_(a.NO_BERKAS_DEFINITIF || '', b.NO_BERKAS_DEFINITIF || '') ||
    naturalCompare_(a.NO_ITEM_DEFINITIF || '', b.NO_ITEM_DEFINITIF || '')
  ).map((row, index) => [
    index + 1,
    row.NO_BERKAS_DEFINITIF || '',
    row.NO_ITEM_DEFINITIF || '',
    row.NO_SURAT_DISPLAY_SNAPSHOT || row.NO_SURAT_UTAMA_SNAPSHOT ||
      row.NO_SURAT_ALTERNATIF_SNAPSHOT || '',
    retentionCf05DateText_(row.TANGGAL_NASKAH_SNAPSHOT),
    row.URAIAN_ITEM_SNAPSHOT || '',
    Number(row.JUMLAH_HALAMAN_SNAPSHOT || 0),
    row.TINGKAT_PERKEMBANGAN_SNAPSHOT || '',
    row.KLASIFIKASI_KEAMANAN_SNAPSHOT || '',
    row.MEDIA_SUMBER_SNAPSHOT || '',
    row.STATUS_BENTUK_DIGITAL_SNAPSHOT || '',
    row.ALIH_MEDIA_FILE_URL_SNAPSHOT || ''
  ]);
}

function retentionCf05JraHeaders_() {
  return [
    'No.', 'No. Berkas', 'Kode Klasifikasi', 'Uraian Informasi Arsip',
    'JRA ID', 'Dasar Hukum JRA', 'Versi JRA', 'Retensi Aktif',
    'Retensi Inaktif', 'Nasib Akhir', 'Tanggal Acuan', 'Batas Aktif',
    'Snapshot Oleh/Waktu'
  ];
}

function retentionCf05JraRows_(details) {
  return (details || []).slice().sort((a, b) => naturalCompare_(
    a.NO_BERKAS_DEFINITIF || '', b.NO_BERKAS_DEFINITIF || '')
  ).map((row, index) => [
    index + 1,
    row.NO_BERKAS_DEFINITIF || '',
    row.KODE_KLASIFIKASI_SNAPSHOT || '',
    row.JUDUL_BERKAS_SNAPSHOT || '',
    row.JRA_ID_SNAPSHOT || 'INPUT MANUAL',
    row.JRA_DASAR_HUKUM_SNAPSHOT || 'Nilai JRA diregistrasi manual oleh unit pengolah',
    row.JRA_VERSI_SNAPSHOT || 'Snapshot sistem',
    retentionDurationLabel_(row.RETENSI_AKTIF_NILAI_SNAPSHOT,
      row.RETENSI_AKTIF_SATUAN_SNAPSHOT),
    retentionDurationLabel_(row.RETENSI_INAKTIF_NILAI_SNAPSHOT,
      row.RETENSI_INAKTIF_SATUAN_SNAPSHOT),
    row.NASIB_AKHIR_SNAPSHOT || '',
    retentionCf05DateText_(row.TGL_ACUAN_RETENSI_SNAPSHOT),
    retentionCf05DateText_(row.BATAS_AKTIF_SNAPSHOT),
    (row.SNAPSHOT_BY || '') + ' · ' + retentionCf05TimestampText_(row.SNAPSHOT_AT)
  ]);
}

function retentionCf05DateText_(value) {
  if (!value) return '';
  try {
    const key = dateKey_(value);
    const parts = key.split('-');
    return parts.length === 3 ? parts[2] + '/' + parts[1] + '/' + parts[0] : key;
  } catch (ignore) {
    return String(value);
  }
}

function retentionCf05TimestampText_(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (isNaN(date.getTime())) return String(value);
  return Utilities.formatDate(date, APP_CONFIG.TIME_ZONE, 'dd/MM/yyyy HH:mm:ss');
}

function retentionCf05Fingerprint_(proposal, details, items) {
  const source = JSON.stringify({
    proposal: [proposal.USUL_PINDAH_ID, proposal.NO_USUL_PINDAH,
      proposal.JUDUL_USUL, proposal.CREATED_AT],
    details: retentionCf05BerkasRows_(details),
    items: retentionCf05ItemRows_(items),
    jra: retentionCf05JraRows_(details)
  });
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, source, Utilities.Charset.UTF_8);
  return bytes.map(value => (value < 0 ? value + 256 : value)
    .toString(16).padStart(2, '0')).join('');
}

function retentionCf05ExportSpreadsheet_(spreadsheetId, format, fileName, options) {
  options = options || {};
  let url = 'https://docs.google.com/spreadsheets/d/' +
    encodeURIComponent(spreadsheetId) + '/export?format=' + encodeURIComponent(format);
  if (format === 'pdf') {
    url += '&size=A4&portrait=' + (options.portrait ? 'true' : 'false') +
      '&fitw=true&sheetnames=true&printtitle=false&pagenumbers=true' +
      '&gridlines=false&fzr=true&top_margin=0.35&bottom_margin=0.35' +
      '&left_margin=0.35&right_margin=0.35';
  }
  const response = UrlFetchApp.fetch(url, {
    headers: {Authorization: 'Bearer ' + ScriptApp.getOAuthToken()},
    muteHttpExceptions: true
  });
  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('Ekspor ' + format.toUpperCase() + ' gagal (HTTP ' + code + ').');
  }
  return response.getBlob().setName(fileName);
}
