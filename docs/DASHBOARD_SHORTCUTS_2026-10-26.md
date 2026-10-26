# Dashboard drilldown — 26 Oktober 2026

Status terbaru: SUDAH dipasang pada deployment existing versi 63, 26 Oktober 2026 pukul 11.42 WIB menurut dialog Apps Script. Source final commit f3875377f64969d84c1b4a77909a2c30045b6295 (kartu 557754cd2ee1a9c2dcd332433790cbe6c58c959c ditambah koreksi ID target monitoring agar unik). Baseline branch feat/berkas-content-search, commit 45c9bb51795c0df0780e151059d1cc82d346ccc5; deployment sebelumnya @62 (22 Oktober), rilis tetap 3.31.0/schema 11.

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

## Verifikasi live 26 Oktober 2026

- Login pemilik bag.umum@uinsa.ac.id. Tiga file live baseline cocok SHA-256 (LF dinormalisasi) sebelum perubahan. Setelah disimpan dan editor direload, ketiga file dibaca lagi melalui UI, hash cocok source patch.
- Dialog Google: Penerapan berhasil diperbarui. Versi 63 pada 26 Okt 2026 pukul 11.42. ID, URL existing, execute-as pemilik, dan akses Hanya saya sendiri dipertahankan.
- URL aplikasi: https://script.google.com/a/macros/uinsa.ac.id/s/AKfycby61nrRsmp5SyiTnySxIiHrf_DDAOdmqVJnNPwwq2BBY9EmCly_sTjR-9ZhLb3TRClv/exec
- Dashboard saat uji: 28 berkas, 138 item, 3 transaksi dipinjam, H-7 nol, habis aktif satu.
- Klik Sedang Dipinjam: halaman Peminjaman, filter ACTIVE, 3 baris (ketiganya terlambat dan masih aktif); target loanTrackingSection fokus dan top 94px. Tombol tindakan existing tetap tersedia, tidak dieksekusi untuk simulasi.
- Tekan Enter pada kartu H-7: halaman retensi, filter DASHBOARD_DUE, 0 baris, pesan tidak ada berkas yang masa aktifnya akan habis dalam 0–7 hari.
- Klik Habis Aktif: filter DASHBOARD_EXPIRED, 1 baris berkas Pemeliharaan Kebersihan Gedung Bertingkat (Gondola) Kampus Gununganyar Tahun 2023; berstatus dipinjam. Target monitoring fokus dan top 94px. Tidak memverifikasi metadata/mengubah pinjaman/membuat usul untuk simulasi.
- Pemeriksaan struktur sebelum pemasangan memastikan ID retentionMonitoringSection dan loanTrackingSection masing-masing hanya satu; Riwayat Usul memakai section existing tanpa ID monitoring.
- Rollback deployment ke @62 pada ID existing jika diperlukan. Tidak perlu reset schema/data/trigger. UAT perangkat mobile belum dilakukan.
