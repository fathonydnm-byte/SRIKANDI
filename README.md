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

## Status (21 Agustus 2026)

- **Central File**: source di `central-file/` ditarik langsung via `clasp pull` dari project Apps Script yang **sedang live di produksi pilot** (akun `bag.umum@uinsa.ac.id`, Bagian Umum Kantor Pusat – Biro AUPK). Terverifikasi cocok dengan baseline handoff: `VERSION 3.25.1`, `SCHEMA_VERSION 8`, 30 file, termasuk `ReceiptPrint.html` sebagai tipe HTML yang benar. Ini pertama kalinya kode ini masuk git — sebelumnya hanya hidup di Apps Script editor. Belum ada perubahan apa pun terhadap project live ini.
- **Record Center**: paket lama `RC-00 + RC-01 v1.0.0 PILOT` yang disebut di handoff **tidak dapat dipulihkan** — tidak pernah masuk git dan direktori kerja sesi AI sebelumnya sudah tidak terjangkau. Sebagai gantinya, **RC-00 (fondasi instance) ditulis ulang dari nol** di `record-center/`, mengikuti spesifikasi handoff §13.2 dan pola engineering yang sudah terbukti di `central-file/`. **RC-00 terpasang dan Definition of Done §14 tuntas** (21 Agustus 2026) pada akun `bag.umum@uinsby.ac.id`: folder & sheet terbentuk, sumber Central File pilot (`INS-6d92f552-1d7e-4935-a4e5-a04161ef6a75`) terdaftar dengan shared secret, health check bersih (`WARNING` hanya untuk scope RC-01 yang memang belum dibangun), backup metadata terverifikasi. Lihat `record-center/README.md` untuk detail.
- Protokol pengambilan keputusan RC→CF sudah diputuskan (**poll dari CF**, bukan push dari RC) — lihat `docs/ADDENDUM_2026-08-20_PROTOKOL_KEPUTUSAN_RC_CF.md`. Ini menggantikan bagian §12.5/§14 handoff yang sebelumnya masih terbuka.
- **RC-01 dibangun, di-deploy, dan CF-06.1 (poll keputusan) selesai** (21 Agustus 2026) — lihat `docs/ADDENDUM_2026-08-21_RC01_DESAIN_ENDPOINT.md` untuk desain endpoint.
- **Federasi CF↔RC LULUS UAT penuh dengan data nyata**: `UP-2026-0002` berhasil dikirim → diterima RC → retry idempoten teruji → ditolak petugas RC dengan alasan → CF berhasil polling dan menyinkronkan keputusan balik, termasuk melepas berkas ke kandidat usul lagi. Trigger polling otomatis (2 jam) aktif di CF. Detail lengkap di `record-center/README.md`.
- Langkah berikutnya: RC-02 (penerimaan fisik arsip inaktif) dan seterusnya sesuai roadmap §14 handoff — federasi inti (CF-06/CF-06.1 ↔ RC-01) sudah selesai dan beroperasi.

## Prinsip kerja di repo ini

- **Central File** dan **Record Center** adalah dua aplikasi terpisah dengan `scriptId` masing-masing — jangan digabung jadi satu project Apps Script.
- Perubahan kode selalu lewat git → `clasp push` ke project yang benar → **New version** deployment (bukan overwrite deployment ke head).
- Jangan hard-code spreadsheet ID/secret/email unit di source bersama; konfigurasi instance ada di Script Properties/Settings masing-masing instance.
- Jangan menjalankan migrasi atau transaksi apa pun pada data produksi tanpa izin eksplisit pemilik repo.

Guardrail lengkap: lihat §20 di dokumen handoff.
