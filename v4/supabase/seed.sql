-- seed.sql — DEV / STAGING ONLY. Never run against production.
-- Fictional data for two units so the read-only screens (Sprint 1) have
-- something to show before the pilot import. Idempotent (ON CONFLICT DO NOTHING).
--
-- Users/profiles are not seeded here: create the auth user through the
-- Supabase Auth admin API (or dashboard), then as service_role:
--   insert into public.profiles (user_id, unit_id, role, full_name)
--   values ('<auth user id>', '00000000-0000-4000-a000-00000000000a', 'PETUGAS', 'Nama Petugas');

insert into public.units (id, code, name, legacy_instance_id, active) values
  ('00000000-0000-4000-a000-00000000000a', 'DEV-A', 'Unit Contoh A (dev)', 'INS-DEV-000A', true),
  ('00000000-0000-4000-a000-00000000000b', 'DEV-B', 'Unit Contoh B (dev)', 'INS-DEV-000B', true)
on conflict do nothing;

insert into public.unit_settings (unit_id, key, value, value_type, description) values
  ('00000000-0000-4000-a000-00000000000a', 'UNIT_NAME', '"Unit Contoh A (dev)"', 'STRING', 'Nama unit'),
  ('00000000-0000-4000-a000-00000000000a', 'ARCHIVE_CREATOR_NAME', '"UIN Sunan Ampel Surabaya"', 'STRING', 'Pencipta arsip'),
  ('00000000-0000-4000-a000-00000000000b', 'UNIT_NAME', '"Unit Contoh B (dev)"', 'STRING', 'Nama unit')
on conflict do nothing;

-- Classification tree (primer -> sekunder -> tersier), same IDs in both units.
insert into public.klasifikasi (unit_id, id, parent_id, level, kode_lengkap, uraian, label_dropdown, aktif, urutan) values
  ('00000000-0000-4000-a000-00000000000a', 'KLS-DEV-PR', null,         '1', 'PR',       'Perencanaan (contoh)',         'PR – Perencanaan', true, 1),
  ('00000000-0000-4000-a000-00000000000a', 'KLS-DEV-SK', 'KLS-DEV-PR', '2', 'PR.01',    'Rencana strategis (contoh)',   'PR.01 – Rencana strategis', true, 2),
  ('00000000-0000-4000-a000-00000000000a', 'KLS-DEV-TR', 'KLS-DEV-SK', '3', 'PR.01.01', 'Renstra lima tahunan (contoh)', 'PR.01.01 – Renstra lima tahunan', true, 3),
  ('00000000-0000-4000-a000-00000000000b', 'KLS-DEV-PR', null,         '1', 'PR',       'Perencanaan (contoh)',         'PR – Perencanaan', true, 1),
  ('00000000-0000-4000-a000-00000000000b', 'KLS-DEV-SK', 'KLS-DEV-PR', '2', 'PR.01',    'Rencana strategis (contoh)',   'PR.01 – Rencana strategis', true, 2)
on conflict do nothing;

insert into public.pegawai (id, unit_id, nama_pegawai, unit_kerja, aktif, created_by, updated_by) values
  ('PGW-DEV-0001', '00000000-0000-4000-a000-00000000000a', 'Pegawai Contoh Satu', 'Subbagian Contoh', true, 'seed', 'seed'),
  ('PGW-DEV-0002', '00000000-0000-4000-a000-00000000000b', 'Pegawai Contoh Dua',  'Subbagian Contoh', true, 'seed', 'seed')
on conflict do nothing;

insert into public.berkas (
  id, unit_id, no_berkas_definitif, judul_berkas, klasifikasi_id,
  kode_klasifikasi_snapshot, uraian_klasifikasi_snapshot,
  retensi_aktif_nilai, retensi_aktif_satuan, retensi_inaktif_nilai, retensi_inaktif_satuan, nasib_akhir,
  status_retensi, tgl_item_awal, tgl_item_akhir, tgl_urut_berkas, tgl_acuan_retensi, batas_aktif, batas_inaktif,
  jumlah_item, total_halaman, kurun_waktu, no_filling_kabinet, no_laci, no_folder,
  status_berkas, klasifikasi_keamanan_akses, media_berkas, status_verifikasi_metadata, metadata_schema_version,
  created_by, updated_by
) values
  ('BRK-DEV-A-0001', '00000000-0000-4000-a000-00000000000a', 1, 'Renstra 2025–2029 (contoh)', 'KLS-DEV-TR',
   'PR.01.01', 'Renstra lima tahunan (contoh)', 2, 'TAHUN', 3, 'TAHUN', 'PERMANEN',
   'AKTIF', '2025-01-15', '2025-03-10', '2025-01-15', '2025-03-10', '2027-03-10', '2030-03-10',
   2, 14, '2025', '1', '1', '1',
   'AKTIF', 'BIASA/TERBUKA', 'TEKSTUAL', 'TERVERIFIKASI', 4, 'seed', 'seed'),
  ('BRK-DEV-B-0001', '00000000-0000-4000-a000-00000000000b', 1, 'Rencana kerja 2026 (contoh)', 'KLS-DEV-SK',
   'PR.01', 'Rencana strategis (contoh)', 1, 'TAHUN', 2, 'TAHUN', 'MUSNAH',
   'AKTIF', '2026-02-01', '2026-02-01', '2026-02-01', '2026-02-01', '2027-02-01', '2029-02-01',
   1, 3, '2026', 'A', '2', '1',
   'AKTIF', 'TERBATAS', 'TEKSTUAL', 'TERVERIFIKASI', 4, 'seed', 'seed')
on conflict (id) do nothing;

insert into public.penerimaan (
  id, unit_id, nomor_tanda_terima, tahun, tanggal_waktu_terima, penyerah_pegawai_id,
  nama_penyerah_snapshot, unit_penyerah_snapshot, nama_penerima, unit_penerima, lokasi,
  jumlah_item, total_halaman, status, created_by, updated_by
) values
  ('RCV-DEV-A-0001', '00000000-0000-4000-a000-00000000000a', 'TRM-2025-0001', 2025, '2025-03-11 09:00:00+07', 'PGW-DEV-0001',
   'Pegawai Contoh Satu', 'Subbagian Contoh', 'Petugas Contoh', 'Bagian Umum (contoh)', 'Surabaya',
   1, 6, 'AKTIF', 'seed', 'seed')
on conflict do nothing;

insert into public.item (
  id, unit_id, berkas_id, no_item_definitif, no_surat_utama, no_surat_display, tanggal_naskah, tahun_kurun_waktu,
  uraian_lengkap, uraian_nama_file, jumlah_halaman, tingkat_perkembangan, klasifikasi_keamanan_akses,
  kode_klasifikasi_snapshot, no_berkas_snapshot, nama_file, status_file, sort_no_surat_normalized, sort_created_at,
  arsip_id, sumber_registrasi, penerimaan_id, penerimaan_item_id, nomor_tanda_terima_snapshot, kondisi_fisik,
  media_sumber, status_bentuk_digital, status_verifikasi_metadata, metadata_schema_version, created_by, updated_by
) values
  ('ITM-DEV-A-0001', '00000000-0000-4000-a000-00000000000a', 'BRK-DEV-A-0001', 1, 'B-001/CONTOH/2025', 'B-001/CONTOH/2025',
   '2025-01-15', 2025, 'Draf renstra (contoh)', 'Draf renstra (contoh)', 8, 'ASLI', 'BIASA/TERBUKA',
   'PR.01.01', 1, '1_1_Draf renstra (contoh).pdf', 'BELUM DIUNGGAH', 'B 001 CONTOH 2025', '2025-01-15T09:00:00+07:00',
   'ITM-DEV-A-0001', 'INPUT_MANUAL', null, null, null, null,
   'TEKSTUAL', 'TIDAK ADA', 'TERVERIFIKASI', 4, 'seed', 'seed'),
  ('ITM-DEV-A-0002', '00000000-0000-4000-a000-00000000000a', 'BRK-DEV-A-0001', 2, 'B-014/CONTOH/2025', 'B-014/CONTOH/2025',
   '2025-03-10', 2025, 'Renstra final (contoh)', 'Renstra final (contoh)', 6, 'COPY', 'BIASA/TERBUKA',
   'PR.01.01', 1, '1_2_Renstra final (contoh).pdf', 'BELUM DIUNGGAH', 'B 014 CONTOH 2025', '2025-03-11T09:00:00+07:00-001',
   'ARS-DEV-0001', 'PENERIMAAN_ARSIP', 'RCV-DEV-A-0001', 'RCVI-DEV-A-0001', 'TRM-2025-0001', 'BAIK',
   'TEKSTUAL', 'TIDAK ADA', 'TERVERIFIKASI', 4, 'seed', 'seed'),
  ('ITM-DEV-B-0001', '00000000-0000-4000-a000-00000000000b', 'BRK-DEV-B-0001', 1, 'B-100/CONTOH/2026', 'B-100/CONTOH/2026',
   '2026-02-01', 2026, 'Rencana kerja (contoh)', 'Rencana kerja (contoh)', 3, 'ASLI', 'TERBATAS',
   'PR.01', 1, '1_1_Rencana kerja (contoh).pdf', 'BELUM DIUNGGAH', 'B 100 CONTOH 2026', '2026-02-01T08:00:00+07:00',
   'ITM-DEV-B-0001', 'INPUT_MANUAL', null, null, null, null,
   'TEKSTUAL', 'TIDAK ADA', 'TERVERIFIKASI', 4, 'seed', 'seed')
on conflict (id) do nothing;

insert into public.penerimaan_item (
  id, unit_id, penerimaan_id, no_item, uraian_informasi, jumlah_halaman, tingkat_perkembangan, kondisi,
  klasifikasi_keamanan_akses, arsip_id, no_surat_utama, tanggal_naskah, status_pemberkasan,
  berkas_id_tujuan, item_id_definitif, no_berkas_definitif_snapshot, no_item_definitif_snapshot,
  diberkaskan_at, diberkaskan_by, media_sumber, status_bentuk_digital, status_verifikasi_metadata,
  metadata_schema_version, created_by, updated_by
) values
  ('RCVI-DEV-A-0001', '00000000-0000-4000-a000-00000000000a', 'RCV-DEV-A-0001', 1, 'Renstra final (contoh)', 6, 'COPY', 'BAIK',
   'BIASA/TERBUKA', 'ARS-DEV-0001', 'B-014/CONTOH/2025', '2025-03-10', 'SUDAH DIBERKASKAN',
   'BRK-DEV-A-0001', 'ITM-DEV-A-0002', 1, 2,
   '2025-03-11 10:00:00+07', 'seed', 'TEKSTUAL', 'TIDAK ADA', 'TERVERIFIKASI', 4, 'seed', 'seed')
on conflict do nothing;

-- Keep the TRM counter in line with the seeded receipt.
insert into public.counters (unit_id, scope, year, last_value) values
  ('00000000-0000-4000-a000-00000000000a', 'TRM', 2025, 1)
on conflict do nothing;
