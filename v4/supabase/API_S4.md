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

## Pekerjaan sebelum rilis Sprint 4 lengkap

Impor dan rekonsiliasi transaksi serta log cetak dari 3.x (pertahankan ID dan status lama); bukti persetujuan
opsional via pengunggah Drive; log cetak Out Indicator; dan Berita Acara Google Docs per transaksi
dengan template dan izin file. Uji akses gateway Docs secara terpisah dan pertahankan kontrol unit.
## Rekonsiliasi staging BAGUM (17 November 2026 WIB)

Satu transaksi aktif lama dari tab PEMINJAMAN (tiga objek berkas lengkap, nomor 11, 17 dan 24)
dipindahkan dengan ID grup dan ID objek asli. Jumlah baris, unit, ID berkas, nomor dan penanda
pinjam dicocokkan sebelum menulis; tidak ada status pinjam yang diubah saat impor.
Aksi pengembalian diuji dengan savepoint dan dibatalkan, sehingga transaksi tetap aktif.
Tidak menyalin kolom NIP/NIK dan WhatsApp, serta belum memindahkan transaksi lama yang sudah selesai.
Pengembalian transaksi yang terdaftar dapat dicatat di v4; staging belum menjadi pengganti produksi.
