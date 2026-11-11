// node --test tests/multi-berkas-loan.test.cjs
// Peminjaman beberapa berkas/item dalam satu transaksi. Memakai fungsi source
// sebenarnya (LoanService.js, BeritaAcaraService.js); layanan Google disimulasikan di memori.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const TODAY = '2026-11-11';

function fixture() {
  const ctx = vm.createContext({});
  for (const file of ['Config.js', 'Services.js', 'NumberingService.js', 'ItemService.js',
    'RetentionService.js', 'LoanService.js', 'BeritaAcaraService.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../central-file', file), 'utf8'), ctx);
  }
  const berkas = (id, number, title, cabinet) => ({
    BERKAS_ID: id, NO_BERKAS_DEFINITIF: number, JUDUL_BERKAS: title,
    KODE_KLASIFIKASI_SNAPSHOT: 'HK.00.0' + number, NO_FILLING_KABINET: cabinet, NO_LACI: 'A1',
    STATUS_PEMINJAMAN: 'TERSEDIA', IS_DELETED: false
  });
  const item = (id, berkasId, number, pages) => ({
    ITEM_ID: id, BERKAS_ID: berkasId, NO_ITEM_DEFINITIF: number, NO_BERKAS_SNAPSHOT: berkasId.slice(-1),
    URAIAN_LENGKAP: 'Uraian ' + id, JUMLAH_HALAMAN: pages, TANGGAL_NASKAH: '2026-01-0' + number,
    STATUS_PEMINJAMAN: 'TERSEDIA', IS_DELETED: false
  });
  const tables = {
    DB_BERKAS: [berkas('BRK-1', '1', 'Berkas Satu', '1'), berkas('BRK-2', '2', 'Berkas Dua', '2'),
      berkas('BRK-3', '3', 'Berkas Tiga', '3')],
    DB_ITEM: [item('ITM-1A', 'BRK-1', '1', 3), item('ITM-1B', 'BRK-1', '2', 4),
      item('ITM-2A', 'BRK-2', '1', 5), item('ITM-2B', 'BRK-2', '2', 6),
      item('ITM-3A', 'BRK-3', '1', 7)],
    PEMINJAMAN: [], AUDIT_LOG: [], LOG_CETAK_OUT_INDICATOR: [], LOG_CETAK_BERITA_ACARA: []
  };
  const rowNumbers = () => Object.values(tables).forEach(rows =>
    rows.forEach((row, index) => row._rowNumber = index + 2));
  rowNumbers();
  const audits = [];
  let sequence = 0;
  Object.assign(ctx, {
    getInstanceSpreadsheetId_: () => 'sheet-test',
    readObjects_: sheet => (tables[sheet] || []).map(row => ({...row})),
    appendObjects_: (sheet, objects) => {
      objects.forEach(object => tables[sheet].push({...object}));
      rowNumbers();
      return objects;
    },
    appendObject_: (sheet, object) => {tables[sheet].push({...object}); rowNumbers(); return object;},
    updateObjectsAtRows_: (sheet, updates) => updates.forEach(update =>
      Object.assign(tables[sheet].find(row => row._rowNumber === update.rowNumber), update.changes)),
    readSettings_: () => ({UNIT_NAME: 'Bagian Umum', ARCHIVE_FOLDER_ID: 'root'}),
    ensureLoanSchema_: () => ({ok: true}),
    ensureLoanOutIndicatorLogSchema_: () => ({}),
    ensureLoanBeritaAcaraLogSchema_: () => ({}),
    audit_: (...args) => audits.push(args),
    getCurrentUser_: () => 'petugas@example.invalid',
    nowIso_: () => TODAY + 'T09:00:00+07:00',
    LockService: {getScriptLock: () => ({waitLock() {}, releaseLock() {}})},
    Utilities: {
      getUuid: () => 'uuid-' + (++sequence),
      formatDate: value => value instanceof Date && value.getFullYear() >= 2000 &&
        Math.abs(value.getTime() - Date.now()) < 5000
        ? TODAY
        : [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'),
          String(value.getDate()).padStart(2, '0')].join('-')
    }
  });
  return {ctx, tables, audits};
}

function baseForm(extra) {
  return Object.assign({
    loanPreviewId: 'LOAN-TEST', borrowerName: 'Budi', borrowerJabatan: 'Staf',
    borrowerUnit: 'Keuangan', loanPurpose: 'Pemeriksaan BPK', loanDate: TODAY,
    loanDueDate: '2026-11-18', loanPageCount: '1', loanCondition: 'BAIK',
    loanOfficerName: 'Petugas CF', loanOfficerJabatan: 'Arsiparis'
  }, extra || {});
}

const selections = list => ({loanSelectionsJson: JSON.stringify(list)});

test('one transaction can borrow a whole berkas plus items from two other berkas', () => {
  const {ctx, tables, audits} = fixture();
  const result = ctx.createLoan_(baseForm(Object.assign({loanPageCount: '25'}, selections([
    {objectType: 'BERKAS', berkasId: 'BRK-1', itemIds: []},
    {objectType: 'ITEM', berkasId: 'BRK-2', itemIds: ['ITM-2A', 'ITM-2B']},
    {objectType: 'ITEM', berkasId: 'BRK-3', itemIds: ['ITM-3A']}
  ]))));
  assert.equal(result.ok, true);
  assert.equal(result.loanGroupId, 'LOAN-TEST');
  assert.deepEqual(Array.from(result.berkasIds), ['BRK-1', 'BRK-2', 'BRK-3']);
  assert.equal(tables.PEMINJAMAN.length, 4);
  assert.deepEqual(tables.PEMINJAMAN.map(row => row.PEMINJAMAN_ID),
    ['LOAN-TEST-01', 'LOAN-TEST-02', 'LOAN-TEST-03', 'LOAN-TEST-04']);
  assert.ok(tables.PEMINJAMAN.every(row => row.LOAN_GROUP_ID === 'LOAN-TEST'));
  assert.deepEqual(tables.PEMINJAMAN.map(row => row.JENIS_OBJEK), ['BERKAS', 'ITEM', 'ITEM', 'ITEM']);
  // Jumlah lembar & lokasi per objek, total grup tetap sama di semua baris.
  assert.equal(tables.PEMINJAMAN[0].JUMLAH_HALAMAN_ITEM, 7);
  assert.equal(tables.PEMINJAMAN[1].JUMLAH_HALAMAN_ITEM, 5);
  assert.ok(tables.PEMINJAMAN.every(row => row.JUMLAH_HALAMAN_GRUP_SNAPSHOT === 25));
  assert.equal(tables.PEMINJAMAN[0].LOKASI_ASAL_SNAPSHOT, 'Kabinet 1 · Laci A1 · Folder 1');
  assert.equal(tables.PEMINJAMAN[3].LOKASI_ASAL_SNAPSHOT, 'Kabinet 3 · Laci A1 · Folder 3');
  // Status ketersediaan semua berkas/item yang terlibat ikut diperbarui.
  const status = id => tables.DB_BERKAS.find(row => row.BERKAS_ID === id).STATUS_PEMINJAMAN;
  const itemStatus = id => tables.DB_ITEM.find(row => row.ITEM_ID === id).STATUS_PEMINJAMAN;
  assert.equal(status('BRK-1'), 'DIPINJAM');
  assert.equal(status('BRK-2'), 'SEBAGIAN DIPINJAM');
  assert.equal(status('BRK-3'), 'SEBAGIAN DIPINJAM');
  assert.equal(itemStatus('ITM-1A'), 'DIPINJAM DALAM BERKAS');
  assert.equal(itemStatus('ITM-2A'), 'DIPINJAM');
  assert.equal(itemStatus('ITM-3A'), 'DIPINJAM');
  // Ringkasan transaksi untuk tabel klien.
  assert.equal(result.loan.berkasCount, 3);
  assert.equal(result.loan.objectType, 'CAMPURAN');
  assert.equal(result.loan.objects.length, 4);
  assert.equal(result.loan.title, '1 berkas lengkap + 3 item arsip (3 berkas)');
  assert.equal(audits.find(args => args[0] === 'BORROW')[2], 'MULTI_BERKAS');
});

test('loan list groups a multi-berkas transaction into one row with every object', () => {
  const {ctx} = fixture();
  ctx.createLoan_(baseForm(selections([
    {objectType: 'BERKAS', berkasId: 'BRK-1', itemIds: []},
    {objectType: 'BERKAS', berkasId: 'BRK-3', itemIds: []}
  ])));
  const options = ctx.getLoanOptions_();
  assert.equal(options.loans.length, 1);
  assert.equal(options.loans[0].title, '2 berkas lengkap');
  assert.deepEqual(Array.from(options.loans[0].berkasNumbers), ['1', '3']);
  assert.equal(options.summary.active, 1);
  assert.equal(options.summary.borrowedBerkas, 2);
  const berkas1 = options.berkas.find(row => row.id === 'BRK-1');
  assert.equal(berkas1.loanStatus, 'DIPINJAM');
  assert.equal(options.berkas.find(row => row.id === 'BRK-2').loanStatus, 'TERSEDIA');
});

test('legacy single-berkas payloads keep working unchanged', () => {
  const {ctx, tables} = fixture();
  ctx.createLoan_(baseForm({loanPreviewId: 'LOAN-A', loanObjectType: 'BERKAS', loanBerkasId: 'BRK-1'}));
  assert.equal(tables.PEMINJAMAN.length, 1);
  assert.equal(tables.PEMINJAMAN[0].PEMINJAMAN_ID, 'LOAN-A');
  assert.equal(tables.PEMINJAMAN[0].JUMLAH_HALAMAN_ITEM, 7);
  const result = ctx.createLoan_(baseForm({loanPreviewId: 'LOAN-B', loanObjectType: 'ITEM',
    loanBerkasId: 'BRK-2', loanItemIdsJson: JSON.stringify(['ITM-2B', 'ITM-2A'])}));
  assert.deepEqual(tables.PEMINJAMAN.slice(1).map(row => row.PEMINJAMAN_ID), ['LOAN-B-01', 'LOAN-B-02']);
  assert.equal(result.loan.title, '2 item arsip dalam berkas 2');
  assert.equal(result.loan.objectType, 'ITEM');
  assert.equal(result.loan.berkasCount, 1);
});

test('items from the same berkas sent twice are merged into one selection', () => {
  const {ctx, tables} = fixture();
  ctx.createLoan_(baseForm(selections([
    {objectType: 'ITEM', berkasId: 'BRK-1', itemIds: ['ITM-1A']},
    {objectType: 'ITEM', berkasId: 'BRK-1', itemIds: ['ITM-1B', 'ITM-1A']}
  ])));
  assert.deepEqual(tables.PEMINJAMAN.map(row => row.ITEM_ID), ['ITM-1A', 'ITM-1B']);
});

test('conflicting or unavailable selections are rejected before anything is written', () => {
  const cases = [
    [[{objectType: 'BERKAS', berkasId: 'BRK-1'}, {objectType: 'ITEM', berkasId: 'BRK-1', itemIds: ['ITM-1A']}],
      /Berkas 1 tercantum lebih dari sekali/],
    [[{objectType: 'BERKAS', berkasId: 'BRK-1'}, {objectType: 'BERKAS', berkasId: 'BRK-1'}],
      /tercantum lebih dari sekali/],
    [[{objectType: 'BERKAS', berkasId: 'BRK-2'}, {objectType: 'ITEM', berkasId: 'BRK-9', itemIds: ['X']}],
      /tidak ditemukan/],
    [[{objectType: 'ITEM', berkasId: 'BRK-2', itemIds: []}], /minimal satu item/],
    [[], /Objek peminjaman wajib diisi/]
  ];
  for (const [list, pattern] of cases) {
    const {ctx, tables} = fixture();
    assert.throws(() => ctx.createLoan_(baseForm(selections(list))), pattern);
    assert.equal(tables.PEMINJAMAN.length, 0);
    assert.ok(tables.DB_BERKAS.every(row => row.STATUS_PEMINJAMAN === 'TERSEDIA'));
  }
});

test('a berkas already on loan blocks the whole multi-berkas transaction', () => {
  const {ctx, tables} = fixture();
  ctx.createLoan_(baseForm({loanPreviewId: 'LOAN-OLD', loanObjectType: 'ITEM', loanBerkasId: 'BRK-3',
    loanItemIdsJson: JSON.stringify(['ITM-3A'])}));
  assert.throws(() => ctx.createLoan_(baseForm(Object.assign({loanPreviewId: 'LOAN-NEW'}, selections([
    {objectType: 'BERKAS', berkasId: 'BRK-1'},
    {objectType: 'BERKAS', berkasId: 'BRK-3'}
  ])))), /Berkas 3 tidak dapat dipinjam seluruhnya karena 1 item masih dipinjam/);
  assert.throws(() => ctx.createLoan_(baseForm(Object.assign({loanPreviewId: 'LOAN-NEW'}, selections([
    {objectType: 'BERKAS', berkasId: 'BRK-1'},
    {objectType: 'ITEM', berkasId: 'BRK-3', itemIds: ['ITM-3A']}
  ])))), /Item 1 pada berkas 3 sedang dipinjam/);
  assert.equal(tables.PEMINJAMAN.length, 1);
  assert.equal(tables.DB_BERKAS.find(row => row.BERKAS_ID === 'BRK-1').STATUS_PEMINJAMAN, 'TERSEDIA');
});

test('repeating the same transaction id never creates duplicate rows', () => {
  const {ctx, tables} = fixture();
  const form = baseForm(selections([
    {objectType: 'BERKAS', berkasId: 'BRK-1'}, {objectType: 'BERKAS', berkasId: 'BRK-2'}
  ]));
  ctx.createLoan_(form);
  const again = ctx.createLoan_(form);
  assert.equal(again.ok, true);
  assert.match(again.message, /sudah tersimpan/);
  assert.equal(tables.PEMINJAMAN.length, 2);
});

test('returning a multi-berkas transaction frees every berkas and item involved', () => {
  const {ctx, tables} = fixture();
  ctx.createLoan_(baseForm(selections([
    {objectType: 'BERKAS', berkasId: 'BRK-1'},
    {objectType: 'ITEM', berkasId: 'BRK-3', itemIds: ['ITM-3A']}
  ])));
  const result = ctx.returnLoan_({returnLoanId: 'LOAN-TEST', returnConfirmation: 'KEMBALIKAN',
    returnDate: TODAY, returnCondition: 'BAIK', returnOfficerName: 'Petugas CF',
    returnOfficerJabatan: 'Arsiparis'});
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.berkasIds), ['BRK-1', 'BRK-3']);
  assert.ok(tables.PEMINJAMAN.every(row => row.STATUS === 'KEMBALI'));
  assert.ok(tables.DB_BERKAS.every(row => row.STATUS_PEMINJAMAN === 'TERSEDIA'));
  assert.ok(tables.DB_ITEM.every(row => row.STATUS_PEMINJAMAN === 'TERSEDIA'));
});

test('Out Indicator returns one sheet per berkas with its own location and items', () => {
  const {ctx, tables} = fixture();
  ctx.createLoan_(baseForm(selections([
    {objectType: 'ITEM', berkasId: 'BRK-2', itemIds: ['ITM-2B', 'ITM-2A']},
    {objectType: 'BERKAS', berkasId: 'BRK-1'}
  ])));
  const payload = ctx.prepareLoanOutIndicator_('LOAN-TEST');
  assert.equal(payload.sheets.length, 2);
  assert.deepEqual(Array.from(payload.sheets, sheet => sheet.berkasNumber), ['1', '2']);
  assert.equal(payload.sheets[0].originalLocation, 'Kabinet 1 · Laci A1 · Folder 1');
  assert.deepEqual(Array.from(payload.sheets[0].items, item => item.number), ['SELURUH BERKAS']);
  assert.equal(payload.sheets[0].items[0].pageCount, 7);
  assert.deepEqual(Array.from(payload.sheets[1].items, item => item.number), ['1', '2']);
  assert.equal(payload.sheets[1].pageCount, 11);
  assert.equal(payload.berkasNumber, '1');
  assert.equal(tables.LOG_CETAK_OUT_INDICATOR[0].JENIS_OBJEK, 'MULTI_BERKAS');
  assert.equal(tables.LOG_CETAK_OUT_INDICATOR[0].NO_BERKAS_SNAPSHOT, '1, 2');
});

test('single-berkas Out Indicator payload is unchanged', () => {
  const {ctx} = fixture();
  ctx.createLoan_(baseForm({loanObjectType: 'BERKAS', loanBerkasId: 'BRK-2', loanPageCount: '9'}));
  const payload = ctx.prepareLoanOutIndicator_('LOAN-TEST');
  assert.equal(payload.sheets.length, 1);
  assert.deepEqual(Array.from(payload.items, item => item.number), ['SELURUH BERKAS']);
  assert.equal(payload.items[0].pageCount, 9);
  assert.equal(payload.pageCount, 9);
  assert.equal(payload.originalLocation, 'Kabinet 2 · Laci A1 · Folder 2');
});

// Drive & Docs tiruan untuk Berita Acara Google Docs.
function docsFixture(ctx) {
  const files = new Map();
  const docs = new Map();
  const effects = {copies: 0, pdfs: 0, trashed: [], tags: [], tables: [], normalized: 0};
  const makeFile = (id, mime) => {
    const file = {
      trashed: false, mime: mime,
      getId: () => id, getUrl: () => 'https://docs.invalid/' + id, getName: () => 'BA_' + id,
      getMimeType: () => file.mime, isTrashed: () => file.trashed,
      setTrashed(value) {file.trashed = value; effects.trashed.push(id); return file;},
      makeCopy() {effects.copies++; return makeFile('doc-' + effects.copies, 'application/vnd.google-apps.document');},
      getAs() {effects.pdfs++; return 'blob';}
    };
    files.set(id, file);
    return file;
  };
  makeFile('template', 'application/vnd.google-apps.document');
  const table = rows => ({
    getNumRows: () => rows.length,
    getRow: index => ({
      getNumCells: () => rows[index].length,
      getCell: column => ({
        getText: () => rows[index][column],
        editAsText: () => ({
          setText(value) {rows[index][column] = value; return this;},
          setFontFamily() {return this;}, setFontSize() {return this;}, setBold() {return this;}
        })
      })
    })
  });
  Object.assign(ctx, {
    getBeritaAcaraTemplateDocId_: () => 'template',
    getBeritaAcaraFolder_: () => ({createFile: () => {effects.pdfs++; return makeFile('pdf-new', 'application/pdf');}}),
    DriveApp: {getFileById: id => {
      if (!files.has(id)) throw new Error('File tidak ditemukan');
      return files.get(id);
    }},
    DocumentApp: {openById: id => {
      if (!docs.has(id)) docs.set(id, {
        pinjam: [['No.', 'Judul', 'Hal', 'Kondisi'], ['1', 'A', '3', 'BAIK']],
        kembali: [['No.', 'Judul', 'Hal', 'Kondisi'], ['1', 'A', '3', '–'], ['2', 'B', '4', 'RUSAK RINGAN']]
      });
      const doc = docs.get(id);
      return {saveAndClose() {}, getBody: () => ({getTables: () =>
        [table(doc.pinjam), table([['PIHAK KEDUA', 'PIHAK PERTAMA']]), table(doc.kembali)]})};
    }},
    fillBeritaAcaraTags_: (doc, tags) => effects.tags.push(Object.keys(tags)),
    fillBeritaAcaraItemsTable_: (doc, section, items) => effects.tables.push(items),
    normalizeBeritaAcaraLayout_: () => {effects.normalized++; return {};}
  });
  return {files, docs, effects, makeFile};
}

const returnForm = {returnLoanId: 'LOAN-TEST', returnConfirmation: 'KEMBALIKAN', returnDate: TODAY,
  returnCondition: 'BAIK', returnOfficerName: 'Petugas Kembali', returnOfficerJabatan: 'Arsiparis'};

test('Berita Acara is saved as an editable Google Doc listing every object across berkas', () => {
  const {ctx, tables} = fixture();
  const {effects, files} = docsFixture(ctx);
  ctx.createLoan_(baseForm(selections([
    {objectType: 'ITEM', berkasId: 'BRK-3', itemIds: ['ITM-3A']},
    {objectType: 'BERKAS', berkasId: 'BRK-1'}
  ])));
  const result = ctx.prepareLoanBeritaAcara_('LOAN-TEST');
  assert.equal(result.ok, true);
  assert.equal(result.reused, false);
  assert.equal(result.docUrl, 'https://docs.invalid/doc-1');
  assert.equal(effects.pdfs, 0, 'tidak ada PDF yang dibuat');
  assert.equal(files.get('doc-1').isTrashed(), false, 'dokumen Docs disimpan, tidak dibuang');
  assert.ok(tables.PEMINJAMAN.every(row => row.BA_PDF_ID === 'doc-1' && row.BA_PDF_URL === result.docUrl));
  assert.equal(tables.LOG_CETAK_BERITA_ACARA[0].STATUS, 'DOCS_DIBUAT');
  assert.equal(effects.tables.length, 2);
  assert.deepEqual(Array.from(effects.tables[0], item => item.number), ['Berkas 1 (lengkap)', 'Berkas 3 / Item 1']);
  assert.equal(effects.tables[0][0].description, 'Berkas Satu');
  // Sebelum kembali, data petugas penerima pengembalian dibiarkan sebagai isian tangan.
  assert.equal(effects.tags[0].includes('NAMA PETUGAS CENTRAL FILE KEMBALI'), false);
  assert.equal(effects.tags[0].includes('NAMA PETUGAS CENTRAL FILE'), true);
});

test('opening the Berita Acara again reuses the same Doc so manual edits are kept', () => {
  const {ctx} = fixture();
  const {effects} = docsFixture(ctx);
  ctx.createLoan_(baseForm({loanObjectType: 'BERKAS', loanBerkasId: 'BRK-1'}));
  const first = ctx.prepareLoanBeritaAcara_('LOAN-TEST');
  const again = ctx.prepareLoanBeritaAcara_('LOAN-TEST');
  assert.equal(again.reused, true);
  assert.equal(again.docUrl, first.docUrl);
  assert.equal(effects.copies, 1);
  assert.equal(effects.tables.length, 2, 'tabel tidak disusun ulang pada dokumen yang sudah ada');
  assert.equal(effects.normalized, 1, 'tata letak dirapikan hanya saat dokumen dibuat, tidak menimpa rapian petugas');
});

test('recording the return fills the same Doc without overwriting manual entries', () => {
  const {ctx, tables} = fixture();
  const {effects, docs} = docsFixture(ctx);
  ctx.createLoan_(baseForm({loanObjectType: 'BERKAS', loanBerkasId: 'BRK-1'}));
  ctx.prepareLoanBeritaAcara_('LOAN-TEST');
  ctx.returnLoan_(returnForm);
  const result = ctx.prepareLoanBeritaAcara_('LOAN-TEST');
  assert.equal(result.reused, true);
  assert.equal(result.isReturned, true);
  assert.equal(effects.copies, 1);
  const tags = effects.tags[1];
  assert.ok(tags.includes('TANGGAL KEMBALI'));
  assert.ok(tags.includes('NAMA PETUGAS CENTRAL FILE KEMBALI'));
  const kembali = docs.get('doc-1').kembali;
  assert.equal(kembali[1][3], 'BAIK', 'kolom kondisi kosong diisi kondisi kembali');
  assert.equal(kembali[2][3], 'RUSAK RINGAN', 'isian manual petugas tidak ditimpa');
  assert.equal(docs.get('doc-1').pinjam[1][3], 'BAIK');
  assert.ok(tables.PEMINJAMAN.every(row => row.BA_PDF_ID === 'doc-1'));
});

test('a legacy PDF or deleted Doc is replaced by a new Google Doc', () => {
  for (const setup of ['pdf', 'trashed', 'missing']) {
    const {ctx, tables} = fixture();
    const {effects, makeFile} = docsFixture(ctx);
    ctx.createLoan_(baseForm({loanObjectType: 'BERKAS', loanBerkasId: 'BRK-1'}));
    if (setup === 'pdf') makeFile('old', 'application/pdf');
    if (setup === 'trashed') makeFile('old', 'application/vnd.google-apps.document').trashed = true;
    tables.PEMINJAMAN.forEach(row => {row.BA_PDF_ID = 'old'; row.BA_PDF_URL = 'https://docs.invalid/old';});
    const result = ctx.prepareLoanBeritaAcara_('LOAN-TEST');
    assert.equal(result.reused, false, setup);
    assert.equal(effects.copies, 1, setup);
    assert.equal(tables.PEMINJAMAN[0].BA_PDF_ID, 'doc-1', setup);
  }
});

test('single-berkas Berita Acara keeps the original numbering', () => {
  const {ctx} = fixture();
  const lines = ctx.loanGroupDocumentLines_([
    {JENIS_OBJEK: 'ITEM', BERKAS_ID: 'BRK-1', ITEM_ID: 'ITM-1B', NO_BERKAS_SNAPSHOT: '1', NO_ITEM_SNAPSHOT: '2', URAIAN_OBJEK_SNAPSHOT: 'B', JUMLAH_HALAMAN_ITEM: 4},
    {JENIS_OBJEK: 'ITEM', BERKAS_ID: 'BRK-1', ITEM_ID: 'ITM-1A', NO_BERKAS_SNAPSHOT: '1', NO_ITEM_SNAPSHOT: '1', URAIAN_OBJEK_SNAPSHOT: 'A', JUMLAH_HALAMAN_ITEM: 3}
  ], {}, {}, false);
  assert.deepEqual(Array.from(lines, line => line.number), ['1', '2']);
});

test('evidence upload validation receives every required field and the selection list', () => {
  const {ctx} = fixture();
  const form = ctx.sanitizeLoanForm_(Object.assign(baseForm(selections([
    {objectType: 'BERKAS', berkasId: 'BRK-1'}, {objectType: 'BERKAS', berkasId: 'BRK-2'}
  ])), {evidenceName: 'bukti.pdf'}));
  assert.equal(form.borrowerJabatan, 'Staf');
  assert.equal(form.loanOfficerName, 'Petugas CF');
  assert.equal(form.loanCondition, 'BAIK');
  assert.equal(ctx.resolveLoanContext_(form).selections.length, 2);
});

// Body Google Docs tiruan untuk normalisasi tata letak BA.
function fakeBody(spec) {
  const types = {PARAGRAPH: 'PARAGRAPH', TABLE: 'TABLE', TEXT: 'TEXT', PAGE_BREAK: 'PAGE_BREAK', LIST_ITEM: 'LIST_ITEM'};
  const children = [];
  const paragraph = (text, extra) => {
    const parts = text === null ? [] : [{getType: () => types.TEXT}];
    if (extra) parts.push({getType: () => extra});
    const element = {
      kind: 'P', text: text || '', breakAfter: extra === types.PAGE_BREAK,
      getType: () => types.PARAGRAPH,
      asParagraph: () => ({
        getNumChildren: () => parts.length, getChild: index => parts[index],
        getText: () => element.text
      }),
      removeFromParent: () => children.splice(children.indexOf(element), 1)
    };
    return element;
  };
  spec.forEach(entry => {
    if (entry === 'TABLE') children.push({kind: 'T', getType: () => types.TABLE, removeFromParent() {}});
    else if (entry === 'LIST') children.push({kind: 'L', getType: () => types.LIST_ITEM, removeFromParent() {}});
    else if (entry === 'IMG') children.push(paragraph('', 'INLINE_IMAGE'));
    else children.push(paragraph(entry));
  });
  const body = {
    getNumChildren: () => children.length,
    getChild: index => children[index],
    insertPageBreak: index => children.splice(index, 0, paragraph(null, types.PAGE_BREAK))
  };
  return {types, body, children};
}

const blanks = count => Array(count).fill('');

test('BA layout: stacked blank lines are collapsed and Pengembalian starts on a new page', () => {
  const {ctx} = fixture();
  const spec = ['BERITA ACARA PEMINJAMAN ARSIP', '', 'Pada hari ini', 'TABLE', ...blanks(19),
    'Demikian berita acara', '', '', 'TABLE', ...blanks(3), 'Menyetujui,', 'Pimpinan', ...blanks(3),
    '[NAMA PIMPINAN]', ...blanks(15), 'Tembusan:', 'LIST', 'IMG', ...blanks(6),
    'BERITA ACARA PENGEMBALIAN ARSIP', '', 'TABLE', ...blanks(19), 'Demikian berita acara',
    'TABLE', ...blanks(17), 'Tembusan:', 'LIST'];
  const {types, body, children} = fakeBody(spec);
  ctx.DocumentApp = {ElementType: types};
  const result = ctx.normalizeBeritaAcaraLayout_({getBody: () => body});
  assert.equal(result.pageBreakInserted, true);
  const kinds = children.map(element => element.breakAfter ? 'BREAK' : element.kind === 'P' ? (element.text || '·') : element.kind);
  // Tumpukan baris kosong tinggal satu; ruang tanda tangan (3 baris) dan gambar tetap.
  assert.deepEqual(kinds.slice(0, 8), ['BERITA ACARA PEMINJAMAN ARSIP', '·', 'Pada hari ini', 'T', '·', 'Demikian berita acara', '·', '·']);
  assert.equal(kinds.indexOf('Menyetujui,') - kinds.lastIndexOf('T', kinds.indexOf('Menyetujui,')), 4);
  const title = kinds.indexOf('BERITA ACARA PENGEMBALIAN ARSIP');
  assert.equal(kinds[title - 1], 'BREAK', 'page break tepat sebelum judul Pengembalian');
  assert.ok(kinds.includes('') === false && children.some(element => element.kind === 'P' && element.text === '' && !element.breakAfter));
  assert.equal(kinds.filter(kind => kind === 'BREAK').length, 1);
  assert.ok(children.length < spec.length - 60);
});

test('BA layout: an existing page break before Pengembalian is not duplicated', () => {
  const {ctx} = fixture();
  const {types, body, children} = fakeBody(['Isi', 'BERITA ACARA PENGEMBALIAN ARSIP', 'Isi']);
  ctx.DocumentApp = {ElementType: types};
  body.insertPageBreak(1);
  const result = ctx.normalizeBeritaAcaraLayout_({getBody: () => body});
  assert.equal(result.pageBreakInserted, false);
  assert.equal(children.filter(element => element.breakAfter).length, 1);
});
