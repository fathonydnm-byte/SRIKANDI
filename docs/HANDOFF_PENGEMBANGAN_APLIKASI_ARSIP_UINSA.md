# Handoff Pengembangan Aplikasi Kearsipan UINSA

**Dokumen operasional untuk AI agent/pengembang penerus**  
**Tanggal handoff:** 15 Agustus 2026  
**Zona waktu sistem:** `Asia/Jakarta`  
**Baseline produksi Central File:** Sprint `3.25.1` / schema `8` / channel `STABLE`  
**Baseline paket Record Center:** `1.0.0 PILOT` / schema `1` / RC-00 + RC-01  

---

## 0. Cara memakai dokumen ini

Dokumen ini adalah sumber konteks utama untuk melanjutkan pembangunan dua aplikasi Google Apps Script yang saling terhubung:

1. **Aplikasi Central File / Arsip Aktif** — dipasang sendiri oleh setiap unit pengolah.
2. **Aplikasi Record Center / Arsip Inaktif** — dipasang terpisah oleh Unit Kearsipan/Record Center.

Agent penerus wajib membaca seluruh dokumen sebelum menyentuh kode atau deployment. Jangan meminta pengguna menjelaskan ulang keputusan yang sudah tercatat di sini. Pertanyaan baru hanya diperlukan bila ada keputusan bisnis yang benar-benar belum ditetapkan atau bila kondisi aktual di Apps Script berbeda dari baseline handoff.

Gunakan urutan bukti berikut ketika ada perbedaan:

1. Data dan kode yang sedang terpasang pada project produksi.
2. Paket rilis resmi terbaru yang disebutkan dalam dokumen ini.
3. Keputusan eksplisit pengguna dalam dokumen ini.
4. Rancangan atau riset lama.

Rancangan awal siklus hidup arsip pernah mencakup arsip aktif, inaktif, statis, pemusnahan, dan penyerahan dalam satu aplikasi. Keputusan tersebut **sudah diganti**. Arsitektur yang berlaku sekarang adalah dua aplikasi federatif: Central File hanya menangani arsip aktif sampai pengajuan usul pemindahan, sedangkan Record Center menangani arsip inaktif sampai riwayat pemusnahan/penyerahan. Pengelolaan arsip statis ala SIKS tidak dibangun di aplikasi ini.

---

## 1. Ringkasan status saat handoff

### 1.1 Central File

Central File sudah berada di Sprint `3.25.1`. CF-00 sampai CF-06 telah dibangun dan dipasang pada instance pilot Bagian Umum.

- Penerimaan dan registrasi awal arsip sudah terhubung dengan Input Arsip.
- Arsip dapat diberkaskan ke berkas baru atau yang sudah ada tanpa registrasi metadata dua kali.
- Klasifikasi keamanan dan akses sudah wajib pada tingkat item.
- Alih media mendukung PDF berukuran **kurang dari 100 MB** melalui upload bertahap.
- Peminjaman arsip aktif mendukung berkas lengkap atau satu/beberapa item dari berkas yang sama.
- Out Indicator A5 portrait sudah berfungsi.
- Monitoring retensi aktif dan pembuatan draft usul pemindahan sudah berfungsi.
- Daftar Arsip Usul Pindah PDF/XLSX dan Riwayat JRA PDF sudah berfungsi.
- Pengajuan ke Record Center sudah berfungsi meskipun koneksi RC belum dikonfigurasi.
- Pengajuan terakhir yang diuji pengguna berhasil masuk ke Riwayat Pengajuan dengan status bisnis `DIAJUKAN` dan outbox `PENDING_CONFIGURATION`.

### 1.2 Record Center

Paket terpisah RC-00 + RC-01 versi `1.0.0 PILOT` sudah selesai dibuat dan diuji secara lokal, tetapi **belum dipasang/deploy pada akun Record Center**.

- RC-00 menyediakan installer instance, spreadsheet/folder terpisah, source registry, shared secret di Script Properties, audit, health check, dan backup.
- RC-01 menyediakan endpoint penerima federatif, validasi SHA-256 + HMAC, idempotensi, salinan dokumen ke Drive RC, monitor penerimaan usul, serta keputusan `DISETUJUI` atau `DITOLAK`.
- Keputusan RC masuk ke `RC_DECISION_OUTBOX` dengan status `PENDING_CONFIGURATION`; sinkronisasi balik ke Central File belum dibangun.

### 1.3 Langkah berikut yang paling tepat

Urutan lanjutan yang direkomendasikan:

1. Pasang RC-00 + RC-01 pada akun Google lain yang ditetapkan sebagai akun Record Center pilot.
2. Buat dua deployment RC: endpoint federatif dan dashboard operator.
3. Daftarkan instance Central File pilot pada RC dan masukkan endpoint/instance ID/shared secret ke installer Central File.
4. Kirim ulang outbox pengajuan `UP-2026-0002` dan pastikan berubah dari `PENDING_CONFIGURATION` menjadi `SENT` serta hanya muncul sekali di RC.
5. Uji keputusan `DISETUJUI` dan `DITOLAK`.
6. Bangun callback keputusan RC ke CF secara aman dan idempoten.
7. Setelah integrasi CF↔RC stabil, lanjut RC-02.

Jangan langsung melompat ke penataan boks atau usul musnah sebelum RC-00/RC-01 terpasang dan alur federatif lulus UAT.

---

## 2. Prinsip dan preferensi pengguna yang mengikat

### 2.1 Prioritas utama

1. **Kecepatan transaksi adalah prioritas nomor satu.** Target transaksi inti rutin adalah kurang dari 10 detik. Peminjaman setelah optimasi pernah tercatat sekitar 1,6 detik.
2. Tidak boleh terjadi duplikasi atau data parsial ketika browser lambat, callback terlambat, koneksi putus, atau tombol dicoba kembali.
3. Data harus tetap dapat diakses dari spreadsheet/Drive walaupun Web App atau kode mengalami bug.
4. Data produksi tidak boleh dihapus permanen oleh alur normal. Gunakan soft delete, status pembatalan, karantina, audit, dan bukti.
5. UI harus sederhana untuk petugas harian, tetapi guardrail server tidak boleh dikurangi.
6. Agent sebaiknya memasang perubahan melalui cloud browser setelah pengguna login. Jangan meminta operator unit mengedit kode manual jika agent mempunyai akses browser.

### 2.2 Model penerapan

Pengguna menyetujui arsitektur **hub-and-spoke/federatif**:

- Pengelola pusat menjaga satu source code dan paket rilis resmi.
- Setiap unit menggunakan email, spreadsheet, folder Drive, dan deployment sendiri.
- Data unit tidak dikumpulkan pada satu spreadsheet pusat.
- Operator unit tidak boleh mengubah kode secara manual.
- Perubahan kode didistribusikan sebagai paket rilis versi resmi.
- Record Center memakai akun, spreadsheet, Drive, Apps Script, dan deployment sendiri.
- Pilot saat ini: satu Central File Bagian Umum dan satu Record Center.

### 2.3 Pola kerja dengan pengguna

- Bila diminta “please proceed”, lanjutkan seksi/sprint berikut yang telah disepakati.
- Beri pembaruan singkat saat bekerja, terutama ketika membuka project, memperbaiki, menguji, atau membuat deployment.
- Pengguna akan login sendiri di cloud browser. Agent tidak boleh meminta atau mengetik kredensial.
- Hindari membuat transaksi uji pada data produksi tanpa izin eksplisit. Pemeriksaan produksi sebaiknya read-only, lalu pengguna menjalankan UAT bisnis.
- Jika perubahan memerlukan deployment, buat **New version**, bukan mengubah deployment ke kode head.
- Setelah deployment, verifikasi nomor rilis yang terlihat di Web App dan minta pengguna melakukan `Ctrl+Shift+R` bila perlu.

---

## 3. Scope dan nomenklatur final

### 3.1 Central File / Arsip Aktif

Scope Central File dimulai saat arsip fisik diterima dan berakhir ketika paket usul pemindahan dikirim ke Record Center.

```text
Penerimaan arsip fisik
        ↓
Registrasi metadata sekali
        ↓
Tanda Terima Penyerahan Arsip
        ↓
Pemberkasan ke berkas baru/lama
        ↓
Temu kembali / alih media / edit / koreksi / peminjaman aktif
        ↓
Retensi aktif habis
        ↓
Draft usul pemindahan + snapshot JRA
        ↓
Daftar Arsip Usul Pindah PDF/XLSX + Riwayat JRA PDF
        ↓
Upload Nota Dinas berdisposisi
        ↓
Ajukan ke Record Center
        ↓
END SCOPE CENTRAL FILE
```

Nomenklatur menu yang berlaku:

- `Penerimaan Arsip`
- `Input Arsip`
- `Alih Media`
- `Edit Arsip`
- `Koreksi & Pembatalan`
- `Cari Arsip`
- `Cetak Lidah Folder`
- `Usul Pemindahan`
- `Peminjaman`
- `Instalasi & Reliability` melalui menu spreadsheet

Nama `Penghapusan` pada UI sudah diganti menjadi **Koreksi & Pembatalan**. Nama `Retensi` sudah diganti menjadi **Usul Pemindahan**.

### 3.2 Record Center / Arsip Inaktif

Scope Record Center dimulai dari penerimaan paket usul pindah dan berakhir setelah arsip inaktif dimusnahkan atau diserahkan serta bukti administrasinya diregistrasi.

```text
Paket usul pindah diterima dari Central File
        ↓
Verifikasi dokumen + pencocokan fisik
        ↓
DISETUJUI / DITOLAK DENGAN ALASAN
        ↓
Penerimaan fisik di ruang transit
        ↓
Upload BA Pemindahan (opsional, boleh menyusul)
        ↓
Penataan ke boks/rak/ruang/folder
        ↓
Nomor definitif arsip inaktif + lokasi simpan
        ↓
Peminjaman arsip inaktif per berkas
        ↓
Monitoring batas retensi inaktif H-14
        ↓
Buat Usul Musnah / Buat Usul Serah
        ↓
Riwayat Pemusnahan / Riwayat Penyerahan + bukti
        ↓
END SCOPE RECORD CENTER
```

### 3.3 Yang sengaja tidak dibangun

- Tidak membangun pengelolaan arsip statis/SIKS di aplikasi Central File atau Record Center ini.
- Tidak membangun pengolahan khazanah statis, preservasi statis, layanan ruang baca statis, atau JIKN.
- Sistem tidak membuat draft Nota Dinas permohonan pemindahan; surat dibuat/diadministrasikan manual karena nomor surat dan disposisi mengikuti tata naskah dinas.
- Sistem tidak membuat Berita Acara pemindahan; hanya menyediakan upload opsional setelah tersedia.
- Central File tidak pernah mengubah fase arsip menjadi `INAKTIF`.
- Tidak ada pemusnahan otomatis hanya karena JRA berakhir.

### 3.4 Dasar istilah

- Gunakan **Penerimaan Arsip** dan **Tanda Terima Penyerahan Arsip** untuk serah terima fisik harian arsip aktif.
- Jangan memakai istilah “Akuisisi Arsip” pada transaksi tersebut; akuisisi lebih tepat untuk arsip statis oleh lembaga kearsipan.
- Gunakan **Usul Pemindahan**, bukan “langsung pindah” atau “aktif menjadi inaktif” pada aplikasi unit.
- `DIAJUKAN`, `DISETUJUI`, `DITOLAK`, `DITERIMA RECORD CENTER`, `DIBATALKAN`, dan `TERTATA INAKTIF` adalah status proses, bukan seluruh fase hukum arsip.

---

## 4. Rujukan regulasi dan kepatuhan yang pernah dipakai

Rancangan terdahulu meneliti fungsi SRIKANDI/SIKS dan rujukan resmi berikut. Agent penerus harus melakukan verifikasi versi terbaru apabila membuat keputusan hukum baru; jangan menganggap tampilan aplikasi pemerintah sebagai peraturan.

- Undang-Undang Nomor 43 Tahun 2009 tentang Kearsipan.
- PP Nomor 28 Tahun 2012 tentang Pelaksanaan UU 43/2009.
- Peraturan ANRI Nomor 4 Tahun 2021 tentang Pedoman Penerapan SRIKANDI.
- Keputusan MenPANRB Nomor 679 Tahun 2020 tentang aplikasi umum bidang kearsipan dinamis.
- Peraturan ANRI Nomor 9 Tahun 2018 tentang Pemeliharaan Arsip Dinamis.
- Perka ANRI Nomor 24 Tahun 2011 tentang Pedoman Penyelenggaraan Kearsipan di Lingkungan Perguruan Tinggi.
- Perka ANRI Nomor 37 Tahun 2016 tentang Pedoman Penyusutan Arsip.
- SOP ANRI Nomor 55 Tahun 2023 mengenai persetujuan/pertimbangan pemusnahan.
- SOP ANRI Nomor 53 Tahun 2023 mengenai penyerahan arsip statis.
- Dokumen resmi pengembangan SRIKANDI 2024 dan uji coba SIKS 2024 sebagai rujukan fungsi, bukan satu-satunya dasar hukum.

Guardrail kepatuhan yang tidak boleh dihapus:

1. JRA menghasilkan kandidat/tanda waktu, bukan keputusan otomatis untuk memusnahkan atau menyerahkan.
2. Keputusan penting memerlukan tindakan manusia, alasan, bukti, audit, dan versi daftar yang tetap.
3. Dokumen/snapshot yang sudah dipakai untuk usul tidak boleh diam-diam berubah mengikuti metadata sumber.
4. Koreksi atau pembatalan tidak menghapus sejarah.
5. Kepemilikan/custody Central File dan Record Center harus jelas serta tidak dicampur dalam satu database produksi.

---

## 5. Arsitektur teknis

### 5.1 Platform

- Google Apps Script V8.
- Google Sheets sebagai database tabular dan laporan manusia-terbaca.
- Google Drive sebagai penyimpanan PDF, XLSX, paket JSON, bukti, backup, dan karantina.
- HTML Service untuk Web App.
- Central File mengaktifkan Advanced Sheets API v4 untuk jalur batch berkecepatan tinggi.
- Tidak ada hosting eksternal dan tidak ada database eksternal pada tahap pilot.

### 5.2 Arsitektur federatif

```text
┌──────────────────────────────┐
│ Central File — Unit A        │
│ akun/sheet/Drive/deploy A    │──┐
└──────────────────────────────┘  │  paket bertanda tangan
                                  │  SHA-256 + HMAC + event ID
┌──────────────────────────────┐  │
│ Central File — Unit B        │──┼──────► Record Center
│ akun/sheet/Drive/deploy B    │  │        akun/sheet/Drive/deploy RC
└──────────────────────────────┘  │
                                  │        keputusan/callback
┌──────────────────────────────┐  │        ◄─────────────────
│ Central File — Unit N        │──┘
│ akun/sheet/Drive/deploy N    │
└──────────────────────────────┘
```

Setiap Central File menyimpan data sendiri. Record Center hanya menerima snapshot usul dan file yang memang dikirim. RC menyalin file yang diterima ke Drive-nya sendiri agar riwayat tidak bergantung pada perubahan/akses Drive unit pengusul.

### 5.3 Pola engineering wajib

- ID stabil/UUID untuk objek, transaksi, request, event, paket, dan outbox.
- `LockService` untuk operasi yang menentukan nomor atau mengubah beberapa tabel terkait.
- Batch read/write untuk mengurangi perjalanan ke Spreadsheet.
- Idempotency key untuk penyimpanan, upload finalization, pembuatan dokumen, dan pengiriman event.
- Upload resumable 512 KB per chunk untuk file besar.
- Commit metadata hanya setelah file Drive selesai dan tervalidasi.
- Retry jaringan harus meneruskan transaksi yang sama, bukan membuat objek baru.
- Laporan adalah proyeksi dan harus bisa dibangun ulang dari database kanonik.
- Migrasi harus non-destruktif, tercatat, dan idempoten.
- Secret tidak disimpan di sheet, source, ZIP, log, atau payload mentah; gunakan Script Properties.
- Semua waktu server memakai `Asia/Jakarta` dan ISO timestamp untuk data teknis.

### 5.4 Batas realistis Google Apps Script/Sheets

- Cocok untuk pilot dan unit kerja dengan pengguna bersamaan rendah–menengah.
- Proses besar harus dipecah karena batas waktu eksekusi Apps Script.
- Hindari formula masif, pemindaian seluruh sheet berulang, dan satu call per baris.
- Pertimbangkan backend database terkelola bila volume/konkurensi menyebabkan batch rutin melampaui target, pencarian lintas ratusan ribu rekod diperlukan, atau kontrol akses per rekod menjadi wajib.
- Data tetap transparan dan dapat diekspor dari Sheets/Drive, sehingga kegagalan Web App tidak membuat arsip tidak dapat diakses.

---

## 6. Instance Central File pilot yang aktif

### 6.1 Identitas dan URL

- Unit: **Bagian Umum Kantor Pusat – Biro AUPK**.
- Akun administrator yang dipakai: `bag.umum@uinsa.ac.id`.
- Apps Script project:
  `https://script.google.com/u/0/home/projects/1_Z8ZfkDU1lIGuI5hlOCp4eeNaXiFR-3zJjO8XL60lSeIotbcaKljRLvb/edit`
- Spreadsheet:
  `https://docs.google.com/spreadsheets/d/1nabA1QfgQd2u2h4JxjJZCJW0-e5KI5HsUhwFyQLIhXk/edit`
- Web App aktif:
  `https://script.google.com/a/macros/uinsa.ac.id/s/AKfycby61nrRsmp5SyiTnySxIiHrf_DDAOdmqVJnNPwwq2BBY9EmCly_sTjR-9ZhLb3TRClv/exec`
- Deployment ID:
  `AKfycby61nrRsmp5SyiTnySxIiHrf_DDAOdmqVJnNPwwq2BBY9EmCly_sTjR-9ZhLb3TRClv`
- Versi deployment terakhir: **41**.
- Rilis terlihat pada Web App: `3.25.1`.
- Schema: `8`.
- Instance ID yang pernah teramati:
  `INS-6d92f552-1d7e-4935-a4e5-a04161ef6a75`.

URL di atas adalah informasi operasional privat untuk handoff. Jangan mempublikasikannya dan jangan menambahkan shared secret ke dokumen ini.

### 6.2 Kondisi UAT terakhir

- `UP-2026-0001`: `DIBATALKAN`.
- `UP-2026-0002`: berhasil diajukan.
- Status bisnis `UP-2026-0002`: `DIAJUKAN`.
- Status teknis outbox: `PENDING_CONFIGURATION` karena aplikasi RC belum dikonfigurasi.
- Berkas terkait menampilkan status diajukan usul pindah.
- Tiga dokumen CF-05 berhasil dibuat: Daftar Arsip Usul Pindah PDF, Daftar Arsip Usul Pindah XLSX, dan Riwayat JRA PDF.

### 6.3 Paket kode Central File

- Direktori sumber lokal saat handoff:
  `/workspace/scratch/e254d26ae452/sprint3240/appscript-sprint2`
- Paket rilis:
  `UINSA_Arsip_Aktif_Sprint_3.25.1_CF06_Hotfix.zip`
- SHA-256:
  `64cd0c4abe64a3a2467e20e12b3477a3f4236b69cff28043ba52678f38c7b059`

File Apps Script/HTML dalam baseline:

```text
AdminSetup.html
CentralFileMetadataService.gs
Client.html
Code.gs
Config.gs
DeletionService.gs
EditService.gs
Index.html
ItemService.gs
LabelLogo.html
LabelPrint.html
LabelService.gs
LoanService.gs
MediaService.gs
NumberingService.gs
OutIndicatorPrint.html
README.md
ReceiptFilingService.gs
ReceiptPrint.html
ReceiptService.gs
ReliabilityService.gs
ReportService.gs
Repository.gs
RetentionDocumentService.gs
RetentionService.gs
SearchService.gs
Services.gs
Styles.html
TransferSubmissionService.gs
UploadService.gs
appsscript.json
```

`ReceiptPrint` harus dibuat sebagai file HTML, bukan `.gs`. Kesalahan tipe file ini sebelumnya menghasilkan `Unexpected token '<'`.

---

## 7. Database dan folder Central File

### 7.1 Sheet kanonik dan operasional

Sheet utama yang dipakai baseline:

- `DB_BERKAS`
- `DB_ITEM`
- `MASTER_KLASIFIKASI`
- `PENERIMAAN_ARSIP`
- `PENERIMAAN_ITEM`
- `MASTER_PEGAWAI`
- `PEMINJAMAN`
- `SETTINGS`
- `AUDIT_LOG` dan partisi audit tahunan bila dibuat reliability layer
- `RIWAYAT_NOMOR`
- `LOG_CETAK_PENERIMAAN`
- `LOG_CETAK_LIDAH`
- `LOG_CETAK_OUT_INDICATOR`
- `USUL_PINDAH`
- `USUL_PINDAH_DETAIL`
- `USUL_PINDAH_ITEM`
- `OUTBOX_RECORD_CENTER`
- `SYSTEM_MIGRATIONS`
- `SYSTEM_BACKUPS`
- `SYSTEM_JOBS`
- `SYSTEM_JOB_QUEUE`
- `SYSTEM_HEALTH_LOG`
- `SYSTEM_QUARANTINE`

Laporan turunan:

- `DAFTAR BERKAS`
- `DAFTAR ISI BERKAS`

Jangan menganggap laporan sebagai sumber kanonik. Jika laporan rusak, bangun ulang dari `DB_BERKAS` dan `DB_ITEM`.

### 7.2 Folder penting

Installer membuat/mengikat folder unit, termasuk:

- folder induk unit;
- `01 ARSIP AKTIF`;
- `90 KARANTINA APLIKASI`;
- `99 BACKUP APLIKASI`;
- folder bukti Penerimaan Arsip;
- folder bukti peminjaman;
- folder bukti Koreksi & Pembatalan;
- folder dokumen usul pemindahan/paket federasi sesuai implementasi.

File arsip yang diganti atau objek yang dibatalkan tidak langsung dipindahkan ke Trash. Gunakan karantina beserta metadata asal, pelaku, waktu, alasan, dan relasi objek. Trash hanya boleh dipakai untuk file sementara/diagnostik/rollback gagal atau reset pilot yang secara eksplisit diizinkan.

### 7.3 Manifest Apps Script Central File

Manifest baseline memakai:

- V8 runtime;
- Advanced Sheets API v4;
- scope spreadsheets;
- Drive;
- script trigger (`script.scriptapp`);
- container UI;
- external request;
- user email.

Jangan menghapus Advanced Sheets API tanpa mengganti jalur batch pada peminjaman dan menguji regresinya.

---

## 8. Riwayat pengembangan Central File per sprint

Bagian ini menjelaskan alasan desain, bukan hanya nomor rilis. Agent penerus harus mempertahankan perilaku yang sudah lulus UAT.

### Fondasi awal sebelum Sprint 3.4

Arsip paket paling awal tidak lagi tersedia lengkap pada workspace handoff, tetapi fondasi fungsionalnya masih dapat direkonstruksi dari database dan modul yang bertahan sampai baseline. Aplikasi bermula sebagai Web App Google Apps Script yang menggantikan pencatatan arsip aktif langsung pada laporan spreadsheet dengan model database yang lebih aman.

Fondasi tersebut mencakup:

- register `DB_BERKAS` dan `DB_ITEM`;
- master klasifikasi/JRA;
- pembuatan berkas dan input item arsip;
- nomor berkas dan nomor item definitif;
- lokasi fisik kabinet/laci/folder;
- folder Drive per berkas dan penamaan PDF;
- laporan `DAFTAR BERKAS` dan `DAFTAR ISI BERKAS`;
- dashboard dan bootstrap Web App;
- pemisahan data kanonik dengan laporan turunan;
- Audit Log dasar;
- perhitungan kurun waktu dan retensi dari item.

Sprint 3.4 menjadi titik awal riwayat rilis yang terdokumentasi rinci. Jangan menyimpulkan bahwa fitur fondasi di atas boleh dihapus hanya karena tidak memiliki seksi sprint tersendiri.

### Sprint 3.4 — Input langsung tanpa preview nomor

- Menghapus layar preview penomoran.
- Satu klik `Simpan Item` langsung memulai transaksi server.
- Nomor definitif dihitung dari data terbaru di dalam lock/transaksi.
- Memperbaiki field wajib tersembunyi yang menghalangi penyimpanan item kedua.

### Sprint 3.5 — Total lembar per berkas

- Menambah `Jumlah (Lembar)` pada `DAFTAR BERKAS`.
- Nilai dihitung dari total `JUMLAH_HALAMAN` item aktif dalam berkas.

### Sprint 3.6 dan 3.7 — Migrasi laporan aman

- Posisi kolom tidak lagi hard-coded ke `H11`.
- Sistem mencari header `Jumlah (Item Arsip)` dan menambah `Jumlah (Lembar)` di sebelahnya.
- Menyesuaikan struktur asli laporan: header merge baris 10–11, nomor kolom baris 12, data mulai baris 13.
- Menambah reset data pilot terkontrol.

### Sprint 3.8 — Penghapusan terkendali

- Menambah penghapusan satu item atau seluruh berkas dengan alasan wajib.
- Bukti disposisi opsional.
- Validasi status pinjam.
- Soft delete, audit, dan penomoran ulang.
- Nomenklatur UI kemudian diubah menjadi `Koreksi & Pembatalan`.

### Sprint 3.9–3.9.2 — Edit dan stabilisasi upload

- Edit uraian, halaman, tanggal, tingkat perkembangan, dan PDF tanpa membuat item baru.
- Alasan dan audit wajib.
- Memperbaiki HTTP 500 ketika form tanpa file opsional dikirim sebagai multipart.
- Menghapus pola menyalin file lewat `DataTransfer`; elemen file asli dipindah ke antrean upload.

### Sprint 3.10–3.11 — Resumable upload

- Upload file dibagi 512 KB.
- Drive resumable upload dapat dilanjutkan dari byte terakhir.
- Database baru dikomit setelah Drive mengonfirmasi seluruh byte.
- Bukti pembatalan dan PDF pengganti Edit menggunakan mekanisme sama.
- Folder bukti khusus dan diagnostik upload ditambahkan.

### Sprint 3.12–3.12.1 — Alih Media opsional

- PDF alih media tidak wajib saat Input Arsip.
- Item tanpa PDF tetap disimpan dengan status `BELUM DIUNGGAH`.
- Menu `Alih Media` melengkapi PDF kemudian.
- Laporan otomatis diperbarui setelah upload susulan.

### Sprint 3.13 — Optimasi Input Arsip

- Pembaruan nomor ditulis per sheet secara batch.
- Item tidak ditulis ulang setelah baris dibuat.
- Posisi kolom laporan di-cache setelah diverifikasi.
- Form item berikutnya dilepas sebelum refresh dashboard selesai.
- Loading menampilkan tahap proses agar tidak tampak macet.

### Sprint 3.14 — Cari Arsip

- Mencari nomor surat utama/alternatif, uraian, judul berkas, klasifikasi, lokasi, dan nama file.
- Filter tanggal, tingkat perkembangan, kode klasifikasi, dan status alih media.
- Hanya data aktif; maksimal 200 hasil paling relevan.
- Akses ke PDF dan folder Drive.

### Sprint 3.15–3.15.1 — Cetak Lidah Folder

- PDF A4, 2 kolom × 7 baris, label 70 × 30 mm.
- Posisi awal 1–14 untuk memakai kembali kertas sebagian terpakai.
- Pilih banyak berkas dan preview.
- Snapshot cetak dan penanda `Perlu cetak ulang` setelah metadata berubah.
- Logo UINSA resolusi tinggi menggantikan logo lama.

### Sprint 3.16 — Retensi aktif awal

- Memperkenalkan perhitungan retensi aktif.
- Jalur pemindahan langsung dari versi lama kemudian dinonaktifkan oleh CF-04.

### Sprint 3.17 — Peminjaman Arsip Aktif

- Peminjaman satu berkas atau satu item.
- Mencegah pinjaman ganda/benturan objek.
- Jumlah lembar otomatis, data peminjam, bukti opsional, keterlambatan, pengembalian.

### Sprint 3.17.1–3.17.3 — Kecepatan dan race condition peminjaman

- Membaca `PEMINJAMAN`, `DB_BERKAS`, `DB_ITEM` masing-masing satu kali.
- Refresh UI tidak lagi menahan konfirmasi transaksi.
- Jalur cepat memakai satu `batchGet` dan satu `batchUpdate` Google Sheets API v4.
- SpreadsheetApp tetap sebagai fallback.
- Durasi lock/baca/tulis ditampilkan bila transaksi ≥10 detik.
- Memperbaiki race condition `loadBootstrap()` yang menghapus `state.loanOptions` setelah tabel tampil.
- Dropdown item dan `Catat Kembali` dapat memulihkan state otomatis.
- Hasil UAT pengguna setelah optimasi sekitar 1,6 detik.

### Sprint 3.18 — Penerimaan Arsip

- Menu `Penerimaan Arsip` dan dokumen `Tanda Terima Penyerahan Arsip`.
- Satu penerimaan memuat banyak item fisik; satu baris = satu item arsip.
- Penyerah dari Master Pegawai; tambah pegawai langsung dari form.
- Penerima memiliki default dari Settings tetapi dapat diedit.
- Nomor `TRM-TAHUN-XXXX` reset per tahun; ID internal UUID lintas tahun.
- Waktu server dikunci setelah simpan.
- Bukti tertandatangani PDF opsional maksimal 10 MB dan dapat menyusul.
- Edit sebelum bukti; setelah bukti, koreksi harus lewat pembatalan dan tanda terima baru.
- Pembatalan mewajibkan alasan; bukti pembatalan PDF opsional maksimal 10 MB.
- Cetak ulang diberi penanda; tanda terima batal diberi watermark.

### Sprint 3.18.1 — Perbaikan A4 dan desain receipt

- Memperbaiki bingkai/garis bawah yang terpotong.
- Memastikan ukuran A4, safe print area, bingkai tertutup.
- Desain hijau–emas lebih artsy, panel identitas, tabel berselang, ringkasan, dan area tanda tangan.
- Item pendek: dua salinan pada satu A4 dengan garis potong.
- Item panjang: salinan dipaginasi ke halaman sendiri tanpa memotong baris.

### Sprint 3.18.2 — Penyimpanan receipt cepat dan idempoten

- Migrasi empat sheet tidak lagi dijalankan pada setiap klik simpan.
- Penerimaan, item, dan Audit Log dibaca/ditulis secara batch.
- Request ID idempoten mencegah tanda terima ganda.
- Browser memiliki batas tunggu dan recovery ketika callback terlambat.

### Sprint 3.18.3–3.18.3.1 — Reliability dan multi-unit

- Konfigurasi instance dipindahkan dari source ke Script Properties/Settings.
- Installer unit, registry migrasi, health check, backup metadata harian, backup penuh bertahap, manifest Drive, audit tahunan, karantina file, dan generator template distribusi bersih.
- Menambah permission `script.container.ui` agar dialog installer dari spreadsheet dapat dibuka.
- Model hub-and-spoke mulai menjadi arsitektur resmi.

### Sprint 3.19 — Integrasi Penerimaan dan Input Arsip

- Metadata diregistrasi satu kali pada Penerimaan.
- `ARSIP_ID` menjadi identitas sumber stabil; `ITEM_ID` tetap identitas definitif per riwayat pemberkasan.
- Antrean item penerimaan yang belum diberkaskan muncul di Input Arsip.
- Checkbox dapat memilih sampai 100 item lintas tanda terima untuk satu berkas tujuan.
- Dapat masuk berkas lama atau membuat berkas baru.
- Nomor surat alternatif opsional; tanggal naskah wajib.
- Bukti tanda tangan boleh menyusul.
- Item yang sudah diberkaskan tetap tersimpan pada riwayat penerimaan, tetapi tidak masuk ulang ke antrean.
- Pembatalan tanda terima ditolak jika item masih berada dalam berkas. Harus memakai `Koreksi & Pembatalan` terlebih dahulu.
- Penghapusan item definitif mengembalikan sumber ke antrean tanpa menghapus riwayat `DB_ITEM` lama.
- PDF tanda terima tetap ringkas: No., uraian, halaman, tingkat perkembangan, kondisi.

### Sprint 3.20 — CF-00 dan CF-01

**CF-00 — Baseline dan hardening pilot**

- Menetapkan baseline Central File, backup, health check, audit, dan migrasi.
- Memastikan perubahan lanjut tidak merusak modul Penerimaan/Input.

**CF-01 — Metadata Central File**

- Menambah pencipta/unit pencipta, keamanan, kategori vital/terjaga, media sumber, born digital, dan status verifikasi.
- Backfill tidak menghapus data lama.
- Item lama tanpa file → `TEKSTUAL` + tidak ada alih media.
- Item lama dengan file → `TEKSTUAL` + `ALIH MEDIA`.
- Rekod lama ditandai perlu verifikasi sebelum dipakai untuk usul.

### Sprint 3.21–3.21.1 — CF-02 Klasifikasi Keamanan

- Klasifikasi keamanan dan akses wajib di tingkat item sejak Penerimaan maupun Input Manual.
- Nilai: `BIASA/TERBUKA`, `TERBATAS`, `RAHASIA`, `SANGAT RAHASIA`.
- Item dari Penerimaan membawa nilai ke `DB_ITEM` tanpa input ulang.
- Klasifikasi berkas adalah tingkat paling ketat dari item aktif.
- Menambah item yang lebih rendah tidak menurunkan klasifikasi berkas.
- Laporan `DAFTAR ISI BERKAS` diperbaiki agar menampilkan klasifikasi item; item lama dapat fallback ke berkas lalu `BIASA/TERBUKA`.
- `repairReports()` hanya diperlukan pada pembaruan laporan 3.21.1; jangan menjalankannya rutin tanpa kebutuhan.

### Sprint 3.22.0 — CF-03 Peminjaman dan Out Indicator

- Satu transaksi dapat meminjam satu berkas, satu item, atau beberapa item dari berkas yang sama.
- Item multi-select berbagi `LOAN_GROUP_ID`.
- Satu berkas tidak dapat dipinjam jika salah satu item masih dipinjam.
- Satu item tidak dapat dipinjam jika berkas penuh sedang dipinjam.
- Bukti persetujuan opsional PDF/JPG/JPEG/PNG maksimal 25 MB.
- Out Indicator A5 portrait dibuat setelah commit utama agar tidak memperlambat transaksi.
- Lokasi asal disimpan sebagai snapshot.
- Cetak ulang tercatat pada `LOG_CETAK_OUT_INDICATOR` dan Audit Log.
- Pengguna menguji bahwa out indicator berhasil, item yang keluar tidak bisa dipinjam ulang, dan berkas yang memiliki item keluar tidak bisa dipinjam penuh.

### Sprint 3.23.0 — CF-04 Monitoring Retensi dan Draft Usul

- Menu `Retensi` menjadi `Usul Pemindahan`.
- Ringkasan `Masih Aktif`, `H-7`, `Habis Aktif`, dan `Dalam Usul`.
- Batas aktif dihitung dari tanggal acuan retensi; masih aktif sampai akhir tanggal, habis mulai hari berikutnya.
- Kandidat hanya dapat dicentang jika batas aktif lewat, metadata terverifikasi, dan tidak ada pinjaman aktif.
- Satu draft maksimal 200 berkas.
- Nomor `UP-TAHUN-XXXX`.
- Snapshot per berkas menyimpan jumlah item, keamanan, kategori, retensi, nasib akhir, tanggal acuan, dan batas aktif.
- Berkas tetap fase aktif. Endpoint lama untuk langsung menandai pindah ditolak.
- Draft dapat dibatalkan dengan alasan wajib dan riwayat tetap disimpan.

### Sprint 3.23.1 — Hotfix klasifikasi pada upload

- Memperbaiki bug saat upload PDF dari Input Manual yang menghilangkan `securityClassification` dari sesi upload.
- Nilai yang terlihat sudah dipilih tetapi server menganggap kosong.
- Metadata kini dipertahankan sejak pembuatan sesi sampai finalisasi.

### Sprint 3.23.2 — Alih Media <100 MB

- Batas PDF arsip/alih media dinaikkan dari kurang dari 25 MB menjadi **kurang dari 100 MB**.
- Berlaku pada Input Manual, menu Alih Media, dan PDF pengganti lewat Edit.
- Tetap memakai chunk 512 KB.
- Batas bukti Peminjaman/Koreksi/Penerimaan tidak ikut berubah.

### Sprint 3.24.0–3.24.1 — CF-05 Dokumen Usul

- Dari frozen snapshot menghasilkan:
  1. Daftar Arsip Usul Pindah PDF.
  2. Daftar Arsip Usul Pindah XLSX.
  3. Riwayat JRA PDF.
- PDF/XLSX memuat Daftar Berkas dan Daftar Isi Berkas, termasuk snapshot link alih media item.
- Pembuatan idempoten; klik ulang memakai file yang sama.
- Menambah `USUL_PINDAH_ITEM` dan referensi dokumen melalui migrasi `REL-009`.
- Draft lama tanpa snapshot item harus dibatalkan lalu dibuat ulang; sejarah tidak dihapus.
- 3.24.1 menambah verifikasi metadata rekod lama dari UI agar checkbox kandidat dapat aktif tanpa melemahkan guardrail.

### Sprint 3.25.0–3.25.1 — CF-06 Pengajuan ke Record Center

- Draft harus memiliki tiga keluaran CF-05.
- Petugas mengunggah Nota Dinas Permohonan Pemindahan Arsip Inaktif yang sudah mendapat disposisi, PDF **kurang dari 10 MB**.
- XLSX dan Riwayat JRA tidak diunggah ulang; sistem memakai frozen file CF-05.
- Sistem membuat paket JSON, SHA-256, dan outbox federatif.
- Status bisnis menjadi `DIAJUKAN`.
- Status teknis: `PENDING_CONFIGURATION`, `PENDING`, `SENT`, atau `FAILED`.
- Jika RC belum dipasang, pengajuan tetap sah/tersimpan dan dapat dikirim ulang.
- Retry harus idempoten.
- Migrasi `REL-010`, schema `8`.

Hotfix 3.25.1 memperbaiki `ReferenceError: recordCenterEmailValue is not defined` pada validasi pengajuan/retry. Bug tersebut **tidak normal** dan sudah diperbaiki. Paket dan deployment produksi sekarang menggunakan 3.25.1.

---

## 9. Migrasi Central File

Migrasi reliability yang sudah dikenal:

| Migrasi | Schema | Tujuan |
|---|---:|---|
| `REL-001` | 1 | Registry migrasi, backup, job, health, karantina |
| `REL-002` | 1 | Konfigurasi instance keluar dari source code |
| `REL-003` | 1 | Backup terjadwal, audit tahunan, karantina |
| `REL-004` | 2 | Integrasi Penerimaan dengan pemberkasan |
| `REL-005` | 3 | Metadata pencipta, keamanan, vital/terjaga, media sumber CF |
| `REL-006` | 4 | Klasifikasi keamanan wajib sejak Penerimaan/Input |
| `REL-007` | 5 | Loan group, snapshot lokasi, log Out Indicator |
| `REL-008` | 6 | Kandidat retensi dan draft usul CF-04 |
| `REL-009` | 7 | Snapshot item dan dokumen CF-05 |
| `REL-010` | 8 | Nota Dinas, paket, dan outbox federatif CF-06 |

Aturan migrasi:

- Append kolom/sheet; jangan menggeser atau menghapus header lama.
- Setiap migrasi hanya dijalankan sekali dan tercatat `SUCCESS`.
- Backfill harus konservatif dan memberi status `PERLU VERIFIKASI` bila informasi tidak pasti.
- Jalankan backup metadata sebelum migrasi material.
- Uji jumlah rekod sebelum/sesudah.
- Installer harus aman dijalankan ulang.

---

## 10. Spesifikasi modul Central File

### 10.1 Penerimaan Arsip

Tujuan: bukti bahwa arsip fisik telah berpindah dari pegawai internal UINSA ke petugas, sekaligus registrasi awal metadata agar tidak perlu input dua kali.

Aturan bisnis:

- Penyerah hanya pegawai internal UINSA.
- Dipilih dari `MASTER_PEGAWAI` dengan nama dan unit kerja.
- Pegawai baru ditambah langsung dari form; tidak perlu menu master terpisah.
- Penerima: nama dan unit dapat diedit, dengan default Settings.
- Satu baris = satu item arsip.
- Satu tanda terima dapat memuat banyak item.
- Tanggal/jam penerimaan dari server dan tidak dapat diubah setelah simpan.
- Catatan umum penerimaan tersedia.
- Arsip yang diterima dianggap lolos pemeriksaan awal dan akan diberkaskan.

Metadata registrasi sumber harus cukup untuk dipakai Input Arsip. Keputusan yang sudah ditetapkan:

- nomor surat utama dapat digunakan sesuai form;
- nomor surat alternatif/vendor opsional;
- tanggal naskah wajib;
- uraian informasi wajib;
- jumlah halaman wajib;
- tingkat perkembangan `ASLI` atau `COPY`;
- kondisi `Baik`, `Rusak ringan`, `Rusak sedang`, `Rusak berat`;
- klasifikasi keamanan dan akses wajib;
- catatan opsional;
- alih media dapat menyusul.

Tanda terima tetap hanya menampilkan:

- No.;
- uraian informasi arsip;
- halaman;
- tingkat perkembangan;
- kondisi.

Bukti tanda tangan:

- PDF saja;
- maksimal 10 MB;
- opsional;
- dapat diunggah kemudian;
- setelah tersedia, tanda terima terkunci.

Pembatalan:

- alasan wajib;
- bukti PDF opsional maksimal 10 MB;
- bukti lama tetap disimpan;
- jika item sudah diberkaskan, pembatalan langsung ditolak sampai item dikeluarkan melalui `Koreksi & Pembatalan`.

### 10.2 Input Arsip dan pemberkasan

Dua jalur:

1. pilih item terdaftar dari Penerimaan Arsip;
2. Input Manual untuk arsip lama/migrasi.

Pemberkasan:

- pilih satu atau banyak item penerimaan dengan checkbox;
- maksimal 100 item per transaksi;
- semua masuk ke satu berkas tujuan;
- pilih berkas yang ada atau buat berkas baru;
- jika membuat berkas baru, metadata berkas diisi sekali;
- setelah simpan, berkas induk tetap terpilih agar item berikutnya cepat dimasukkan;
- nomor definitif dihitung server berdasarkan data terbaru;
- jangan tampilkan preview nomor yang dapat menjadi stale.

Relasi sumber:

- `ARSIP_ID` tetap stabil;
- item definitif memiliki `ITEM_ID`;
- snapshot penerimaan tetap ada walaupun uraian final diperbaiki;
- item yang sudah diberkaskan tidak tampil lagi pada antrean;
- item yang dibatalkan/dikeluarkan dapat kembali ke antrean sesuai aturan.

### 10.3 Klasifikasi keamanan dan kategori

Keamanan wajib per item:

- `BIASA/TERBUKA`
- `TERBATAS`
- `RAHASIA`
- `SANGAT RAHASIA`

Berkas mengikuti nilai item paling ketat. Nilai ini harus terbawa ke snapshot usul pindah dan kelak menjadi metadata arsip inaktif.

Kategori arsip yang disiapkan untuk lintas fase:

- `VITAL`
- `TERJAGA`
- `BIASA`

Jangan mencampur kategori dengan klasifikasi keamanan.

### 10.4 Alih Media

- PDF opsional.
- Batas file arsip/alih media: **kurang dari 100 MB**, bukan ≤100 MB.
- Chunk 512 KB.
- Bisa dilengkapi melalui menu Alih Media.
- Penggantian PDF dilakukan lewat Edit Arsip.
- File lama dikarantina setelah file baru berhasil.
- Born digital boleh tidak memiliki fisik; beri penanda born digital dan link pada kolom alih media.
- Finalisasi retry tidak boleh membuat file atau item ganda.

### 10.5 Cari Arsip

Cari berdasarkan nomor surat, nomor alternatif, uraian, judul berkas, kode/uraian klasifikasi, lokasi, nama file, nomor definitif. Filter tanggal, perkembangan, klasifikasi, dan status alih media. Hasil hanya data aktif dan maksimal 200.

### 10.6 Edit dan Koreksi & Pembatalan

- Identitas stabil tidak berubah.
- Alasan minimal 10 karakter untuk edit material/pembatalan.
- Simpan sebelum/sesudah pada Audit Log.
- Tidak boleh mengubah atau membatalkan objek yang sedang dipinjam.
- Item terakhir dalam berkas tidak dihapus sendiri; gunakan pembatalan seluruh berkas.
- Mengubah tanggal dapat memicu penomoran/kronologi/laporan/retensi ulang.
- File lama dipindahkan ke karantina, bukan Trash.

### 10.7 Peminjaman Arsip Aktif

Objek:

- satu berkas lengkap; atau
- satu/beberapa item dari berkas yang sama.

Data peminjam:

- nama;
- NIP/NIK opsional;
- unit kerja;
- WhatsApp opsional;
- keperluan;
- tanggal pinjam;
- tanggal wajib kembali;
- jumlah halaman/item;
- bukti persetujuan opsional;
- catatan.

Guardrail:

- tidak ada pinjaman ganda objek sama;
- berkas penuh ditolak jika satu item keluar;
- item ditolak jika berkas penuh keluar;
- transaksi grup dikembalikan bersama;
- status berkas dihitung dari semua pinjaman aktif, bukan transaksi terakhir;
- arsip dipinjam memblokir edit, pembatalan, dan usul pindah.

Out Indicator:

- A5 portrait;
- identitas peminjam, jadwal, lokasi asal, daftar objek;
- daftar panjang lanjut halaman berikut;
- dibuat setelah commit transaksi inti;
- cetak ulang tercatat.

### 10.8 Usul Pemindahan

Kandidat:

- batas aktif sudah lewat;
- metadata terverifikasi;
- tidak sedang dipinjam;
- tidak berada di usul lain;
- status bukan soft-deleted/batal.

Draft:

- maksimal 200 berkas;
- nomor `UP-TAHUN-XXXX`;
- snapshot metadata/JRA saat usul dibuat;
- tetap arsip aktif;
- pembatalan alasan wajib.

Dokumen CF-05:

- Daftar Arsip Usul Pindah PDF;
- Daftar Arsip Usul Pindah XLSX dengan sheet Daftar Berkas dan Daftar Isi Berkas;
- Riwayat JRA PDF;
- idempoten dan frozen.

Pengajuan CF-06:

- upload Nota Dinas berdisposisi PDF <10 MB;
- gunakan dokumen frozen CF-05, jangan meminta upload ulang XLSX/JRA;
- buat payload/package/event ID, SHA-256, HMAC saat secret tersedia;
- status bisnis terpisah dari status outbox;
- `PENDING_CONFIGURATION` adalah kondisi valid, bukan error bisnis.

---

## 11. Reliability dan dukungan jangka panjang

### 11.1 Mengapa aplikasi masih layak dipakai jangka panjang

- Database berada di Google Sheets dan dokumen di Drive; data tidak dikunci dalam binary proprietary aplikasi.
- Tiap unit memiliki instance sendiri sehingga pertumbuhan tidak sentralistik.
- Laporan dapat dibangun ulang dari database kanonik.
- Backup spreadsheet dan manifest Drive tersedia.
- File yang dibatalkan dikarantina.
- Audit dan migrasi menyimpan jejak versi.
- Paket rilis ber-versi memungkinkan rollback kode tanpa menghapus data.

### 11.2 Hal yang harus dipantau

- Pertumbuhan jumlah sel dan ukuran audit.
- Durasi batch pada data besar.
- quota Apps Script/Drive/Sheets.
- jumlah pengguna bersamaan.
- kapasitas pencarian.
- keberhasilan backup dan restore sample.
- akses folder ketika pegawai berganti.

### 11.3 Backup dan pemulihan

- Backup metadata harian berupa salinan spreadsheet.
- Backup penuh Drive dilakukan bertahap/job, bukan satu eksekusi panjang.
- Simpan manifest dan hitungan file/folder.
- Uji restore sampel secara berkala; “backup dibuat” belum cukup tanpa verifikasi.
- Data arsip tidak boleh bergantung pada satu akun pribadi yang akan dinonaktifkan; arah jangka panjang adalah kepemilikan institusional/Shared Drive bila tersedia.

### 11.4 Health check

Health check minimal memeriksa:

- versi/schema;
- sheet dan header wajib;
- akses folder;
- konfigurasi instance;
- integrasi Penerimaan–Input;
- metadata CF;
- schema peminjaman;
- schema retensi/dokumen/pengajuan;
- trigger backup;
- konfigurasi RC sebagai `OK` atau `WARNING`, bukan error bila belum dipasang.

---

## 12. Protokol federasi Central File → Record Center

### 12.1 Konsep

Central File tidak menulis langsung ke spreadsheet RC. Ia membuat event/payload bertanda tangan dan mengirim ke endpoint RC. RC memvalidasi event, menyalin file, menyimpan snapshot, lalu merespons idempoten.

### 12.2 Event saat ini

- `SUBMIT_TRANSFER_PROPOSAL`
- `CANCEL_TRANSFER_PROPOSAL`

RC kelak mengirim:

- `TRANSFER_PROPOSAL_DECISION`

### 12.3 Integritas dan autentikasi

- Payload memiliki schema versi, package/event/proposal ID.
- Hash payload: SHA-256.
- Envelope memuat source instance, destination instance, sent-at, hash, dan signature.
- Signature: HMAC shared secret.
- RC memeriksa usia event maksimal 24 jam pada baseline.
- Perbandingan signature dilakukan constant-time.
- Source harus terdaftar aktif pada `RC_SOURCE_REGISTRY`.
- Destination instance harus cocok.
- Event ID, package ID, dan proposal ID dipakai untuk idempotensi.

Jangan mencatat shared secret ke sheet. Secret CF/RC harus sama dan berada di Script Properties masing-masing.

### 12.4 Status outbox CF

- `PENDING_CONFIGURATION`: endpoint/instance/secret RC belum lengkap; aman dikirim ulang setelah konfigurasi.
- `PENDING`: siap/menunggu pengiriman.
- `SENT`: RC sudah menerima.
- `FAILED`: percobaan gagal; simpan error dan izinkan retry idempoten.

Status bisnis `DIAJUKAN` tidak boleh otomatis dikembalikan ke draft hanya karena transport belum terkirim.

### 12.5 Callback yang belum dibangun

Callback keputusan RC ke CF harus menjadi pekerjaan integrasi setelah RC-01 terpasang.

Persyaratan:

- endpoint terpisah atau mode signed POST yang tidak membuka dashboard;
- autentikasi SHA-256 + HMAC serupa;
- idempoten per event keputusan;
- `DISETUJUI` atau `DITOLAK` dengan alasan;
- keputusan ditulis ke usul dan Audit Log;
- berkas pada usul ditolak dilepas agar dapat diperbaiki/diajukan ulang sesuai aturan;
- berkas disetujui tetap terkunci dalam proses sampai diterima fisik/ditata;
- callback tidak boleh mengubah fase menjadi inaktif di CF;
- tangani retry dan event out-of-order.

---

## 13. Paket dan desain aplikasi Record Center

### 13.1 Paket saat handoff

- Direktori:
  `/workspace/scratch/e254d26ae452/record-center-rc01`
- ZIP:
  `UINSA_Record_Center_RC-00_RC-01_v1.0.0.zip`
- SHA-256:
  `c2752d9bf2030e630eb67faf27c594de8e67b311bdbf1dee403fb0ae37686ef0`
- Rilis: `1.0.0 PILOT`.
- Schema: `1`.
- Migrasi: `RC-REL-001`.

File project:

```text
AdminSetup.html
Client.html
Code.gs
Config.gs
Index.html
ReliabilityService.gs
Repository.gs
Services.gs
Styles.html
TransferInboxService.gs
appsscript.json
```

### 13.2 RC-00 — Fondasi instance

Installer RC harus dijalankan pada spreadsheet Record Center baru dan akun Record Center, bukan spreadsheet Central File.

Folder:

- `01 PENERIMAAN USUL PINDAH`
- `02 ARSIP INAKTIF`
- `90 KARANTINA APLIKASI`
- `99 BACKUP APLIKASI`

Sheet:

- `RC_SETTINGS`
- `RC_SOURCE_REGISTRY`
- `PENERIMAAN_USUL_PINDAH`
- `PENERIMAAN_USUL_BERKAS`
- `PENERIMAAN_USUL_ITEM`
- `RC_INBOX_EVENTS`
- `RC_DECISION_OUTBOX`
- `RC_AUDIT_LOG`
- `RC_SYSTEM_MIGRATIONS`
- `RC_SYSTEM_HEALTH`
- `RC_SYSTEM_BACKUPS`

Fungsi fondasi:

- instance ID RC;
- administrator email;
- registry sumber CF;
- shared secret di Script Properties;
- health check;
- Audit Log;
- backup spreadsheet harian;
- pembatasan dashboard ke administrator instance.

### 13.3 RC-01 — Monitor Penerimaan Usul Pindah

Endpoint menerima event signed POST dan:

1. memvalidasi envelope/payload;
2. menolak source tidak aktif atau destination salah;
3. menolak hash/signature salah;
4. mencegah event ganda;
5. menyalin Nota Dinas, XLSX, Riwayat JRA, PDF daftar opsional, serta raw payload/envelope ke Drive RC;
6. menyimpan snapshot berkas dan item;
7. menampilkan proposal pada monitor;
8. memungkinkan keputusan `DISETUJUI` atau `DITOLAK`;
9. mewajibkan alasan ketika ditolak;
10. membuat event keputusan di `RC_DECISION_OUTBOX`.

Data snapshot item mencakup tautan alih media dan penanda born digital.

### 13.4 Dua deployment RC wajib

Satu project RC harus dibuat menjadi dua deployment:

1. **Endpoint Federatif**
   - execute as administrator;
   - akses `Anyone`;
   - GET tidak menampilkan data;
   - POST wajib signature;
   - URL dimasukkan ke konfigurasi Central File.

2. **Dashboard Operator**
   - execute as administrator;
   - akses `Only myself` atau kebijakan terbatas akun operator;
   - digunakan petugas RC;
   - server tetap memeriksa email administrator.

Jangan memakai endpoint publik sebagai dashboard kerja.

### 13.5 Data yang diterima RC dari CF

Paket awal harus memuat:

1. Nota Dinas Permohonan Pemindahan Arsip Inaktif yang sudah mendapat disposisi pimpinan.
2. Daftar Arsip Usul Pindah XLSX.
3. Riwayat JRA yang dipakai ketika usul dibuat.

Daftar Arsip Usul Pindah PDF tidak perlu diunggah lagi oleh petugas karena menjadi lampiran Nota Dinas, tetapi boleh ikut disalin dari paket CF untuk kemudahan riwayat.

Berita Acara Pemindahan **tidak wajib pada awal pengajuan**. Upload BA bersifat opsional dan dapat menyusul setelah proses administratif/fisik.

### 13.6 Status proses RC final

Gunakan status berikut:

- `DISETUJUI`
- `DITOLAK`
- `DITERIMA RECORD CENTER`
- `DIBATALKAN`
- `TERTATA INAKTIF`

Antrean awal dapat memiliki status teknis diterima/menunggu verifikasi, tetapi UI bisnis utama mengikuti lima status di atas. Jangan menambah status penilaian kembali pada alur ini.

---

## 14. Roadmap Record Center per seksi/sprint

### RC-00 — Fondasi instance — SUDAH DIBANGUN, BELUM DIPASANG

Keluaran:

- spreadsheet/Drive RC terpisah;
- installer;
- settings, source registry, migration, health, audit, backup;
- administrator guard;
- secret Script Properties.

Definition of done operasional:

- dipasang pada akun RC pilot;
- health check `OK`;
- folder/sheet terbentuk;
- source CF terdaftar;
- backup metadata dapat dibuat.

### RC-01 — Monitor dan verifikasi usul — SUDAH DIBANGUN, BELUM DIPASANG

Keluaran:

- signed endpoint;
- copy dokumen/snapshot;
- monitor proposal;
- detail berkas/item;
- keputusan Disetujui/Ditolak;
- decision outbox.

Definition of done operasional:

- dua deployment aktif;
- CF dapat retry `UP-2026-0002` dan outbox menjadi `SENT`;
- proposal hanya muncul satu kali;
- file dapat dibuka dari Drive RC;
- kirim ulang event tidak menggandakan data;
- keputusan membuat decision outbox.

### Integrasi keputusan RC → CF — NEXT / WAJIB SEBELUM RC-02 PENUH

Walau dapat diperlakukan sebagai RC-01.1/CF-06.1, sinkronisasi balik vital agar status CF tidak berhenti pada `DIAJUKAN`.

Keluaran:

- endpoint callback CF;
- signing/verification;
- update status usul;
- alasan penolakan;
- retry/idempotensi;
- audit dua sisi;
- UAT event duplikat, event lama, signature salah, keputusan bertentangan.

### RC-02 — Penerimaan fisik arsip inaktif

Tujuan: setelah usul disetujui dan fisik diserahkan, petugas mencatat penerimaan tanpa langsung menganggap arsip tertata.

Fitur:

- tombol `Terima Fisik` untuk proposal disetujui;
- checklist kecocokan fisik berkas/item;
- catatan selisih/pemeriksaan;
- tanggal/jam dan petugas penerima;
- status `DITERIMA RECORD CENTER`;
- lokasi awal `RUANG TRANSIT`;
- upload BA Pemindahan PDF opsional, dapat menyusul;
- data XLSX/snapshot dikonversi menjadi daftar penerimaan arsip inaktif;
- tidak memberi nomor definitif atau boks final pada langkah ini;
- tidak menghapus data CF.

Guardrail:

- hanya proposal `DISETUJUI` dapat diterima;
- penerimaan ulang idempoten;
- usul yang sudah diterima tidak dapat dibatalkan sepihak dari CF;
- perbedaan fisik harus dicatat dan mencegah commit “sesuai” palsu.

### RC-03 — Penataan Arsip Inaktif

Tujuan: memindahkan arsip dari ruang transit ke boks/lokasi definitif.

Fitur:

- pilih satu/beberapa berkas penerimaan;
- masukkan ke boks yang sudah ada atau buat boks baru;
- lokasi: ruang, nomor rak, nomor boks, nomor folder;
- nomor definitif arsip inaktif berurutan tanpa batas;
- status `TERTATA INAKTIF`;
- label boks;
- daftar arsip inaktif;
- mutasi lokasi tercatat.

Label boks memuat:

- nama unit pencipta arsip;
- kurun waktu arsip;
- nomor boks;
- rentang nomor berkas.

### RC-04 — Peminjaman Arsip Inaktif

- Peminjam hanya pegawai internal UINSA.
- Peminjaman wajib satu berkas penuh; tidak boleh per item/halaman.
- Tidak ada batas durasi default yang dipaksakan; petugas memasukkan tanggal sesuai proses.
- Bukti persetujuan opsional seperti peminjaman aktif.
- Status terlambat/terlampaui ditampilkan.
- Out Indicator mengikuti konsep A5 peminjaman aktif, tetapi objek selalu berkas inaktif dan lokasi asal memuat ruang/rak/boks/folder.
- Berkas aktif pinjaman memblokir mutasi lokasi dan usul akhir.
- Pengembalian memulihkan status/lokasi dengan audit.

### RC-05 — Monitoring Retensi Inaktif dan pembuatan usul akhir

- Tanggal akhir retensi inaktif diisi manual oleh petugas RC.
- Reminder H-14.
- Nasib akhir diisi manual saat input/penataan inaktif: `PERMANEN`, `MUSNAH`, atau `DINILAI KEMBALI` sebagai metadata JRA.
- UI tidak perlu menu kandidat terpisah.
- Petugas memilih berkas pada monitor retensi lalu memilih:
  - `Buat Usul Musnah`; atau
  - `Buat Usul Serah`.
- Tidak ada tombol `Buat Penilaian Kembali`.
- Asumsi bisnis pengguna: ketika petugas memilih usul, berkas tersebut sudah ditetapkan untuk jalur tersebut.
- Berkas yang dipilih tidak boleh dimasukkan ke usul lain.
- Daftar Arsip Usul Musnah/Serah isinya sama dengan Daftar Arsip Inaktif, hanya judul dan subset rekod berubah.

### RC-06 — Riwayat Pemusnahan dan Penyerahan

Sistem tidak membuat Nota Dinas atau Berita Acara. Sistem membuat daftar usul dari data dan menyediakan upload dokumen administratif secara bertahap.

**Riwayat Pemusnahan**

- daftar kegiatan dapat diurutkan berdasarkan tanggal pelaksanaan;
- detail menampilkan delapan slot bukti;
- status `BUKTI BELUM LENGKAP` atau `BUKTI LENGKAP`;
- seluruh bukti opsional saat membuat riwayat dan boleh dilengkapi kemudian.

Dokumen:

1. SK Panitia Penilai Arsip.
2. Daftar Arsip Usul Musnah.
3. Surat Pertimbangan Panitia Penilai Arsip.
4. Nota Dinas Permohonan Persetujuan Pemusnahan yang mendapat disposisi pimpinan.
5. SK Penetapan Daftar Arsip yang Dimusnahkan.
6. Berita Acara Pemusnahan Arsip.
7. Laporan Pemusnahan Arsip.
8. Surat Dinas Permohonan Persetujuan Pemusnahan yang mendapat disposisi Kepala ANRI — opsional khusus arsip dengan masa retensi inaktif lebih dari 10 tahun.

**Riwayat Penyerahan**

- daftar kegiatan dapat diurutkan berdasarkan tanggal pelaksanaan;
- detail menampilkan lima slot bukti;
- status `BUKTI BELUM LENGKAP` atau `BUKTI LENGKAP`;
- bukti dapat dilengkapi kemudian.

Dokumen:

1. SK Panitia Penilai Arsip.
2. Daftar Arsip Usul Serah.
3. Surat Pertimbangan Panitia Penilai Arsip.
4. Nota Dinas Permohonan Persetujuan Penyerahan yang mendapat disposisi pimpinan.
5. Berita Acara Penyerahan Arsip.

Endpoint produk adalah riwayat dan bukti kegiatan; pengelolaan arsip statis setelah penyerahan tidak termasuk scope.

---

## 15. Metadata Daftar Arsip Inaktif final

Daftar Arsip Inaktif perlu dapat disortir berdasarkan pencipta/unit pencipta. Struktur final yang disetujui:

1. Nomor definitif arsip inaktif.
2. Pencipta Arsip / Unit Pencipta Arsip.
3. Kode Klasifikasi Berkas.
4. Uraian Informasi Arsip.
5. Kurun Waktu — tahun terciptanya arsip.
6. Tingkat Perkembangan — `ASLI`, `COPY`, atau `KOMBINASI`.
7. Jumlah Item — bukan jumlah halaman dan bukan label “jumlah berkas”.
8. Media Arsip — `TEKSTUAL`, `AUDIO-VISUAL`, atau `DIGITAL`.
9. Keterangan.
10. Lokasi Simpan — ruang, nomor rak, nomor boks, nomor folder.
11. Jangka Simpan Inaktif / tanggal akhir retensi inaktif yang ditentukan manual.
12. Nasib Akhir — `PERMANEN`, `MUSNAH`, atau `DINILAI KEMBALI`.
13. Kondisi — `BAIK`, `RAPUH`, atau `RUSAK`.
14. Tingkat Keamanan Akses — `SANGAT RAHASIA`, `RAHASIA`, `TERBATAS`, atau `BIASA`.
15. Kategori Arsip — `VITAL`, `TERJAGA`, atau `BIASA`.
16. Link Alih Media.

Catatan penting:

- Satu rekod arsip inaktif mewakili satu berkas, bukan satu item aktif.
- Jumlah Item berasal dari jumlah item dalam berkas aktif.
- Born digital tetap dihitung sebagai item; beri catatan `(born digital)` agar pemeriksa fisik tidak bingung.
- Link born digital/alih media ditampilkan pada kolom Link Alih Media.
- Klasifikasi keamanan dibawa dari Central File, tidak diinput ulang bila snapshot valid.
- Retensi inaktif dan tanggal akhirnya ditentukan manual petugas RC karena pemicu lapangan dapat kompleks.

---

## 16. Status, fase, dan aturan transisi

### 16.1 Jangan memakai satu kolom untuk semua arti

Pisahkan minimal:

- fase arsip (`AKTIF`, `INAKTIF`, hasil akhir bila diperlukan);
- status proses usul;
- status pinjam;
- status outbox/transport;
- status kelengkapan bukti;
- status soft delete/koreksi.

### 16.2 Transisi penting

- Central File: `DRAFT USUL` → `DIAJUKAN`.
- Transport CF: `PENDING_CONFIGURATION/PENDING/FAILED` → `SENT`.
- RC verifikasi: proposal diterima → `DISETUJUI` atau `DITOLAK`.
- RC fisik: `DISETUJUI` → `DITERIMA RECORD CENTER`.
- RC penataan: `DITERIMA RECORD CENTER` → `TERTATA INAKTIF`.

Central File tidak menulis fase `INAKTIF`; RC menjadi pemegang data inaktif setelah penerimaan fisik/penataan sesuai desain.

### 16.3 Pembatalan

- Draft CF dapat dibatalkan dengan alasan.
- Pengajuan CF yang belum diterima fisik dapat mengirim event pembatalan sesuai guardrail.
- Setelah diterima fisik/tertata RC, CF tidak boleh membatalkan sepihak.
- Pembatalan tidak menghapus snapshot, dokumen, event, atau audit.

---

## 17. Riwayat bug penting dan pelajaran teknis

### 17.1 Peminjaman 20–25 detik

Penyebab bukan hanya refresh UI; server menjalankan banyak round-trip Spreadsheet. Solusi yang berhasil:

- satu batch read;
- satu batch write atomik;
- refresh dashboard di latar belakang;
- durasi per tahap;
- fallback SpreadsheetApp.

Jangan mengembalikan loop `getRange/setValue` per baris pada jalur panas.

### 17.2 Race condition state peminjaman

`loadBootstrap()` yang datang terlambat pernah menghapus `state.loanOptions`. UI terlihat berisi, tetapi dropdown dan pengembalian membaca state kosong. Solusi:

- jangan menimpa state yang lebih baru;
- recovery load bila state hilang;
- bedakan transaksi benar-benar selesai dengan data browser yang belum sinkron.

### 17.3 HTTP 500 upload

Mengirim file besar sekaligus melalui `google.script.run`, form multipart tanpa file, dan file sintetis `DataTransfer` pernah gagal. Pola yang terbukti:

- object biasa bila tanpa file;
- file asli, bukan salinan sintetis;
- resumable Drive upload;
- chunk 512 KB;
- session offset disimpan;
- commit metadata setelah upload sukses.

### 17.4 Receipt stuck lebih dari dua menit

Pemeriksaan/migrasi sheet pada setiap simpan dan batch yang belum idempoten menyebabkan loading lama. Solusi 3.18.2:

- migrasi bukan di jalur setiap transaksi;
- batch read/write;
- request ID;
- browser timeout + recovery lookup.

### 17.5 `ReceiptPrint.gs` salah tipe

HTML ditempel ke file Script menghasilkan `Unexpected token '<'`. `ReceiptPrint` wajib file HTML.

### 17.6 Permission installer UI

`Ui.showModalDialog` gagal karena scope `script.container.ui` belum ada. Manifest 3.18.3.1 menambah scope tersebut. Jika izin diubah, jalankan ulang otorisasi.

### 17.7 Kolom klasifikasi kosong pada laporan

Nilai sudah tersimpan tetapi report tidak membaca kolom item yang benar. Perbaikan 3.21.1 membuat `DAFTAR ISI BERKAS` membaca item, fallback berkas, lalu `BIASA/TERBUKA`. Perubahan report ini memang memerlukan `repairReports()` satu kali.

### 17.8 Klasifikasi hilang ketika upload alih media

Jalur tanpa file benar, jalur upload salah karena sesi tidak membawa metadata keamanan. Hotfix 3.23.1 meneruskan `securityClassification` dari form sampai finalisasi.

### 17.9 Checkbox usul pindah tidak aktif

Rekod lama berstatus `PERLU VERIFIKASI`; checkbox memang diblokir. 3.24.1 menambah tindakan verifikasi metadata dari UI dan server.

### 17.10 `recordCenterEmailValue is not defined`

Bug CF-06 pada `validateTransferSubmissionRequest_`/retry. Diperbaiki pada 3.25.1. Jangan memakai ulang paket 3.25.0.

---

## 18. Pengujian dan quality gate

### 18.1 Test suite Central File

Baseline memiliki test berikut:

```text
test_central_file_metadata.js
test_item_upload_security.js
test_loan_cf03.js
test_out_indicator_pdf.js
test_receipt_filing.js
test_receipt_filing_commit.js
test_receipt_save.js
test_reliability.js
test_report_security.js
test_retention_cf04.js
test_retention_cf05.js
test_transfer_submission_cf06.js
```

### 18.2 Test suite Record Center

```text
test_rc01.js
test_rc01_accept.js
```

Keduanya lulus pada saat paket dibuat.

### 18.3 Quality gate setiap sprint

Sebelum deployment:

1. syntax Apps Script/inline JavaScript/manifest valid;
2. semua test lama dan baru lulus;
3. migrasi idempoten;
4. backup metadata dibuat dan dapat dibuka;
5. tidak ada perubahan destruktif pada sheet/header;
6. core transaction rutin ditargetkan <10 detik;
7. retry tidak membuat data/file ganda;
8. laporan dapat diregenerasi;
9. Audit Log mencatat sukses dan kegagalan material;
10. UAT spesifik sprint disediakan.

### 18.4 UAT CF yang wajib dipertahankan

- Penerimaan multi-item dan PDF adaptif.
- Pemberkasan batch dari Penerimaan.
- Security classification per item sampai laporan.
- Input dengan/ tanpa PDF dan retry upload besar.
- Peminjaman item/berkas, konflik, pengembalian, Out Indicator.
- Kandidat retensi tidak dapat dipilih bila belum habis/metadata belum verifikasi/sedang dipinjam.
- Dokumen CF-05 frozen dan idempoten.
- CF-06 dapat tetap `PENDING_CONFIGURATION` tanpa kehilangan pengajuan.
- Cancel/retry tidak membuat duplikasi.

### 18.5 UAT RC-00/RC-01 yang harus dijalankan setelah instalasi

1. Health check `OK`.
2. Dua deployment dibuat dengan akses berbeda.
3. Source CF terdaftar.
4. Retry `UP-2026-0002` membuat CF outbox `SENT`.
5. Proposal muncul satu kali.
6. Nota, XLSX, JRA, folder, jumlah berkas/item dapat dibuka.
7. Event sama dikirim ulang tanpa duplikasi.
8. `DISETUJUI` berhasil.
9. `DITOLAK` mewajibkan alasan.
10. Keputusan menghasilkan `RC_DECISION_OUTBOX` tanpa mengubah arsip menjadi inaktif.
11. Signature/source/destination salah ditolak.
12. Endpoint publik tidak membuka dashboard/data.

---

## 19. Prosedur pemasangan dan rilis

### 19.1 Central File existing instance

Untuk perubahan kode:

1. Pastikan project dan spreadsheet benar.
2. Bandingkan file produksi dengan paket baseline sebelum edit.
3. Terapkan hanya file yang diperlukan atau seluruh paket resmi sesuai rencana migrasi.
4. Simpan seluruh file.
5. Jalankan fungsi installer/migrasi hanya bila rilis memang memerlukannya.
6. Jalankan health check.
7. Buat New version pada deployment stabil.
8. Arahkan deployment ke versi tersebut.
9. Verifikasi Web App menampilkan versi baru.
10. Minta pengguna UAT dan `Ctrl+Shift+R`.

Jangan menjalankan `repairReports()` secara default. Gunakan hanya bila release notes menyatakan perubahan struktur/report atau health check menunjukkan laporan perlu dibangun ulang.

### 19.2 Unit Central File baru

1. Administrator unit memakai akun institusional unit.
2. Buat spreadsheet/folder induk unit baru atau gunakan template distribusi bersih.
3. Pasang paket source resmi tanpa edit manual per unit.
4. Jalankan installer `Arsip Aktif → Instalasi & Reliability…`.
5. Isi identitas unit, admin, default penerima, dan folder induk.
6. Izinkan OAuth scopes.
7. Jalankan health check dan backup awal.
8. Deploy Web App sebagai administrator dengan akses sesuai kebijakan unit.
9. Jangan menyalin data/instance ID/secret unit pilot ke unit baru.

### 19.3 Record Center baru

1. Login akun Record Center pilot yang terpisah.
2. Buat spreadsheet dan folder induk RC baru.
3. Buat Apps Script bound ke spreadsheet.
4. Pasang semua file paket RC 1.0.0.
5. Jalankan installer RC.
6. Catat instance ID sekali.
7. Daftarkan source CF dan buat/shared secret; simpan secret hanya di Script Properties.
8. Jalankan health check.
9. Buat deployment endpoint `Anyone` dan dashboard private.
10. Masukkan nama/email/instance ID/endpoint/secret RC ke installer CF.
11. Kirim ulang outbox.
12. Jalankan UAT RC-01.

### 19.4 Packaging sprint

Setiap sprint harus menghasilkan:

- folder source lengkap;
- ZIP versioned;
- README/release notes;
- migration ID/schema version;
- test suite;
- UAT checklist;
- checksum SHA-256;
- daftar file yang wajib diganti;
- instruksi deployment/rollback;
- catatan apakah `repairReports`, installer, atau otorisasi baru diperlukan.

---

## 20. Guardrail untuk agent penerus

### 20.1 Data dan deployment

- Jangan menghapus sheet, header, file, folder, deployment, atau transaksi produksi untuk “membersihkan”.
- Jangan memakai `git reset --hard`, reset spreadsheet, atau fungsi hapus data pilot pada produksi.
- Jangan mengubah spreadsheet secara manual untuk memperbaiki bug kode kecuali ada migrasi terkontrol dan audit.
- Jangan deploy sebagai head untuk produksi.
- Jangan membuat deployment baru yang membingungkan tanpa mencatat deployment aktif.
- Selalu identifikasi akun/project/spreadsheet sebelum menulis.

### 20.2 Source dan distribusi

- Jangan menyuruh unit pengguna mengedit `Config.gs` atau hard-code spreadsheet ID.
- Jangan memasukkan spreadsheet ID, email unit, atau secret ke source bersama.
- Jangan mendistribusikan salinan spreadsheet produksi sebagai template.
- Jangan menggabungkan source Central File dan Record Center menjadi satu project.
- Jangan menghidupkan kembali menu statis/SIKS tanpa keputusan scope baru.

### 20.3 Keamanan

- Shared secret tidak boleh tampil kembali setelah installer kecuali diregenerasi dengan proses aman.
- Jangan log token OAuth, secret, atau payload sensitif berlebihan.
- Endpoint federatif boleh publik hanya bila signed POST diverifikasi server dan GET tidak mengungkap data.
- Dashboard RC harus privat dan server-side email guard tetap aktif.
- Link Drive mengikuti izin file/folder; jangan menganggap URL acak sebagai kontrol akses.

### 20.4 Performa

- Jangan menambah pemeriksaan schema/migrasi penuh pada setiap transaksi.
- Jangan membaca seluruh sheet berkali-kali dalam satu request.
- Jangan membuat PDF sebelum commit inti jika dapat dilakukan setelah respons.
- Jangan mengirim file besar melalui satu `google.script.run`.
- Ukur lock, read, write, Drive, dan report secara terpisah bila transaksi ≥10 detik.

### 20.5 Kearsipan

- Jangan menandai arsip `INAKTIF` dari Central File.
- Jangan memusnahkan atau menyerahkan otomatis dari tanggal JRA.
- Jangan menghapus snapshot JRA atau dokumen usul setelah pembatalan.
- Jangan mengubah daftar frozen setelah dipakai untuk pengajuan.
- Jangan membatalkan penerimaan yang sudah diberkaskan tanpa koreksi pada objek definitif.
- Jangan mengizinkan berkas dipindahkan/diusulkan saat sedang dipinjam.

---

## 21. Checklist awal untuk agent penerus

### Fase A — Orientasi tanpa perubahan

- [ ] Baca dokumen ini seluruhnya.
- [ ] Dapatkan paket CF 3.25.1 dan RC 1.0.0 dari pengguna/Library.
- [ ] Verifikasi checksum.
- [ ] Setelah pengguna login di cloud browser, buka project Central File.
- [ ] Cocokkan `Config.gs` versi 3.25.1/schema 8.
- [ ] Cocokkan deployment aktif versi 41 dan URL stabil.
- [ ] Periksa Apps Script Executions untuk error terbaru tanpa mengubah data.
- [ ] Periksa `SYSTEM_MIGRATIONS`, health check, dan status outbox.

### Fase B — Pasang RC-00/RC-01

- [ ] Minta pengguna login akun RC yang terpisah.
- [ ] Buat spreadsheet/folder/project RC.
- [ ] Tempel paket RC lengkap.
- [ ] Jalankan installer dan otorisasi.
- [ ] Verifikasi sheet/folder/health.
- [ ] Buat endpoint publik signed dan dashboard private.
- [ ] Catat URL/instance ID tanpa membocorkan secret.
- [ ] Konfigurasi Central File melalui installer, bukan edit source.

### Fase C — UAT federasi

- [ ] Retry `UP-2026-0002`.
- [ ] Pastikan satu proposal RC dan outbox CF `SENT`.
- [ ] Periksa dokumen hasil copy.
- [ ] Uji duplicate retry.
- [ ] Uji Disetujui dan Ditolak pada data uji yang aman.
- [ ] Dokumentasikan hasil.

### Fase D — Integrasi balik

- [ ] Desain event keputusan signed.
- [ ] Tambah inbox event keputusan di CF secara non-destruktif.
- [ ] Tambah retry di RC.
- [ ] Update status bisnis dan Audit Log.
- [ ] Uji event salah/duplikat/out-of-order.
- [ ] Deployment versioned dan UAT pengguna.

### Fase E — RC-02

- [ ] Baru mulai setelah fase B–D stabil.
- [ ] Rancang migration/sheet penerimaan fisik.
- [ ] Pertahankan ruang transit dan BA opsional.
- [ ] Jangan langsung memberi nomor/lokasi definitif.

---

## 22. Open items dan risiko yang masih harus diselesaikan

### 22.1 Open items langsung

- RC belum dideploy pada akun Record Center.
- Endpoint dan instance ID RC belum dimasukkan ke Central File.
- Shared secret CF↔RC belum dikonfigurasi pada kedua sisi.
- `UP-2026-0002` masih `PENDING_CONFIGURATION`.
- Callback keputusan RC→CF belum dibangun.
- RC-02 dan seterusnya masih desain.

### 22.2 Keputusan kelembagaan yang mungkin dibutuhkan kemudian

- Identitas resmi Unit Kearsipan I/Record Center pada surat/label.
- Administrator/operator RC final.
- Kebijakan Shared Drive institusional.
- SOP dan pejabat berwenang untuk pemusnahan/penyerahan.
- Template resmi Daftar Arsip Inaktif/Usul Musnah/Usul Serah bila berbeda dari struktur yang sudah disepakati.
- Aturan nomor boks/nomor definitif bila lembaga memiliki format baku selain urutan sederhana.

Jangan mengarang keputusan tersebut. Gunakan konfigurasi dan tanyakan pengguna hanya saat implementasi membutuhkan pilihan final.

### 22.3 Risiko teknis

- Deployment Apps Script dengan akses `Anyone` dapat dibatasi kebijakan domain; bila opsi tidak tersedia, cari pola akses resmi yang tetap memungkinkan signed federation tanpa melemahkan keamanan.
- Copy file antar akun memerlukan izin sumber yang memadai.
- Email aktif dari `Session.getActiveUser()` dapat kosong pada deployment tertentu; jangan hanya mengandalkan UI access setting untuk otorisasi.
- Trigger/Drive quota dapat memengaruhi backup besar.
- Sheet audit perlu dipartisi bila tumbuh cepat.

---

## 23. File, versi, dan checksum

| Artefak | Versi | Status | SHA-256 |
|---|---|---|---|
| `UINSA_Arsip_Aktif_Sprint_3.25.1_CF06_Hotfix.zip` | 3.25.1/schema 8 | Terpasang produksi pilot | `64cd0c4abe64a3a2467e20e12b3477a3f4236b69cff28043ba52678f38c7b059` |
| `UINSA_Record_Center_RC-00_RC-01_v1.0.0.zip` | 1.0.0/schema 1 | Dibangun & diuji, belum dipasang | `c2752d9bf2030e630eb67faf27c594de8e67b311bdbf1dee403fb0ae37686ef0` |

Paket historis yang ada di workspace, berguna untuk audit tetapi **bukan baseline deployment**:

```text
UINSA_Arsip_Aktif_Sprint_3.18.3.zip
UINSA_Arsip_Aktif_Sprint_3.18.3.1.zip
UINSA_Arsip_Aktif_Sprint_3.19.zip
UINSA_Arsip_Aktif_Sprint_3.20_CF00_CF01.zip
UINSA_Arsip_Aktif_Sprint_3.21_CF02.zip
UINSA_Arsip_Aktif_Sprint_3.21.1.zip
UINSA_Arsip_Aktif_Sprint_3.22.0_CF03.zip
UINSA_Arsip_Aktif_Sprint_3.23.0_CF04.zip
UINSA_Arsip_Aktif_Sprint_3.23.1_Upload_Security_Fix.zip
UINSA_Arsip_Aktif_Sprint_3.23.2_Alih_Media_100MB.zip
UINSA_Arsip_Aktif_Sprint_3.24.0_CF05.zip
UINSA_Arsip_Aktif_Sprint_3.24.1_CF05_Checkbox_Fix.zip
UINSA_Arsip_Aktif_Sprint_3.25.0_CF06.zip
UINSA_Arsip_Aktif_Sprint_3.25.1_CF06_Hotfix.zip
```

---

## 24. Definition of done untuk sprint baru

Sebuah sprint belum selesai hanya karena kode sudah ditulis. Selesai berarti:

- requirement pengguna telah diterjemahkan menjadi aturan server dan UI;
- schema/migration non-destruktif tersedia;
- source lengkap dan versioned;
- test baru + seluruh regresi lulus;
- UAT checklist tersedia;
- performa jalur inti diukur;
- health check diperbarui;
- Audit Log mencakup tindakan material;
- retry/idempotensi diuji;
- ZIP + checksum dibuat;
- perubahan dipasang pada Apps Script yang benar;
- deployment new version dibuat;
- versi Web App diverifikasi;
- pengguna menjalankan UAT dan mengonfirmasi hasil;
- dokumentasi handoff/release notes diperbarui.

---

## 25. Prompt singkat untuk memulai agent berikutnya

Pengguna dapat memberikan instruksi berikut bersama dokumen ini:

> Baca `HANDOFF_PENGEMBANGAN_APLIKASI_ARSIP_UINSA.md` seluruhnya dan perlakukan keputusan di dalamnya sebagai baseline. Jangan menulis ulang aplikasi dari nol dan jangan mencampur Central File dengan Record Center. Mulai dengan mengaudit kondisi Apps Script secara read-only, lalu lanjutkan langkah berikut yang tercantum: pemasangan RC-00/RC-01 pada akun Record Center pilot, konfigurasi federasi, dan UAT pengiriman `UP-2026-0002`. Gunakan cloud browser setelah saya login; jangan meminta kredensial. Pertahankan deployment versioned, migrasi non-destruktif, idempotensi, audit, serta target transaksi inti <10 detik. Jangan membuat transaksi produksi tanpa izin saya.

---

## 26. Kesimpulan handoff

Central File pilot sudah stabil sampai CF-06. Status `OUTBOX PENDING_CONFIGURATION` pada pengajuan terakhir adalah perilaku yang disengaja karena Record Center belum dikonfigurasi, bukan kehilangan data. Pekerjaan terdekat bukan memperluas lagi Central File, melainkan memasang RC-00/RC-01 sebagai aplikasi terpisah, menghubungkan kedua instance dengan HMAC, menyelesaikan keputusan balik RC→CF, lalu membangun RC-02 secara bertahap.

Pertahankan pemisahan tanggung jawab:

- Central File mengelola arsip aktif dan mengajukan pemindahan.
- Record Center memverifikasi, menerima, menata, meminjamkan, dan menyelesaikan siklus arsip inaktif.
- Arsip statis berada di luar scope aplikasi ini.

Dengan disiplin tersebut, pengembangan tetap realistis untuk Google Apps Script + Google Sheets, dapat direplikasi per unit, dan tidak mengorbankan jejak bukti maupun keteraksesan data jangka panjang.
