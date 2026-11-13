// Synthetic legacy export (fictional data only) with the awkward cases the
// importer must handle. fixtureDefinition() returns a plain object that tests
// may modify before writeFixture() turns it into an .xlsx file.
//
//   node test/fixture.mjs out.xlsx   -> writes the default fixture
import ExcelJS from 'exceljs';

const D = (y, m, d, hh = 0, mi = 0) => new Date(Date.UTC(y, m - 1, d, hh, mi)); // wall-clock date cell
const serial = (y, m, d) => (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000; // raw serial number
const link = (url) => ({ text: url, hyperlink: url });

export const FIXTURE_UNIT = { code: 'UJI', name: 'Unit Uji Fiktif', instanceId: 'INS-UJI-0001' };

export function fixtureDefinition() {
  const sheets = {};

  sheets.SETTINGS = {
    headers: ['KEY', 'VALUE', 'TYPE', 'DESCRIPTION', 'SCOPE', 'UPDATED_AT'],
    rows: [
      { KEY: 'INSTANCE_ID', VALUE: 'INS-UJI-0001', TYPE: 'STRING', DESCRIPTION: 'ID instance', SCOPE: 'GLOBAL', UPDATED_AT: '2025-01-01T01:02:03.456Z' },
      { KEY: 'UNIT_ID', VALUE: 'UNIT-UJI', TYPE: 'STRING', DESCRIPTION: 'ID unit' },
      { KEY: 'UNIT_CODE', VALUE: 'UJI', TYPE: 'STRING' },
      { KEY: 'UNIT_NAME', VALUE: 'Unit Uji Fiktif', TYPE: 'STRING' },
      { KEY: 'ARCHIVE_CREATOR_NAME', VALUE: 'Universitas Contoh', TYPE: 'STRING' },
      { KEY: 'AUDIT_LOG_YEAR', VALUE: 2026, TYPE: 'NUMBER', DESCRIPTION: 'Tahun audit log aktif' },
      { KEY: 'BACKUP_DAILY_ENABLED', VALUE: true, TYPE: 'BOOLEAN' },
      { KEY: 'BA_PIMPINAN_NIP', VALUE: '000000000000000000', TYPE: 'STRING', DESCRIPTION: 'NIP fiktif' },
      { KEY: 'RECORD_CENTER_SHARED_SECRET', VALUE: 'rahasia-fiktif-jangan-diimpor', TYPE: 'STRING' },
      // real export marks secrets with TYPE=SECRET; the key name alone would not reveal it
      { KEY: 'RC_KUNCI_BERSAMA', VALUE: 'nilai-rahasia-tipe', TYPE: 'SECRET', SCOPE: 'RECORD_CENTER' }
    ]
  };

  sheets.MASTER_KLASIFIKASI = {
    headers: ['KLASIFIKASI_ID', 'LEVEL', 'PARENT_ID', 'KODE_PRIMER', 'KODE_SEKUNDER', 'KODE_TERSIER', 'KODE_LENGKAP', 'URAIAN',
      'LABEL_DROPDOWN', 'URUTAN', 'AKTIF', 'STATUS_REVIEW', 'SUMBER', 'CATATAN', 'UPDATED_AT'],
    rows: [
      { KLASIFIKASI_ID: 'K-PR', PARENT_ID: '', LEVEL: 'PRIMER', KODE_PRIMER: 'PR', KODE_LENGKAP: 'PR', STATUS_REVIEW: 'DISETUJUI', SUMBER: 'Pedoman fiktif', URAIAN: 'Perencanaan', LABEL_DROPDOWN: 'PR – Perencanaan', AKTIF: true, URUTAN: 1 },
      { KLASIFIKASI_ID: 'K-PR01', PARENT_ID: 'K-PR', LEVEL: 'SEKUNDER', KODE_PRIMER: 'PR', KODE_SEKUNDER: '01', KODE_LENGKAP: 'PR.01', STATUS_REVIEW: 'DISETUJUI', UPDATED_AT: '2025-02-03T04:05:06.789Z', URAIAN: 'Rencana strategis', AKTIF: 'TRUE', URUTAN: 2 },
      { KLASIFIKASI_ID: 'K-PR0101', PARENT_ID: 'K-PR01', LEVEL: 'TERSIER', KODE_PRIMER: 'PR', KODE_SEKUNDER: '01', KODE_TERSIER: '01', KODE_LENGKAP: 'PR.01.01', CATATAN: 'catatan fiktif', UPDATED_AT: '2025-02-03T04:05:06.789Z', URAIAN: 'Renstra', AKTIF: true, URUTAN: 3 },
      { KLASIFIKASI_ID: 'K-KU', PARENT_ID: 'ROOT', LEVEL: 'PRIMER', KODE_LENGKAP: 'KU', URAIAN: 'Keuangan', AKTIF: true, URUTAN: 4 },
      // secondary without tertiary children (FIX 3.30.6)
      { KLASIFIKASI_ID: 'K-KU02', PARENT_ID: 'K-KU', LEVEL: 'SEKUNDER', KODE_LENGKAP: 'KU.02', URAIAN: 'Pelaksanaan anggaran', AKTIF: true, URUTAN: 5 },
      { KLASIFIKASI_ID: 'K-LAMA', PARENT_ID: 'K-KU', LEVEL: 'SEKUNDER', KODE_LENGKAP: 'KU.99', URAIAN: 'Kode lama (nonaktif)', AKTIF: '', URUTAN: 6 }
    ]
  };

  sheets.MASTER_PEGAWAI = {
    // NIP is not a 3.32.5 header: exercises the PII path
    headers: ['PEGAWAI_ID', 'NAMA_PEGAWAI', 'UNIT_KERJA', 'AKTIF', 'NIP', 'CREATED_AT', 'CREATED_BY', 'UPDATED_AT', 'UPDATED_BY'],
    rows: [
      { PEGAWAI_ID: 'PGW-1', NAMA_PEGAWAI: 'Budi Fiktif', UNIT_KERJA: 'Subbagian Contoh', AKTIF: true, NIP: '199001012020121001', CREATED_AT: '2025-01-02T08:00:00+07:00', CREATED_BY: 'petugas@contoh.invalid' },
      { PEGAWAI_ID: 'PGW-2', NAMA_PEGAWAI: 'Sari Fiktif', UNIT_KERJA: 'Subbagian Contoh', AKTIF: false, NIP: '', CREATED_AT: '2025-01-02T08:05:00+07:00', CREATED_BY: 'petugas@contoh.invalid', UPDATED_AT: '2025-06-01T10:00:00+07:00', UPDATED_BY: 'admin@contoh.invalid' }
    ]
  };

  const berkasHeaders = [
    // deliberately not the legacy order; MEDIA_BERKAS and JRA_* missing; one extra column
    'JUDUL_BERKAS', 'BERKAS_ID', 'NO_BERKAS_DEFINITIF', 'KLASIFIKASI_ID', 'KODE_KLASIFIKASI_SNAPSHOT',
    'URAIAN_KLASIFIKASI_SNAPSHOT', 'KATEGORI_NASKAH_ID', 'POLA_PEMBERKASAN',
    'RETENSI_AKTIF_NILAI', 'RETENSI_AKTIF_SATUAN', 'RETENSI_INAKTIF_NILAI', 'RETENSI_INAKTIF_SATUAN', 'NASIB_AKHIR',
    'STATUS_RETENSI', 'TGL_ITEM_AWAL', 'TGL_ITEM_AKHIR', 'TGL_URUT_BERKAS', 'TGL_ACUAN_RETENSI', 'BATAS_AKTIF', 'BATAS_INAKTIF',
    'JUMLAH_ITEM', 'TOTAL_HALAMAN', 'KURUN_WAKTU', 'NO_FILLING_KABINET', 'NO_LACI', 'NO_FOLDER',
    'DRIVE_FOLDER_ID', 'DRIVE_FOLDER_URL', 'STATUS_PEMINJAMAN', 'STATUS_BERKAS', 'STATUS_PEMINDAHAN', 'CATATAN',
    'PENCIPTA_ARSIP_SNAPSHOT', 'UNIT_PENCIPTA_ID', 'UNIT_PENCIPTA_SNAPSHOT', 'KLASIFIKASI_KEAMANAN_AKSES',
    'ARSIP_VITAL', 'ARSIP_TERJAGA', 'JUMLAH_ITEM_FISIK', 'JUMLAH_ITEM_BORN_DIGITAL', 'JUMLAH_ITEM_ALIH_MEDIA',
    'STATUS_VERIFIKASI_METADATA', 'METADATA_SCHEMA_VERSION', 'USUL_PINDAH_ID_AKTIF', 'USUL_PINDAH_NO_AKTIF',
    'IS_DELETED', 'VERSION', 'UPDATED_BY', 'UPDATED_AT', 'CREATED_BY', 'CREATED_AT', 'KOLOM_LAMA_X',
    // present in real sheets, absent from the 3.32.5 code
    'NO_BERKAS_LAMA', 'JRA_NAMA_SNAPSHOT', 'TGL_PEMINDAHAN', 'BUKTI_PEMINDAHAN_FILE_ID', 'DELETED_AT',
    'DISETUJUI_PEMINDAHAN_OLEH', 'TGL_PERSETUJUAN_PEMINDAHAN', 'CATATAN_PEMINDAHAN', 'BUKTI_PEMINDAHAN_FILE_URL'
  ];
  const ret = { RETENSI_AKTIF_NILAI: 2, RETENSI_AKTIF_SATUAN: 'TAHUN', RETENSI_INAKTIF_NILAI: 3, RETENSI_INAKTIF_SATUAN: 'tahun', NASIB_AKHIR: 'PERMANEN' };
  sheets.DB_BERKAS = {
    headers: berkasHeaders,
    rows: [
      { BERKAS_ID: 'BRK-1', NO_BERKAS_DEFINITIF: 1, JUDUL_BERKAS: 'Renstra 2025 (fiktif)', KLASIFIKASI_ID: 'K-PR0101', KODE_KLASIFIKASI_SNAPSHOT: 'PR.01.01', URAIAN_KLASIFIKASI_SNAPSHOT: 'Renstra', ...ret,
        STATUS_RETENSI: 'AKTIF', TGL_ITEM_AWAL: D(2025, 1, 15), TGL_ITEM_AKHIR: D(2025, 3, 10), TGL_URUT_BERKAS: D(2025, 1, 15), TGL_ACUAN_RETENSI: D(2025, 3, 10), BATAS_AKTIF: D(2027, 3, 10), BATAS_INAKTIF: D(2030, 3, 10),
        JUMLAH_ITEM: 2, TOTAL_HALAMAN: 14, KURUN_WAKTU: 2025, NO_FILLING_KABINET: '1', NO_LACI: 1, NO_FOLDER: 1,
        DRIVE_FOLDER_ID: 'drv-folder-1', DRIVE_FOLDER_URL: link('https://drive.google.com/drive/folders/drv-folder-1'),
        STATUS_PEMINJAMAN: 'TERSEDIA', STATUS_BERKAS: 'AKTIF', KLASIFIKASI_KEAMANAN_AKSES: 'BIASA/TERBUKA', ARSIP_VITAL: 'YA', ARSIP_TERJAGA: false,
        STATUS_VERIFIKASI_METADATA: 'TERVERIFIKASI', METADATA_SCHEMA_VERSION: 4, IS_DELETED: false, VERSION: 5,
        CREATED_AT: '2025-01-15T09:00:00+07:00', CREATED_BY: 'petugas@contoh.invalid', UPDATED_AT: D(2025, 3, 11, 10, 15), UPDATED_BY: 'petugas@contoh.invalid', KOLOM_LAMA_X: 'abaikan', NO_BERKAS_LAMA: '12' },
      // renumbered (was 1), secondary classification without tertiary, text dates, wrong TOTAL_HALAMAN
      { BERKAS_ID: 'BRK-2', NO_BERKAS_DEFINITIF: '2', JUDUL_BERKAS: 'Pelaksanaan anggaran 2026 (fiktif)', KLASIFIKASI_ID: 'K-KU02', KODE_KLASIFIKASI_SNAPSHOT: 'KU.02', ...ret, NASIB_AKHIR: 'musnah',
        STATUS_RETENSI: 'AKTIF', TGL_ITEM_AWAL: '01/02/2026', TGL_ITEM_AKHIR: '01/02/2026', TGL_URUT_BERKAS: '01/02/2026', TGL_ACUAN_RETENSI: '1/2/2026', BATAS_AKTIF: '01/02/2028', BATAS_INAKTIF: '01-02-2031',
        JUMLAH_ITEM: 1, TOTAL_HALAMAN: 5, KURUN_WAKTU: '2026', NO_FILLING_KABINET: 'A', NO_LACI: '2', NO_FOLDER: '2',
        STATUS_BERKAS: 'AKTIF', KLASIFIKASI_KEAMANAN_AKSES: 'Terbatas', ARSIP_VITAL: '', IS_DELETED: 'FALSE', VERSION: 3,
        CREATED_AT: '15/01/2026 09:30', CREATED_BY: 'petugas@contoh.invalid' },
      // soft-deleted berkas re-using number 2
      { BERKAS_ID: 'BRK-3', NO_BERKAS_DEFINITIF: 2, JUDUL_BERKAS: 'Berkas salah input (dihapus)', KLASIFIKASI_ID: 'K-KU02', ...ret,
        STATUS_BERKAS: 'DIHAPUS', IS_DELETED: true, VERSION: 2, CATATAN: 'Dihapus: salah input', CREATED_AT: '2026-01-20T10:00:00+07:00', DELETED_AT: '2026-01-21T08:00:00+07:00' },
      // draft, dangling classification, lowercase security alias
      { BERKAS_ID: 'BRK-4', NO_BERKAS_DEFINITIF: '', JUDUL_BERKAS: 'Draft tanpa item (fiktif)', KLASIFIKASI_ID: 'K-HILANG', ...ret,
        STATUS_RETENSI: 'MENUNGGU ITEM', STATUS_BERKAS: 'DRAFT', KLASIFIKASI_KEAMANAN_AKSES: 'biasa', CREATED_AT: D(2026, 2, 3, 14, 0) },
      // transferred to Record Center: not active
      { BERKAS_ID: 'BRK-5', NO_BERKAS_DEFINITIF: 3, JUDUL_BERKAS: 'Berkas lama sudah dipindahkan', KLASIFIKASI_ID: 'K-PR01', ...ret,
        STATUS_BERKAS: 'AKTIF', STATUS_PEMINDAHAN: 'SUDAH DIPINDAHKAN', JUMLAH_ITEM: 1, TOTAL_HALAMAN: 4, CREATED_AT: '2020-05-05T08:00:00+07:00',
        TGL_PEMINDAHAN: D(2025, 6, 30), TGL_PERSETUJUAN_PEMINDAHAN: '20/06/2025', DISETUJUI_PEMINDAHAN_OLEH: 'Pejabat Fiktif', CATATAN_PEMINDAHAN: 'Dipindah ke RC (fiktif)' }
    ]
  };

  sheets.DB_ITEM = {
    headers: [
      'ITEM_ID', 'BERKAS_ID', 'NO_ITEM_DEFINITIF', 'JENIS_NASKAH_ID', 'SUBJENIS_NASKAH_ID', 'KELENGKAPAN',
      'NO_SURAT_UTAMA', 'NO_SURAT_ALTERNATIF', 'NO_SURAT_DISPLAY', 'TANGGAL_NASKAH', 'TAHUN_KURUN_WAKTU',
      'URAIAN_LENGKAP', 'URAIAN_NAMA_FILE', 'JUMLAH_HALAMAN', 'TINGKAT_PERKEMBANGAN', 'KLASIFIKASI_KEAMANAN_AKSES',
      'KODE_KLASIFIKASI_SNAPSHOT', 'NO_BERKAS_SNAPSHOT', 'NAMA_FILE', 'DRIVE_FILE_ID', 'DRIVE_FILE_URL', 'MIME_TYPE',
      'LAMPIRAN_JSON', 'STATUS_FILE', 'STATUS_PEMINJAMAN', 'SORT_NO_SURAT_NORMALIZED', 'SORT_CREATED_AT', 'CATATAN',
      'CREATED_AT', 'CREATED_BY', 'UPDATED_AT', 'UPDATED_BY', 'VERSION', 'IS_DELETED',
      'ARSIP_ID', 'SUMBER_REGISTRASI', 'PENERIMAAN_ID', 'PENERIMAAN_ITEM_ID', 'NOMOR_TANDA_TERIMA_SNAPSHOT', 'KONDISI_FISIK',
      'MEDIA_SUMBER', 'STATUS_BENTUK_DIGITAL', 'CATATAN_MEDIA', 'STATUS_VERIFIKASI_METADATA', 'METADATA_SCHEMA_VERSION',
      'KOLOM_TAMBAHAN', 'NO_ITEM_LAMA', 'DELETED_AT'
    ],
    rows: [
      { ITEM_ID: 'ITM-1', BERKAS_ID: 'BRK-1', NO_ITEM_DEFINITIF: 1, NO_SURAT_UTAMA: 'B-001/FIKTIF/2025', NO_SURAT_DISPLAY: 'B-001/FIKTIF/2025',
        TANGGAL_NASKAH: D(2025, 1, 15), TAHUN_KURUN_WAKTU: 2025, URAIAN_LENGKAP: 'Draf renstra', URAIAN_NAMA_FILE: 'Draf renstra', JUMLAH_HALAMAN: 8,
        TINGKAT_PERKEMBANGAN: 'ASLI', KLASIFIKASI_KEAMANAN_AKSES: 'BIASA/TERBUKA', KODE_KLASIFIKASI_SNAPSHOT: 'PR.01.01', NO_BERKAS_SNAPSHOT: 1,
        NAMA_FILE: '1_1_Draf renstra.pdf', DRIVE_FILE_ID: 'drv-file-1', DRIVE_FILE_URL: link('https://drive.google.com/file/d/drv-file-1/view'), MIME_TYPE: 'application/pdf',
        LAMPIRAN_JSON: '[]', STATUS_FILE: 'TERSEDIA', STATUS_PEMINJAMAN: 'TERSEDIA', SORT_NO_SURAT_NORMALIZED: 'B 001 FIKTIF 2025', SORT_CREATED_AT: '2025-01-15T09:00:00+07:00',
        CREATED_AT: '2025-01-15T09:00:00+07:00', CREATED_BY: 'petugas@contoh.invalid', VERSION: 2, IS_DELETED: false,
        ARSIP_ID: 'ITM-1', SUMBER_REGISTRASI: 'INPUT_MANUAL', MEDIA_SUMBER: 'TEKSTUAL', STATUS_BENTUK_DIGITAL: 'ALIH MEDIA', STATUS_VERIFIKASI_METADATA: 'TERVERIFIKASI', METADATA_SCHEMA_VERSION: 4, KOLOM_TAMBAHAN: 'x' },
      { ITEM_ID: 'ITM-2', BERKAS_ID: 'BRK-1', NO_ITEM_DEFINITIF: 2, NO_SURAT_UTAMA: 'B-014/FIKTIF/2025',
        TANGGAL_NASKAH: serial(2025, 3, 10), TAHUN_KURUN_WAKTU: 2025, URAIAN_LENGKAP: 'Renstra final', JUMLAH_HALAMAN: 6,
        TINGKAT_PERKEMBANGAN: 'copy', NO_BERKAS_SNAPSHOT: 1, LAMPIRAN_JSON: '[{"nama":"lampiran.pdf","id":"drv-lamp-1"}]', STATUS_FILE: 'BELUM DIUNGGAH',
        SORT_CREATED_AT: '2025-03-11T09:00:00+07:00-001', CREATED_AT: '2025-03-11T09:00:00+07:00', VERSION: 1, IS_DELETED: false,
        ARSIP_ID: 'ITM-2', SUMBER_REGISTRASI: 'INPUT_MANUAL', MEDIA_SUMBER: 'audiovisual', STATUS_BENTUK_DIGITAL: 'TIDAK ADA' },
      // filed from a receipt
      { ITEM_ID: 'ITM-3', BERKAS_ID: 'BRK-2', NO_ITEM_DEFINITIF: 1, NO_SURAT_UTAMA: 'KU-100/FIKTIF/2026',
        TANGGAL_NASKAH: '01/02/2026', TAHUN_KURUN_WAKTU: 2026, URAIAN_LENGKAP: 'SPJ kegiatan', JUMLAH_HALAMAN: 3, TINGKAT_PERKEMBANGAN: 'ASLI',
        KLASIFIKASI_KEAMANAN_AKSES: 'TERBATAS', NO_BERKAS_SNAPSHOT: 2, CREATED_AT: '2026-02-02T11:00:00+07:00', VERSION: 1, IS_DELETED: false,
        ARSIP_ID: 'ARS-1', SUMBER_REGISTRASI: 'PENERIMAAN_ARSIP', PENERIMAAN_ID: 'RCV-1', PENERIMAAN_ITEM_ID: 'RCVI-1', NOMOR_TANDA_TERIMA_SNAPSHOT: 'TRM-2026-0001', KONDISI_FISIK: 'BAIK' },
      // soft-deleted item keeping the same number
      { ITEM_ID: 'ITM-4', BERKAS_ID: 'BRK-2', NO_ITEM_DEFINITIF: 1, URAIAN_LENGKAP: 'Duplikat (dihapus)', TANGGAL_NASKAH: '2026-02-01', JUMLAH_HALAMAN: 2,
        STATUS_FILE: 'DIHAPUS', CATATAN: 'Dihapus: duplikat', CREATED_AT: '2026-02-02T11:05:00+07:00', IS_DELETED: 'TRUE', DELETED_AT: '2026-02-03T09:00:00+07:00', NO_ITEM_LAMA: '7' },
      // orphan: berkas does not exist
      { ITEM_ID: 'ITM-5', BERKAS_ID: 'BRK-TIDAK-ADA', NO_ITEM_DEFINITIF: 1, URAIAN_LENGKAP: 'Item yatim', JUMLAH_HALAMAN: 1, CREATED_AT: '2026-02-03T08:00:00+07:00' },
      // in a transferred berkas; ARSIP_ID without source
      { ITEM_ID: 'ITM-6', BERKAS_ID: 'BRK-5', NO_ITEM_DEFINITIF: 1, URAIAN_LENGKAP: 'Item berkas lama', TANGGAL_NASKAH: '5 Mei 2020', JUMLAH_HALAMAN: 4,
        CREATED_AT: '2020-05-05T08:00:00+07:00', ARSIP_ID: 'ARS-HILANG', SUMBER_REGISTRASI: 'PENERIMAAN_ARSIP' },
      // blank trailing rows
      {}, { URAIAN_LENGKAP: '   ' }, {}
    ]
  };

  sheets.PENERIMAAN_ARSIP = {
    headers: [
      'PENERIMAAN_ID', 'NOMOR_TANDA_TERIMA', 'TAHUN', 'TANGGAL_WAKTU_TERIMA', 'PENYERAH_PEGAWAI_ID', 'NAMA_PENYERAH_SNAPSHOT',
      'UNIT_PENYERAH_SNAPSHOT', 'NAMA_PENERIMA', 'UNIT_PENERIMA', 'LOKASI', 'CATATAN_UMUM', 'JUMLAH_ITEM', 'TOTAL_HALAMAN', 'STATUS',
      'BUKTI_TTD_FILE_ID', 'BUKTI_TTD_URL', 'BUKTI_TTD_NAMA', 'BUKTI_TTD_UPLOADED_AT', 'BUKTI_TTD_UPLOADED_BY',
      'ALASAN_PEMBATALAN', 'BATAL_BUKTI_FILE_ID', 'BATAL_BUKTI_URL', 'BATAL_BUKTI_NAMA', 'DIBATALKAN_AT', 'DIBATALKAN_BY',
      'CREATED_AT', 'CREATED_BY', 'UPDATED_AT', 'UPDATED_BY', 'VERSION'
    ],
    rows: [
      { PENERIMAAN_ID: 'RCV-1', NOMOR_TANDA_TERIMA: 'TRM-2026-0001', TAHUN: 2026, TANGGAL_WAKTU_TERIMA: '2026-02-02T09:15:00+07:00', PENYERAH_PEGAWAI_ID: 'PGW-1',
        NAMA_PENYERAH_SNAPSHOT: 'Budi Fiktif', UNIT_PENYERAH_SNAPSHOT: 'Subbagian Contoh', NAMA_PENERIMA: 'Petugas Fiktif', UNIT_PENERIMA: 'Bagian Umum (fiktif)', LOKASI: 'Surabaya',
        JUMLAH_ITEM: 2, TOTAL_HALAMAN: 5, STATUS: 'AKTIF', BUKTI_TTD_FILE_ID: 'drv-ttd-1', BUKTI_TTD_UPLOADED_AT: D(2026, 2, 2, 13, 0),
        CREATED_AT: '2026-02-02T09:15:00+07:00', CREATED_BY: 'petugas@contoh.invalid', VERSION: 1 },
      { PENERIMAAN_ID: 'RCV-2', NOMOR_TANDA_TERIMA: 'TRM-2026-0002', TAHUN: 2026, TANGGAL_WAKTU_TERIMA: D(2026, 2, 3, 8, 45), PENYERAH_PEGAWAI_ID: 'PGW-2',
        NAMA_PENYERAH_SNAPSHOT: 'Sari Fiktif', JUMLAH_ITEM: 1, TOTAL_HALAMAN: 2, STATUS: 'DIBATALKAN', ALASAN_PEMBATALAN: 'Salah unit penyerah',
        DIBATALKAN_AT: '04/02/2026 10:00', DIBATALKAN_BY: 'admin@contoh.invalid', CREATED_AT: D(2026, 2, 3, 8, 45), VERSION: 2 },
      { PENERIMAAN_ID: 'RCV-3', NOMOR_TANDA_TERIMA: 'TRM-2026-0003', TAHUN: '2026', TANGGAL_WAKTU_TERIMA: '05/02/2026 14:20', PENYERAH_PEGAWAI_ID: 'PGW-HILANG',
        NAMA_PENYERAH_SNAPSHOT: 'Pegawai Terhapus', JUMLAH_ITEM: 0, TOTAL_HALAMAN: 0, STATUS: 'AKTIF', CREATED_AT: '05/02/2026 14:20' }
    ]
  };

  sheets.PENERIMAAN_ITEM = {
    // CF metadata FILE_DIGITAL_* columns missing on purpose
    headers: [
      'PENERIMAAN_ITEM_ID', 'PENERIMAAN_ID', 'NO_ITEM', 'URAIAN_INFORMASI', 'JUMLAH_HALAMAN', 'TINGKAT_PERKEMBANGAN', 'KONDISI',
      'KLASIFIKASI_KEAMANAN_AKSES', 'CREATED_AT', 'CREATED_BY', 'UPDATED_AT', 'UPDATED_BY', 'IS_DELETED', 'DELETED_AT', 'DELETED_BY',
      'ARSIP_ID', 'NO_SURAT_UTAMA', 'NO_SURAT_ALTERNATIF', 'TANGGAL_NASKAH', 'CATATAN_ITEM', 'STATUS_PEMBERKASAN', 'BERKAS_ID_TUJUAN',
      'ITEM_ID_DEFINITIF', 'NO_BERKAS_DEFINITIF_SNAPSHOT', 'NO_ITEM_DEFINITIF_SNAPSHOT', 'DIBERKASKAN_AT', 'DIBERKASKAN_BY', 'PEMBERKASAN_REQUEST_ID'
    ],
    rows: [
      { PENERIMAAN_ITEM_ID: 'RCVI-1', PENERIMAAN_ID: 'RCV-1', NO_ITEM: 1, URAIAN_INFORMASI: 'SPJ kegiatan', JUMLAH_HALAMAN: 3, TINGKAT_PERKEMBANGAN: 'ASLI', KONDISI: 'BAIK',
        KLASIFIKASI_KEAMANAN_AKSES: 'TERBATAS', CREATED_AT: '2026-02-02T09:15:00+07:00', IS_DELETED: false, ARSIP_ID: 'ARS-1', NO_SURAT_UTAMA: 'KU-100/FIKTIF/2026',
        TANGGAL_NASKAH: '01/02/2026', STATUS_PEMBERKASAN: 'SUDAH DIBERKASKAN', BERKAS_ID_TUJUAN: 'BRK-2', ITEM_ID_DEFINITIF: 'ITM-3',
        NO_BERKAS_DEFINITIF_SNAPSHOT: 2, NO_ITEM_DEFINITIF_SNAPSHOT: 1, DIBERKASKAN_AT: '2026-02-02T11:00:00+07:00', DIBERKASKAN_BY: 'petugas@contoh.invalid', PEMBERKASAN_REQUEST_ID: 'REQ-1' },
      { PENERIMAAN_ITEM_ID: 'RCVI-2', PENERIMAAN_ID: 'RCV-1', NO_ITEM: 2, URAIAN_INFORMASI: 'Undangan rapat', JUMLAH_HALAMAN: 2, TINGKAT_PERKEMBANGAN: 'COPY', KONDISI: 'rusak ringan',
        CREATED_AT: '2026-02-02T09:15:00+07:00', IS_DELETED: false, ARSIP_ID: 'ARS-2', TANGGAL_NASKAH: '5 Maret 2026', STATUS_PEMBERKASAN: 'BELUM DIBERKASKAN' },
      { PENERIMAAN_ITEM_ID: 'RCVI-3', PENERIMAAN_ID: 'RCV-2', NO_ITEM: 1, URAIAN_INFORMASI: 'Surat salah unit', JUMLAH_HALAMAN: 2, TINGKAT_PERKEMBANGAN: 'ASLI',
        CREATED_AT: D(2026, 2, 3, 8, 45), IS_DELETED: true, DELETED_AT: '04/02/2026 10:00', DELETED_BY: 'admin@contoh.invalid', ARSIP_ID: 'ARS-3', STATUS_PEMBERKASAN: 'DIBATALKAN' },
      // orphan: receipt does not exist
      { PENERIMAAN_ITEM_ID: 'RCVI-4', PENERIMAAN_ID: 'RCV-TIDAK-ADA', NO_ITEM: 1, URAIAN_INFORMASI: 'Yatim', JUMLAH_HALAMAN: 1, CREATED_AT: '2026-02-06T08:00:00+07:00' }
    ]
  };

  sheets.RIWAYAT_NOMOR = {
    headers: ['RIWAYAT_ID', 'JENIS_OBJEK', 'OBJEK_ID', 'BERKAS_ID', 'NOMOR_LAMA', 'NOMOR_BARU', 'NAMA_LAMA', 'NAMA_BARU', 'ALASAN',
      'BATCH_RENUMBER_ID', 'DIKONFIRMASI_OLEH', 'DIKONFIRMASI_AT', 'CREATED_AT', 'CREATED_BY', 'CATATAN'],
    rows: [
      { RIWAYAT_ID: 'HIS-1', JENIS_OBJEK: 'BERKAS', OBJEK_ID: 'BRK-2', BERKAS_ID: 'BRK-2', NOMOR_LAMA: '', NOMOR_BARU: 1, ALASAN: 'Penomoran awal', BATCH_RENUMBER_ID: 'REN-1', CREATED_AT: '2026-01-15T09:30:00+07:00' },
      { RIWAYAT_ID: 'HIS-2', JENIS_OBJEK: 'BERKAS', OBJEK_ID: 'BRK-2', BERKAS_ID: 'BRK-2', NOMOR_LAMA: 1, NOMOR_BARU: 2, ALASAN: 'Penomoran ulang kronologis', BATCH_RENUMBER_ID: 'REN-2', DIKONFIRMASI_OLEH: 'petugas@contoh.invalid', DIKONFIRMASI_AT: '2026-02-02T11:00:00+07:00', CREATED_AT: '2026-02-02T11:00:00+07:00' },
      { RIWAYAT_ID: 'HIS-3', JENIS_OBJEK: 'BERKAS', OBJEK_ID: 'BRK-1', BERKAS_ID: 'BRK-1', NOMOR_LAMA: '2', NOMOR_BARU: '1', ALASAN: 'Penomoran ulang kronologis', BATCH_RENUMBER_ID: 'REN-2', CREATED_AT: '2026-02-02T11:00:00+07:00' },
      { RIWAYAT_ID: 'HIS-4', JENIS_OBJEK: 'ITEM', OBJEK_ID: 'ITM-2', BERKAS_ID: 'BRK-1', NOMOR_LAMA: '–', NOMOR_BARU: 2, NAMA_LAMA: '', NAMA_BARU: '1_2_Renstra final.pdf', CREATED_AT: '2025-03-11T09:00:00+07:00' },
      { RIWAYAT_ID: 'HIS-5', JENIS_OBJEK: 'ITEM', OBJEK_ID: 'ITM-1', BERKAS_ID: 'BRK-1', NOMOR_LAMA: '1a', NOMOR_BARU: 1, CREATED_AT: '2025-03-11T09:00:00+07:00' }
    ]
  };

  const auditHeaders = ['LOG_ID', 'TIMESTAMP', 'USER_EMAIL', 'AKSI', 'MODUL', 'JENIS_OBJEK', 'OBJEK_ID', 'RINGKASAN',
    'DATA_SEBELUM_JSON', 'DATA_SESUDAH_JSON', 'ALASAN', 'REQUEST_ID', 'STATUS', 'IP_INFO', 'CATATAN'];
  sheets.AUDIT_LOG_2025 = {
    headers: auditHeaders,
    rows: [
      { LOG_ID: 'LOG-1', TIMESTAMP: '2025-01-15T09:00:00+07:00', USER_EMAIL: 'petugas@contoh.invalid', AKSI: 'CREATE', MODUL: 'BERKAS', JENIS_OBJEK: 'BERKAS', OBJEK_ID: 'BRK-1', RINGKASAN: 'Membuat berkas', REQUEST_ID: 'REQ-A', STATUS: 'SUCCESS' },
      { LOG_ID: 'LOG-2', TIMESTAMP: D(2025, 3, 11, 9, 0), USER_EMAIL: 'petugas@contoh.invalid', AKSI: 'CREATE', MODUL: 'ITEM', JENIS_OBJEK: 'ITEM', OBJEK_ID: '', RINGKASAN: 'Gagal menyimpan item', ALASAN: 'Timeout', STATUS: 'FAILED' }
    ]
  };
  sheets.AUDIT_LOG = {
    headers: auditHeaders,
    rows: [
      { LOG_ID: 'LOG-3', TIMESTAMP: '2026-02-02T11:00:00+07:00', USER_EMAIL: 'petugas@contoh.invalid', AKSI: 'PEMBERKASAN', MODUL: 'PENERIMAAN_ARSIP', OBJEK_ID: 'RCV-1', STATUS: '' },
      { LOG_ID: 'LOG-5', TIMESTAMP: '2026-02-05T01:02:03.004Z', USER_EMAIL: '', AKSI: 'UPDATE', MODUL: 'BERKAS', OBJEK_ID: 'BRK-1',
        DATA_SEBELUM_JSON: '{"judul":"lama"}', DATA_SESUDAH_JSON: '{"judul":"baru"}', IP_INFO: '0.0.0.0 (fiktif)', CATATAN: 'catatan fiktif', STATUS: 'WARNING' },
      { LOG_ID: 'LOG-4', TIMESTAMP: '04/02/2026 10:00', USER_EMAIL: 'admin@contoh.invalid', AKSI: 'CANCEL', MODUL: 'PENERIMAAN_ARSIP', OBJEK_ID: 'RCV-2', ALASAN: 'Salah unit penyerah', STATUS: 'SUCCESS' }
    ]
  };

  // Modules not in the schema yet
  sheets.PEMINJAMAN = {
    headers: ['PEMINJAMAN_ID', 'LOAN_GROUP_ID', 'BERKAS_ID', 'NAMA_PEMINJAM', 'NIP_NIK', 'STATUS'],
    rows: [
      { PEMINJAMAN_ID: 'PJM-1', LOAN_GROUP_ID: 'LG-1', BERKAS_ID: 'BRK-1', NAMA_PEMINJAM: 'Peminjam Fiktif', NIP_NIK: '000', STATUS: 'DIKEMBALIKAN' },
      { PEMINJAMAN_ID: 'PJM-2', LOAN_GROUP_ID: 'LG-2', BERKAS_ID: 'BRK-2', NAMA_PEMINJAM: 'Peminjam Fiktif', NIP_NIK: '000', STATUS: 'DIPINJAM' }
    ]
  };
  sheets.USUL_PINDAH = { headers: ['USUL_PINDAH_ID', 'NO_USUL_PINDAH', 'STATUS_USUL'], rows: [{ USUL_PINDAH_ID: 'USP-1', NO_USUL_PINDAH: 'UP-2025-0001', STATUS_USUL: 'TERTATA INAKTIF' }] };
  sheets.OUTBOX_RECORD_CENTER = { headers: ['OUTBOX_ID', 'STATUS'], rows: [] };
  sheets.LOG_CETAK_PENERIMAAN = { headers: ['CETAK_ID', 'PENERIMAAN_ID'], rows: [{ CETAK_ID: 'PRN-1', PENERIMAAN_ID: 'RCV-1' }] };
  sheets.SYSTEM_BACKUPS = { headers: ['BACKUP_ID', 'STATUS'], rows: [{ BACKUP_ID: 'BKP-1', STATUS: 'COMPLETE' }] };
  sheets['Catatan Petugas'] = { headers: ['CATATAN'], rows: [{ CATATAN: 'lembar kerja pribadi' }] };
  sheets.MASTER_JENIS_NASKAH = {
    headers: ['JENIS_NASKAH_ID', 'KATEGORI', 'SUBJENIS_NASKAH_ID', 'SUBJENIS', 'POLA_DEFAULT', 'AKTIF', 'URUTAN'],
    rows: [
      { JENIS_NASKAH_ID: 'JN-1', KATEGORI: 'Kategori fiktif', SUBJENIS_NASKAH_ID: 'SJ-1', SUBJENIS: 'Subjenis fiktif', POLA_DEFAULT: 'BULANAN', AKTIF: true, URUTAN: 1 },
      { JENIS_NASKAH_ID: 'JN-1', KATEGORI: 'Kategori fiktif', SUBJENIS_NASKAH_ID: 'SJ-2', SUBJENIS: 'Subjenis fiktif 2', POLA_DEFAULT: 'TAHUNAN', AKTIF: true, URUTAN: 2 }
    ]
  };
  sheets.MASTER_JRA = { headers: ['JRA_ID', 'KODE_JRA', 'JENIS_ARSIP', 'NASIB_AKHIR'], rows: [] };
  sheets.IMPORT_STAGING = { headers: ['IMPORT_BATCH_ID', 'BARIS_SUMBER', 'NO_BERKAS_LAMA'], rows: [] };
  // hand-made layout sheet with a merged title in row 1 (duplicate header names)
  sheets['DAFTAR CONTOH LAIN'] = { matrix: [['DAFTAR CONTOH (fiktif)', 'DAFTAR CONTOH (fiktif)'], ['No', 'Uraian'], [1, 'baris fiktif']] };

  // Derived legacy reports (layout sheets): title rows, header row, column-number row, data rows
  sheets['DAFTAR BERKAS'] = {
    matrix: [
      ['DAFTAR BERKAS (fiktif)'], [],
      ['Nomor Berkas', 'Kode Klasifikasi', '', '', 'Uraian Informasi Berkas', 'Kurun Waktu', 'Jumlah (Item Arsip)', 'Jumlah (Lembar)', 'Keterangan'],
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
      [1, 'PR', '01', '01.01', 'Renstra 2025 (fiktif)', '2025', 2, 14, 'AKTIF'],
      [2, 'KU', '02', '', 'Pelaksanaan anggaran 2026 (fiktif)', '2026', 1, 3, 'AKTIF']
    ]
  };
  sheets['DAFTAR ISI BERKAS'] = {
    matrix: [
      ['DAFTAR ISI BERKAS (fiktif)'], [],
      ['No Berkas', 'No Item', 'Nomor Surat', 'Kode', '', '', 'Uraian'],
      [1, 2, 3, 4, 5, 6, 7],
      [1, 1, 'B-001/FIKTIF/2025', 'PR', '01', '01.01', 'Draf renstra'],
      [1, 2, 'B-014/FIKTIF/2025', 'PR', '01', '01.01', 'Renstra final'],
      [2, 1, 'KU-100/FIKTIF/2026', 'KU', '02', '', 'SPJ kegiatan']
    ]
  };
  return sheets;
}

export async function writeFixture(definition, file) {
  const wb = new ExcelJS.Workbook();
  for (const [name, sheet] of Object.entries(definition)) {
    const ws = wb.addWorksheet(name);
    if (sheet.matrix) {
      sheet.matrix.forEach((r) => ws.addRow(r));
      continue;
    }
    ws.addRow(sheet.headers);
    for (const row of sheet.rows) {
      const r = ws.addRow(sheet.headers.map((h) => (row[h] === undefined ? null : row[h])));
      sheet.headers.forEach((h, i) => {
        if (row[h] instanceof Date) {
          const d = row[h];
          r.getCell(i + 1).numFmt = d.getUTCHours() || d.getUTCMinutes() ? 'dd/mm/yyyy hh:mm' : 'dd/mm/yyyy';
        }
      });
    }
  }
  await wb.xlsx.writeFile(file);
  return file;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2] || 'fixture-legacy.xlsx';
  await writeFixture(fixtureDefinition(), out);
  process.stdout.write(`${out}\n`);
}
