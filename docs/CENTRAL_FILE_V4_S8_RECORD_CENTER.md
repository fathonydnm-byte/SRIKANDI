# Sprint 8 — Pengajuan pemindahan ke Record Center

Central File v4 produksi BAGUM mulai dipakai pada 23 November 2026 dengan
skema `0028`. Pemulihan metadata, login Admin Pusat, pembukaan PDF lama,
unggah dan pembukaan PDF baru, serta satu cadangan manual produksi telah
dikonfirmasi. Cadangan manual sekitar 10.15 WIB mencatat 1.994 baris dan
204 rujukan Drive untuk BAGUM; `_PLATFORM` melaporkan 0 baris. Eksekusi
cadangan terjadwal pertama masih perlu dikonfirmasi di **Cadangan & Cermin**.

Di v4, **Penyusutan Arsip** baru menyimpan draf lokal dengan nomor
`DRAF-…`. Sprint ini menyiapkan pengajuan, pembatalan, dan sinkronisasi
keputusan ke Record Center uji. Sistem Record Center tetap terpisah.

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

## 2. Kriteria Sprint 8 di lingkungan uji

Dengan migrasi `0029` dan build Sprint 8 di lingkungan uji, buka
**Penyusutan Arsip → Draf Usul → Periksa Kelayakan**. Mulai dengan
draf sintetis dari berkas terverifikasi yang retensi aktifnya sudah
berakhir dan memiliki item aktif. Periksa bahwa draf lolos. Ubah data
contoh, atau tandai salah satu item dipinjam, lalu klik **Periksa
Ulang**: alasan hambatan muncul di bawah nomor berkas. Pemeriksaan
ini tidak mengubah draf, membuat dokumen, atau menghubungi Record
Center. Pengajuan yang kelak menyimpan paket harus mengulang
pemeriksaan dalam transaksi tulisnya sendiri.

Tahap berikutnya mencakup alur lengkap ini:
1. Sebelum membuat nomor resmi dan paket, periksa ulang kelayakan berkas
   dari draf. Bila data berubah atau arsip sedang dipinjam, operator
   menerima alasan dan pengajuan tidak disimpan sebagian.
2. Buat paket untuk data sintetis: nota dinas, daftar usul XLSX dan
   riwayat JRA wajib; daftar PDF sesuai paket lama. Pastikan akun
   Record Center uji dapat membaca dokumen yang dibutuhkan.
3. Gunakan kontrak Apps Script yang ada untuk pengiriman, pembatalan,
   dan polling. Uji kehilangan respons, ulang pengiriman dengan ID
   yang sama, dan dua pemroses yang bersamaan: satu usul diterima.
   Ulang pengambilan keputusan tidak boleh menggandakan perubahan
   status atau audit di Central File.
4. Uji keputusan setuju dan tolak serta pembatalan; bedakan status
   teknis kirim dari keputusan bisnis. Uji izin akses antarunit
   dan kecocokan riwayat setelah backup serta pemulihan uji.

Pakai instance, kredensial, dan folder Drive khusus pengujian. Aktivasi
pengiriman BAGUM produksi dilakukan setelah hasil uji dan rekonsiliasi
riwayat ditinjau. Penggunaan operasional BAGUM di produksi tetap berjalan.
