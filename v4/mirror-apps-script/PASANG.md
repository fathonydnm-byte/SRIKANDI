# Memasang Cermin Spreadsheet & Backup (untuk Admin Pusat)

Proyek Apps Script **kedua** (terpisah dari gerbang Drive) yang setiap malam: (1) menyalin data tiap unit ke Google Sheets **hanya-baca** supaya data tetap terbaca walau aplikasi mati, dan (2) menyimpan **paket backup harian** di Drive. Sekaligus membuat proyek Supabase gratis tidak dijeda. Kerjakan sekali, ±20 menit.

> **Jangan pernah** menempel `JOB_SECRET` di chat, email, atau repo. Salin langsung dari Apps Script ke Cloudflare.

**Keamanan data:** paket menggunakan perlindungan bawaan Google Drive akun instansi, tanpa enkripsi tambahan dari aplikasi. Kolom data pribadi (NIP/NIK, kontak) di dalam paket tetap terenkripsi seperti di database; cermin spreadsheet tidak memuatnya sama sekali. Siapa pun yang punya akses ke akun instansi dapat membaca cermin.

## 1. Buat proyek kedua
1. Masuk sebagai akun instansi `bag.umum@uinsa.ac.id`. Buka <https://script.google.com> → **Proyek baru**. Namai `Central File – Cermin & Backup`.
2. Hapus isi `Code.gs`, tempel seluruh isi [`Code.gs`](Code.gs). Simpan.
3. ⚙️ **Setelan proyek** → centang **Tampilkan file manifes "appsscript.json"**. Ganti isinya dengan [`appsscript.json`](appsscript.json). Simpan. (Manifes memasang layanan lanjutan **Google Sheets API v4** dan meminta `drive.file`, panggilan keluar, serta pemicu. Jangan tambahkan izin umum `spreadsheets` atau `drive`. Proyek hanya mencari spreadsheet cermin bertanda miliknya dan **tidak punya** aplikasi web.)
4. Bila memakai proyek Google Cloud standar, aktifkan **Google Sheets API** di proyek tersebut sebelum uji. Pada proyek bawaan Apps Script, penambahan layanan lanjutan mengaktifkan API terkait. Bila akun sebelumnya sudah memberi izin cakupan lama pada proyek cermin, hapus pemberian izin proyek **cermin** itu dan beri izin ulang setelah kedua file diperbarui.

## 2. Buat secret dan beri izin
1. Pilih fungsi **`setupMirror`** → **Jalankan** → **Tinjau izin** → akun instansi → **Lanjutan** → **Buka … (tidak aman)** → **Izinkan**.
2. Buka **Log eksekusi**: ada baris `JOB_SECRET baru …: <96 karakter>`. Salin 96 karakter itu.
3. Cloudflare → Workers & Pages → proyek aplikasi → **Settings → Variables and Secrets** → **Add**: nama `JOB_SECRET`, tipe **Secret**, tempel nilainya (Production, dan Preview bila dipakai). Pastikan `SUPABASE_SERVICE_ROLE_KEY` juga sudah ada sebagai Secret. **Deploy ulang** agar terbaca.

## 3. Alamat aplikasi dan pemicu malam
1. Di editor, buka fungsi `aturAlamatAplikasi`, ganti teks `https://GANTI-DENGAN-ALAMAT-APLIKASI.pages.dev` dengan alamat aplikasi Anda (wajib `https`, tanpa jalur), simpan, **Jalankan** (atau tambahkan properti skrip `BASE_URL` di Setelan proyek).
2. Setelah `JOB_SECRET` tersedia pada deployment staging, jalankan **`runNow`** sekali untuk mencoba. Bila pekerjaan melebihi batas 6 menit Apps Script, ia berhenti dan **melanjutkan sendiri** 1 menit kemudian (unit banyak = beberapa putaran; tidak perlu diapa-apakan). `statusMirror` menampilkan posisinya.
3. Setelah cermin dan paket pertama diverifikasi, jalankan **`installNightlyTrigger`**. Aman diulang: hanya satu pemicu harian, antara pukul 01:00 dan 02:00 WIB.

## 4. Di mana hasilnya
Di Drive akun instansi, folder **CENTRAL FILE V4** (dibuat proyek ini; bisa ada dua folder bernama sama karena gerbang Drive membuat folder sendiri — proyek ini hanya memakai miliknya):
- `CENTRAL FILE V4/<kode unit>/CERMIN/CERMIN CENTRAL FILE – <kode unit>`: spreadsheet. Tab `DAFTAR BERKAS`, `DAFTAR ISI BERKAS`, lalu tabel dengan nama 3.x (`DB_BERKAS`, `DB_ITEM`, `MASTER_KLASIFIKASI` …), dan `_INFO`. **Perubahan di sini tidak masuk ke aplikasi** dan ditimpa tiap malam (peringatan muncul saat mengedit).
- `CENTRAL FILE V4/<kode unit>/BACKUP/<tanggal>/`: paket (`*.ndjson.gz` per tabel, `manifest.json`). Disimpan 30 paket harian terbaru + paket pertama tiap bulan selama 12 bulan; sisanya dibuang ke tempat sampah Drive (hanya yang dibuat proyek ini). Ada juga `_PLATFORM/BACKUP` untuk catatan audit lintas unit.

## 5. Memeriksa
Di aplikasi, menu **Keamanan & Audit → Cadangan & Cermin** (Admin Pusat: semua unit; Admin Unit: unitnya). Spanduk kuning = tidak ada yang berhasil >36 jam atau belum pernah jalan; merah = percobaan terakhir gagal. Bila Apps Script gagal, Google juga mengirim email kegagalan ke pemilik proyek.

## 6. Latihan restore (restore drill)
Backup baru terbukti bila bisa dipulihkan. **Admin Pusat bersama pengembang**, minimal tiap tiga bulan dan sebelum cutover, di proyek Supabase/Postgres **baru dan kosong** (bukan produksi):
1. Terapkan semua migrasi ke database kosong itu.
2. Unduh folder paket `<tanggal>` dari Drive (atau zip-kan).
3. Di komputer pengembang: `RESTORE_DATABASE_URL=<url database> node v4/tools/restore-backup/restore.mjs --package <folder-atau-zip> --database-url-env RESTORE_DATABASE_URL --dry-run`, lalu ulangi tanpa `--dry-run`. Alat memeriksa hash dan jumlah baris, menolak bila versi skema berbeda, memuat dalam satu transaksi, dan menjalankan pemeriksaan integritas (yatim, nomor ganda, counter).
4. Akun login (tabel `profiles`/Auth) tidak ikut paket: buat ulang oleh admin.
Catat hasil latihan (tanggal, paket, lolos/tidak).

## Mengganti secret / mencabut
- `rotateJobSecret` membuat secret baru (yang lama langsung tidak berlaku); perbarui di Cloudflare dan deploy ulang.
- Berhenti total: `removeTriggers`, lalu cabut akses di <https://myaccount.google.com/permissions>.
- Pekerjaan macet: `resetJob` (tidak menghapus apa pun di Drive).
