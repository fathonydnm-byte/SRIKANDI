# Legacy column map — Central File 3.32.5 (Sheets) → v4 (Postgres)

Source: the `*_HEADERS_` arrays in `central-file/*.js`, plus every `row.X` / `X:` usage for the sheets with no single header declaration (`DB_BERKAS`, `DB_ITEM`, `MASTER_KLASIFIKASI`, `AUDIT_LOG`, `RIWAYAT_NOMOR`, `SETTINGS`). **Check this against the real pilot spreadsheet headers in Sprint 1.** Rows marked **?** were inferred from defensive reads and may not exist in real sheets.

General rules for the importer:

- Every row gets `unit_id` = the unit the spreadsheet belongs to. Legacy IDs are copied verbatim into `id`.
- `''` → `NULL`. `TRUE`/`'TRUE'`/`'YA'` → `true`. Sheet dates (Date objects or serial numbers) → `date` in `Asia/Jakarta`. ISO strings with offset → `timestamptz`.
- Enumerated values are normalized first (e.g. `centralFileMetadataNormalizeSecurity_`), then stored. Check constraints only cover closed lists the legacy code enforces.
- Upserts into `berkas` and `item` must name the arbiter: `ON CONFLICT (id) ...`. Postgres cannot infer an arbiter when the table has a deferrable exclusion constraint.
- `audit_log` and `riwayat_nomor` are append-only. Import them with `ON CONFLICT (id) DO NOTHING`.
- Cross-table foreign keys are `DEFERRABLE INITIALLY DEFERRED`. Load one unit in a single transaction, in any order.

Types: `t` = text, `i` = integer, `b` = boolean, `d` = date, `ts` = timestamptz, `j` = jsonb, `x` = bytea.

## units ← SETTINGS (instance-level keys)

| Legacy | Column | Type |
| --- | --- | --- |
| (new) | id | uuid |
| UNIT_CODE | code | t, unique |
| UNIT_NAME | name | t |
| INSTANCE_ID | legacy_instance_id | t, unique |
| UNIT_ID | legacy_unit_id | t (value used by `UNIT_PENCIPTA_ID`) |
| (new) | active, created_at | b, ts |

## unit_settings ← SETTINGS

| Legacy | Column | Type |
| --- | --- | --- |
| KEY | key | t (`^[A-Z][A-Z0-9_]*$`, no SECRET/PASSWORD/TOKEN/… keys) |
| VALUE | value | j |
| TYPE | value_type | t |
| DESCRIPTION | description | t |
| (new) | updated_at, updated_by | ts, t |

Do not import `RECORD_CENTER_SHARED_SECRET`, which is refused by a check. It belongs in the encrypted federation table (Sprint 5). Instance keys that become `units` columns (`INSTANCE_ID`, `UNIT_CODE`, `UNIT_NAME`) may also stay as settings.

## audit_log ← AUDIT_LOG (and yearly rollover sheets, see `AUDIT_LOG_YEAR`)

| Legacy | Column | Type |
| --- | --- | --- |
| LOG_ID | id | t |
| TIMESTAMP | occurred_at | ts |
| USER_EMAIL | actor_email_snapshot | t |
| AKSI | action | t |
| MODUL | module | t |
| JENIS_OBJEK | object_type | t |
| OBJEK_ID | object_id | t |
| RINGKASAN | summary | t |
| ALASAN | reason | t |
| REQUEST_ID | request_id | t |
| STATUS | result | t (SUCCESS / FAILED / WARNING) |
| (new) | unit_id, actor_user_id, actor_name_snapshot, before_data, after_data | uuid, uuid, t, j, j |

## klasifikasi ← MASTER_KLASIFIKASI (PK = unit_id + id)

| Legacy | Column | Type |
| --- | --- | --- |
| KLASIFIKASI_ID | id | t |
| PARENT_ID | parent_id | t (`''` = primer → NULL) |
| LEVEL | level | t **?** (format unknown: number or name) |
| KODE_LENGKAP | kode_lengkap | t |
| URAIAN | uraian | t |
| LABEL_DROPDOWN | label_dropdown | t |
| AKTIF | aktif | b |
| URUTAN | urutan | i |

## pegawai ← MASTER_PEGAWAI

| Legacy | Column | Type |
| --- | --- | --- |
| PEGAWAI_ID | id | t |
| NAMA_PEGAWAI | nama_pegawai | t |
| UNIT_KERJA | unit_kerja | t |
| AKTIF | aktif | b |
| CREATED_AT / CREATED_BY / UPDATED_AT / UPDATED_BY | created_at / created_by / updated_at / updated_by | ts / t / ts / t |
| (new, PII) | nip_nik_enc, kontak_enc | x via `app.encrypt_pii` |

## berkas ← DB_BERKAS

| Legacy | Column | Type |
| --- | --- | --- |
| BERKAS_ID | id | t |
| NO_BERKAS_DEFINITIF | no_berkas_definitif | i (unique per unit among non-deleted, deferred) |
| JUDUL_BERKAS | judul_berkas | t |
| KATEGORI_NASKAH_ID | kategori_naskah_id | t (always `''` in 3.32.5) |
| POLA_PEMBERKASAN | pola_pemberkasan | t (always `''`) |
| KLASIFIKASI_ID | klasifikasi_id | t → klasifikasi |
| KODE_KLASIFIKASI_SNAPSHOT | kode_klasifikasi_snapshot | t |
| URAIAN_KLASIFIKASI_SNAPSHOT | uraian_klasifikasi_snapshot | t |
| RETENSI_AKTIF_NILAI / _SATUAN | retensi_aktif_nilai / retensi_aktif_satuan | i / t (TAHUN, BULAN) |
| RETENSI_INAKTIF_NILAI / _SATUAN | retensi_inaktif_nilai / retensi_inaktif_satuan | i / t |
| NASIB_AKHIR | nasib_akhir | t (MUSNAH, PERMANEN, DINILAI KEMBALI) |
| STATUS_RETENSI | status_retensi | t |
| TGL_ITEM_AWAL / TGL_ITEM_AKHIR | tgl_item_awal / tgl_item_akhir | d |
| TGL_URUT_BERKAS | tgl_urut_berkas | d |
| TGL_ACUAN_RETENSI | tgl_acuan_retensi | d |
| BATAS_AKTIF / BATAS_INAKTIF | batas_aktif / batas_inaktif | d |
| JUMLAH_ITEM / TOTAL_HALAMAN | jumlah_item / total_halaman | i |
| KURUN_WAKTU | kurun_waktu | t |
| NO_FILLING_KABINET / NO_LACI / NO_FOLDER | no_filling_kabinet / no_laci / no_folder | t |
| DRIVE_FOLDER_ID / DRIVE_FOLDER_URL | drive_folder_id / drive_folder_url | t |
| STATUS_PEMINJAMAN | status_peminjaman | t |
| STATUS_BERKAS | status_berkas | t (DRAFT, AKTIF, DIHAPUS, GAGAL) |
| STATUS_PEMINDAHAN | status_pemindahan | t (asserted as a required header; no writer found in 3.32.5) |
| CATATAN | catatan | t |
| PENCIPTA_ARSIP_SNAPSHOT | pencipta_arsip_snapshot | t |
| UNIT_PENCIPTA_ID / UNIT_PENCIPTA_SNAPSHOT | unit_pencipta_id / unit_pencipta_snapshot | t |
| KLASIFIKASI_KEAMANAN_AKSES | klasifikasi_keamanan_akses | t (BIASA/TERBUKA, TERBATAS, RAHASIA, SANGAT RAHASIA) |
| ARSIP_VITAL / ARSIP_TERJAGA | arsip_vital / arsip_terjaga | b (TRUE or `'YA'`) |
| MEDIA_BERKAS | media_berkas | t |
| JUMLAH_ITEM_FISIK / _BORN_DIGITAL / _ALIH_MEDIA | jumlah_item_fisik / jumlah_item_born_digital / jumlah_item_alih_media | i |
| STATUS_VERIFIKASI_METADATA | status_verifikasi_metadata | t |
| METADATA_SCHEMA_VERSION | metadata_schema_version | i |
| USUL_PINDAH_ID_AKTIF / USUL_PINDAH_NO_AKTIF | usul_pindah_id_aktif / usul_pindah_no_aktif | t (FK in S5) |
| JRA_ID **?** | jra_id | t |
| JRA_DASAR_HUKUM or DASAR_HUKUM_JRA **?** | jra_dasar_hukum | t |
| JRA_VERSI or VERSI_JRA **?** | jra_versi | t |
| CREATED_AT / CREATED_BY / UPDATED_AT / UPDATED_BY | created_at / created_by / updated_at / updated_by | ts / t / ts / t |
| VERSION | version | i |
| IS_DELETED | is_deleted | b |

Not mapped: `TAHUN` **?**. RetentionService reads `row.TAHUN` as a fallback for `KURUN_WAKTU`, but no writer exists.

## item ← DB_ITEM

| Legacy | Column | Type |
| --- | --- | --- |
| ITEM_ID | id | t |
| BERKAS_ID | berkas_id | t → berkas |
| NO_ITEM_DEFINITIF | no_item_definitif | i (unique per berkas among non-deleted, deferred) |
| JENIS_NASKAH_ID / SUBJENIS_NASKAH_ID / KELENGKAPAN | jenis_naskah_id / subjenis_naskah_id / kelengkapan | t (always `''`) |
| NO_SURAT_UTAMA / NO_SURAT_ALTERNATIF / NO_SURAT_DISPLAY | no_surat_utama / no_surat_alternatif / no_surat_display | t |
| TANGGAL_NASKAH | tanggal_naskah | d |
| TAHUN_KURUN_WAKTU | tahun_kurun_waktu | i |
| URAIAN_LENGKAP / URAIAN_NAMA_FILE | uraian_lengkap / uraian_nama_file | t |
| JUMLAH_HALAMAN | jumlah_halaman | i |
| TINGKAT_PERKEMBANGAN | tingkat_perkembangan | t (ASLI, COPY) |
| KLASIFIKASI_KEAMANAN_AKSES | klasifikasi_keamanan_akses | t |
| KODE_KLASIFIKASI_SNAPSHOT | kode_klasifikasi_snapshot | t |
| NO_BERKAS_SNAPSHOT | no_berkas_snapshot | i |
| NAMA_FILE | nama_file | t |
| DRIVE_FILE_ID / DRIVE_FILE_URL / MIME_TYPE | drive_file_id / drive_file_url / mime_type | t |
| (new) | drive_file_size_bytes / drive_file_sha256 | bigint / t |
| LAMPIRAN_JSON | lampiran | j (array) |
| STATUS_FILE | status_file | t |
| STATUS_PEMINJAMAN | status_peminjaman | t |
| SORT_NO_SURAT_NORMALIZED | sort_no_surat_normalized | t |
| SORT_CREATED_AT | sort_created_at | t (ISO text, may end in `-NNN`) |
| CATATAN | catatan | t |
| ARSIP_ID | arsip_id | t (indexed, not unique **?**) |
| SUMBER_REGISTRASI | sumber_registrasi | t (INPUT_MANUAL, PENERIMAAN_ARSIP) |
| PENERIMAAN_ID / PENERIMAAN_ITEM_ID | penerimaan_id / penerimaan_item_id | t → penerimaan / penerimaan_item |
| NOMOR_TANDA_TERIMA_SNAPSHOT | nomor_tanda_terima_snapshot | t |
| KONDISI_FISIK | kondisi_fisik | t |
| MEDIA_SUMBER | media_sumber | t (TEKSTUAL, AUDIO VISUAL, DIGITAL) |
| STATUS_BENTUK_DIGITAL | status_bentuk_digital | t (TIDAK ADA, ALIH MEDIA, BORN DIGITAL) |
| CATATAN_MEDIA | catatan_media | t |
| STATUS_VERIFIKASI_METADATA / METADATA_SCHEMA_VERSION | status_verifikasi_metadata / metadata_schema_version | t / i |
| CREATED_AT / CREATED_BY / UPDATED_AT / UPDATED_BY / VERSION / IS_DELETED | same, snake_case | ts / t / ts / t / i / b |

## penerimaan ← PENERIMAAN_ARSIP (`RECEIPT_HEADERS_`)

| Legacy | Column | Type |
| --- | --- | --- |
| PENERIMAAN_ID | id | t |
| NOMOR_TANDA_TERIMA | nomor_tanda_terima | t (TRM-YYYY-NNNN, unique per unit; counter scope `TRM`) |
| TAHUN | tahun | i |
| TANGGAL_WAKTU_TERIMA | tanggal_waktu_terima | ts |
| PENYERAH_PEGAWAI_ID | penyerah_pegawai_id | t → pegawai |
| NAMA_PENYERAH_SNAPSHOT / UNIT_PENYERAH_SNAPSHOT | nama_penyerah_snapshot / unit_penyerah_snapshot | t |
| NAMA_PENERIMA / UNIT_PENERIMA / LOKASI / CATATAN_UMUM | nama_penerima / unit_penerima / lokasi / catatan_umum | t |
| JUMLAH_ITEM / TOTAL_HALAMAN | jumlah_item / total_halaman | i |
| STATUS | status | t (AKTIF, DIBATALKAN) |
| BUKTI_TTD_FILE_ID / _URL / _NAMA | bukti_ttd_file_id / bukti_ttd_url / bukti_ttd_nama | t |
| BUKTI_TTD_UPLOADED_AT / _BY | bukti_ttd_uploaded_at / bukti_ttd_uploaded_by | ts / t |
| ALASAN_PEMBATALAN | alasan_pembatalan | t |
| BATAL_BUKTI_FILE_ID / _URL / _NAMA | batal_bukti_file_id / batal_bukti_url / batal_bukti_nama | t |
| DIBATALKAN_AT / DIBATALKAN_BY | dibatalkan_at / dibatalkan_by | ts / t |
| CREATED_AT / CREATED_BY / UPDATED_AT / UPDATED_BY / VERSION | same | ts / t / ts / t / i |

## penerimaan_item ← PENERIMAAN_ITEM (`RECEIPT_ITEM_HEADERS_` + `CF_METADATA_RECEIPT_ITEM_HEADERS_`)

| Legacy | Column | Type |
| --- | --- | --- |
| PENERIMAAN_ITEM_ID | id | t |
| PENERIMAAN_ID | penerimaan_id | t → penerimaan |
| NO_ITEM | no_item | i |
| URAIAN_INFORMASI | uraian_informasi | t |
| JUMLAH_HALAMAN | jumlah_halaman | i |
| TINGKAT_PERKEMBANGAN | tingkat_perkembangan | t |
| KONDISI | kondisi | t (BAIK, RUSAK RINGAN, RUSAK SEDANG, RUSAK BERAT) |
| KLASIFIKASI_KEAMANAN_AKSES | klasifikasi_keamanan_akses | t |
| CREATED_AT / CREATED_BY / UPDATED_AT / UPDATED_BY | same | ts / t / ts / t |
| IS_DELETED / DELETED_AT / DELETED_BY | is_deleted / deleted_at / deleted_by | b / ts / t |
| ARSIP_ID | arsip_id | t |
| NO_SURAT_UTAMA / NO_SURAT_ALTERNATIF | no_surat_utama / no_surat_alternatif | t |
| TANGGAL_NASKAH | tanggal_naskah | d |
| CATATAN_ITEM | catatan_item | t |
| STATUS_PEMBERKASAN | status_pemberkasan | t (BELUM DIBERKASKAN, SUDAH DIBERKASKAN, PERLU DILENGKAPI, DIBATALKAN) |
| BERKAS_ID_TUJUAN | berkas_id_tujuan | t → berkas |
| ITEM_ID_DEFINITIF | item_id_definitif | t → item |
| NO_BERKAS_DEFINITIF_SNAPSHOT / NO_ITEM_DEFINITIF_SNAPSHOT | no_berkas_definitif_snapshot / no_item_definitif_snapshot | i |
| DIBERKASKAN_AT / DIBERKASKAN_BY | diberkaskan_at / diberkaskan_by | ts / t |
| PEMBERKASAN_REQUEST_ID | pemberkasan_request_id | t |
| MEDIA_SUMBER / STATUS_BENTUK_DIGITAL / CATATAN_MEDIA | media_sumber / status_bentuk_digital / catatan_media | t |
| FILE_DIGITAL_ID / _URL / _MIME_TYPE | file_digital_id / file_digital_url / file_digital_mime_type | t |
| (new) | file_digital_size_bytes / file_digital_sha256 | bigint / t |
| STATUS_VERIFIKASI_METADATA / METADATA_SCHEMA_VERSION | same | t / i |

## riwayat_nomor ← RIWAYAT_NOMOR (`historyRecord_`)

| Legacy | Column | Type |
| --- | --- | --- |
| RIWAYAT_ID | id | t |
| JENIS_OBJEK | jenis_objek | t (BERKAS, ITEM) |
| OBJEK_ID | objek_id | t (polymorphic, no FK) |
| BERKAS_ID | berkas_id | t → berkas |
| NOMOR_LAMA / NOMOR_BARU | nomor_lama / nomor_baru | i (`''` → NULL) **?** (if real sheets hold `'–'` or text, switch to t) |
| NAMA_LAMA / NAMA_BARU | nama_lama / nama_baru | t |
| ALASAN | alasan | t |
| BATCH_RENUMBER_ID | batch_renumber_id | t |
| DIKONFIRMASI_OLEH / DIKONFIRMASI_AT | dikonfirmasi_oleh / dikonfirmasi_at | t / ts |
| CREATED_AT / CREATED_BY | created_at / created_by | ts / t |

## Not in this sprint

PEMINJAMAN (holds the PII `NIP_NIK` and `NO_WHATSAPP`, which go through `app.encrypt_pii` in S4), USUL_PINDAH*, OUTBOX_RECORD_CENTER, DB_SEARCH_DOCUMENTS, LOG_CETAK_*, SYSTEM_*, JRA reference.

## Additions from the real pilot export (migration 0007)

These columns exist in the real 3.32.5 sheets but are not declared anywhere in the Apps Script code.

| Sheet | Legacy | Column | Type |
| --- | --- | --- | --- |
| DB_BERKAS | NO_BERKAS_LAMA | no_berkas_lama | t |
| DB_BERKAS | JRA_NAMA_SNAPSHOT | jra_nama_snapshot | t |
| DB_BERKAS | TGL_PEMINDAHAN / TGL_PERSETUJUAN_PEMINDAHAN | tgl_pemindahan / tgl_persetujuan_pemindahan | d |
| DB_BERKAS | BUKTI_PEMINDAHAN_FILE_ID / _URL | bukti_pemindahan_file_id / bukti_pemindahan_file_url | t |
| DB_BERKAS | DISETUJUI_PEMINDAHAN_OLEH / CATATAN_PEMINDAHAN | disetujui_pemindahan_oleh / catatan_pemindahan | t |
| DB_BERKAS | DELETED_AT | deleted_at | ts |
| DB_ITEM | NO_ITEM_LAMA / DELETED_AT | no_item_lama / deleted_at | t / ts |
| MASTER_KLASIFIKASI | KODE_PRIMER / KODE_SEKUNDER / KODE_TERSIER | kode_primer / kode_sekunder / kode_tersier | t |
| MASTER_KLASIFIKASI | STATUS_REVIEW / SUMBER / CATATAN | status_review / sumber / catatan | t |
| MASTER_KLASIFIKASI | UPDATED_AT | updated_at | ts (a blank cell keeps the DB value) |
| SETTINGS | SCOPE / UPDATED_AT | scope / updated_at | t / ts (a blank cell keeps the DB value) |
| RIWAYAT_NOMOR | CATATAN | catatan | t |
| AUDIT_LOG | DATA_SEBELUM_JSON / DATA_SESUDAH_JSON | before_data / after_data | j |
| AUDIT_LOG | IP_INFO / CATATAN | ip_info / catatan | t |

SETTINGS rows with `TYPE = SECRET` are never imported, whatever the key name. Each one is reported by key name only.

Answers to the Sprint 0 open questions (pilot export):

- `LEVEL` is text: PRIMER / SEKUNDER / TERSIER.
- `JRA_ID` exists in DB_BERKAS but is empty. There is no JRA dasar-hukum or versi column; `JRA_NAMA_SNAPSHOT` exists instead.
- DB_BERKAS has no `TAHUN` column.
- `STATUS_PEMINDAHAN` exists and is empty.
- `MEDIA_BERKAS` is free text and includes "BELUM DITETAPKAN".
- `KONDISI_FISIK` on DB_ITEM only holds BAIK or blank.
- DB_ITEM has `DELETED_AT` (empty) and no `DELETED_BY`.
- `ARSIP_ID` is unique in the pilot.
- `NOMOR_LAMA` / `NOMOR_BARU` are always integers or blank, so `integer` stays.
- MASTER_PEGAWAI has no PII columns.

Sheets outside Config.js found in the pilot:

- MASTER_JENIS_NASKAH: deferred to S2.
- MASTER_JRA (empty): deferred to S5.
- IMPORT_STAGING (empty): not migrated.
- DOKUMEN ISO and DAFTAR ARSIP ELEKTRONIK: hand-made layout sheets, reported as unknown.

## Sprint 2 sheets (migration 0010)

| Legacy | Column | Type |
| --- | --- | --- |
| MASTER_JENIS_NASKAH.SUBJENIS_NASKAH_ID | jenis_naskah.subjenis_naskah_id | t (PK with unit) |
| JENIS_NASKAH_ID / KATEGORI / SUBJENIS | jenis_naskah_id / kategori / subjenis | t |
| POLA_DEFAULT / PERIODE_DEFAULT / TEMPLATE_JUDUL_BERKAS | pola_default / periode_default / template_judul_berkas | t |
| PERLU_KELENGKAPAN / OPSI_KELENGKAPAN / AKTIF / URUTAN / CATATAN | perlu_kelengkapan / opsi_kelengkapan / aktif / urutan / catatan | b / t / b / i / t |
| LOG_CETAK_PENERIMAAN.CETAK_ID | penerimaan_cetak_log.id | t (append-only) |
| PENERIMAAN_ID / NOMOR_TANDA_TERIMA_SNAPSHOT / PRINT_TOKEN | penerimaan_id / nomor_tanda_terima_snapshot / print_token | t (token unique per unit) |
| CETAK_KE / JENIS_CETAK / STATUS_SNAPSHOT | cetak_ke / jenis_cetak / status_snapshot | i / t (PERTAMA, CETAK ULANG) / t |
| TIMESTAMP / USER_EMAIL / PDF_FILE_NAME | printed_at / user_email / pdf_file_name | ts / t / t |
