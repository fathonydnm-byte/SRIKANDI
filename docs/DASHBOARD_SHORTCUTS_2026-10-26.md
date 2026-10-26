# Dashboard drilldown — 26 Oktober 2026

Status: source selesai dan 5 pengujian terarah lulus; belum dipasang. Login browser proyek diperlukan kembali. Baseline branch feat/berkas-content-search, commit 45c9bb51795c0df0780e151059d1cc82d346ccc5; deployment terverifikasi terakhir @62 (22 Oktober), rilis 3.31.0/schema 11.

## Perilaku

- Kartu Sedang Dipinjam menjadi tombol: buka Peminjaman, pilih filter ACTIVE (termasuk OVERDUE), kosongkan pencarian lama, muat ulang satu kali, fokus/gulir ke Pelacakan Peminjaman sehingga tidak berhenti di form input.
- Kartu Retensi H-7 / Habis Aktif menjadi tombol: buka Penyusutan Arsip, kosongkan pencarian lama, muat ulang satu kali, fokus/gulir ke Monitoring Retensi Aktif. Opsi filter khusus menghitung daysToActiveLimit: 0–7 inklusif untuk H-7, <0 untuk habis. Keduanya menyertakan PROPOSED dan mengecualikan TRANSFERRED agar cakupannya sesuai hitungan getDashboardSummary_. Filter status biasa tidak berubah.
- Angka nol tetap dapat diklik dengan pesan kosong yang sesuai. Native button mendukung klik, Enter, Spasi, dan outline fokus.
- Respons yang terlambat tidak mengambil fokus kembali setelah petugas berpindah halaman. Memakai endpoint/list/actions existing; tidak menambah endpoint, migrasi, atau mengubah aturan usul/pengembalian.

## File pemasangan

central-file/Index.html, Client.html, Styles.html. Source lain tidak berubah. Sebelum menulis, bandingkan ketiga file live dengan baseline commit di atas; rekonsiliasi jika berbeda. Simpan source lama, pasang source baru, lalu update deployment existing dengan versi baru dan akses/URL yang sama. Catat nomor versi sebenarnya; jangan mengasumsikan @63.

## Verifikasi

node --test tests/dashboard-shortcuts.test.cjs: 5 lulus. Mencakup batas -1/0/7/8 hari, proposed/transferred, filter biasa dan pencarian, navigasi dan pemuatan tunggal, daftar kosong, serta respons lambat setelah navigasi. Client.html lolos pemeriksaan sintaks Node VM.

UAT live masih diperlukan: klik tiga kartu; cocokkan jumlah peminjaman dengan transaksi aktif berkelompok; H-7 nol menampilkan pesan kosong; daftar habis sesuai dashboard. Pastikan tindakan cetak/pengembalian/usul existing tersedia tanpa mengeksekusi transaksi untuk simulasi. Uji keyboard dan fokus/gulir. Angka bisa berubah jika data atau hari WIB berubah setelah dashboard dimuat.
