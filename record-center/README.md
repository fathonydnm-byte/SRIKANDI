# Record Center — RC-00 (fondasi instance)

Status: **kode ditulis & lulus syntax check, belum pernah dipasang ke Apps Script/Drive manapun.** Ditulis dari nol pada 20 Agustus 2026 mengikuti spesifikasi handoff §13.2 dan §14, karena source RC-00/RC-01 sebelumnya (v1.0.0 PILOT yang disebut di handoff) tidak pernah masuk git dan direktori kerjanya tidak lagi terjangkau dari sesi ini.

## Cakupan RC-00 (yang ADA di sini)

- Installer (`showRcInstallerDialog` / `AdminSetup.html`) — membuat/mengikat spreadsheet Record Center, folder Drive terpisah, dan seluruh sheet fondasi.
- Sheet: `RC_SETTINGS`, `RC_SOURCE_REGISTRY`, `RC_AUDIT_LOG`, `RC_SYSTEM_MIGRATIONS`, `RC_SYSTEM_HEALTH`, `RC_SYSTEM_BACKUPS`.
- Folder: `01 PENERIMAAN USUL PINDAH`, `02 ARSIP INAKTIF`, `90 KARANTINA APLIKASI`, `99 BACKUP APLIKASI` (folder `01`/`02` dibuat sekarang tapi baru dipakai isinya oleh RC-01/RC-03).
- Registry sumber Central File: daftar/perbarui/nonaktifkan sumber, terbitkan shared secret (disimpan di Script Properties dengan kunci `SOURCE_SECRET_<sourceId>`, **tidak pernah** ditulis ke sheet — hanya tampil sekali di respons API saat diterbitkan).
- Health check, Audit Log, migrasi (`RC-REL-001`, schema 1), backup sinkron (salinan spreadsheet + manifest jumlah file/folder).
- Guard administrator (`isRecordCenterAdmin_`/`requireRecordCenterAdmin_`) — dashboard dan aksi registry menolak akun selain admin instance, diperiksa di server bukan hanya lewat access setting deployment (§22.3).

## Yang SENGAJA belum ada (scope RC-01)

- `doPost()` / endpoint federatif apa pun. RC-00 murni installer + dashboard, tidak menerima panggilan dari Central File.
- Sheet `RC_INBOX_EVENTS`, `RC_DECISION_OUTBOX`, `PENERIMAAN_USUL_PINDAH`, `PENERIMAAN_USUL_BERKAS`, `PENERIMAAN_USUL_ITEM`. Kolomnya perlu diselaraskan dengan payload aktual yang dikirim Central File — lihat `buildTransferSubmissionEnvelope_` di `central-file/TransferSubmissionService.js` (schema `UINSA-ARSIP-TRANSFER-PROPOSAL/1.0`) sebelum menulis skema ini.
- Verifikasi signature HMAC (`transferSubmissionSignature_`/`transferSubmissionSha256_` di CF sudah jadi acuan formatnya: `HMAC-SHA256(eventId|payloadSha256|timestamp, secret)`, hex lowercase) — RC-01 perlu meng-cover-nya di sisi penerima, termasuk perbandingan constant-time.
- Event `QUERY_DECISION` (protokol poll — lihat `docs/ADDENDUM_2026-08-20_PROTOKOL_KEPUTUSAN_RC_CF.md`).
- Dua deployment (endpoint `Anyone` + dashboard `Only myself`/terbatas) — baru relevan setelah RC-01 punya `doPost()` untuk di-deploy.

`isSourceActive_(sourceId)` dan `getSourceSecret_(sourceId)` sudah disediakan di `ReliabilityService.js` karena RC-01 akan langsung membutuhkannya untuk memvalidasi pengirim.

## Cara memasang (mengikuti handoff §19.3)

1. Login akun Google yang ditetapkan sebagai Record Center pilot (**terpisah** dari akun Central File `bag.umum@uinsa.ac.id`).
2. Buat Google Sheet baru kosong, lalu buat folder Drive induk kosong untuk Record Center (folder ini akan diisi installer dengan empat subfolder di atas).
3. Buka Extensions → Apps Script pada spreadsheet tersebut (ini membuat container-bound Apps Script project baru dengan `scriptId` sendiri).
4. Push seluruh isi direktori ini ke project tersebut (lewat clasp: `clasp push` setelah `.clasp.json` diisi `scriptId` project itu, atau tempel manual bila belum ada akses clasp ke akun RC).
5. Reload spreadsheet, jalankan menu **Record Center → Instalasi & Reliability…**, isi form, submit.
6. Daftarkan Central File pilot sebagai sumber (Instance ID CF ada di `INSTANCE_ID` pada Script Properties CF / hasil installer CF — lihat handoff §6.1).
7. Simpan shared secret yang diterbitkan — akan dibutuhkan untuk mengisi field Record Center pada installer Central File (`recordCenterSharedSecret`, dst., sudah ada di `installUnitInstance_` CF).
8. Jalankan Backup Sekarang dan pastikan health check `OK`/`WARNING` (bukan `ERROR`) sebelum lanjut ke RC-01.

## Status pemasangan

- Project Apps Script + spreadsheet RC-00 sudah dibuat (20 Agustus 2026) pada akun `bag.umum@uinsby.ac.id`, `scriptId` tercatat di `.clasp.json` pada direktori ini. Folder induk dan 10 file source sudah ter-*push*.
- Instalasi (menjalankan installer dari menu spreadsheet, mengisi form, mendaftarkan sumber CF) dilakukan pengguna langsung di browser — `google.script.run` pada dialog installer memerlukan sesi browser aktif dan tidak dapat dipicu dari sesi agent ini.
