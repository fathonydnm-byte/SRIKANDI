var LOAN_BA_LOG_HEADERS_ = [
  'PRINT_ID', 'TIMESTAMP', 'USER_EMAIL', 'LOAN_GROUP_ID', 'TYPE',
  'PEMINJAMAN_IDS', 'PDF_FILE_ID', 'PDF_FILE_NAME', 'PDF_URL', 'STATUS'
];

// Satu dokumen gabungan (BA Peminjaman + BA Pengembalian dalam 1 file Google Docs)
// sejak revisi ini — sebelumnya dua dokumen terpisah. Kunci lama tetap dibaca
// untuk migrasi satu-kali (lihat getBeritaAcaraTemplateDocId_) supaya kop
// surat/tata letak yang sudah dikustomisasi admin di template PEMINJAMAN
// lama tidak hilang.
var LOAN_BA_TEMPLATE_SETTINGS_KEY_ = 'BA_TEMPLATE_COMBINED_DOC_ID';
var LOAN_BA_LEGACY_PEMINJAMAN_SETTINGS_KEY_ = 'BA_TEMPLATE_PEMINJAMAN_DOC_ID';

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

// Folder "Central File" langsung di bawah folder induk unit (sejajar dengan
// 01 ARSIP AKTIF, 90 KARANTINA APLIKASI, 99 BACKUP APLIKASI) — menampung
// dokumen KELUARAN operasional (Berita Acara, Out Indicator), terpisah dari
// folder data arsip itu sendiri. subfolderName kosong = folder Central File-nya
// sendiri.
function getCentralFileFolder_(subfolderName) {
  const settings = readSettings_();
  const root = DriveApp.getFolderById(
    requireValue_(settings.UNIT_ROOT_FOLDER_ID, 'UNIT_ROOT_FOLDER_ID pada SETTINGS'));
  const rootMatches = root.getFoldersByName('Central File');
  const centralFileFolder = rootMatches.hasNext() ? rootMatches.next() : root.createFolder('Central File');
  if (!subfolderName) return centralFileFolder;
  const matches = centralFileFolder.getFoldersByName(subfolderName);
  return matches.hasNext() ? matches.next() : centralFileFolder.createFolder(subfolderName);
}

function getBeritaAcaraFolder_() {
  return getCentralFileFolder_('Berita Acara Peminjaman Arsip');
}

function getOutIndicatorFolder_() {
  return getCentralFileFolder_('Out Indicator');
}

function moveFileToFolder_(file, folder) {
  folder.addFile(file);
  const parents = file.getParents();
  while (parents.hasNext()) {
    const parent = parents.next();
    if (parent.getId() !== folder.getId()) parent.removeFile(file);
  }
}

// Mengambil ID Google Docs master gabungan (Peminjaman + Pengembalian dalam
// satu dokumen). Dibuat sekali secara otomatis (idempotent, disimpan di
// SETTINGS) mengikuti pola folder lazy-create yang sudah dipakai di seluruh
// aplikasi. Bila template PEMINJAMAN lama (format terpisah, sebelum revisi
// ini) masih ada dan sudah dikustomisasi admin (mis. kop surat), dokumen itu
// disalin lalu ditambahkan bagian Pengembalian di halaman berikutnya —
// bukan dibangun ulang dari nol — supaya kustomisasi admin tidak hilang.
// forceRecreate=true membuat ulang template gabungan dari awal (tata letak
// standar tanpa kop surat) — dipakai bila admin ingin mulai ulang dari nol.
function getBeritaAcaraTemplateDocId_(forceRecreate) {
  const settings = readSettings_();
  const existingId = cleanText_(settings[LOAN_BA_TEMPLATE_SETTINGS_KEY_], 200);
  if (existingId && !forceRecreate) {
    try {
      const file = DriveApp.getFileById(existingId);
      if (!file.isTrashed()) return existingId;
    } catch (ignore) {}
  }
  let docId = '';
  const legacyId = cleanText_(settings[LOAN_BA_LEGACY_PEMINJAMAN_SETTINGS_KEY_], 200);
  if (legacyId && !forceRecreate) {
    try {
      docId = migrateLegacyBeritaAcaraDoc_(legacyId);
    } catch (migrateError) {
      docId = '';
    }
  }
  if (!docId) docId = buildBeritaAcaraCombinedTemplateDoc_().getId();
  moveFileToFolder_(DriveApp.getFileById(docId), getBeritaAcaraFolder_());
  upsertReliabilitySettingsBatch_([
    [LOAN_BA_TEMPLATE_SETTINGS_KEY_, docId, 'STRING',
      'ID master Google Docs Berita Acara Peminjaman + Pengembalian gabungan ' +
      '(jangan hapus manual; disalin per transaksi)']
  ]);
  return docId;
}

function migrateLegacyBeritaAcaraDoc_(legacyId) {
  const legacyFile = DriveApp.getFileById(legacyId);
  if (legacyFile.isTrashed()) throw new Error('Template lama sudah dihapus.');
  const copy = legacyFile.makeCopy('TEMPLATE BERITA ACARA PEMINJAMAN & PENGEMBALIAN ARSIP');
  const doc = DocumentApp.openById(copy.getId());
  const body = doc.getBody();
  body.appendPageBreak();
  appendBeritaAcaraSection_(body, 'PENGEMBALIAN', ' KEMBALI');
  doc.saveAndClose();
  return copy.getId();
}

function buildBeritaAcaraCombinedTemplateDoc_() {
  const doc = DocumentApp.create('TEMPLATE BERITA ACARA PEMINJAMAN & PENGEMBALIAN ARSIP');
  const body = doc.getBody();
  body.clear();
  appendBeritaAcaraSection_(body, 'PEMINJAMAN', '');
  body.appendPageBreak();
  appendBeritaAcaraSection_(body, 'PENGEMBALIAN', ' KEMBALI');
  doc.saveAndClose();
  return doc;
}

// Menulis satu bagian (Peminjaman ATAU Pengembalian) ke body dokumen yang
// sedang dibangun/diperluas. tagSuffix membedakan tag tanggal & petugas
// milik bagian Pengembalian (mis. [TANGGAL KEMBALI]) dari bagian Peminjaman
// ([TANGGAL]) supaya body.replaceText() tidak salah isi lintas bagian —
// tag identitas peminjam/pimpinan/unit kerja sengaja TANPA suffix karena
// nilainya sama di kedua bagian.
function appendBeritaAcaraSection_(body, type, tagSuffix) {
  const isPeminjaman = type === 'PEMINJAMAN';
  const officerName = '[NAMA PETUGAS CENTRAL FILE' + tagSuffix + ']';
  const officerNip = '[NIP PETUGAS CENTRAL FILE' + tagSuffix + ']';
  const officerJabatan = '[JABATAN PETUGAS CENTRAL FILE' + tagSuffix + ']';

  const heading = body.appendParagraph(
    isPeminjaman ? 'BERITA ACARA PEMINJAMAN ARSIP' : 'BERITA ACARA PENGEMBALIAN ARSIP');
  heading.setHeading(DocumentApp.ParagraphHeading.HEADING1);
  heading.setAlignment(DocumentApp.HorizontalAlignment.CENTER);

  body.appendParagraph('Pada hari ini [HARI' + tagSuffix + '] tanggal [TANGGAL' + tagSuffix +
    '] bulan [BULAN' + tagSuffix + '] tahun [TAHUN' + tagSuffix + '], kami yang bertanda tangan di bawah ini:');
  body.appendParagraph('');

  const party1 = isPeminjaman
    ? {name: officerName, nip: officerNip, jabatan: officerJabatan, role: 'PENYERAH ARSIP'}
    : {name: '[NAMA PEMINJAM]', nip: '[NIP PEMINJAM]', jabatan: '[JABATAN PEMINJAM]', role: 'PENYERAH ARSIP'};
  const party2 = isPeminjaman
    ? {name: '[NAMA PEMINJAM]', nip: '[NIP PEMINJAM]', jabatan: '[JABATAN PEMINJAM]', role: 'PEMINJAM ARSIP'}
    : {name: officerName, nip: officerNip, jabatan: officerJabatan, role: 'PENERIMA ARSIP'};

  appendBeritaAcaraPartyBlock_(body, party1, 'PIHAK PERTAMA');
  appendBeritaAcaraPartyBlock_(body, party2, 'PIHAK KEDUA');

  const bodyText = isPeminjaman
    ? 'PIHAK PERTAMA menyatakan telah menyerahkan arsip kepada PIHAK KEDUA, dan PIHAK KEDUA ' +
      'menyatakan telah menerima arsip dari PIHAK PERTAMA dengan rincian sebagai berikut:'
    : 'PIHAK KEDUA menyatakan telah menerima arsip dari PIHAK PERTAMA, dan PIHAK PERTAMA ' +
      'menyatakan telah mengembalikan arsip kepada PIHAK KEDUA dengan rincian sebagai berikut:';
  body.appendParagraph(bodyText);
  body.appendParagraph('');

  const itemsTable = body.appendTable([['No.', 'Judul Berkas/Item Arsip', 'Jumlah Halaman', 'Kondisi Arsip']]);
  applyBeritaAcaraTableRowFont_(itemsTable.getRow(0), true);
  body.appendParagraph('');

  body.appendParagraph('Demikian berita acara serah terima arsip ini dibuat oleh kedua belah pihak dan ' +
    'dibuat dua rangkap sebagai bukti otentik yang sah. Sejak penandatanganan Berita Acara ini maka ' +
    'arsip tersebut menjadi tanggung jawab PIHAK KEDUA untuk memelihara dan merawatnya dengan baik, ' +
    'serta dipergunakan untuk keperluan sebagaimana mestinya.');
  body.appendParagraph('');

  const nameTag2 = isPeminjaman ? '[NAMA PEMINJAM]' : officerName;
  const nameTag1 = isPeminjaman ? officerName : '[NAMA PEMINJAM]';
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
  body.appendParagraph('(NAMA PIMPINAN)');
  body.appendParagraph('NIP. [NIP PIMPINAN]');
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

// Mengunci tampilan tabel daftar arsip ke Arial 9 supaya baris data TIDAK
// ikut mewarisi format tebal header di atasnya (bug yang dilaporkan user) —
// dipanggil baik saat header tabel dibuat (bold) maupun saat baris data
// diisi ulang setiap kali BA dicetak (tidak bold).
function applyBeritaAcaraTableRowFont_(row, bold) {
  const cellCount = row.getNumCells();
  for (let index = 0; index < cellCount; index++) {
    row.getCell(index).editAsText().setFontFamily('Arial').setFontSize(9).setBold(Boolean(bold));
  }
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

// Setiap bagian (Peminjaman/Pengembalian) sebenarnya memuat 2 tabel: tabel
// daftar arsip DAN tabel tanda tangan (PIHAK KEDUA/PIHAK PERTAMA) — belum
// termasuk tabel dekoratif apa pun yang mungkin ditambahkan admin di kop
// surat (mis. baris logo akreditasi). Posisi murni (tables[0], tables[1], …)
// karena itu TIDAK bisa diandalkan untuk menunjuk tabel daftar arsip yang
// benar. Fungsi ini mencari tabel berdasarkan ISI header-nya (sel pertama
// baris pertama = "No.") sehingga tahan terhadap tabel lain di sekitarnya,
// lalu mengambil tabel ke sectionIndex (0 = bagian Peminjaman, 1 = bagian
// Pengembalian) di antara tabel yang cocok saja.
function findBeritaAcaraItemsTables_(body) {
  return body.getTables().filter(table => {
    if (table.getNumRows() < 1) return false;
    const headerRow = table.getRow(0);
    if (headerRow.getNumCells() < 1) return false;
    const label = cleanText_(headerRow.getCell(0).getText(), 20).toUpperCase().replace(/\.+$/, '');
    return label === 'NO';
  });
}

function fillBeritaAcaraItemsTable_(doc, sectionIndex, items, condition) {
  const body = doc.getBody();
  const tables = findBeritaAcaraItemsTables_(body);
  if (tables.length <= sectionIndex) {
    throw new Error('Tabel daftar arsip bagian ke-' + (sectionIndex + 1) + ' tidak ditemukan pada template Berita Acara ' +
      '(header kolom pertama harus tetap berbunyi "No.").');
  }
  const table = tables[sectionIndex];
  while (table.getNumRows() > 1) table.removeRow(1);
  items.forEach((item, index) => {
    const row = table.appendTableRow();
    row.appendTableCell(String(index + 1));
    row.appendTableCell(String(item.number || '–') + ' – ' + String(item.description || ''));
    row.appendTableCell(String(item.pageCount || 0));
    row.appendTableCell(condition || '–');
    applyBeritaAcaraTableRowFont_(row, false);
  });
}

// Membuat (atau membuka ulang) satu Berita Acara gabungan — bagian
// Peminjaman + bagian Pengembalian — sebagai Google Docs di folder Central
// File/Berita Acara Peminjaman Arsip, lalu menautkannya ke baris PEMINJAMAN.
// Dipanggil otomatis setelah transaksi Pinjam/Kembali tersimpan dan lewat
// tombol Cetak BA. Dokumen yang sudah ada dipakai ulang agar rapian petugas
// tidak hilang; saat pengembalian dicatat, tag & kolom kondisi bagian
// Pengembalian yang masih kosong diisikan ke dokumen yang sama. Data yang
// belum diketahui tidak ditebak: tag dibiarkan sebagai isian tangan.
function prepareLoanBeritaAcara_(loanGroupId) {
  ensureLoanSchema_();
  ensureLoanBeritaAcaraLogSchema_();
  loanGroupId = cleanText_(requireValue_(loanGroupId, 'ID transaksi peminjaman'), 80);

  const allLoans = readObjects_(APP_CONFIG.SHEETS.PEMINJAMAN);
  const records = allLoans.filter(row => loanGroupId_(row) === loanGroupId ||
    String(row.PEMINJAMAN_ID) === loanGroupId);
  if (!records.length) throw new Error('Transaksi peminjaman tidak ditemukan.');
  const first = records[0];
  const isReturned = records.some(row => String(row.STATUS || '').toUpperCase() === LOAN_RETURNED_STATUS_);

  // Satu transaksi dapat memuat beberapa berkas; bila demikian, nomor
  // objek di tabel BA menyertakan nomor berkasnya agar tidak ambigu.
  const lookups = loanGroupLookups_(records);
  const items = loanGroupDocumentLines_(records, lookups.parentById, lookups.itemById,
    lookups.berkasIds.length > 1);

  const settings = readSettings_();
  const unitName = cleanText_(settings.UNIT_NAME, 250) || 'UIN SUNAN AMPEL SURABAYA';
  const pimpinanName = cleanText_(settings.BA_PIMPINAN_NAMA, 250);
  const pimpinanNip = cleanText_(settings.BA_PIMPINAN_NIP, 100);

  const borrowDateParts = first.TANGGAL_PINJAM
    ? beritaAcaraDateParts_(loanDateKey_(first.TANGGAL_PINJAM, 'Tanggal pinjam')) : null;
  const returnDateParts = first.TANGGAL_KEMBALI
    ? beritaAcaraDateParts_(loanDateKey_(first.TANGGAL_KEMBALI, 'Tanggal kembali')) : null;

  const tags = {
    'NAMA PETUGAS CENTRAL FILE': first.PETUGAS_PINJAM_NAMA || '–',
    'NIP PETUGAS CENTRAL FILE': first.PETUGAS_PINJAM_NIP || '–',
    'JABATAN PETUGAS CENTRAL FILE': first.PETUGAS_PINJAM_JABATAN || '–',
    'NAMA PEMINJAM': first.NAMA_PEMINJAM || '–',
    'NIP PEMINJAM': first.NIP_NIK || '–',
    'JABATAN PEMINJAM': first.JABATAN_PEMINJAM || '–',
    'UNIT KERJA': unitName,
    'NAMA PIMPINAN': pimpinanName || '–',
    'NIP PIMPINAN': pimpinanNip || '–'
  };
  if (borrowDateParts) {
    tags['HARI'] = borrowDateParts.day;
    tags['TANGGAL'] = borrowDateParts.date;
    tags['BULAN'] = borrowDateParts.month;
    tags['TAHUN'] = borrowDateParts.year;
  }
  // Data petugas penerima pengembalian baru diisikan setelah arsip benar-benar
  // kembali (dokumen yang sama diperbarui), sama seperti tanggal kembali; sebelum
  // itu tag dibiarkan sebagai isian tangan.
  if (isReturned) {
    tags['NAMA PETUGAS CENTRAL FILE KEMBALI'] = first.PETUGAS_KEMBALI_NAMA || first.PETUGAS_PINJAM_NAMA || '–';
    tags['NIP PETUGAS CENTRAL FILE KEMBALI'] = first.PETUGAS_KEMBALI_NIP || first.PETUGAS_PINJAM_NIP || '–';
    tags['JABATAN PETUGAS CENTRAL FILE KEMBALI'] = first.PETUGAS_KEMBALI_JABATAN || first.PETUGAS_PINJAM_JABATAN || '–';
  }
  if (returnDateParts) {
    tags['HARI KEMBALI'] = returnDateParts.day;
    tags['TANGGAL KEMBALI'] = returnDateParts.date;
    tags['BULAN KEMBALI'] = returnDateParts.month;
    tags['TAHUN KEMBALI'] = returnDateParts.year;
  }

  // Berita Acara disimpan sebagai Google Docs (bukan PDF) agar petugas dapat
  // merapikan tata letaknya. Satu transaksi = satu dokumen: bila dokumen
  // sudah ada, dokumen itu dipakai ulang sehingga rapian petugas tidak
  // hilang; data pengembalian diisikan ke dokumen yang sama.
  const existingDoc = findBeritaAcaraDoc_(first.BA_PDF_ID);
  const timestamp = nowIso_();
  if (existingDoc) {
    const doc = DocumentApp.openById(existingDoc.getId());
    // Hanya tag yang masih tersisa yang terganti; teks yang sudah diubah
    // petugas tidak tersentuh.
    fillBeritaAcaraTags_(doc, tags);
    const updatedConditions = isReturned
      ? fillBeritaAcaraReturnCondition_(doc, first.KONDISI_KEMBALI || '') : 0;
    doc.saveAndClose();
    linkBeritaAcaraDoc_(records, existingDoc);
    audit_('UPDATE', 'PEMINJAMAN', 'BERITA_ACARA', loanGroupId,
      'Memperbarui Berita Acara (Google Docs) yang sudah ada',
      isReturned ? 'Data pengembalian diisikan; ' + updatedConditions + ' kolom kondisi diperbarui' : 'Dibuka ulang',
      'SUCCESS');
    return {
      ok: true,
      loanGroupId: loanGroupId,
      fileName: existingDoc.getName(),
      docUrl: existingDoc.getUrl(),
      pdfUrl: existingDoc.getUrl(),
      reused: true,
      printSequence: 0,
      isReprint: false,
      isReturned: isReturned,
      message: isReturned
        ? 'Data pengembalian sudah diisikan ke Berita Acara (Google Docs) yang sama.'
        : 'Berita Acara (Google Docs) dibuka. Perubahan rapian Anda tetap tersimpan di dokumen ini.'
    };
  }

  const templateDocId = getBeritaAcaraTemplateDocId_(false);
  const previousPrints = readObjects_(APP_CONFIG.SHEETS.LOAN_BA_LOG)
    .filter(row => String(row.LOAN_GROUP_ID) === loanGroupId);
  const printSequence = previousPrints.length + 1;
  const fileName = ('BA_Peminjaman_Pengembalian_' + loanGroupId +
    (printSequence > 1 ? '_Cetak_Ulang_' + printSequence : '')).replace(/[^A-Za-z0-9._-]+/g, '_');
  const folder = getBeritaAcaraFolder_();
  const docFile = DriveApp.getFileById(templateDocId).makeCopy(fileName, folder);
  try {
    const doc = DocumentApp.openById(docFile.getId());
    fillBeritaAcaraTags_(doc, tags);
    fillBeritaAcaraItemsTable_(doc, 0, items, first.KONDISI_PINJAM || '');
    fillBeritaAcaraItemsTable_(doc, 1, items, first.KONDISI_KEMBALI || '');
    doc.saveAndClose();
  } catch (error) {
    // Jangan tinggalkan salinan setengah terisi bila pengisian gagal.
    try { docFile.setTrashed(true); } catch (cleanupError) {}
    throw error;
  }

  appendObject_(APP_CONFIG.SHEETS.LOAN_BA_LOG, {
    PRINT_ID: 'BA-' + Utilities.getUuid(),
    TIMESTAMP: timestamp,
    USER_EMAIL: getCurrentUser_(),
    LOAN_GROUP_ID: loanGroupId,
    TYPE: 'GABUNGAN_DOCS',
    PEMINJAMAN_IDS: records.map(row => row.PEMINJAMAN_ID).join(', '),
    PDF_FILE_ID: docFile.getId(),
    PDF_FILE_NAME: docFile.getName(),
    PDF_URL: docFile.getUrl(),
    STATUS: 'DOCS_DIBUAT'
  });
  linkBeritaAcaraDoc_(records, docFile);
  audit_('GENERATE_DOC', 'PEMINJAMAN', 'BERITA_ACARA', loanGroupId,
    'Membuat Berita Acara Peminjaman & Pengembalian arsip (Google Docs)',
    'Dokumen ke-' + printSequence, 'SUCCESS');

  return {
    ok: true,
    loanGroupId: loanGroupId,
    fileName: docFile.getName(),
    docUrl: docFile.getUrl(),
    pdfUrl: docFile.getUrl(),
    reused: false,
    printSequence: printSequence,
    isReprint: printSequence > 1,
    isReturned: isReturned,
    message: (isReturned
      ? 'Berita Acara Peminjaman & Pengembalian (Google Docs) berhasil dibuat'
      : 'Berita Acara Peminjaman (Google Docs) berhasil dibuat; bagian Pengembalian terisi otomatis saat arsip dikembalikan') +
      '. Rapikan dan cetak langsung dari Google Docs.'
  };
}

// Dokumen BA yang tercatat pada transaksi, bila masih ada dan berupa Google
// Docs. PDF lama (sebelum rilis Docs) atau file yang sudah dihapus diabaikan
// sehingga dibuatkan dokumen baru.
function findBeritaAcaraDoc_(fileId) {
  fileId = cleanText_(fileId, 200);
  if (!fileId) return null;
  try {
    const file = DriveApp.getFileById(fileId);
    if (file.isTrashed()) return null;
    if (String(file.getMimeType()) !== 'application/vnd.google-apps.document') return null;
    return file;
  } catch (error) {
    return null;
  }
}

function linkBeritaAcaraDoc_(records, file) {
  const changes = {BA_PDF_ID: file.getId(), BA_PDF_URL: file.getUrl()};
  const updates = records
    .filter(row => row.BA_PDF_ID !== changes.BA_PDF_ID || row.BA_PDF_URL !== changes.BA_PDF_URL)
    .map(row => ({rowNumber: row._rowNumber, changes: changes}));
  if (updates.length) updateObjectsAtRows_(APP_CONFIG.SHEETS.PEMINJAMAN, updates);
}

// Mengisi kolom "Kondisi Arsip" tabel bagian Pengembalian pada dokumen yang
// sudah ada. Hanya sel yang masih kosong/"–" yang diisi agar isian manual
// petugas tidak tertimpa.
function fillBeritaAcaraReturnCondition_(doc, condition) {
  if (!condition) return 0;
  const tables = findBeritaAcaraItemsTables_(doc.getBody());
  if (tables.length < 2) return 0;
  const table = tables[1];
  let updated = 0;
  for (let index = 1; index < table.getNumRows(); index++) {
    const row = table.getRow(index);
    if (row.getNumCells() < 4) continue;
    const cell = row.getCell(3);
    const text = cleanText_(cell.getText(), 50);
    if (text && text !== '–' && text !== '-') continue;
    cell.editAsText().setText(condition);
    cell.editAsText().setFontFamily('Arial').setFontSize(9).setBold(false);
    updated++;
  }
  return updated;
}

// Menyimpan salinan Out Indicator (dibuat client-side di OutIndicatorPrint.html)
// ke folder Central File/Out Indicator, dipanggil setelah PDF-nya berhasil
// dibuat & diunduh di browser — supaya ada jejak digital tersimpan di Drive,
// bukan hanya file yang diunduh ke komputer petugas.
function saveOutIndicatorPdf_(loanGroupId, base64Data, fileName) {
  loanGroupId = cleanText_(requireValue_(loanGroupId, 'ID transaksi peminjaman'), 80);
  const data = String(requireValue_(base64Data, 'Data PDF Out Indicator'));
  const cleanName = cleanFileName_(cleanText_(fileName, 200) || ('Out_Indicator_' + loanGroupId)) + '.pdf';
  const bytes = Utilities.base64Decode(data);
  const blob = Utilities.newBlob(bytes, 'application/pdf', cleanName);
  const file = getOutIndicatorFolder_().createFile(blob);
  return {ok: true, id: file.getId(), url: file.getUrl(), fileName: file.getName()};
}
