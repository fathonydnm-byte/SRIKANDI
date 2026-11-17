# Latihan pemulihan Central File v4

Gunakan paket asli dari Google Drive di komputer instansi. Perintah di bawah membuat PostgreSQL **baru, sementara, dan hanya lokal**. Ia memakai migrasi dari checkout, menguji ROLLBACK lalu COMMIT, dan membersihkan database sementara saat selesai. Paket yang diunduh tetap ada. Tidak perlu URL atau akun Supabase, Cloudflare, atau Apps Script.

## Paket pertama di staging

Log Apps Script 17 November 2026 WIB mencatat `BAGUM`: cermin dan backup berhasil (1.772 baris), serta `_PLATFORM`: backup berhasil (0 baris). Pemilik memulihkan kedua paket asli di PostgreSQL 16 lokal melalui Ubuntu WSL. Log berakhir dengan `Latihan pemulihan lulus`. Jumlah baris per tabel cocok; pemeriksaan relasi, keunikan nomor, dan counter tanda terima lulus. Database sementara dibersihkan. Aktivasi pemicu harian dan hasil malam pertama belum dikonfirmasi.

1. Di Google Drive akun instansi, unduh **masing-masing folder tanggal** dari `CENTRAL FILE V4/BAGUM/BACKUP/` dan `CENTRAL FILE V4/_PLATFORM/BACKUP/`. Pilih tanggal yang sama. Jika dua ZIP bernama sama, beri nama lokal `BAGUM.zip` dan `PLATFORM.zip`. Jangan gabungkan keduanya menjadi satu ZIP. Masing-masing harus memuat `manifest.json`; backup platform dengan nol baris tetap sah.
2. Gunakan Linux, atau Ubuntu di WSL pada Windows. Dari root repo, pada revisi yang berisi panduan ini, pastikan Node.js 22+, npm, Bash, dan biner PostgreSQL 16 terpasang. Biner PostgreSQL biasanya ada di `/usr/lib/postgresql/16/bin`; jika berbeda, atur `PG_BIN`.
3. Jalankan dari root repo dengan path paket yang sesuai:

```bash
npm ci --prefix v4/tools/restore-backup --no-audit --no-fund
bash v4/tools/restore-backup/rehearse.sh \
  "/mnt/c/path-ke-paket/BAGUM.zip" \
  "/mnt/c/path-ke-paket/PLATFORM.zip"
```

Folder paket yang sudah diekstrak juga bisa dipakai. Alat mencocokkan versi skema manifest dengan database. Jika tidak cocok, gunakan checkout dengan migrasi sesuai versi paket; jangan paksa perbedaan skema. Revisi awal panduan ini memuat migrasi hingga `0023`.

4. Catat tanggal dan versi skema paket, jumlah baris per unit, hasil pemeriksaan, serta pesan `Latihan pemulihan lulus`. Jika gagal, sampaikan jenis pemeriksaan atau kode error saja, tanpa isi arsip atau paket. Aktifkan `installNightlyTrigger` pada proyek Apps Script cermin hanya setelah paket ini lolos latihan.

Latihan ini menguji pemulihan **data paket** (hash, jumlah baris, transaksi, dan integritas relasi/nomor). Akun login dan isi PDF tidak disalin oleh paket; file tetap di Google Drive dan paket menyimpan referensi/inventaris. Ini bukan latihan untuk pemulihan Supabase Auth atau pemindahan file alih media.
