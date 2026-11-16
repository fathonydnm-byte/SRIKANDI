# Central File v4 — Penyelesaian Sprint 3, cermin dan backup

**17 November 2026 · rencana rilis staging.** Produksi Apps Script @70 dan Record Center produksi tetap di luar rilis ini.

## Titik awal

- Pada 16 November, pemilik menguji dari HP: Penerimaan → Pemberkasan ke berkas baru → penomoran definitif otomatis → unggah lewat Alih Media → berkas terlihat di dashboard → PDF bisa dibuka.
- Staging sudah menerima migrasi penomoran 0023. Hash isi fungsi aktif `app.renumber_unit(app.actor,text[],text,text)` yang diverifikasi saat pemasangan: `ba11d19a4f0adf0a24c1d22dc87ad943`. Migrasi 0022 adalah pekerjaan terpisah dan tidak dilaporkan terpasang.
- Tampilan pemberkasan terakhir tayang lewat [run 43877636469](https://github.com/fathonydnm-byte/SRIKANDI/actions/runs/43877636469). Salinan yang sama dan migrasi 0023 disatukan ke cabang pengembangan dalam PR persiapan S3. CI PR juga menjalankan tes cermin serta pemulihan di database sementara.
- Rujukan setup: [PASANG.md](../v4/mirror-apps-script/PASANG.md). Rujukan sprint: [handoff](HANDOFF_CENTRAL_FILE_V4_2026-11-14.md) §7.

## Urutan staging setelah tinjauan

1. Periksa baris **0022 dan 0023 secara terpisah** di `public.schema_migrations_log`. Jangan mengandalkan `max(version)`: 0023 dipasang lebih dulu sebagai perbaikan di staging dan tidak berarti 0022 sudah ada.
2. Bila 0022 belum tercatat, jalankan [0022_s3_backup.sql](../v4/supabase/migrations/0022_s3_backup.sql) pada Supabase staging dalam satu transaksi. Periksa pencatatan 0022, keberadaan tabel/RPC backup, dan isi fungsi 0023 tetap sesuai. Jangan jalankan ulang 0019 secara terpisah karena definisi lamanya mengembalikan galat penomoran.
3. Deploy hanya commit yang ditinjau ke [Central File staging](https://central-file-uinsa.pages.dev). Buka **Cadangan & Cermin** sebagai Admin Pusat dan Admin Unit; verifikasi pembatasan hasil antarunit dan status awal belum pernah berjalan.
4. Pemilik membuat **proyek Apps Script baru** (bukan proyek produksi atau gerbang Drive). Pemilik menyetujui perlindungan bawaan Drive tanpa enkripsi tambahan untuk paket. Gunakan manifes baru dengan `drive.file` dan layanan lanjutan Google Sheets API v4; proyek cermin tidak meminta izin umum `spreadsheets`. Simpan `JOB_SECRET` langsung di pengaturan Cloudflare sebagai Secret; deploy ulang, lalu lakukan `runNow` terhadap URL staging. Aktifkan pemicu malam setelah hasil manual diverifikasi.
5. Periksa kedua hasil: cermin dapat dibaca, satu paket harian lengkap tercatat, status Admin Pusat dan Admin Unit sesuai. Latih pemulihan dari paket nyata di database kosong yang terpisah dan versinya cocok: dry-run, restore, lalu cocokkan manifest, jumlah baris, penomoran dan integritas relasi. Catat tanggal, hash manifest, hasil UI, serta hasil restore tanpa menyimpan data atau secret di GitHub.

Cermin adalah salinan satu arah. Jika pengujian berhenti atau gagal, nonaktifkan pemicu proyek cermin; jangan timpa atau hapus data sumber. Cadangan tidak mencakup akun login; pemulihan akun adalah prosedur terpisah.

## Sprint 4 setelah gate S3

Mulai fondasi Peminjaman: transaksi pinjam/kembali dalam satu grup, konflik berkas induk dengan itemnya, penomoran dan audit, serta data warisan dan log cetak. Out Indicator A5 dan Berita Acara Docs menyusul setelah aturan transaksi stabil. Jadikan status pinjaman baru sumber untuk penjaga edit/pembatalan dan ringkasan dashboard. Perbarui kontrak backup/restore bersama tabel S4 agar pinjaman ikut dipulihkan.
