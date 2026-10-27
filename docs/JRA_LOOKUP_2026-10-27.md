# Cek Jadwal Retensi Arsip — 27 Oktober 2026

Status: source selesai, belum dipasang. Browser pemasangan Google diarahkan ke verifikasi CAPTCHA (unusual traffic), sehingga perlu intervensi pengguna sebelum login. Baseline source branch feat/berkas-content-search commit 9126ee56e390462186de2b56361fc6ad0d4f284f; deployment live terakhir terverifikasi @63, rilis 3.31.0/schema 11.

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

node --test tests/jra-lookup.test.cjs: 6 lulus (conditional text, blank/merged cells, pagination/source change, validation/header mismatch, Enter/XSS, stale response/timer cleanup). Sintaks client berhasil. Pengujian parser pada snapshot asli 899 baris menghasilkan 5 rektor sesuai pembacaan sumber. Google I/O masih mock; akses akun deploying ke sumber harus diuji langsung.

## Pemasangan berikutnya

1. Setelah CAPTCHA dan login selesai, gunakan akun proyek bag.umum@uinsa.ac.id. Baca/cadangkan Index live dan bandingkan baseline @63. Jika berbeda, rekonsiliasi.
2. Tambah JraLookupService.gs dari .js dan JraLookup.html; lalu pasang Index.html yang memuat include. Pastikan nama file persis, modul lama lain tetap.
3. Simpan source, update deployment existing menggunakan versi baru; catat versi aktual, jangan mengasumsikan @64. URL/akses dipertahankan, tanpa migrasi/reset.
4. UAT baca saja: buka Registrasi Berkas Baru, mode Berkas Baru (jika layar Input Arsip menampilkan pilihan), cari rektor (5 hasil; syarat lengkap), query nihil, query umum >10 hasil untuk pagination, dan Enter tidak mengirim form. Pastikan angka retensi manual tidak berubah. Periksa posisi tepat sebelum Lokasi Fisik dan tampilan mobile/desktop.
5. Jika akun aplikasi belum memiliki akses source, berikan akses melalui alur berbagi yang disetujui pemilik; jangan memperluas akses secara diam-diam. Endpoint menjelaskan kegagalan akses.

Rollback tampilan melalui deployment @63; tidak ada perubahan data yang perlu dibatalkan. Snapshot referensi untuk verifikasi lokal bukan file sumber yang harus dimasukkan ke repository.
