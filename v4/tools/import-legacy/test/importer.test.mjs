// Importer tests against the throwaway Postgres prepared by ../test.sh.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { runImport } from '../lib/importer.mjs';
import { renderText } from '../lib/report.mjs';
import { convert } from '../lib/convert.mjs';
import { fixtureDefinition, writeFixture, FIXTURE_UNIT } from './fixture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PII_KEY = 'kunci-uji-saja-0123456789abcdef';
const pool = new pg.Pool({ max: 3 });
let dir;
let fixtureFile;

const imp = (file, extra = {}) => runImport({
  file, unitCode: FIXTURE_UNIT.code, unitName: FIXTURE_UNIT.name, piiKey: PII_KEY, ...extra
});

async function variant(name, mutate) {
  const def = fixtureDefinition();
  mutate(def);
  return writeFixture(def, join(dir, `${name}.xlsx`));
}

async function unitId(code = FIXTURE_UNIT.code) {
  return (await pool.query('select id from public.units where code = $1', [code])).rows[0]?.id;
}

const TABLES = ['unit_settings', 'klasifikasi', 'pegawai', 'berkas', 'penerimaan', 'item', 'penerimaan_item', 'riwayat_nomor', 'audit_log'];
async function snapshot(id) {
  const out = {};
  out.units = (await pool.query('select md5(t::text) h from public.units t where id = $1', [id])).rows[0].h;
  for (const t of TABLES) {
    out[t] = (await pool.query(
      `select count(*)::int n, md5(coalesce(string_agg(t::text, '|' order by t::text), '')) h from public.${t} t where unit_id = $1`, [id])).rows[0];
  }
  return out;
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cf-import-test-'));
  fixtureFile = await writeFixture(fixtureDefinition(), join(dir, 'fixture.xlsx'));
});
after(async () => {
  await pool.end();
  await rm(dir, { recursive: true, force: true });
});

test('converters: dates without day shift, serials, text formats, timestamps in Asia/Jakarta', () => {
  assert.equal(convert.date(new Date(Date.UTC(2025, 0, 15))), '2025-01-15');
  assert.equal(convert.date(45726), '2025-03-10');
  assert.equal(convert.date('10/03/2025'), '2025-03-10');
  assert.equal(convert.date('1-2-2026'), '2026-02-01');
  assert.equal(convert.date('5 Mei 2020'), '2020-05-05');
  assert.equal(convert.date('2025-03-10T23:30:00+07:00'), '2025-03-10');
  assert.equal(convert.date('2025-03-10T20:00:00Z'), '2025-03-11'); // 03:00 next day in Jakarta
  assert.throws(() => convert.date('31/02/2025'));
  assert.throws(() => convert.date('kemarin'));
  assert.equal(convert.timestamp(new Date(Date.UTC(2025, 2, 11, 10, 15))), '2025-03-11T10:15:00+07:00');
  assert.equal(convert.timestamp('15/01/2026 09:30'), '2026-01-15T09:30:00+07:00');
  assert.equal(convert.timestamp('2025-01-15T09:00:00+07:00'), '2025-01-15T09:00:00+07:00');
  assert.equal(convert.timestamp('2025-01-15 09:00'), '2025-01-15T09:00:00+07:00');
  assert.equal(convert.int('2'), 2);
  assert.throws(() => convert.int('tiga'));
  assert.equal(convert.bool('YA'), true);
  assert.equal(convert.text(''), null);
});

test('dry-run reports everything and leaves the database untouched', async () => {
  const r = await imp(fixtureFile, { dryRun: true });
  assert.equal(r.status, 'UJI_COBA_BERHASIL', r.fatal.join('\n'));
  assert.equal(r.tables.berkas.inserted, 5);
  assert.equal(await unitId(), undefined);
  assert.equal((await pool.query('select count(*)::int n from public.berkas')).rows[0].n, 0);
});

let firstReport;
test('first import: rows, statuses, dates, links and PII stored as expected', async () => {
  const r = firstReport = await imp(fixtureFile);
  assert.equal(r.status, 'BERHASIL', r.fatal.join('\n'));
  const counts = Object.fromEntries(Object.entries(r.tables).map(([t, s]) => [t, [s.read, s.inserted, s.rejected]]));
  assert.deepEqual(counts, {
    unit_settings: [10, 8, 0], klasifikasi: [6, 6, 0], pegawai: [2, 2, 0], berkas: [5, 5, 0],
    penerimaan: [3, 3, 0], item: [6, 5, 1], penerimaan_item: [4, 3, 1], riwayat_nomor: [5, 5, 0], audit_log: [5, 5, 0]
  });
  const id = await unitId();
  const q = async (sql, ...p) => (await pool.query(sql, [id, ...p])).rows;

  const [unit] = (await pool.query('select * from public.units where id = $1', [id])).rows;
  assert.equal(unit.legacy_instance_id, 'INS-UJI-0001');
  assert.equal(unit.legacy_unit_id, 'UNIT-UJI');

  // dates: Date cells, serials, dd/mm/yyyy and Indonesian month text, no day shift
  const items = Object.fromEntries((await q(`select id, to_char(tanggal_naskah, 'YYYY-MM-DD') d, tingkat_perkembangan, media_sumber,
      is_deleted, jsonb_array_length(lampiran) lamp, drive_file_url from public.item where unit_id = $1`)).map((x) => [x.id, x]));
  assert.deepEqual(Object.keys(items).sort(), ['ITM-1', 'ITM-2', 'ITM-3', 'ITM-4', 'ITM-6']);
  assert.equal(items['ITM-1'].d, '2025-01-15');
  assert.equal(items['ITM-2'].d, '2025-03-10');
  assert.equal(items['ITM-3'].d, '2026-02-01');
  assert.equal(items['ITM-6'].d, '2020-05-05');
  assert.equal(items['ITM-2'].tingkat_perkembangan, 'COPY');
  assert.equal(items['ITM-2'].media_sumber, 'AUDIO VISUAL');
  assert.equal(items['ITM-2'].lamp, 1);
  assert.equal(items['ITM-4'].is_deleted, true);
  assert.equal(items['ITM-1'].drive_file_url, 'https://drive.google.com/file/d/drv-file-1/view');

  const berkas = Object.fromEntries((await q(`select id, no_berkas_definitif no, is_deleted, status_berkas, klasifikasi_id,
      klasifikasi_keamanan_akses sec, nasib_akhir, retensi_inaktif_satuan sat, arsip_vital, to_char(batas_aktif, 'YYYY-MM-DD') ba,
      updated_at, created_at from public.berkas where unit_id = $1`)).map((x) => [x.id, x]));
  assert.equal(berkas['BRK-2'].no, 2);
  assert.equal(berkas['BRK-2'].ba, '2028-02-01');
  assert.equal(berkas['BRK-2'].nasib_akhir, 'MUSNAH');
  assert.equal(berkas['BRK-2'].sec, 'TERBATAS');
  assert.equal(berkas['BRK-2'].created_at.toISOString(), '2026-01-15T02:30:00.000Z');
  assert.equal(berkas['BRK-2'].updated_at.toISOString(), '2026-01-15T02:30:00.000Z'); // fallback to CREATED_AT
  assert.equal(berkas['BRK-1'].updated_at.toISOString(), '2025-03-11T03:15:00.000Z'); // date-time cell, 10:15 WIB
  assert.equal(berkas['BRK-1'].sat, 'TAHUN');
  assert.equal(berkas['BRK-1'].arsip_vital, true);
  assert.equal(berkas['BRK-3'].is_deleted, true);
  assert.equal(berkas['BRK-3'].no, 2);
  assert.equal(berkas['BRK-4'].no, null);
  assert.equal(berkas['BRK-4'].klasifikasi_id, null); // dangling K-HILANG cleared, reported
  assert.equal(berkas['BRK-4'].sec, 'BIASA/TERBUKA');

  const rcv = Object.fromEntries((await q('select id, status, alasan_pembatalan, dibatalkan_at, penyerah_pegawai_id from public.penerimaan where unit_id = $1')).map((x) => [x.id, x]));
  assert.equal(rcv['RCV-2'].status, 'DIBATALKAN');
  assert.equal(rcv['RCV-2'].alasan_pembatalan, 'Salah unit penyerah');
  assert.equal(rcv['RCV-2'].dibatalkan_at.toISOString(), '2026-02-04T03:00:00.000Z');
  assert.equal(rcv['RCV-3'].penyerah_pegawai_id, null);
  const [pi3] = await q("select is_deleted, status_pemberkasan, kondisi from public.penerimaan_item where unit_id = $1 and id = 'RCVI-3'");
  assert.deepEqual(pi3, { is_deleted: true, status_pemberkasan: 'DIBATALKAN', kondisi: null });
  const [pi2] = await q("select kondisi, to_char(tanggal_naskah, 'YYYY-MM-DD') d from public.penerimaan_item where unit_id = $1 and id = 'RCVI-2'");
  assert.deepEqual(pi2, { kondisi: 'RUSAK RINGAN', d: '2026-03-05' });

  const klas = Object.fromEntries((await q('select id, parent_id, aktif from public.klasifikasi where unit_id = $1')).map((x) => [x.id, x]));
  assert.equal(klas['K-KU'].parent_id, null);
  assert.equal(klas['K-KU02'].parent_id, 'K-KU');
  assert.equal(klas['K-LAMA'].aktif, false);

  const hist = Object.fromEntries((await q('select id, nomor_lama, nomor_baru from public.riwayat_nomor where unit_id = $1')).map((x) => [x.id, x]));
  assert.deepEqual(hist['HIS-3'], { id: 'HIS-3', nomor_lama: 2, nomor_baru: 1 });
  assert.equal(hist['HIS-4'].nomor_lama, null);
  assert.equal(hist['HIS-5'].nomor_lama, null);
  assert.deepEqual(r.notes.looseInt.map((x) => x.value), ['1a']);

  const audit = Object.fromEntries((await q('select id, result, occurred_at from public.audit_log where unit_id = $1')).map((x) => [x.id, x]));
  assert.deepEqual(Object.keys(audit).sort(), ['LOG-1', 'LOG-2', 'LOG-3', 'LOG-4', 'LOG-5']);
  assert.equal(audit['LOG-3'].result, 'SUCCESS');
  assert.equal(audit['LOG-2'].result, 'FAILED');
  assert.equal(audit['LOG-4'].occurred_at.toISOString(), '2026-02-04T03:00:00.000Z');

  // secret-like setting skipped and named; settings typed
  assert.deepEqual(r.skippedSecretSettings, ['RECORD_CENTER_SHARED_SECRET', 'RC_KUNCI_BERSAMA']);
  const settings = Object.fromEntries((await q('select key, value from public.unit_settings where unit_id = $1')).map((x) => [x.key, x.value]));
  assert.equal(settings.RECORD_CENTER_SHARED_SECRET, undefined);
  assert.equal(settings.AUDIT_LOG_YEAR, 2026);
  assert.equal(settings.BACKUP_DAILY_ENABLED, true);
  assert.equal(settings.RC_KUNCI_BERSAMA, undefined);
  assert.ok(!JSON.stringify(r).includes('rahasia-fiktif-jangan-diimpor'));
  assert.ok(!JSON.stringify(r).includes('nilai-rahasia-tipe'));

  // PII encrypted at rest, decryptable with the key, never in the report
  const [p] = await q("select nip_nik_enc from public.pegawai where unit_id = $1 and id = 'PGW-1'");
  assert.ok(!p.nip_nik_enc.includes(Buffer.from('199001012020121001')));
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query("select set_config('app.pii_key', $1, true)", [PII_KEY]);
    const { rows: [d] } = await c.query("select app.decrypt_pii(nip_nik_enc) v from public.pegawai where id = 'PGW-1'");
    assert.equal(d.v, '199001012020121001');
    await c.query('rollback');
  } finally { c.release(); }
  assert.deepEqual(r.piiColumnsEncrypted, ['nip_nik_enc']);
  assert.ok(!JSON.stringify(r).includes('199001012020121001'));
});

test('first import: reconciliation report (orphans, totals, legacy reports, unknown/deferred sheets, open questions)', () => {
  const r = firstReport;
  assert.deepEqual(r.orphans.rejected.map((o) => `${o.table}:${o.id}`).sort(), ['item:ITM-5', 'penerimaan_item:RCVI-4']);
  assert.deepEqual(r.orphans.linksCleared.map((o) => `${o.table}.${o.column}=${o.value}`).sort(),
    ['berkas.klasifikasi_id=K-HILANG', 'penerimaan.penyerah_pegawai_id=PGW-HILANG']);
  assert.deepEqual(r.orphans.arsipWithoutSource, [{ itemId: 'ITM-6', arsipId: 'ARS-HILANG', sumber: 'PENERIMAAN_ARSIP' }]);
  assert.deepEqual(r.duplicates, { berkasNumber: [], itemNumber: [], receiptNumber: [] });

  assert.equal(r.totals.berkasAktif, 2);
  assert.equal(r.totals.itemAktif, 3);
  assert.equal(r.totals.totalLembarItemAktif, 17);
  assert.equal(r.totals.penerimaanDibatalkan, 1);
  assert.deepEqual(r.totals.selisihJumlahPerBerkas.map((m) => [m.berkasId, m.totalHalamanTercatat, m.totalHalamanDihitung]), [['BRK-2', 5, 3]]);
  assert.equal(r.legacyReports.daftarBerkas.cocok, true);
  assert.equal(r.legacyReports.daftarIsiBerkas.cocok, true);
  assert.equal(r.dbVerification.cocokDenganEkspor, true);

  assert.deepEqual(r.unknownColumns, {
    DB_BERKAS: [{ column: 'KOLOM_LAMA_X', nonEmpty: 1 }], DB_ITEM: [{ column: 'KOLOM_TAMBAHAN', nonEmpty: 1 }]
  });
  assert.ok(r.missingOptionalColumns.DB_BERKAS.includes('MEDIA_BERKAS'));
  assert.ok(r.missingOptionalColumns.DB_BERKAS.includes('JRA_ID'));
  assert.ok(r.missingOptionalColumns.PENERIMAAN_ITEM.includes('FILE_DIGITAL_ID'));
  assert.deepEqual(r.columnOrder.DB_BERKAS.slice(0, 3), ['JUDUL_BERKAS', 'BERKAS_ID', 'NO_BERKAS_DEFINITIF']);

  assert.deepEqual(r.sheets.deferred.map((s) => [s.name, s.rows, s.sprint]), [
    ['IMPORT_STAGING', 0, null], ['LOG_CETAK_PENERIMAAN', 1, 2], ['MASTER_JENIS_NASKAH', 2, 2], ['MASTER_JRA', 0, 5],
    ['OUTBOX_RECORD_CENTER', 0, 5], ['PEMINJAMAN', 2, 4], ['SYSTEM_BACKUPS', 1, 3], ['USUL_PINDAH', 1, 5]
  ]);
  assert.deepEqual(r.sheets.unknown.map((s) => [s.name, s.rows]), [['Catatan Petugas', 1], ['DAFTAR CONTOH LAIN', 2]]);
  assert.deepEqual(r.sheets.reportsOnly.map((s) => s.name).sort(), ['DAFTAR BERKAS', 'DAFTAR ISI BERKAS']);
  assert.deepEqual(r.tables.audit_log.sheets, ['AUDIT_LOG', 'AUDIT_LOG_2025']);

  const q = (h) => r.openQuestions.find((x) => x.headersFound.includes(h) || x.question.includes(h));
  assert.deepEqual(q('LEVEL').columns.LEVEL.distinct.map((d) => d.value).sort(), ['PRIMER', 'SEKUNDER', 'TERSIER']);
  assert.deepEqual(r.openQuestions.find((x) => x.question.includes('JRA_ID')).headersFound, []);
  const pii = r.openQuestions.find((x) => x.sheet === 'MASTER_PEGAWAI');
  assert.deepEqual(pii.headersFound, ['NIP']);
  assert.equal(pii.columns.NIP.distinct, undefined);

  const text = renderText(r);
  for (const s of ['BERHASIL', 'ditunda ke sprint 4', 'RECORD_CENTER_SHARED_SECRET', 'KOLOM_LAMA_X', 'BRK-TIDAK-ADA', 'Pertanyaan terbuka']) {
    assert.ok(text.includes(s), `text report mentions ${s}`);
  }
  assert.ok(!text.includes('199001012020121001'));
});

test('real-export shapes: extra legacy columns, TYPE=SECRET, Z timestamps, audit JSON, blank UPDATED_AT kept', async () => {
  const id = await unitId();
  const q = async (sql) => (await pool.query(sql, [id])).rows;
  const klas = Object.fromEntries((await q('select id, level, kode_primer, kode_sekunder, kode_tersier, status_review, sumber, catatan, updated_at, created_at from public.klasifikasi where unit_id = $1')).map((x) => [x.id, x]));
  assert.deepEqual([klas['K-PR0101'].level, klas['K-PR0101'].kode_primer, klas['K-PR0101'].kode_sekunder, klas['K-PR0101'].kode_tersier, klas['K-PR0101'].catatan],
    ['TERSIER', 'PR', '01', '01', 'catatan fiktif']);
  assert.equal(klas['K-PR'].status_review, 'DISETUJUI');
  assert.equal(klas['K-PR01'].updated_at.toISOString(), '2025-02-03T04:05:06.789Z');
  assert.ok(klas['K-PR'].updated_at instanceof Date); // blank UPDATED_AT -> column default, not NULL
  const [st] = await q("select scope, updated_at from public.unit_settings where unit_id = $1 and key = 'INSTANCE_ID'");
  assert.deepEqual([st.scope, st.updated_at.toISOString()], ['GLOBAL', '2025-01-01T01:02:03.456Z']);
  const b = Object.fromEntries((await q(`select id, no_berkas_lama, to_char(tgl_pemindahan, 'YYYY-MM-DD') tp,
      to_char(tgl_persetujuan_pemindahan, 'YYYY-MM-DD') tpp, disetujui_pemindahan_oleh, deleted_at from public.berkas where unit_id = $1`)).map((x) => [x.id, x]));
  assert.equal(b['BRK-1'].no_berkas_lama, '12');
  assert.deepEqual([b['BRK-5'].tp, b['BRK-5'].tpp, b['BRK-5'].disetujui_pemindahan_oleh], ['2025-06-30', '2025-06-20', 'Pejabat Fiktif']);
  assert.equal(b['BRK-3'].deleted_at.toISOString(), '2026-01-21T01:00:00.000Z');
  const [i4] = await q("select no_item_lama, deleted_at from public.item where unit_id = $1 and id = 'ITM-4'");
  assert.deepEqual([i4.no_item_lama, i4.deleted_at.toISOString()], ['7', '2026-02-03T02:00:00.000Z']);
  const [a5] = await q("select occurred_at, before_data, after_data, ip_info, catatan, result, actor_email_snapshot from public.audit_log where unit_id = $1 and id = 'LOG-5'");
  assert.equal(a5.occurred_at.toISOString(), '2026-02-05T01:02:03.004Z');
  assert.deepEqual([a5.before_data, a5.after_data, a5.ip_info, a5.result, a5.actor_email_snapshot], [{ judul: 'lama' }, { judul: 'baru' }, '0.0.0.0 (fiktif)', 'WARNING', null]);
  assert.equal((await q("select count(*)::int n from public.unit_settings where unit_id = $1 and key = 'RC_KUNCI_BERSAMA'"))[0].n, 0);
  assert.ok(!renderText(firstReport).includes('nilai-rahasia-tipe'));
});

test('second run: zero changes and identical database state', async () => {
  const id = await unitId();
  const before = await snapshot(id);
  const r = await imp(fixtureFile);
  assert.equal(r.status, 'BERHASIL', r.fatal.join('\n'));
  for (const [t, s] of Object.entries(r.tables)) {
    assert.equal(s.inserted, 0, `${t} inserted`);
    assert.equal(s.updated, 0, `${t} updated`);
    assert.equal(s.unchanged, s.accepted, `${t} unchanged`);
    assert.equal(s.inDatabaseNotInExport, 0, `${t} not in export`);
  }
  assert.equal(r.unit.action, 'TIDAK BERUBAH');
  assert.deepEqual(await snapshot(id), before);
});

test('changed export: mutable rows are updated, append-only rows are refused and reported', async () => {
  const file = await variant('changed', (def) => {
    def.DB_BERKAS.rows[0].JUDUL_BERKAS = 'Renstra 2025 (judul diperbaiki)';
    def.AUDIT_LOG_2025.rows[0].RINGKASAN = 'Ringkasan diubah';
    def.DB_ITEM.rows.splice(1, 0, { ITEM_ID: 'ITM-7', BERKAS_ID: 'BRK-1', NO_ITEM_DEFINITIF: 3, URAIAN_LENGKAP: 'Item baru', TANGGAL_NASKAH: '20/03/2025', JUMLAH_HALAMAN: 1, CREATED_AT: '2025-03-20T08:00:00+07:00' });
  });
  const r = await imp(file);
  assert.equal(r.status, 'BERHASIL', r.fatal.join('\n'));
  assert.equal(r.tables.berkas.updated, 1);
  assert.deepEqual(r.tables.berkas.changedColumns, { judul_berkas: 1 });
  assert.equal(r.tables.item.inserted, 1);
  assert.equal(r.tables.audit_log.rejected, 1);
  assert.match(r.tables.audit_log.rejectedRows[0].reasons[0], /append-only.*summary/);
  const id = await unitId();
  const { rows: [b] } = await pool.query("select judul_berkas, version from public.berkas where unit_id = $1 and id = 'BRK-1'", [id]);
  assert.equal(b.judul_berkas, 'Renstra 2025 (judul diperbaiki)');
  const { rows: [a] } = await pool.query("select summary from public.audit_log where id = 'LOG-1'");
  assert.equal(a.summary, 'Membuat berkas');
  // item sum now differs from TOTAL_HALAMAN of BRK-1: reported, not "fixed"
  assert.ok(r.totals.selisihJumlahPerBerkas.some((m) => m.berkasId === 'BRK-1'));
});

test('fails loudly: missing required column names sheet and column', async () => {
  const file = await variant('no-berkas-id', (def) => { def.DB_ITEM.headers = def.DB_ITEM.headers.filter((h) => h !== 'BERKAS_ID'); });
  const r = await imp(file, { unitCode: 'UJIX', dryRun: true });
  assert.equal(r.status, 'GAGAL');
  assert.ok(r.fatal.some((f) => f.includes('DB_ITEM') && f.includes('BERKAS_ID')), r.fatal.join('\n'));
});

test('fails loudly: unparseable required value names sheet, row and column', async () => {
  const file = await variant('bad-date', (def) => { def.PENERIMAAN_ARSIP.rows[1].TANGGAL_WAKTU_TERIMA = 'kemarin sore'; });
  const r = await imp(file, { unitCode: 'UJIX' });
  assert.equal(r.status, 'GAGAL');
  assert.ok(r.fatal.some((f) => f.includes('sheet PENERIMAAN_ARSIP baris 3 kolom TANGGAL_WAKTU_TERIMA')), r.fatal.join('\n'));
  assert.equal(await unitId('UJIX'), undefined);
});

test('optional unparseable value rejects only that row, with the reason', async () => {
  const file = await variant('bad-optional', (def) => { def.DB_ITEM.rows[1].JUMLAH_HALAMAN = 'enam'; });
  const r = await imp(file, { dryRun: true });
  assert.equal(r.status, 'UJI_COBA_BERHASIL', r.fatal.join('\n'));
  const rej = r.tables.item.rejectedRows.find((x) => x.id === 'ITM-2');
  assert.match(rej.reasons[0], /DB_ITEM baris 3 kolom JUMLAH_HALAMAN: bukan bilangan bulat/);
});

test('fails: duplicate active berkas number, PII without key, another unit owning the IDs, strict mode', async () => {
  const dupFile = await variant('dup-number', (def) => { def.DB_BERKAS.rows[4].STATUS_PEMINDAHAN = ''; def.DB_BERKAS.rows[4].NO_BERKAS_DEFINITIF = 1; });
  const dup = await imp(dupFile, { dryRun: true });
  assert.equal(dup.status, 'GAGAL');
  assert.deepEqual(dup.duplicates.berkasNumber, [{ number: '1', ids: ['BRK-1', 'BRK-5'] }]);

  const noKey = await imp(fixtureFile, { unitCode: 'UJIX', dryRun: true, piiKey: null });
  assert.equal(noKey.status, 'GAGAL');
  assert.ok(noKey.fatal.some((f) => f.includes('nip_nik_enc')));

  const mismatch = await imp(fixtureFile, { unitCode: 'LAIN', unitName: 'Unit Lain', legacyInstanceId: 'INS-LAIN' });
  assert.equal(mismatch.status, 'GAGAL');
  assert.ok(mismatch.fatal.some((f) => f.includes('berbeda dengan SETTINGS.INSTANCE_ID')), mismatch.fatal.join('\n'));
  const reused = await imp(fixtureFile, { unitCode: 'LAIN', unitName: 'Unit Lain' });
  assert.ok(reused.fatal.some((f) => f.includes('INS-UJI-0001 sudah dipakai unit UJI')), reused.fatal.join('\n'));
  const noInstance = await variant('no-instance', (def) => { def.SETTINGS.rows = def.SETTINGS.rows.filter((r) => r.KEY !== 'INSTANCE_ID'); });
  const other = await imp(noInstance, { unitCode: 'LAIN', unitName: 'Unit Lain' });
  assert.equal(other.status, 'GAGAL');
  assert.ok(other.fatal.some((f) => f.includes('ID sudah dimiliki unit lain')), other.fatal.join('\n'));
  assert.equal(await unitId('LAIN'), undefined);

  const strict = await imp(fixtureFile, { strict: true, dryRun: true });
  assert.equal(strict.status, 'GAGAL');
  assert.ok(strict.fatal.some((f) => f.startsWith('Mode ketat')));
});

test('CLI: secrets only from env, never echoed; reports written; usage errors exit 2', async () => {
  const reportDir = join(dir, 'laporan');
  const env = {
    ...process.env,
    TEST_DB_URL: `postgresql://postgres:KataSandiRahasiaUji@localhost/${process.env.PGDATABASE}?host=${encodeURIComponent(process.env.PGHOST)}&port=${process.env.PGPORT}`,
    TEST_PII: PII_KEY
  };
  const res = spawnSync(process.execPath, [join(HERE, '..', 'import.mjs'), '--file', fixtureFile, '--unit-code', FIXTURE_UNIT.code,
    '--unit-name', FIXTURE_UNIT.name, '--dry-run', '--database-url-env', 'TEST_DB_URL', '--pii-key-env', 'TEST_PII', '--report-dir', reportDir],
  { env, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /UJI COBA BERHASIL/);
  const files = await readdir(reportDir);
  assert.equal(files.filter((f) => f.endsWith('.json')).length, 1);
  assert.equal(files.filter((f) => f.endsWith('.txt')).length, 1);
  const everything = res.stdout + res.stderr + (await Promise.all(files.map((f) => readFile(join(reportDir, f), 'utf8')))).join('');
  for (const secret of ['KataSandiRahasiaUji', PII_KEY, 'rahasia-fiktif-jangan-diimpor', '199001012020121001']) {
    assert.ok(!everything.includes(secret), `leaked ${secret}`);
  }
  const usage = spawnSync(process.execPath, [join(HERE, '..', 'import.mjs'), '--unit-code', 'X'], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
  const badKey = spawnSync(process.execPath, [join(HERE, '..', 'import.mjs'), '--file', fixtureFile, '--unit-code', 'X', '--unit-name', 'X', '--pii-key-env', 'TIDAK_ADA_ENV'], { encoding: 'utf8', env: { ...process.env, TIDAK_ADA_ENV: '' } });
  assert.equal(badKey.status, 2);
});
