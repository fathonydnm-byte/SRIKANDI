# Perbaikan umpan balik pencarian isi — 16 Oktober 2026

Status terbaru 22 Oktober 2026: SUDAH dipasang pada deployment existing versi 62, pukul 09.22 WIB menurut dialog Apps Script. Source perbaikan commit `e3eeaadd00a1449536ff058d04ed3ef5d5492a88`, branch `feat/berkas-content-search`; rilis tetap 3.31.0/schema 11. Baseline sebelum patch `3a90e4e413e7016e829bccd3d82edc45e47fb84a`, deployment versi 61.

## Perubahan

- Kolom kata/frasa dan tombol Cari satu baris grid; petunjuk dipindah ke baris berikutnya. Tinggi tombol sama dengan input, 40px.
- Menyiapkan unggahan, mengirim chunk, menyimpan antrean, memuat kesiapan, dan mencari menampilkan spinner serta waktu tunggu. Persentase unggah berasal dari byte yang sudah dikonfirmasi Drive. Spinner tidak dianggap heartbeat worker.
- Antrean/ekstraksi menampilkan spinner, status terakhir dari server, usia status, dan penjelasan pemeriksaan otomatis. Tahap ini tidak memiliki persentase server; tidak ada persentase buatan. Setelah 10 menit ada penjelasan proses lebih lama dari biasanya.
- Polling 10 detik dijadwalkan ulang ketika unggah/pencarian sibuk, serta mencoba ulang setelah gagal memuat status. Polling tidak memulai permintaan baru saat pencarian aktif.
- Unggahan baru memakai offset yang dikembalikan start, sehingga menghemat satu RPC browser-server dan satu query status Drive. Resume tetap memeriksa Drive untuk pemulihan respons hilang.
- Validasi schema mengambil header sekali, bukan memanggil getHeaders_ untuk masing-masing dari 17 kolom. Cache isi header existing tetap dipakai; sebelumnya getHeaders_ juga memanggil getSheetId/getLastColumn setiap kali.

## Yang sengaja dipertahankan

Ukuran chunk 512 KiB, validasi DOCX, lock, lease/retry worker, audit, riwayat versi, pemeriksaan ulang PDF dan snapshot hasil pencarian. Tidak ada perubahan schema, scope akses, jadwal trigger, atau data arsip. Ekstraksi masih berjalan melalui trigger sekitar satu menit sekali; jeda antrean berbeda dari waktu transfer berkas.

## Verifikasi

`node --test tests/*.test.cjs`: 49 lulus, termasuk empat regresi baru untuk resume vs fresh upload, pembersihan timer, penjadwalan polling, dan validasi schema. Google I/O disimulasikan; tidak membuktikan durasi di server Google. Percobaan render lokal terhalang executable Chromium yang tidak tersedia. Layout desktop/mobile perlu diverifikasi pada Web App setelah pemasangan.

Belum ada benchmark unggah/ekstraksi live. Belum dapat menyatakan besarnya percepatan, atau memastikan penyebab eksekusi historis 233 detik. Jika masih lambat, ukur tahap pembukaan DOCX, parsing XmlService, dan penulisan indeks sebelum mengganti parser.

## Lanjutkan pemasangan

1. Login kembali pada browser proyek, buka script `1_Z8ZfkDU1lIGuI5hlOCp4eeNaXiFR-3zJjO8XL60lSeIotbcaKljRLvb`.
2. Cocokkan tiga file live terhadap baseline sebelum edit: ContentSearch.html, ContentDocumentService.gs, ContentSearchService.gs. Jika berubah, rekonsiliasi; jangan menimpa perubahan pengguna.
3. Simpan baseline/cadangan source. Pasang ketiga file tersebut (ekstensi .js di git = .gs di editor). Tidak perlu migrasi/reset atau perubahan trigger.
4. Update deployment existing menggunakan versi baru; pertahankan URL dan akses. Catat nomor versi aktual, jangan mengasumsikan @62.
5. Verifikasi posisi Cari pada desktop/mobile, spinner/detik saat pencarian, antrean sampai READY/FAILED, dan resume unggah. Gunakan dokumen uji yang disetujui pengguna; jangan mengubah arsip lama untuk simulasi.

## Bukti pemasangan 22 Oktober 2026

- Login proyek terverifikasi bag.umum@uinsa.ac.id. Ketiga file target cocok dengan baseline sebelum edit. Tidak ditemukan perubahan pengguna pada ketiga file itu.
- ContentSearch.html, ContentDocumentService.gs, ContentSearchService.gs diperbarui. Setelah editor dimuat ulang, ketiganya dibaca kembali melalui clipboard UI dan dibandingkan persis dengan source perbaikan: semuanya cocok (normalisasi CRLF).
- Dialog Google menampilkan "Penerapan berhasil diperbarui. Versi 62 pada 22 Okt 2026, pukul 09.22". Deployment ID dan URL existing dipertahankan; execute-as pemilik, akses Hanya saya sendiri tetap.
- URL: https://script.google.com/a/macros/uinsa.ac.id/s/AKfycby61nrRsmp5SyiTnySxIiHrf_DDAOdmqVJnNPwwq2BBY9EmCly_sTjR-9ZhLb3TRClv/exec
- Uji baca saja pada berkas 15 Surveillance Audit: 1/5 item siap, item 5 SPMK. Query denda menghasilkan 2 paragraf/bagian, 1/1 item siap selesai diperiksa, tanpa error.
- Spinner dan hitungan waktu pencarian terlihat; screenshot menangkap 4 detik. Ini waktu pada saat capture, bukan durasi total pencarian.
- Pengukuran DOM desktop: input dan tombol top 335.625, bottom 375.625, height 40 piksel; sejajar tepat.
- Belum menguji ulang unggah, resume, antrean sampai READY/FAILED dengan file baru; tidak menambah versi Word/data arsip untuk simulasi. Belum UAT mobile. Efek percepatan unggah/ekstraksi belum dibenchmark.
- Rollback bila diperlukan: pilih deployment versi 61 pada ID existing tanpa reset schema/data. Source sebelum patch tetap tersedia di commit baseline di atas.

Bagian "Lanjutkan pemasangan" di atas adalah instruksi historis sebelum pemasangan; jangan memasang ulang tanpa memeriksa kondisi terbaru.
