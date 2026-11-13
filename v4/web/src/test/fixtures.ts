import type { BerkasDetail, ItemDetail, SearchHit } from '../lib/api';

export function makeHit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    item_id: 'ITM-1',
    berkas_id: 'BRK-1',
    unit_id: 'unit-1',
    no_berkas: 50,
    no_item: 1,
    judul_berkas: 'Laporan Keuangan 2025',
    no_surat: 'B-014/UN.07/2025',
    no_surat_utama: 'B-014/UN.07/2025',
    no_surat_alternatif: null,
    tanggal_naskah: '2025-01-10',
    uraian: 'Laporan triwulan I',
    jumlah_halaman: 4,
    tingkat_perkembangan: 'ASLI',
    kondisi_fisik: null,
    kode_klasifikasi: 'KU.01',
    uraian_klasifikasi: 'Keuangan umum',
    kabinet: '7',
    laci: '3',
    folder: '12',
    lokasi: 'Kabinet 7 · Laci 3 · Folder 12',
    klasifikasi_keamanan: 'BIASA/TERBUKA',
    has_file: true,
    drive_file_id: 'FILE1',
    drive_file_url: 'https://drive.google.com/file/d/FILE1/view',
    drive_folder_url: 'https://drive.google.com/drive/folders/F1',
    status_peminjaman: 'TERSEDIA',
    status_berkas: 'AKTIF',
    dibatalkan: false,
    score: 600,
    ...overrides,
  };
}

export function makeItemDetail(overrides: Partial<ItemDetail> = {}): ItemDetail {
  const { score: _score, ...hit } = makeHit();
  void _score;
  return {
    ...hit,
    media_sumber: 'TEKSTUAL',
    status_bentuk_digital: 'ALIH MEDIA',
    nama_file: '50_1_Laporan.pdf',
    nomor_tanda_terima: 'TRM-2025-0001',
    catatan: null,
    ...overrides,
  };
}

export function makeBerkasDetail(overrides: Partial<BerkasDetail> = {}): BerkasDetail {
  return {
    berkas_id: 'BRK-1',
    unit_id: 'unit-1',
    no_berkas: 50,
    judul_berkas: 'Laporan Keuangan 2025',
    kode_klasifikasi: 'KU.01',
    uraian_klasifikasi: 'Keuangan umum',
    kurun_waktu: '2025',
    kabinet: '7',
    laci: '3',
    folder: '12',
    lokasi: 'Kabinet 7 · Laci 3 · Folder 12',
    klasifikasi_keamanan: 'BIASA/TERBUKA',
    drive_folder_url: 'https://drive.google.com/drive/folders/F1',
    status_berkas: 'AKTIF',
    status_peminjaman: 'TERSEDIA',
    status_retensi: 'AKTIF',
    nasib_akhir: 'PERMANEN',
    dibatalkan: false,
    jumlah_item: 2,
    total_lembar: 6,
    tanggal_awal: '2025-01-10',
    tanggal_akhir: '2025-06-01',
    items: [
      { item_id: 'ITM-1', no_item: 1, no_surat: 'B-014/UN.07/2025', tanggal_naskah: '2025-01-10', uraian: 'Laporan triwulan I', jumlah_halaman: 4, tingkat_perkembangan: 'ASLI', klasifikasi_keamanan: 'BIASA/TERBUKA', has_file: true, drive_file_id: 'FILE1', drive_file_url: null, dibatalkan: false },
      { item_id: 'ITM-2', no_item: 2, no_surat: 'SK-02/2025', tanggal_naskah: '2025-06-01', uraian: 'Nota dinas', jumlah_halaman: 2, tingkat_perkembangan: 'COPY', klasifikasi_keamanan: 'RAHASIA', has_file: false, drive_file_id: null, drive_file_url: null, dibatalkan: false },
    ],
    ...overrides,
  };
}
