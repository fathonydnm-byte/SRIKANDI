# Central File 3.30.6 — klasifikasi sekunder tanpa wajib tersier

Tanggal: 14 Oktober 2026. Schema tetap **10**. Baseline source: commit `1df26587866ec757939bc8b4dd801c5ef3adf7d9` (3.30.5).

Status: **dipasang melalui clasp oleh pengguna pada 14 Oktober 2026, deployment existing diperbarui dari @59 ke @60**. Screenshot PowerShell menunjukkan `Redeployed ... @60` dan keterangan `v3.30.6 - Klasifikasi sekunder tanpa wajib tersier`. Pengujian lokal 20/20 lulus; verifikasi tampilan Web App dan UAT registrasi oleh pengguna masih menunggu. Agent tidak mengakses Apps Script live langsung karena login browser terhambat 502.

## Keputusan bisnis terbaru

Klasifikasi sekunder dapat digunakan apabila masalah arsip belum cukup spesifik untuk tersier, termasuk ketika master menyediakan turunan tersier. Pengguna tidak perlu memilih tersier yang tidak sesuai hanya agar unggah PDF berhasil. Keputusan ini menggantikan persyaratan historis “pilih sampai tingkat terakhir” pada konteks tersebut.

## Penyebab dan perbaikan

`validateClassification_()` di `Services.js` sebelumnya menolak setiap klasifikasi yang mempunyai turunan aktif. Fungsi ini dipakai `normalizeNewBerkasPayload_()`, baik saat membuat berkas, validasi awal upload PDF, commit setelah upload, commit metadata tanpa PDF, maupun pemberkasan dari Penerimaan Arsip.

Validator sekarang menerima sekunder meskipun mempunyai turunan. Tingkat sekunder ditentukan dari relasi parent master yang sama dengan dropdown, sehingga tidak bergantung pada penulisan kolom LEVEL atau pola titik dalam kode. Kode/uraian yang disimpan tetap snapshot kode sekunder yang dipilih, tidak diganti otomatis dengan turunan tersier. Klasifikasi aktif yang sudah merupakan leaf tetap diterima seperti sebelumnya. Primer yang masih mempunyai turunan tetap memerlukan pemilihan lebih lanjut; cakupan perubahan ini khusus mengizinkan sekunder.

`Client.html` sudah mengirim pilihan terdalam yang dipilih: tersier jika dipilih, jika kosong memakai sekunder. Tidak perlu perubahan payload atau upload chunk. `Index.html` memperjelas petunjuk dan menandai tersier sebagai opsional. Kode kosong, tidak ditemukan, dan nonaktif tetap ditolak. Klasifikasi keamanan/akses adalah field berbeda dan tetap divalidasi.

| File aplikasi | Perubahan |
|---|---|
| `central-file/Services.js` → `Services.gs` | Sekunder yang mempunyai turunan diterima |
| `central-file/Index.html` | Petunjuk pilihan sekunder/tersier dan label opsional |
| `central-file/Config.js` → `Config.gs` | Versi 3.30.6, tanggal rilis; schema 10 |

Tidak ada migrasi atau perubahan sheet/header; tidak mengubah klasifikasi berkas yang sudah tersimpan. Source `UploadService.js` tidak berubah pada rilis ini; perbaikan penggantian PDF 3.30.5 tetap dibawa dalam baseline.

## Pengujian

Perintah: `node --test tests/*.test.cjs`.

Hasil 14 Oktober 2026: **20/20 lulus**, terdiri dari 10 regresi penggantian PDF sebelumnya dan 10 kasus klasifikasi sekunder baru. Pengujian menggunakan fungsi source sebenarnya untuk validasi, normalisasi, rencana nomor, sesi/chunk/finalisasi, commit metadata/PDF dan Alih Media; layanan Google disimulasikan di memori. Ini tidak membuktikan deployment live atau izin Drive produksi.

- Sekunder dengan tersier aktif: berhasil mulai upload, chunk, finalize dan simpan; snapshot sekunder terjaga pada berkas/item.
- Parent primer berbentuk kosong maupun `ROOT`: diterima.
- Simpan tanpa PDF lalu upload susulan Alih Media: berhasil, snapshot tetap sekunder.
- Tersier: kode/uraian tersier tetap tersimpan.
- Kosong/tidak ditemukan/nonaktif/primer dengan turunan: ditolak sebelum upload/folder/database dibuat.
- Leaf existing tetap diterima; client mengirim sekunder ketika tersier kosong.
- Finalize ulang tidak membuat berkas/item ganda.

## Pemasangan setelah akses live tersedia

1. Pastikan akun/project adalah Central File yang benar. Binding repository menunjukkan scriptId `1_Z8ZfkDU1lIGuI5hlOCp4eeNaXiFR-3zJjO8XL60lSeIotbcaKljRLvb`; identitas live tetap perlu dicocokkan.
2. Backup source live dan catat versi/deployment aktif. Bandingkan dengan baseline 3.30.5 agar perubahan live lain tidak tertimpa. Jangan langsung push seluruh repository bila ada perubahan live di luar git.
3. Jika live sesuai baseline, salin tiga file aplikasi di tabel atau gunakan alur git/clasp yang telah terverifikasi. Bila berbeda, terapkan patch terarah pada source aktual dan sinkronkan perbedaannya.
4. Save. Pada deployment produksi yang benar, pilih edit → **New version** → deploy; pertahankan URL serta pengaturan akses/execute-as yang ada. Tidak perlu installer, repair schema, atau reset data.
5. Buka ulang Web App dan cocokkan rilis 3.30.6/schema 10 serta petunjuk tersier opsional.
6. UAT pengguna: primer → sekunder yang mempunyai tersier → biarkan tersier kosong → simpan item dengan PDF. Cocokkan snapshot kode/uraian sekunder pada DB_BERKAS/DB_ITEM dan laporan. Ulangi tanpa PDF lalu lengkapi Alih Media; periksa tersier dan kasus negatif.

UAT yang membuat transaksi perlu memakai data uji yang disetujui pengguna. Jangan membuat data sintetis di database produksi tanpa izin. Rollback dilakukan dengan memilih versi deployment sebelumnya; tidak menghapus berkas/item hasil registrasi yang sudah sah.

## Catatan handover

Pengembangan Record Center tetap pada repository terpisah `fathonydnm-byte/UINSA-Record-Center`. Perubahan ini hanya Central File. Working tree lama berisi perubahan sesi sebelumnya dipertahankan; pekerjaan baru dilakukan pada worktree/branch `fix/secondary-classification` dari commit remote.

## Bukti pemasangan 14 Oktober 2026

- Screenshot awal pengguna: hasil clone `Config.js` menunjukkan 3.30.5/schema 10, dan list-deployments menunjukkan deployment versi @59 berlabel perbaikan Edit Arsip.
- Pengguna menjalankan blok PowerShell yang memeriksa scriptId target, membuat cadangan lokal, dan membandingkan tiga file live (`Services.js`, `Index.html`, `Config.js`) dengan baseline git sebelum menyalin perbaikan dari commit `d089277da6b5d7d5de8c6f2d226f0a131afcdbb0`.
- Screenshot akhir pukul sekitar 14.08 WIB menunjukkan redeploy existing berhasil ke @60, dengan deskripsi rilis 3.30.6. Tidak dibuat URL deployment baru dalam alur tersebut.
- Schema tetap 10; tidak ada migrasi atau transaksi arsip dari perintah pemasangan.
- Batas verifikasi: keberhasilan CLI didasarkan pada screenshot pengguna. Belum dilakukan readback seluruh source server, pemeriksaan rendered UI 3.30.6, atau transaksi UAT live oleh agent. Jangan menandai UAT lulus sebelum pengguna mengonfirmasi hasil.
