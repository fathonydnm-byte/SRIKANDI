#!/usr/bin/env node
// Read-only comparison of a legacy workbook and a verified v4 unit backup.
import { parseArgs } from 'node:util';
import { analyseWorkbook } from './lib/importer.mjs';
import { TABLES } from './lib/spec.mjs';
import { openPackage, readPart, verifyPackage } from '../restore-backup/lib/package.mjs';

const retention = [
  'tgl_acuan_retensi', 'retensi_aktif_nilai', 'retensi_aktif_satuan', 'retensi_inaktif_nilai',
  'retensi_inaktif_satuan', 'nasib_akhir', 'batas_aktif', 'batas_inaktif',
];
const fields = {
  berkas: ['no_berkas_definitif', 'judul_berkas', 'kode_klasifikasi_snapshot', 'no_filling_kabinet', 'no_laci',
    'no_folder', 'status_berkas', 'status_pemindahan', 'status_peminjaman', 'usul_pindah_id_aktif',
    'klasifikasi_keamanan_akses', 'is_deleted', ...retention],
  item: ['berkas_id', 'no_item_definitif', 'tanggal_naskah', 'no_surat_utama', 'no_surat_alternatif',
    'uraian_lengkap', 'jumlah_halaman', 'tingkat_perkembangan', 'klasifikasi_keamanan_akses', 'status_peminjaman',
    'drive_file_id', 'status_file', 'penerimaan_id', 'penerimaan_item_id', 'is_deleted'],
  penerimaan: ['nomor_tanda_terima', 'jumlah_item', 'total_halaman', 'status', 'bukti_ttd_file_id', 'batal_bukti_file_id'],
  penerimaan_item: ['penerimaan_id', 'uraian_informasi', 'jumlah_halaman', 'tanggal_naskah', 'status_pemberkasan',
    'berkas_id_tujuan', 'item_id_definitif', 'file_digital_id', 'is_deleted'],
};

function readRows(pkg, manifest, table) {
  if (!Object.hasOwn(manifest.tables, table)) throw new Error(`Paket tidak memuat tabel ${table}.`);
  return manifest.tables[table].parts.flatMap((part) => readPart(pkg, part.file));
}

function indexV4(rows, unitId, table) {
  const map = new Map();
  for (const row of rows) {
    if (!row || row.unit_id !== unitId || typeof row.id !== 'string' || !row.id || map.has(row.id)) {
      throw new Error(`Paket ${table} memuat ID kosong, ganda, atau milik unit lain.`);
    }
    const required = fields[table] ?? (table === 'loan_groups' ? ['returned_on'] : ['cancelled_at']);
    if ((table === 'berkas' && !['LEGACY', 'MANUAL', 'PENDING'].includes(row.retensi_acuan_mode))
      || required.some((field) => !Object.hasOwn(row, field))) {
      throw new Error(`Struktur tabel ${table} di paket tidak lengkap.`);
    }
    map.set(row.id, row);
  }
  return map;
}

function totals(tables) {
  const activeFolders = new Set([...tables.berkas.values()]
    .filter((b) => !b.is_deleted && b.no_berkas_definitif != null && b.status_pemindahan?.trim().toUpperCase() !== 'SUDAH DIPINDAHKAN')
    .map((b) => b.id));
  const activeItems = [...tables.item.values()]
    .filter((i) => !i.is_deleted && i.no_item_definitif != null && activeFolders.has(i.berkas_id));
  return {
    berkas_aktif: activeFolders.size, item_aktif: activeItems.length,
    lembar_aktif: activeItems.reduce((n, i) => n + (i.jumlah_halaman ?? 0), 0),
    item_aktif_ada_file: activeItems.filter((i) => i.drive_file_id).length,
  };
}

function compare(before, after, columns, table) {
  const result = { lama: before.size, v4: after.size, hanya_lama: [], hanya_v4: [], berbeda: [],
    jadwal_dikelola_v4: [] };
  for (const id of [...before.keys()].sort()) {
    const a = before.get(id), b = after.get(id);
    if (!b) { result.hanya_lama.push(id); continue; }
    const changed = columns.filter((c) => (a[c] ?? null) !== (b[c] ?? null));
    const managed = table === 'berkas' && b.retensi_acuan_mode !== 'LEGACY';
    const differences = managed ? changed.filter((c) => !retention.includes(c)) : changed;
    if (differences.length) result.berbeda.push({ id, kolom: differences });
    if (managed) result.jadwal_dikelola_v4.push({ id, mode: b.retensi_acuan_mode });
  }
  result.hanya_v4 = [...after.keys()].filter((id) => !before.has(id)).sort();
  return result;
}

function dangling(tables) {
  return [
    ...[...tables.item.values()].filter((i) => !tables.berkas.has(i.berkas_id)).map((i) => ({ tabel: 'item', id: i.id })),
    ...[...tables.penerimaan_item.values()].filter((i) => !tables.penerimaan.has(i.penerimaan_id))
      .map((i) => ({ tabel: 'penerimaan_item', id: i.id })),
  ];
}

async function reconcile(file, backup, unitCode) {
  let legacy;
  try { legacy = await analyseWorkbook(file); }
  catch { throw new Error('Ekspor XLSX lama tidak dapat dibaca.'); }
  const { data, report, fatal, sheetsSeen } = legacy;
  if (fatal.length || Object.keys(report.duplicateHeaders).length) {
    throw new Error('Ekspor XLSX lama tidak lengkap, memiliki ID bertentangan, atau header ganda.');
  }
  const instance = data.unit_settings.get('INSTANCE_ID')?.out.value;
  const code = data.unit_settings.get('UNIT_CODE')?.out.value;
  if (!instance || code !== unitCode || report.tables.unit_settings.duplicateIdenticalRows) {
    throw new Error('INSTANCE_ID atau UNIT_CODE ekspor lama tidak cocok/tidak lengkap, atau SETTINGS memiliki ID ganda.');
  }
  let pkg, manifest;
  try {
    pkg = openPackage(backup);
    const verified = verifyPackage(pkg);
    if (verified.problems.length) throw new Error();
    manifest = verified.manifest;
  } catch { throw new Error('Paket cadangan tidak dapat dibaca atau gagal verifikasi integritas.'); }
  if (manifest.schema_version !== '0028') throw new Error('Gunakan paket cadangan dengan skema 0028 untuk revisi alat ini.');
  const units = readRows(pkg, manifest, 'units');
  if (units.length !== 1 || manifest.unit.code !== unitCode || units[0]?.code !== unitCode
    || !manifest.unit.id || units[0].id !== manifest.unit.id || units[0].legacy_instance_id !== instance) {
    throw new Error('Paket dan ekspor harus berasal dari unit dan INSTANCE_ID yang sama.');
  }
  const before = {}, after = {}, diffs = {};
  for (const [table, columns] of Object.entries(fields)) {
    const { sheets: [sheet], columns: mappings } = TABLES.find((s) => s.table === table);
    const input = report.tables[table];
    if (!sheetsSeen.includes(sheet) || input.rejected || input.duplicateIdenticalRows) {
      throw new Error(`Tab ${sheet} absen, memuat baris tidak valid, atau memiliki ID ganda.`);
    }
    const missing = new Set(report.missingOptionalColumns[sheet] ?? []);
    const unavailable = mappings.filter((m) => columns.includes(m.c) && missing.has([m.h].flat()[0])).map((m) => m.c);
    before[table] = new Map([...data[table]].map(([id, entry]) => [id, entry.out]));
    after[table] = indexV4(readRows(pkg, manifest, table), manifest.unit.id, table);
    diffs[table] = {
      ...compare(before[table], after[table], columns.filter((c) => !unavailable.includes(c)), table),
      kolom_tidak_ada_di_ekspor: unavailable,
    };
  }
  const sums = { lama: totals(before), v4: totals(after) };
  const orphans = { lama: dangling(before), v4: dangling(after) };
  const needsReview = Object.values(diffs).some((d) => d.hanya_lama.length || d.hanya_v4.length
    || d.berbeda.length || d.kolom_tidak_ada_di_ekspor.length)
    || orphans.lama.length || orphans.v4.length
    || Object.keys(sums.lama).some((key) => sums.lama[key] !== sums.v4[key]);
  const loans = indexV4(readRows(pkg, manifest, 'loan_groups'), manifest.unit.id, 'loan_groups');
  const drafts = indexV4(readRows(pkg, manifest, 'transfer_drafts'), manifest.unit.id, 'transfer_drafts');
  return {
    status: needsReview ? 'PERLU_TINJAU' : 'COCOK_DALAM_CAKUPAN',
    unit: unitCode, schema: manifest.schema_version, tanggal_paket: manifest.day ?? null,
    ringkasan: sums, tabel: diffs, relasi_induk_hilang: orphans,
    perlu_cek_terpisah: {
      baris_tab_legacy: Object.fromEntries(report.sheets.deferred.filter((s) => [4, 5, 6].includes(s.sprint)).map((s) => [s.name, s.rows])),
      grup_pinjaman_terbuka_v4: [...loans.values()].filter((r) => r.returned_on == null).length,
      draf_pemindahan_aktif_v4: [...drafts.values()].filter((r) => r.cancelled_at == null).length,
    },
  };
}

try {
  const { values } = parseArgs({ options: {
    legacy: { type: 'string' }, backup: { type: 'string' }, unit: { type: 'string' }, help: { type: 'boolean' },
  } });
  const help = 'node v4/tools/import-legacy/reconcile.mjs --legacy Ekspor_Apps_Script.xlsx --backup BAGUM.zip --unit BAGUM';
  if (values.help) console.log(help);
  else {
    if (!values.legacy || !values.backup || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(values.unit ?? '')) {
      throw new Error(help);
    }
    const report = await reconcile(values.legacy, values.backup, values.unit);
    console.log(JSON.stringify(report, null, 2));
    if (report.status === 'PERLU_TINJAU') process.exitCode = 1;
  }
} catch (error) {
  console.error(`Rekonsiliasi gagal: ${error.message}`);
  process.exitCode = 2;
}
