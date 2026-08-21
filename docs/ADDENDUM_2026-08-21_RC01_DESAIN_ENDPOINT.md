# Addendum — Desain endpoint federatif RC-01

**Tanggal:** 21 Agustus 2026
**Status:** Keputusan mengikat, melengkapi §13.3/§13.4 pada `HANDOFF_PENGEMBANGAN_APLIKASI_ARSIP_UINSA.md` dan `ADDENDUM_2026-08-20_PROTOKOL_KEPUTUSAN_RC_CF.md`.

## 1. Satu deployment, bukan dua

Handoff §13.4 meminta dua deployment RC (endpoint federatif `Anyone` + dashboard operator `Only myself`). RC-01 di repo ini **hanya membuat satu deployment** — endpoint federatif (`executeAs: USER_DEPLOYING`, `access: ANYONE_ANONYMOUS`, wajib karena `UrlFetchApp` dari Central File adalah permintaan HTTP polos tanpa token Google).

Alasan: dashboard/monitor petugas RC dipindah sepenuhnya ke **menu spreadsheet** (`ui.prompt()`/`ui.alert()` native — lihat `Code.js`: `listPendingProposalsViaPrompt`, `decideProposalViaPrompts`, `listAllProposalsViaPrompt`), bukan halaman Web App. Konsekuensinya:

- `doGet()` pada deployment publik **tidak pernah** menampilkan data apa pun untuk siapa pun — bukan lagi soal "mengandalkan pemeriksaan admin yang mungkin gagal karena `Session.getActiveUser()` kosong pada deployment publik" (risiko yang eksplisit disebut §22.3), tapi dijamin secara struktural karena `doGet()` cuma mengembalikan halaman statis netral.
- Tidak perlu deployment kedua sama sekali — akses dashboard sepenuhnya mengikuti izin edit spreadsheet Google Sheets yang sudah teruji, bukan pengaturan akses Web App terpisah yang harus dikonfigurasi manual dan mudah salah setel.
- Ini konsisten dengan pola yang sudah terbukti jalan sepanjang sesi ini (instalasi, registrasi sumber, health check, backup — semua lewat menu, bukan dialog HTML) di lingkungan browser yang membatasi iframe `google.script.run`.

`Index.html`/dashboard HTML RC-00 **dihapus** karena jadi tidak terjangkau (tidak ada pemanggil lagi). Dialog HTML installer (`AdminSetup.html`) tetap dipertahankan sebagai jalur utama untuk lingkungan yang tidak mengalami masalah iframe tersebut — bukan dihapus, karena itu murni soal instalasi/registrasi (jalan dari spreadsheet pemilik, bukan endpoint publik), beda kelas risiko dengan dashboard yang berpotensi disajikan lewat deployment publik.

## 2. Verifikasi payload — signature vs hash

Signature (`rcHmacSignature_`) menutupi `eventId|payloadSha256|sentAt`, **bukan** `payload` itu sendiri secara langsung. Ini berarti pemeriksaan `SHA256(JSON.stringify(body.payload)) === body.payloadSha256` **bukan sekadar pengecekan integritas tambahan — ini bagian inti keamanan**: tanpa pengecekan ini, pihak yang bisa mencegat lalu lintas jaringan (tanpa memegang shared secret) berpotensi menukar isi `payload` sambil mempertahankan `eventId`/`payloadSha256` lama dan `signature` yang masih valid untuk kombinasi lama itu (serangan substitusi payload). RC-01 mewajibkan kedua pemeriksaan (signature DAN hash payload), bukan salah satu saja.

Kestabilan `JSON.stringify(JSON.parse(x)) === x` untuk `x` yang berasal dari `JSON.stringify()` V8 tanpa nilai eksotis (Date, BigInt, `undefined` di dalam array, dsb.) sudah diverifikasi berlaku pada bentuk data yang dikirim CF (`buildTransferSubmissionEnvelope_` menghasilkan objek literal biasa — string/number/boolean/null/array/object bersarang, `JSON.stringify` tanpa indentasi). Bila di masa depan CF mengubah cara membangun payload (menambah `Date` object mentah, dsb.), pengecekan hash ini bisa mulai gagal untuk permintaan yang sah — bukan tanda serangan. Uji ulang asumsi ini bila hash payload mulai gagal secara konsisten padahal pengirimnya sah.

## 3. Kontrak `QUERY_DECISION` (baru, belum ada di CF)

Belum diimplementasikan di sisi Central File (itu scope CF-06.1 berikutnya). RC-01 sudah siap menerima kontrak berikut:

**Request** (envelope federatif standar, sama seperti `SUBMIT_TRANSFER_PROPOSAL`):
```json
{
  "eventId": "QRY-<uuid>",
  "eventType": "QUERY_DECISION",
  "sourceInstanceId": "<instance ID CF>",
  "destinationInstanceId": "<instance ID RC>",
  "sentAt": "<ISO 8601>",
  "payloadSha256": "<sha256 hex dari JSON.stringify(payload)>",
  "signature": "<hmac-sha256 hex>",
  "payload": { "submitEventId": "<OUTBOX_ID CF dari event SUBMIT_TRANSFER_PROPOSAL asal>" }
}
```

**Response** (`{ok:true, ...}` selalu bila envelope valid — kegagalan bisnis bukan HTTP error):
- Usul belum ditemukan: `{ok:true, decisionAvailable:false, status:'BELUM_DITEMUKAN'}`
- Menunggu keputusan: `{ok:true, decisionAvailable:false, status:'MENUNGGU_KEPUTUSAN'}`
- Dibatalkan: `{ok:true, decisionAvailable:false, status:'DIBATALKAN'}`
- Ada keputusan: `{ok:true, decisionAvailable:true, status:'DISETUJUI'|'DITOLAK', decision, reason, decidedAt, decidedBy}`

Setiap query yang menemukan keputusan otomatis menandai baris `RC_DECISION_OUTBOX` terkait sebagai `ACKNOWLEDGED` — aman dipanggil berulang (idempoten), CF boleh polling sesering apa pun tanpa efek samping.

## 4. Yang belum termasuk RC-01 ini

- Dashboard HTML monitor (saat ini murni `ui.prompt()`/`ui.alert()` dari menu spreadsheet — cukup untuk volume pilot, tapi tidak scalable untuk banyak usul sekaligus).
- Implementasi `QUERY_DECISION` di sisi Central File (CF-06.1) dan trigger poll otomatis di CF (lihat `ADDENDUM_2026-08-20_PROTOKOL_KEPUTUSAN_RC_CF.md` §2).
- RC-02 (penerimaan fisik), RC-03 (penataan boks), dst. — di luar scope RC-01.
