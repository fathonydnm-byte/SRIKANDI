# Sprint 6 — Pemindaian arsip (tahap pertama)

Di **Alih Media Arsip**, pilih berkas dan item yang belum mempunyai PDF,
lalu pilih **Pindai dengan kamera**. Tombol **Ambil foto** meminta kamera
belakang lewat pemilih file bawaan perangkat; bila browser tidak membuka
kamera, pengguna masih bisa mengambil foto dari galeri. Tambahkan hingga
30 halaman, putar atau urutkan, lalu pilih **Gunakan PDF**. Foto diolah di
browser. Dokumen baru masuk ke alur unggah PDF yang sudah ada setelah
operator menekan **Upload Alih Media**.

- Setiap foto dibatasi 24 MB. JPG, PNG, dan WebP diterima; HEIC/HEIF
  bergantung pada dukungan dekoder browser. Hasil akhir tetap di bawah 100 MB.
- Resolusi foto disesuaikan hingga 2.400 piksel pada sisi terpanjang dan
  disusun ke halaman A4. PDF berisi gambar; teks belum bisa dicari.
- Tidak ada perubahan skema, gateway, atau jalur unggah. Modul pemindai
  dan pembuat PDF dimuat ketika dipakai. Pemberitahuan lisensi dependensi
  pemindai ikut disajikan di `/scan-licenses.txt`.
- Deteksi tepi/koreksi perspektif, OCR, Cari Isi Berkas, dan Cek JRA
  masih tahap lanjutan. Uji kamera fisik dilakukan kemudian sesuai
  arahan pemilik; tes otomatis menguji input foto dan PDF sintetis.

## Tahap kedua — Cek JRA pada registrasi berkas baru

Pemilik telah menguji pindai kamera melalui HP dan menyatakan hasilnya baik
(18 November 2026). Tahap berikutnya menambahkan Cek JRA di atas isian Retensi
pada **Buat Berkas Baru**.

Pencarian membaca tab **Jadwal Retensi** dari spreadsheet rujukan yang sudah
digunakan aplikasi Apps Script. Nilai aktif, inaktif, nasib akhir/keterangan,
dan catatan sel gabungan ditampilkan persis sebagai teks; kondisi retensi
seperti “setelah tidak berlaku” tidak dikonversi menjadi angka secara otomatis.
Baris induk tanpa nilai tidak mewarisi retensi dari baris lain. Operator tetap
memutuskan dan memasukkan nilai pada form berkas, dengan tautan ke baris sumber.

Endpoint `POST /api/jra/search` memeriksa akun aktif lewat Supabase sebelum
membaca satu URL spreadsheet tetap. Kata kunci/JWT tidak dikirim ke Google.
Tidak ada perluasan izin Drive atau kunci layanan baru. Pengambilan CSV dibatasi
2 MB, 10.000 baris, dan 15 detik; header diverifikasi. Sepuluh hasil per halaman;
fingerprint sumber mencegah paginasi pada data yang sudah berubah. Jawaban
tidak disimpan di cache. Bila akses publik sumber dicabut, tampilkan kegagalan
yang bisa dicoba ulang dan tautan rujukan; jangan mengubah izin sumber otomatis.

Tidak ada migrasi database atau perubahan nilai retensi arsip tersimpan.

## Tahap ketiga — Rapikan perspektif foto pindaian

Di pemindai **Alih Media Arsip**, pilih **Rapikan sudut** pada satu halaman.
Geser keempat penanda ke sudut kertas; tombol panah juga bisa dipakai.
Pilih **Terapkan** untuk memotong foto dan meluruskan perspektifnya, atau
**Kembali** untuk mempertahankan keadaan halaman sebelumnya. Jika hasilnya
kurang pas, buka lagi dan pilih **Pakai batas foto asli**, kemudian
**Terapkan**. Koreksi selalu dimulai dari foto asli yang disiapkan browser;
rotasi halaman tetap diterapkan ketika menampilkan pratinjau dan menyusun PDF.

Koreksi berjalan di perangkat, dengan progres dan keluaran hingga 4 MP
(dan sisi terpanjang 2.400 piksel). Tidak ada dependensi baru, pengiriman
otomatis, atau migrasi. Deteksi tepi otomatis, OCR, dan pencarian isi PDF
masih di luar tahap ini.
