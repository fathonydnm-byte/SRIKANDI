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
