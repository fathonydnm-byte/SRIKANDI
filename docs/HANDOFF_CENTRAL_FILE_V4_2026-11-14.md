# Handoff — Central File UINSA v4 (web hybrid, multi-unit)

**14 November 2026 · Status: STAGING, belum produksi · Branch kerja: `claude/clever-bardeen-mmrijr`**

Dokumen ini mencatat seluruh pekerjaan v4 dari awal sampai hari ini, keputusan yang sudah disepakati pemilik, keadaan staging, dan pekerjaan berikutnya. Produksi tetap aplikasi Apps Script 3.32.5 / schema 11 / deployment @70 (commit `01aa6f5a`); v4 tidak menyentuhnya. Dokumen pendamping: `docs/PRD_CENTRAL_FILE_V4_2026-11-13.md` (PRD yang disetujui) dan `docs/HANDOFF_CENTRAL_FILE_UINSA_2026-11-13` yang lama (kontrak perilaku 3.32.5; salinannya ada pada pemilik).

## 1. Mulai di sini

| Komponen | Acuan |
| --- | --- |
| Repo | `fathonydnm-byte/SRIKANDI` (publik), branch `claude/clever-bardeen-mmrijr`. Branch `claude/arsip-input-app-uinsa-m3uigw` berisi kode Apps Script produksi dan **tidak** memuat folder `v4/`. |
| Kode v4 | `v4/web` (aplikasi + Pages Functions), `v4/supabase` (migrasi + kontrak API), `v4/tests/db`, `v4/tools/import-legacy`, `v4/gateway-apps-script`, `v4/mirror-apps-script` (sedang dikerjakan) |
| Staging | https://central-file-uinsa.pages.dev |
| Hosting web | Cloudflare Pages, proyek `central-file-uinsa`, akun `bag.umum@uinsa.ac.id` |
| Database + login | Supabase, proyek `bycimuphbyfkwywcbsvx` (Singapura, Postgres 17), akun `bag.umum@uinsa.ac.id` |
| File | Google Drive `bag.umum@uinsa.ac.id`; file lama tetap di tempatnya, unggahan baru di `CENTRAL FILE V4/<kode unit>/…` |
| Gerbang Drive | Proyek Apps Script "Central File – Gerbang Drive" di akun `bag.umum`, sudah di-deploy pemilik (izin `drive.readonly` + `drive.file`) |
| Deploy | GitHub Actions `v4 deploy (staging)`, **hanya manual** (`workflow_dispatch`) |
| CI | GitHub Actions `v4-ci.yml` (web, database, importer) — belum pernah diperiksa hasilnya di GitHub |
| Akun pertama | `bag.umum@uinsa.ac.id`, peran Admin Pusat |

Rahasia tidak ada di repo. Nama dan lokasinya:

| Nama | Lokasi | Dibuat oleh |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | GitHub repo secret | Pemilik |
| `DRIVE_GATEWAY_URL`, `DRIVE_GATEWAY_SECRET` | Cloudflare Pages → Variables and Secrets | Pemilik (dari `setupGateway`) |
| `FILE_TICKET_SECRET` | Cloudflare Pages | Acak, dipasang lewat API |
| `UPLOAD_ATTEST_SECRET` | Cloudflare Pages **dan** Supabase Vault (nilai sama) | Acak, dipasang lewat API |
| `SUPABASE_SERVICE_ROLE_KEY` | Cloudflare Pages | Dari Supabase, dipasang lewat API |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Cloudflare Pages dan `v4-deploy.yml` | Publik secara rancangan |
| `JOB_SECRET` | Cloudflare Pages (belum ada; untuk cermin/backup) | Pemilik, nanti |
| Token Supabase dan Cloudflare untuk sesi agen | Environment cloud "SRIKANDI" (network secrets) | Pemilik |

Catatan: `DRIVE_GATEWAY_SECRET` di Cloudflare masih bertipe Text; sebaiknya diubah ke Secret.

## 2. Keputusan pemilik yang mengikat

### 2.1 Sebelum PRD (13 November)

1. Login email + kata sandi biasa; tidak wajib akun `@uinsa.ac.id`.
2. Peran: Admin Pusat, Admin Unit, Petugas Arsip, Pimpinan (cari dan unduh saja).
3. Arsip terbatas/rahasia boleh dibuka dari luar kantor oleh Petugas Arsip dan Pimpinan.
4. Tidak ada larangan menyimpan metadata di luar Google; minta perlindungan enkripsi secukupnya.
5. Semua unit boleh dalam satu database dengan pemisahan ketat per unit (menggantikan model federatif lama untuk Central File).
6. File tetap di Drive `bag.umum`; asumsi kapasitas 10 TB.
7. Volume: 10.000–20.000 item per tahun untuk **seluruh unit** (dikonfirmasi sebagai total per tahun).
8. Data harus tetap bisa dibuka dari spreadsheet walau aplikasi rusak.
9. Record Center dikembangkan pemilik secara terpisah; v4 hanya menjaga kontraknya.
10. Tidak ada jembatan sementara di Apps Script; langsung ke stack baru.
11. Scan dari HP menjadi PDF; unggah PDF hasil alat lain tetap didukung.
12. OCR/searchable PDF bila memungkinkan.
13. Paket usul pemindahan berisi metadata dan daftar saja; alih media tetap di Drive Central File.
14. Akun layanan atas nama instansi (`bag.umum@uinsa.ac.id`).
15. Online penuh, tanpa mode offline.

### 2.2 Persetujuan PRD dan sesudahnya

16. Stack disetujui: React PWA di Cloudflare Pages, Supabase, file di Google Drive.
17. Batas 500 MB Supabase gratis diterima untuk awal; bila penuh, pemilik mengusulkan paket berbayar ke pimpinan.
18. Kualitas scan di bawah CamScanner Pro diterima; unggah PDF dari alat lain tetap jalur utama.
19. Urutan sprint disetujui; mode baca dari HP didahulukan.
20. Tab "DOKUMEN ISO" dan "DAFTAR ARSIP ELEKTRONIK" di spreadsheet pilot diabaikan (tidak dipakai).
21. Kolom Arsip Vital/Terjaga yang kosong berarti "bukan".
22. Dashboard harus mengikuti tampilan Apps Script: lima kartu, Daftar Isi Berkas yang bisa digulir, pintasan pinjam/H-7/habis aktif; kotak "Koneksi server" dihapus.
23. Pola kerja: orchestrator memecah pekerjaan ke sub-agent, mereview hasilnya, dan hanya meminta persetujuan pemilik untuk hal yang sangat penting. Pekerjaan yang tidak terlalu kompleks memakai sub-agent Sonnet; yang rawan (penomoran, keamanan, transaksi) memakai Opus. Semua hasil tetap direview dan diuji ulang orchestrator.

### 2.3 Keputusan orchestrator (pemilik sudah diberi tahu; bisa diubah)

- Logika tulis berada di fungsi RPC Postgres, bukan Edge Functions (revisi PRD §3.1).
- Unggahan baru masuk ke pohon folder buatan aplikasi; gerbang tidak bisa mengubah atau menghapus file lama.
- PDF diunggah setelah item tersimpan (jalur Alih Media), bukan dalam satu kali kirim.
- Karantina dicatat di database, bukan dengan memindahkan file di Drive.
- Kata konfirmasi pembatalan "HAPUS"; bukti pembatalan hanya bisa dibuka admin.
- Mengubah judul berkas ikut mengganti nama folder buatan aplikasi.
- Klasifikasi primer tanpa turunan diterima; bukti boleh ditempel ke tanda terima yang sudah dibatalkan (keduanya seperti 3.x).
- Akun dibuat admin dengan kata sandi sementara; wajib ganti saat pertama masuk.
- Label lidah folder memakai huruf Times seperti aplikasi lama; judul tidak lagi menimpa logo (di 3.x menimpa).
- Paket backup tidak dienkripsi tersendiri (tersimpan di Drive yang sama dengan semua PDF arsip; kolom data pribadi tetap terenkripsi).

### 2.4 Pertanyaan terbuka untuk pemilik

- Apakah edit dan pembatalan harus ditolak untuk berkas yang sedang dalam usul pemindahan atau sudah dipindahkan? (3.x mengizinkan; v4 mengikuti 3.x.)
- Apakah ekspor spreadsheet pilot yang diimpor adalah salinan terbaru? Isinya 32 berkas / 154 item, lebih kecil dari perkiraan pemilik (±80 berkas / ±2.000 item).
- Apakah paket backup tetap perlu dienkripsi tersendiri?

## 3. Arsitektur

```text
HP / PC ──► Cloudflare Pages (React PWA + Pages Functions)
              │  baca & tulis: supabase-js → RPC Postgres (RLS + otorisasi di fungsi)
              ├─► Supabase: Postgres, Auth, Vault
              └─► /api/files/*  ──► Gerbang Apps Script (token Drive sementara, HMAC)
                                   └─► Google Drive bag.umum (unduh lewat Range; unggah resumable)
```

- **Pemisahan unit:** RLS aktif dan dipaksa di setiap tabel. Klien hanya punya SELECT dalam unitnya; semua tulis lewat RPC `SECURITY DEFINER` yang memeriksa peran dan unit dari `auth.uid()`.
- **Integritas:** kunci per unit untuk penomoran, kunci idempotensi per permintaan, soft delete saja, audit append-only, pemicu yang menolak hapus permanen.
- **Konvensi galat:** SQLSTATE `P0001`, pesan `"<KODE>: <pesan>"`, kode yang sama di `hint`.
- **Unduhan:** tiket bertanda tangan 10 menit; hak akses dicek lewat `get_file_access`, akses dicatat lewat `log_file_access`. Token Google tidak pernah sampai ke browser.
- **Unggahan:** `upload_begin` → sesi resumable Drive → browser mengirim potongan langsung ke Google (cadangan: lewat `/api/files/upload-chunk`) → server memverifikasi file di Drive → `upload_commit` dengan atestasi HMAC (`UPLOAD_ATTEST_SECRET`). Tanpa atestasi, file tidak bisa ditautkan.
- **Kunci admin Supabase** hanya dipakai di `server/adminUsers.ts` (dan nanti `server/jobsExport.ts`), selalu setelah gerbang otorisasi.
- **Kontrak API:** `v4/supabase/API_S2.md` dan `API_S3.md`. Pemetaan kolom lama → baru: `v4/supabase/LEGACY_COLUMN_MAP.md`.

## 4. Riwayat sprint

Angka tes adalah hasil yang dijalankan ulang orchestrator, kecuali disebut lain.

| Sprint | Isi | Status |
| --- | --- | --- |
| Pra-sprint | Pembacaan handoff, kode 3.32.5 dan Record Center; temuan penyebab aplikasi tidak jalan di HP (`access: MYSELF`); 15 pertanyaan ke pemilik; PRD | Selesai, PRD disetujui |
| S0 Fondasi | Skema inti (unit, profil, peran, audit, penghitung, berkas, item, penerimaan), RLS, enkripsi kolom data pribadi, kerangka PWA, login, hak akses per peran, CI | Selesai, tayang |
| S1 Baca + impor | Importer spreadsheet lama, Pencarian Arsip, detail item/berkas, dashboard setara 3.x, unduhan PDF aman lewat gerbang | Selesai, tayang; pemilik sudah membuka PDF dari HP |
| S2 Registrasi | Penerimaan + tanda terima + cetak, antrean, pemberkasan, input manual, penomoran definitif, Alih Media, jembatan unggah | Selesai, tayang; unggah ke Drive asli **belum dikonfirmasi** |
| S3 bagian 1 | Master Log, Cetak Lidah Folder, Perubahan, Koreksi & Pembatalan, Karantina, Kelola Pengguna | Selesai, tayang; beberapa alur belum diuji pemilik (§6) |
| S3 bagian 2 | Cermin spreadsheet, backup harian, alat pemulihan, halaman "Cadangan & Cermin" | **Sedang dikerjakan**, belum direview |
| S4 Peminjaman | Pinjam/kembali multi-berkas, Out Indicator A5, Berita Acara Google Docs | Belum mulai |
| S5 Retensi + RC | Monitoring, usul pemindahan, tiga dokumen, outbox, polling keputusan | Belum mulai |
| S6 Scan + isi | Scan kamera, OCR, Cari Isi Berkas, Cek JRA | Belum mulai |
| S7 Cutover | UAT, uji pemulihan, rekonsiliasi, perpindahan produksi | Belum mulai |

### Rincian per sprint

**S0.** Migrasi 0001–0005. Kontrak: `units`, `profiles`, enum peran, `unit_settings`, `audit_log`, `idempotency_keys`, `counters`, `app.next_counter`, `my_account_status()`. Web: Vite + React + TypeScript, PWA, layar login/lupa sandi/ubah sandi, satu modul hak akses (`src/auth/permissions.ts`) untuk menu dan penjaga rute.

**S1.**
- Importer (`v4/tools/import-legacy`): berbasis nama header, satu transaksi, idempoten, laporan rekonsiliasi. Pada ekspor pilot: 32 berkas (4 dibatalkan), 154 item (16 dibatalkan), 16 tanda terima, 173 klasifikasi, 414 riwayat nomor, 751 baris audit; tanpa penolakan; 28 berkas aktif dan 138 item aktif cocok dengan DAFTAR BERKAS dan DAFTAR ISI BERKAS (1.525 lembar).
- Migrasi 0006–0009: pencarian (porting `searchArchive_`), kolom lama yang belum terpetakan, akses file, dashboard. Pencarian diperbaiki dari ±3,8 detik menjadi <10 milidetik pada 20.000 item (indeks trigram tidak terpakai di bawah RLS; diganti kolom `search_doc` + pembantu).
- Jembatan unduh: `functions/api/files/ticket.ts`, `download.ts`; gerbang Apps Script.

**S2.** Migrasi 0010–0015. RPC: `receipt_save`, `receipt_cancel`, `receipt_print_prepare/confirm`, `filing_commit`, `item_create_manual`, `upload_begin/commit/cancel/register_folder`, `drive_task_list/complete`, dan RPC opsi. Penomoran ulang hasil porting menghasilkan nomor yang sama persis dengan data pilot. Dua belas penyimpanan serentak mendapat nomor TRM berurutan; satu baris penerimaan yang diberkaskan empat sesi sekaligus hanya berhasil sekali.

**S3 bagian 1.** Migrasi 0016–0021.
- Lidah folder: A4, 2×7 label 70×30 mm, posisi awal 1–14, posisi terkunci 25,4 mm dari tepi kertas, tanda "Perlu cetak ulang".
- Master Log: seluruh log dengan filter dan rincian sebelum–sesudah; hanya admin.
- Edit/Pembatalan: `item_update`, `berkas_update_title`, `archive_cancel`, `edit_options`, `cancel_options`, `quarantine_list`; satu fungsi pengaman pinjam (`app.assert_not_borrowed`) yang akan diarahkan ke tabel pinjaman di S4. Membatalkan item mengembalikan baris penerimaan ke antrean sehingga tanda terimanya bisa dibatalkan.
- Kelola Pengguna: `user_list`, `user_admin_authorize`, `user_profile_upsert_service`, `password_changed`; `functions/api/admin/users.ts`.

### Beda perilaku dari 3.32.5 yang perlu diketahui pengguna

- Unduhan PDF tidak butuh akses Drive; setiap pembukaan dicatat di audit.
- Tanda terima dan label dicetak lewat dialog cetak browser, bukan file PDF buatan aplikasi.
- "Sedang Dipinjam" di dashboard menghitung berkas berstatus dipinjam dari data impor, bukan jumlah transaksi, sampai S4.
- Daftar H-7 dan Habis Aktif baru berupa daftar baca sampai S5.
- Master Log menampilkan seluruh log berhalaman (3.x: 200–500 baris terbaru).
- Sesi unggah kedaluwarsa 24 jam (3.x: 7 hari); bukti tanda tangan kedua ditolak dengan pesan jelas.
- Klasifikasi, nomor surat, dan retensi tidak bisa diubah dari layar Perubahan (sama seperti 3.x).

## 5. Keadaan staging

- Database: migrasi 0001–0021 terpasang; ±14 MB dari 500 MB (diukur setelah impor pertama). Migrasi 0022 belum dipasang.
- Data: satu unit (`BAGUM`, Bagian Umum Kantor Pusat – Biro AUPK, instance lama `INS-6d92f552-…`) berisi impor ekspor pilot, ditambah 9 jenis naskah, 20 log cetak tanda terima, 15 log cetak lidah, 7 baris karantina.
- Tab lama yang **belum** diimpor (menunggu sprintnya): PEMINJAMAN 14, LOG_CETAK_BERITA_ACARA 28, LOG_CETAK_OUT_INDICATOR 9 (S4); USUL_PINDAH 3, USUL_PINDAH_DETAIL 3, USUL_PINDAH_ITEM 6, OUTBOX_RECORD_CENTER 1, MASTER_JRA 0 (S5); DB_SEARCH_DOCUMENTS 1 (S6); SYSTEM_BACKUPS 120, SYSTEM_JOBS 120, SYSTEM_JOB_QUEUE 75, SYSTEM_HEALTH_LOG 122, SYSTEM_MIGRATIONS 13 (belum diputuskan: diarsipkan sebagai histori).
- Kunci rahasia Record Center lama sengaja tidak diimpor; dipasang ulang di S5.
- Pendaftaran akun bebas di Supabase dimatikan.
- Tes terakhir yang dijalankan orchestrator: database 229, importer 15, web 347, gerbang 11 — semuanya lulus. Angka ini belum mencakup pekerjaan S3 bagian 2.

Cara memasang perubahan:

1. Migrasi: jalankan berkas SQL berurutan lewat Supabase Management API (`POST /v1/projects/<ref>/database/query`); semua migrasi aman dijalankan ulang.
2. Web: jalankan workflow `v4 deploy (staging)` secara manual pada branch kerja.
3. Variabel Cloudflare berubah → deploy ulang supaya terpakai.
4. Deploy langsung dengan wrangler dari sesi agen tidak berfungsi (token unggahan tertimpa proxy sesi); selalu lewat GitHub Actions.

## 6. Yang belum terbukti

| Hal | Keadaan |
| --- | --- |
| Unggah PDF ke Drive asli (Alih Media, bukti tanda terima) | Gerbang sudah diperbarui pemilik; unggah nyata belum dikonfirmasi. Unggahan langsung browser → Google baru diuji dengan Drive tiruan; jalur cadangan lewat server tersedia |
| Ganti PDF, bukti pembatalan, membuka file karantina | Belum pernah berjalan dengan Drive asli |
| Kelola Pengguna ujung ke ujung (buat akun → masuk → wajib ganti sandi) | Layanan login Supabase sudah diuji langsung; alur lengkap di aplikasi belum |
| Email reset kata sandi | Belum dikonfirmasi; email bawaan Supabase gratis sangat terbatas |
| Label lidah folder di printer dan kertas stiker | Belum; PDF berhuruf Times juga belum dilihat ulang |
| Dialog konfirmasi pembatalan di HP | Tata letaknya belum dilihat langsung |
| Instalasi PWA dan "Bagikan berkas" di HP | Belum |
| CI di GitHub | Belum diperiksa |
| Batas paket gratis Supabase/Cloudflare | Dari sumber sekunder; belum dicek di halaman resmi |
| Pemulihan dari backup | Belum ada sampai S3 bagian 2 selesai |

## 7. Pekerjaan berikutnya

### S3 bagian 2 — cermin spreadsheet dan backup (sedang berjalan)

Rancangan: proyek Apps Script kedua (`v4/mirror-apps-script`) di akun `bag.umum`, berjalan tiap malam, mengambil data lewat `POST /api/jobs/export` (bertanda tangan `JOB_SECRET`), menulis satu spreadsheet cermin per unit (nama tab dan kolom seperti spreadsheet lama, termasuk DAFTAR BERKAS dan DAFTAR ISI BERKAS) dan satu paket backup harian di `CENTRAL FILE V4/<kode unit>/BACKUP/`. Migrasi 0022 (`backup_runs`, `job_nonces`), alat `v4/tools/restore-backup`, halaman "Cadangan & Cermin". Pekerjaan malam ini sekaligus mencegah proyek Supabase dijeda.

Setelah direview: pasang 0022, deploy, lalu pemilik memasang proyek Apps Script kedua dan menambahkan `JOB_SECRET` di Cloudflare.

### S4 — Peminjaman

Porting `LoanService`, `OutIndicatorPrint`, `BeritaAcaraService`: satu grup per transaksi, sampai 100 objek, berkas penuh bentrok dengan item anaknya, pengembalian membebaskan seluruh grup, Out Indicator A5 per berkas, satu Berita Acara Google Docs per transaksi yang bisa diedit dan dibuat ulang dari template. Impor PEMINJAMAN dan dua log cetaknya. Arahkan `app.assert_not_borrowed` ke tabel pinjaman dan kartu "Sedang Dipinjam" ke jumlah transaksi. Kolom NIP/NIK dan nomor WhatsApp peminjam dienkripsi; kuncinya perlu disimpan di Supabase Vault. Berita Acara butuh gerbang bisa menyalin template dan mengisi Docs — izin gerbang perlu ditinjau lagi.

### S5 — Retensi dan Record Center

Monitoring H-7/habis aktif dengan aksi, draft usul (maks. 200), snapshot beku, Daftar Arsip Usul Pindah PDF/XLSX, Riwayat JRA, Nota Dinas disposisi, paket JSON, outbox, polling keputusan. Kontrak federasi dipertahankan persis (`SUBMIT_TRANSFER_PROPOSAL`, `CANCEL_TRANSFER_PROPOSAL`, `QUERY_DECISION`, SHA-256, HMAC, status outbox terpisah dari status bisnis; lihat `docs/ADDENDUM_2026-08-20…` dan `…08-21…`). Paket `SENT` hasil impor tidak boleh dikirim ulang. Kirim hanya ke Record Center uji sampai pemilik mengizinkan.

### S6 — Scan dan pencarian isi

Scan kamera di `src/lib/scan.ts` (titik sambung sudah ada): `jscanify` + OpenCV.js, PDF dengan `pdf-lib`, OCR `tesseract.js` (Indonesia + Inggris) di latar. Cari Isi Berkas dari DOCX seperti 3.31.0; indeks menjadi STALE saat PDF diganti (kaitnya sudah ada: `app.invalidate_file_derivatives`). Cek JRA dari spreadsheet rujukan.

### S7 — Cutover

Ikuti handoff lama §6: UAT pemilik, uji pemulihan, impor ulang dari ekspor terbaru, rekonsiliasi, jeda tulis di Apps Script, satu penulis dan satu set pekerja terjadwal, trigger lama dimatikan, go/no-go oleh pemilik. Proyek Supabase kedua untuk memisahkan staging dan produksi belum dibuat. Belum ada pull request ke branch utama.

### Utang kecil

- Aturan pembatas laju Cloudflare untuk `/api/files/*` dan `/api/admin/*`.
- Halaman pemakaian database dengan peringatan 60% dan 80%.
- `DRIVE_GATEWAY_SECRET` diubah ke tipe Secret.
- Unggahan yang sedang berjalan tidak bisa dilanjutkan setelah halaman dimuat ulang penuh.
- Impor ulang berkas bernomor tanpa item aktif akan menggagalkan penomoran ulang (tidak ada di data pilot).

## 8. Prompt untuk sesi baru

> Lanjutkan Central File UINSA v4 berdasarkan `docs/HANDOFF_CENTRAL_FILE_V4_2026-11-14.md` dan `docs/PRD_CENTRAL_FILE_V4_2026-11-13.md` pada branch `claude/clever-bardeen-mmrijr`. Baca `v4/supabase/API_S2.md`, `API_S3.md`, dan migrasi 0010 sebelum menulis RPC baru. Bertindak sebagai orchestrator: pecah pekerjaan ke sub-agent (Sonnet untuk yang tidak terlalu kompleks, Opus untuk penomoran, keamanan, dan transaksi), jalankan ulang semua tes sendiri, dan minta persetujuan pemilik hanya untuk hal yang sangat penting. Selesaikan dan review S3 bagian 2, lalu lanjut S4. Jangan ubah produksi Apps Script, jangan kirim apa pun ke Record Center produksi, dan jangan deploy pekerjaan yang belum direview ke staging.
