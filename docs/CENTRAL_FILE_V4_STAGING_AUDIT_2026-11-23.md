# Audit Central File v4 dan baseline staging

Pemeriksaan dilakukan pada 23 November 2026 (WIB) untuk versi v4 di
[`central-file-uinsa.pages.dev`](https://central-file-uinsa.pages.dev/).
Perbaikan audit disiapkan terpisah dari branch rilis. Sprint 8 dan integrasi
Record Center tetap dijeda.

## Bukti kecocokan

| Bagian | Bukti |
| --- | --- |
| Deploy terakhir | [GitHub Actions run 44657692945](https://github.com/fathonydnm-byte/SRIKANDI/actions/runs/44657692945) berhasil mengirim commit `ebb549c1656c4dbe886cdb47bcf43c9467a2ce1f` ke Cloudflare. Log mencatat [URL deployment `3a0c6967`](https://3a0c6967.central-file-uinsa.pages.dev/). HTML di URL itu sama dengan HTML pada domain staging. |
| Branch rilis | `release/v4-edit-item-hierarchy-20261120` menunjuk ke `8f0773299122cbd9b53ba0c914fa51373e3c3c17`. Dibandingkan commit yang dikirim, satu-satunya perubahan adalah `.github/workflows/v4-deploy.yml` yang mengembalikan pemicu manual. Kode aplikasi, Functions, migrasi, dan sumber Apps Script sama di kedua commit. |
| Aset publik | `npm ci` dan `npm run build` dengan konfigurasi browser dari workflow staging menghasilkan 56 berkas publik yang semuanya identik byte per byte dengan berkas yang disajikan staging. Konfigurasi internal Pages (`_headers`, `_redirects`, `_routes.json`) bukan aset unduhan publik. `/edit` dan `/retensi` mengembalikan halaman HTML. |
| Functions live | Permintaan POST tanpa autentikasi mendapat `401 UNAUTHENTICATED` dari tiket file dan `401 JOB_DENIED` dari endpoint ekspor. Ini memverifikasi rute dan penolakan permintaan tanpa autentikasi; belum menguji alur tulis atau isi data staging. |
| Supabase staging | Pada 23 November 2026, pemilik menjalankan kueri baca saja pada proyek staging. `public.schema_migrations_log` melaporkan 28 migrasi dan versi terbaru `0028`, sesuai baseline repo. Ini memverifikasi log migrasi, bukan diff seluruh definisi skema. |
| Gerbang Drive (Apps Script) | Tangkapan layar konsol pada 23 November 2026 menunjukkan satu deployment aktif bernama Gerbang Drive v2, menggunakan Version 2 (dibuat 14 November 2026); v1 diarsipkan. `DRIVE_GATEWAY_URL` pada Cloudflare Pages bertipe Secret. Pemetaan staging ke deployment ini serta kecocokan isi Version 2 dengan repo belum dikonfirmasi. |

Sidik jari SHA-256: HTML utama
`025cbafed91554707b369d781660ddff08f154d9e834e2be46896b75795081b5`;
`/assets/index-BQNgerKP.js`
`b5bece2a1458a7a7138b58dfb64fc0cef018c8b53034cd98678b0b0c15d66458`;
`/sw.js`
`47efbad33ed9678a959aadc05096256a458366b1d35112a21fd623732db04c7d`.

## Temuan dan perbaikan pada branch audit

| Bagian | Temuan dan hasil |
| --- | --- |
| Antrean unggah dan akun | Antrean sebelumnya hidup lebih lama daripada sesi akun. Kini pergantian akun membuang file dan pekerjaan lokal, meminta pembatalan pekerjaan lama, dan mengabaikan hasil yang datang terlambat. Pembaruan token untuk akun yang sama tidak mengganggu antrean. |
| Unggah resumable | Pembatalan ketika sesi baru dibuka kini menutup sesi saat respons tiba. Respons Drive yang berulang tanpa kemajuan mengikuti batas percobaan ulang. |
| Dashboard | Gangguan pencarian uraian item kini dibedakan dari hasil kosong dan dapat dicoba lagi. Segarkan Data membatalkan pencarian rincian lama sehingga respons yang terlambat tidak mengganti isi terbaru. Pengambilan item memakai satu permintaan yang mengikuti batas 100 berkas; jalur pecah batch yang tidak terpakai dihapus. |
| Pemulihan | `--dry-run` tidak lagi mengubah urutan cetak label. Pemulihan yang disimpan menaikkan sequence hanya jika diperlukan, dalam transaksi yang sama dengan data. |

Review menelusuri sumber web, Functions, SQL/RPC, gerbang Drive, cermin,
dan alat impor/pemulihan menurut alur: autentikasi dan peran; penerimaan,
pemberkasan, edit/pembatalan; pencarian, PDF/OCR; peminjaman, retensi dan
draf; serta cadangan. Pemeriksaan statis mencakup TypeScript (termasuk
variabel/parameter tidak terpakai), lint dan build. Tidak ada migrasi baru,
dependensi baru, atau perubahan pada kontrak Record Center.

Validasi lokal: 440 tes web/Functions, 269 tes database, 48 tes Apps
Script, 18 tes importer, dan 14 tes cadangan/pemulihan lulus. PostgreSQL
16 lokal memakai loopback karena lingkungan ini tidak mengizinkan soket
Unix; database dan Drive untuk tes memakai data sintetis. Pemindaian
dependensi runtime web oleh registry npm tidak melaporkan advisori pada
saat pemeriksaan.

## Pemeriksaan lanjutan yang masih relevan

- Dalam tampilan lintas unit, identitas berkas tidak selalu mencakup unit.
  Skema membedakan berkas dengan pasangan `(unit_id,id)`, sementara
  `dashboard_berkas_items` mengelompokkan berdasarkan `berkas_id` saja.
  Sebelum perluasan ke banyak unit, uji dua unit dengan ID arsip historis
  sama, dan sertakan unit pada pengelompokan serta navigasi detail. Belum
  ada bukti benturan di data staging yang diperiksa.
- Untuk Gerbang Drive, cocokkan URL deployment dari catatan pemasangan internal jika tersedia. Tanpa catatan, buka satu PDF yang sudah ada di staging dan gunakan waktu buka serta log Web App `doPost` sebagai petunjuk. Jika token Drive masih tersimpan di cache, tidak selalu ada eksekusi Apps Script baru. Uji fungsional tidak membuktikan nilai URL atau kecocokan kode byte per byte. Jangan mengganti secret hanya untuk pemeriksaan ini.
- Sebelum memasang hasil audit, lakukan uji dengan akun uji berizin
  menggunakan arsip contoh: login, pencarian, buka PDF, unggah/batalkan,
  ganti akun, serta baca status cadangan. Simpan bukti versi deployment.
