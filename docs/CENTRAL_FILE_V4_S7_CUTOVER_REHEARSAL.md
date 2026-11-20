# Sprint 7 — Latihan perpindahan Central File

Sistem produksi tetap **Central File 3.x (Apps Script)** sampai pemilik
memberi keputusan. Dokumen ini untuk latihan di salinan data. Hasil latihan
tidak mengubah aplikasi, akses, trigger, maupun data di kedua lingkungan.

## 1. Buat laporan pembanding BAGUM

1. Unduh **File → Download → Microsoft Excel (.xlsx)** dari Spreadsheet
   database Apps Script produksi. Gunakan workbook utuh, bukan Daftar Berkas
   atau Daftar Isi Berkas saja. Catat waktu ekspor.
2. Unduh backup terbaru unit **BAGUM** dari folder
   `CENTRAL FILE V4/BAGUM/BACKUP/` di Drive instansi. Untuk alat ini gunakan
   paket dengan `schema_version: "0028"`. Catat tanggal dan jam kedua salinan;
   usahakan berdekatan. Paket `_PLATFORM` diperlukan untuk latihan pemulihan,
   tetapi tidak untuk pembandingan per unit.
3. Jalankan di WSL/Linux dengan Node.js 22+, dari root repo pada branch yang
   memuat dokumen ini. Ganti kedua path dengan lokasi file yang sebenarnya.

```bash
npm ci --prefix v4/tools/import-legacy --no-audit --no-fund
node v4/tools/import-legacy/reconcile.mjs \
  --legacy "/mnt/c/path-ke-ekspor/Central File 3.x.xlsx" \
  --backup "/mnt/c/path-ke-backup/BAGUM.zip" \
  --unit BAGUM
```

Gunakan `> ~/rekonsiliasi-bagum.json` pada baris terakhir untuk menyimpan
keluaran di komputer instansi. Kode keluar **0** berarti cocok dalam cakupan
alat, **1** berarti ada temuan untuk diperiksa (JSON tetap dihasilkan), dan
**2** berarti input tidak dapat dipakai. Tidak perlu kredensial database,
PostgreSQL, atau akses jaringan setelah dependensi terpasang.

Laporan membandingkan ID berkas, item, tanda terima, dan item penerimaan
(termasuk draf dan riwayat penghapusan jika tercatat). Ia menghitung berkas
dan item aktif bernomor, lembar, dan item dengan referensi file. Ia menampilkan
ID yang hanya ada pada satu versi, nama kolom yang berbeda untuk ID yang sama,
kolom yang belum bisa dibandingkan, serta relasi induk utama yang hilang.
Perubahan PDF dilaporkan sebagai perbedaan referensi, tanpa membacanya.
Berkas dengan jadwal **MANUAL** atau **PENDING** di v4 ditandai terpisah;
kolom jadwal pada berkas tersebut tidak diperlakukan sebagai selisih biasa.

Tentukan tindakan untuk setiap temuan berdasarkan bukti transaksi dan waktu
ekspor. Data satu sisi bisa merupakan arsip baru yang sah. Metadata yang
berubah pada ID sama perlu ditinjau; nomor definitif dapat bergeser sehingga
nomor yang sama belum tentu menunjuk arsip yang sama. Jangan menjalankan
impor ulang di staging atau di produksi untuk menyelesaikan selisih ini.
Laporan tidak memuat uraian, nama orang, atau ID/URL Drive. ID arsip tetap
data internal; bagikan hanya ringkasan jumlah dan jenis temuan di luar alur
kerja instansi. Simpan workbook dan paket ZIP di penyimpanan instansi.

## 2. Uji sebelum meminta keputusan

| Pemeriksaan | Cara dan bukti yang diterima |
| --- | --- |
| Data dan Drive | Tidak ada selisih material yang belum diputuskan. Cek sampel dokumen lama dan baru di HP/desktop, termasuk PDF terbatas lewat akun yang berhak serta akun yang tidak berhak. Jumlah referensi dalam laporan tidak membuktikan file bisa dibuka. |
| Penerimaan, pemberkasan, perubahan | Ulangi alur yang sudah lulus di HP dengan data uji; tambahkan dua sesi menginput bersamaan, edit/ganti PDF, dan pembatalan. Periksa nomor unik, audit, indeks lama hilang saat PDF diganti, dan jejak sumber penerimaan tetap ada. |
| Pinjam/kembali | Cocokkan per transaksi dan per objek termasuk pinjaman lama yang belum kembali, serta arsip yang hanya memiliki status pinjam. Uji benturan item vs berkas penuh, pengembalian, Out Indicator, dan Berita Acara. Jumlah grup terbuka v4 di laporan bukan bukti riwayat pinjam setara. |
| JRA dan retensi | Coba berkas lama dan baru, tanggal acuan manual/kosong, H-7 sampai hari batas, dan habis aktif sehari sesudahnya. Pastikan berkas dipinjam/masuk usul mendapat perlakuan yang tepat. |
| Usul dan Record Center | Cocokkan status bisnis, histori, dan status pengiriman secara terpisah. Pastikan paket lama `SENT` tidak diputar ulang. v4 baru memiliki draf lokal; impor histori, paket, outbox, dan keputusan harus dituntaskan dan diuji di RC uji jika dipakai saat hari pertama, atau dijadwalkan terpisah dengan persetujuan pemilik. |
| Pencarian isi | Uji pindaian OCR baru, pergantian PDF, serta hasil akun lintas unit. Tentukan kebutuhan untuk DOCX dan PDF lama yang belum terindeks di v4 sebelum beralih. |
| Pemulihan dan penjadwalan | Ulangi [latihan restore](../v4/tools/restore-backup/README.md) untuk BAGUM dan _PLATFORM dari versi skema terbaru. Verifikasi hasil backup otomatis dan akses file sampel. Siapkan pemulihan login dan uji ulang indeks terpisah; kedua data tersebut tidak ikut dipulihkan dari paket metadata. |
| Isolasi produksi/staging | Tetapkan target yang terpisah dari staging, verifikasi unit, peran, akses Drive, alamat aplikasi dan tujuan job; jangan sambungkan staging ke Record Center produksi. |

Catat hasil tiap uji sebagai **lulus**, **gagal**, atau **belum diuji** dengan
tanggal, versi aplikasi/skema dan penanggung jawab. Lulus tes otomatis atau
status `COCOK_DALAM_CAKUPAN` tidak menggantikan uji ini.

## 3. Hari perpindahan, setelah disetujui pemilik

1. Sepakati waktu jeda, kontak operator, batas sebelum batal, dan tujuan
   penulisan produksi. Catat versi sumber, commit target, dan daftar job.
2. Jeda penulisan pada sumber dan target; tuntaskan atau catat unggahan,
   peminjaman, draf, dan pekerjaan yang masih terbuka. Ambil snapshot
   kedua sisi pada jeda yang sama; buat daftar delta yang direview.
3. Terapkan hasil rekonsiliasi yang disetujui pada target terpisah. Ulangi
   pembandingan, pemeriksaan relasi/nomor, akses file, dan uji operasi inti.
   Perpindahan tidak berjalan bila ada selisih material tanpa keputusan.
4. Setelah **go** dari pemilik, aktifkan hanya satu aplikasi penulis dan
   satu set job yang sudah diperiksa. Pantau akses, unggahan, pencarian,
   pengembalian pinjaman dan backup pertama. Pastikan riwayat status pengiriman
   tidak memicu pengiriman ulang.
5. Jika perlu kembali ke sumber, jeda tulis target dan job lebih dulu.
   Amankan transaksi yang terjadi setelah beralih dan rekonsiliasi ke sumber
   sebelum mengaktifkan kembali penulisan lama. Mengubah URL saja akan
   meninggalkan transaksi baru di target.
