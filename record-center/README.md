# Record Center — RC-00 + RC-01

Status: **RC-00 dan RC-01 terpasang & di-deploy** pada akun `bag.umum@uinsby.ac.id` (instance ID `RC-8ae1f3f3-8542-48be-9c3d-ae51a2ed3ffd`). Ditulis dari nol pada 20–21 Agustus 2026 mengikuti spesifikasi handoff §13.2/§13.3 dan protokol poll pada `docs/ADDENDUM_2026-08-20_PROTOKOL_KEPUTUSAN_RC_CF.md`, karena source RC-00/RC-01 sebelumnya (v1.0.0 PILOT yang disebut di handoff) tidak pernah masuk git dan direktori kerjanya tidak lagi terjangkau dari sesi ini. Detail lihat "Status pemasangan" di bawah dan `docs/ADDENDUM_2026-08-21_RC01_DESAIN_ENDPOINT.md` untuk keputusan desain endpoint.

## Cakupan RC-00 (fondasi instance)

- Installer (`showRcInstallerDialog` / `AdminSetup.html`, atau jalur `ui.prompt()` cadangan) — membuat/mengikat spreadsheet Record Center, folder Drive terpisah, dan seluruh sheet fondasi.
- Sheet: `RC_SETTINGS`, `RC_SOURCE_REGISTRY`, `RC_AUDIT_LOG`, `RC_SYSTEM_MIGRATIONS`, `RC_SYSTEM_HEALTH`, `RC_SYSTEM_BACKUPS`.
- Folder: `01 PENERIMAAN USUL PINDAH`, `02 ARSIP INAKTIF`, `90 KARANTINA APLIKASI`, `99 BACKUP APLIKASI`.
- Registry sumber Central File: daftar/perbarui/nonaktifkan sumber, terbitkan shared secret (disimpan di Script Properties dengan kunci `SOURCE_SECRET_<sourceId>`, **tidak pernah** ditulis ke sheet — hanya tampil sekali saat diterbitkan).
- Health check, Audit Log, migrasi (`RC-REL-001`, schema 1), backup sinkron.
- Guard administrator (`isRecordCenterAdmin_`/`requireRecordCenterAdmin_`) — diperiksa di server, bukan hanya lewat access setting deployment (§22.3).

## Cakupan RC-01 (endpoint federatif) — `TransferInboxService.js`

- Sheet tambahan: `RC_INBOX_EVENTS` (log idempotensi/audit tiap event masuk), `PENERIMAAN_USUL_PINDAH`, `PENERIMAAN_USUL_BERKAS`/`PENERIMAAN_USUL_ITEM` (kolom snapshot identik `RETENTION_CF04_DETAIL_HEADERS_`/`RETENTION_CF05_ITEM_HEADERS_` di CF, minus kolom status internal CF), `RC_DECISION_OUTBOX`. Migrasi `RC-REL-002`, schema 2.
- `doPost()` menangani `SUBMIT_TRANSFER_PROPOSAL`, `CANCEL_TRANSFER_PROPOSAL`, `QUERY_DECISION` — validasi envelope lengkap (§12.3): instance tujuan cocok, sumber aktif terdaftar, usia event ≤24 jam, signature HMAC constant-time, **dan** hash payload (yang secara keamanan sama pentingnya dengan signature — lihat addendum §2).
- Dokumen wajib (Nota Dinas, XLSX, Riwayat JRA) + opsional (PDF) disalin dari Drive CF ke Drive RC sendiri (CF sudah membagikan akses viewer ke email admin RC saat pengajuan).
- Keputusan `DISETUJUI`/`DITOLAK` (alasan wajib ≥10 karakter untuk tolak) lewat menu spreadsheet — **bukan** dashboard Web App (lihat alasan di addendum §1: satu deployment saja, `doGet()` tidak pernah menampilkan data).
- `QUERY_DECISION` — kontrak protokol poll sudah siap di sisi RC; **belum diimplementasikan di CF** (itu kerja CF-06.1 berikutnya).

## Cara memasang (mengikuti handoff §19.3, diperbarui dengan langkah deploy)

1. Login akun Google yang ditetapkan sebagai Record Center pilot (**terpisah** dari akun Central File).
2. Buat Google Sheet baru kosong + folder Drive induk kosong.
3. Buka Extensions → Apps Script pada spreadsheet (membuat project Apps Script container-bound).
4. Push seluruh isi direktori ini (`clasp push` dengan `.clasp.json` diisi `scriptId` project itu).
5. Reload spreadsheet, jalankan menu **Record Center → 0. Otorisasi Awal**, lalu **Pasang Instance**, isi form.
6. Daftarkan Central File pilot sebagai sumber lewat menu **Daftarkan Sumber CF** — simpan shared secret yang diterbitkan.
7. Jalankan **Cek Status & Backup** sampai health check `OK`/`WARNING` (bukan `ERROR`).
8. **Deploy sebagai Web App** (`clasp deploy`) — manifest `appsscript.json` sudah diset `access: ANYONE_ANONYMOUS`, `executeAs: USER_DEPLOYING`. Catat URL `.../exec` yang dihasilkan.
9. Masukkan URL itu ke installer Central File (menu **Arsip Aktif → Update Koneksi Record Center**, field endpoint) bersama nama/instance ID/secret RC.
10. UAT: retry pengajuan CF yang `PENDING_CONFIGURATION`, pastikan berubah jadi `SENT` dan proposal muncul satu kali di RC (`Lihat Usul Menunggu Keputusan`).

## Status pemasangan

- **RC-00 terpasang dan Definition of Done §14 tuntas** (21 Agustus 2026): folder/sheet terbentuk, sumber CF terdaftar, health check bersih, backup terverifikasi read-only via Drive API.
- **RC-01 dibangun, di-deploy, dan diverifikasi read-only** (21 Agustus 2026):
  - Deployment: `AKfycbxKeg5QZdyOh1HIfQEaMSZFUIn3VVU3TvRJnw75c_F2_h_CRDsLfwDlM5Nyc0mbUyKUww` @1, access `ANYONE_ANONYMOUS` — dikonfirmasi lewat Apps Script API (`entryPointConfig.access`), bukan cuma asumsi dari manifest.
  - URL endpoint: `https://script.google.com/macros/s/AKfycbxKeg5QZdyOh1HIfQEaMSZFUIn3VVU3TvRJnw75c_F2_h_CRDsLfwDlM5Nyc0mbUyKUww/exec`
  - **Belum bisa diuji langsung dari sesi agent ini** — sandbox jaringan sesi ini memblokir domain `script.google.com` di level proxy (`connect_rejected`, kebijakan sandbox, bukan masalah pada deployment-nya). Verifikasi end-to-end sesungguhnya terjadi lewat `UrlFetchApp` asli dari infrastruktur Apps Script CF saat retry pengajuan — jalur jaringan yang sepenuhnya berbeda dari sandbox ini.
- Instance ID RC (bukan rahasia): `RC-8ae1f3f3-8542-48be-9c3d-ae51a2ed3ffd`.
- Sumber Central File pilot terdaftar aktif: `INS-6d92f552-1d7e-4935-a4e5-a04161ef6a75` (Bagian Umum Kantor Pusat – Biro AUPK).
- **CF sudah dikonfigurasi lengkap** termasuk endpoint URL di atas (lewat `updateRecordCenterConnectionViaPrompts` di CF) — belum diverifikasi hasil retry `UP-2026-0002` yang sesungguhnya.
- Tersisa: UAT retry `UP-2026-0002` (langkah 10 di atas), lalu CF-06.1 (implementasi `QUERY_DECISION` di sisi CF + trigger poll otomatis, sesuai addendum 2026-08-20).
