import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { analyseWorkbook } from '../lib/importer.mjs';
import { TABLES } from '../lib/spec.mjs';
import { FIXTURE_UNIT, fixtureDefinition, writeFixture } from './fixture.mjs';

const cli = fileURLToPath(new URL('../reconcile.mjs', import.meta.url));
const unit = { id: '4d4bbca2-c81f-441f-8673-86f481aa4d4e', code: FIXTURE_UNIT.code, legacy_instance_id: FIXTURE_UNIT.instanceId };

async function writePackage(dir, rowsByTable) {
  const tables = {};
  for (const [name, rows] of Object.entries(rowsByTable)) {
    const file = name + '.00001.ndjson.gz';
    const bytes = gzipSync(rows.map((row) => JSON.stringify(row) + '\n').join(''));
    await writeFile(join(dir, file), bytes);
    tables[name] = { rows: rows.length, parts: [{
      file, rows: rows.length, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    }] };
  }
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({
    format: 'CFBACKUP1', day: '2026-11-20', schema_version: '0028', unit, tables,
    total_rows: Object.values(tables).reduce((n, t) => n + t.rows, 0),
  }));
}

test('compares both snapshots by ID, protects manual retention and fails closed on a damaged or wrong unit package', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cfreconcile-'));
  t.after(() => rm(dir, { force: true, recursive: true }));
  const file = join(dir, 'legacy.xlsx'), backup = join(dir, 'v4');
  await mkdir(backup);
  const sheets = fixtureDefinition();
  for (const table of ['berkas', 'item', 'penerimaan', 'penerimaan_item']) {
    const spec = TABLES.find((s) => s.table === table);
    const sheet = sheets[spec.sheets[0]];
    for (const { h } of spec.columns) {
      if (![h].flat().some((name) => sheet.headers.includes(name))) sheet.headers.push([h].flat()[0]);
    }
  }
  sheets.DB_ITEM.rows = sheets.DB_ITEM.rows.filter((r) => sheets.DB_BERKAS.rows.some((b) => b.BERKAS_ID === r.BERKAS_ID));
  sheets.PENERIMAAN_ITEM.rows = sheets.PENERIMAAN_ITEM.rows.filter((r) => sheets.PENERIMAAN_ARSIP.rows.some((b) => b.PENERIMAAN_ID === r.PENERIMAAN_ID));
  await writeFixture(sheets, file);
  const { data } = await analyseWorkbook(file);
  const rows = { units: [unit], loan_groups: [], transfer_drafts: [] };
  for (const table of ['berkas', 'item', 'penerimaan', 'penerimaan_item']) {
    rows[table] = [...data[table].values()].map(({ out }) => ({
      ...out, unit_id: unit.id, ...(table === 'berkas' ? { retensi_acuan_mode: 'LEGACY' } : {}),
    }));
  }
  const invoke = () => spawnSync(process.execPath, [cli, '--legacy', file, '--backup', backup, '--unit', unit.code], { encoding: 'utf8' });
  await writePackage(backup, rows);
  const clean = invoke();
  assert.equal(clean.status, 0, clean.stderr || clean.stdout);
  assert.equal(JSON.parse(clean.stdout).status, 'COCOK_DALAM_CAKUPAN');

  const a = rows.berkas.find((r) => r.id === 'BRK-1');
  a.retensi_acuan_mode = 'MANUAL';
  a.tgl_acuan_retensi = '2026-08-01';
  a.batas_aktif = '2028-08-01';
  const legacyOnly = rows.berkas.pop();
  rows.berkas.push({ ...legacyOnly, id: 'BRK-V4-ONLY', no_berkas_definitif: 999, is_deleted: true });
  const firstItem = rows.item.find((r) => r.berkas_id === a.id);
  firstItem.drive_file_id = 'PRIVATE-DRIVE-REFERENCE';
  firstItem.uraian_lengkap = 'PRIVATE-DOCUMENT-SUBJECT';
  rows.loan_groups.push({ id: 'PIN-UJI', unit_id: unit.id, returned_on: null, borrower_name: 'PRIVATE-PERSON' });
  await writePackage(backup, rows);
  const differences = invoke();
  assert.equal(differences.status, 1, differences.stderr || differences.stdout);
  const report = JSON.parse(differences.stdout);
  assert.deepEqual(report.tabel.berkas.hanya_lama, [legacyOnly.id]);
  assert.deepEqual(report.tabel.berkas.hanya_v4, ['BRK-V4-ONLY']);
  assert.deepEqual(report.tabel.berkas.jadwal_dikelola_v4, [{ id: a.id, mode: 'MANUAL' }]);
  assert.deepEqual(report.tabel.berkas.berbeda, []);
  assert.deepEqual(report.tabel.item.berbeda[0], { id: firstItem.id, kolom: ['uraian_lengkap', 'drive_file_id'] });
  assert.equal(report.perlu_cek_terpisah.grup_pinjaman_terbuka_v4, 1);
  assert.doesNotMatch(differences.stdout, /PRIVATE|2028-08-01/);

  rows.units = [{ ...unit, legacy_instance_id: 'INS-LAIN' }];
  await writePackage(backup, rows);
  const wrongUnit = invoke();
  assert.equal(wrongUnit.status, 2);
  assert.match(wrongUnit.stderr, /INSTANCE_ID yang sama/);
  await writeFile(join(backup, 'item.00001.ndjson.gz'), 'corrupt');
  const corrupt = invoke();
  assert.equal(corrupt.status, 2);
  assert.match(corrupt.stderr, /gagal verifikasi integritas/);
});
