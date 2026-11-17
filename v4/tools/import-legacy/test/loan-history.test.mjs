import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { applyLoanHistory, readLoanHistory } from '../lib/loan-history.mjs';

const db = new pg.Client();
const code = 'S4HIST';
let unit;
const begin = '2025-03-01', end = '2025-03-03';
const synthetic = () => {
  const base = {
    JENIS_OBJEK: 'BERKAS', BERKAS_ID: 'B1', NAMA_PEMINJAM: 'Peminjam Sintetis',
    TANGGAL_PINJAM: begin, TANGGAL_WAJIB_KEMBALI: end, TANGGAL_KEMBALI: end,
    STATUS: 'KEMBALI', JUMLAH_HALAMAN_GRUP_SNAPSHOT: 2, JUMLAH_HALAMAN_ITEM: 1,
    NIP_NIK: 'NOMOR-RAHASIA-UJI', BUKTI_PERSETUJUAN_URL: 'https://example.test/private',
  };
  const doc = { PRINT_ID: 'PRINT-1', TIMESTAMP: '2025-03-02 09:00', LOAN_GROUP_ID: 'HOLD-1', STATUS: 'PDF_DIBUAT' };
  return new Map(Object.entries({
    SETTINGS: [{ KEY: 'INSTANCE_ID', VALUE: 'INS-HISTORY' }],
    PEMINJAMAN: [
      { ...base, PEMINJAMAN_ID: 'OBJ1', LOAN_GROUP_ID: 'G1', NO_BERKAS_SNAPSHOT: 27 },
      { ...base, PEMINJAMAN_ID: 'OBJ2', LOAN_GROUP_ID: 'G1', BERKAS_ID: 'B2' },
      { ...base, PEMINJAMAN_ID: 'HOLD-1', STATUS: 'DIPINJAM', TANGGAL_KEMBALI: null },
      { ...base, PEMINJAMAN_ID: 'OPEN-1', STATUS: 'DIPINJAM', TANGGAL_KEMBALI: null },
    ],
    LOG_CETAK_OUT_INDICATOR: [doc],
    LOG_CETAK_BERITA_ACARA: [{ ...doc, LOAN_GROUP_ID: 'OBJ1', STATUS: 'DOCS_DIBUAT' }],
  }).map(([name, rows]) => [name, {
    headers: Object.keys(rows[0]), duplicateHeaders: [], rows: rows.map((values, i) => ({ rowNumber: i + 2, values })),
  }]));
};

before(async () => {
  await db.connect();
  unit = (await db.query("insert into public.units (code,name,legacy_instance_id) values ($1,'S4 Hist','INS-HISTORY') returning id", [code])).rows[0].id;
  await db.query(`insert into public.berkas (unit_id,id,judul_berkas,no_berkas_definitif,status_peminjaman)
    values ($1,'B1','Uji 1',1,'DIPINJAM'), ($1,'B2','Uji 2',2,'TERSEDIA')`, [unit]);
  await db.query(`insert into public.loan_groups (unit_id,id,borrower_name,borrower_position,borrower_unit,
    officer_name,officer_position,purpose,borrowed_on,due_on,returned_on,borrow_condition,page_count)
    values ($1,'HOLD-1','Data v4','','','','','',$2,$3,$3,'BAIK',2)`, [unit, begin, end]);
});
after(() => db.end());

test('repairs history only: dry run rolls back, apply is repeatable and preserves v4 returns and borrowing flags', async () => {
  const source = readLoanHistory(synthetic());
  await assert.rejects(applyLoanHistory(db, code, { ...source, instance: 'OTHER' }, true), /INSTANCE_ID/);
  const dryRun = await applyLoanHistory(db, code, source);
  assert.deepEqual(dryRun, {
    committed: false, addedLoans: 1, existingLoans: 1, skippedOpenLoans: 1,
    addedPrintLogs: 2, existingPrintLogs: 0, unmatchedPrintRows: [],
  });
  assert.equal((await db.query("select id from public.loan_groups where unit_id=$1 and id='G1'", [unit])).rowCount, 0);
  const applied = await applyLoanHistory(db, code, source, true);
  assert.equal(applied.committed, true);
  const again = await applyLoanHistory(db, code, source, true);
  assert.equal(again.addedLoans, 0);
  assert.equal(again.existingPrintLogs, 2);
  const groups = (await db.query(`select id,borrower_name,borrow_condition,returned_on::text,borrower_identity_enc
    from public.loan_groups where unit_id=$1 order by id`, [unit])).rows;
  assert.deepEqual(groups, [
    { id: 'G1', borrower_name: 'Peminjam Sintetis', borrow_condition: null, returned_on: end, borrower_identity_enc: null },
    { id: 'HOLD-1', borrower_name: 'Data v4', borrow_condition: 'BAIK', returned_on: end, borrower_identity_enc: null },
  ]);
  const objects = (await db.query(`select id,loan_id,berkas_no from public.loan_objects
    where unit_id=$1 order by id`, [unit])).rows;
  assert.deepEqual(objects, [{ id: 'OBJ1', loan_id: 'G1', berkas_no: 27 }, { id: 'OBJ2', loan_id: 'G1', berkas_no: 2 }]);
  const audit = (await db.query('select object_id,after_data from public.audit_log where unit_id=$1 order by object_id', [unit])).rows;
  assert.deepEqual(audit, [
    { object_id: 'G1', after_data: { source_status: 'DOCS_DIBUAT' } },
    { object_id: 'HOLD-1', after_data: { source_status: 'PDF_DIBUAT' } },
  ]);
  assert.equal((await db.query("select status_peminjaman from public.berkas where unit_id=$1 and id='B1'", [unit])).rows[0].status_peminjaman, 'DIPINJAM');
});

test('an unresolved log prevents new writes even with --apply', async () => {
  const sheets = synthetic();
  const rows = sheets.get('PEMINJAMAN').rows;
  rows.push({ rowNumber: 6, values: { ...rows[0].values, PEMINJAMAN_ID: 'NEW-1', LOAN_GROUP_ID: 'NEW-G' } });
  sheets.get('LOG_CETAK_BERITA_ACARA').rows[0].values.LOAN_GROUP_ID = 'NOT-FOUND';
  const result = await applyLoanHistory(db, code, readLoanHistory(sheets), true);
  assert.equal(result.committed, false);
  assert.equal(result.addedLoans, 1);
  assert.deepEqual(result.unmatchedPrintRows, [{ sheet: 'LOG_CETAK_BERITA_ACARA', row: 2 }]);
  assert.equal((await db.query("select id from public.loan_groups where unit_id=$1 and id='NEW-G'", [unit])).rowCount, 0);
});
