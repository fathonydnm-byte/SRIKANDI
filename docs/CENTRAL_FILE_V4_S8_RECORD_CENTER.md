# Sprint 8 — Fondasi pemindahan arsip dan rencana integrasi Record Center

**Dijeda 23 November 2026 atas keputusan pemilik.** Cakupan Central File
berhenti pada persiapan draf. Pembuatan paket, pengiriman, dan sinkronisasi
keputusan ditunda sampai aplikasi Record Center dan lingkungan ujinya siap.
Tidak ada pemasangan Sprint 8 ke produksi BAGUM.

Central File v4 produksi BAGUM mulai dipakai pada 23 November 2026 dengan
skema `0028`. Pemulihan metadata, login Admin Pusat, pembukaan PDF lama,
unggah dan pembukaan PDF baru, serta satu cadangan manual produksi telah
dikonfirmasi. Cadangan manual sekitar 10.15 WIB mencatat 1.994 baris dan
204 rujukan Drive untuk BAGUM; `_PLATFORM` melaporkan 0 baris. Eksekusi
cadangan terjadwal pertama masih perlu dikonfirmasi di **Cadangan & Cermin**.

| Cakupan | Status |
| --- | --- |
| Central File v4 produksi (`0028`) | **Penyusutan Arsip** bisa menampilkan kandidat, membuat dan membatalkan draf lokal bernomor `DRAF-…`, serta menyimpan salinan metadata berkas dan item saat draf dibuat. Lihat [API draf](../v4/supabase/API_S5.md). |
| Branch `feat/v4-s8-record-center` (`0029`) | **Periksa Kelayakan** memeriksa ulang status berkas, pinjaman, dan perubahan metadata sejak draf dibuat. Sudah diuji lokal. Migrasi dan build tetap di branch Sprint 8. |
| Integrasi ke aplikasi Record Center yang akan datang | Rancangan disimpan di bawah. Belum ada penomoran resmi, pembuat paket, pengiriman dari v4, atau sinkronisasi keputusan. Implementasi Apps Script lama adalah referensi kompatibilitas dan tidak menjadi tujuan pengiriman baru. |

## 1. Inventaris riwayat BAGUM (baca saja)

Gunakan ekspor Excel utuh dari spreadsheet database Central File 3.x
yang dipakai untuk pembandingan Sprint 7. Ambil ekspor baca saja yang
lebih baru jika riwayat bisa berubah sejak ekspor itu. Laporan ini
memeriksa riwayat pengajuan pada ekspor; PostgreSQL v4 tetap menjadi
sumber transaksi arsip BAGUM.

Dari root repo pada branch Sprint 8, jalankan di WSL dengan Node.js 22
atau lebih baru. Sesuaikan nama file dengan ekspor yang ada:

```bash
npm ci --prefix v4/tools/import-legacy --no-audit --no-fund
node v4/tools/import-legacy/transfer-inventory.mjs \
  --legacy "/mnt/c/CentralFile-S7/CentralFile-3x.xlsx" --unit BAGUM
```

Laporan memisahkan status bisnis usul dari status teknis outbox.
`diajukan_dan_sudah_terkirim` menghitung usul `DIAJUKAN` yang merujuk ke
pengiriman `SENT` miliknya; ini daftar pekerjaan yang perlu dicocokkan
dengan Record Center, bukan pernyataan bahwa Record Center belum memberi
keputusan. Event pembatalan dihitung terpisah.

| Kode keluar | Arti |
| --- | --- |
| 0 | Tab usul dan outbox ada dan kosong pada ekspor yang diperiksa. |
| 1 | Ada catatan historis dan laporan berhasil dibuat. Cocokkan dengan hasil Record Center sebelum melanjutkan pengiriman. |
| 2 | Ekspor tidak dapat diperiksa, misalnya salah unit, tab tidak lengkap, atau ID ganda. |

Keluaran hanya memuat kode unit, kategori status yang dikenal, dan
jumlah. Simpan workbook di komputer atau Drive instansi. Jika ada
riwayat, lakukan pembandingan rinci di instansi: pertahankan nomor usul,
kaitan berkas, ID event, dan keputusan yang sudah tercatat. Cocokkan
`SENT` pada Central File dengan penerimaan di Record Center berdasarkan
instance sumber dan ID event. Riwayat `SENT` tidak masuk antrean kirim ulang.

**Hasil BAGUM, 23 November 2026.** Ekspor memuat 3 usul (1 draf,
1 ditolak, 1 dibatalkan) dan 1 event pengajuan berstatus `SENT`.
Tidak ada usul `DIAJUKAN`, event menunggu kirim, atau ketidakcocokan
relasi di ekspor. Pemilik mengonfirmasi ID pengajuan dan status
`DITOLAK` cocok dengan catatan Record Center. Pertahankan pengiriman dan
keputusan itu sebagai riwayat. Riwayat belum dimuat ke database v4.

## 2. Rancangan sambungan saat aplikasi Record Center siap

Central File menyiapkan usul dan mencatat hasil pengiriman. Record Center
menerima usul, mencatat keputusan, dan mengelola serah terima fisik.
Keberhasilan pengiriman teknis (`SENT`) tidak menandakan persetujuan atau
perpindahan fisik. Usul lama yang sudah `SENT` dipertahankan sebagai
riwayat dan tidak dimasukkan ke antrean baru.

1. **Siapkan pengajuan di Central File.** Periksa ulang kelayakan dalam
   transaksi yang memfinalkan pengajuan. Jika suatu berkas berubah atau
   tidak lagi memenuhi syarat, jangan simpan pengajuan sebagian. Jika
   lolos, tetapkan nomor resmi `UP-…` per unit setelah meninjau nomor
   historis. Bentuk paket dari salinan metadata yang telah diperiksa:
   berkas, item, nota dinas, daftar usul XLSX, riwayat JRA, dan PDF jika
   tersedia. Draf `DRAF-…` tetap menjadi asal usul.
2. **Kirim dari server dan simpan bukti penerimaan.** Gunakan antrean
   tersimpan, dengan ID event yang sama saat mencoba kembali pengiriman
   yang sama. Catat unit, ID usul, ID event, dan identitas tujuan. Record
   Center harus mengenali pengiriman ulang berdasarkan identitas sumber
   dan event, sehingga satu pengajuan tercatat satu kali. Tentukan skema
   penandatanganan dan akses dokumen antarserver bersama tim Record Center;
   kredensial tidak boleh masuk ke browser atau paket.
3. **Sinkronkan keputusan dan pembatalan.** Kaitkan hasil Record Center
   ke pengajuan asal. Catat keputusan, alasan, dan waktunya terpisah dari
   status pengiriman. Terapkan keputusan hanya sekali walaupun respons
   dibaca berulang. Draf yang belum dikirim bisa dibatalkan secara lokal;
   pengajuan yang sudah terkirim perlu prosedur pembatalan dari kedua
   sistem. Serah terima fisik adalah tahap tersendiri.

Sebelum mulai menghubungkan, cocokkan skema paket, ID sumber/tujuan,
penerimaan dokumen, dan status dengan tim Record Center. Referensi pilot
Apps Script: [desain endpoint RC-01](ADDENDUM_2026-08-21_RC01_DESAIN_ENDPOINT.md)
untuk `SUBMIT_TRANSFER_PROPOSAL`, `CANCEL_TRANSFER_PROPOSAL`, dan
`QUERY_DECISION`, serta [protokol keputusan](ADDENDUM_2026-08-20_PROTOKOL_KEPUTUSAN_RC_CF.md).
Gunakan referensi ini untuk menilai kompatibilitas; transport, autentikasi,
dan kontrak final mengikuti rancangan aplikasi Record Center yang baru.

## 3. Cara melanjutkan di lingkungan uji

Dengan migrasi `0029` dan build Sprint 8 di lingkungan uji, buka
**Penyusutan Arsip → Draf Usul → Periksa Kelayakan**. Mulai dengan
draf sintetis dari berkas terverifikasi yang retensi aktifnya sudah
berakhir dan memiliki item aktif. Periksa bahwa draf lolos. Ubah data
contoh, atau tandai salah satu item dipinjam, lalu klik **Periksa
Ulang**: alasan hambatan muncul di bawah nomor berkas. Pemeriksaan
ini tidak mengubah draf, membuat dokumen, atau menghubungi Record
Center. Pengajuan yang kelak menyimpan paket harus mengulang
pemeriksaan dalam transaksi tulisnya sendiri.

Setelah aplikasi Record Center uji siap, mulai dari satu draf sintetis.
Uji akses dokumen, pengiriman ulang setelah respons hilang, dua pemroses
yang bersamaan, keputusan setuju dan tolak, pembatalan, pemisahan akses
antarunit, serta pemulihan riwayat dari cadangan. Pastikan paket historis
BAGUM tidak pernah ikut dikirim dalam pengujian.

Pakai instance, kredensial, dan folder Drive khusus pengujian. Aktivasi
pengiriman BAGUM produksi dilakukan setelah hasil uji dan rekonsiliasi
riwayat ditinjau. Penggunaan operasional BAGUM di produksi tetap berjalan.
