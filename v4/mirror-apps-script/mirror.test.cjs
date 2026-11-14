// Node tests for Code.gs (pure logic + the resumable job against fake Apps Script services).
// Run: node --test v4/mirror-apps-script/mirror.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { createWorld, makeFakeApi, canonicalJson, plain, SOURCE } = require('./testkit.cjs');

const SECRET = 'S'.repeat(48);
const DAY_MS = 24 * 3600 * 1000;
const UNIT_A = '11111111-1111-4111-8111-111111111111';
const UNIT_B = '22222222-2222-4222-8222-222222222222';
const TABLES = {
  units: { key: ['id'] }, unit_settings: { key: ['key'] }, counters: { key: ['scope', 'year'] }, klasifikasi: { key: ['id'] },
  jenis_naskah: { key: ['subjenis_naskah_id'] }, pegawai: { key: ['id'] }, berkas: { key: ['id'] }, item: { key: ['id'] },
  penerimaan: { key: ['id'] }, penerimaan_item: { key: ['id'] }, riwayat_nomor: { key: ['id'] }, penerimaan_cetak_log: { key: ['id'] },
  folder_label_log: { key: ['id'] }, karantina: { key: ['id'] }, pembatalan_arsip: { key: ['id'] }, drive_tasks: { key: ['id'] }, audit_log: { key: ['id'] },
};
const ALL = Object.keys(TABLES);
const UNITS = [
  { id: UNIT_A, code: 'BAU', name: 'Biro Administrasi Umum', active: true, tables: ALL, backup_only: false },
  { id: UNIT_B, code: 'LPM', name: 'LPM', active: true, tables: ALL, backup_only: false },
  { id: 'GLOBAL', code: '_PLATFORM', name: 'Lintas unit (audit tanpa unit)', active: true, tables: ['audit_log'], backup_only: true },
];

function dataset({ items = 2300 } = {}) {
  const A = Object.fromEntries(ALL.map((t) => [t, []]));
  A.units.push({ id: UNIT_A, code: 'BAU', name: 'Biro Administrasi Umum', legacy_instance_id: 'INS-1', legacy_unit_id: 'U1', active: true, created_at: '2026-01-01T00:00:00+00:00' });
  A.unit_settings.push({ unit_id: UNIT_A, key: 'UNIT_NAME', value: 'Biro', value_type: 'STRING', description: null, updated_at: '2026-01-01T00:00:00+00:00', updated_by: null, scope: null });
  A.counters.push({ unit_id: UNIT_A, scope: 'BRK', year: 0, last_value: 3, updated_at: '2026-01-01T00:00:00+00:00' }, { unit_id: UNIT_A, scope: 'TRM', year: 2026, last_value: 9, updated_at: '2026-01-01T00:00:00+00:00' });
  A.pegawai.push({ id: 'PGW-1', unit_id: UNIT_A, nama_pegawai: 'Budi', unit_kerja: 'X', aktif: true, nip_nik_enc: '\\xdeadbeef', kontak_enc: '\\xcafe', created_at: '2026-01-01T00:00:00+00:00' });
  const berkas = (n, over = {}) => ({ id: `BRK-${n}`, unit_id: UNIT_A, no_berkas_definitif: n, judul_berkas: `Berkas ${n}`, kode_klasifikasi_snapshot: 'PR.01.02', kurun_waktu: '2026', status_retensi: 'AKTIF', no_filling_kabinet: '1', no_laci: '2', batas_aktif: '2031-01-01', klasifikasi_keamanan_akses: 'TERBATAS', drive_folder_id: `folder${n}abcdefghij`, status_pemindahan: null, is_deleted: false, ...over });
  A.berkas.push(berkas(1), berkas(2), berkas(3, { is_deleted: true }), berkas(4, { status_pemindahan: 'SUDAH DIPINDAHKAN' }), berkas(5, { no_berkas_definitif: null }));
  for (let i = 1; i <= items; i++) {
    A.item.push({
      id: `ITM-${String(i).padStart(5, '0')}`, unit_id: UNIT_A, berkas_id: `BRK-${(i % 2) + 1}`, no_item_definitif: i, no_surat_display: i === 7 ? '=HYPERLINK("http://evil.example","klik")' : `S-${i}`,
      uraian_lengkap: i === 8 ? '-2+3 pengeluaran' : i === 9 ? '@SUM(1)' : i === 10 ? 'x'.repeat(60000) : `Uraian ${i}, "kutip"`, jumlah_halaman: 2, tanggal_naskah: '2026-02-03', tahun_kurun_waktu: 2026,
      kode_klasifikasi_snapshot: 'PR.01.02', no_berkas_snapshot: (i % 2) + 1, tingkat_perkembangan: 'ASLI', klasifikasi_keamanan_akses: null, drive_file_id: i % 3 === 0 ? `file${i}abcdefghijk` : null,
      nama_file: i % 3 === 0 ? `Surat ${i}.pdf` : null, drive_file_size_bytes: i % 3 === 0 ? 1000 + i : null, drive_file_sha256: i % 3 === 0 ? 'ab'.repeat(32) : null, mime_type: 'application/pdf',
      drive_file_url: i % 3 === 0 ? `https://drive.google.com/file/d/file${i}abcdefghijk/view` : null, is_deleted: false, lampiran: [], created_at: '2026-02-03T01:02:03.456789+00:00',
    });
  }
  A.penerimaan.push({ id: 'RCV-1', unit_id: UNIT_A, nomor_tanda_terima: 'TRM-2026-0001', bukti_ttd_file_id: 'ttdfile1abcdefghij', bukti_ttd_nama: 'ttd.pdf', bukti_ttd_size_bytes: 5, bukti_ttd_md5: 'cd'.repeat(16), batal_bukti_file_id: null });
  A.audit_log.push({ id: 'LOG-1', unit_id: UNIT_A, occurred_at: '2026-02-03T01:02:03+00:00', action: 'CREATE', summary: '+1 baris', before_data: null, after_data: { a: 1 } });
  const B = Object.fromEntries(ALL.map((t) => [t, []]));
  B.units.push({ id: UNIT_B, code: 'LPM', name: 'LPM', legacy_instance_id: null, legacy_unit_id: null, active: true, created_at: '2026-01-01T00:00:00+00:00' });
  return { [UNIT_A]: A, [UNIT_B]: B, GLOBAL: { audit_log: [{ id: 'LOG-G1', unit_id: null, occurred_at: '2026-02-03T01:02:03+00:00', action: 'USER_CREATE', summary: 'x' }, { id: 'LOG-G2', unit_id: null, occurred_at: '2026-02-03T01:02:04+00:00', action: 'USER_CREATE', summary: 'y' }] } };
}

function setup({ items, apiOpts = {}, worldOpts = {} } = {}) {
  const data = dataset({ items });
  const world = createWorld(worldOpts);
  world.configure({ secret: SECRET });
  const api = makeFakeApi({ secret: SECRET, units: UNITS, data, tables: TABLES, nowMs: () => world.clock.now, ...apiOpts });
  world.apiHandler = api.handler;
  world.api = api;
  world.data = data;
  return world;
}
const dayOf = (world) => new Date(world.clock.now + 7 * 3600 * 1000).toISOString().slice(0, 10);
const folderNamed = (world, name, parent) => world.drive.byName(name, parent).filter((f) => !f.trashed);
function unitFolders(world, code) {
  const root = folderNamed(world, 'CENTRAL FILE V4')[0];
  const unit = folderNamed(world, code, root.id)[0];
  return { root, unit, cermin: folderNamed(world, 'CERMIN', unit.id)[0], backup: folderNamed(world, 'BACKUP', unit.id)[0] };
}
const gunzipRows = (buf) => zlib.gunzipSync(buf).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
function packageOf(world, code, day) {
  const { backup } = unitFolders(world, code);
  return folderNamed(world, day ?? dayOf(world), backup.id)[0];
}
function readPackage(world, pkg) {
  const files = world.drive.children(pkg.id);
  const manifest = JSON.parse(files.find((f) => f.name === 'manifest.json').bytes.toString('utf8'));
  const tables = {};
  for (const [t, info] of Object.entries(manifest.tables)) {
    tables[t] = info.parts.flatMap((p) => gunzipRows(files.find((f) => f.name === p.file).bytes));
  }
  return { manifest, tables, files };
}
const runsOf = (world, kind, unit) => [...world.api.runs.values()].filter((r) => r.kind === kind && r.unit_id === unit);

// ===========================================================================
// pure logic
// ===========================================================================
test('signing: fixed vector shared with server/jobsExport.test.ts', () => {
  const w = createWorld();
  const body = plain(w.call('signJob_', 's'.repeat(64), 'TABLE_PAGE', 1800000000, 'abcdefghijklmnop', { unit_id: UNIT_A.replace(/^1+/, '4').replace(/1/g, '4'), table: 'item', after: ['ITM-1'], limit: 1000 }));
  // same params as the TS vector: unit 44444444-4444-4444-8444-444444444444
  const b2 = plain(w.call('signJob_', 's'.repeat(64), 'TABLE_PAGE', 1800000000, 'abcdefghijklmnop', { unit_id: '44444444-4444-4444-8444-444444444444', table: 'item', after: ['ITM-1'], limit: 1000 }));
  assert.equal(b2.sig, 'fa25fb9755694e94180c5e73bab1623dd19aa7cf5d08aa8a64955ee80d12b697');
  assert.deepEqual(Object.keys(b2).sort(), ['action', 'after', 'limit', 'nonce', 'sig', 'table', 'ts', 'unit_id']);
  assert.notEqual(body.sig, b2.sig);
});

test('canonicalJson matches an independent implementation and the server rules', () => {
  const w = createWorld();
  const samples = [{ b: 1, a: { d: [3, 1], c: null }, e: 'x"y\n' }, {}, [], { z: [{ b: 1, a: 2 }], y: 'é€' }, { n: -0.5, t: true, u: undefined }];
  for (const s of samples) assert.equal(w.call('canonicalJson_', s), canonicalJson(JSON.parse(JSON.stringify(s))));
  assert.equal(w.call('canonicalJson_', { b: 1, a: { d: [3, 1], c: null }, e: 'x"y' }), '{"a":{"c":null,"d":[3,1]},"b":1,"e":"x\\"y"}');
});

test('nonce: 48 chars of [A-Za-z0-9_-], unique', () => {
  const w = createWorld();
  const seen = new Set();
  for (let i = 0; i < 200; i++) { const n = w.call('newNonce_'); assert.match(n, /^[A-Za-z0-9_-]{16,64}$/); assert.equal(n.length, 48); seen.add(n); }
  assert.equal(seen.size, 200);
});

test('formula-injection guard: = + - @ (and tab/CR) start -> written as text; ordinary values untouched', () => {
  const w = createWorld();
  const g = (v) => w.call('safeCell_', v);
  for (const bad of ['=1+1', '=HYPERLINK("x")', '+SUM(A1)', '-2+3', '@SUM(1)', '\t=1', '\r=1', '==x', '-', '+', '=']) assert.equal(g(bad), "'" + bad, JSON.stringify(bad));
  for (const ok of ['biasa', 'a=b', '1+1', 'x-y', ' =1', 'Rp -5', "'sudah", '']) assert.equal(g(ok), ok, ok);
  assert.equal(g(null), '');
  assert.equal(g(undefined), '');
  assert.equal(g(0), 0);
  assert.equal(g(-5), -5);
  assert.equal(g(true), true);
  assert.equal(g(NaN), '');
  assert.equal(g({ a: '=1' }), '{"a":"=1"}');
  const d = new Date(Date.UTC(2026, 1, 3));
  assert.equal(g(d), d);
  const long = g('x'.repeat(60000));
  assert.ok(long.length < 50000 && long.endsWith('paket backup]'));
});

test('sheet names and headers: legacy names where mapped, UPPERCASE otherwise; PII columns left out of the mirror', () => {
  const w = createWorld();
  const names = Object.fromEntries(ALL.map((t) => [t, w.call('sheetNameFor_', t)]));
  assert.deepEqual(names, {
    units: 'UNIT', unit_settings: 'SETTINGS', counters: 'PENOMORAN', klasifikasi: 'MASTER_KLASIFIKASI', jenis_naskah: 'MASTER_JENIS_NASKAH', pegawai: 'MASTER_PEGAWAI',
    berkas: 'DB_BERKAS', item: 'DB_ITEM', penerimaan: 'PENERIMAAN_ARSIP', penerimaan_item: 'PENERIMAAN_ITEM', riwayat_nomor: 'RIWAYAT_NOMOR', penerimaan_cetak_log: 'LOG_CETAK_PENERIMAAN',
    folder_label_log: 'LOG_CETAK_LIDAH', karantina: 'SYSTEM_QUARANTINE', pembatalan_arsip: 'PEMBATALAN_ARSIP', drive_tasks: 'ANTREAN_DRIVE', audit_log: 'AUDIT_LOG',
  });
  assert.equal(w.call('sheetNameFor_', 'tabel_baru'), 'TABEL_BARU');
  const h = (t, c) => w.call('headerFor_', t, c);
  assert.deepEqual([h('berkas', 'id'), h('berkas', 'no_berkas_definitif'), h('berkas', 'unit_id'), h('item', 'id'), h('item', 'lampiran'), h('item', 'drive_file_url')], ['BERKAS_ID', 'NO_BERKAS_DEFINITIF', 'UNIT_UUID', 'ITEM_ID', 'LAMPIRAN_JSON', 'DRIVE_FILE_URL']);
  assert.deepEqual([h('audit_log', 'occurred_at'), h('audit_log', 'actor_email_snapshot'), h('audit_log', 'result'), h('audit_log', 'before_data')], ['TIMESTAMP', 'USER_EMAIL', 'STATUS', 'DATA_SEBELUM_JSON']);
  assert.deepEqual([h('unit_settings', 'value_type'), h('units', 'code'), h('units', 'legacy_instance_id'), h('units', 'legacy_unit_id'), h('penerimaan_cetak_log', 'id')], ['TYPE', 'UNIT_CODE', 'INSTANCE_ID', 'UNIT_ID', 'CETAK_ID']);
  const cols = plain(w.call('mirrorColumns_', 'pegawai', [{ id: 'a', nama_pegawai: 'b', nip_nik_enc: '\\x00', kontak_enc: '\\x01' }]));
  assert.deepEqual(cols.map((c) => c.header), ['PEGAWAI_ID', 'NAMA_PEGAWAI']);
});

test('extractInventory_: Drive file ids with name, size, checksum', () => {
  const w = createWorld();
  const inv = plain(w.call('extractInventory_', 'item', [{ id: 'I1', drive_file_id: 'F1', nama_file: 'a.pdf', drive_file_size_bytes: 10, drive_file_sha256: 'h', mime_type: 'application/pdf' }, { id: 'I2', drive_file_id: null }]));
  assert.deepEqual(inv, [{ source: 'item', source_id: 'I1', kind: 'FILE', file_id: 'F1', name: 'a.pdf', size: 10, sha256: 'h', md5: null, mime: 'application/pdf' }]);
  const rcv = plain(w.call('extractInventory_', 'penerimaan', [{ id: 'R', bukti_ttd_file_id: 'T', bukti_ttd_nama: 't.pdf', bukti_ttd_size_bytes: 3, bukti_ttd_md5: 'm', batal_bukti_file_id: 'B' }]));
  assert.deepEqual(rcv.map((x) => [x.source, x.file_id, x.md5]), [['penerimaan.bukti_ttd', 'T', 'm'], ['penerimaan.batal_bukti', 'B', null]]);
  assert.equal(plain(w.call('extractInventory_', 'berkas', [{ id: 'B', drive_folder_id: 'FO', judul_berkas: 'j' }]))[0].kind, 'FOLDER');
  assert.equal(plain(w.call('extractInventory_', 'karantina', [{ id: 'K', object_type: 'FOLDER', object_id: 'KF' }]))[0].kind, 'FOLDER');
  assert.deepEqual(plain(w.call('extractInventory_', 'audit_log', [{ id: 'x', object_id: 'y' }])), []);
});

test('keysetAfter_ and part names', () => {
  const w = createWorld();
  assert.deepEqual(plain(w.call('keysetAfter_', ['id'], { id: 'X', a: 1 })), ['X']);
  assert.deepEqual(plain(w.call('keysetAfter_', ['scope', 'year'], { scope: 'TRM', year: 2026 })), ['TRM', 2026]);
  assert.equal(w.call('partName_', 'item', 3), 'item.0003.ndjson.gz');
  assert.equal(w.call('rowsToNdjson_', [{ a: 1 }, { b: 'x\ny' }]), '{"a":1}\n{"b":"x\\ny"}\n');
});

test('retention: 30 newest dailies + first package of each of the last 12 months; foreign names never listed for deletion', () => {
  const w = createWorld();
  const days = [];
  for (let i = 0; i < 400; i++) days.push(new Date(Date.UTC(2026, 10, 14) - i * DAY_MS).toISOString().slice(0, 10));
  const sel = plain(w.call('selectRetention_', [...days, 'catatan-saya', '2026-13-45', 'manifest.json'], '2026-11-14'));
  const keep = new Set(sel.keep);
  for (let i = 0; i < 30; i++) assert.ok(keep.has(days[i]), `daily ${days[i]}`);
  assert.ok(!keep.has(days[30]) || days[30].endsWith('-01'));
  const months = [];
  for (let k = 0; k < 12; k++) { const d = new Date(Date.UTC(2026, 10 - k, 1)); months.push(d.toISOString().slice(0, 7)); }
  for (const m of months) assert.ok(keep.has(`${m}-01`), `first of ${m}`);
  const nov2025 = days.filter((d) => d.startsWith('2025-11')).sort()[0];
  assert.ok(nov2025 && !keep.has(nov2025), 'the 13th month back is not kept as a monthly');
  assert.ok(sel.remove.includes(nov2025));
  assert.ok(keep.has(days.filter((d) => d.startsWith('2025-12')).sort()[0]), 'the 12th month back is');
  for (const odd of ['catatan-saya', '2026-13-45', 'manifest.json']) assert.ok(!sel.keep.includes(odd) && !sel.remove.includes(odd), odd);
  assert.equal(sel.keep.length + sel.remove.length, 400);
  // 30 + up to 12 monthlies (overlaps with the dailies are counted once)
  assert.ok(sel.keep.length >= 30 && sel.keep.length <= 42, String(sel.keep.length));
  // first package of a month is the earliest that exists, not necessarily the 1st
  const s2 = plain(w.call('selectRetention_', ['2026-03-05', '2026-03-20', '2026-04-02'], '2026-11-14'));
  assert.deepEqual(s2.keep.sort(), ['2026-03-05', '2026-03-20', '2026-04-02']); // fewer than 30: all kept
  const many = [];
  for (let i = 0; i < 45; i++) many.push(new Date(Date.UTC(2026, 10, 14) - i * DAY_MS).toISOString().slice(0, 10));
  many.push('2026-03-05', '2026-03-20');
  const s3 = plain(w.call('selectRetention_', many, '2026-11-14'));
  assert.ok(s3.keep.includes('2026-03-05') && !s3.keep.includes('2026-03-20'));
  assert.deepEqual(plain(w.call('selectRetention_', [], '2026-11-14')), { keep: [], remove: [] });
});

test('manifest: per-table rows, parts with sha256, inventory, total', () => {
  const w = createWorld();
  const m = plain(w.call('buildManifest_',
    { createdAt: '2026-11-15T01:10:00+07:00', day: '2026-11-15', unit: { id: UNIT_A, code: 'BAU', name: 'B' }, schemaVersion: '0022', tables: ['berkas', 'item', 'karantina'] },
    [{ table: 'item', file: 'item.0002.ndjson.gz', rows: 5, bytes: 50, sha256: 'b' }, { table: 'item', file: 'item.0001.ndjson.gz', rows: 1000, bytes: 900, sha256: 'a' },
      { table: 'berkas', file: 'berkas.0001.ndjson.gz', rows: 2, bytes: 20, sha256: 'c' }, { table: '_drive_inventory', file: '_drive_inventory.0001.ndjson.gz', rows: 7, bytes: 9, sha256: 'd' }]));
  assert.equal(m.format, 'CFBACKUP1');
  assert.equal(m.schema_version, '0022');
  assert.equal(m.tables.item.rows, 1005);
  assert.deepEqual(m.tables.item.parts.map((p) => p.file), ['item.0001.ndjson.gz', 'item.0002.ndjson.gz']);
  assert.deepEqual(m.tables.karantina, { rows: 0, parts: [] });
  assert.equal(m.total_rows, 1007);
  assert.equal(m.drive_inventory.rows, 7);
});

test('reports (DAFTAR BERKAS / DAFTAR ISI BERKAS): filters, order, counts, security default', () => {
  const w = createWorld();
  const berkas = [
    { BERKAS_ID: 'B2', NO_BERKAS_DEFINITIF: 2, KODE_KLASIFIKASI_SNAPSHOT: 'KU.02.01', JUDUL_BERKAS: 'Dua', KURUN_WAKTU: '2025', STATUS_RETENSI: 'H-3', NO_FILLING_KABINET: 'K1', NO_LACI: 'L2', BATAS_AKTIF: '2030-01-01', KLASIFIKASI_KEAMANAN_AKSES: 'RAHASIA', IS_DELETED: false, STATUS_PEMINDAHAN: '' },
    { BERKAS_ID: 'B1', NO_BERKAS_DEFINITIF: 1, KODE_KLASIFIKASI_SNAPSHOT: 'PR', JUDUL_BERKAS: 'Satu', KURUN_WAKTU: '2024', STATUS_RETENSI: 'AKTIF', IS_DELETED: false },
    { BERKAS_ID: 'B3', NO_BERKAS_DEFINITIF: 3, IS_DELETED: true },
    { BERKAS_ID: 'B4', NO_BERKAS_DEFINITIF: 4, STATUS_PEMINDAHAN: 'sudah dipindahkan', IS_DELETED: false },
    { BERKAS_ID: 'B5', NO_BERKAS_DEFINITIF: '', IS_DELETED: false },
  ];
  const items = [
    { ITEM_ID: 'I3', BERKAS_ID: 'B2', NO_ITEM_DEFINITIF: 1, NO_BERKAS_SNAPSHOT: 2, JUMLAH_HALAMAN: 4, KODE_KLASIFIKASI_SNAPSHOT: 'KU.02.01', URAIAN_LENGKAP: '=bad', TAHUN_KURUN_WAKTU: 2025, TINGKAT_PERKEMBANGAN: 'ASLI', IS_DELETED: false, KLASIFIKASI_KEAMANAN_AKSES: '' },
    { ITEM_ID: 'I1', BERKAS_ID: 'B1', NO_ITEM_DEFINITIF: 2, NO_BERKAS_SNAPSHOT: 1, JUMLAH_HALAMAN: 3, IS_DELETED: false },
    { ITEM_ID: 'I2', BERKAS_ID: 'B1', NO_ITEM_DEFINITIF: 1, NO_BERKAS_SNAPSHOT: 1, JUMLAH_HALAMAN: 2, IS_DELETED: false, DRIVE_FILE_URL: 'https://x' },
    { ITEM_ID: 'X', BERKAS_ID: 'B3', NO_ITEM_DEFINITIF: 1, NO_BERKAS_SNAPSHOT: 3, IS_DELETED: false },
    { ITEM_ID: 'Y', BERKAS_ID: 'B1', NO_ITEM_DEFINITIF: 9, NO_BERKAS_SNAPSHOT: 1, IS_DELETED: true },
    { ITEM_ID: 'Z', BERKAS_ID: 'B1', NO_ITEM_DEFINITIF: '', NO_BERKAS_SNAPSHOT: 1, IS_DELETED: false },
  ];
  const r = plain(w.call('buildReports_', berkas, items));
  assert.deepEqual(r.berkasRows.map((x) => x[0]), [1, 2]);
  assert.deepEqual(r.berkasRows[0], [1, 'PR', '', '', 'Satu', '2024', 2, 5, 'AKTIF']);
  assert.deepEqual(r.berkasRows[1], [2, 'KU', '02', '02.01', 'Dua', '2025', 1, 4, 'H-3']);
  assert.deepEqual(r.itemRows.map((x) => [x[0], x[1]]), [[1, 1], [1, 2], [2, 1]]);
  assert.equal(r.itemRows[2][14], 'RAHASIA'.replace('RAHASIA', 'RAHASIA'), 'item has no own class -> parent B2 RAHASIA? item class is empty string');
  assert.equal(r.itemRows[0][14], 'BIASA/TERBUKA');
  assert.equal(r.itemRows[0][19], 'https://x');
  assert.equal(r.itemRows[2][11], 'K1');
  assert.equal(r.itemRows[2][7], '2025');
  assert.equal(r.itemRows[0].length, 20);
  assert.equal(r.berkasRows[0].length, 9);
});

test('state size guard and error sanitising keep secrets/URLs out', () => {
  const w = createWorld();
  assert.throws(() => w.call('setJson_', 'JOB_STATE', { x: 'y'.repeat(9000) }), /terlalu besar/);
  const e = w.call('sanitizeError_', new Error('gagal https://x.example/api?token=abc Bearer ya29.AAAA ' + 'f'.repeat(64)));
  assert.ok(!/https?:|ya29|f{40}/.test(e), e);
});

// ===========================================================================
// manifest / source hygiene
// ===========================================================================
test('manifest: scopes are exactly the four allowed, no web app; the source exposes no entry point', () => {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname, 'appsscript.json'), 'utf8'));
  assert.deepEqual(m.oauthScopes, [
    'https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/script.external_request', 'https://www.googleapis.com/auth/script.scriptapp',
  ]);
  assert.ok(!('webapp' in m), 'no web app block');
  assert.equal(m.timeZone, 'Asia/Jakarta');
  assert.ok(!/\bdoGet\b|\bdoPost\b/.test(SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), 'no doGet/doPost');
  assert.ok(!/DriveApp|MailApp|GmailApp|DocumentApp|ContentService|HtmlService/.test(SOURCE.replace(/\/\*[\s\S]*?\*\//g, '')), 'only the services the scopes cover');
  assert.ok(!/\.setSharing|addEditor|addViewer|setPermission/.test(SOURCE), 'never changes sharing');
  assert.ok(!/drive\/v3\/(permissions|about)|files\/[^'"]*\/(copy|export)|\/emptyTrash/.test(SOURCE), 'no permission/copy/export/emptyTrash');
});

test('setupMirror: strong secret, stored once, logged once; second run keeps it; rotateJobSecret replaces it', () => {
  const w = createWorld();
  const s = w.call('setupMirror');
  assert.match(s, /^[0-9a-f]{96}$/);
  assert.equal(w.props.get('JOB_SECRET'), s);
  assert.equal(w.logs.filter(([, m]) => m.includes(s)).length, 2); // Logger + console, once each
  assert.equal(w.call('setupMirror'), null);
  assert.equal(w.props.get('JOB_SECRET'), s);
  const s2 = w.call('rotateJobSecret');
  assert.notEqual(s2, s);
  assert.equal(w.props.get('JOB_SECRET'), s2);
  assert.ok(!w.logs.some(([, m]) => m.includes('ya29')), 'no token in logs');
  assert.ok(w.fetchLog.every((f) => f.url.startsWith('https://www.googleapis.com/drive/v3/files?pageSize=1')), 'setup only checks Drive access');
});

test('setBaseUrl: https origin only', () => {
  const w = createWorld();
  assert.equal(w.call('setBaseUrl', 'https://central-file.pages.dev/'), 'https://central-file.pages.dev');
  assert.equal(w.props.get('BASE_URL'), 'https://central-file.pages.dev');
  assert.equal(w.call('setBaseUrl', ' https://arsip.uinsa.ac.id '), 'https://arsip.uinsa.ac.id');
  for (const bad of ['http://x.example', 'central-file.pages.dev', 'https://localhost', 'https://a.example/api', 'https://u:p@a.example', 'javascript:alert(1)', '', null, 'https://a.example/?x=1']) {
    assert.throws(() => w.call('setBaseUrl', bad), /Alamat tidak valid/, String(bad));
  }
  assert.equal(w.props.get('BASE_URL'), 'https://arsip.uinsa.ac.id');
});

test('installNightlyTrigger: exactly one daily trigger at 01:00, idempotent, repairs duplicates; removeTriggers', () => {
  const w = createWorld();
  assert.equal(w.call('installNightlyTrigger'), 'DIPASANG');
  assert.equal(w.triggers.length, 1);
  assert.deepEqual({ h: w.triggers[0].handler, d: w.triggers[0].everyDays, at: w.triggers[0].atHour }, { h: 'nightlyMirror', d: 1, at: 1 });
  assert.equal(w.call('installNightlyTrigger'), 'ADA');
  assert.equal(w.triggers.length, 1);
  w.triggers.push({ id: 'dup', handler: 'nightlyMirror' }, { id: 'other', handler: 'somethingElse' });
  assert.equal(w.call('installNightlyTrigger'), 'DIPASANG');
  assert.equal(w.triggers.filter((t) => t.handler === 'nightlyMirror').length, 1);
  assert.ok(w.triggers.some((t) => t.handler === 'somethingElse'), 'unrelated triggers untouched');
  w.call('removeTriggers');
  assert.deepEqual(w.triggers.map((t) => t.handler), ['somethingElse']);
});

// ===========================================================================
// the job
// ===========================================================================
test('full night: mirror + backup for every unit, counts match, nothing half-written, nothing touched but our own files', () => {
  const w = setup();
  const foreign = w.drive.addForeign({ name: 'Arsip PDF lama.pdf' });
  assert.equal(w.call('runNow'), 'DONE');
  const day = dayOf(w);
  assert.equal(day, '2026-11-15');

  // runs: one MIRROR and one BACKUP per real unit, one BACKUP for the platform pseudo unit; all SUCCESS
  assert.equal(runsOf(w, 'MIRROR', UNIT_A).length, 1);
  assert.equal(runsOf(w, 'BACKUP', 'GLOBAL').length, 1);
  assert.equal(runsOf(w, 'MIRROR', 'GLOBAL').length, 0);
  assert.ok([...w.api.runs.values()].every((r) => r.status === 'SUCCESS'));
  const mA = runsOf(w, 'MIRROR', UNIT_A)[0];
  assert.match(mA.mirror_url, /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]+\/edit$/);
  assert.equal(mA.stats.tables.item, 2300);
  assert.equal(mA.stats.total_rows, Object.values(w.data[UNIT_A]).reduce((n, r) => n + r.length, 0));

  // folders: CENTRAL FILE V4/<unit>/CERMIN and /BACKUP
  const fa = unitFolders(w, 'BAU');
  assert.ok(fa.cermin && fa.backup);
  const ss = folderNamed(w, 'CERMIN CENTRAL FILE – BAU', fa.cermin.id);
  assert.equal(ss.length, 1);
  assert.equal(ss[0].id, mA.mirror_file_id);
  assert.equal(folderNamed(w, 'CERMIN CENTRAL FILE – LPM', unitFolders(w, 'LPM').cermin.id).length, 1);
  assert.equal(w.drive.children(unitFolders(w, '_PLATFORM').backup.id).length, 1, 'platform: backup only');

  // mirror tabs: reports first, legacy names, info last, no temp tabs, warning-only protection everywhere
  const tabs = w.sheetsBook.tabs(ss[0].id);
  assert.deepEqual(tabs.slice(0, 4), ['DAFTAR BERKAS', 'DAFTAR ISI BERKAS', 'UNIT', 'SETTINGS']);
  assert.equal(tabs.at(-1), '_INFO');
  assert.ok(tabs.includes('DB_ITEM') && tabs.includes('MASTER_PEGAWAI') && tabs.includes('AUDIT_LOG'));
  assert.ok(tabs.every((t) => !t.startsWith('~')) && !tabs.includes('Sheet1'));
  for (const t of tabs) {
    const raw = w.sheetsBook.raw(ss[0].id, t);
    assert.equal(raw.hidden, false, t);
    assert.equal(raw.protections.length, 1, t);
    assert.equal(raw.protections[0].warningOnly, true, t);
  }
  assert.equal(w.sheetsBook.formulaCells, 0, 'no cell is ever interpreted as a formula');
  const items = w.sheetsBook.read(ss[0].id, 'DB_ITEM');
  assert.equal(items.length, 2301);
  assert.equal(items[0][0], 'ITEM_ID');
  assert.ok(items[0].includes('NO_SURAT_DISPLAY') && items[0].includes('UNIT_UUID'));
  const colSurat = items[0].indexOf('NO_SURAT_DISPLAY');
  assert.equal(items[7][colSurat], '\'=HYPERLINK("http://evil.example","klik")');
  assert.equal(items[8][items[0].indexOf('URAIAN_LENGKAP')], "'-2+3 pengeluaran");
  assert.ok(String(items[10][items[0].indexOf('URAIAN_LENGKAP')]).length < 50000);
  const peg = w.sheetsBook.read(ss[0].id, 'MASTER_PEGAWAI');
  assert.ok(!peg[0].some((h) => /_ENC$/.test(h)), 'encrypted PII columns are not mirrored');
  // reports
  const rb = w.sheetsBook.read(ss[0].id, 'DAFTAR BERKAS');
  assert.equal(rb[3][0], 'No. Berkas');
  assert.deepEqual(rb.slice(4).map((r) => r[0]), [1, 2]);
  assert.equal(rb[4][6], 1150, 'item count of berkas 1');
  assert.equal(w.sheetsBook.read(ss[0].id, 'DAFTAR ISI BERKAS').length, 4 + 2300);
  const info = w.sheetsBook.read(ss[0].id, '_INFO');
  assert.ok(info.some((r) => String(r[1]).includes('HANYA-BACA') || String(r[0]).includes('HANYA-BACA')));
  assert.ok(info.some((r) => r[0] === 'DB_ITEM' && r[1] === 2300));
  // empty table -> note tab
  assert.deepEqual(w.sheetsBook.read(unitFolders(w, 'LPM') && runsOf(w, 'MIRROR', UNIT_B)[0].mirror_file_id, 'DB_ITEM'), [['(kosong)']]);

  // backup package
  const pkg = packageOf(w, 'BAU');
  assert.ok(pkg);
  const { manifest, tables, files } = readPackage(w, pkg);
  assert.equal(manifest.format, 'CFBACKUP1');
  assert.equal(manifest.schema_version, '0022');
  assert.equal(manifest.day, day);
  assert.deepEqual(manifest.unit, { id: UNIT_A, code: 'BAU', name: 'Biro Administrasi Umum' });
  assert.equal(manifest.tables.item.rows, 2300);
  assert.equal(manifest.tables.item.parts.length, 3, '1000 + 1000 + 300');
  assert.deepEqual(manifest.tables.item.parts.map((p) => p.rows), [1000, 1000, 300]);
  for (const t of ALL) assert.deepEqual(tables[t], w.data[UNIT_A][t], `${t} round-trips byte for byte through gzip/NDJSON`);
  for (const t of Object.values(manifest.tables)) for (const p of t.parts) {
    const f = files.find((x) => x.name === p.file);
    assert.equal(crypto.createHash('sha256').update(f.bytes).digest('hex'), p.sha256, p.file);
    assert.equal(f.bytes.length, p.bytes);
  }
  assert.equal(manifest.total_rows, mA.stats.total_rows);
  const invFiles = manifest.drive_inventory.parts.flatMap((p) => gunzipRows(files.find((x) => x.name === p.file).bytes));
  assert.equal(invFiles.length, manifest.drive_inventory.rows);
  assert.equal(invFiles.filter((x) => x.source === 'item').length, 766);
  assert.ok(invFiles.some((x) => x.source === 'penerimaan.bukti_ttd' && x.file_id === 'ttdfile1abcdefghij'));
  assert.ok(invFiles.some((x) => x.source === 'berkas' && x.kind === 'FOLDER'));
  assert.equal(readPackage(w, packageOf(w, '_PLATFORM')).tables.audit_log.length, 2);
  assert.equal(runsOf(w, 'BACKUP', UNIT_A)[0].backup_file_id, pkg.id);

  // hygiene: only our own files were touched, no temp folders left, no triggers left, no token in logs, lock released
  for (const e of w.drive.log.filter((x) => x.mutates)) assert.notEqual(e.mutates, foreign);
  assert.ok(![...w.drive.files.values()].some((f) => !f.foreign && !f.trashed && f.name.startsWith('_tmp-')));
  assert.equal(w.triggers.length, 0);
  assert.equal(w.props.get('JOB_STATE') ?? null, null);
  assert.ok(!JSON.stringify(w.logs).includes('ya29'));
  assert.ok(!JSON.stringify(w.logs).includes(SECRET));
  assert.ok(w.lockReleased >= 1);
  // requests: signed, one unit per request, the table list comes from the server, limit 1000, arrays as cursors
  const pages = w.api.requests.filter((r) => r.action === 'TABLE_PAGE');
  assert.ok(pages.every((r) => r.limit === 1000 && (r.unit_id === UNIT_A || r.unit_id === UNIT_B || r.unit_id === 'GLOBAL') && ALL.includes(r.table)));
  assert.ok(pages.filter((r) => r.after).every((r) => Array.isArray(r.after)));
});

test('a second night replaces the mirror atomically and keeps one protection per tab; same-day rerun replaces the package', () => {
  const w = setup({ items: 30 });
  w.call('runNow');
  const id = runsOf(w, 'MIRROR', UNIT_A)[0].mirror_file_id;
  const first = w.sheetsBook.read(id, 'DB_ITEM');
  // data changes, next night
  w.data[UNIT_A].item.push({ ...w.data[UNIT_A].item[0], id: 'ITM-99999', no_item_definitif: 99 });
  w.data[UNIT_A].item[0].uraian_lengkap = 'diubah';
  w.clock.now += DAY_MS;
  assert.equal(w.call('runNow'), 'DONE');
  const after = w.sheetsBook.read(id, 'DB_ITEM');
  assert.equal(after.length, first.length + 1);
  assert.equal(after[1][after[0].indexOf('URAIAN_LENGKAP')], 'diubah');
  assert.equal(w.sheetsBook.tabs(id).filter((t) => t === 'DB_ITEM').length, 1);
  assert.ok(w.sheetsBook.tabs(id).every((t) => !t.startsWith('~')));
  for (const t of w.sheetsBook.tabs(id)) assert.equal(w.sheetsBook.raw(id, t).protections.length, 1, t);
  assert.equal(w.drive.children(unitFolders(w, 'BAU').cermin.id).length, 1, 'still one spreadsheet');
  assert.equal(folderNamed(w, dayOf(w), unitFolders(w, 'BAU').backup.id).length, 1);
  // same day again -> still exactly one package for that day, with the newest content
  w.data[UNIT_A].item.pop();
  assert.equal(w.call('runNow'), 'DONE');
  const pk = folderNamed(w, dayOf(w), unitFolders(w, 'BAU').backup.id);
  assert.equal(pk.length, 1);
  assert.equal(readPackage(w, pk[0]).manifest.tables.item.rows, 30);
  assert.equal(folderNamed(w, '2026-11-15', unitFolders(w, 'BAU').backup.id).length, 1, 'night 1 package kept');
});

test('retry: 503 / network errors are retried with a FRESH nonce each time; 4xx is not retried', () => {
  let n = 0;
  const w = setup({ items: 5, worldOpts: { fetchFault: (url) => { if (url.endsWith('/api/jobs/export') && n++ < 2) return n === 2 ? 'throw' : { code: 503, text: 'busy' }; return null; } } });
  assert.equal(w.call('runNow'), 'DONE');
  const nonces = w.api.requests.map((r) => r.nonce);
  assert.equal(new Set(nonces).size, nonces.length, 'every attempt used a new nonce');
  assert.ok(w.sleeps >= 2);
  // 401 (bad secret) is not retried and fails the whole job loudly
  const w2 = setup({ items: 5 });
  w2.props.set('JOB_SECRET', 'X'.repeat(48));
  assert.throws(() => w2.call('runNow'), /ditolak \(HTTP 401 JOB_DENIED\)/);
  assert.equal(w2.api.requests.length, 1, 'one attempt only');
  assert.equal(w2.lockReleased, 1);
});

test('missing configuration fails clearly before any request', () => {
  const w = createWorld();
  assert.throws(() => w.call('runNow'), /JOB_SECRET belum dibuat/);
  w.props.set('JOB_SECRET', 'S'.repeat(48));
  assert.throws(() => w.call('runNow'), /Alamat aplikasi belum diisi/);
  assert.equal(w.fetchLog.length, 0);
});

test('lock busy: nothing runs', () => {
  const w = setup({ items: 5 });
  w.lockBusy = true;
  assert.equal(w.call('runNow'), 'LOCKED');
  assert.equal(w.api.requests.length, 0);
});

// -- time budget / resume ---------------------------------------------------
function finishInSlices(w, budgetSlices = 40) {
  let outcome = w.call('runNow');
  let slices = 1;
  while (outcome === 'CONTINUE' && slices < budgetSlices) {
    assert.equal(w.triggers.filter((t) => t.handler === 'continueMirror').length, 1, 'exactly one continuation trigger');
    assert.equal(w.triggers.find((t) => t.handler === 'continueMirror').afterMs, 60000);
    outcome = w.call('continueMirror');
    slices++;
  }
  return { outcome, slices };
}

test('timeout mid-table: the run stops, schedules a continuation, resumes from the saved cursor and ends identical to an uninterrupted run', () => {
  const baseline = setup({ items: 2300 });
  baseline.call('runNow');

  const w = setup({ items: 2300, worldOpts: { fetchFault: (url, _p, world) => { if (url.endsWith('/api/jobs/export')) world.clock.now += 40000; return null; } } });
  const first = w.call('runNow');
  assert.equal(first, 'CONTINUE');
  const st = JSON.parse(w.props.get('JOB_STATE'));
  assert.equal(st.step, 'TABLE');
  assert.ok(st.u.ti >= 0 && st.ui === 0);
  assert.equal(w.triggers.length, 1);
  const { outcome, slices } = finishInSlices(w);
  assert.equal(outcome, 'DONE');
  assert.ok(slices >= 5, `expected several continuations, got ${slices}`);
  assert.equal(w.triggers.length, 0, 'no continuation trigger left behind');
  assert.equal(w.props.get('JOB_STATE') ?? null, null);

  // timeout in the MIDDLE of the item table (cursor persisted between executions): same final package + mirror
  for (const code of ['BAU', 'LPM', '_PLATFORM']) {
    const a = readPackage(baseline, packageOf(baseline, code));
    const b = readPackage(w, packageOf(w, code));
    assert.deepEqual(b.tables, a.tables, code);
    assert.deepEqual(b.manifest.tables, a.manifest.tables, code);
  }
  const idB = runsOf(baseline, 'MIRROR', UNIT_A)[0].mirror_file_id;
  const idW = runsOf(w, 'MIRROR', UNIT_A)[0].mirror_file_id;
  for (const t of baseline.sheetsBook.tabs(idB)) {
    if (t === '_INFO') continue;
    const norm = (rows) => plain(rows).map((r, i) => (String(r[0]).startsWith('Dibuat otomatis') ? ['(waktu pembuatan)'] : r));
    assert.deepEqual(norm(w.sheetsBook.read(idW, t)), norm(baseline.sheetsBook.read(idB, t)), t);
  }
  assert.equal(w.sheetsBook.formulaCells, 0);
  assert.ok([...w.api.runs.values()].every((r) => r.status === 'SUCCESS'));
  // and no mirror was visible half-written: the visible tabs never contained a "~" temp tab or a partial item tab
  assert.equal(w.sheetsBook.read(idW, 'DB_ITEM').length, 2301);
});

test('the timeout is detected between pages of ONE table (state shows a cursor inside item)', () => {
  const w = setup({ items: 2300, worldOpts: { fetchFault: (url, _p, world) => { if (url.endsWith('/api/jobs/export')) world.clock.now += 100000; return null; } } });
  let seenMidItem = false;
  let outcome = w.call('runNow');
  for (let i = 0; i < 60 && outcome === 'CONTINUE'; i++) {
    const st = JSON.parse(w.props.get('JOB_STATE'));
    if (st.step === 'TABLE' && st.u.after && st.u.written > 0 && st.u.written < 2300 && st.u.ti === 7) seenMidItem = true;
    outcome = w.call('continueMirror');
  }
  assert.equal(outcome, 'DONE');
  assert.ok(seenMidItem, 'a continuation started in the middle of the item table with a keyset cursor');
});

test('crash between "part uploaded" and "state saved": the replayed page overwrites its part, no duplicates, no gaps', () => {
  const w = setup({ items: 2300 });
  // drive the machine by hand through stepOnce_, discarding one step's effect on the saved state (= process death)
  const ctx = w.ctx;
  let state = ctx.freshState_(w.clock.now);
  ctx.saveState_(state);
  let crashed = false;
  for (let guard = 0; guard < 400; guard++) {
    state = ctx.loadState_();
    const live = state.step === 'TABLE' && state.u && state.u.ti === 7 && state.u.written === 1000 && !crashed;
    const more = ctx.stepOnce_(state); // uploads page 2 of item ...
    if (live) { crashed = true; continue; } // ... but its state is NOT saved: a "crash"
    ctx.saveState_(state);
    if (!more) break;
  }
  assert.ok(crashed);
  const pkg = packageOf(w, 'BAU');
  const { manifest, tables, files } = readPackage(w, pkg);
  assert.deepEqual(tables.item, w.data[UNIT_A].item);
  const itemFiles = files.filter((f) => f.name.startsWith('item.'));
  assert.deepEqual(itemFiles.map((f) => f.name).sort(), ['item.0001.ndjson.gz', 'item.0002.ndjson.gz', 'item.0003.ndjson.gz']);
  assert.equal(manifest.tables.item.rows, 2300);
});

test('heavy phases (reports / swap / manifest) are not started with less than two minutes left', () => {
  // every API call costs 1 s of fake time; the first REPORTS phase is reached after more than 30 s with less than 120 s of a 150 s budget left
  const w = setup({ items: 20, worldOpts: { fetchFault: (url, _p, world) => { if (url.endsWith('/api/jobs/export')) world.clock.now += 1000; return null; } } });
  const outcome = w.ctx.runJob_({ budgetMs: 150000 });
  assert.equal(outcome, 'CONTINUE');
  const st = JSON.parse(w.props.get('JOB_STATE'));
  assert.equal(st.step, 'REPORTS', 'paused BEFORE the heavy phase');
  assert.equal(w.triggers.length, 1);
  // the continuation starts with a fresh budget and finishes
  assert.equal(w.call('continueMirror'), 'DONE');
  assert.equal(w.triggers.length, 0);
});

test('swap interrupted halfway (execution killed) resumes without overwriting finished tabs with placeholders', () => {
  const w = setup({ items: 20 });
  const ctx = w.ctx;
  let state = ctx.freshState_(w.clock.now);
  ctx.saveState_(state);
  while (state.step !== 'SWAP') { ctx.stepOnce_(state); ctx.saveState_(state); }
  const id = state.u.ssId;
  let renames = 0;
  w.sheetsBook.hooks.beforeSetName = () => { if (++renames === 7) throw new Error('execution killed'); };
  assert.throws(() => ctx.stepSwap_(state), /execution killed/); // called directly: a real kill cannot be caught either
  w.sheetsBook.hooks.beforeSetName = null;
  const persisted = JSON.parse(w.props.get('JOB_STATE'));
  assert.equal(persisted.step, 'SWAP');
  assert.ok(persisted.u.si >= 2 && persisted.u.si < 19, `swap progress was saved (si=${persisted.u.si})`);
  assert.equal(w.call('continueMirror'), 'DONE');
  const tabs = w.sheetsBook.tabs(id);
  assert.ok(tabs.every((t) => !t.startsWith('~')), tabs.join(','));
  assert.equal(w.sheetsBook.read(id, 'DB_ITEM').length, 21);
  assert.equal(w.sheetsBook.read(id, 'DB_BERKAS').length, 6);
  assert.equal(w.sheetsBook.read(id, 'DAFTAR BERKAS')[4][0], 1);
  for (const t of tabs) assert.equal(w.sheetsBook.raw(id, t).protections.length, 1, t);
  assert.ok([...w.api.runs.values()].every((r) => r.status === 'SUCCESS'));
});

// -- failures ----------------------------------------------------------------
test('count mismatch twice -> that unit FAILS (runs FAILED, no package, old mirror kept), the other units still succeed, the job reports the failure', () => {
  const w = setup({ items: 40 });
  w.call('runNow'); // night 1 ok
  const mirrorId = runsOf(w, 'MIRROR', UNIT_A)[0].mirror_file_id;
  const before = plain(w.sheetsBook.read(mirrorId, 'DB_ITEM'));
  w.clock.now += DAY_MS;
  // server claims 41 item rows but only serves 40 (e.g. rows hidden/lost): never acceptable
  const realHandler = w.api.handler;
  w.apiHandler = (body, p) => {
    const out = realHandler(body, p);
    if (body.action === 'TABLE_PAGE' && body.table === 'item' && body.unit_id === UNIT_A && !body.after) out.headers = { 'X-Total-Count': '41' };
    return out;
  };
  w.data[UNIT_A].item[0].uraian_lengkap = 'BARU';
  assert.throws(() => w.call('runNow'), /1 unit gagal: BAU/);
  const day2 = dayOf(w);
  const runsA = [...runsOf(w, 'MIRROR', UNIT_A), ...runsOf(w, 'BACKUP', UNIT_A)];
  assert.equal(runsA.filter((r) => r.status === 'FAILED').length, 2);
  const failed = runsOf(w, 'MIRROR', UNIT_A).find((r) => r.status === 'FAILED');
  assert.match(failed.error, /Jumlah baris tidak cocok untuk item: ditulis 40, server 41/);
  assert.equal(folderNamed(w, day2, unitFolders(w, 'BAU').backup.id).length, 0, 'no package for the failed unit');
  assert.ok(![...w.drive.files.values()].some((f) => !f.foreign && !f.trashed && f.name.startsWith('_tmp-')), 'partial package removed');
  assert.deepEqual(plain(w.sheetsBook.read(mirrorId, 'DB_ITEM')), before, 'the visible mirror still shows the last good night');
  // other units unaffected
  assert.equal(runsOf(w, 'MIRROR', UNIT_B).at(-1).status, 'SUCCESS');
  assert.equal(runsOf(w, 'BACKUP', 'GLOBAL').at(-1).status, 'SUCCESS');
  assert.ok(packageOf(w, 'LPM'));
  assert.equal(w.props.get('JOB_STATE') ?? null, null);
});

test('a transient mismatch (one extra page attempt) is retried once from the start and then succeeds', () => {
  const w = setup({ items: 40 });
  let once = true;
  const realHandler = w.api.handler;
  w.apiHandler = (body, p) => {
    const out = realHandler(body, p);
    if (body.action === 'TABLE_PAGE' && body.table === 'item' && body.unit_id === UNIT_A && !body.after && once) { once = false; out.headers = { 'X-Total-Count': '39' }; }
    return out;
  };
  assert.equal(w.call('runNow'), 'DONE');
  assert.equal(readPackage(w, packageOf(w, 'BAU')).manifest.tables.item.rows, 40);
  assert.equal(w.drive.children(packageOf(w, 'BAU').id).filter((f) => f.name.startsWith('item.')).length, 1);
  assert.ok([...w.api.runs.values()].every((r) => r.status === 'SUCCESS'));
});

test('server without a total count header -> the unit fails (nothing can be verified)', () => {
  const w = setup({ items: 5 });
  const realHandler = w.api.handler;
  w.apiHandler = (body, p) => { const out = realHandler(body, p); if (body.action === 'TABLE_PAGE' && body.unit_id === UNIT_B) out.headers = {}; return out; };
  assert.throws(() => w.call('runNow'), /1 unit gagal: LPM/);
  assert.match(runsOf(w, 'MIRROR', UNIT_B)[0].error, /jumlah total tidak diberikan server/);
  assert.equal(runsOf(w, 'MIRROR', UNIT_A)[0].status, 'SUCCESS');
});

test('a server that caps rows per page (max-rows 700) still yields every row', () => {
  const w = setup({ items: 2300, apiOpts: { maxRows: 700 } });
  assert.equal(w.call('runNow'), 'DONE');
  const m = readPackage(w, packageOf(w, 'BAU'));
  assert.deepEqual(m.tables.item, w.data[UNIT_A].item);
  assert.ok(m.manifest.tables.item.parts.every((p) => p.rows <= 700));
});

test('stale state (> 12 h) is abandoned: its runs are reported FAILED and the job starts fresh', () => {
  const w = setup({ items: 5, worldOpts: { fetchFault: (url, _p, world) => { if (url.endsWith('/api/jobs/export')) world.clock.now += 100000; return null; } } });
  assert.equal(w.call('runNow'), 'CONTINUE');
  const old = JSON.parse(w.props.get('JOB_STATE'));
  const oldRuns = [old.u.runMirror, old.u.runBackup];
  w.clock.now += 13 * 3600 * 1000;
  w.ctx.runJob_({ budgetMs: 1e9 });
  for (const id of oldRuns) { assert.equal(w.api.runs.get(id).status, 'FAILED'); assert.match(w.api.runs.get(id).error, /Dihentikan/); }
  assert.equal(w.props.get('JOB_STATE') ?? null, null);
  assert.ok(packageOf(w, 'BAU'));
});

test('retention after a run: old packages trimmed, foreign/unmarked folders untouched, only our own folders are trashed', () => {
  const w = setup({ items: 5 });
  w.call('runNow'); // creates the folders
  const backup = unitFolders(w, 'BAU').backup;
  const mk = (name, props) => { const r = JSON.parse(w.drive.handle('post', 'https://www.googleapis.com/drive/v3/files', { payload: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [backup.id], appProperties: props }) }).text); return r.id; };
  const old = [];
  for (let i = 1; i <= 60; i++) old.push(new Date(Date.UTC(2026, 10, 15) - i * DAY_MS).toISOString().slice(0, 10));
  const ids = Object.fromEntries(old.map((d) => [d, mk(d, { cfBackup: '1' })]));
  const unmarked = mk('2020-01-01', {}); // looks like a package but we did not create it
  const notes = mk('catatan-pemilik', { cfBackup: '1' });
  w.clock.now += DAY_MS;
  w.call('runNow');
  const sel = plain(w.ctx.selectRetention_(old.concat([dayOf(w), '2026-11-15']), dayOf(w)));
  const trashed = (id) => w.drive.files.get(id).trashed;
  for (const d of old) assert.equal(trashed(ids[d]), sel.remove.includes(d), d);
  assert.equal(trashed(unmarked), false);
  assert.equal(trashed(notes), false);
  assert.ok(old.filter((d) => trashed(ids[d])).length > 20, 'something was trimmed');
  assert.ok(w.drive.log.filter((e) => e.kind === 'meta' && e.meta.trashed).every((e) => !w.drive.files.get(e.mutates).foreign));
});

test('no request ever leaves for a host other than the app and the Drive API; Drive calls use the script token only', () => {
  const w = setup({ items: 5 });
  w.call('runNow');
  for (const f of w.fetchLog) assert.ok(f.url.startsWith('https://app.example.pages.dev/api/jobs/export') || f.url.startsWith('https://www.googleapis.com/'), f.url);
  assert.ok(w.fetchLog.filter((f) => f.url.includes('googleapis')).every((f) => f.headers.Authorization === 'Bearer ya29.FAKE_OAUTH'));
  assert.ok(w.fetchLog.filter((f) => f.url.includes('/api/jobs/export')).every((f) => !f.headers || !f.headers.Authorization), 'the app never receives the Drive token');
});

test('Drive listing pagination (pageToken) is followed', () => {
  const w = setup({ items: 5 });
  w.drive.pageSize = 2;
  assert.equal(w.call('runNow'), 'DONE');
  const { manifest } = readPackage(w, packageOf(w, 'BAU'));
  assert.equal(manifest.tables.item.rows, 5);
  assert.ok(w.drive.log.some((e) => /pageToken/.test(e.query || '')));
});
