# Central File 3.32.1 — desain ulang Out Indicator

Tanggal: 11 November 2026. Schema tetap **11**, tanpa migrasi. Baseline: 3.32.0 (`043b20c`). Hanya `central-file/OutIndicatorPrint.html` dan `Config.js` (versi) yang berubah.

## Tujuan

Permintaan pengguna: Out Indicator mengikuti palet warna logo UIN Sunan Ampel Surabaya dan tampil lebih estetis. Sebelumnya memakai biru tua + oranye yang tidak sesuai identitas visual aplikasi (sudah hijau/emas sejak rombak UI 3.30.x).

## Desain

- **Palet logo UINSA**: hijau zamrud `#0B4D2C` (pita kepala, kepala tabel, aksen), hijau tua `#062E1D` (judul), emas `#C4A163`/`#946C26` (garis aksen, label kecil, ornamen), krem `#FBF7ED` (kartu identitas). Latar halaman tetap putih agar hemat tinta.
- **Ornamen bintang segi delapan (Rub el Hizb)** dari logo digambar sebagai vektor tipis di pita kepala, terpotong rapi di tepi pita.
- **Hierarki informasi untuk petugas di rak**: kartu krem berisi *Nomor Berkas* (besar), *Lokasi Asal*, dan *Wajib Kembali* — tiga hal yang paling sering dicari ketika arsip keluar.
- **Status berbentuk pil**: emas = DIPINJAM, merah = TERLAMBAT (tanggal kembali ikut merah), hijau = SUDAH KEMBALI.
- Rincian peminjam dua kolom (termasuk NIP/NIK dan WhatsApp bila ada), keperluan dalam panel hijau muda, tabel dengan baris selang-seling, footer "Simpan di lokasi asal" dengan tanggal cetak.
- Lembar multi-berkas tetap satu lembar per berkas dengan label "LEMBAR BERKAS x DARI n"; halaman lanjutan memakai kepala ringkas.

## Perbaikan teknis

- Lebar teks kini diukur dengan metrik font **Helvetica** sebenarnya (sebelumnya metrik Times di browser), sehingga pemotongan baris, rata kanan, dan rata tengah presisi dan teks tidak meluber dari kolom.
- Tanda "·" dan "–" dicetak sebagai karakter WinAnsi asli (sebelumnya diganti "-").
- Jarak spasi huruf (`Tc`) selalu di-set ulang per teks agar tidak terbawa ke teks lain.

## Pengujian

`node --test tests/*.test.cjs` → **79/79 lulus**. Pratinjau dirender dengan `pdftoppm` untuk empat kasus: satu berkas, multi-berkas 14 item (3 halaman lanjutan), terlambat, sudah kembali.

## Pemasangan

Dari folder `central-file`: `clasp push`, lalu `clasp deploy -i <deploymentId produksi> -d "v3.32.1 PILOT - Desain ulang Out Indicator"`. Tidak perlu migrasi. Cetak ulang Out Indicator dari tabel Pelacakan Peminjaman untuk mencoba.
