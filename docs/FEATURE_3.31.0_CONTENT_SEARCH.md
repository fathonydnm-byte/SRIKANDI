# Central File 3.31.0 PILOT — pencarian isi per berkas

Tanggal: 15 Oktober 2026. Schema **11**, migrasi **REL-013**. Baseline kode: `e30c96eefb27159e8703e3e9f9cf5c765c08323e` (3.30.6/schema 10; deployment @60 menurut screenshot pengguna 14 Oktober).

**Status: source dibangun dan diuji lokal; belum dipasang, belum dimigrasikan, dan belum di-UAT pada instance Google pengguna.** Jangan mengartikan nomor rilis di source sebagai bukti deployment. Pengembangan ini hanya Central File; source Record Center tidak berubah.

## Keputusan dan perilaku

- Pencarian kata/frasa literal di **satu berkas**, dengan filter semua item atau satu item. Beberapa kata dicari berurutan dalam satu paragraf; huruf besar/kecil dan perbedaan whitespace diabaikan. Tidak mengoreksi ejaan OCR, angka, identitas, atau menghitung jawaban.
- Word `.docx` hasil OCR dilengkapi per item yang sudah memiliki PDF. Word belum wajib untuk registrasi arsip; item tanpa Word tetap sah dan tampil dalam hitungan cakupan.
- Tombol tersedia di berkas yang dibuka pada Dashboard, halaman Pencarian Arsip, setiap hasil metadata, dan detail Spotlight. Buka **Kelola Word pendamping dan kesiapan item** untuk mengunggah/mengganti Word.
- Hasil memuat item sumber, paragraf/bagian, sorotan frasa, konteks sebelum/sesudah yang bisa dibuka, serta tautan PDF dan Word.
- Nomor halaman tidak ditebak. Parser tahap pertama tidak menyediakan pemetaan halaman yang terverifikasi; semua hasil memakai paragraf. Nomor paragraf adalah urutan paragraf tidak kosong pada bagian Word, bukan nomor halaman PDF.
- PDF diganti melalui aplikasi → ID PDF berubah → teks lama langsung tidak memenuhi syarat pencarian. Unggah Word baru agar item siap dicari lagi. Pemeriksaan dilakukan saat mulai unggah, finalisasi, ekstraksi, dan setiap pencarian; hasil diperiksa ulang sebelum dikembalikan.
- Word terbaru menggantikan versi sebelumnya untuk pencarian, termasuk selama mengantre/diproses/gagal. File dan catatan versi sebelumnya tetap tersimpan. Tidak ada pemulihan versi lama secara diam-diam.
- Tidak membatasi otomatis pada 25 halaman. Angka JUMLAH_HALAMAN tidak dipakai sebagai batas. Berkas panjang memakai proses dan mesin pencarian yang sama.
- Tidak ada panggilan model AI/OCR/API berbayar. Nitro/OCR dilakukan petugas; penyimpanan dan proses tetap memakai kapasitas/kuota akun Google.

## Batas tahap pertama

| Batas | Nilai / perilaku |
|---|---|
| Format | `.docx`, bukan `.doc`, PDF, DOCM, atau Google Docs |
| Ukuran Word | Maksimal 10 MiB, diperiksa server |
| ZIP setelah diekspansi | Maksimal 32 MiB; maksimal 1.500 entri |
| Tiap bagian XML | Maksimal 6 MiB |
| Teks hasil ekstraksi | Maksimal 750.000 karakter, 12.000 bagian paragraf |
| Paragraf sangat panjang | Bagian 2.400 karakter, overlap 200 agar frasa pada batas tidak hilang; konteks dapat berulang |
| Kata/frasa | 2–120 karakter; substring, tanpa stemming/semantik |
| Tiap respons pencarian | Maksimal 20 bagian cocok, 3 pembacaan indeks, atau anggaran pemrosesan 15 detik (bukan janji latensi total) |
| Kelanjutan | Tombol **Lanjutkan pencarian** sampai cakupan selesai; respons parsial tidak dianggap hasil final |
| Ekstraksi | Satu dokumen per eksekusi trigger; antrean setiap satu menit, waktu nyata bergantung jadwal/kuota Google |
| Proses terhenti | Lease 10 menit; maksimal tiga percobaan sebelum FAILED yang terlihat; retry manual tersedia |

Dokumen yang melampaui batas ditolak/diberi status gagal dengan penjelasan. Jangan memangkas teks diam-diam. Belum ada pengujian Word nyata 160 halaman; pengujian lokal memakai metadata 160 halaman dan indeks sintetis 160 paragraf, yang **bukan** bukti performa dokumen vendor nyata 160 halaman. Angka batas di atas adalah batas awal konservatif, bukan kapasitas maksimum Google yang dijamin.

## Penyimpanan dan schema

Migrasi menambah satu sheet **DB_SEARCH_DOCUMENTS**, tanpa mengubah header/data DB_ITEM atau DB_BERKAS. Folder `_TEKS_PENCARIAN` dibuat di bawah folder berkas saat pertama kali Word diunggah; menyimpan Word dan JSON teks hasil ekstraksi. Tidak menambah izin berbagi Drive.

Kolom baru:

```text
DOCUMENT_ID, BERKAS_ID, ITEM_ID, SOURCE_PDF_ID, WORD_FILE_ID, WORD_NAME,
INDEX_FILE_ID, STATUS, CHAR_COUNT, PARAGRAPH_COUNT, ERROR_MESSAGE,
CREATED_AT, CREATED_BY, UPDATED_AT, LEASE_ID, LEASE_AT, ATTEMPT_COUNT
```

Setiap finalisasi unggah menambah satu catatan versi; DOCUMENT_ID sama dengan ID sesi unggah sebagai kunci idempotensi. Versi terbaru per item adalah catatan terakhir. QUERY tidak membaca isi Word ulang, melainkan JSON yang telah disiapkan. Cache opsional dipakai hanya untuk indeks kecil; pembacaan cache gagal memakai Drive. Metadata/ID PDF tetap diperiksa walaupun indeks berasal dari cache.

| Status | Arti / transisi |
|---|---|
| NO_PDF | Status efektif: item belum memiliki PDF; unggah Word ditolak |
| MISSING | Status efektif: belum ada dokumen pendamping |
| QUEUED → PROCESSING → READY | Unggah lengkap → pekerja ekstraksi → teks siap |
| FAILED → QUEUED | Kesalahan terlihat; petugas mencoba ulang versi terkini |
| STALE | PDF berbeda dari SOURCE_PDF_ID; wajib Word terbaru |
| SUPERSEDED | Pekerjaan lama digantikan unggahan baru saat proses berjalan; tidak diterbitkan |

STALE dihitung dari PDF saat ini; nilai STATUS lama yang masih READY di sheet bukan izin memakai teks lama. Item/berkas soft-delete tidak muncul dalam hasil. Teks diindeks saat unggah; perubahan file langsung melalui Drive di luar alur aplikasi tidak memicu ekstraksi otomatis. Gunakan unggah ulang untuk perubahan Word dan menu Perubahan Arsip untuk penggantian PDF.

DOCX dibaca memakai Utilities.unzip + XmlService. Isi utama, paragraf sel tabel, catatan kaki/akhir, serta header/footer berbasis teks disertakan; teks revisi yang dihapus dikecualikan. Gambar tidak di-OCR oleh aplikasi. Konten `altChunk` ditolak karena membutuhkan konversi khusus. Kualitas pencarian tetap mengikuti hasil OCR. Sampel SPMK pengguna tidak disalin ke repository/test fixture publik.

## File pemasangan

| File | Tindakan |
|---|---|
| Config.js, Code.js, Client.html, Index.html, ReliabilityService.js | Perbarui dari rilis ini |
| ContentDocumentService.js, ContentSearchService.js, DocxTextService.js, ContentSearch.html | Tambahkan |

Sembilan file aplikasi diperlukan. Source lainnya tetap baseline; tidak perlu mengganti UploadService, EditService, atau Services. File `.js` ditampilkan sebagai `.gs` pada editor Apps Script. Manifest/scopes tidak berubah; tidak perlu mengaktifkan layanan/cloud AI baru.

## Pengujian dan batas verifikasi

Jalankan `node --test tests/*.test.cjs`. Node.js dan Python 3 diperlukan untuk adaptor ZIP/XML pengujian; tidak ada Python/dependensi eksternal pada aplikasi GAS.

Hasil lokal: **45 pengujian lulus**, termasuk 20 regresi lama, parser DOCX, sel tabel/header/catatan, keamanan render HTML, unggah resumable/recovery/idempotensi, scope/filter, pergantian PDF, race worker, pagination lengkap, batas percobaan, migrasi idempoten, dan callback UI terlambat. Layanan Google disimulasikan; parser aplikasi sebenarnya dijalankan menggunakan adaptor ZIP/XML Python standar.

Uji tambahan dengan lampiran Nitro asli: `CONTENT_SEARCH_SAMPLE_DOCX=/path/to/sample.docx node --test tests/content-search.test.cjs`. Hasil: **4.185 karakter / 71 paragraf tidak kosong**, frasa Denda terbaca. Teks hasil OCR tetap apa adanya. PDF asli dua halaman berbentuk gambar, tanpa lapisan teks; Word ter-render dua halaman pada pemeriksaan lokal, tetapi tidak memiliki penanda halaman yang dapat menjamin pemetaan PDF.

Pemeriksaan sintaks semua `.js`, JavaScript inline HTML, dan JSON manifest lulus. Pengujian browser visual belum berjalan: executable Chromium tidak tersedia dan unduhan gagal. Test UI menggunakan adaptor DOM untuk state/render, bukan browser nyata. Izin Drive, jadwal trigger, latensi jaringan, dan tata letak Full HD perlu diverifikasi melalui UAT Google.

## Pemasangan melalui clasp

1. Pada versi existing, buat **Backup Metadata Sekarang** melalui Instalasi & Reliability. Catat deployment ID/versi existing (terakhir diketahui @60), akses, dan execute-as. Jangan reset data.
2. Unduh source branch `feat/berkas-content-search` dari GitHub, atau checkout branch tersebut. Pisahkan folder source rilis dari clone live. Bila membangun paket, jalankan `python scripts/package-central-file.py --output-dir <folder-output>`; ZIP berisi source lengkap tanpa `.clasp.json`/kredensial, manifest per file, dan checksum SHA-256.
3. Di PowerShell, buat folder clone baru lalu clone project **Central File**, menggunakan profil clasp yang sebelumnya berhasil:

```powershell
$scriptId = '1_Z8ZfkDU1lIGuI5hlOCp4eeNaXiFR-3zJjO8XL60lSeIotbcaKljRLvb'
$appFolder = Join-Path $HOME ('Documents\CentralFile-3.31.0-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $appFolder | Out-Null
Set-Location $appFolder
clasp.cmd --user central-file-uinsa clone-script $scriptId
if ($LASTEXITCODE -ne 0) { throw 'Clone gagal; jangan lanjut.' }
clasp.cmd --user central-file-uinsa list-deployments
```

4. Jalankan `scripts/prepare-content-search.ps1` dari source yang diunduh. Isi path sesuai lokasi ekstraksi:

```powershell
$releaseFolder = 'C:\path\ke\SRIKANDI-feat-berkas-content-search'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$releaseFolder\scripts\prepare-content-search.ps1" `
  -AppDirectory $appFolder -SourceDirectory "$releaseFolder\central-file" -ExpectedScriptId $scriptId
if ($LASTEXITCODE -ne 0) { throw 'Persiapan gagal; jangan push.' }
```

Script memeriksa binding project, membandingkan lima file existing terhadap baseline GitHub 3.30.6 (BOM/CRLF dinormalisasi), menolak perbedaan atau file ganda, mencadangkan clone, lalu menyiapkan sembilan file. **Script tidak push, tidak mengubah spreadsheet, dan tidak deploy.** Jika berbeda dari baseline, berhenti dan rekonsiliasi source live; jangan menonaktifkan pemeriksaan agar bisa memaksa.

Hash sembilan file rilis juga dicocokkan dengan manifest. Manifest seluruh 35 source ada pada `releases/central-file-3.31.0-manifest.json`. Build ZIP lokal yang diverifikasi memiliki SHA-256 `bb3345e5b6824b5bb0ad180859f54ac32df15748540854417756964026a632cf`; ZIP dapat dibangun ulang memakai skrip packaging (binary ZIP tidak dimasukkan ke git).

5. Periksa sembilan file yang disiapkan, lalu dari folder clone:

```powershell
Set-Location $appFolder
clasp.cmd --user central-file-uinsa push
if ($LASTEXITCODE -ne 0) { throw 'Push gagal; jangan deploy.' }
```

6. Buka spreadsheet Central File dan refresh. Jalankan **Arsip Aktif → Jalankan Migrasi Tertunda**. Pastikan REL-013 `SUCCESS`, SCHEMA_VERSION `11`, sheet DB_SEARCH_DOCUMENTS tersedia, dan satu trigger `continueContentDocumentJobs` aktif. Jika trigger hilang, gunakan **Pasang / Perbaiki Pencarian Isi Dokumen**. Jalankan health check. Tidak perlu repairReports/reset pilot/installer ulang.
7. Buat **New version** pada deployment existing yang benar; pertahankan URL dan akses. Bisa melalui Deploy → Manage deployments → edit → New version. Jika memakai clasp 3 yang sebelumnya dipakai, periksa ID pada `list-deployments`, lalu:

```powershell
$deploymentId = Read-Host 'Tempel deployment ID existing Central File yang sudah diperiksa'
clasp.cmd --user central-file-uinsa update-deployment $deploymentId --description 'v3.31.0 PILOT - Pencarian isi per berkas'
```

8. Buka Web App, hard refresh, verifikasi **3.31.0/schema 11**, lalu UAT. Catat nomor deployment aktual dan hasil; jangan menulis @61 sebagai fakta sebelum CLI/editor membuktikannya.

PowerShell persiapan belum dieksekusi di Windows dalam lingkungan pengembangan ini. Pemeriksaan baseline bergantung akses HTTPS raw.githubusercontent.com di PC pengguna. Jika jaringan tidak tersedia, jangan melewati verifikasi source.

## Checklist UAT setelah pemasangan

- [ ] Backup sebelum migrasi bisa dibuka; REL-013 satu SUCCESS; satu trigger; health check sesuai.
- [ ] Dashboard dan Pencarian Arsip menampilkan tombol Cari Isi tanpa mengganggu menu existing pada Full HD.
- [ ] Unggah DOCX SPMK untuk item PDF yang benar; lihat QUEUED/PROCESSING lalu READY; cari `denda` dan buka konteks/PDF/Word.
- [ ] Huruf besar/kecil dan spasi berbeda diterima; frasa tidak berurutan tidak dianggap cocok; angka hasil tetap sama dengan OCR.
- [ ] Filter satu item tidak menampilkan teks item lain; berkas lain tidak ikut dicari.
- [ ] Item tanpa Word tetap tersedia sebagai arsip, tercatat dalam cakupan, dan tidak menghambat pencarian item siap.
- [ ] DOC lama/gambar saja/file melampaui batas ditolak atau FAILED dengan pesan jelas; tidak ada teks parsial diam-diam.
- [ ] Koneksi putus saat unggah → Lanjutkan Unggah meneruskan sesi; finalisasi ulang tidak menambah catatan/file logis ganda.
- [ ] Ganti PDF via Perubahan Arsip → STALE, teks lama tidak muncul; unggah Word terbaru → READY.
- [ ] Ganti PDF ketika Word masih diunggah/diekstrak → finalisasi/aktivasi lama ditolak.
- [ ] Data uji dengan >20 paragraf cocok dan >3 item → Lanjutkan sampai selesai; tidak ada hasil hilang.
- [ ] Word vendor nyata 160 halaman: catat ukuran Word, ukuran XML/teks, durasi antrean/ekstraksi/pencarian; jangan menyatakan dukungan terukur sebelum uji ini.
- [ ] Regresi: registrasi sekunder tanpa tersier, upload PDF, Perubahan Arsip keamanan, Alih Media susulan, peminjaman, dan laporan tetap berfungsi.

Gunakan transaksi/data uji yang disetujui pengguna. Belum ada transaksi uji pada produksi dari pengembangan ini.

## Rollback

Pilih kembali versi deployment existing sebelum 3.31.0 (terakhir diketahui @60), tanpa menghapus data atau sheet baru. Bila menonaktifkan fitur, hapus/nonaktifkan **hanya** trigger `continueContentDocumentJobs`; pertahankan trigger reliability/backup/polling RC. Word, indeks dan catatan riwayat tetap tersedia di Drive/Sheets. Jangan menurunkan angka schema atau menghapus REL-013 untuk memaksa rollback. Pemulihan ke versi baru harus memeriksa trigger lagi.

## Rujukan teknis

- [Apps Script Utilities/unzip](https://developers.google.com/apps-script/reference/utilities/utilities#unzip(BlobSource))
- [XmlService](https://developers.google.com/apps-script/reference/xml-service/xml-service)
- [Apps Script best practices](https://developers.google.com/apps-script/guides/support/best-practices)
- [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas)
- [clasp 3: clone, akun bernama, update-deployment](https://github.com/google/clasp)
