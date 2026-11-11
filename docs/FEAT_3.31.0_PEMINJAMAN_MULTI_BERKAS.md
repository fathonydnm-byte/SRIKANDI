# Central File 3.31.0 — peminjaman beberapa berkas/item dalam satu transaksi

Tanggal: 11 November 2026. Schema tetap **10** (tidak ada perubahan sheet/header, tidak ada migrasi). Baseline source: commit `e30c96e` (3.30.6, deployment @60).

Status: **source siap di git, belum dipasang ke Apps Script.** Container agent pada sesi ini tidak mempunyai clasp/kredensial Google, sehingga pemasangan dilakukan pengguna (alur yang sama dengan 3.30.6).

## Kebutuhan bisnis

Sebelumnya satu transaksi peminjaman hanya bisa memuat **satu berkas lengkap** atau **beberapa item dalam satu berkas**. Di lapangan peminjam sering meminjam beberapa berkas/item dari berkas berbeda sekaligus, sehingga petugas harus menginput berulang (dan menghasilkan beberapa Berita Acara/Out Indicator untuk satu kali peminjaman).

## Perubahan

### Form Peminjaman (`Index.html`, `Client.html`, `Styles.html`)

- Tombol baru **"+ Tambahkan ke Daftar Pinjam"** di bawah pemilih berkas/item. Petugas memilih berkas lengkap atau item, menekan tombol, lalu mengulang untuk berkas berikutnya.
- Panel **"Daftar arsip yang dipinjam"** menampilkan setiap berkas/item beserta jumlah lembar dan lokasi asal, dengan tombol **Hapus** per baris dan **Kosongkan Daftar**.
- Pilihan yang sedang aktif tetapi belum ditambahkan tetap ikut tersimpan (ditandai "Pilihan saat ini — ikut tersimpan"), sehingga alur lama satu berkas tetap: pilih → isi data → simpan, tanpa harus menekan tombol tambah.
- Pengaman di klien: berkas yang sudah ada di daftar sebagai berkas lengkap tidak bisa dipilih lagi; berkas yang sudah ada per item tidak bisa ditambahkan sebagai berkas lengkap; item yang sudah di daftar ditampilkan tercentang dan nonaktif. Item tambahan dari berkas yang sama digabung ke baris yang sama.
- Jumlah halaman/item terisi otomatis dari total seluruh daftar (tetap dapat dikoreksi).
- Tabel Pelacakan Peminjaman menampilkan transaksi multi-berkas sebagai **satu baris** (mis. "3 berkas (1, 4, 9)") lengkap dengan rincian setiap objek; form Catat Pengembalian mengembalikan seluruh objek dalam transaksi sekaligus.

### Server (`LoanService.js`, `BeritaAcaraService.js`)

- Payload baru `loanSelectionsJson = [{objectType: 'BERKAS'|'ITEM', berkasId, itemIds}]`. Format lama (`loanObjectType`/`loanBerkasId`/`loanItemIdsJson`) tetap diterima sebagai satu pilihan.
- Validasi per berkas memakai aturan benturan yang sama seperti sebelumnya (berkas dipinjam seluruhnya, item sedang dipinjam, status tidak sinkron); pesan galat menyebut nomor berkas bila transaksi memuat lebih dari satu berkas. Berkas yang dicantumkan dua kali ditolak; item dari berkas yang sama digabung. Maksimal 100 objek per transaksi (batas yang sudah ada).
- Data tetap **satu baris per objek** di sheet PEMINJAMAN dengan `LOAN_GROUP_ID` yang sama; `LOKASI_ASAL_SNAPSHOT`, nomor kabinet/laci/folder, dan `JUMLAH_HALAMAN_ITEM` dicatat per objek, `JUMLAH_HALAMAN_GRUP_SNAPSHOT` = total transaksi.
- Status `STATUS_PEMINJAMAN` di DB_BERKAS/DB_ITEM diperbarui untuk **semua** berkas yang terlibat, baik saat pinjam maupun kembali (sebelumnya pengembalian hanya menyinkronkan berkas pertama).
- **Out Indicator**: satu lembar A5 **per berkas** dalam satu PDF, masing-masing dengan lokasi asal dan daftar item berkasnya serta label "LEMBAR BERKAS x DARI n", karena penanda diletakkan di lokasi asal tiap berkas.
- **Berita Acara**: satu dokumen untuk seluruh transaksi; bila lebih dari satu berkas, kolom objek menyertakan nomor berkas ("Berkas 4 / Item 2", "Berkas 9 (lengkap)").
- Audit: `JENIS_OBJEK` = `MULTI_BERKAS` untuk transaksi lintas berkas.

### Perbaikan bug terkait

`sanitizeLoanForm_()` (dipakai saat peminjaman disertai upload bukti persetujuan) belum meneruskan field wajib yang ditambahkan pada rilis Berita Acara (jabatan peminjam, kondisi, data petugas), sehingga peminjaman **dengan file bukti** akan ditolak "Jabatan peminjam wajib diisi". Field tersebut dan `loanSelectionsJson` kini diteruskan.

| File aplikasi | Perubahan |
|---|---|
| `central-file/LoanService.js` → `LoanService.gs` | Parsing daftar pilihan, validasi & penulisan multi-berkas, ringkasan grup, pengembalian multi-berkas, Out Indicator per berkas, perbaikan `sanitizeLoanForm_` |
| `central-file/BeritaAcaraService.js` → `BeritaAcaraService.gs` | Daftar objek BA lintas berkas |
| `central-file/Client.html` | Daftar Pinjam, payload baru, tabel & form pengembalian |
| `central-file/OutIndicatorPrint.html` | PDF satu lembar per berkas |
| `central-file/Index.html`, `central-file/Styles.html` | Markup & gaya Daftar Pinjam |
| `central-file/Config.js` → `Config.gs` | Versi 3.31.0, tanggal rilis; schema 10 |

## Pengujian

Perintah: `node --test tests/*.test.cjs`. Hasil 11 November 2026: **39/39 lulus** — 20 regresi sebelumnya, 13 kasus server baru (`tests/multi-berkas-loan.test.cjs`), 6 kasus klien baru (`tests/multi-berkas-loan-client.test.cjs`). Pengujian memakai fungsi source sebenarnya; layanan Google dan DOM disimulasikan di memori. Ini tidak membuktikan deployment live.

- Satu transaksi: berkas lengkap + item dari dua berkas lain → 4 baris dengan grup yang sama, lokasi/lembar per objek, status ketiga berkas dan itemnya diperbarui.
- Tabel peminjaman menampilkan satu baris dengan seluruh nomor berkas; ringkasan statistik benar.
- Payload lama satu berkas / beberapa item tetap menghasilkan ID dan judul yang sama seperti sebelumnya.
- Duplikat/benturan (berkas dua kali, berkas lengkap + item berkas yang sama, berkas tidak ditemukan, item kosong, berkas/item sedang dipinjam) ditolak sebelum ada data ditulis.
- Kirim ulang ID transaksi yang sama tidak membuat baris ganda.
- Pengembalian membebaskan semua berkas dan item yang terlibat.
- Out Indicator: satu lembar per berkas (lokasi & item masing-masing); payload satu berkas tidak berubah. PDF klien: 3 berkas → 3 halaman.
- Berita Acara: nomor objek berawalan nomor berkas untuk transaksi lintas berkas; penomoran satu berkas tetap.
- Klien: tambah/gabung/tolak benturan di Daftar Pinjam, pilihan aktif ikut tersimpan, payload berisi seluruh pilihan + field lama, simpan tanpa pilihan ditolak.

## Pemasangan

1. Pastikan project adalah Central File yang benar (scriptId `1_Z8ZfkDU1lIGuI5hlOCp4eeNaXiFR-3zJjO8XL60lSeIotbcaKljRLvb`).
2. Backup source live dan bandingkan dengan baseline 3.30.6 (`e30c96e`) agar perubahan live di luar git tidak tertimpa.
3. Jika live sesuai baseline: dari folder `central-file` jalankan `clasp push`, lalu redeploy deployment produksi yang sudah ada sebagai **versi baru** (`clasp deploy -i <deploymentId> -d "v3.31.0 - Peminjaman multi berkas"`) — URL Web App tetap sama. Tidak perlu installer, repair schema, atau reset data.
4. Buka ulang Web App (hard refresh), cocokkan rilis 3.31.0/schema 10.

## UAT yang disarankan

Gunakan data uji yang disetujui. Catat satu peminjaman berisi: satu berkas lengkap + dua item dari berkas lain. Periksa: satu baris di tabel Pelacakan; sheet PEMINJAMAN berisi baris per objek dengan `LOAN_GROUP_ID` sama; status berkas/item di Daftar Isi Berkas; Out Indicator berisi satu lembar per berkas; Berita Acara memuat seluruh objek. Lalu Catat Kembali dan pastikan seluruh berkas/item kembali TERSEDIA. Ulangi peminjaman satu berkas biasa (alur lama) dan peminjaman dengan file bukti persetujuan.

Rollback: pilih versi deployment sebelumnya (@60). Transaksi multi-berkas yang sudah tercatat tetap valid dibaca versi lama sebagai baris-baris per objek, tetapi tabel versi lama akan menampilkan ringkasannya seolah satu berkas dan pengembaliannya hanya menyinkronkan status berkas pertama — selesaikan pengembalian transaksi multi-berkas sebelum rollback, atau jalankan sinkronisasi status dengan membuka menu Peminjaman.
