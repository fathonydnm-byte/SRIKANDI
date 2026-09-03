var LOAN_BA_LOG_HEADERS_ = [
  'PRINT_ID', 'TIMESTAMP', 'USER_EMAIL', 'LOAN_GROUP_ID', 'TYPE',
  'PEMINJAMAN_IDS', 'PDF_FILE_ID', 'PDF_FILE_NAME', 'PDF_URL', 'STATUS'
];

var LOAN_BA_TEMPLATE_SETTINGS_KEY_ = {
  PEMINJAMAN: 'BA_TEMPLATE_PEMINJAMAN_DOC_ID',
  PENGEMBALIAN: 'BA_TEMPLATE_PENGEMBALIAN_DOC_ID'
};

var LOAN_BA_DAY_NAMES_ = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
var LOAN_BA_MONTH_NAMES_ = [
  'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
  'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
];

function ensureLoanBeritaAcaraLogSchema_() {
  const spreadsheet = getSpreadsheet_();
  let sheet = spreadsheet.getSheetByName(APP_CONFIG.SHEETS.LOAN_BA_LOG);
  if (!sheet) sheet = spreadsheet.insertSheet(APP_CONFIG.SHEETS.LOAN_BA_LOG);
  const existing = sheet.getLastColumn() > 0
    ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0] : [];
  const missing = LOAN_BA_LOG_HEADERS_.filter(header => existing.indexOf(header) === -1);
  if (missing.length) {
    sheet.getRange(1, existing.filter(Boolean).length + 1, 1, missing.length).setValues([missing]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, LOAN_BA_LOG_HEADERS_.length)
      .setFontWeight('bold').setBackground('#143b5d').setFontColor('#ffffff');
    headerCache_ = {};
  }
  return sheet;
}

// Folder khusus untuk template master (1 dokumen per jenis) dan hasil PDF Berita Acara,
// terpisah dari BUKTI PEMINJAMAN (yang menyimpan bukti persetujuan pinjam, bukan BA).
function getBeritaAcaraFolder_() {
  const settings = readSettings_();
  const root = DriveApp.getFolderById(requireValue_(settings.ARCHIVE_FOLDER_ID, 'ARCHIVE_FOLDER_ID pada SETTINGS'));
  const matches = root.getFoldersByName('BERITA ACARA PEMINJAMAN');
  return matches.hasNext() ? matches.next() : root.createFolder('BERITA ACARA PEMINJAMAN');
}

function moveFileToFolder_(file, folder) {
  folder.addFile(file);
  const parents = file.getParents();
  while (parents.hasNext()) {
    const parent = parents.next();
    if (parent.getId() !== folder.getId()) parent.removeFile(file);
  }
}

// Mengambil ID Google Docs master untuk jenis Berita Acara ('PEMINJAMAN'/'PENGEMBALIAN').
// Dibuat sekali secara otomatis (idempotent, disimpan di SETTINGS) mengikuti pola folder
// lazy-create yang sudah dipakai di seluruh aplikasi (mis. getLoanEvidenceFolder_,
// getDeletionEvidenceFolder_). forceRecreate=true membuat ulang template dari awal —
// dipakai bila admin ingin menata ulang tata letak master secara manual lalu memuat ulang.
function getBeritaAcaraTemplateDocId_(type, forceRecreate) {
  const settingsKey = LOAN_BA_TEMPLATE_SETTINGS_KEY_[type];
  if (!settingsKey) throw new Error('Jenis Berita Acara tidak dikenal: ' + type);
  const settings = readSettings_();
  const existingId = cleanText_(settings[settingsKey], 200);
  if (existingId && !forceRecreate) {
    try {
      const file = DriveApp.getFileById(existingId);
      if (!file.isTrashed()) return existingId;
    } catch (ignore) {}
  }
  const doc = buildBeritaAcaraTemplateDoc_(type);
  moveFileToFolder_(DriveApp.getFileById(doc.getId()), getBeritaAcaraFolder_());
  upsertReliabilitySettingsBatch_([
    [settingsKey, doc.getId(), 'STRING',
      'ID master Google Docs Berita Acara ' + type + ' (jangan hapus manual; disalin per transaksi)']
  ]);
  return doc.getId();
}

function buildBeritaAcaraTemplateDoc_(type) {
  const isPeminjaman = type === 'PEMINJAMAN';
  const title = isPeminjaman ? 'TEMPLATE BERITA ACARA PEMINJAMAN ARSIP' : 'TEMPLATE BERITA ACARA PENGEMBALIAN ARSIP';
  const doc = DocumentApp.create(title);
  const body = doc.getBody();
  body.clear();

  const heading = body.appendParagraph(isPeminjaman ? 'BERITA ACARA PEMINJAMAN ARSIP' : 'BERITA ACARA PENGEMBALIAN ARSIP');
  heading.setHeading(DocumentApp.ParagraphHeading.HEADING1);
  heading.setAlignment(DocumentApp.HorizontalAlignment.CENTER);

  body.appendParagraph('Pada hari ini [HARI] tanggal [TANGGAL] bulan [BULAN] tahun [TAHUN], ' +
    'kami yang bertanda tangan di bawah ini:');
  body.appendParagraph('');

  const party1 = isPeminjaman
    ? {name: '[NAMA PETUGAS CENTRAL FILE]', nip: '[NIP PETUGAS CENTRAL FILE]',
        jabatan: '[JABATAN PETUGAS CENTRAL FILE]', role: 'PENYERAH ARSIP'}
    : {name: '[NAMA PEMINJAM]', nip: '[NIP PEMINJAM]',
        jabatan: '[JABATAN PEMINJAM]', role: 'PENYERAH ARSIP'};
  const party2 = isPeminjaman
    ? {name: '[NAMA PEMINJAM]', nip: '[NIP PEMINJAM]',
        jabatan: '[JABATAN PEMINJAM]', role: 'PEMINJAM ARSIP'}
    : {name: '[NAMA PETUGAS CENTRAL FILE]', nip: '[NIP PETUGAS CENTRAL FILE]',
        jabatan: '[JABATAN PETUGAS CENTRAL FILE]', role: 'PENERIMA ARSIP'};

  appendBeritaAcaraPartyBlock_(body, party1, 'PIHAK PERTAMA');
  appendBeritaAcaraPartyBlock_(body, party2, 'PIHAK KEDUA');

  const bodyText = isPeminjaman
    ? 'PIHAK PERTAMA menyatakan telah menyerahkan arsip kepada PIHAK KEDUA, dan PIHAK KEDUA ' +
      'menyatakan telah menerima arsip dari PIHAK PERTAMA dengan rincian sebagai berikut:'
    : 'PIHAK KEDUA menyatakan telah menerima arsip dari PIHAK PERTAMA, dan PIHAK PERTAMA ' +
      'menyatakan telah mengembalikan arsip kepada PIHAK KEDUA dengan rincian sebagai berikut:';
  body.appendParagraph(bodyText);
  body.appendParagraph('');

  const conditionHeader = isPeminjaman ? 'Kondisi Pinjam' : 'Kondisi Kembali';
  const itemsTable = body.appendTable([['No.', 'Judul Berkas/Item Arsip', 'Jumlah Halaman', conditionHeader]]);
  for (let column = 0; column < 4; column++) {
    itemsTable.getCell(0, column).editAsText().setBold(true);
  }
  body.appendParagraph('');

  body.appendParagraph('Demikian berita acara serah terima arsip ini dibuat oleh kedua belah pihak dan ' +
    'dibuat dua rangkap sebagai bukti otentik yang sah. Sejak penandatanganan Berita Acara ini maka ' +
    'arsip tersebut menjadi tanggung jawab PIHAK KEDUA untuk memelihara dan merawatnya dengan baik, ' +
    'serta dipergunakan untuk keperluan sebagaimana mestinya.');
  body.appendParagraph('');

  const nameTag2 = isPeminjaman ? '[NAMA PEMINJAM]' : '[NAMA PETUGAS CENTRAL FILE]';
  const nameTag1 = isPeminjaman ? '[NAMA PETUGAS CENTRAL FILE]' : '[NAMA PEMINJAM]';
  const sigTable = body.appendTable([
    ['PIHAK KEDUA', 'PIHAK PERTAMA'],
    ['', ''],
    ['', ''],
    ['', ''],
    ['(' + nameTag2 + ')', '(' + nameTag1 + ')']
  ]);
  sigTable.setBorderWidth(0);
  for (let column = 0; column < 2; column++) {
    sigTable.getCell(0, column).editAsText().setBold(true);
  }
  body.appendParagraph('');

  body.appendParagraph(isPeminjaman ? 'Menyetujui,' : 'Mengetahui,');
  const pimpinanHeading = body.appendParagraph('PIMPINAN [UNIT KERJA]');
  pimpinanHeading.editAsText().setBold(true);
  body.appendParagraph('');
  body.appendParagraph('');
  body.appendParagraph('');
  body.appendParagraph('(NAMA PIMPINAN)').editAsText().setBold(false);
  body.appendParagraph('NIP. [NIP PIMPINAN]');

  doc.saveAndClose();
  return doc;
}

function appendBeritaAcaraPartyBlock_(body, party, roleLabel) {
  body.appendParagraph('Nama : ' + party.name);
  body.appendParagraph('NIP : ' + party.nip);
  body.appendParagraph('Jabatan : ' + party.jabatan);
  const role = body.appendParagraph('Peran : ' + party.role);
  role.editAsText().setBold(true);
  body.appendParagraph('Selanjutnya disebut ' + roleLabel + '.');
  body.appendParagraph('');
}

function beritaAcaraDateParts_(dateKeyValue) {
  const date = parseLocalDate_(dateKeyValue, 'Tanggal Berita Acara');
  return {
    day: LOAN_BA_DAY_NAMES_[date.getDay()],
    date: String(date.getDate()),
    month: LOAN_BA_MONTH_NAMES_[date.getMonth()],
    year: String(date.getFullYear())
  };
}

function beritaAcaraEscapeRegex_(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fillBeritaAcaraTags_(doc, tags) {
  const body = doc.getBody();
  Object.keys(tags).forEach(key => {
    const pattern = '\\[' + beritaAcaraEscapeRegex_(key) + '\\]';
    const value = String(tags[key] === undefined || tags[key] === null ? '' : tags[key])
      .replace(/\$/g, '$$$$');
    body.replaceText(pattern, value);
  });
}

function fillBeritaAcaraItemsTable_(doc, items, condition) {
  const body = doc.getBody();
  const tables = body.getTables();
  if (!tables.length) throw new Error('Tabel daftar arsip tidak ditemukan pada template Berita Acara.');
  const table = tables[0];
  while (table.getNumRows() > 1) table.removeRow(1);
  items.forEach((item, index) => {
    const row = table.appendTableRow();
    row.appendTableCell(String(index + 1));
    row.appendTableCell(String(item.number || '–') + ' – ' + String(item.description || ''));
    row.appendTableCell(String(item.pageCount || 0));
    row.appendTableCell(condition || '–');
  });
}

// Menghasilkan PDF Berita Acara Peminjaman/Pengembalian untuk satu transaksi (loanGroupId)
// dari template master, menyimpannya di Drive, mencatat log cetak (dengan nomor cetak ulang),
// dan menautkan URL PDF tsb kembali ke baris PEMINJAMAN terkait. Dipanggil otomatis oleh klien
// setelah transaksi Pinjam/Kembali tersimpan, dan juga dapat dipanggil ulang kapan saja
// (tombol Cetak Ulang) — setiap pemanggilan membuat PDF baru dan menaikkan nomor cetakan.
function prepareLoanBeritaAcara_(loanGroupId, type) {
  ensureLoanSchema_();
  ensureLoanBeritaAcaraLogSchema_();
  type = String(type || '').toUpperCase();
  if (['PEMINJAMAN', 'PENGEMBALIAN'].indexOf(type) === -1) throw new Error('Jenis Berita Acara tidak dikenal.');
  loanGroupId = cleanText_(requireValue_(loanGroupId, 'ID transaksi peminjaman'), 80);

  const allLoans = readObjects_(APP_CONFIG.SHEETS.PEMINJAMAN);
  const records = allLoans.filter(row => loanGroupId_(row) === loanGroupId ||
    String(row.PEMINJAMAN_ID) === loanGroupId);
  if (!records.length) throw new Error('Transaksi peminjaman tidak ditemukan.');
  const first = records[0];
  if (type === 'PENGEMBALIAN' &&
      !records.some(row => String(row.STATUS || '').toUpperCase() === LOAN_RETURNED_STATUS_)) {
    throw new Error('Transaksi ini belum dikembalikan. Berita Acara Pengembalian belum dapat dibuat.');
  }

  const berkasId = loanBerkasId_(first);
  const parent = readObjects_(APP_CONFIG.SHEETS.BERKAS)
    .find(row => String(row.BERKAS_ID) === berkasId) || {};
  const itemById = {};
  readObjects_(APP_CONFIG.SHEETS.ITEM)
    .filter(row => String(row.BERKAS_ID) === berkasId)
    .forEach(row => itemById[String(row.ITEM_ID)] = row);
  const objectType = loanObjectType_(first);
  const condition = (type === 'PEMINJAMAN' ? first.KONDISI_PINJAM : first.KONDISI_KEMBALI) || 'BAIK';
  const items = objectType === 'BERKAS'
    ? [{
        number: 'SELURUH BERKAS',
        description: first.URAIAN_OBJEK_SNAPSHOT || parent.JUDUL_BERKAS || 'Berkas arsip',
        pageCount: Number(first.JUMLAH_HALAMAN_GRUP_SNAPSHOT || first.JUMLAH_HALAMAN_ITEM || 0)
      }]
    : records.map(row => {
        const currentItem = itemById[loanItemId_(row)] || {};
        return {
          number: row.NO_ITEM_SNAPSHOT || currentItem.NO_ITEM_DEFINITIF || '–',
          description: row.URAIAN_OBJEK_SNAPSHOT || currentItem.URAIAN_LENGKAP || 'Item arsip',
          pageCount: Number(row.JUMLAH_HALAMAN_ITEM || currentItem.JUMLAH_HALAMAN || 0)
        };
      }).sort((a, b) => naturalCompare_(a.number, b.number));

  const settings = readSettings_();
  const unitName = cleanText_(settings.UNIT_NAME, 250) || 'UIN SUNAN AMPEL SURABAYA';
  const eventDateSource = type === 'PEMINJAMAN'
    ? (first.TANGGAL_PINJAM || loanTodayKey_())
    : (first.TANGGAL_KEMBALI || loanTodayKey_());
  const eventDate = loanDateKey_(eventDateSource, 'Tanggal Berita Acara');
  const dateParts = beritaAcaraDateParts_(eventDate);

  const officerName = type === 'PEMINJAMAN' ? first.PETUGAS_PINJAM_NAMA : first.PETUGAS_KEMBALI_NAMA;
  const officerNip = type === 'PEMINJAMAN' ? first.PETUGAS_PINJAM_NIP : first.PETUGAS_KEMBALI_NIP;
  const officerJabatan = type === 'PEMINJAMAN' ? first.PETUGAS_PINJAM_JABATAN : first.PETUGAS_KEMBALI_JABATAN;
  const pimpinanName = cleanText_(settings.BA_PIMPINAN_NAMA, 250);
  const pimpinanNip = cleanText_(settings.BA_PIMPINAN_NIP, 100);

  const tags = {
    'HARI': dateParts.day,
    'TANGGAL': dateParts.date,
    'BULAN': dateParts.month,
    'TAHUN': dateParts.year,
    'NAMA PETUGAS CENTRAL FILE': officerName || '–',
    'NIP PETUGAS CENTRAL FILE': officerNip || '–',
    'JABATAN PETUGAS CENTRAL FILE': officerJabatan || '–',
    'NAMA PEMINJAM': first.NAMA_PEMINJAM || '–',
    'NIP PEMINJAM': first.NIP_NIK || '–',
    'JABATAN PEMINJAM': first.JABATAN_PEMINJAM || '–',
    'UNIT KERJA': unitName,
    'NAMA PIMPINAN': pimpinanName || '–',
    'NIP PIMPINAN': pimpinanNip || '–'
  };

  const templateDocId = getBeritaAcaraTemplateDocId_(type, false);
  const previousPrints = readObjects_(APP_CONFIG.SHEETS.LOAN_BA_LOG)
    .filter(row => String(row.LOAN_GROUP_ID) === loanGroupId && String(row.TYPE) === type);
  const printSequence = previousPrints.length + 1;
  const fileNameBase = ('BA_' + (type === 'PEMINJAMAN' ? 'Peminjaman' : 'Pengembalian') + '_' + loanGroupId +
    (printSequence > 1 ? '_Cetak_Ulang_' + printSequence : '')).replace(/[^A-Za-z0-9._-]+/g, '_');
  const folder = getBeritaAcaraFolder_();

  const copy = DriveApp.getFileById(templateDocId).makeCopy(fileNameBase, folder);
  let pdfBlob;
  try {
    const copyDoc = DocumentApp.openById(copy.getId());
    fillBeritaAcaraTags_(copyDoc, tags);
    fillBeritaAcaraItemsTable_(copyDoc, items, condition);
    copyDoc.saveAndClose();
    pdfBlob = DriveApp.getFileById(copy.getId()).getAs('application/pdf');
  } finally {
    try { copy.setTrashed(true); } catch (cleanupError) {}
  }
  const pdfFile = folder.createFile(pdfBlob).setName(fileNameBase + '.pdf');

  const timestamp = nowIso_();
  appendObject_(APP_CONFIG.SHEETS.LOAN_BA_LOG, {
    PRINT_ID: 'BA-' + Utilities.getUuid(),
    TIMESTAMP: timestamp,
    USER_EMAIL: getCurrentUser_(),
    LOAN_GROUP_ID: loanGroupId,
    TYPE: type,
    PEMINJAMAN_IDS: records.map(row => row.PEMINJAMAN_ID).join(', '),
    PDF_FILE_ID: pdfFile.getId(),
    PDF_FILE_NAME: pdfFile.getName(),
    PDF_URL: pdfFile.getUrl(),
    STATUS: 'PDF_DIBUAT'
  });

  updateObjectsAtRows_(APP_CONFIG.SHEETS.PEMINJAMAN, records.map(row => ({
    rowNumber: row._rowNumber,
    changes: type === 'PEMINJAMAN'
      ? {BA_PEMINJAMAN_PDF_ID: pdfFile.getId(), BA_PEMINJAMAN_PDF_URL: pdfFile.getUrl()}
      : {BA_PENGEMBALIAN_PDF_ID: pdfFile.getId(), BA_PENGEMBALIAN_PDF_URL: pdfFile.getUrl()}
  })));

  audit_('GENERATE_PDF', 'PEMINJAMAN', 'BERITA_ACARA_' + type, loanGroupId,
    'Membuat Berita Acara ' + (type === 'PEMINJAMAN' ? 'Peminjaman' : 'Pengembalian') + ' arsip',
    'Cetakan ke-' + printSequence, 'SUCCESS');

  return {
    ok: true,
    loanGroupId: loanGroupId,
    type: type,
    fileName: pdfFile.getName(),
    pdfUrl: pdfFile.getUrl(),
    printSequence: printSequence,
    isReprint: printSequence > 1,
    message: 'Berita Acara ' + (type === 'PEMINJAMAN' ? 'Peminjaman' : 'Pengembalian') +
      ' berhasil dibuat' + (printSequence > 1 ? ' (cetak ulang ke-' + printSequence + ')' : '') + '.'
  };
}
