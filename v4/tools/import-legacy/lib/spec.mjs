// Legacy sheet -> v4 table mapping (see v4/supabase/LEGACY_COLUMN_MAP.md).
// Column entry: { h: header | [header, alias...], c: column, t: converter,
//   required?: header must exist and every row must have a parseable value,
//   def?: value used when the cell is blank (NOT NULL columns),
//   pii?: plaintext encrypted with app.encrypt_pii on write }
import {
  convert as cv, SECURITY, SATUAN, NASIB, TINGKAT, KONDISI, MEDIA_SUMBER, BENTUK_DIGITAL,
  VERIFIKASI, RECEIPT_STATUS, FILING_STATUS, JENIS_OBJEK, AUDIT_RESULT, enumOf, ValueError
} from './convert.mjs';

const T = cv.text, I = cv.int, B = cv.bool, D = cv.date, TS = cv.timestamp;

const audit = (createdRequired = true) => [
  { h: 'CREATED_AT', c: 'created_at', t: TS, required: createdRequired },
  { h: 'CREATED_BY', c: 'created_by', t: T },
  { h: 'UPDATED_AT', c: 'updated_at', t: TS, fallback: 'created_at' },
  { h: 'UPDATED_BY', c: 'updated_by', t: T }
];

export const TABLES = [
  {
    table: 'unit_settings', sheets: ['SETTINGS'], key: ['unit_id', 'key'], label: 'Pengaturan unit',
    columns: [
      { h: 'KEY', c: 'key', t: T, required: true },
      { h: 'VALUE', c: 'value', t: 'settingValue' },
      { h: 'TYPE', c: 'value_type', t: T, def: 'STRING' },
      { h: 'DESCRIPTION', c: 'description', t: T },
      { h: 'SCOPE', c: 'scope', t: T },
      { h: 'UPDATED_AT', c: 'updated_at', t: TS, keepWhenNull: true }
    ]
  },
  {
    table: 'klasifikasi', sheets: ['MASTER_KLASIFIKASI'], key: ['unit_id', 'id'], label: 'Klasifikasi',
    columns: [
      { h: 'KLASIFIKASI_ID', c: 'id', t: T, required: true },
      { h: 'PARENT_ID', c: 'parent_id', t: (v) => { const s = T(v); return s && s.toUpperCase() !== 'ROOT' ? s : null; } },
      { h: 'LEVEL', c: 'level', t: T },
      { h: 'KODE_LENGKAP', c: 'kode_lengkap', t: T, required: true },
      { h: 'URAIAN', c: 'uraian', t: T },
      { h: 'LABEL_DROPDOWN', c: 'label_dropdown', t: T },
      // legacy getClassificationData_: only TRUE is active, blank = inactive
      { h: 'AKTIF', c: 'aktif', t: B, def: false },
      { h: 'URUTAN', c: 'urutan', t: I },
      { h: 'KODE_PRIMER', c: 'kode_primer', t: T },
      { h: 'KODE_SEKUNDER', c: 'kode_sekunder', t: T },
      { h: 'KODE_TERSIER', c: 'kode_tersier', t: T },
      { h: 'STATUS_REVIEW', c: 'status_review', t: T },
      { h: 'SUMBER', c: 'sumber', t: T },
      { h: 'CATATAN', c: 'catatan', t: T },
      { h: 'UPDATED_AT', c: 'updated_at', t: TS, keepWhenNull: true }
    ]
  },
  {
    // Sprint 2: master jenis/subjenis naskah (SUBJENIS_NASKAH_ID unique per unit in the pilot)
    table: 'jenis_naskah', sheets: ['MASTER_JENIS_NASKAH'], key: ['unit_id', 'subjenis_naskah_id'], label: 'Jenis naskah',
    columns: [
      { h: 'SUBJENIS_NASKAH_ID', c: 'subjenis_naskah_id', t: T, required: true },
      { h: 'JENIS_NASKAH_ID', c: 'jenis_naskah_id', t: T, required: true },
      { h: 'KATEGORI', c: 'kategori', t: T },
      { h: 'SUBJENIS', c: 'subjenis', t: T },
      { h: 'POLA_DEFAULT', c: 'pola_default', t: T },
      { h: 'PERIODE_DEFAULT', c: 'periode_default', t: T },
      { h: 'TEMPLATE_JUDUL_BERKAS', c: 'template_judul_berkas', t: T },
      { h: 'PERLU_KELENGKAPAN', c: 'perlu_kelengkapan', t: B, def: false },
      { h: 'OPSI_KELENGKAPAN', c: 'opsi_kelengkapan', t: T },
      { h: 'AKTIF', c: 'aktif', t: B, def: false },
      { h: 'URUTAN', c: 'urutan', t: I },
      { h: 'CATATAN', c: 'catatan', t: T }
    ]
  },
  {
    table: 'pegawai', sheets: ['MASTER_PEGAWAI'], key: ['id'], label: 'Pegawai',
    columns: [
      { h: 'PEGAWAI_ID', c: 'id', t: T, required: true },
      { h: 'NAMA_PEGAWAI', c: 'nama_pegawai', t: T, required: true },
      { h: 'UNIT_KERJA', c: 'unit_kerja', t: T },
      // legacy receiptBoolean_: blank = inactive
      { h: 'AKTIF', c: 'aktif', t: B, def: false },
      // Not in RECEIPT_EMPLOYEE_HEADERS_; picked up if the real sheet has them.
      { h: ['NIP_NIK', 'NIP', 'NIK', 'NIP/NIK'], c: 'nip_nik_enc', t: T, pii: true },
      { h: ['NO_WHATSAPP', 'NO_HP', 'NO_TELEPON', 'TELEPON', 'KONTAK'], c: 'kontak_enc', t: T, pii: true },
      ...audit()
    ]
  },
  {
    table: 'berkas', sheets: ['DB_BERKAS'], key: ['id'], label: 'Berkas',
    columns: [
      { h: 'BERKAS_ID', c: 'id', t: T, required: true },
      { h: 'NO_BERKAS_DEFINITIF', c: 'no_berkas_definitif', t: I },
      { h: 'JUDUL_BERKAS', c: 'judul_berkas', t: T, required: true },
      { h: 'KATEGORI_NASKAH_ID', c: 'kategori_naskah_id', t: T },
      { h: 'POLA_PEMBERKASAN', c: 'pola_pemberkasan', t: T },
      { h: 'KLASIFIKASI_ID', c: 'klasifikasi_id', t: T },
      { h: 'KODE_KLASIFIKASI_SNAPSHOT', c: 'kode_klasifikasi_snapshot', t: T },
      { h: 'URAIAN_KLASIFIKASI_SNAPSHOT', c: 'uraian_klasifikasi_snapshot', t: T },
      { h: 'RETENSI_AKTIF_NILAI', c: 'retensi_aktif_nilai', t: I },
      { h: 'RETENSI_AKTIF_SATUAN', c: 'retensi_aktif_satuan', t: SATUAN },
      { h: 'RETENSI_INAKTIF_NILAI', c: 'retensi_inaktif_nilai', t: I },
      { h: 'RETENSI_INAKTIF_SATUAN', c: 'retensi_inaktif_satuan', t: SATUAN },
      { h: 'NASIB_AKHIR', c: 'nasib_akhir', t: NASIB },
      { h: 'STATUS_RETENSI', c: 'status_retensi', t: T },
      { h: 'TGL_ITEM_AWAL', c: 'tgl_item_awal', t: D },
      { h: 'TGL_ITEM_AKHIR', c: 'tgl_item_akhir', t: D },
      { h: 'TGL_URUT_BERKAS', c: 'tgl_urut_berkas', t: D },
      { h: 'TGL_ACUAN_RETENSI', c: 'tgl_acuan_retensi', t: D },
      { h: 'BATAS_AKTIF', c: 'batas_aktif', t: D },
      { h: 'BATAS_INAKTIF', c: 'batas_inaktif', t: D },
      { h: 'JUMLAH_ITEM', c: 'jumlah_item', t: I },
      { h: 'TOTAL_HALAMAN', c: 'total_halaman', t: I },
      { h: 'KURUN_WAKTU', c: 'kurun_waktu', t: T },
      { h: 'NO_FILLING_KABINET', c: 'no_filling_kabinet', t: T },
      { h: 'NO_LACI', c: 'no_laci', t: T },
      { h: 'NO_FOLDER', c: 'no_folder', t: T },
      { h: 'DRIVE_FOLDER_ID', c: 'drive_folder_id', t: T },
      { h: 'DRIVE_FOLDER_URL', c: 'drive_folder_url', t: T },
      { h: 'STATUS_PEMINJAMAN', c: 'status_peminjaman', t: T, def: 'TERSEDIA' },
      { h: 'STATUS_BERKAS', c: 'status_berkas', t: T, def: 'DRAFT' },
      { h: 'STATUS_PEMINDAHAN', c: 'status_pemindahan', t: T },
      { h: 'CATATAN', c: 'catatan', t: T },
      { h: 'PENCIPTA_ARSIP_SNAPSHOT', c: 'pencipta_arsip_snapshot', t: T },
      { h: 'UNIT_PENCIPTA_ID', c: 'unit_pencipta_id', t: T },
      { h: 'UNIT_PENCIPTA_SNAPSHOT', c: 'unit_pencipta_snapshot', t: T },
      { h: 'KLASIFIKASI_KEAMANAN_AKSES', c: 'klasifikasi_keamanan_akses', t: SECURITY },
      { h: 'ARSIP_VITAL', c: 'arsip_vital', t: B, def: false },
      { h: 'ARSIP_TERJAGA', c: 'arsip_terjaga', t: B, def: false },
      { h: 'MEDIA_BERKAS', c: 'media_berkas', t: T },
      { h: 'JUMLAH_ITEM_FISIK', c: 'jumlah_item_fisik', t: I },
      { h: 'JUMLAH_ITEM_BORN_DIGITAL', c: 'jumlah_item_born_digital', t: I },
      { h: 'JUMLAH_ITEM_ALIH_MEDIA', c: 'jumlah_item_alih_media', t: I },
      { h: 'STATUS_VERIFIKASI_METADATA', c: 'status_verifikasi_metadata', t: VERIFIKASI },
      { h: 'METADATA_SCHEMA_VERSION', c: 'metadata_schema_version', t: I },
      { h: 'USUL_PINDAH_ID_AKTIF', c: 'usul_pindah_id_aktif', t: T },
      { h: 'USUL_PINDAH_NO_AKTIF', c: 'usul_pindah_no_aktif', t: T },
      { h: 'JRA_ID', c: 'jra_id', t: T },
      { h: ['JRA_DASAR_HUKUM', 'DASAR_HUKUM_JRA'], c: 'jra_dasar_hukum', t: T },
      { h: ['JRA_VERSI', 'VERSI_JRA'], c: 'jra_versi', t: T },
      // found in the real pilot sheet (0007)
      { h: 'NO_BERKAS_LAMA', c: 'no_berkas_lama', t: T },
      { h: 'JRA_NAMA_SNAPSHOT', c: 'jra_nama_snapshot', t: T },
      { h: 'TGL_PEMINDAHAN', c: 'tgl_pemindahan', t: D },
      { h: 'BUKTI_PEMINDAHAN_FILE_ID', c: 'bukti_pemindahan_file_id', t: T },
      { h: 'BUKTI_PEMINDAHAN_FILE_URL', c: 'bukti_pemindahan_file_url', t: T },
      { h: 'DISETUJUI_PEMINDAHAN_OLEH', c: 'disetujui_pemindahan_oleh', t: T },
      { h: 'TGL_PERSETUJUAN_PEMINDAHAN', c: 'tgl_persetujuan_pemindahan', t: D },
      { h: 'CATATAN_PEMINDAHAN', c: 'catatan_pemindahan', t: T },
      { h: 'DELETED_AT', c: 'deleted_at', t: TS },
      ...audit(),
      { h: 'VERSION', c: 'version', t: I, def: 1 },
      { h: 'IS_DELETED', c: 'is_deleted', t: B, def: false }
    ]
  },
  {
    table: 'penerimaan', sheets: ['PENERIMAAN_ARSIP'], key: ['id'], label: 'Penerimaan (tanda terima)',
    columns: [
      { h: 'PENERIMAAN_ID', c: 'id', t: T, required: true },
      { h: 'NOMOR_TANDA_TERIMA', c: 'nomor_tanda_terima', t: T, required: true },
      { h: 'TAHUN', c: 'tahun', t: I, required: true },
      { h: 'TANGGAL_WAKTU_TERIMA', c: 'tanggal_waktu_terima', t: TS, required: true },
      { h: 'PENYERAH_PEGAWAI_ID', c: 'penyerah_pegawai_id', t: T },
      { h: 'NAMA_PENYERAH_SNAPSHOT', c: 'nama_penyerah_snapshot', t: T },
      { h: 'UNIT_PENYERAH_SNAPSHOT', c: 'unit_penyerah_snapshot', t: T },
      { h: 'NAMA_PENERIMA', c: 'nama_penerima', t: T },
      { h: 'UNIT_PENERIMA', c: 'unit_penerima', t: T },
      { h: 'LOKASI', c: 'lokasi', t: T },
      { h: 'CATATAN_UMUM', c: 'catatan_umum', t: T },
      { h: 'JUMLAH_ITEM', c: 'jumlah_item', t: I },
      { h: 'TOTAL_HALAMAN', c: 'total_halaman', t: I },
      { h: 'STATUS', c: 'status', t: RECEIPT_STATUS, def: 'AKTIF' },
      { h: 'BUKTI_TTD_FILE_ID', c: 'bukti_ttd_file_id', t: T },
      { h: 'BUKTI_TTD_URL', c: 'bukti_ttd_url', t: T },
      { h: 'BUKTI_TTD_NAMA', c: 'bukti_ttd_nama', t: T },
      { h: 'BUKTI_TTD_UPLOADED_AT', c: 'bukti_ttd_uploaded_at', t: TS },
      { h: 'BUKTI_TTD_UPLOADED_BY', c: 'bukti_ttd_uploaded_by', t: T },
      { h: 'ALASAN_PEMBATALAN', c: 'alasan_pembatalan', t: T },
      { h: 'BATAL_BUKTI_FILE_ID', c: 'batal_bukti_file_id', t: T },
      { h: 'BATAL_BUKTI_URL', c: 'batal_bukti_url', t: T },
      { h: 'BATAL_BUKTI_NAMA', c: 'batal_bukti_nama', t: T },
      { h: 'DIBATALKAN_AT', c: 'dibatalkan_at', t: TS },
      { h: 'DIBATALKAN_BY', c: 'dibatalkan_by', t: T },
      ...audit(),
      { h: 'VERSION', c: 'version', t: I, def: 1 }
    ]
  },
  {
    // Sprint 2: receipt print log (LOG_CETAK_PENERIMAAN), append-only
    table: 'penerimaan_cetak_log', sheets: ['LOG_CETAK_PENERIMAAN'], key: ['id'], appendOnly: true, label: 'Log cetak tanda terima',
    columns: [
      { h: 'CETAK_ID', c: 'id', t: T, required: true },
      { h: 'PENERIMAAN_ID', c: 'penerimaan_id', t: T, required: true },
      { h: 'NOMOR_TANDA_TERIMA_SNAPSHOT', c: 'nomor_tanda_terima_snapshot', t: T },
      { h: 'PRINT_TOKEN', c: 'print_token', t: T, required: true },
      { h: 'CETAK_KE', c: 'cetak_ke', t: I, required: true },
      { h: 'JENIS_CETAK', c: 'jenis_cetak', t: enumOf(['PERTAMA', 'CETAK ULANG']), required: true },
      { h: 'STATUS_SNAPSHOT', c: 'status_snapshot', t: T },
      { h: 'TIMESTAMP', c: 'printed_at', t: TS, required: true },
      { h: 'USER_EMAIL', c: 'user_email', t: T },
      { h: 'PDF_FILE_NAME', c: 'pdf_file_name', t: T }
    ]
  },
  {
    // Sprint 3: folder-label print log (LOG_CETAK_LIDAH), append-only. One row per berkas per print.
    table: 'folder_label_log', sheets: ['LOG_CETAK_LIDAH'], key: ['id'], appendOnly: true, label: 'Log cetak lidah folder',
    columns: [
      { h: 'PRINT_ID', c: 'id', t: T, required: true },
      { h: 'TIMESTAMP', c: 'printed_at', t: TS, required: true },
      { h: 'USER_EMAIL', c: 'user_email', t: T },
      { h: 'BATCH_ID', c: 'batch_id', t: T, required: true },
      { h: 'BERKAS_ID', c: 'berkas_id', t: T, required: true },
      { h: 'NO_BERKAS_SNAPSHOT', c: 'no_berkas_snapshot', t: T },
      { h: 'KODE_KLASIFIKASI_SNAPSHOT', c: 'kode_klasifikasi_snapshot', t: T },
      { h: 'JUDUL_BERKAS_SNAPSHOT', c: 'judul_berkas_snapshot', t: T },
      { h: 'START_SLOT', c: 'start_slot', t: (v) => {
        const n = I(v);
        if (n !== null && (n < 1 || n > 14)) throw new ValueError(`posisi awal ${n} di luar 1–14`);
        return n;
      } },
      { h: 'PDF_FILE_NAME', c: 'pdf_file_name', t: T },
      { h: 'STATUS', c: 'status', t: enumOf(['DICETAK'], { 'PDF DIBUAT': 'PDF_DIBUAT' }), def: 'PDF_DIBUAT' }
    ]
  },
  {
    table: 'item', sheets: ['DB_ITEM'], key: ['id'], label: 'Item arsip',
    columns: [
      { h: 'ITEM_ID', c: 'id', t: T, required: true },
      { h: 'BERKAS_ID', c: 'berkas_id', t: T, required: true },
      { h: 'NO_ITEM_DEFINITIF', c: 'no_item_definitif', t: I },
      { h: 'JENIS_NASKAH_ID', c: 'jenis_naskah_id', t: T },
      { h: 'SUBJENIS_NASKAH_ID', c: 'subjenis_naskah_id', t: T },
      { h: 'KELENGKAPAN', c: 'kelengkapan', t: T },
      { h: 'NO_SURAT_UTAMA', c: 'no_surat_utama', t: T },
      { h: 'NO_SURAT_ALTERNATIF', c: 'no_surat_alternatif', t: T },
      { h: 'NO_SURAT_DISPLAY', c: 'no_surat_display', t: T },
      { h: 'TANGGAL_NASKAH', c: 'tanggal_naskah', t: D },
      { h: 'TAHUN_KURUN_WAKTU', c: 'tahun_kurun_waktu', t: I },
      { h: 'URAIAN_LENGKAP', c: 'uraian_lengkap', t: T },
      { h: 'URAIAN_NAMA_FILE', c: 'uraian_nama_file', t: T },
      { h: 'JUMLAH_HALAMAN', c: 'jumlah_halaman', t: I },
      { h: 'TINGKAT_PERKEMBANGAN', c: 'tingkat_perkembangan', t: TINGKAT },
      { h: 'KLASIFIKASI_KEAMANAN_AKSES', c: 'klasifikasi_keamanan_akses', t: SECURITY },
      { h: 'KODE_KLASIFIKASI_SNAPSHOT', c: 'kode_klasifikasi_snapshot', t: T },
      { h: 'NO_BERKAS_SNAPSHOT', c: 'no_berkas_snapshot', t: I },
      { h: 'NAMA_FILE', c: 'nama_file', t: T },
      { h: 'DRIVE_FILE_ID', c: 'drive_file_id', t: T },
      { h: 'DRIVE_FILE_URL', c: 'drive_file_url', t: T },
      { h: 'MIME_TYPE', c: 'mime_type', t: T },
      { h: 'LAMPIRAN_JSON', c: 'lampiran', t: (v) => { const j = cv.json(v); if (j !== null && !Array.isArray(j)) throw new Error('LAMPIRAN_JSON bukan array'); return j; }, def: [] },
      { h: 'STATUS_FILE', c: 'status_file', t: T },
      { h: 'STATUS_PEMINJAMAN', c: 'status_peminjaman', t: T, def: 'TERSEDIA' },
      { h: 'SORT_NO_SURAT_NORMALIZED', c: 'sort_no_surat_normalized', t: T },
      { h: 'SORT_CREATED_AT', c: 'sort_created_at', t: T },
      { h: 'CATATAN', c: 'catatan', t: T },
      { h: 'ARSIP_ID', c: 'arsip_id', t: T },
      { h: 'SUMBER_REGISTRASI', c: 'sumber_registrasi', t: T },
      { h: 'PENERIMAAN_ID', c: 'penerimaan_id', t: T },
      { h: 'PENERIMAAN_ITEM_ID', c: 'penerimaan_item_id', t: T },
      { h: 'NOMOR_TANDA_TERIMA_SNAPSHOT', c: 'nomor_tanda_terima_snapshot', t: T },
      { h: 'KONDISI_FISIK', c: 'kondisi_fisik', t: T },
      { h: 'MEDIA_SUMBER', c: 'media_sumber', t: MEDIA_SUMBER },
      { h: 'STATUS_BENTUK_DIGITAL', c: 'status_bentuk_digital', t: BENTUK_DIGITAL },
      { h: 'CATATAN_MEDIA', c: 'catatan_media', t: T },
      { h: 'STATUS_VERIFIKASI_METADATA', c: 'status_verifikasi_metadata', t: VERIFIKASI },
      { h: 'METADATA_SCHEMA_VERSION', c: 'metadata_schema_version', t: I },
      // found in the real pilot sheet (0007)
      { h: 'NO_ITEM_LAMA', c: 'no_item_lama', t: T },
      { h: 'DELETED_AT', c: 'deleted_at', t: TS },
      ...audit(),
      { h: 'VERSION', c: 'version', t: I, def: 1 },
      { h: 'IS_DELETED', c: 'is_deleted', t: B, def: false }
    ]
  },
  {
    table: 'penerimaan_item', sheets: ['PENERIMAAN_ITEM'], key: ['id'], label: 'Item penerimaan',
    columns: [
      { h: 'PENERIMAAN_ITEM_ID', c: 'id', t: T, required: true },
      { h: 'PENERIMAAN_ID', c: 'penerimaan_id', t: T, required: true },
      { h: 'NO_ITEM', c: 'no_item', t: I },
      { h: 'URAIAN_INFORMASI', c: 'uraian_informasi', t: T },
      { h: 'JUMLAH_HALAMAN', c: 'jumlah_halaman', t: I },
      { h: 'TINGKAT_PERKEMBANGAN', c: 'tingkat_perkembangan', t: TINGKAT },
      { h: 'KONDISI', c: 'kondisi', t: KONDISI },
      { h: 'KLASIFIKASI_KEAMANAN_AKSES', c: 'klasifikasi_keamanan_akses', t: SECURITY },
      { h: 'ARSIP_ID', c: 'arsip_id', t: T },
      { h: 'NO_SURAT_UTAMA', c: 'no_surat_utama', t: T },
      { h: 'NO_SURAT_ALTERNATIF', c: 'no_surat_alternatif', t: T },
      { h: 'TANGGAL_NASKAH', c: 'tanggal_naskah', t: D },
      { h: 'CATATAN_ITEM', c: 'catatan_item', t: T },
      { h: 'STATUS_PEMBERKASAN', c: 'status_pemberkasan', t: FILING_STATUS },
      { h: 'BERKAS_ID_TUJUAN', c: 'berkas_id_tujuan', t: T },
      { h: 'ITEM_ID_DEFINITIF', c: 'item_id_definitif', t: T },
      { h: 'NO_BERKAS_DEFINITIF_SNAPSHOT', c: 'no_berkas_definitif_snapshot', t: I },
      { h: 'NO_ITEM_DEFINITIF_SNAPSHOT', c: 'no_item_definitif_snapshot', t: I },
      { h: 'DIBERKASKAN_AT', c: 'diberkaskan_at', t: TS },
      { h: 'DIBERKASKAN_BY', c: 'diberkaskan_by', t: T },
      { h: 'PEMBERKASAN_REQUEST_ID', c: 'pemberkasan_request_id', t: T },
      { h: 'MEDIA_SUMBER', c: 'media_sumber', t: MEDIA_SUMBER },
      { h: 'STATUS_BENTUK_DIGITAL', c: 'status_bentuk_digital', t: BENTUK_DIGITAL },
      { h: 'CATATAN_MEDIA', c: 'catatan_media', t: T },
      { h: 'FILE_DIGITAL_ID', c: 'file_digital_id', t: T },
      { h: 'FILE_DIGITAL_URL', c: 'file_digital_url', t: T },
      { h: 'FILE_DIGITAL_MIME_TYPE', c: 'file_digital_mime_type', t: T },
      { h: 'STATUS_VERIFIKASI_METADATA', c: 'status_verifikasi_metadata', t: VERIFIKASI },
      { h: 'METADATA_SCHEMA_VERSION', c: 'metadata_schema_version', t: I },
      ...audit(),
      { h: 'IS_DELETED', c: 'is_deleted', t: B, def: false },
      { h: 'DELETED_AT', c: 'deleted_at', t: TS },
      { h: 'DELETED_BY', c: 'deleted_by', t: T }
    ]
  },
  {
    table: 'riwayat_nomor', sheets: ['RIWAYAT_NOMOR'], key: ['id'], appendOnly: true, label: 'Riwayat nomor',
    columns: [
      { h: 'RIWAYAT_ID', c: 'id', t: T, required: true },
      { h: 'JENIS_OBJEK', c: 'jenis_objek', t: JENIS_OBJEK, required: true },
      { h: 'OBJEK_ID', c: 'objek_id', t: T, required: true },
      { h: 'BERKAS_ID', c: 'berkas_id', t: T },
      { h: 'NOMOR_LAMA', c: 'nomor_lama', t: 'looseInt' },
      { h: 'NOMOR_BARU', c: 'nomor_baru', t: 'looseInt' },
      { h: 'NAMA_LAMA', c: 'nama_lama', t: T },
      { h: 'NAMA_BARU', c: 'nama_baru', t: T },
      { h: 'ALASAN', c: 'alasan', t: T },
      { h: 'BATCH_RENUMBER_ID', c: 'batch_renumber_id', t: T },
      { h: 'DIKONFIRMASI_OLEH', c: 'dikonfirmasi_oleh', t: T },
      { h: 'DIKONFIRMASI_AT', c: 'dikonfirmasi_at', t: TS },
      { h: 'CREATED_AT', c: 'created_at', t: TS, required: true },
      { h: 'CREATED_BY', c: 'created_by', t: T },
      { h: 'CATATAN', c: 'catatan', t: T }
    ]
  },
  {
    // AUDIT_LOG plus yearly rollover sheets AUDIT_LOG_<YYYY> (ReliabilityService.rolloverAuditLogIfNeeded_)
    table: 'audit_log', sheets: ['AUDIT_LOG'], sheetPattern: /^AUDIT_LOG_\d{4}$/, key: ['id'], appendOnly: true,
    label: 'Audit log',
    columns: [
      { h: 'LOG_ID', c: 'id', t: T, required: true },
      { h: 'TIMESTAMP', c: 'occurred_at', t: TS, required: true },
      { h: 'USER_EMAIL', c: 'actor_email_snapshot', t: T },
      { h: 'AKSI', c: 'action', t: T, required: true },
      { h: 'MODUL', c: 'module', t: T },
      { h: 'JENIS_OBJEK', c: 'object_type', t: T },
      { h: 'OBJEK_ID', c: 'object_id', t: T },
      { h: 'RINGKASAN', c: 'summary', t: T },
      { h: 'ALASAN', c: 'reason', t: T },
      { h: 'REQUEST_ID', c: 'request_id', t: T },
      { h: 'STATUS', c: 'result', t: AUDIT_RESULT, def: 'SUCCESS' },
      { h: 'DATA_SEBELUM_JSON', c: 'before_data', t: cv.json },
      { h: 'DATA_SESUDAH_JSON', c: 'after_data', t: cv.json },
      { h: 'IP_INFO', c: 'ip_info', t: T },
      { h: 'CATATAN', c: 'catatan', t: T }
    ]
  }
];

// Sheets that exist in 3.32.5 but whose tables are not in the v4 schema yet.
export const DEFERRED_SHEETS = {
  'PEMINJAMAN': { sprint: 4, module: 'Peminjaman' },
  'LOG_CETAK_OUT_INDICATOR': { sprint: 4, module: 'Peminjaman (log cetak Out Indicator)' },
  'LOG_CETAK_BERITA_ACARA': { sprint: 4, module: 'Peminjaman (log cetak Berita Acara)' },
  'USUL_PINDAH': { sprint: 5, module: 'Usul pemindahan' },
  'USUL_PINDAH_DETAIL': { sprint: 5, module: 'Usul pemindahan (detail berkas)' },
  'USUL_PINDAH_ITEM': { sprint: 5, module: 'Usul pemindahan (detail item)' },
  'OUTBOX_RECORD_CENTER': { sprint: 5, module: 'Federasi Record Center (outbox)' },
  'SYSTEM_MIGRATIONS': { sprint: 3, module: 'Sistem (riwayat migrasi Apps Script)' },
  'SYSTEM_BACKUPS': { sprint: 3, module: 'Sistem (backup)' },
  'SYSTEM_JOBS': { sprint: 3, module: 'Sistem (pekerjaan terjadwal)' },
  'SYSTEM_JOB_QUEUE': { sprint: 3, module: 'Sistem (antrean pekerjaan)' },
  'SYSTEM_HEALTH_LOG': { sprint: 3, module: 'Sistem (health)' },
  'SYSTEM_QUARANTINE': { sprint: 3, module: 'Sistem (karantina)' },
  'DB_SEARCH_DOCUMENTS': { sprint: 6, module: 'Cari Isi Berkas (indeks isi)' },
  // found in the real pilot export
  'MASTER_JRA': { sprint: 5, module: 'Master JRA (retensi)' },
  'IMPORT_STAGING': { sprint: null, module: 'Staging impor massal lama — tidak ada padanan v4' }
};

// Derived report sheets: not imported, used to cross-check totals.
export const REPORT_SHEETS = { berkas: 'DAFTAR BERKAS', item: 'DAFTAR ISI BERKAS' };

// Columns flagged as uncertain in Sprint 0; the report shows what the export really contains.
export const OPEN_QUESTIONS = [
  { sheet: 'MASTER_KLASIFIKASI', headers: ['LEVEL'], question: 'Format kolom LEVEL (angka atau nama tingkat)?' },
  { sheet: 'DB_BERKAS', headers: ['JRA_ID'], question: 'Apakah DB_BERKAS memiliki JRA_ID?' },
  { sheet: 'DB_BERKAS', headers: ['JRA_DASAR_HUKUM', 'DASAR_HUKUM_JRA'], question: 'Nama kolom dasar hukum JRA di DB_BERKAS?' },
  { sheet: 'DB_BERKAS', headers: ['JRA_VERSI', 'VERSI_JRA'], question: 'Nama kolom versi JRA di DB_BERKAS?' },
  { sheet: 'DB_BERKAS', headers: ['TAHUN'], question: 'Apakah DB_BERKAS memiliki kolom TAHUN (tidak dipetakan)?' },
  { sheet: 'DB_BERKAS', headers: ['STATUS_PEMINDAHAN'], question: 'Nilai apa saja yang ada di STATUS_PEMINDAHAN?' },
  { sheet: 'DB_BERKAS', headers: ['MEDIA_BERKAS'], question: 'Nilai apa saja yang ada di MEDIA_BERKAS?' },
  { sheet: 'DB_ITEM', headers: ['KONDISI_FISIK'], question: 'Nilai apa saja yang ada di KONDISI_FISIK (DB_ITEM)?' },
  { sheet: 'DB_ITEM', headers: ['DELETED_AT', 'DELETED_BY'], question: 'Apakah DB_ITEM memiliki DELETED_AT/DELETED_BY?' },
  { sheet: 'DB_ITEM', headers: ['ARSIP_ID'], question: 'Apakah ARSIP_ID unik per unit?', check: 'unique' },
  { sheet: 'RIWAYAT_NOMOR', headers: ['NOMOR_LAMA', 'NOMOR_BARU'], question: 'Apakah NOMOR_LAMA/NOMOR_BARU selalu angka?', check: 'integer' },
  { sheet: 'MASTER_PEGAWAI', headers: ['NIP_NIK', 'NIP', 'NIK', 'NIP/NIK', 'NO_WHATSAPP', 'NO_HP', 'NO_TELEPON', 'TELEPON', 'KONTAK'], question: 'Apakah MASTER_PEGAWAI menyimpan data pribadi (NIP/NIK, kontak)?', sensitive: true }
];

// unit_settings keys that must never be imported (same rule as the DB check constraint).
export const SECRET_KEY_RE = /(SECRET|PASSWORD|TOKEN|PRIVATE_KEY|API_KEY)/;
// SETTINGS.TYPE values that mark a secret regardless of the key name (real pilot export uses TYPE=SECRET).
export const SECRET_TYPES = ['SECRET', 'PASSWORD'];
