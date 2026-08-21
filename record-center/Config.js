const RC_RELEASE = Object.freeze({
  VERSION: '1.1.0',
  SCHEMA_VERSION: 2,
  CHANNEL: 'PILOT',
  RELEASE_DATE: '2026-08-21'
});

// RC-00 = fondasi instance (installer, folder, registry sumber, reliability).
// RC-01 = endpoint federatif + tabel bisnis penerimaan usul pindah, ditambah
// setelah kolomnya diselaraskan dengan payload aktual dari Central File
// (lihat buildTransferSubmissionEnvelope_ di central-file/TransferSubmissionService.js)
// dan protokol poll pada docs/ADDENDUM_2026-08-20_PROTOKOL_KEPUTUSAN_RC_CF.md.
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
    SYSTEM_BACKUPS: 'RC_SYSTEM_BACKUPS',
    INBOX_EVENTS: 'RC_INBOX_EVENTS',
    TRANSFER_PROPOSAL: 'PENERIMAAN_USUL_PINDAH',
    TRANSFER_PROPOSAL_BERKAS: 'PENERIMAAN_USUL_BERKAS',
    TRANSFER_PROPOSAL_ITEM: 'PENERIMAAN_USUL_ITEM',
    DECISION_OUTBOX: 'RC_DECISION_OUTBOX'
  }),
  FOLDERS: Object.freeze({
    // Keempat folder ini dibuat installer sekarang sesuai daftar folder RC-00
    // di handoff §13.2. '01' mulai terisi mulai RC-01 ini; '02' baru terisi
    // ketika RC-03 (penataan) dibangun.
    TRANSFER_INBOX: '01 PENERIMAAN USUL PINDAH',
    INACTIVE_ARCHIVE: '02 ARSIP INAKTIF',
    QUARANTINE: '90 KARANTINA APLIKASI',
    BACKUP: '99 BACKUP APLIKASI'
  }),
  SOURCE_STATUS: Object.freeze(['AKTIF', 'NONAKTIF']),
  PROPOSAL_STATUS: Object.freeze(['DITERIMA', 'DISETUJUI', 'DITOLAK', 'DIBATALKAN']),
  // Baseline §12.3: event lebih tua dari ini ditolak (proteksi replay).
  MAX_EVENT_AGE_MS: 24 * 60 * 60 * 1000
});
