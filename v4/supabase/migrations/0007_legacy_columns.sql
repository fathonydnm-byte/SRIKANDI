-- 0007_legacy_columns.sql
-- Columns present in the real 3.32.5 pilot sheets but not declared anywhere in
-- the Apps Script code (found when importing the pilot export, Sprint 1).
-- PRD §7 requires everything legacy to be preserved, so they get a home here.
-- Additive and idempotent; table grants and RLS policies already cover them.

-- DB_BERKAS: older-schema columns (bulk import + transfer approval)
alter table public.berkas add column if not exists no_berkas_lama              text;        -- NO_BERKAS_LAMA
alter table public.berkas add column if not exists jra_nama_snapshot           text;        -- JRA_NAMA_SNAPSHOT
alter table public.berkas add column if not exists tgl_pemindahan              date;        -- TGL_PEMINDAHAN
alter table public.berkas add column if not exists bukti_pemindahan_file_id    text;        -- BUKTI_PEMINDAHAN_FILE_ID
alter table public.berkas add column if not exists bukti_pemindahan_file_url   text;        -- BUKTI_PEMINDAHAN_FILE_URL
alter table public.berkas add column if not exists disetujui_pemindahan_oleh   text;        -- DISETUJUI_PEMINDAHAN_OLEH
alter table public.berkas add column if not exists tgl_persetujuan_pemindahan  date;        -- TGL_PERSETUJUAN_PEMINDAHAN
alter table public.berkas add column if not exists catatan_pemindahan          text;        -- CATATAN_PEMINDAHAN
alter table public.berkas add column if not exists deleted_at                  timestamptz; -- DELETED_AT

-- DB_ITEM
alter table public.item add column if not exists no_item_lama  text;        -- NO_ITEM_LAMA
alter table public.item add column if not exists deleted_at    timestamptz; -- DELETED_AT

-- MASTER_KLASIFIKASI (UPDATED_AT maps to the existing updated_at)
alter table public.klasifikasi add column if not exists kode_primer    text; -- KODE_PRIMER
alter table public.klasifikasi add column if not exists kode_sekunder  text; -- KODE_SEKUNDER
alter table public.klasifikasi add column if not exists kode_tersier   text; -- KODE_TERSIER
alter table public.klasifikasi add column if not exists status_review  text; -- STATUS_REVIEW
alter table public.klasifikasi add column if not exists sumber         text; -- SUMBER
alter table public.klasifikasi add column if not exists catatan        text; -- CATATAN

-- SETTINGS (UPDATED_AT maps to the existing updated_at)
alter table public.unit_settings add column if not exists scope text; -- SCOPE

-- RIWAYAT_NOMOR
alter table public.riwayat_nomor add column if not exists catatan text; -- CATATAN

-- AUDIT_LOG (DATA_SEBELUM_JSON / DATA_SESUDAH_JSON map to before_data / after_data)
alter table public.audit_log add column if not exists ip_info  text; -- IP_INFO
alter table public.audit_log add column if not exists catatan  text; -- CATATAN

insert into public.schema_migrations_log (version, name)
values ('0007', 'legacy_columns') on conflict (version) do nothing;
