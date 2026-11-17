# Sprint 5 — Retensi dan draf usul pemindahan

Bagian awal: migrasi `0026_s5_transfer_drafts.sql`, halaman **Penyusutan Arsip**
(`/retensi`). Kartu dashboard tetap menyediakan daftar baca; operator yang
berwenang bisa lanjut ke modul dari daftar H-7 atau Habis Aktif.

- `retention_candidates(p_unit_id,p_filter,p_offset)`: kalender Asia/Jakarta;
  H-7 mencakup hari ini hingga tujuh hari ke depan, Habis Aktif berarti batas
  aktif sudah lewat. Hanya berkas aktif dengan nomor definitif dan belum
  dipindah tampil. `blocked_reason` menjelaskan jika kandidat belum dapat
  dipilih. Berkas yang sedang dipinjam (termasuk salah satu item), tanpa item
  aktif, belum terverifikasi, atau sudah berada di usul tidak dapat dipilih.
- `transfer_draft_create(p_unit_id,p_request_id,p_berkas_ids,p_title,p_notes)`:
  1–200 berkas berbeda. Syarat diverifikasi sekali lagi dengan lock unit; semua
  berkas disimpan atomik atau seluruh tindakan gagal. Mengembalikan
  `{id,draft_number,replayed}`. Nomor sementara `DRAF-YYYY-NNNN` per unit tidak
  mengambil nomor resmi `UP-…` sebelum riwayat lama direkonsiliasi.
- `transfer_drafts_list(p_unit_id,p_offset)` dan
  `transfer_draft_get(p_unit_id,p_draft_id)`: ringkasan dan rincian daftar
  berkas pada saat draf dibuat. Maksimal 25 baris per halaman untuk daftar.
- `transfer_draft_cancel(p_unit_id,p_request_id,p_draft_id,p_reason)`:
  alasan minimal tiga karakter; melepaskan penanda berkas yang masih menunjuk
  ke draf ini. Riwayat dan salinan metadata draf tetap tersimpan untuk audit.
  Jika berkas masih memenuhi syarat, berkas dapat ditambahkan ke draf baru.

Akses: Petugas, Admin Unit, dan Admin Pusat dengan unit terpilih. ID
unit tidak bisa dipakai untuk mengakses draf milik unit lain. Kedua operasi
tulis mengikuti konvensi audit dan idempotensi API Sprint 2; tabel internal
tidak bisa diakses langsung dari klien. Tabel draf dan salinan item ikut
ekspor dan pemulihan mulai skema 0026.

Bagian ini hanya mengatur draf lokal. Berkas tidak berubah fase menjadi
inaktif. Salinan metadata tetap sama meskipun data sumber berubah sesudah
pembuatan draf; tahap pengajuan berikutnya harus memvalidasi berkas lagi
sebelum menghasilkan paket. Verifikasi metadata lama dari menu Retensi,
impor usul lama, penomoran resmi, pembuatan dokumen/paket, outbox, dan
pertukaran keputusan Record Center masih di tahap berikutnya.
