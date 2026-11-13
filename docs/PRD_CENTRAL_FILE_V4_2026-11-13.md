# PRD — Central File UINSA v4 (web hybrid, multi-unit, multi-pengguna)

**13 November 2026 · Status: DRAF, menunggu persetujuan pemilik · Baseline sumber: 3.32.5 / schema 11 / @70 (`01aa6f5a`)**

Dokumen ini menetapkan target produk dan keputusan arsitektur untuk memindahkan Central File dari Google Apps Script + Sheets ke aplikasi web yang berjalan di desktop dan HP. Kontrak perilaku bisnis tetap mengikuti `HANDOFF_CENTRAL_FILE_UINSA_2026-11-13` §4–§5 dan `HANDOFF_PENGEMBANGAN_APLIKASI_ARSIP_UINSA.md` §2, §10, §12. Produksi @70 tidak diubah sampai cutover disetujui.

## 1. Masalah dan tujuan

| # | Masalah sekarang | Tujuan v4 |
| --- | --- | --- |
| 1 | Aplikasi hanya terbuka untuk akun pemasang (`access: MYSELF`), tidak praktis di HP | Satu aplikasi web (PWA) yang nyaman di desktop dan HP; petugas/pimpinan bisa mencari lokasi arsip dan membuka softcopy dari mana saja |
| 2 | Scan dilakukan di aplikasi lain, lalu diunggah | Scan dari kamera HP langsung menjadi PDF (dengan OCR bila memungkinkan), lalu lanjut isi metadata; unggah PDF dari alat lain tetap ada |
| 3 | Satu akun bersama, satu instance per unit | Login per orang, peran, banyak unit dalam satu sistem, backup teruji, dan paket usul pemindahan ke Record Center |

Bukan tujuan: membangun ulang Record Center (dikembangkan terpisah oleh pemilik), mode offline, pengelolaan arsip statis, pemusnahan otomatis, memindahkan file dari Google Drive.

## 2. Keputusan pemilik yang sudah masuk (13 November 2026)

1. Login memakai email + kata sandi biasa; tidak wajib akun `@uinsa.ac.id`.
2. Peran: Admin Pusat, Admin Unit, Petugas Arsip, Pimpinan (cari dan unduh).
3. Arsip terbatas/rahasia boleh dibuka dari luar kantor oleh Petugas Arsip dan Pimpinan.
4. Tidak ada larangan menyimpan metadata di luar Google; minta perlindungan enkripsi secukupnya.
5. Semua unit boleh dalam satu database dengan pemisahan ketat per unit. **Ini menggantikan keputusan federatif lama (handoff awal §2.2) untuk Central File.** Record Center tetap sistem terpisah.
6. File tetap di Google Drive `bag.umum@uinsa.ac.id` (asumsi kapasitas 10 TB).
7. Volume: kini ±80 berkas / ±2.000 item; per unit 80–400 berkas dan 10.000–20.000 item; PDF 500 KB – 100 MB.
8. Data harus tetap bisa dibuka dari spreadsheet walau aplikasi rusak.
9. Record Center: cukup kontraknya dijaga.
10. Tidak ada jembatan di Apps Script; langsung ke stack baru.
11. Scan dari HP → PDF; unggah PDF hasil alat lain tetap didukung.
12. OCR/searchable PDF bila memungkinkan.
13. Paket usul berisi metadata dan daftar saja; alih media tetap di Drive Central File.
14. Akun layanan atas nama instansi (`bag.umum@uinsa.ac.id`).
15. Online penuh.

## 3. Keputusan arsitektur

### 3.1 Stack terpilih

| Lapisan | Pilihan | Catatan |
| --- | --- | --- |
| Tampilan | React + TypeScript + Vite, PWA, mobile-first | Di-host di Cloudflare Pages (gratis, bandwidth tidak dibatasi seperti Netlify) |
| Database + login | Supabase: Postgres, Auth email/kata sandi, Row Level Security | Dua proyek gratis: produksi dan staging |
| Logika bisnis | Supabase Edge Functions (TypeScript) dengan transaksi SQL | Semua operasi tulis lewat server; penomoran memakai lock database |
| File | Google Drive akun instansi; database menyimpan ID Drive, checksum, ukuran | ID file lama tetap berlaku, jadi tidak ada migrasi file |
| Jembatan Drive/Docs | Cloudflare Pages Functions + Drive/Docs REST API dengan token akun instansi; cadangan: gerbang Apps Script bertanda tangan HMAC | Dipastikan lewat spike di Sprint 0 |
| Pekerjaan terjadwal | `pg_cron` + GitHub Actions | Backup, cermin spreadsheet, polling keputusan RC, penjaga agar proyek tidak dijeda |

### 3.2 Opsi yang dipertimbangkan

| Opsi | Kelebihan | Mengapa tidak dipilih |
| --- | --- | --- |
| Tetap Apps Script + login buatan sendiri | Tanpa migrasi, tanpa vendor baru | Transaksi lambat, konkurensi 40 pengguna berisiko, kamera tidak bisa dipakai di dalam iframe Apps Script; pemilik memilih stack baru |
| Supabase + Netlify | Seperti usulan awal | Sama, tetapi kuota gratis Netlify lebih ketat; Cloudflare Pages menggantikannya |
| Cloudflare D1 (SQLite) + Workers | 5 GB gratis, tidak dijeda | Tidak ada transaksi interaktif (aturan pinjam/penomoran jadi rumit), login harus dibangun sendiri, batas CPU 10 ms mengganggu hashing kata sandi |
| Firebase | Login dan hosting gratis | Basis data non-relasional, tidak cocok untuk relasi berkas–item–pinjaman–usul |

### 3.3 Batas paket gratis dan mitigasi

Angka dari sumber sekunder per November 2026; diperiksa ulang di halaman resmi saat Sprint 0.

| Batas Supabase gratis | Dampak | Mitigasi |
| --- | --- | --- |
| Database 500 MB | Perkiraan ±1,5–2 KB per item termasuk indeks → nyaman sampai ±100–150 ribu item seluruh unit | Indeks isi dan audit lama diarsipkan ke Drive; halaman admin menampilkan pemakaian dengan peringatan di 60% dan 80% |
| Dijeda setelah ±7 hari tanpa aktivitas | Aplikasi berhenti merespons sampai dibangunkan | Tugas terjadwal harian (backup) sekaligus menjaga proyek tetap aktif |
| Tanpa backup otomatis | Kehilangan data bila proyek rusak | Dump harian terenkripsi ke Drive + uji restore berkala (§6) |
| 2 proyek, egress 5 GB/bulan | Unduhan PDF tidak boleh lewat Supabase | File dialirkan lewat Cloudflare, bukan Supabase |

Bila 500 MB terlampaui setelah bertahun-tahun, jalur keluarnya: mengarsipkan data berkas yang sudah dipindahkan, pindah ke Postgres lain (skema Postgres standar, tanpa fitur khusus vendor di luar Auth), atau paket berbayar. Keputusan itu milik pemilik saat waktunya tiba.

### 3.4 Keamanan

- Kata sandi di-hash oleh Supabase Auth; akun dibuat oleh admin, tidak ada pendaftaran bebas.
- Row Level Security pada setiap tabel: pengguna hanya melihat unitnya; peran dan tingkat keamanan arsip diperiksa di server, bukan dengan menyembunyikan tombol.
- Enkripsi: data tersimpan terenkripsi di sisi penyedia dan semua lalu lintas memakai TLS. Kolom data pribadi (NIP/NIK, kontak) dan secret federasi dienkripsi di tingkat kolom. Dump backup dienkripsi sebelum disimpan ke Drive. Metadata arsip (uraian, judul) **tidak** dienkripsi per kolom karena harus bisa dicari.
- File Drive tidak dibagikan publik; setiap unduhan melewati pemeriksaan hak akses dan dicatat di audit.
- Secret hanya di penyimpanan secret layanan, tidak di repo (repo ini publik).

## 4. Pengguna, peran, dan unit

| Kemampuan | Admin Pusat | Admin Unit | Petugas Arsip | Pimpinan |
| --- | :-: | :-: | :-: | :-: |
| Kelola unit, rilis, backup, koneksi RC | ✔ | – | – | – |
| Kelola pengguna unit, master pegawai, pengaturan unit, Master Log | ✔ | ✔ | – | – |
| Penerimaan, pemberkasan, alih media, edit, batal, label | ✔ | ✔ | ✔ | – |
| Peminjaman, pengembalian, BA, Out Indicator | ✔ | ✔ | ✔ | – |
| Retensi, usul pemindahan | ✔ | ✔ | ✔ | – |
| Cari arsip, lihat lokasi, buka/unduh softcopy (termasuk terbatas/rahasia) | ✔ | ✔ | ✔ | ✔ |

Seorang pengguna terikat pada satu unit (Admin Pusat lintas unit). Setiap baris data membawa `unit_id`; nomor berkas, TRM, dan UP berurutan per unit. Asumsi kapasitas: 5–40 pengguna, sampai ±10 unit.

## 5. Ruang lingkup fungsional

**Dibawa utuh dari 3.32.5** (aturan rinci mengikuti handoff §4): penerimaan dan tanda terima, antrean dan pemberkasan, penomoran definitif, metadata dan klasifikasi keamanan, alih media, edit, koreksi dan pembatalan dengan karantina, cari metadata, laporan Daftar Berkas / Daftar Isi Berkas, cetak lidah folder, peminjaman multi-berkas dengan Out Indicator A5 dan Berita Acara Google Docs, monitoring retensi, usul pemindahan dan tiga dokumennya, Cek JRA, Cari Isi Berkas, Master Log, backup dan health.

**Baru di v4:**

1. **Akses HP.** Tata letak mobile-first; alur utama HP: cari → lihat lokasi (kabinet/laci/folder) → buka atau bagikan softcopy. Bisa dipasang sebagai aplikasi (PWA).
2. **Login dan multi-unit.** Sesuai §4; audit mencatat pelaku per orang, bukan akun bersama.
3. **Scan terintegrasi.** Kamera → deteksi tepi dan koreksi perspektif → banyak halaman → PDF → lanjut ke form metadata. Seluruh proses di perangkat, tanpa biaya layanan.
   - Deteksi/perspektif: `jscanify` (MIT) di atas OpenCV.js; sudut bisa digeser manual bila deteksi meleset.
   - OCR: `tesseract.js` (Apache-2.0) dengan bahasa Indonesia + Inggris, keluaran PDF berlapis teks. Dijalankan di latar; bila perangkat terlalu lambat, PDF tetap tersimpan tanpa lapisan teks.
   - `scribe.js` tidak dipakai karena lisensinya AGPL.
   - Kualitas di bawah CamScanner Pro untuk dokumen sulit (kusut, bayangan); diuji pada contoh arsip nyata di sprint scan.
4. **Cermin spreadsheet.** Setiap malam data tiap unit diekspor ke Google Sheets di Drive instansi (tabel kanonik + dua laporan), hanya-baca. Ini pengganti prinsip "data tetap terbuka dari spreadsheet".
5. **Backup sebagai paket.** Dump database terenkripsi + manifest file (ID Drive, checksum) per hari; paket per unit bisa diunduh Admin Pusat.

**Federasi Record Center.** Format amplop, event (`SUBMIT_TRANSFER_PROPOSAL`, `CANCEL_TRANSFER_PROPOSAL`, `QUERY_DECISION`), SHA-256, HMAC, dan model polling dipertahankan persis, sehingga endpoint RC yang ada tetap menerima kiriman v4. Tiap unit menjadi satu sumber terdaftar dengan ID instance dan secret sendiri; unit pilot mempertahankan ID `INS-6d92f552-…`. Status outbox teknis tetap terpisah dari status bisnis. Paket berisi metadata dan daftar; RC membaca dokumen usul melalui akses Drive seperti sekarang. Bila RC kelak pindah stack, kontrak ini yang menjadi acuan.

## 6. Kebutuhan non-fungsional

- **Kecepatan:** transaksi inti di bawah 3 detik pada jaringan seluler normal (target lama: di bawah 10 detik).
- **Integritas:** tidak ada nomor ganda atau data parsial; setiap operasi tulis memakai kunci idempotensi; soft delete saja.
- **Unggah:** PDF sampai <100 MB, langsung dari browser ke Drive secara resumable; metadata di-commit setelah file utuh.
- **Pemulihan:** kehilangan data maksimal 24 jam; restore diuji pada staging sebelum cutover dan tiap tiga bulan.
- **Audit:** append-only, hanya admin yang membaca.
- **Waktu:** tanggal lokal `Asia/Jakarta` disimpan sebagai tanggal; cap waktu audit sebagai waktu absolut.

## 7. Migrasi data pilot

1. Ekspor spreadsheet pilot (baca saja) → importer deterministik dan idempoten ke staging.
2. Semua ID lama dipertahankan (`BERKAS_ID`, `ITEM_ID`, `ARSIP_ID`, `PEMINJAMAN_ID`, `LOAN_GROUP_ID`, `USUL_PINDAH_ID`), termasuk rekod dibatalkan, riwayat nomor, audit, log cetak, snapshot usul.
3. File tidak dipindah: ID Drive lama tetap dirujuk.
4. Rekonsiliasi: jumlah berkas/item/lembar, pinjaman aktif, status usul dan outbox harus cocok dengan laporan lama. Paket `SENT` tidak dikirim ulang.
5. Cutover mengikuti handoff §6 M4: jeda tulis di Apps Script, impor delta, satu penulis dan satu set pekerja terjadwal, trigger lama dimatikan. Go/no-go oleh pemilik.

## 8. Urutan sprint

| Sprint | Isi | Hasil yang bisa dicoba pemilik |
| --- | --- | --- |
| S0 Fondasi | Kerangka repo, skema, login, peran, unit, RLS, spike jembatan Drive, verifikasi batas gratis, CI | Login di staging dari HP dan desktop |
| S1 Baca + impor | Importer data pilot, Cari Arsip, detail berkas/item, dashboard, buka softcopy | **Mencari lokasi arsip dan membuka PDF dari HP** dengan data pilot |
| S2 Registrasi | Penerimaan, tanda terima, antrean, pemberkasan, penomoran, unggah alih media | Input arsip ujung ke ujung |
| S3 Perubahan + laporan | Edit, pembatalan, karantina, lidah folder, cermin spreadsheet, backup dan restore | Laporan dan backup pertama |
| S4 Peminjaman | Pinjam/kembali multi-berkas, Out Indicator, Berita Acara Docs | Siklus pinjam lengkap |
| S5 Retensi + RC | Monitoring, usul, dokumen, outbox, polling keputusan | Usul ke RC uji |
| S6 Scan + isi | Scan kamera, OCR, Cari Isi Berkas, Cek JRA | Scan langsung dari HP |
| S7 Cutover | UAT §6 handoff, uji restore, rekonsiliasi, cutover | Produksi v4 |

Tiap sprint dikerjakan sub-agent, direview orchestrator, dan ditutup dengan tes otomatis; 87 tes lama menjadi acuan perilaku yang diterjemahkan ke rangkaian tes baru.

## 9. Yang dibutuhkan dari pemilik

1. Persetujuan PRD ini (stack §3.1, batas §3.3, urutan §8).
2. Membuat akun Supabase dan Cloudflare dengan `bag.umum@uinsa.ac.id`, lalu memberi kunci akses lewat jalur secret yang aman (bukan di chat atau repo).
3. Satu kali persetujuan akses Google Drive/Docs untuk jembatan file.
4. Ekspor baca-saja spreadsheet pilot untuk importer (S1).

## 10. Risiko terbuka

| Risiko | Penanganan |
| --- | --- |
| Paket gratis berubah atau dicabut | Skema Postgres standar, backup harian di Drive, cermin spreadsheet; pindah penyedia tanpa kehilangan data |
| Admin Workspace kampus menolak akses API Drive | Cadangan gerbang Apps Script yang sudah berizin |
| OCR di HP lambat atau kurang akurat | OCR opsional dan di latar; unggah PDF dari alat lain tetap tersedia |
| Kapasitas 500 MB lebih cepat habis dari perkiraan | Pemantauan pemakaian dan pengarsipan sejak S3 |
| Selisih perilaku dengan 3.32.5 | Tes terjemahan dan pembandingan laporan sebelum cutover |
