# Central File 3.30.5 — metadata penggantian PDF

Tanggal persiapan: 15 September 2026. Schema tetap 10.

## Status pemasangan

Perbaikan source dan pengujian lokal selesai. **Belum dipasang di Apps Script
atau deployment produksi**; sesi browser memerlukan login kembali. Baseline live
terakhir yang diverifikasi pada 14 September 2026 adalah 3.30.4.

## Penyebab dan perbaikan

Form Perubahan Arsip mengirim `editSecurityClassification` dan `editCondition`,
tetapi `sanitizeEditUploadForm_` tidak memasukkan kedua field ke sesi upload.
Saat `finalizeEditReplacementUpload_` meneruskan `session.form` ke
`updateArchiveItem_`, klasifikasi menjadi kosong dan validasi menggagalkan
penyimpanan meskipun pilihan pada UI sudah terisi. Kondisi fisik juga hilang.

`UploadService.js` kini mempertahankan kedua field dan memvalidasinya sebelum
membuka sesi upload Drive. Validasi wajib klasifikasi tetap berlaku; nilai kosong
tidak diganti otomatis menjadi Biasa/Terbuka. Tidak diperlukan migrasi sheet.

## Pengujian

Jalankan `node --test tests/edit-replacement-upload.test.cjs` dari root repository.
Sembilan pengujian lulus dengan layanan Google diganti simulasi in-memory:
keempat klasifikasi, kondisi fisik, finalisasi berulang, input tidak valid sebelum
upload, serta perubahan metadata tanpa PDF. Pada source 3.30.4, delapan pengujian
tersebut gagal sehingga tes menangkap regresi yang dilaporkan.

Ini belum merupakan uji transaksi pada Google Drive/Sheets sungguhan.

## Pemasangan dan pemeriksaan

1. Cocokkan source live dengan baseline sebelum menerapkan perubahan.
2. Pasang `UploadService.js` (editor: `UploadService.gs`) dan `Config.js`
   (editor: `Config.gs`) ke project Central File yang benar.
3. Buat versi Apps Script baru, perbarui deployment stabil ke versi tersebut,
   lalu catat nomor versi dan commit. Jangan gunakan deployment HEAD.
4. Muat ulang aplikasi agar sesi upload lama yang kehilangan metadata tidak
   digunakan kembali. Pilih item/PDF dan isi kembali form, lalu simpan.
5. Periksa klasifikasi, kondisi fisik, tautan PDF baru, dan karantina PDF lama
   pada transaksi yang memang ingin dilakukan pemilik. Jangan membuat transaksi
   produksi hanya untuk pengujian tanpa izin.

Rollback kode: arahkan deployment stabil ke versi produksi sebelumnya yang
dicatat sebelum pemasangan. Schema tidak berubah.
