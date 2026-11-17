#!/usr/bin/env node
import { parseArgs } from 'node:util';
import pg from 'pg';
import { readWorkbook } from './lib/workbook.mjs';
import { applyLoanHistory, readLoanHistory } from './lib/loan-history.mjs';

const usage = 'node import-loan-history.mjs --file EKSPOR.xlsx --unit-code KODE_UNIT [--apply]\n'
  + 'Gunakan DATABASE_URL atau PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE. Bawaan: uji coba dengan rollback.';

let args;
try {
  ({ values: args } = parseArgs({ options: {
    file: { type: 'string' }, 'unit-code': { type: 'string' }, apply: { type: 'boolean' }, help: { type: 'boolean' },
  } }));
  if (!args.help && (!args.file || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(args['unit-code'] ?? ''))) throw new Error();
} catch {
  console.error(usage);
  process.exit(2);
}
if (args.help) { console.log(usage); process.exit(0); }

let stage = 'membaca file XLSX';
let client;
try {
  const sheets = await readWorkbook(args.file);
  stage = 'memeriksa riwayat';
  const history = readLoanHistory(sheets);
  stage = 'mengakses database';
  if (!process.env.DATABASE_URL && !process.env.PGDATABASE) {
    throw new Error('Tetapkan DATABASE_URL atau PGDATABASE agar tujuan database eksplisit.');
  }
  client = new pg.Client(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {});
  await client.connect();
  const report = await applyLoanHistory(client, args['unit-code'].toUpperCase(), history, args.apply);
  console.log(JSON.stringify(report, null, 2));
  if (report.unmatchedPrintRows.length) process.exitCode = 1;
} catch (error) {
  // PostgreSQL errors can embed the full failing row, including names and notes.
  const safe = /^(SETTINGS |Header tab |Unit tujuan |PEMINJAMAN baris |LOG_CETAK_|Tetapkan )/.test(error.message);
  const code = /^[A-Z0-9]{5}$/.test(error.code ?? '') ? ` (SQLSTATE ${error.code})` : '';
  console.error(safe ? error.message : `Gagal ${stage}${code}. Tidak ada perubahan yang disimpan.`);
  process.exitCode = 1;
} finally {
  if (client) await client.end().catch(() => {});
}
