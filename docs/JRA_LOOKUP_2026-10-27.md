# Cek Jadwal Retensi Arsip — 27 Oktober 2026

Status: terpasang dan terverifikasi live pada deployment @64, 27 Oktober 2026 pukul 10.09 WIB. Akun proyek bag.umum@uinsa.ac.id; rilis 3.31.0/schema 11. Source fitur commit 2a664302b2485be765eb1ebffb5e99ec6475d8d2 pada branch feat/berkas-content-search, baseline 9126ee56e390462186de2b56361fc6ad0d4f284f (@63). URL aplikasi dan akses Hanya saya sendiri tetap.

Aplikasi: https://script.google.com/a/macros/uinsa.ac.id/s/AKfycby61nrRsmp5SyiTnySxIiHrf_DDAOdmqVJnNPwwq2BBY9EmCly_sTjR-9ZhLb3TRClv/exec

## Fitur

Pencarian referensi JRA pada Input Arsip / Identitas Berkas Baru, setelah Retensi Manual dan tepat sebelum Lokasi Fisik. Operator mengetik kata, menekan Cari JRA atau Enter, melihat jenis arsip, retensi aktif, retensi inaktif, nasib akhir/keterangan, dan link baris sumber. Sepuluh hasil per halaman dengan tombol Tampilkan selanjutnya; seluruh kecocokan bisa ditelusuri. Ada spinner dan hitungan detik selama request, total hasil, dan waktu pemeriksaan sumber.

Referensi saja: tidak otomatis mengubah angka retensi, tanggal acuan, nasib akhir, klasifikasi, ataupun menyimpan arsip. Enter di kolom ini dicegah agar tidak mengirim form input induk.

## Sumber terverifikasi

Spreadsheet: https://docs.google.com/spreadsheets/d/1aTE2WDOwMpWlH50cl739ZKMCl4AACW54R6_OmF_d2e0/edit
Judul Jadwal Retensi Arsip UINSA. Metadata: Jadwal Retensi gid 917043056 (999x26); Isi Sumber gid 1491826361 (4612x6). Lookup membaca hanya tab Jadwal Retensi, kolom A:I. Pada 27 Oktober data terisi sampai baris 900 (899 baris data). Header Bagian, NO, JENIS ARSIP, AKTIF, INAKTIF, KETERANGAN, Retensi dalam sel gabungan Word, Tabel sumber, Baris sumber.

Uji terhadap snapshot seluruh data menghasilkan 5 kecocokan rektor: baris 48, 50, 223, 448, 863. Baris 48 Keputusan Rektor: aktif '1 Tahun setelah diperbarui', inaktif '4 tahun', keterangan 'Permanen' (line break asli dipertahankan pada tampilan).

Sumber memuat salah ketik OCR, beberapa baris judul tanpa angka, dan kolom retensi gabungan yang ambigu. Teks asli dipertahankan. Sel kosong ditampilkan 'Tidak tercantum pada baris ini'; tidak diisi dari baris tetangga dan tidak diinterpretasikan. Kolom gabungan ditampilkan terpisah sebagai catatan, bukan otomatis dibagi menjadi aktif/inaktif. Pengguna dapat membuka sumber untuk verifikasi.

## Implementasi

- Index.html: satu include JraLookup sebelum Lokasi Fisik.
- JraLookup.html: modul HTML/CSS/JS mandiri, memakai runServer dan escapeHtml existing setelah DOM siap. Tidak menggunakan form bersarang atau menambahkan field bernama ke payload arsip.
- JraLookupService.js: endpoint publik apiSearchJraReference dan dua helper privat, membaca spreadsheet rujukan melalui SpreadsheetApp.openById. Memakai scope spreadsheets existing. Tidak menambah izin OAuth, migrasi, trigger, atau menulis spreadsheet sumber.
- Pencarian tidak peka huruf besar/kecil, spasi dinormalisasi, multi-kata memakai AND pada tujuh kolom konten. Hanya berjalan atas tindakan pencarian; tidak membaca referensi pada bootstrap atau setiap ketukan. Satu pembacaan nilai A:I sampai getLastRow per pencarian; batas 10.000 baris, 2–120 karakter. Data dibaca langsung tanpa salinan statis agar perubahan sumber tercermin pada pencarian berikutnya.
- Pagination memakai digest snapshot; jika sumber berubah di tengah halaman, petugas diminta mencari kembali. Respons lama diabaikan jika operator mengganti query. HTML sumber di-escape sebelum render.

## Pengujian

node --test tests/jra-lookup.test.cjs: 6 lulus (conditional text, blank/merged cells, pagination/source change, validation/header mismatch, Enter/XSS, stale response/timer cleanup). Sintaks client berhasil. Pengujian parser pada snapshot asli 899 baris menghasilkan 5 rektor sesuai pembacaan sumber. Akses SpreadsheetApp akun deploying juga telah lulus UAT langsung berikut.

## Pemasangan dan UAT live

- Login diverifikasi bag.umum@uinsa.ac.id. Index sebelum patch cocok dengan baseline @63 (SHA-256 normalisasi LF/trailing newline: 4fae0261e74ae12c4b482267075c600467a86fe4da17f4d59874d28730aba508).
- Tambah JraLookupService.gs, JraLookup.html, dan include Index. Clipboard readback cocok dengan source teruji. Setelah reload editor, layanan masih cocok dan ketiga nama file ada. Tidak mengubah module lain, scope, trigger, data, atau pengaturan akses.
- Deployment existing berhasil diperbarui @64 pada 27 Oktober pukul 10.09 WIB, deskripsi v3.31.0 PILOT - Cek JRA dari spreadsheet rujukan 2026-10-27.
- Buka aplikasi live, Registrasi Berkas Baru > Buat Berkas Baru. Cek JRA tampil tepat setelah Retensi Manual dan sebelum Lokasi Fisik. Screenshot desktop memperlihatkan tombol Cari JRA sejajar dengan input.
- Ketik rektor dan Enter: indikator Mencari pada sumber JRA dengan hitungan detik muncul, kemudian 5 dari 5 hasil. Baris 48,50,223,448,863 sesuai sumber. Retensi Keputusan Rektor tetap 1 Tahun setelah diperbarui / 4 tahun / Permanen; tautan tiap baris benar.
- Isian seluruh input/select identitas berkas dibandingkan sebelum dan sesudah lookup: tidak berubah. Enter tidak mengirim form induk; tidak ada transaksi arsip yang disimpan dalam UAT.
- Query zzqjratanpahasil menampilkan pesan hasil kosong dan saran ejaan.
- Query tahun menghasilkan 694 kecocokan, awal 10 baris. Tampilkan selanjutnya menambah hingga 20 dari 694; 20 link sumber unik, tanpa duplikasi halaman.
- Query rektor diulang sukses dan dibiarkan terbuka sebagai tampilan akhir. Screenshot bukti central-file-jra-live-20261027.jpg. Pengujian visual browser dilakukan pada desktop; aturan responsif tersedia, belum UAT di perangkat mobile.

Hash source tersimpan (SHA-256, LF, trailing newline diabaikan):

- JraLookupService.gs: 061202d586a87b9b7ac4f3eda4d2cc2618153505cf15bb125ef0f7aa2d07089e
- JraLookup.html: 1f20b910a932e49062588cfabccee6c130d9637a81a34721368a5917537ede67
- Index.html: 6005824a4a0f1ec6b35524b948382c56abc01d433bb300777bafb1c711637aa3

Rollback tampilan melalui deployment @63; tidak ada perubahan data yang perlu dibatalkan. Snapshot referensi untuk verifikasi lokal bukan file sumber yang harus dimasukkan ke repository.
