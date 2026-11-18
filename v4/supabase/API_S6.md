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

## Tahap keempat — OCR opsional pada PDF pindaian

Di dialog pemindaian **Alih Media Arsip**, centang **Kenali teks agar
bisa dicari di PDF (OCR)** sebelum menekan **Gunakan PDF**. Progres
menampilkan halaman dan persentase pembacaan. **Lewati OCR** melanjutkan
pembuatan PDF gambar; jika unduhan model, pembacaan, atau penggabungan
lapisan teks gagal, PDF gambar tetap dibuat. Status akhir memberi tahu
operator berapa halaman yang berisi teks, atau bila OCR tidak selesai.

Satu Web Worker Tesseract.js (Apache-2.0) membaca Indonesia dan Inggris
di perangkat. Foto asli dari alur pindai (setelah koreksi bila dipakai)
tetap menjadi tampilan PDF; OCR menambahkan lapisan teks yang mengikuti
urutan, rotasi, dan posisi gambar. Teks ini bisa dicari di pembaca PDF,
sementara indeks aplikasi **Cari Isi Berkas** belum terhubung. Halaman
kosong atau tanpa teks yang dikenali tidak diberi lapisan teks. OCR tidak
mengubah alur unggah: operator tetap harus menekan **Upload Alih Media**.

Build menyalin worker, tiga varian inti LSTM, model Indonesia dan Inggris,
serta atribusi ke `/ocr/v1/` dari versi npm yang terkunci. Browser mengunduh
satu varian inti dan kedua model (sekitar 8 MB pertama kali) dari domain yang
sama; Workbox tidak memasukkannya ke pemasangan PWA. Perbarui versi path
asset dan aturan header bersama saat menaikkan versi mesin atau model.
Izin kompilasi WebAssembly hanya berlaku pada respons skrip worker OCR.
Tidak ada perubahan database, hak akses Drive, atau pengiriman foto ke
layanan OCR eksternal.

## Tahap kelima — Cari Isi Berkas dari OCR pindaian baru

1. Buat PDF dengan OCR di **Alih Media Arsip**, lalu pilih **Upload Alih
   Media**. Setelah PDF terverifikasi dan terhubung dengan item, aplikasi
   otomatis mengirim teks OCR yang sudah tersedia; PDF tidak diunduh
   atau di-OCR ulang. Tray unggahan menampilkan status indeks secara
   terpisah. Jika gagal, **Coba lagi indeks teks** mengulang penyimpanan
   tanpa mengunggah ulang PDF. Draf teks untuk retry hanya hidup di tab.
2. Buka **Cari Isi Berkas**, masukkan kata atau frasa, lalu tekan **Cari**.
   Mode biasa membutuhkan semua kata pada halaman yang sama; **Cari frasa
   berurutan** membutuhkan urutan dan posisi yang berdampingan. Hasil berisi
   cuplikan, unit, nomor item/berkas, dan nomor halaman PDF. Klik judul
   hasil untuk buka detail item. Lokasi akses PDF tetap di detail tersebut.

Tahap ini mencakup PDF pindaian baru yang dibuat dengan OCR di aplikasi
dan diunggah setelah migrasi. PDF lama, PDF eksternal, lampiran DOCX dan
OCR yang dilewati belum ikut indeks. Teks dibatasi 8.000 karakter per
halaman dan 48.000 per PDF; pemotongan tidak mengubah PDF.

- `index_scan_content(p_session_id, p_pages)` menerima array teks/null
  sesuai urutan halaman, hanya dari pemilik sesi unggah PDF item yang
  berstatus COMMITTED dan masih menunjuk ke file aktif. Isi indeks
  berasal dari OCR browser; pengindeksan tidak mengubah isi PDF. Retry
  dengan sesi sama tidak menggandakan atau menimpa isi yang telah disimpan.
- `search_scan_content(p_query, p_unit_id, p_phrase, p_limit, p_offset)`
  memakai PostgreSQL FTS (`simple`) dan hanya mengembalikan cuplikan.
  Hak baca mengikuti PDF arsip aktif: peran aktif melihat unit sendiri;
  Admin Pusat bisa memilih satu atau semua unit. Baris mentah tidak
  diberikan ke peran browser. Hasil dibatasi per halaman.
- `content_documents` menggunakan kait invalidasi Sprint 3. Ketika file
  diganti atau arsip dibatalkan, indeks lama tidak ditampilkan dan teksnya
  dihapus ketika status menjadi STALE. Teks tidak ikut cermin/backup
  metadata; lapisan teks tetap ada di PDF. Fitur pengindeksan ulang
  diperlukan jika hasil pencarian isi perlu dipulihkan dari PDF lama.

**Urutan rilis:** terapkan `0027_s6_content_search.sql` dalam satu
transaksi di basis data staging. Pastikan `schema_migrations_log`
memuat `0027 / s6_content_search`, baru pasang build web. Uji dengan
pindaian OCR arsip contoh berisi kata yang tidak ada di judul, lalu cek
bahwa hasil hanya muncul untuk unit yang berwenang. Tidak ada perubahan
gateway/izin Drive dan alur unggah PDF biasa tetap tersedia.

## Penyesuaian jadwal retensi — migrasi 0028

Form **Buat Berkas Baru**, baik dari penerimaan maupun input manual,
meminta tanggal acuan yang ditetapkan petugas sesuai JRA, durasi aktif
dan inaktif (bulan/tahun), serta nasib akhir. Jika tanggal belum diketahui,
petugas dapat memilih **Tanggal acuan belum diketahui**. Berkas tetap bisa
digunakan, tetapi batas retensi dan kelayakan usul belum ditentukan.

- Batas aktif = tanggal acuan + durasi aktif. Batas inaktif = batas aktif
  + durasi inaktif. Penambahan bulan/tahun memakai konvensi kalender yang
  sama dengan versi sebelumnya. Renumber hanya mengubah kronologi dan
  metadata item, tanpa mengubah tanggal acuan atau batas retensi.
- Berkas lama tetap menyimpan tanggal dan batas yang sudah ada. Tanggal
  lama terlihat di dashboard dan **Perubahan Arsip → Ubah jadwal retensi**.
  Jadwal lama perlu dikonfirmasi sebelum berkas masuk usul pemindahan baru.
  Impor ulang data lama tidak menimpa jadwal yang sudah ditetapkan atau
  ditandai menunggu tanggal acuan.
- Perubahan dicatat dengan alasan serta nilai sebelum/sesudah di Master Log.
  Jika berkas masuk draf usul, batalkan draf terlebih dahulu. Berkas yang
  sudah dipindahkan atau sedang dipinjam mengikuti pembatasan perubahan.
  Izin pengguna mengikuti izin perubahan arsip dan cakupan unit.
- Rilis: tinjau aturan ini, ambil cadangan metadata terbaru, terapkan
  `0028_manual_retention.sql` dalam satu transaksi, lalu pasang build web.
  Migrasi menambah penanda sumber jadwal tanpa menghitung ulang tanggal
  arsip lama. Selama jeda antara migrasi dan pembaruan web, versi lama
  masih bisa membuat berkas; berkas baru itu berstatus menunggu acuan.
