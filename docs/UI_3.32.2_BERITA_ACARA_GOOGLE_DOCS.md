# Central File 3.32.2 — Berita Acara sebagai Google Docs

Tanggal: 11 November 2026. Schema tetap **11**, tanpa migrasi dan tanpa perubahan header sheet. Baseline: 3.32.1 (`202d358`).

## Kebutuhan

Hasil PDF Berita Acara Peminjaman & Pengembalian sering tidak rapi (pemutusan halaman, halaman kosong) dan tidak dapat diperbaiki petugas. Pengguna meminta BA dibuat sebagai Google Docs agar dapat dirapikan sebelum dicetak.

## Perilaku baru

- Tombol **Cetak BA Peminjaman** (dan pembuatan otomatis setelah transaksi tersimpan) menghasilkan **Google Docs** di folder *Central File/Berita Acara Peminjaman Arsip*. Tidak ada lagi konversi ke PDF; petugas merapikan lalu mencetak/mengunduh PDF langsung dari Google Docs.
- **Satu transaksi = satu dokumen.** Membuka BA lagi membuka dokumen yang sama, bukan membuat salinan baru, sehingga rapian petugas tidak hilang.
- **Saat pengembalian dicatat**, data pengembalian diisikan ke dokumen yang sama: tag tanggal kembali dan petugas penerima yang masih tersisa diganti, serta kolom *Kondisi Arsip* bagian Pengembalian yang masih kosong/"–" diisi kondisi kembali. Teks yang sudah diubah petugas tidak disentuh.
- Data petugas penerima pengembalian kini dibiarkan sebagai isian tangan sampai arsip benar-benar kembali (sebelumnya diisi nama petugas peminjaman dan tidak akan terkoreksi pada dokumen yang dipakai ulang).
- Transaksi lama yang tautannya masih PDF, atau dokumen yang sudah dihapus, otomatis dibuatkan dokumen Docs baru.
- Kolom `BA_PDF_ID`/`BA_PDF_URL` dan log `LOG_CETAK_BERITA_ACARA` tetap dipakai (kini berisi ID/URL dokumen Docs; `STATUS` = `DOCS_DIBUAT`), sehingga tidak perlu perubahan struktur.

| File | Perubahan |
|---|---|
| `central-file/BeritaAcaraService.js` | Simpan Docs, pakai ulang dokumen, isi data pengembalian di tempat |
| `central-file/Client.html` | Buka URL Docs, teks proses, keterangan tombol |
| `central-file/Config.js` | Versi 3.32.2 |

## Pengujian

`node --test tests/*.test.cjs` → **82/82 lulus**, termasuk kasus baru: Docs dibuat & disimpan tanpa PDF; dibuka ulang tanpa salinan baru; pengembalian mengisi dokumen yang sama tanpa menimpa isian manual; PDF lama/dokumen terhapus diganti dokumen baru.

## Pemasangan

Dari folder `central-file`: `clasp push`, lalu `clasp deploy -i <deploymentId produksi> -d "v3.32.2 PILOT - Berita Acara Google Docs"`. Tidak perlu migrasi atau izin baru (scope Drive & Docs sudah ada).

## 3.32.3 — perapian tata letak otomatis (11 November 2026)

Laporan pengguna: walau sudah disisipi page break, halaman pertama tetap "menyundul" halaman berikutnya. Analisis struktur template `TEMPLATE BERITA ACARA PEMINJAMAN & PENGEMBALIAN ARSIP` (ekspor .docx, dibaca seluruhnya): **tidak ada page break maupun keep-with-next**; perpindahan halaman diatur dengan menumpuk baris kosong — 19 baris antara tabel dan "Demikian…", 15 baris sebelum "Tembusan", 19 dan 17 baris di bagian Pengembalian. Tumpukan itu hanya pas untuk tabel satu baris; tabel yang lebih panjang mendorongnya ke halaman berikutnya dan menggeser seluruh isi.

Perbaikan `normalizeBeritaAcaraLayout_()` (hanya pada dokumen BA yang **baru dibuat**, tidak pada dokumen yang sedang/ sudah dirapikan petugas):

- Tumpukan ≥ 5 paragraf kosong berturut-turut diringkas menjadi satu. Ruang tanda tangan (3 baris), gambar, daftar, dan tabel tidak disentuh.
- Page break asli disisipkan tepat sebelum judul "BERITA ACARA PENGEMBALIAN ARSIP" (tidak digandakan bila sudah ada).

Simulasi pada struktur template asli: 140 → 73 elemen, 68 baris kosong dihapus, satu page break sebelum bagian Pengembalian. `node --test tests/*.test.cjs` → **84/84 lulus**.

Catatan: ukuran kertas template saat ini **Letter** (8,5 × 11 inci); bila standar unit A4/F4, ubah lewat *File → Page setup* pada template.
