# Sprint 4 — Peminjaman Arsip (inti transaksi)

Skema 0024, ditambah setelah 0023. UI: `/peminjaman`. Petugas, Admin Unit, dan Admin Pusat (memilih unit).
Nomor NIP/NIK dan kontak opsional hanya dienkripsi di server; sebelum uji staging, buat secret acak
minimal 32 karakter bernama `LOAN_PII_KEY` di Vault staging. Simpan kunci dalam prosedur pengelolaan
kredensial instansi agar backup tetap bisa didekripsi kelak. Jangan masukkan kunci dalam migrasi,
chat, atau JS klien. CI memakai nilai lokal fiktif. Nilai ciphertext ikut paket backup, bukan cermin Sheets.

- `loan_options(p_unit_id,p_query,p_berkas_id)`: 30 berkas aktif definitif sesuai kata kunci; bila ID
  diberikan, satu berkas beserta item, status pinjam dan jumlah lembar. Berkas dialihkan/dihapus tidak tersedia.
- `loan_create(p_unit_id,p_request_id,p_borrower,p_choices,p_borrowed_on,p_due_on,p_condition,p_purpose,p_notes,p_page_count)`:
  `p_choices` adalah array `{berkas_id,item_ids}`; gunakan array item kosong untuk seluruh berkas.
  Maksimum 100 objek; item dari satu berkas ditaruh dalam satu entri. Lock unit dan idempotensi
  mengikuti API_S2. Mempertahankan pengaman status lama selama data pinjaman lama belum diimpor.
- `loan_list(p_unit_id,p_status,p_offset)`: 25 transaksi beserta objek per halaman; ACTIVE atau RETURNED.
  Tidak mengembalikan NIP/NIK/WA, ciphertext, atau identitas petugas.
- `loan_return(p_unit_id,p_request_id,p_loan_id,p_returned_on,p_condition,p_officer,p_notes)`:
  menutup seluruh objek dalam satu transaksi. Peminjaman item lain yang masih aktif tetap berjalan.
- Kedua operasi tulis mengembalikan `{id,replayed}` dan mencatat audit tanpa NIP/NIK/WA.
  `app.assert_not_borrowed` lama tetap memakai status yang diperbarui atomik bersama transaksi.
- Dashboard menghitung transaksi aktif satu kali. Berkas dengan penanda aktif lama yang belum terhubung
  ke transaksi tetap terlihat; sampai rekonsiliasi, penghitung memakai jumlah berkas untuk bagian lama itu.
- Out Indicator dibuat dari snapshot transaksi; cetak atau simpan PDF dari browser, satu lembar A5 per berkas.

## Riwayat dokumen dan impor pinjaman yang sudah selesai (0025)

- Out Indicator v4 mencatat **disiapkan untuk cetak** ketika A5 siap. Browser tidak melaporkan
  apakah operator mencetak, menyimpan PDF, atau membatalkan dialog. Aksi yang dikirim ulang
  dengan ID permintaan sama mencatat satu peristiwa. Riwayat per transaksi dibatasi untuk petugas
  dan admin yang berwenang di unit tersebut; log ikut backup sebagai bagian dari audit.
- Impor mengambil transaksi berstatus **KEMBALI** dan dua tab riwayat dokumen dari satu ekspor
  XLSX asli 3.x. Unit harus sudah ada dan `SETTINGS.INSTANCE_ID` harus cocok dengan unit v4.
  ID transaksi/objek, tanggal, dan snapshot yang tersedia dipertahankan. Jika judul/nomor tidak
  tersimpan, data berkas/item saat ini dipakai sebagai cadangan; kondisi pinjam kosong tetap kosong.
  Tidak mengubah status arsip. Transaksi yang sudah terdaftar tidak ditimpa, termasuk pengembalian
  yang baru dicatat di v4 meski ekspor lama masih menandainya aktif. Pinjaman aktif lain dilewati.
- Log lama hanya menyimpan ID log, waktu, jenis, dan status sumber; tidak menyalin tautan,
  isi dokumen, nomor identitas, kontak, atau alamat email. Log yang tidak bisa dikaitkan dilaporkan
  dengan tab dan nomor baris; keberadaannya mencegah commit seluruh impor. Cocokkan dengan
  arsip sumber sebelum melakukan koreksi, jangan membuat transaksi fiktif untuk meloloskannya.
- Terapkan 0025 dan gunakan koneksi postgres staging melalui variabel lingkungan. Mulai dari
  *root* repo. Simpan dan gunakan XLSX di lingkungan operator; jangan taruh file ekspor di repo.

```sh
npm ci --prefix v4/tools/import-legacy --no-audit --no-fund
node v4/tools/import-legacy/import-loan-history.mjs --file "/path/ekspor.xlsx" --unit-code BAGUM
```

Perintah di atas memakai transaksi lengkap lalu **rollback**. Tinjau jumlah grup, log, pinjaman
aktif yang dilewati, dan baris yang belum cocok. Setelah rekonsiliasi disetujui, jalankan ulang
dengan `--apply`. Periksa tab **Sudah kembali**, **Riwayat Dokumen**, dan pastikan status pinjam
tetap sama. Ulangi uji coba untuk memastikan tidak ada tambahan duplikat.

## Pekerjaan Sprint 4 yang masih terbuka

Bukti persetujuan opsional via pengunggah Drive, dan pembuatan Berita Acara Google Docs per
transaksi dengan template dan izin file. Uji akses gateway Docs secara terpisah dan pertahankan
kontrol unit.

## Rekonsiliasi staging BAGUM (17 November 2026 WIB)

Satu transaksi aktif lama dari tab PEMINJAMAN (tiga objek berkas lengkap, nomor 11, 17 dan 24)
dipindahkan dengan ID grup dan ID objek asli. Jumlah baris, unit, ID berkas, nomor dan penanda
pinjam dicocokkan sebelum menulis; tidak ada status pinjam yang diubah saat impor.
Aksi pengembalian diuji dengan savepoint dan dibatalkan, sehingga transaksi tetap aktif.
Tidak menyalin kolom NIP/NIK dan WhatsApp, serta belum memindahkan transaksi lama yang sudah selesai.
Pengembalian transaksi yang terdaftar dapat dicatat di v4; staging belum menjadi pengganti produksi.
