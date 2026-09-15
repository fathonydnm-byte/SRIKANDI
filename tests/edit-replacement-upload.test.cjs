// Run: node --test tests/edit-replacement-upload.test.cjs
// Executes the real upload/session/finalize/edit code with in-memory Google services.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture() {
  const ctx = vm.createContext({});
  for (const name of ['Services.js', 'CentralFileMetadataService.js', 'UploadService.js', 'EditService.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../central-file', name), 'utf8'), ctx);
  }
  const item = {
    ITEM_ID: 'item-test', BERKAS_ID: 'berkas-test', _rowNumber: 2,
    TANGGAL_NASKAH: '2026-04-20', JUMLAH_HALAMAN: 3,
    URAIAN_LENGKAP: 'Dokumen pengujian', TINGKAT_PERKEMBANGAN: 'ASLI',
    KONDISI_FISIK: 'BAIK', KLASIFIKASI_KEAMANAN_AKSES: 'RAHASIA',
    DRIVE_FILE_ID: 'old-pdf', VERSION: 1
  };
  const parent = {BERKAS_ID: item.BERKAS_ID, DRIVE_FOLDER_ID: 'folder-test'};
  const properties = new Map();
  const effects = {uploads: 0, updates: 0, quarantined: [], trashed: []};
  Object.assign(ctx, {
    APP_CONFIG: {SHEETS: {BERKAS: 'berkas', ITEM: 'item', PEMINJAMAN: 'loans'}},
    getCurrentUser_: () => 'test@example.invalid',
    nowIso_: () => '2026-09-15T10:00:00+07:00',
    dateKey_: value => String(value).slice(0, 10),
    parseLocalDate_: value => String(value),
    readObjects_: sheet => sheet === 'berkas' ? [parent] : sheet === 'item' ? [item] : [],
    isDeleted_: () => false,
    LockService: {getScriptLock: () => ({waitLock() {}, releaseLock() {}})},
    PropertiesService: {getScriptProperties: () => ({
      getProperty: key => properties.get(key),
      setProperty: (key, value) => properties.set(key, value),
      deleteProperty: key => properties.delete(key)
    })},
    Utilities: {getUuid: () => 'test-session', base64Decode: s => [...Buffer.from(s, 'base64')]},
    purgeOldEditUploadSessions_: () => {},
    initializeDriveResumableUpload_: () => { effects.uploads++; return 'mock-session'; },
    sendDriveResumableChunk_: () => ({complete: true, fileId: 'new-pdf'}),
    DriveApp: {getFileById: id => ({
      getSize: () => 8, getMimeType: () => 'application/pdf', getId: () => id,
      getUrl: () => 'mock-file-url', setTrashed: () => effects.trashed.push(id)
    })},
    updateObjectAtRow_: (sheet, row, changes) => {
      assert.equal(sheet, 'item'); assert.equal(row, 2);
      effects.updates++; Object.assign(item, changes);
    },
    buildReindexPlan_: () => ({}), applyNumberingPlan_: () => {},
    quarantineDriveObject_: (type, id) => {effects.quarantined.push(id); return {ok: true};},
    rebuildReports_: () => {}, audit_: () => {}
  });
  const request = {
    editBerkasId: parent.BERKAS_ID, editItemId: item.ITEM_ID,
    editDocumentDate: '2026-04-20', editPageCount: '3', editDevelopmentLevel: 'ASLI',
    editDescription: 'Dokumen pengujian', editReason: 'Mengganti PDF untuk pengujian',
    editSecurityClassification: 'BIASA/TERBUKA', editCondition: 'BAIK',
    replacementName: 'replacement.pdf', replacementSize: 8, replacementType: 'application/pdf'
  };
  return {ctx, item, effects, request};
}

for (const classification of ['BIASA/TERBUKA', 'TERBATAS', 'RAHASIA', 'SANGAT RAHASIA']) {
  test(`replacement preserves ${classification} and physical condition through stored session`, () => {
    const {ctx, item, effects, request} = fixture();
    request.editSecurityClassification = classification;
    request.editCondition = 'RUSAK RINGAN';
    const started = ctx.startEditReplacementUpload_(request);
    const session = ctx.getEditUploadSession_(started.sessionId);
    assert.equal(session.form.editSecurityClassification, classification);
    assert.equal(session.form.editCondition, 'RUSAK RINGAN');
    ctx.uploadEditReplacementChunk_({sessionId: started.sessionId, start: 0, end: 8,
      total: 8, base64: Buffer.from('%PDF-1.4').toString('base64')});
    assert.equal(ctx.finalizeEditReplacementUpload_(started.sessionId).ok, true);
    assert.equal(item.KLASIFIKASI_KEAMANAN_AKSES, classification);
    assert.equal(item.KONDISI_FISIK, 'RUSAK RINGAN');
    assert.equal(item.DRIVE_FILE_ID, 'new-pdf');
    assert.deepEqual(effects.quarantined, ['old-pdf']);
    assert.deepEqual(effects.trashed, []);
    assert.equal(ctx.finalizeEditReplacementUpload_(started.sessionId).ok, true);
    assert.equal(effects.updates, 1, 'repeated finalization must not update twice');
  });
}

for (const value of [undefined, '', 'INVALID']) {
  test(`invalid classification ${JSON.stringify(value)} fails before Drive upload`, () => {
    const {ctx, item, effects, request} = fixture();
    request.editSecurityClassification = value;
    assert.throws(() => ctx.startEditReplacementUpload_(request), /Klasifikasi keamanan/);
    assert.equal(effects.uploads, 0);
    assert.equal(effects.updates, 0);
    assert.equal(item.DRIVE_FILE_ID, 'old-pdf');
  });
}

test('invalid physical condition fails before upload; blank condition remains optional', () => {
  const {ctx, effects, request} = fixture();
  request.editCondition = 'INVALID';
  assert.throws(() => ctx.startEditReplacementUpload_(request), /Kondisi fisik tidak valid/);
  assert.equal(effects.uploads, 0);
  request.editCondition = '';
  assert.equal(ctx.startEditReplacementUpload_(request).ok, true);
});

test('editing metadata without a replacement still saves both fields', () => {
  const {ctx, effects, request, item} = fixture();
  request.editSecurityClassification = 'TERBATAS';
  request.editCondition = 'RUSAK SEDANG';
  assert.equal(ctx.updateArchiveItem_(request).ok, true);
  assert.equal(item.KLASIFIKASI_KEAMANAN_AKSES, 'TERBATAS');
  assert.equal(item.KONDISI_FISIK, 'RUSAK SEDANG');
  assert.equal(item.DRIVE_FILE_ID, 'old-pdf');
  assert.equal(effects.uploads, 0);
  assert.deepEqual(effects.quarantined, []);
});

test('a pre-3.30.5 session is discarded instead of losing metadata', () => {
  const {ctx, effects} = fixture();
  ctx.saveEditUploadSession_({
    sessionId: 'legacy-session', userEmail: 'test@example.invalid',
    driveFileId: 'legacy-temp-pdf', committed: false,
    form: {editBerkasId: 'berkas-test', editItemId: 'item-test'}
  });
  assert.throws(() => ctx.getEditReplacementUploadStatus_('legacy-session'),
    /UPLOAD_SESSION_EXPIRED:.*versi aplikasi lama/);
  assert.deepEqual(effects.trashed, ['legacy-temp-pdf']);
  assert.throws(() => ctx.getEditUploadSession_('legacy-session'),
    /UPLOAD_SESSION_NOT_FOUND/);
});
