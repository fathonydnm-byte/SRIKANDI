#!/usr/bin/env node
// Central File 3.x -> v4 legacy importer (one unit per run). See --help.
import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runImport } from './lib/importer.mjs';
import { renderText } from './lib/report.mjs';

const HELP = `Pemakaian:
  node import.mjs --file ekspor.xlsx --unit-code KODE --unit-name "Nama Unit"
                  [--legacy-instance-id INS-...] [--dry-run] [--strict]
                  [--database-url-env NAMA_ENV] [--pii-key-env NAMA_ENV]
                  [--report-dir DIREKTORI]

Koneksi database (urutan): --database-url (tidak disarankan: tersimpan di riwayat shell),
  lalu variabel lingkungan yang dinamai --database-url-env (bawaan DATABASE_URL),
  lalu variabel standar PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE.
  Gunakan koneksi langsung/session pooler peran postgres proyek Supabase.
Kunci data pribadi: hanya lewat variabel lingkungan yang dinamai --pii-key-env.
--dry-run   jalankan seluruh impor lalu ROLLBACK (tidak ada yang tersimpan).
--strict    gagalkan impor bila ada baris ditolak atau referensi yatim.
Laporan JSON + teks ditulis ke --report-dir (bawaan ./laporan-impor) dan teksnya dicetak.
Kode keluar: 0 berhasil, 1 impor gagal, 2 argumen salah.`;

function usage(message) {
  if (message) process.stderr.write(`Kesalahan: ${message}\n\n`);
  process.stderr.write(`${HELP}\n`);
  process.exit(2);
}

let args;
try {
  ({ values: args } = parseArgs({
    options: {
      file: { type: 'string' }, 'unit-code': { type: 'string' }, 'unit-name': { type: 'string' },
      'legacy-instance-id': { type: 'string' }, 'database-url': { type: 'string' },
      'database-url-env': { type: 'string', default: 'DATABASE_URL' }, 'pii-key-env': { type: 'string' },
      'report-dir': { type: 'string', default: 'laporan-impor' },
      'dry-run': { type: 'boolean', default: false }, strict: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false }
    },
    strict: true
  }));
} catch (error) {
  usage(error.message);
}
if (args.help) { process.stdout.write(`${HELP}\n`); process.exit(0); }
for (const required of ['file', 'unit-code', 'unit-name']) {
  if (!args[required]) usage(`--${required} wajib diisi`);
}
if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(args['unit-code'])) usage('--unit-code hanya huruf, angka, - dan _ (maks. 32)');

let connectionString = null;
if (args['database-url']) {
  process.stderr.write('Peringatan: --database-url tersimpan di riwayat shell; lebih aman memakai variabel lingkungan.\n');
  connectionString = args['database-url'];
} else if (process.env[args['database-url-env']]) {
  connectionString = process.env[args['database-url-env']];
}
let piiKey = null;
if (args['pii-key-env']) {
  piiKey = process.env[args['pii-key-env']] || null;
  if (!piiKey) usage(`variabel lingkungan ${args['pii-key-env']} (kunci data pribadi) kosong`);
  if (piiKey.length < 16) usage('kunci data pribadi minimal 16 karakter');
}

const report = await runImport({
  file: resolve(args.file),
  unitCode: args['unit-code'],
  unitName: args['unit-name'],
  legacyInstanceId: args['legacy-instance-id'] || null,
  dryRun: args['dry-run'],
  strict: args.strict,
  piiKey,
  pg: connectionString ? { connectionString } : {}
}).catch((error) => ({ status: 'GAGAL', fatal: [`Tidak dapat terhubung/menjalankan impor: ${error.message}`], file: args.file, mode: args['dry-run'] ? 'UJI_COBA' : 'IMPOR' }));

const text = renderText(report);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = resolve(args['report-dir']);
await mkdir(dir, { recursive: true });
const base = join(dir, `impor-${args['unit-code']}-${stamp}`);
await writeFile(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(`${base}.txt`, text);
process.stdout.write(`${text}\nLaporan: ${base}.json\n         ${base}.txt\n`);
process.exit(report.status === 'GAGAL' ? 1 : 0);
