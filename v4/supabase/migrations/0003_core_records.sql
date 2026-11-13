-- 0003_core_records.sql
-- Core Central File records needed by Sprint 1 (read-only + import):
-- klasifikasi, pegawai, berkas, item, penerimaan, penerimaan_item, riwayat_nomor.
--
-- Conventions
--   * Every row carries unit_id (not null). Legacy IDs are kept verbatim as the
--     text primary key (BRK-…, ITM-…, RCV-…, RCVI-…, PGW-…, HIS-…).
--   * Each table also has UNIQUE (unit_id, id) so that references between
--     business tables are composite (unit_id, x_id) and can never cross units.
--   * Cross-table FKs are DEFERRABLE INITIALLY DEFERRED so the importer and
--     the filing transaction can insert mutually-referencing rows in any order.
--   * Local calendar dates (Asia/Jakarta) are `date`; technical times are
--     `timestamptz`. created_by / updated_by keep the legacy actor text (email).
--   * Soft delete only: is_deleted / status columns. Hard DELETE is blocked by
--     trigger on every business table.
--   * Enumerated legacy values are checked only where the legacy code enforces
--     a closed list; the importer maps legacy '' to NULL.
--   * Column mapping to legacy sheet headers: v4/supabase/LEGACY_COLUMN_MAP.md

-- ---------------------------------------------------------------------------
-- klasifikasi  (MASTER_KLASIFIKASI)
-- Primary key is (unit_id, id): each legacy instance has its own copy of the
-- master, so the same KLASIFIKASI_ID is expected in several units.
-- ---------------------------------------------------------------------------
create table if not exists public.klasifikasi (
  unit_id          uuid not null references public.units(id),
  id               text not null,             -- KLASIFIKASI_ID
  parent_id        text,                      -- PARENT_ID ('' / ROOT -> NULL = primer)
  level            text,                      -- LEVEL (raw legacy value)
  kode_lengkap     text not null,             -- KODE_LENGKAP
  uraian           text,                      -- URAIAN
  label_dropdown   text,                      -- LABEL_DROPDOWN
  aktif            boolean not null default true, -- AKTIF
  urutan           integer,                   -- URUTAN
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (unit_id, id),
  constraint klasifikasi_parent_fk foreign key (unit_id, parent_id)
    references public.klasifikasi (unit_id, id) deferrable initially deferred,
  constraint klasifikasi_not_own_parent check (parent_id is null or parent_id <> id)
);
create index if not exists klasifikasi_parent_idx on public.klasifikasi (unit_id, parent_id);
create index if not exists klasifikasi_kode_idx on public.klasifikasi (unit_id, kode_lengkap);

-- ---------------------------------------------------------------------------
-- pegawai  (MASTER_PEGAWAI)
-- ---------------------------------------------------------------------------
create table if not exists public.pegawai (
  id            text primary key,              -- PEGAWAI_ID
  unit_id       uuid not null references public.units(id),
  nama_pegawai  text not null,                 -- NAMA_PEGAWAI
  unit_kerja    text,                          -- UNIT_KERJA
  aktif         boolean not null default true, -- AKTIF
  nip_nik_enc   bytea,                         -- (new, PII, app.encrypt_pii) no legacy column
  kontak_enc    bytea,                         -- (new, PII, app.encrypt_pii) no legacy column
  created_at    timestamptz not null default now(), -- CREATED_AT
  created_by    text,                          -- CREATED_BY
  updated_at    timestamptz not null default now(), -- UPDATED_AT
  updated_by    text,                          -- UPDATED_BY
  constraint pegawai_unit_id_key unique (unit_id, id)
);
create index if not exists pegawai_nama_idx on public.pegawai (unit_id, nama_pegawai);

-- ---------------------------------------------------------------------------
-- berkas  (DB_BERKAS)
-- ---------------------------------------------------------------------------
create table if not exists public.berkas (
  id                           text primary key,      -- BERKAS_ID
  unit_id                      uuid not null references public.units(id),
  no_berkas_definitif          integer,               -- NO_BERKAS_DEFINITIF (NULL while DRAFT)
  judul_berkas                 text not null,         -- JUDUL_BERKAS
  kategori_naskah_id           text,                  -- KATEGORI_NASKAH_ID (always '' in 3.32.5)
  pola_pemberkasan             text,                  -- POLA_PEMBERKASAN (always '' in 3.32.5)
  klasifikasi_id               text,                  -- KLASIFIKASI_ID
  kode_klasifikasi_snapshot    text,                  -- KODE_KLASIFIKASI_SNAPSHOT
  uraian_klasifikasi_snapshot  text,                  -- URAIAN_KLASIFIKASI_SNAPSHOT
  retensi_aktif_nilai          integer,               -- RETENSI_AKTIF_NILAI
  retensi_aktif_satuan         text,                  -- RETENSI_AKTIF_SATUAN
  retensi_inaktif_nilai        integer,               -- RETENSI_INAKTIF_NILAI
  retensi_inaktif_satuan       text,                  -- RETENSI_INAKTIF_SATUAN
  nasib_akhir                  text,                  -- NASIB_AKHIR
  status_retensi               text,                  -- STATUS_RETENSI (AKTIF | H-n | HABIS AKTIF … | MENUNGGU ITEM)
  tgl_item_awal                date,                  -- TGL_ITEM_AWAL
  tgl_item_akhir               date,                  -- TGL_ITEM_AKHIR
  tgl_urut_berkas              date,                  -- TGL_URUT_BERKAS
  tgl_acuan_retensi            date,                  -- TGL_ACUAN_RETENSI
  batas_aktif                  date,                  -- BATAS_AKTIF
  batas_inaktif                date,                  -- BATAS_INAKTIF
  jumlah_item                  integer,               -- JUMLAH_ITEM
  total_halaman                integer,               -- TOTAL_HALAMAN
  kurun_waktu                  text,                  -- KURUN_WAKTU ('2024' or '2023–2025')
  no_filling_kabinet           text,                  -- NO_FILLING_KABINET
  no_laci                      text,                  -- NO_LACI
  no_folder                    text,                  -- NO_FOLDER
  drive_folder_id              text,                  -- DRIVE_FOLDER_ID
  drive_folder_url             text,                  -- DRIVE_FOLDER_URL
  status_peminjaman            text not null default 'TERSEDIA', -- STATUS_PEMINJAMAN
  status_berkas                text not null default 'DRAFT',    -- STATUS_BERKAS (DRAFT | AKTIF | DIHAPUS | GAGAL)
  status_pemindahan            text,                  -- STATUS_PEMINDAHAN ('SUDAH DIPINDAHKAN' when transferred)
  catatan                      text,                  -- CATATAN
  -- metadata schema v4 (CentralFileMetadataService)
  pencipta_arsip_snapshot      text,                  -- PENCIPTA_ARSIP_SNAPSHOT
  unit_pencipta_id             text,                  -- UNIT_PENCIPTA_ID (legacy SETTINGS.UNIT_ID text)
  unit_pencipta_snapshot       text,                  -- UNIT_PENCIPTA_SNAPSHOT
  klasifikasi_keamanan_akses   text,                  -- KLASIFIKASI_KEAMANAN_AKSES
  arsip_vital                  boolean not null default false, -- ARSIP_VITAL (TRUE / 'YA')
  arsip_terjaga                boolean not null default false, -- ARSIP_TERJAGA (TRUE / 'YA')
  media_berkas                 text,                  -- MEDIA_BERKAS
  jumlah_item_fisik            integer,               -- JUMLAH_ITEM_FISIK
  jumlah_item_born_digital     integer,               -- JUMLAH_ITEM_BORN_DIGITAL
  jumlah_item_alih_media       integer,               -- JUMLAH_ITEM_ALIH_MEDIA
  status_verifikasi_metadata   text,                  -- STATUS_VERIFIKASI_METADATA
  metadata_schema_version      integer,               -- METADATA_SCHEMA_VERSION
  -- retention / transfer (RetentionService CF04); FK added with usul_pindah in S5
  usul_pindah_id_aktif         text,                  -- USUL_PINDAH_ID_AKTIF
  usul_pindah_no_aktif         text,                  -- USUL_PINDAH_NO_AKTIF
  -- read defensively by RetentionService; may not exist in real sheets
  jra_id                       text,                  -- JRA_ID (uncertain)
  jra_dasar_hukum              text,                  -- JRA_DASAR_HUKUM / DASAR_HUKUM_JRA (uncertain)
  jra_versi                    text,                  -- JRA_VERSI / VERSI_JRA (uncertain)
  -- bookkeeping
  created_at                   timestamptz not null default now(), -- CREATED_AT
  created_by                   text,                  -- CREATED_BY
  updated_at                   timestamptz not null default now(), -- UPDATED_AT
  updated_by                   text,                  -- UPDATED_BY
  version                      integer not null default 1,         -- VERSION
  is_deleted                   boolean not null default false,     -- IS_DELETED
  constraint berkas_unit_id_key unique (unit_id, id),
  constraint berkas_klasifikasi_fk foreign key (unit_id, klasifikasi_id)
    references public.klasifikasi (unit_id, id) deferrable initially deferred,
  -- Display number unique per unit among non-deleted berkas. Deferred because
  -- chronological renumbering shifts many numbers inside one transaction.
  constraint berkas_no_definitif_per_unit
    exclude using btree (unit_id with =, no_berkas_definitif with =)
    where (not is_deleted) deferrable initially deferred,
  constraint berkas_no_definitif_positive check (no_berkas_definitif is null or no_berkas_definitif > 0),
  constraint berkas_retensi_satuan_check check (
    (retensi_aktif_satuan is null or retensi_aktif_satuan in ('TAHUN', 'BULAN')) and
    (retensi_inaktif_satuan is null or retensi_inaktif_satuan in ('TAHUN', 'BULAN'))),
  constraint berkas_retensi_nilai_check check (
    (retensi_aktif_nilai is null or retensi_aktif_nilai >= 0) and
    (retensi_inaktif_nilai is null or retensi_inaktif_nilai >= 0)),
  constraint berkas_nasib_akhir_check check (
    nasib_akhir is null or nasib_akhir in ('MUSNAH', 'PERMANEN', 'DINILAI KEMBALI')),
  constraint berkas_keamanan_check check (
    klasifikasi_keamanan_akses is null or
    klasifikasi_keamanan_akses in ('BIASA/TERBUKA', 'TERBATAS', 'RAHASIA', 'SANGAT RAHASIA')),
  constraint berkas_verifikasi_check check (
    status_verifikasi_metadata is null or
    status_verifikasi_metadata in ('PERLU VERIFIKASI', 'TERVERIFIKASI'))
);
create index if not exists berkas_unit_no_idx on public.berkas (unit_id, no_berkas_definitif);
create index if not exists berkas_klasifikasi_idx on public.berkas (unit_id, klasifikasi_id);
create index if not exists berkas_batas_aktif_idx on public.berkas (unit_id, batas_aktif) where not is_deleted;

-- ---------------------------------------------------------------------------
-- penerimaan  (PENERIMAAN_ARSIP)
-- ---------------------------------------------------------------------------
create table if not exists public.penerimaan (
  id                       text primary key,      -- PENERIMAAN_ID
  unit_id                  uuid not null references public.units(id),
  nomor_tanda_terima       text not null,         -- NOMOR_TANDA_TERIMA (TRM-YYYY-NNNN)
  tahun                    integer not null,      -- TAHUN
  tanggal_waktu_terima     timestamptz not null,  -- TANGGAL_WAKTU_TERIMA
  penyerah_pegawai_id      text,                  -- PENYERAH_PEGAWAI_ID
  nama_penyerah_snapshot   text,                  -- NAMA_PENYERAH_SNAPSHOT
  unit_penyerah_snapshot   text,                  -- UNIT_PENYERAH_SNAPSHOT
  nama_penerima            text,                  -- NAMA_PENERIMA
  unit_penerima            text,                  -- UNIT_PENERIMA
  lokasi                   text,                  -- LOKASI
  catatan_umum             text,                  -- CATATAN_UMUM
  jumlah_item              integer,               -- JUMLAH_ITEM
  total_halaman            integer,               -- TOTAL_HALAMAN
  status                   text not null default 'AKTIF', -- STATUS (AKTIF | DIBATALKAN)
  bukti_ttd_file_id        text,                  -- BUKTI_TTD_FILE_ID
  bukti_ttd_url            text,                  -- BUKTI_TTD_URL
  bukti_ttd_nama           text,                  -- BUKTI_TTD_NAMA
  bukti_ttd_uploaded_at    timestamptz,           -- BUKTI_TTD_UPLOADED_AT
  bukti_ttd_uploaded_by    text,                  -- BUKTI_TTD_UPLOADED_BY
  alasan_pembatalan        text,                  -- ALASAN_PEMBATALAN
  batal_bukti_file_id      text,                  -- BATAL_BUKTI_FILE_ID
  batal_bukti_url          text,                  -- BATAL_BUKTI_URL
  batal_bukti_nama         text,                  -- BATAL_BUKTI_NAMA
  dibatalkan_at            timestamptz,           -- DIBATALKAN_AT
  dibatalkan_by            text,                  -- DIBATALKAN_BY
  created_at               timestamptz not null default now(), -- CREATED_AT
  created_by               text,                  -- CREATED_BY
  updated_at               timestamptz not null default now(), -- UPDATED_AT
  updated_by               text,                  -- UPDATED_BY
  version                  integer not null default 1,         -- VERSION
  constraint penerimaan_unit_id_key unique (unit_id, id),
  constraint penerimaan_nomor_per_unit unique (unit_id, nomor_tanda_terima),
  constraint penerimaan_pegawai_fk foreign key (unit_id, penyerah_pegawai_id)
    references public.pegawai (unit_id, id) deferrable initially deferred,
  constraint penerimaan_status_check check (status in ('AKTIF', 'DIBATALKAN'))
);
create index if not exists penerimaan_unit_time_idx on public.penerimaan (unit_id, tanggal_waktu_terima desc);

-- ---------------------------------------------------------------------------
-- item  (DB_ITEM)
-- ---------------------------------------------------------------------------
create table if not exists public.item (
  id                            text primary key,     -- ITEM_ID
  unit_id                       uuid not null references public.units(id),
  berkas_id                     text not null,        -- BERKAS_ID
  no_item_definitif             integer,              -- NO_ITEM_DEFINITIF
  jenis_naskah_id               text,                 -- JENIS_NASKAH_ID (always '' in 3.32.5)
  subjenis_naskah_id            text,                 -- SUBJENIS_NASKAH_ID (always '' in 3.32.5)
  kelengkapan                   text,                 -- KELENGKAPAN (always '' in 3.32.5)
  no_surat_utama                text,                 -- NO_SURAT_UTAMA
  no_surat_alternatif           text,                 -- NO_SURAT_ALTERNATIF
  no_surat_display              text,                 -- NO_SURAT_DISPLAY
  tanggal_naskah                date,                 -- TANGGAL_NASKAH
  tahun_kurun_waktu             integer,              -- TAHUN_KURUN_WAKTU
  uraian_lengkap                text,                 -- URAIAN_LENGKAP
  uraian_nama_file              text,                 -- URAIAN_NAMA_FILE
  jumlah_halaman                integer,              -- JUMLAH_HALAMAN
  tingkat_perkembangan          text,                 -- TINGKAT_PERKEMBANGAN (ASLI | COPY)
  klasifikasi_keamanan_akses    text,                 -- KLASIFIKASI_KEAMANAN_AKSES
  kode_klasifikasi_snapshot     text,                 -- KODE_KLASIFIKASI_SNAPSHOT
  no_berkas_snapshot            integer,              -- NO_BERKAS_SNAPSHOT
  nama_file                     text,                 -- NAMA_FILE
  drive_file_id                 text,                 -- DRIVE_FILE_ID
  drive_file_url                text,                 -- DRIVE_FILE_URL
  mime_type                     text,                 -- MIME_TYPE
  drive_file_size_bytes         bigint,               -- (new) size of the Drive file
  drive_file_sha256             text,                 -- (new) checksum of the Drive file
  lampiran                      jsonb not null default '[]'::jsonb, -- LAMPIRAN_JSON
  status_file                   text,                 -- STATUS_FILE (TERSEDIA | BELUM DIUNGGAH | DIHAPUS | GAGAL)
  status_peminjaman             text not null default 'TERSEDIA', -- STATUS_PEMINJAMAN
  sort_no_surat_normalized      text,                 -- SORT_NO_SURAT_NORMALIZED
  sort_created_at               text,                 -- SORT_CREATED_AT (ISO text, may carry a -NNN suffix)
  catatan                       text,                 -- CATATAN
  arsip_id                      text,                 -- ARSIP_ID
  sumber_registrasi             text,                 -- SUMBER_REGISTRASI (INPUT_MANUAL | PENERIMAAN_ARSIP)
  penerimaan_id                 text,                 -- PENERIMAAN_ID
  penerimaan_item_id            text,                 -- PENERIMAAN_ITEM_ID
  nomor_tanda_terima_snapshot   text,                 -- NOMOR_TANDA_TERIMA_SNAPSHOT
  kondisi_fisik                 text,                 -- KONDISI_FISIK
  media_sumber                  text,                 -- MEDIA_SUMBER
  status_bentuk_digital         text,                 -- STATUS_BENTUK_DIGITAL
  catatan_media                 text,                 -- CATATAN_MEDIA
  status_verifikasi_metadata    text,                 -- STATUS_VERIFIKASI_METADATA
  metadata_schema_version       integer,              -- METADATA_SCHEMA_VERSION
  created_at                    timestamptz not null default now(), -- CREATED_AT
  created_by                    text,                 -- CREATED_BY
  updated_at                    timestamptz not null default now(), -- UPDATED_AT
  updated_by                    text,                 -- UPDATED_BY
  version                       integer not null default 1,         -- VERSION
  is_deleted                    boolean not null default false,     -- IS_DELETED
  constraint item_unit_id_key unique (unit_id, id),
  constraint item_berkas_fk foreign key (unit_id, berkas_id)
    references public.berkas (unit_id, id) deferrable initially deferred,
  constraint item_penerimaan_fk foreign key (unit_id, penerimaan_id)
    references public.penerimaan (unit_id, id) deferrable initially deferred,
  constraint item_no_definitif_per_berkas
    exclude using btree (unit_id with =, berkas_id with =, no_item_definitif with =)
    where (not is_deleted) deferrable initially deferred,
  constraint item_no_definitif_positive check (no_item_definitif is null or no_item_definitif > 0),
  constraint item_jumlah_halaman_check check (jumlah_halaman is null or jumlah_halaman >= 0),
  constraint item_lampiran_is_array check (jsonb_typeof(lampiran) = 'array'),
  constraint item_tingkat_check check (tingkat_perkembangan is null or tingkat_perkembangan in ('ASLI', 'COPY')),
  constraint item_keamanan_check check (
    klasifikasi_keamanan_akses is null or
    klasifikasi_keamanan_akses in ('BIASA/TERBUKA', 'TERBATAS', 'RAHASIA', 'SANGAT RAHASIA')),
  constraint item_media_sumber_check check (
    media_sumber is null or media_sumber in ('TEKSTUAL', 'AUDIO VISUAL', 'DIGITAL')),
  constraint item_bentuk_digital_check check (
    status_bentuk_digital is null or status_bentuk_digital in ('TIDAK ADA', 'ALIH MEDIA', 'BORN DIGITAL')),
  constraint item_verifikasi_check check (
    status_verifikasi_metadata is null or
    status_verifikasi_metadata in ('PERLU VERIFIKASI', 'TERVERIFIKASI'))
);
create index if not exists item_berkas_idx on public.item (unit_id, berkas_id);
create index if not exists item_arsip_idx on public.item (unit_id, arsip_id);
create index if not exists item_tanggal_idx on public.item (unit_id, tanggal_naskah);
create index if not exists item_penerimaan_item_idx on public.item (unit_id, penerimaan_item_id);

-- ---------------------------------------------------------------------------
-- penerimaan_item  (PENERIMAAN_ITEM)
-- ---------------------------------------------------------------------------
create table if not exists public.penerimaan_item (
  id                              text primary key,  -- PENERIMAAN_ITEM_ID
  unit_id                         uuid not null references public.units(id),
  penerimaan_id                   text not null,     -- PENERIMAAN_ID
  no_item                         integer,           -- NO_ITEM
  uraian_informasi                text,              -- URAIAN_INFORMASI
  jumlah_halaman                  integer,           -- JUMLAH_HALAMAN
  tingkat_perkembangan            text,              -- TINGKAT_PERKEMBANGAN
  kondisi                         text,              -- KONDISI
  klasifikasi_keamanan_akses      text,              -- KLASIFIKASI_KEAMANAN_AKSES
  arsip_id                        text,              -- ARSIP_ID
  no_surat_utama                  text,              -- NO_SURAT_UTAMA
  no_surat_alternatif             text,              -- NO_SURAT_ALTERNATIF
  tanggal_naskah                  date,              -- TANGGAL_NASKAH
  catatan_item                    text,              -- CATATAN_ITEM
  status_pemberkasan              text,              -- STATUS_PEMBERKASAN
  berkas_id_tujuan                text,              -- BERKAS_ID_TUJUAN
  item_id_definitif               text,              -- ITEM_ID_DEFINITIF
  no_berkas_definitif_snapshot    integer,           -- NO_BERKAS_DEFINITIF_SNAPSHOT
  no_item_definitif_snapshot      integer,           -- NO_ITEM_DEFINITIF_SNAPSHOT
  diberkaskan_at                  timestamptz,       -- DIBERKASKAN_AT
  diberkaskan_by                  text,              -- DIBERKASKAN_BY
  pemberkasan_request_id          text,              -- PEMBERKASAN_REQUEST_ID
  media_sumber                    text,              -- MEDIA_SUMBER
  status_bentuk_digital           text,              -- STATUS_BENTUK_DIGITAL
  catatan_media                   text,              -- CATATAN_MEDIA
  file_digital_id                 text,              -- FILE_DIGITAL_ID
  file_digital_url                text,              -- FILE_DIGITAL_URL
  file_digital_mime_type          text,              -- FILE_DIGITAL_MIME_TYPE
  file_digital_size_bytes         bigint,            -- (new)
  file_digital_sha256             text,              -- (new)
  status_verifikasi_metadata      text,              -- STATUS_VERIFIKASI_METADATA
  metadata_schema_version         integer,           -- METADATA_SCHEMA_VERSION
  created_at                      timestamptz not null default now(), -- CREATED_AT
  created_by                      text,              -- CREATED_BY
  updated_at                      timestamptz not null default now(), -- UPDATED_AT
  updated_by                      text,              -- UPDATED_BY
  is_deleted                      boolean not null default false,     -- IS_DELETED
  deleted_at                      timestamptz,       -- DELETED_AT
  deleted_by                      text,              -- DELETED_BY
  constraint penerimaan_item_unit_id_key unique (unit_id, id),
  constraint penerimaan_item_penerimaan_fk foreign key (unit_id, penerimaan_id)
    references public.penerimaan (unit_id, id) deferrable initially deferred,
  constraint penerimaan_item_berkas_fk foreign key (unit_id, berkas_id_tujuan)
    references public.berkas (unit_id, id) deferrable initially deferred,
  constraint penerimaan_item_item_fk foreign key (unit_id, item_id_definitif)
    references public.item (unit_id, id) deferrable initially deferred,
  constraint penerimaan_item_jumlah_halaman_check check (jumlah_halaman is null or jumlah_halaman >= 0),
  constraint penerimaan_item_tingkat_check check (
    tingkat_perkembangan is null or tingkat_perkembangan in ('ASLI', 'COPY')),
  constraint penerimaan_item_kondisi_check check (
    kondisi is null or kondisi in ('BAIK', 'RUSAK RINGAN', 'RUSAK SEDANG', 'RUSAK BERAT')),
  constraint penerimaan_item_keamanan_check check (
    klasifikasi_keamanan_akses is null or
    klasifikasi_keamanan_akses in ('BIASA/TERBUKA', 'TERBATAS', 'RAHASIA', 'SANGAT RAHASIA')),
  constraint penerimaan_item_status_check check (
    status_pemberkasan is null or
    status_pemberkasan in ('BELUM DIBERKASKAN', 'SUDAH DIBERKASKAN', 'PERLU DILENGKAPI', 'DIBATALKAN')),
  constraint penerimaan_item_media_sumber_check check (
    media_sumber is null or media_sumber in ('TEKSTUAL', 'AUDIO VISUAL', 'DIGITAL')),
  constraint penerimaan_item_bentuk_digital_check check (
    status_bentuk_digital is null or status_bentuk_digital in ('TIDAK ADA', 'ALIH MEDIA', 'BORN DIGITAL')),
  constraint penerimaan_item_verifikasi_check check (
    status_verifikasi_metadata is null or
    status_verifikasi_metadata in ('PERLU VERIFIKASI', 'TERVERIFIKASI'))
);
create index if not exists penerimaan_item_penerimaan_idx on public.penerimaan_item (unit_id, penerimaan_id);
create index if not exists penerimaan_item_status_idx on public.penerimaan_item (unit_id, status_pemberkasan) where not is_deleted;

-- item.penerimaan_item_id -> penerimaan_item (added after both tables exist)
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'item_penerimaan_item_fk'
                 and conrelid = 'public.item'::regclass) then
    alter table public.item
      add constraint item_penerimaan_item_fk foreign key (unit_id, penerimaan_item_id)
      references public.penerimaan_item (unit_id, id) deferrable initially deferred;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- riwayat_nomor  (RIWAYAT_NOMOR)
-- ---------------------------------------------------------------------------
create table if not exists public.riwayat_nomor (
  id                 text primary key,      -- RIWAYAT_ID
  unit_id            uuid not null references public.units(id),
  jenis_objek        text not null,         -- JENIS_OBJEK (BERKAS | ITEM)
  objek_id           text not null,         -- OBJEK_ID (berkas.id or item.id; polymorphic, no FK)
  berkas_id          text,                  -- BERKAS_ID
  nomor_lama         integer,               -- NOMOR_LAMA ('' -> NULL)
  nomor_baru         integer,               -- NOMOR_BARU
  nama_lama          text,                  -- NAMA_LAMA
  nama_baru          text,                  -- NAMA_BARU
  alasan             text,                  -- ALASAN
  batch_renumber_id  text,                  -- BATCH_RENUMBER_ID
  dikonfirmasi_oleh  text,                  -- DIKONFIRMASI_OLEH
  dikonfirmasi_at    timestamptz,           -- DIKONFIRMASI_AT
  created_at         timestamptz not null default now(), -- CREATED_AT
  created_by         text,                  -- CREATED_BY
  constraint riwayat_nomor_unit_id_key unique (unit_id, id),
  constraint riwayat_nomor_berkas_fk foreign key (unit_id, berkas_id)
    references public.berkas (unit_id, id) deferrable initially deferred,
  constraint riwayat_nomor_jenis_check check (jenis_objek in ('BERKAS', 'ITEM'))
);
create index if not exists riwayat_nomor_objek_idx on public.riwayat_nomor (unit_id, objek_id);
create index if not exists riwayat_nomor_berkas_idx on public.riwayat_nomor (unit_id, berkas_id);

-- ---------------------------------------------------------------------------
-- Soft delete only: block hard DELETE / TRUNCATE on all business tables.
-- riwayat_nomor is history and is append-only.
-- ---------------------------------------------------------------------------
create or replace trigger klasifikasi_no_hard_delete before delete or truncate on public.klasifikasi
  for each statement execute function app.tg_forbid_hard_delete();
create or replace trigger pegawai_no_hard_delete before delete or truncate on public.pegawai
  for each statement execute function app.tg_forbid_hard_delete();
create or replace trigger berkas_no_hard_delete before delete or truncate on public.berkas
  for each statement execute function app.tg_forbid_hard_delete();
create or replace trigger item_no_hard_delete before delete or truncate on public.item
  for each statement execute function app.tg_forbid_hard_delete();
create or replace trigger penerimaan_no_hard_delete before delete or truncate on public.penerimaan
  for each statement execute function app.tg_forbid_hard_delete();
create or replace trigger penerimaan_item_no_hard_delete before delete or truncate on public.penerimaan_item
  for each statement execute function app.tg_forbid_hard_delete();
create or replace trigger riwayat_nomor_append_only before update or delete or truncate on public.riwayat_nomor
  for each statement execute function app.tg_append_only();

insert into public.schema_migrations_log (version, name)
values ('0003', 'core_records') on conflict (version) do nothing;
