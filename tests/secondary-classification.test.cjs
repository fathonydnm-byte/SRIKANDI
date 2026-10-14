// node --test tests/secondary-classification.test.cjs
// Real validation, numbering, upload/session and commit functions; Google I/O is in memory.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(rootParent = '') {
  const ctx = vm.createContext({});
  for (const file of ['Config.js', 'Services.js', 'CentralFileMetadataService.js',
    'NumberingService.js', 'ItemService.js', 'UploadService.js', 'EditService.js', 'MediaService.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../central-file', file), 'utf8'), ctx);
  }
  const tables = {
    MASTER_KLASIFIKASI: [
      {KLASIFIKASI_ID: 'primary', PARENT_ID: rootParent, KODE_LENGKAP: 'A', URAIAN: 'Primer', AKTIF: true, URUTAN: 1},
      {KLASIFIKASI_ID: 'secondary', PARENT_ID: 'primary', KODE_LENGKAP: 'A.01', URAIAN: 'Masalah umum', AKTIF: 'TRUE', URUTAN: 2},
      {KLASIFIKASI_ID: 'tertiary', PARENT_ID: 'secondary', KODE_LENGKAP: 'A.01.01', URAIAN: 'Masalah spesifik', AKTIF: true, URUTAN: 3},
      {KLASIFIKASI_ID: 'leaf-primary', PARENT_ID: rootParent, KODE_LENGKAP: 'B', URAIAN: 'Primer tanpa turunan', AKTIF: true, URUTAN: 4},
      {KLASIFIKASI_ID: 'inactive', PARENT_ID: 'primary', AKTIF: false, URUTAN: 5}
    ], DB_BERKAS: [], DB_ITEM: [], PEMINJAMAN: []
  };
  const properties = new Map();
  const files = new Map();
  const effects = {uploads: 0, folders: 0};
  let sequence = 0;
  const file = id => {
    if (!files.has(id)) files.set(id, {
      getId: () => id, getUrl: () => 'https://example.invalid/' + id,
      getMimeType: () => 'application/pdf', getSize: () => 8,
      setName() {return this;}, moveTo() {return this;}, setTrashed() {return this;}
    });
    return files.get(id);
  };
  const folder = {
    getId: () => 'archive-folder', getUrl: () => 'https://example.invalid/folder',
    getName: () => 'Arsip', setName() {return this;},
    createFolder() {effects.folders++; return this;}
  };
  Object.assign(ctx, {
    readObjects_: sheet => tables[sheet] || [],
    readSettings_: () => ({ARCHIVE_FOLDER_ID: 'archive-root'}),
    getSheetOrThrow_: sheet => ({getLastRow: () => (tables[sheet] || []).length + 1}),
    appendObject_: (sheet, value) => {
      tables[sheet].push({...value, _rowNumber: tables[sheet].length + 2});
    },
    updateObjectAtRow_: (sheet, row, changes) => Object.assign(tables[sheet].find(x => x._rowNumber === row), changes),
    getCurrentUser_: () => 'test@example.invalid', nowIso_: () => '2026-10-14T10:00:00+07:00',
    LockService: {getScriptLock: () => ({waitLock() {}, releaseLock() {}})},
    PropertiesService: {getScriptProperties: () => ({
      getProperty: key => properties.get(key), setProperty: (key, value) => properties.set(key, value),
      deleteProperty: key => properties.delete(key), getProperties: () => Object.fromEntries(properties)
    })},
    Utilities: {
      getUuid: () => 'uuid-' + (++sequence),
      base64Decode: value => [...Buffer.from(value, 'base64')],
      formatDate: value => [value.getFullYear(), String(value.getMonth() + 1).padStart(2, '0'), String(value.getDate()).padStart(2, '0')].join('-')
    },
    DriveApp: {getFolderById: () => folder, getFileById: file},
    initializeDriveResumableUpload_: () => {effects.uploads++; return 'upload-' + effects.uploads;},
    sendDriveResumableChunk_: () => ({complete: true, fileId: 'file-' + effects.uploads}),
    applyNumberingPlan_: () => {}, rebuildReports_: () => {}, audit_: () => {}
  });
  const request = {
    berkasMode: 'NEW', title: 'Berkas masalah umum', classificationId: 'secondary',
    newBerkasId: 'berkas-test', previewItemId: 'item-test', activeRetentionValue: '2',
    activeRetentionUnit: 'TAHUN', inactiveRetentionValue: '3', inactiveRetentionUnit: 'TAHUN',
    finalDisposition: 'MUSNAH', documentDate: '2026-10-14', pageCount: '1',
    developmentLevel: 'ASLI', securityClassification: 'BIASA/TERBUKA', description: 'Naskah umum',
    pdfName: 'arsip.pdf', pdfSize: 8, pdfType: 'application/pdf'
  };
  return {ctx, tables, request, effects};
}

function upload(ctx, started, media = false) {
  const input = {sessionId: started.sessionId, start: 0, end: 8, total: 8,
    base64: Buffer.from('%PDF-1.4').toString('base64')};
  (media ? ctx.uploadMediaChunk_ : ctx.uploadItemChunk_)(input);
  return (media ? ctx.finalizeMediaUpload_ : ctx.finalizeItemUpload_)(started.sessionId);
}

for (const root of ['', 'ROOT']) {
  test(`secondary with active tertiary children can upload and commit (root=${JSON.stringify(root)})`, () => {
    const {ctx, tables, request} = fixture(root);
    const started = ctx.startItemUpload_(request);
    assert.equal(ctx.getItemUploadSession_(started.sessionId).form.classificationId, 'secondary');
    assert.equal(upload(ctx, started).ok, true);
    assert.equal(tables.DB_BERKAS[0].KLASIFIKASI_ID, 'secondary');
    assert.equal(tables.DB_BERKAS[0].KODE_KLASIFIKASI_SNAPSHOT, 'A.01');
    assert.equal(tables.DB_BERKAS[0].URAIAN_KLASIFIKASI_SNAPSHOT, 'Masalah umum');
    assert.equal(tables.DB_ITEM[0].KODE_KLASIFIKASI_SNAPSHOT, 'A.01');
    assert.equal(tables.DB_ITEM[0].STATUS_FILE, 'TERSEDIA');
    assert.equal(ctx.finalizeItemUpload_(started.sessionId).ok, true);
    assert.equal(tables.DB_BERKAS.length, 1);
    assert.equal(tables.DB_ITEM.length, 1);
  });
}

test('secondary can commit without PDF, then attach PDF through Alih Media', () => {
  const {ctx, tables, request} = fixture();
  assert.equal(ctx.commitItem_(request, null, true).ok, true);
  assert.equal(tables.DB_ITEM[0].STATUS_FILE, 'BELUM DIUNGGAH');
  const started = ctx.startMediaUpload_({berkasId: 'berkas-test', itemId: 'item-test',
    fileName: 'susulan.pdf', fileSize: 8, mimeType: 'application/pdf'});
  assert.equal(upload(ctx, started, true).ok, true);
  assert.equal(tables.DB_ITEM[0].STATUS_FILE, 'TERSEDIA');
  assert.equal(tables.DB_BERKAS[0].KODE_KLASIFIKASI_SNAPSHOT, 'A.01');
  assert.equal(tables.DB_ITEM[0].KODE_KLASIFIKASI_SNAPSHOT, 'A.01');
  assert.equal(ctx.finalizeMediaUpload_(started.sessionId).ok, true);
  assert.equal(tables.DB_ITEM.length, 1);
});

test('tertiary remains usable with its own code and description', () => {
  const {ctx, tables, request} = fixture();
  request.classificationId = 'tertiary';
  assert.equal(upload(ctx, ctx.startItemUpload_(request)).ok, true);
  assert.equal(tables.DB_BERKAS[0].KODE_KLASIFIKASI_SNAPSHOT, 'A.01.01');
  assert.equal(tables.DB_BERKAS[0].URAIAN_KLASIFIKASI_SNAPSHOT, 'Masalah spesifik');
});

for (const id of ['', 'unknown', 'inactive', 'primary']) {
  test(`invalid or insufficient classification ${JSON.stringify(id)} fails before upload and writes`, () => {
    const {ctx, tables, request, effects} = fixture();
    request.classificationId = id;
    assert.throws(() => ctx.startItemUpload_(request), /klasifikasi/i);
    assert.throws(() => ctx.commitItem_(request, null, true), /klasifikasi/i);
    assert.equal(effects.uploads, 0);
    assert.equal(effects.folders, 0);
    assert.equal(tables.DB_BERKAS.length, 0);
    assert.equal(tables.DB_ITEM.length, 0);
  });
}

test('existing leaf classification remains accepted', () => {
  const {ctx} = fixture();
  assert.equal(ctx.validateClassification_('leaf-primary').KODE_LENGKAP, 'B');
});

test('client sends secondary when tertiary is empty, and tertiary when selected', () => {
  const source = fs.readFileSync(path.join(__dirname, '../central-file/Client.html'), 'utf8');
  const fn = source.match(/function updateClassificationId\(\)\{[^}]+\}/)[0];
  const fields = {primaryClass: {value: 'primary'}, secondaryClass: {value: 'secondary'},
    tertiaryClass: {value: ''}, classificationId: {value: ''}};
  const ctx = vm.createContext({$: id => fields[id]});
  vm.runInContext(fn, ctx);
  ctx.updateClassificationId();
  assert.equal(fields.classificationId.value, 'secondary');
  fields.tertiaryClass.value = 'tertiary';
  ctx.updateClassificationId();
  assert.equal(fields.classificationId.value, 'tertiary');
});
