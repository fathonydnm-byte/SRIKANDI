# Memasang gerbang Drive (untuk Admin Pusat)

Gerbang ini membuat aplikasi Central File bisa membuka PDF arsip dari Google Drive **akun instansi** tanpa memberi akses Drive kepada setiap pengguna. Kerjakan sekali, ±15 menit.

> **Jangan pernah** menempel secret atau URL gerbang di chat, email, atau repo. Secret hanya disalin dari Apps Script ke Cloudflare.

## 1. Buat proyek Apps Script

1. Buka browser, **masuk sebagai akun instansi** `bag.umum@uinsa.ac.id` (akun pemilik folder arsip).
2. Buka <https://script.google.com> → **Proyek baru**. Ganti nama menjadi `Central File – Gerbang Drive`.
3. Hapus isi `Code.gs`, lalu tempel seluruh isi file [`Code.gs`](Code.gs) dari folder ini. Simpan (ikon disket).
4. Klik ⚙️ **Setelan proyek** → centang **Tampilkan file manifes "appsscript.json" di editor**.
5. Kembali ke **Editor**, buka `appsscript.json`, ganti seluruh isinya dengan file [`appsscript.json`](appsscript.json) dari folder ini. Simpan.

## 2. Buat secret dan beri izin

1. Di bilah atas editor, pilih fungsi **`setupGateway`**, klik **Jalankan**.
2. Muncul **Perlu otorisasi** → **Tinjau izin** → pilih akun instansi → (bila muncul "Google belum memverifikasi aplikasi ini": **Lanjutan** → **Buka … (tidak aman)**) → **Izinkan**. Izin yang diminta: **melihat** semua file Google Drive, dan **mengelola hanya file yang dibuat aplikasi ini** (untuk unggahan baru).
3. Setelah selesai, buka **Log eksekusi** di bawah. Ada baris `Secret gerbang baru …: <96 karakter>`. **Salin 96 karakter itu** (ini `DRIVE_GATEWAY_SECRET`). Log ini hanya Anda yang bisa melihat.

## 3. Pasang sebagai aplikasi web

1. Klik **Terapkan** → **Deployment baru** → ikon ⚙️ → **Aplikasi web**.
2. Isi: Deskripsi `Gerbang Drive v1`; **Jalankan sebagai: Saya (bag.umum@…)**; **Yang memiliki akses: Siapa saja**.
   (Aman: setiap permintaan wajib bertanda tangan secret; tanpa itu gerbang hanya menjawab "DITOLAK".)
3. Klik **Terapkan**, lalu salin **URL aplikasi web** (berakhiran `/exec`). Ini `DRIVE_GATEWAY_URL`.

## 4. Isi di Cloudflare Pages

1. Buka dasbor Cloudflare → **Workers & Pages** → proyek **central-file-uinsa** → **Settings** → **Variables and Secrets**.
2. Tambahkan untuk lingkungan **Production** (dan **Preview** bila dipakai), tipe **Secret** (terenkripsi):

   | Nama | Isi |
   | --- | --- |
   | `DRIVE_GATEWAY_URL` | URL `/exec` dari langkah 3 |
   | `DRIVE_GATEWAY_SECRET` | 96 karakter dari langkah 2 |
   | `FILE_TICKET_SECRET` | teks acak ≥ 32 karakter (boleh jalankan `setupGateway` di proyek lain atau pakai pembuat kata sandi; **berbeda** dari secret gerbang) |
   | `UPLOAD_ATTEST_SECRET` | teks acak ≥ 32 karakter, **berbeda** dari dua secret lain (dipakai untuk mengesahkan unggahan) |
   | `SUPABASE_URL` | URL proyek Supabase (sama dengan `VITE_SUPABASE_URL`) |
   | `SUPABASE_ANON_KEY` | anon key Supabase (sama dengan `VITE_SUPABASE_ANON_KEY`) |

3. **Deploy ulang** (Deployments → … → Retry deployment, atau push berikutnya) supaya variabel terbaca.

## 5. Uji

Masuk ke Central File di HP → Cari Arsip → buka satu arsip yang PDF-nya tersedia → **Lihat PDF**. Bila muncul "Jembatan Drive belum dipasang", periksa nama variabel di langkah 4 lalu deploy ulang.

## Mengganti secret / mencabut akses

- Ganti secret: jalankan lagi `setupGateway` (secret lama langsung tidak berlaku), lalu perbarui `DRIVE_GATEWAY_SECRET` di Cloudflare dan deploy ulang.
- Mencabut sama sekali: Apps Script → **Terapkan** → **Kelola deployment** → **Arsipkan**; dan/atau <https://myaccount.google.com/permissions> → hapus akses proyek ini.
- Memperbarui kode: tempel `Code.gs` baru → **Terapkan** → **Kelola deployment** → ✏️ → **Versi: Versi baru** → **Terapkan** (URL tetap sama).

## Pembaruan Sprint 2: izin unggah (sekali, ±5 menit)

Mulai Sprint 2 aplikasi bisa **mengunggah** PDF. Gerbang perlu izin tambahan "kelola file yang dibuat aplikasi ini" (`drive.file`). Izin ini **tidak** bisa mengubah atau menghapus file lama di Drive; aplikasi hanya bisa menulis ke folder baru `CENTRAL FILE V4` yang dibuatnya sendiri.

1. Masuk sebagai `bag.umum@uinsa.ac.id`, buka proyek **Central File – Gerbang Drive** di <https://script.google.com>.
2. Ganti isi `Code.gs` dan `appsscript.json` dengan versi terbaru dari folder ini. Simpan.
3. Pilih fungsi **`authorizeGateway`** → **Jalankan** → **Tinjau izin** → **Izinkan**. (Fungsi ini **tidak** mengganti secret; jangan jalankan `setupGateway` kecuali memang ingin mengganti secret.) Log menampilkan `Izin gerbang aktif`.
4. **Terapkan** → **Kelola deployment** → pilih deployment yang ada → ✏️ **Edit** → **Versi: Versi baru** → **Terapkan**. URL `/exec` **tetap sama**; tidak perlu mengubah apa pun di Cloudflare kecuali menambahkan `UPLOAD_ATTEST_SECRET` (lihat tabel langkah 4 di atas) lalu deploy ulang Pages.
5. Uji: di Central File buka **Alih Media Arsip**, unggah satu PDF kecil. Bila muncul pesan izin Drive kurang, tunggu ±30 menit (token lama masih tersimpan sementara) atau deploy ulang Pages, lalu coba lagi.
