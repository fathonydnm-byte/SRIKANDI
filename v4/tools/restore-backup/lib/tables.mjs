// Tables a package may contain, in load order (units first: every other table references it).
// MUST equal EXPORT_TABLES in v4/web/server/jobsExport.ts (test.sh compares them) and the list in
// v4/tests/db/s3_backup.test.mjs. profiles, idempotency_keys, upload_sessions, schema_migrations_log, job_nonces and
// backup_runs are deliberately NOT restorable: a package can never overwrite accounts or job bookkeeping.
export const RESTORE_TABLES = [
  'units', 'unit_settings', 'counters', 'klasifikasi', 'jenis_naskah', 'pegawai', 'berkas', 'item', 'penerimaan',
  'penerimaan_item', 'riwayat_nomor', 'penerimaan_cetak_log', 'folder_label_log', 'karantina', 'pembatalan_arsip',
  'drive_tasks', 'audit_log',
];
/** Which column ties a row to its unit. audit_log may have NULL (cross-unit rows, package "_PLATFORM"). */
export const UNIT_COLUMN = (table) => (table === 'units' ? 'id' : 'unit_id');
