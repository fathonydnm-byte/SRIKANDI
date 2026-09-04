var LOAN_BA_LOG_HEADERS_ = [
  'PRINT_ID', 'TIMESTAMP', 'USER_EMAIL', 'LOAN_GROUP_ID', 'TYPE',
  'PEMINJAMAN_IDS', 'PDF_FILE_ID', 'PDF_FILE_NAME', 'PDF_URL', 'STATUS'
];

// Satu dokumen gabungan (BA Peminjaman + BA Pengembalian dalam 1 file, 1 PDF)
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

// tableIndex: 0 = tabel daftar arsip pada bagian BERITA ACARA PEMINJAMAN,
// 1 = tabel pada bagian BERITA ACARA PENGEMBALIAN (urutan tabel dalam
// dokumen mengikuti urutan bagian yang ditulis appendBeritaAcaraSection_).
function fillBeritaAcaraItemsTable_(doc, tableIndex, items, condition) {
  const body = doc.getBody();
  const tables = body.getTables();
  if (tables.length <= tableIndex) {
    throw new Error('Tabel daftar arsip bagian ke-' + (tableIndex + 1) + ' tidak ditemukan pada template Berita Acara.');
  }
  const table = tables[tableIndex];
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

// Menghasilkan satu PDF gabungan (bagian Peminjaman + bagian Pengembalian
// dalam satu dokumen/file) untuk satu transaksi (loanGroupId) dari template
// master, menyimpannya di Drive, mencatat log cetak (dengan nomor cetak
// ulang), dan menautkan URL PDF tsb kembali ke baris PEMINJAMAN terkait.
// Dipanggil otomatis oleh klien setelah transaksi Pinjam/Kembali tersimpan,
// dan juga dapat dipanggil ulang kapan saja (tombol Cetak) — setiap
// pemanggilan membuat PDF baru dan menaikkan nomor cetakan. Field bagian
// Pengembalian yang secara jujur belum diketahui (belum dikembalikan) TIDAK
// ditebak/dipalsukan: tag tanggal & kolom kondisi tetap kosong/apa adanya,
// siap diisi tangan; petugas memakai data petugas peminjaman sebagai isian
// awal yang wajar sampai ada data petugas pengembalian sungguhan.
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

  const berkasId = loanBerkasId_(first);
  const parent = readObjects_(APP_CONFIG.SHEETS.BERKAS)
    .find(row => String(row.BERKAS_ID) === berkasId) || {};
  const itemById = {};
  readObjects_(APP_CONFIG.SHEETS.ITEM)
    .filter(row => String(row.BERKAS_ID) === berkasId)
    .forEach(row => itemById[String(row.ITEM_ID)] = row);
  const objectType = loanObjectType_(first);
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
  const pimpinanName = cleanText_(settings.BA_PIMPINAN_NAMA, 250);
  const pimpinanNip = cleanText_(settings.BA_PIMPINAN_NIP, 100);

  const borrowDateParts = first.TANGGAL_PINJAM
    ? beritaAcaraDateParts_(loanDateKey_(first.TANGGAL_PINJAM, 'Tanggal pinjam')) : null;
  const returnDateParts = first.TANGGAL_KEMBALI
    ? beritaAcaraDateParts_(loanDateKey_(first.TANGGAL_KEMBALI, 'Tanggal kembali')) : null;

  // Petugas pengembalian belum tentu tercatat saat BA ini pertama dicetak
  // (dibuat sepasang dengan BA Peminjaman, sebelum arsip benar-benar
  // kembali) — pakai petugas peminjaman sebagai isian awal yang wajar,
  // digantikan data petugas pengembalian sungguhan begitu tersedia.
  const returnOfficerName = first.PETUGAS_KEMBALI_NAMA || first.PETUGAS_PINJAM_NAMA;
  const returnOfficerNip = first.PETUGAS_KEMBALI_NIP || first.PETUGAS_PINJAM_NIP;
  const returnOfficerJabatan = first.PETUGAS_KEMBALI_JABATAN || first.PETUGAS_PINJAM_JABATAN;

  const tags = {
    'NAMA PETUGAS CENTRAL FILE': first.PETUGAS_PINJAM_NAMA || '–',
    'NIP PETUGAS CENTRAL FILE': first.PETUGAS_PINJAM_NIP || '–',
    'JABATAN PETUGAS CENTRAL FILE': first.PETUGAS_PINJAM_JABATAN || '–',
    'NAMA PETUGAS CENTRAL FILE KEMBALI': returnOfficerName || '–',
    'NIP PETUGAS CENTRAL FILE KEMBALI': returnOfficerNip || '–',
    'JABATAN PETUGAS CENTRAL FILE KEMBALI': returnOfficerJabatan || '–',
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
  if (returnDateParts) {
    tags['HARI KEMBALI'] = returnDateParts.day;
    tags['TANGGAL KEMBALI'] = returnDateParts.date;
    tags['BULAN KEMBALI'] = returnDateParts.month;
    tags['TAHUN KEMBALI'] = returnDateParts.year;
  }

  const templateDocId = getBeritaAcaraTemplateDocId_(false);
  const previousPrints = readObjects_(APP_CONFIG.SHEETS.LOAN_BA_LOG)
    .filter(row => String(row.LOAN_GROUP_ID) === loanGroupId);
  const printSequence = previousPrints.length + 1;
  const fileNameBase = ('BA_Peminjaman_Pengembalian_' + loanGroupId +
    (printSequence > 1 ? '_Cetak_Ulang_' + printSequence : '')).replace(/[^A-Za-z0-9._-]+/g, '_');
  const folder = getBeritaAcaraFolder_();

  const copy = DriveApp.getFileById(templateDocId).makeCopy(fileNameBase, folder);
  let pdfBlob;
  try {
    const copyDoc = DocumentApp.openById(copy.getId());
    fillBeritaAcaraTags_(copyDoc, tags);
    fillBeritaAcaraItemsTable_(copyDoc, 0, items, first.KONDISI_PINJAM || '');
    fillBeritaAcaraItemsTable_(copyDoc, 1, items, first.KONDISI_KEMBALI || '');
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
    TYPE: 'GABUNGAN',
    PEMINJAMAN_IDS: records.map(row => row.PEMINJAMAN_ID).join(', '),
    PDF_FILE_ID: pdfFile.getId(),
    PDF_FILE_NAME: pdfFile.getName(),
    PDF_URL: pdfFile.getUrl(),
    STATUS: 'PDF_DIBUAT'
  });

  updateObjectsAtRows_(APP_CONFIG.SHEETS.PEMINJAMAN, records.map(row => ({
    rowNumber: row._rowNumber,
    changes: {BA_PDF_ID: pdfFile.getId(), BA_PDF_URL: pdfFile.getUrl()}
  })));

  audit_('GENERATE_PDF', 'PEMINJAMAN', 'BERITA_ACARA', loanGroupId,
    'Membuat Berita Acara Peminjaman & Pengembalian arsip (satu dokumen)',
    'Cetakan ke-' + printSequence, 'SUCCESS');

  return {
    ok: true,
    loanGroupId: loanGroupId,
    fileName: pdfFile.getName(),
    pdfUrl: pdfFile.getUrl(),
    printSequence: printSequence,
    isReprint: printSequence > 1,
    isReturned: isReturned,
    message: (isReturned
      ? 'Berita Acara Peminjaman & Pengembalian berhasil dibuat'
      : 'Berita Acara Peminjaman berhasil dibuat (bagian Pengembalian masih formulir kosong)') +
      (printSequence > 1 ? ' (cetak ulang ke-' + printSequence + ')' : '') + '.'
  };
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
