# Addendum — Protokol pengambilan keputusan RC→CF

**Tanggal:** 20 Agustus 2026
**Status:** Keputusan mengikat, melengkapi §12.5 dan §14 (Integrasi keputusan RC → CF) pada `HANDOFF_PENGEMBANGAN_APLIKASI_ARSIP_UINSA.md`.
**Konteks:** Dokumen handoff sengaja menyisakan mekanisme callback keputusan RC→CF sebagai open item ("endpoint terpisah atau mode signed POST yang tidak membuka dashboard"). Addendum ini menutup pertanyaan tersebut berdasarkan temuan kode dan keputusan pengguna.

## Temuan yang mendasari keputusan

Central File (`central-file/Code.js`) hanya memiliki `doGet()`. Tidak ada `doPost()`. Satu-satunya komunikasi keluar CF adalah `dispatchTransferOutbox_()` di `TransferSubmissionService.js`, yang melakukan `UrlFetchApp.fetch()` POST bertanda tangan (HMAC) ke endpoint RC dan menunggu respons JSON sinkron pada request yang sama. Central File saat ini murni **outbound-only**.

## Keputusan

1. **Model pengambilan keputusan adalah *poll*, bukan *push*.** Central File yang secara aktif memanggil endpoint Record Center menanyakan status keputusan atas pengajuan yang sudah `SENT` — bukan Record Center yang memanggil balik ke Central File.
   - Central File **tidak akan** menambah `doPost()` baru atau deployment kedua untuk keperluan ini.
   - Record Center **tidak perlu** menyimpan atau mempercayai URL callback milik tiap instance Central File di `RC_SOURCE_REGISTRY` — menghindari risiko kelas SSRF (memercayai URL yang disuplai/didaftarkan sebagai tujuan panggilan balik).
   - Pola request query keputusan memakai signature/HMAC yang sama persis dengan yang sudah dipakai `dispatchTransferOutbox_()` untuk `SUBMIT_TRANSFER_PROPOSAL` — bukan skema autentikasi baru.
   - Endpoint federatif RC (yang sama dengan penerima `SUBMIT_TRANSFER_PROPOSAL`/`CANCEL_TRANSFER_PROPOSAL`) perlu menambah satu event/aksi baru, misalnya `QUERY_DECISION`, yang membaca `RC_DECISION_OUTBOX` berdasarkan `OUTBOX_ID`/`proposalId` dan membalas sinkron: `DISETUJUI`/`DITOLAK` + alasan, atau status "belum ada keputusan" bila petugas RC belum memutuskan.
   - CF menandai entri keputusan sebagai `ACKNOWLEDGED` setelah berhasil menerima dan menuliskannya ke `USUL_PINDAH`/Audit Log, supaya query berikutnya tidak memproses ulang keputusan yang sama (idempoten, simetris dengan pola outbox yang sudah ada).

2. **Pemicu poll: trigger otomatis + tombol manual**, keduanya aktif berdampingan.
   - Time-driven trigger Apps Script berjalan berkala memeriksa semua baris outbox CF berstatus `SENT` yang belum `ACKNOWLEDGED`, memanggil `QUERY_DECISION` untuk masing-masing.
   - Interval trigger belum ditetapkan angka pastinya — perlu dipilih saat implementasi RC-01.1/CF-06.1 dengan mempertimbangkan kuota trigger Apps Script per akun dan jumlah usul aktif; kandidat awal yang wajar adalah tiap 1–4 jam.
   - Menu **Usul Pemindahan** di CF menambah tombol **"Cek Status Keputusan RC"** agar petugas bisa memicu pengecekan langsung tanpa menunggu jadwal — pola UX ini meniru tombol "Kirim Ulang" yang sudah ada di CF-06.

3. **Tidak ada notifikasi email otomatis** saat keputusan RC masuk, untuk saat ini. Keputusan cukup terlihat saat petugas membuka menu Usul Pemindahan/Riwayat Pengajuan. Ini bisa direvisi di sprint mendatang bila kebutuhan operasional berubah — tambahkan sebagai fitur baru, jangan asumsikan sudah disetujui tanpa keputusan pengguna baru.

## Yang tidak berubah dari handoff asli

- Guardrail §12.5 tetap berlaku penuh: idempoten per event keputusan, `DISETUJUI`/`DITOLAK` dengan alasan wajib, keputusan ditulis ke usul dan Audit Log, berkas ditolak dilepas agar dapat diperbaiki/diajukan ulang, berkas disetujui tetap terkunci sampai diterima fisik/ditata, callback (dalam hal ini: hasil poll) tidak boleh mengubah fase menjadi `INAKTIF` di CF, dan sistem harus menangani retry serta event out-of-order.
- Status outbox CF (`PENDING_CONFIGURATION`/`PENDING`/`SENT`/`FAILED`) tidak berubah maknanya. `ACKNOWLEDGED` adalah status tambahan khusus untuk siklus query-keputusan, bukan pengganti status pengiriman paket.
