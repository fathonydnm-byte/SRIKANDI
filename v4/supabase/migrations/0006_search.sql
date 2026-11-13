-- 0006_search.sql
-- Sprint 1 read side: archive search (port of legacy SearchService.js
-- searchArchive_ / apiSearchArchive), item and berkas detail, dashboard counts.
--
--   * Every public function here is SECURITY INVOKER: RLS on item / berkas /
--     penerimaan(_item) decides what the caller sees (own unit; ADMIN_PUSAT all).
--   * Only `authenticated` may execute them; anon gets permission denied.
--   * Normalisation helpers live in schema app (IMMUTABLE, empty search_path)
--     so they can back trigram expression indexes.
--   * Idempotent: create or replace / if not exists everywhere.
--
-- Legacy semantics kept (searchArchive_):
--   - text is normalised like normalizeArchiveSearchText_: strip accents,
--     upper-case, every run of non [A-Z0-9] -> one space; the query is split
--     into tokens and EVERY token must occur somewhere in the corpus
--     (no. surat utama/alternatif/display, uraian, judul berkas, kode +
--     uraian klasifikasi, lokasi label, no. berkas, no. item, nama file, kondisi);
--   - filters: classification (substring of the normalised code; item code,
--     falling back to the berkas code), development ALL|ASLI|COPY,
--     fileStatus ALL|TERSEDIA|BELUM_DIUNGGAH (= DRIVE_FILE_ID filled or not),
--     dateFrom/dateTo on tanggal_naskah;
--   - deleted items and items of deleted berkas are hidden;
--   - ranking archiveSearchScore_ (1000 exact no. surat, 800 prefix, 600
--     contains, 300 judul, 200 klasifikasi, 100 uraian, 10 other), then
--     no. berkas, no. item.
-- Differences (deliberate, reported):
--   - with a date filter, undated items are excluded for dateTo too (legacy
--     compared '' > dateTo and therefore kept undated items for dateTo only);
--   - "active" additionally hides berkas with status DIHAPUS / GAGAL;
--   - pagination (limit/offset + exact total) replaces the 300-row cap;
--   - ties are broken by berkas id / item id so pages are stable.

-- ---------------------------------------------------------------------------
-- pg_trgm (optional). Supabase ships it; plain Postgres needs contrib. Without
-- it search still works, only without the trigram indexes.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_trgm') then
    if exists (select 1 from pg_available_extensions where name = 'pg_trgm') then
      create schema if not exists extensions;
      create extension pg_trgm with schema extensions;
    else
      raise notice 'pg_trgm is not available: archive search runs without trigram indexes';
    end if;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Normalisation helpers (port of normalizeArchiveSearchText_)
-- ---------------------------------------------------------------------------
create or replace function app.search_norm(value text)
returns text
language sql immutable parallel safe
set search_path = ''
as $$
  select pg_catalog.btrim(pg_catalog.regexp_replace(
    pg_catalog.upper(pg_catalog.translate(coalesce(value, ''),
      'àáâãäåèéêëìíîïòóôõöùúûüýÿñçÀÁÂÃÄÅÈÉÊËÌÍÎÏÒÓÔÕÖÙÚÛÜÝÑÇ',
      'aaaaaaeeeeiiiiooooouuuuyyncAAAAAAEEEEIIIIOOOOOUUUUYNC')),
    '[^A-Z0-9]+', ' ', 'g'))
$$;

-- Port of archiveLocationLabel_: folder falls back to the berkas number.
create or replace function app.lokasi_label(kabinet text, laci text, folder text, no_berkas integer)
returns text
language sql immutable parallel safe
set search_path = ''
as $$
  select coalesce(nullif(pg_catalog.array_to_string(array[
           case when nullif(pg_catalog.btrim(kabinet), '') is not null then 'Kabinet ' || pg_catalog.btrim(kabinet) end,
           case when nullif(pg_catalog.btrim(laci), '') is not null then 'Laci ' || pg_catalog.btrim(laci) end,
           case when coalesce(nullif(pg_catalog.btrim(folder), ''), no_berkas::text) is not null
                then 'Folder ' || coalesce(nullif(pg_catalog.btrim(folder), ''), no_berkas::text) end
         ], ' · '), ''), 'Lokasi belum diisi')
$$;

create or replace function app.display_no_surat(display text, utama text, alternatif text)
returns text
language sql immutable parallel safe
set search_path = ''
as $$
  select coalesce(
    nullif(pg_catalog.btrim(display), ''),
    case
      when nullif(pg_catalog.btrim(utama), '') is not null and nullif(pg_catalog.btrim(alternatif), '') is not null
        then pg_catalog.btrim(utama) || ' atau ' || pg_catalog.btrim(alternatif)
      else coalesce(nullif(pg_catalog.btrim(utama), ''), nullif(pg_catalog.btrim(alternatif), ''), '')
    end)
$$;

-- Item part of the legacy corpus.
create or replace function app.item_search_doc(
  no_utama text, no_alt text, no_display text, uraian text, kode text,
  no_item integer, nama_file text, kondisi text)
returns text
language sql immutable parallel safe
set search_path = ''
as $$
  select app.search_norm(
    coalesce(no_utama, '') || ' ' || coalesce(no_alt, '') || ' ' || coalesce(no_display, '') || ' ' ||
    coalesce(uraian, '') || ' ' || coalesce(kode, '') || ' ' || coalesce(no_item::text, '') || ' ' ||
    coalesce(nama_file, '') || ' ' || coalesce(kondisi, ''))
$$;

-- Berkas part of the legacy corpus (judul, klasifikasi, lokasi label, no. berkas).
create or replace function app.berkas_search_doc(
  judul text, kode text, uraian_klasifikasi text, kabinet text, laci text, folder text, no_berkas integer)
returns text
language sql immutable parallel safe
set search_path = ''
as $$
  select app.search_norm(
    coalesce(judul, '') || ' ' || coalesce(kode, '') || ' ' || coalesce(uraian_klasifikasi, '') || ' ' ||
    app.lokasi_label(kabinet, laci, folder, no_berkas) || ' ' || coalesce(no_berkas::text, ''))
$$;

-- Port of archiveSearchScore_ (q is already normalised).
create or replace function app.search_score(
  q text, utama text, alt text, display text, judul text, kode text, uraian text)
returns integer
language sql immutable parallel safe
set search_path = ''
as $$
  select case
    when q is null or q = '' then 0
    when q in (app.search_norm(utama), app.search_norm(alt), app.search_norm(display)) then 1000
    when app.search_norm(utama) like q || '%' or app.search_norm(alt) like q || '%' then 800
    when pg_catalog.strpos(app.search_norm(utama), q) > 0 or pg_catalog.strpos(app.search_norm(alt), q) > 0
      or pg_catalog.strpos(app.search_norm(display), q) > 0 then 600
    when pg_catalog.strpos(app.search_norm(judul), q) > 0 then 300
    when pg_catalog.strpos(app.search_norm(kode), q) > 0 then 200
    when pg_catalog.strpos(app.search_norm(uraian), q) > 0 then 100
    else 10
  end
$$;

-- The invoker (authenticated) must be able to call the helpers.
grant execute on function app.search_norm(text) to authenticated, service_role;
grant execute on function app.lokasi_label(text, text, text, integer) to authenticated, service_role;
grant execute on function app.display_no_surat(text, text, text) to authenticated, service_role;
grant execute on function app.item_search_doc(text, text, text, text, text, integer, text, text) to authenticated, service_role;
grant execute on function app.berkas_search_doc(text, text, text, text, text, text, integer) to authenticated, service_role;
grant execute on function app.search_score(text, text, text, text, text, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Indexes. Trigram expression indexes only when pg_trgm is installed; the
-- operator class is looked up in whatever schema holds the extension.
-- ---------------------------------------------------------------------------
create index if not exists item_search_active_idx on public.item (unit_id, berkas_id) where not is_deleted;
create index if not exists penerimaan_item_waiting_idx on public.penerimaan_item (unit_id, penerimaan_id)
  where not is_deleted and status_pemberkasan in ('BELUM DIBERKASKAN', 'PERLU DILENGKAPI');

do $$
declare
  trgm_schema text;
begin
  select n.nspname into trgm_schema
  from pg_extension e join pg_namespace n on n.oid = e.extnamespace
  where e.extname = 'pg_trgm';
  if trgm_schema is null then
    return;
  end if;
  execute format(
    'create index if not exists item_search_doc_trgm on public.item using gin ('
    || 'app.item_search_doc(no_surat_utama, no_surat_alternatif, no_surat_display, uraian_lengkap, '
    || 'kode_klasifikasi_snapshot, no_item_definitif, nama_file, kondisi_fisik) %I.gin_trgm_ops)',
    trgm_schema);
  execute format(
    'create index if not exists berkas_search_doc_trgm on public.berkas using gin ('
    || 'app.berkas_search_doc(judul_berkas, kode_klasifikasi_snapshot, uraian_klasifikasi_snapshot, '
    || 'no_filling_kabinet, no_laci, no_folder, no_berkas_definitif) %I.gin_trgm_ops)',
    trgm_schema);
end
$$;

-- ---------------------------------------------------------------------------
-- public.search_archive — item-level hits joined with their berkas.
-- Returns jsonb: { total, limit, offset, results: [ ... ] }.
-- ---------------------------------------------------------------------------
create or replace function public.search_archive(
  p_query            text    default null,
  p_classification   text    default null,
  p_development      text    default 'ALL',
  p_file_status      text    default 'ALL',
  p_date_from        date    default null,
  p_date_to          date    default null,
  p_unit_id          uuid    default null,
  p_include_deleted  boolean default false,
  p_limit            integer default 20,
  p_offset           integer default 0
)
returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_query   text := app.search_norm(pg_catalog.left(coalesce(p_query, ''), 250));
  v_class   text := app.search_norm(pg_catalog.left(coalesce(p_classification, ''), 80));
  v_dev     text := pg_catalog.upper(coalesce(nullif(pg_catalog.btrim(p_development), ''), 'ALL'));
  v_file    text := pg_catalog.upper(coalesce(nullif(pg_catalog.btrim(p_file_status), ''), 'ALL'));
  v_limit   integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_offset  integer := greatest(coalesce(p_offset, 0), 0);
  v_tokens  text[];
  v_lead    text;
  v_result  jsonb;
begin
  if v_dev not in ('ALL', 'ASLI', 'COPY') then
    raise exception 'Filter tingkat perkembangan tidak valid.' using errcode = '22023';
  end if;
  if v_file not in ('ALL', 'TERSEDIA', 'BELUM_DIUNGGAH') then
    raise exception 'Filter status alih media tidak valid.' using errcode = '22023';
  end if;
  if p_date_from is not null and p_date_to is not null and p_date_from > p_date_to then
    raise exception 'Tanggal awal tidak boleh lebih besar daripada tanggal akhir.' using errcode = '22023';
  end if;

  v_tokens := case when v_query = '' then array[]::text[] else pg_catalog.string_to_array(v_query, ' ') end;
  -- Longest token (>= 3 chars) narrows candidates through the trigram indexes.
  select t into v_lead from pg_catalog.unnest(v_tokens) t
  where pg_catalog.length(t) >= 3 order by pg_catalog.length(t) desc, t limit 1;

  with matched as materialized (
    select
      i.id                                   as item_id,
      i.berkas_id,
      i.unit_id,
      coalesce(b.no_berkas_definitif, i.no_berkas_snapshot) as no_berkas,
      i.no_item_definitif                    as no_item,
      b.judul_berkas,
      app.display_no_surat(i.no_surat_display, i.no_surat_utama, i.no_surat_alternatif) as no_surat,
      i.no_surat_utama,
      i.no_surat_alternatif,
      i.tanggal_naskah,
      i.uraian_lengkap                        as uraian,
      i.jumlah_halaman,
      i.tingkat_perkembangan,
      i.kondisi_fisik,
      coalesce(nullif(pg_catalog.btrim(i.kode_klasifikasi_snapshot), ''), b.kode_klasifikasi_snapshot) as kode_klasifikasi,
      b.uraian_klasifikasi_snapshot           as uraian_klasifikasi,
      b.no_filling_kabinet                    as kabinet,
      b.no_laci                               as laci,
      coalesce(nullif(pg_catalog.btrim(b.no_folder), ''), b.no_berkas_definitif::text) as folder,
      app.lokasi_label(b.no_filling_kabinet, b.no_laci, b.no_folder, b.no_berkas_definitif) as lokasi,
      coalesce(i.klasifikasi_keamanan_akses, b.klasifikasi_keamanan_akses) as klasifikasi_keamanan,
      (nullif(pg_catalog.btrim(i.drive_file_id), '') is not null) as has_file,
      nullif(pg_catalog.btrim(i.drive_file_id), '')  as drive_file_id,
      nullif(pg_catalog.btrim(i.drive_file_url), '') as drive_file_url,
      nullif(pg_catalog.btrim(b.drive_folder_url), '') as drive_folder_url,
      case when pg_catalog.upper(coalesce(i.status_peminjaman, 'TERSEDIA')) <> 'TERSEDIA'
           then pg_catalog.upper(i.status_peminjaman)
           else pg_catalog.upper(coalesce(b.status_peminjaman, 'TERSEDIA')) end as status_peminjaman,
      b.status_berkas,
      (i.is_deleted or b.is_deleted or b.status_berkas in ('DIHAPUS', 'GAGAL')) as dibatalkan,
      app.search_score(v_query, i.no_surat_utama, i.no_surat_alternatif, i.no_surat_display, b.judul_berkas,
        coalesce(nullif(pg_catalog.btrim(i.kode_klasifikasi_snapshot), ''), b.kode_klasifikasi_snapshot),
        i.uraian_lengkap) as score
    from public.item i
    join public.berkas b on b.unit_id = i.unit_id and b.id = i.berkas_id
    where (p_unit_id is null or i.unit_id = p_unit_id)
      and (p_include_deleted
           or (not i.is_deleted and not b.is_deleted and b.status_berkas not in ('DIHAPUS', 'GAGAL')))
      and (v_dev = 'ALL' or pg_catalog.upper(coalesce(i.tingkat_perkembangan, '')) = v_dev)
      and (v_file = 'ALL'
           or (v_file = 'TERSEDIA' and nullif(pg_catalog.btrim(i.drive_file_id), '') is not null)
           or (v_file = 'BELUM_DIUNGGAH' and nullif(pg_catalog.btrim(i.drive_file_id), '') is null))
      and (p_date_from is null or i.tanggal_naskah >= p_date_from)
      and (p_date_to is null or i.tanggal_naskah <= p_date_to)
      and (v_class = '' or pg_catalog.strpos(app.search_norm(
             coalesce(nullif(pg_catalog.btrim(i.kode_klasifikasi_snapshot), ''), b.kode_klasifikasi_snapshot)), v_class) > 0)
      and (v_lead is null or i.id in (
             select i2.id from public.item i2
             where app.item_search_doc(i2.no_surat_utama, i2.no_surat_alternatif, i2.no_surat_display, i2.uraian_lengkap,
                     i2.kode_klasifikasi_snapshot, i2.no_item_definitif, i2.nama_file, i2.kondisi_fisik)
                   like '%' || v_lead || '%'
             union
             select i3.id from public.item i3
             join public.berkas b3 on b3.unit_id = i3.unit_id and b3.id = i3.berkas_id
             where app.berkas_search_doc(b3.judul_berkas, b3.kode_klasifikasi_snapshot, b3.uraian_klasifikasi_snapshot,
                     b3.no_filling_kabinet, b3.no_laci, b3.no_folder, b3.no_berkas_definitif)
                   like '%' || v_lead || '%'))
      and not exists (
             select 1 from pg_catalog.unnest(v_tokens) t
             where pg_catalog.strpos(app.item_search_doc(i.no_surat_utama, i.no_surat_alternatif, i.no_surat_display,
                     i.uraian_lengkap, i.kode_klasifikasi_snapshot, i.no_item_definitif, i.nama_file, i.kondisi_fisik), t) = 0
               and pg_catalog.strpos(app.berkas_search_doc(b.judul_berkas, b.kode_klasifikasi_snapshot,
                     b.uraian_klasifikasi_snapshot, b.no_filling_kabinet, b.no_laci, b.no_folder,
                     b.no_berkas_definitif), t) = 0)
  ),
  page as (
    select m.* from matched m
    order by m.score desc, m.no_berkas asc nulls last, m.no_item asc nulls last, m.berkas_id, m.item_id
    limit v_limit offset v_offset
  )
  select pg_catalog.jsonb_build_object(
    'total',  (select count(*) from matched),
    'limit',  v_limit,
    'offset', v_offset,
    'results', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p)
               order by p.score desc, p.no_berkas asc nulls last, p.no_item asc nulls last, p.berkas_id, p.item_id)
      from page p), '[]'::jsonb))
  into v_result;

  return v_result;
end
$$;

comment on function public.search_archive(text, text, text, text, date, date, uuid, boolean, integer, integer) is
  'Cari Arsip (port of legacy searchArchive_). SECURITY INVOKER: RLS limits rows to the caller''s unit.';

-- ---------------------------------------------------------------------------
-- public.get_item_detail — one item with its berkas and location (or null).
-- ---------------------------------------------------------------------------
create or replace function public.get_item_detail(p_item_id text)
returns jsonb
language sql stable security invoker
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'item_id', i.id,
    'berkas_id', i.berkas_id,
    'unit_id', i.unit_id,
    'no_berkas', coalesce(b.no_berkas_definitif, i.no_berkas_snapshot),
    'no_item', i.no_item_definitif,
    'judul_berkas', b.judul_berkas,
    'no_surat', app.display_no_surat(i.no_surat_display, i.no_surat_utama, i.no_surat_alternatif),
    'no_surat_utama', i.no_surat_utama,
    'no_surat_alternatif', i.no_surat_alternatif,
    'tanggal_naskah', i.tanggal_naskah,
    'uraian', i.uraian_lengkap,
    'jumlah_halaman', i.jumlah_halaman,
    'tingkat_perkembangan', i.tingkat_perkembangan,
    'kondisi_fisik', i.kondisi_fisik,
    'media_sumber', i.media_sumber,
    'status_bentuk_digital', i.status_bentuk_digital,
    'kode_klasifikasi', coalesce(nullif(pg_catalog.btrim(i.kode_klasifikasi_snapshot), ''), b.kode_klasifikasi_snapshot),
    'uraian_klasifikasi', b.uraian_klasifikasi_snapshot,
    'kabinet', b.no_filling_kabinet,
    'laci', b.no_laci,
    'folder', coalesce(nullif(pg_catalog.btrim(b.no_folder), ''), b.no_berkas_definitif::text),
    'lokasi', app.lokasi_label(b.no_filling_kabinet, b.no_laci, b.no_folder, b.no_berkas_definitif),
    'klasifikasi_keamanan', coalesce(i.klasifikasi_keamanan_akses, b.klasifikasi_keamanan_akses),
    'has_file', nullif(pg_catalog.btrim(i.drive_file_id), '') is not null,
    'drive_file_id', nullif(pg_catalog.btrim(i.drive_file_id), ''),
    'drive_file_url', nullif(pg_catalog.btrim(i.drive_file_url), ''),
    'drive_folder_url', nullif(pg_catalog.btrim(b.drive_folder_url), ''),
    'nama_file', i.nama_file,
    'status_peminjaman',
      case when pg_catalog.upper(coalesce(i.status_peminjaman, 'TERSEDIA')) <> 'TERSEDIA'
           then pg_catalog.upper(i.status_peminjaman)
           else pg_catalog.upper(coalesce(b.status_peminjaman, 'TERSEDIA')) end,
    'status_berkas', b.status_berkas,
    'dibatalkan', (i.is_deleted or b.is_deleted or b.status_berkas in ('DIHAPUS', 'GAGAL')),
    'nomor_tanda_terima', i.nomor_tanda_terima_snapshot,
    'catatan', i.catatan)
  from public.item i
  join public.berkas b on b.unit_id = i.unit_id and b.id = i.berkas_id
  where i.id = p_item_id
$$;

-- ---------------------------------------------------------------------------
-- public.get_berkas_detail — Daftar Isi Berkas (or null).
-- Items in order (no. item, then legacy sort keys); totals over active items.
-- ---------------------------------------------------------------------------
create or replace function public.get_berkas_detail(p_berkas_id text, p_include_deleted boolean default false)
returns jsonb
language sql stable security invoker
set search_path = ''
as $$
  with b as (
    select * from public.berkas where id = p_berkas_id
  ),
  items as (
    select i.*
    from public.item i join b on b.unit_id = i.unit_id and b.id = i.berkas_id
    where p_include_deleted or not i.is_deleted
  )
  select pg_catalog.jsonb_build_object(
    'berkas_id', b.id,
    'unit_id', b.unit_id,
    'no_berkas', b.no_berkas_definitif,
    'judul_berkas', b.judul_berkas,
    'kode_klasifikasi', b.kode_klasifikasi_snapshot,
    'uraian_klasifikasi', b.uraian_klasifikasi_snapshot,
    'kurun_waktu', b.kurun_waktu,
    'kabinet', b.no_filling_kabinet,
    'laci', b.no_laci,
    'folder', coalesce(nullif(pg_catalog.btrim(b.no_folder), ''), b.no_berkas_definitif::text),
    'lokasi', app.lokasi_label(b.no_filling_kabinet, b.no_laci, b.no_folder, b.no_berkas_definitif),
    'klasifikasi_keamanan', b.klasifikasi_keamanan_akses,
    'drive_folder_url', nullif(pg_catalog.btrim(b.drive_folder_url), ''),
    'status_berkas', b.status_berkas,
    'status_peminjaman', b.status_peminjaman,
    'status_retensi', b.status_retensi,
    'nasib_akhir', b.nasib_akhir,
    'dibatalkan', (b.is_deleted or b.status_berkas in ('DIHAPUS', 'GAGAL')),
    'jumlah_item', (select count(*) from items where not is_deleted),
    'total_lembar', (select coalesce(sum(jumlah_halaman), 0) from items where not is_deleted),
    'tanggal_awal', (select min(tanggal_naskah) from items where not is_deleted),
    'tanggal_akhir', (select max(tanggal_naskah) from items where not is_deleted),
    'items', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'item_id', i.id,
               'no_item', i.no_item_definitif,
               'no_surat', app.display_no_surat(i.no_surat_display, i.no_surat_utama, i.no_surat_alternatif),
               'tanggal_naskah', i.tanggal_naskah,
               'uraian', i.uraian_lengkap,
               'jumlah_halaman', i.jumlah_halaman,
               'tingkat_perkembangan', i.tingkat_perkembangan,
               'klasifikasi_keamanan', coalesce(i.klasifikasi_keamanan_akses, b.klasifikasi_keamanan_akses),
               'has_file', nullif(pg_catalog.btrim(i.drive_file_id), '') is not null,
               'drive_file_id', nullif(pg_catalog.btrim(i.drive_file_id), ''),
               'drive_file_url', nullif(pg_catalog.btrim(i.drive_file_url), ''),
               'dibatalkan', i.is_deleted)
             order by i.no_item_definitif asc nulls last, i.tanggal_naskah asc nulls last,
                      i.sort_no_surat_normalized asc nulls last, i.sort_created_at asc nulls last, i.id)
      from items i), '[]'::jsonb))
  from b
$$;

-- ---------------------------------------------------------------------------
-- public.dashboard_counts — only what the S1 tables support.
-- ---------------------------------------------------------------------------
create or replace function public.dashboard_counts(p_unit_id uuid default null)
returns jsonb
language sql stable security invoker
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'berkas_aktif', (
      select count(*) from public.berkas b
      where (p_unit_id is null or b.unit_id = p_unit_id)
        and not b.is_deleted and b.status_berkas = 'AKTIF'),
    'item_aktif', (
      select count(*) from public.item i
      join public.berkas b on b.unit_id = i.unit_id and b.id = i.berkas_id
      where (p_unit_id is null or i.unit_id = p_unit_id)
        and not i.is_deleted and not b.is_deleted and b.status_berkas not in ('DIHAPUS', 'GAGAL')),
    'item_tanpa_pdf', (
      select count(*) from public.item i
      join public.berkas b on b.unit_id = i.unit_id and b.id = i.berkas_id
      where (p_unit_id is null or i.unit_id = p_unit_id)
        and not i.is_deleted and not b.is_deleted and b.status_berkas not in ('DIHAPUS', 'GAGAL')
        and nullif(pg_catalog.btrim(i.drive_file_id), '') is null),
    'penerimaan_menunggu', (
      select count(*) from public.penerimaan_item pi
      join public.penerimaan p on p.unit_id = pi.unit_id and p.id = pi.penerimaan_id
      where (p_unit_id is null or pi.unit_id = p_unit_id)
        and not pi.is_deleted and p.status = 'AKTIF'
        and pi.status_pemberkasan in ('BELUM DIBERKASKAN', 'PERLU DILENGKAPI')))
$$;

-- ---------------------------------------------------------------------------
-- Privileges: authenticated only.
-- ---------------------------------------------------------------------------
revoke all on function public.search_archive(text, text, text, text, date, date, uuid, boolean, integer, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.get_item_detail(text) from public, anon, authenticated, service_role;
revoke all on function public.get_berkas_detail(text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.dashboard_counts(uuid) from public, anon, authenticated, service_role;

grant execute on function public.search_archive(text, text, text, text, date, date, uuid, boolean, integer, integer)
  to authenticated, service_role;
grant execute on function public.get_item_detail(text) to authenticated, service_role;
grant execute on function public.get_berkas_detail(text, boolean) to authenticated, service_role;
grant execute on function public.dashboard_counts(uuid) to authenticated, service_role;

-- Self-check
do $$
begin
  if has_function_privilege('anon', 'public.search_archive(text, text, text, text, date, date, uuid, boolean, integer, integer)', 'EXECUTE')
     or has_function_privilege('anon', 'public.dashboard_counts(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.get_item_detail(text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.get_berkas_detail(text, boolean)', 'EXECUTE') then
    raise exception 'search self-check: anon can execute a search function';
  end if;
  if exists (select 1 from pg_proc
             where oid in ('public.search_archive(text, text, text, text, date, date, uuid, boolean, integer, integer)'::regprocedure,
                           'public.get_item_detail(text)'::regprocedure,
                           'public.get_berkas_detail(text, boolean)'::regprocedure,
                           'public.dashboard_counts(uuid)'::regprocedure)
               and prosecdef) then
    raise exception 'search self-check: search functions must be SECURITY INVOKER';
  end if;
end
$$;

insert into public.schema_migrations_log (version, name)
values ('0006', 'search') on conflict (version) do nothing;
