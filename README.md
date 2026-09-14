# Aplikasi Kearsipan UINSA — Central File & Record Center

Repo ini adalah **sumber kebenaran (source of truth) di git** untuk dua aplikasi Google Apps Script federatif yang saling terhubung, dibangun untuk mendukung siklus hidup arsip aktif→inaktif di lingkungan UINSA sesuai semangat SRIKANDI/UU Kearsipan, tapi disederhanakan menjadi dua aplikasi mandiri yang dipasang terpisah per instansi.

> Baca dulu **[`docs/HANDOFF_PENGEMBANGAN_APLIKASI_ARSIP_UINSA.md`](docs/HANDOFF_PENGEMBANGAN_APLIKASI_ARSIP_UINSA.md)** sebelum mengubah apa pun di repo ini. Dokumen itu adalah baseline keputusan bisnis, arsitektur, riwayat sprint, dan guardrail yang mengikat. Jangan menulis ulang aplikasi dari nol dan jangan mencampur Central File dengan Record Center.

## Struktur repo

```text
docs/
  HANDOFF_PENGEMBANGAN_APLIKASI_ARSIP_UINSA.md          # baseline operasional — wajib dibaca lebih dulu
  ADDENDUM_2026-08-20_PROTOKOL_KEPUTUSAN_RC_CF.md       # keputusan protokol poll RC→CF (melengkapi §12.5/§14)
central-file/                                     # aplikasi Arsip Aktif (dipasang per unit pengolah)
  .clasp.json                                     # scriptId project Apps Script Central File
  appsscript.json, Code.js, Config.js, ...        # source hasil `clasp pull` dari project live
record-center/                                    # aplikasi Arsip Inaktif (dipasang oleh Record Center)
  README.md                                       # cakupan RC-00 vs RC-01, cara memasang
  appsscript.json, Code.js, Config.js, ...        # RC-00: installer, registry sumber, health/audit/backup
```

## Status (14 September 2026)

- **Central File**: `VERSION 3.30.4`, `SCHEMA_VERSION 10`, kanal `STABLE`. Pada 14 September 2026, seluruh 31 berkas source Apps Script live telah diverifikasi satu per satu dan hash isinya identik dengan `central-file/` pada commit kode `7ba440a91523f2312b951949c99c81dc0c1e67fd`. Web App produksi juga terverifikasi menampilkan rilis `3.30.4` (deployment `@57`). Migrasi `REL-001` sampai `REL-012` tercatat `SUCCESS` pada `SYSTEM_MIGRATIONS`.
- **Record Center**: `VERSION 1.1.0`, `SCHEMA_VERSION 2`, kanal `PILOT`. RC-00/RC-01 terpasang sebagai aplikasi terpisah dan menangani endpoint federatif, penerimaan usul pindah, keputusan, serta sinkronisasi balik melalui pola polling CF→RC. Lihat `record-center/README.md` untuk detail.
- Protokol pengambilan keputusan RC→CF sudah diputuskan (**poll dari CF**, bukan push dari RC) — lihat `docs/ADDENDUM_2026-08-20_PROTOKOL_KEPUTUSAN_RC_CF.md`. Ini menggantikan bagian §12.5/§14 handoff yang sebelumnya masih terbuka.
- **RC-01 dibangun, di-deploy, dan CF-06.1 (poll keputusan) selesai** (21 Agustus 2026) — lihat `docs/ADDENDUM_2026-08-21_RC01_DESAIN_ENDPOINT.md` untuk desain endpoint.
- **Federasi CF↔RC LULUS UAT penuh dengan data nyata**: `UP-2026-0002` berhasil dikirim → diterima RC → retry idempoten teruji → ditolak petugas RC dengan alasan → CF berhasil polling dan menyinkronkan keputusan balik, termasuk melepas berkas ke kandidat usul lagi. Trigger polling otomatis (2 jam) aktif di CF. Detail lengkap di `record-center/README.md`.
- Langkah berikutnya: RC-02 (penerimaan fisik arsip inaktif) dan seterusnya sesuai roadmap §14 handoff — federasi inti (CF-06/CF-06.1 ↔ RC-01) sudah selesai dan beroperasi.

## Prinsip kerja di repo ini

- **Central File** dan **Record Center** adalah dua aplikasi terpisah dengan `scriptId` masing-masing — jangan digabung jadi satu project Apps Script.
- Perubahan kode selalu lewat git → `clasp push` ke project yang benar → **New version** deployment (bukan overwrite deployment ke head).
- Jangan hard-code spreadsheet ID/secret/email unit di source bersama; konfigurasi instance ada di Script Properties/Settings masing-masing instance.
- Jangan menjalankan migrasi atau transaksi apa pun pada data produksi tanpa izin eksplisit pemilik repo.

## Tracking versi dan sinkronisasi

- Nilai versi resmi tiap aplikasi berada di `central-file/Config.js` (`APP_RELEASE`) dan `record-center/Config.js` (`RC_RELEASE`).
- Setiap perubahan dimulai dari branch git, dicatat dalam commit yang menjelaskan dampak kode, schema, pengujian, dan nomor deployment.
- Jika struktur sheet berubah, naikkan `SCHEMA_VERSION` dan tambahkan migrasi idempoten baru; perubahan UI/logic tanpa perubahan struktur hanya menaikkan `VERSION`.
- Setelah `clasp push`, cocokkan source Apps Script dengan commit git, lalu buat **versioned deployment** baru. Jangan memakai deployment HEAD untuk produksi.
- Format commit yang dianjurkan: `fix(scope): ...`, `feat(scope): ...`, `perf(scope): ...`, atau `docs(scope): ...`.
- Commit kode terakhir yang telah dicocokkan dengan Apps Script live: `7ba440a91523f2312b951949c99c81dc0c1e67fd` (`v3.30.4`, schema 10, deployment `@57`).

Guardrail lengkap: lihat §20 di dokumen handoff.
