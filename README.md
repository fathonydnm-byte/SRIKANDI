# Aplikasi Kearsipan UINSA — Central File & Record Center

Repo ini adalah **sumber kebenaran (source of truth) di git** untuk dua aplikasi Google Apps Script federatif yang saling terhubung, dibangun untuk mendukung siklus hidup arsip aktif→inaktif di lingkungan UINSA sesuai semangat SRIKANDI/UU Kearsipan, tapi disederhanakan menjadi dua aplikasi mandiri yang dipasang terpisah per instansi.

> Baca dulu **[`docs/HANDOFF_PENGEMBANGAN_APLIKASI_ARSIP_UINSA.md`](docs/HANDOFF_PENGEMBANGAN_APLIKASI_ARSIP_UINSA.md)** sebelum mengubah apa pun di repo ini. Dokumen itu adalah baseline keputusan bisnis, arsitektur, riwayat sprint, dan guardrail yang mengikat. Jangan menulis ulang aplikasi dari nol dan jangan mencampur Central File dengan Record Center.

## Struktur repo

```text
docs/
  HANDOFF_PENGEMBANGAN_APLIKASI_ARSIP_UINSA.md   # baseline operasional — wajib dibaca lebih dulu
central-file/                                     # aplikasi Arsip Aktif (dipasang per unit pengolah)
  .clasp.json                                     # scriptId project Apps Script Central File
  appsscript.json, Code.js, Config.js, ...        # source hasil `clasp pull` dari project live
record-center/                                    # aplikasi Arsip Inaktif (dipasang oleh Record Center)
  (belum ada — lihat "Status" di bawah)
```

## Status saat commit pertama ini dibuat (20 Agustus 2026)

- **Central File**: source di `central-file/` ditarik langsung via `clasp pull` dari project Apps Script yang **sedang live di produksi pilot** (akun `bag.umum@uinsa.ac.id`, Bagian Umum Kantor Pusat – Biro AUPK). Terverifikasi cocok dengan baseline handoff: `VERSION 3.25.1`, `SCHEMA_VERSION 8`, 30 file (29 file kode + manifest), termasuk `ReceiptPrint.html` sebagai tipe HTML yang benar. Ini pertama kalinya kode ini masuk git — sebelumnya hanya hidup di Apps Script editor.
- **Record Center**: paket `RC-00 + RC-01 v1.0.0 PILOT` **sudah dibangun & lulus uji lokal** menurut dokumen handoff, tetapi **belum di-deploy** ke akun Record Center, dan source-nya **belum ada di repo ini** — direktori kerja sesi AI sebelumnya (`/workspace/scratch/e254d26ae452/record-center-rc01`) tidak lagi dapat diakses dari sesi ini. Perlu dipulihkan dari ZIP rilis resmi (`UINSA_Record_Center_RC-00_RC-01_v1.0.0.zip`, SHA-256 tercatat di §23 handoff) jika masih tersimpan di Google Drive/Library pengguna, atau dibangun ulang berdasarkan spesifikasi di handoff §13–§14.
- Langkah selanjutnya mengikuti urutan yang sudah ditetapkan di handoff §1.3 dan §21 (checklist Fase A–E): pasang RC-00/RC-01, konfigurasi federasi CF↔RC, UAT pengiriman `UP-2026-0002`, baru lanjut RC-02.

## Prinsip kerja di repo ini

- **Central File** dan **Record Center** adalah dua aplikasi terpisah dengan `scriptId` masing-masing — jangan digabung jadi satu project Apps Script.
- Perubahan kode selalu lewat git → `clasp push` ke project yang benar → **New version** deployment (bukan overwrite deployment ke head).
- Jangan hard-code spreadsheet ID/secret/email unit di source bersama; konfigurasi instance ada di Script Properties/Settings masing-masing instance.
- Jangan menjalankan migrasi atau transaksi apa pun pada data produksi tanpa izin eksplisit pemilik repo.

Guardrail lengkap: lihat §20 di dokumen handoff.
