const RC_RELEASE = Object.freeze({
  VERSION: '1.0.0',
  SCHEMA_VERSION: 1,
  CHANNEL: 'PILOT',
  RELEASE_DATE: '2026-08-20'
});

// RC-00 = fondasi instance: installer, folder, registry sumber Central File,
// reliability (migrasi/health/audit/backup). Sheet transaksi bisnis
// (PENERIMAAN_USUL_PINDAH/BERKAS/ITEM, RC_INBOX_EVENTS, RC_DECISION_OUTBOX)
// sengaja belum dibuat di sini — schema-nya dirancang bersamaan dengan
// endpoint federatif RC-01 supaya kolomnya cocok persis dengan payload yang
// dikirim Central File (lihat buildTransferSubmissionEnvelope_ pada paket CF).
const RC_CONFIG = Object.freeze({
  // ID spreadsheet disimpan installer pada Script Properties, bukan hard-code,
  // supaya paket kode yang sama bisa dipakai ulang bila RC perlu instance lain.
  get SPREADSHEET_ID() {
    return getInstanceSpreadsheetId_();
  },
  TIME_ZONE: 'Asia/Jakarta',
  SHEETS: Object.freeze({
    SETTINGS: 'RC_SETTINGS',
    SOURCE_REGISTRY: 'RC_SOURCE_REGISTRY',
    AUDIT: 'RC_AUDIT_LOG',
    SYSTEM_MIGRATIONS: 'RC_SYSTEM_MIGRATIONS',
    SYSTEM_HEALTH: 'RC_SYSTEM_HEALTH',
    SYSTEM_BACKUPS: 'RC_SYSTEM_BACKUPS'
  }),
  FOLDERS: Object.freeze({
    // Keempat folder ini dibuat installer sekarang sesuai daftar folder RC-00
    // di handoff §13.2, walau '01' dan '02' baru terisi berkas ketika RC-01
    // (penerimaan usul) dan RC-03 (penataan) dibangun.
    TRANSFER_INBOX: '01 PENERIMAAN USUL PINDAH',
    INACTIVE_ARCHIVE: '02 ARSIP INAKTIF',
    QUARANTINE: '90 KARANTINA APLIKASI',
    BACKUP: '99 BACKUP APLIKASI'
  }),
  SOURCE_STATUS: Object.freeze(['AKTIF', 'NONAKTIF'])
});
