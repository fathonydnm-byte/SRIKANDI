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

test('Berita Acara lists every object, prefixed with its berkas when several berkas are borrowed', () => {
  const {ctx} = fixture();
  const filled = [];
  const file = {getId: () => 'doc', getUrl: () => 'https://example.invalid/ba', getName: () => 'BA.pdf',
    setName() {return this;}, makeCopy() {return {getId: () => 'copy', setTrashed() {}};},
    getAs: () => 'pdf-blob', setTrashed() {}};
  Object.assign(ctx, {
    getBeritaAcaraTemplateDocId_: () => 'template',
    getBeritaAcaraFolder_: () => ({createFile: () => file}),
    DriveApp: {getFileById: () => file},
    DocumentApp: {openById: () => ({saveAndClose() {}})},
    fillBeritaAcaraTags_: () => {},
    fillBeritaAcaraItemsTable_: (doc, section, items) => filled.push(items)
  });
  ctx.createLoan_(baseForm(selections([
    {objectType: 'ITEM', berkasId: 'BRK-3', itemIds: ['ITM-3A']},
    {objectType: 'BERKAS', berkasId: 'BRK-1'}
  ])));
  const result = ctx.prepareLoanBeritaAcara_('LOAN-TEST');
  assert.equal(result.ok, true);
  assert.equal(filled.length, 2);
  assert.deepEqual(Array.from(filled[0], item => item.number), ['Berkas 1 (lengkap)', 'Berkas 3 / Item 1']);
  assert.equal(filled[0][0].description, 'Berkas Satu');
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
