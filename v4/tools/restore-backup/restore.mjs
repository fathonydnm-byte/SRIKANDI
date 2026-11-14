#!/usr/bin/env node
// Restore backup harian Central File v4.
//
//   node restore.mjs --package <zip|folder> [--package <zip|folder> ...] --database-url-env NAMA_VARIABEL [--dry-run] [--force-schema] [--json]
//
//   --package            paket (folder <tanggal>/ yang diunduh dari Drive, atau ZIP-nya). Boleh diulang untuk beberapa unit:
//                        semuanya dipulihkan dalam SATU transaksi.
//   --database-url-env   NAMA variabel lingkungan yang berisi URL koneksi Postgres (mis. RESTORE_DATABASE_URL).
//                        URL tidak pernah diterima lewat argumen dan tidak pernah dicetak.
//   --dry-run            memeriksa paket, memuat ke database di dalam transaksi, menjalankan pemeriksaan integritas, lalu ROLLBACK.
//   --force-schema       tetap lanjut bila versi skema database berbeda dari manifest (tidak disarankan).
//
// Database tujuan harus sudah bermigrasi (idealnya kosong: latihan restore memakai proyek Supabase/Postgres baru).
// Idempoten: dijalankan ulang menghasilkan keadaan yang sama (baris yang ada ditimpa dengan isi paket; tabel append-only
// tidak diubah). Kode keluar: 0 berhasil; 1 galat umum; 2 paket rusak; 3 skema berbeda; 4 pemeriksaan integritas/constraint gagal.
import pg from 'pg';
import { openPackage, verifyPackage } from './lib/package.mjs';
import { restorePackages, RestoreError } from './lib/restore.mjs';

function parseArgs(argv) {
  const out = { packages: [], dryRun: false, forceSchema: false, json: false, envName: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--package') out.packages.push(argv[++i]);
    else if (a === '--database-url-env') out.envName = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--force-schema') out.forceSchema = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`Argumen tidak dikenal: ${a}`);
  }
  return out;
}

const scrub = (msg, secret) => (secret ? String(msg).split(secret).join('[url-database]') : String(msg));

export async function main(argv, env = process.env, io = { out: (s) => console.log(s), err: (s) => console.error(s) }) {
  let args;
  try { args = parseArgs(argv); } catch (e) { io.err(e.message); return 1; }
  if (args.help || !args.packages.length || !args.packages.every(Boolean) || !args.envName) {
    io.err('Pemakaian: node restore.mjs --package <zip|folder> [--package ...] --database-url-env NAMA [--dry-run] [--force-schema] [--json]');
    return args.help ? 0 : 1;
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(args.envName)) { io.err('Nama variabel lingkungan tidak valid.'); return 1; }
  const url = env[args.envName];
  if (!url) { io.err(`Variabel lingkungan ${args.envName} kosong atau tidak ada.`); return 1; }

  // 1) verify every package BEFORE touching the database
  const packages = [];
  for (const target of args.packages) {
    let pkg;
    try { pkg = openPackage(target); } catch (e) { io.err(`${target}: ${e.message}`); return 2; }
    const { manifest, problems, counts } = verifyPackage(pkg);
    if (problems.length) {
      io.err(`Paket ${target} TIDAK utuh:`);
      for (const p of problems) io.err(`  - ${p}`);
      return 2;
    }
    io.out(`Paket ${manifest.unit.code} (${manifest.day}, skema ${manifest.schema_version}): ${manifest.total_rows} baris di ${Object.keys(counts).length} tabel, hash dan jumlah baris cocok.`);
    packages.push({ pkg, manifest, counts });
  }

  // 2) load (one transaction)
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    const summary = await restorePackages(client, packages, { dryRun: args.dryRun, forceSchema: args.forceSchema, log: (m) => io.err(m) });
    if (args.json) io.out(JSON.stringify(summary));
    io.out(args.dryRun ? '--dry-run: semua dimuat lalu dibatalkan (ROLLBACK). Tidak ada yang tersimpan.' : 'Restore selesai (COMMIT).');
    for (const [t, s] of Object.entries(summary.tables)) if (s.packageRows) io.out(`  ${t.padEnd(22)} paket ${String(s.packageRows).padStart(7)}  ditulis ${String(s.affected).padStart(7)}`);
    for (const c of summary.checks) io.out(`  [${c.ok ? 'OK' : 'GAGAL'}] ${c.name}: ${c.detail}`);
    return 0;
  } catch (e) {
    const code = e instanceof RestoreError ? e.code : 'DATABASE';
    io.err(scrub(e instanceof RestoreError ? e.message : `Galat: ${e.message}`, url));
    if (e.summary) for (const c of e.summary.checks.filter((x) => !x.ok)) io.err(`  [GAGAL] ${c.name}: ${c.detail}`);
    io.err('Tidak ada yang tersimpan (ROLLBACK).');
    return code === 'SCHEMA_MISMATCH' || code === 'SCHEMA' ? 3 : code === 'INTEGRITY' ? 4 : 1;
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2));
}
