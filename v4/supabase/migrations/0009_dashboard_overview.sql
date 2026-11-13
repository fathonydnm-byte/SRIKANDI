-- 0009_dashboard_overview.sql
-- Dashboard parity with 3.x (Services.js getDashboardSummary_ /
-- getDashboardArchiveOverview_, RetentionService.js retentionPresentation_).
-- All public functions are SECURITY INVOKER (RLS: own unit; ADMIN_PUSAT all),
-- authenticated only. Idempotent.
--
-- "Active berkas" (legacy getDashboardSummary_): not deleted, not DIHAPUS/GAGAL,
-- and STATUS_PEMINDAHAN <> 'SUDAH DIPINDAHKAN' (transferred berkas are history).
-- DRAFT berkas count in Total Berkas (as in 3.x); the Daftar Isi list shows
-- only berkas with a definitive number (as in 3.x).
--
-- Retention (legacy retentionDayDifference_): days = batas_aktif - today, where
-- today is the local date in Asia/Jakarta. H-7 = 0..7 inclusive, Habis Aktif
-- = < 0. Berkas in a transfer proposal are included; transferred are excluded.
--
-- "Sedang Dipinjam": the PEMINJAMAN table arrives in Sprint 4. Until then the
-- count is the number of active berkas whose own STATUS_PEMINJAMAN, or that of
-- any of their active items, is not TERSEDIA (columns kept up to date by 3.x
-- LoanService and imported). 3.x counts loan TRANSACTIONS (distinct loan
-- groups with STATUS = DIPINJAM), so one transaction covering 3 berkas is 1
-- in 3.x and 3 here.
--
-- Status badge (legacy syncRetentionStatuses_ values, computed live instead of
-- read from the stored STATUS_RETENSI snapshot):
--   USUL_PINDAH_ID_AKTIF set   -> 'DALAM USUL PEMINDAHAN'           (PROPOSED)
--   no BATAS_AKTIF             -> stored STATUS_RETENSI or 'AKTIF'   (PENDING)
--   days < 0                   -> 'HABIS AKTIF – KANDIDAT USUL PINDAH' (EXPIRED)
--   0 <= days <= 7             -> 'H-<days>'                         (DUE)
--   otherwise                  -> 'AKTIF'                            (ACTIVE)

create or replace function app.today_jakarta()
returns date
language sql stable
set search_path = ''
as $$
  select (pg_catalog.now() at time zone 'Asia/Jakarta')::date
$$;

-- One row per active berkas with everything the dashboard needs.
create or replace function app.dashboard_berkas(p_unit_id uuid)
returns table (
  berkas_id text, unit_id uuid, no_berkas integer, judul_berkas text, kode_klasifikasi text,
  kurun_waktu text, kabinet text, laci text, folder text, lokasi text,
  item_count bigint, total_lembar bigint, item_dipinjam bigint,
  status_peminjaman text, dipinjam boolean,
  batas_aktif date, batas_inaktif date, days_to_active_limit integer,
  status_code text, status_label text, usul_pindah_no text, status_berkas text
)
language sql stable
set search_path = ''
as $$
  with today as (select app.today_jakarta() d),
  b as (
    select * from public.berkas x
    where (p_unit_id is null or x.unit_id = p_unit_id)
      and not x.is_deleted
      and x.status_berkas not in ('DIHAPUS', 'GAGAL')
      and pg_catalog.upper(coalesce(x.status_pemindahan, '')) <> 'SUDAH DIPINDAHKAN'
  ),
  agg as (
    select i.unit_id, i.berkas_id,
           count(*) as n,
           coalesce(sum(i.jumlah_halaman), 0) as pages,
           count(*) filter (where pg_catalog.upper(coalesce(i.status_peminjaman, 'TERSEDIA')) <> 'TERSEDIA') as borrowed
    from public.item i
    join b on b.unit_id = i.unit_id and b.id = i.berkas_id
    where not i.is_deleted
    group by i.unit_id, i.berkas_id
  )
  select
    b.id, b.unit_id, b.no_berkas_definitif, b.judul_berkas, b.kode_klasifikasi_snapshot,
    b.kurun_waktu, b.no_filling_kabinet, b.no_laci,
    coalesce(nullif(pg_catalog.btrim(b.no_folder), ''), b.no_berkas_definitif::text),
    app.lokasi_label(b.no_filling_kabinet, b.no_laci, b.no_folder, b.no_berkas_definitif),
    coalesce(a.n, 0), coalesce(a.pages, 0), coalesce(a.borrowed, 0),
    pg_catalog.upper(coalesce(b.status_peminjaman, 'TERSEDIA')),
    (pg_catalog.upper(coalesce(b.status_peminjaman, 'TERSEDIA')) <> 'TERSEDIA' or coalesce(a.borrowed, 0) > 0),
    b.batas_aktif, b.batas_inaktif,
    (b.batas_aktif - t.d),
    case
      when nullif(pg_catalog.btrim(b.usul_pindah_id_aktif), '') is not null then 'PROPOSED'
      when b.batas_aktif is null then 'PENDING'
      when b.batas_aktif < t.d then 'EXPIRED'
      when b.batas_aktif - t.d <= 7 then 'DUE'
      else 'ACTIVE'
    end,
    case
      when nullif(pg_catalog.btrim(b.usul_pindah_id_aktif), '') is not null then 'DALAM USUL PEMINDAHAN'
      when b.batas_aktif is null then coalesce(nullif(pg_catalog.btrim(b.status_retensi), ''), 'AKTIF')
      when b.batas_aktif < t.d then 'HABIS AKTIF – KANDIDAT USUL PINDAH'
      when b.batas_aktif - t.d <= 7 then 'H-' || (b.batas_aktif - t.d)
      else 'AKTIF'
    end,
    nullif(pg_catalog.btrim(b.usul_pindah_no_aktif), ''),
    b.status_berkas
  from b
  cross join today t
  left join agg a on a.unit_id = b.unit_id and a.berkas_id = b.id
$$;

-- ---------------------------------------------------------------------------
-- Stored search documents (normalised corpus of 0006) so trigram rechecks and
-- per-token checks read text instead of recomputing regexp work per row
-- (measured ±40–60 µs/row → 1–2 s per search at 20k items before).
-- NOTE: stored values are not recomputed if app.item_search_doc /
-- app.berkas_search_doc are ever redefined; a later migration must then run
-- `update public.item set uraian_lengkap = uraian_lengkap` (and berkas) to refresh.
-- ---------------------------------------------------------------------------
alter table public.item add column if not exists search_doc text
  generated always as (app.item_search_doc(no_surat_utama, no_surat_alternatif, no_surat_display, uraian_lengkap,
    kode_klasifikasi_snapshot, no_item_definitif, nama_file, kondisi_fisik)) stored;
alter table public.berkas add column if not exists search_doc text
  generated always as (app.berkas_search_doc(judul_berkas, kode_klasifikasi_snapshot, uraian_klasifikasi_snapshot,
    no_filling_kabinet, no_laci, no_folder, no_berkas_definitif)) stored;

-- Replace the expression indexes of 0006 with indexes on the stored columns.
drop index if exists public.item_search_doc_trgm;
drop index if exists public.berkas_search_doc_trgm;
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
  execute format('create index if not exists item_search_doc_col_trgm on public.item using gin (search_doc %I.gin_trgm_ops)', trgm_schema);
  execute format('create index if not exists berkas_search_doc_col_trgm on public.berkas using gin (search_doc %I.gin_trgm_ops)', trgm_schema);
end
$$;

-- ---------------------------------------------------------------------------
-- Trigram candidates under RLS.
-- Under RLS Postgres does not use an index for a non-LEAKPROOF operator such
-- as LIKE (it must evaluate the policy first), so the trigram indexes of 0006
-- were never used for `authenticated` (measured: 0.9 s seq scan vs 3 ms with
-- the index on 20k items; search_archive 3.8 s). These SECURITY DEFINER
-- helpers do the indexed lookup and return item ids, filtered EXPLICITLY to
-- the caller's unit (ADMIN_PUSAT: all or p_unit_id); callers then restrict
-- with `id = ANY(...)` (leakproof, primary key) and RLS still applies to the
-- rows they return. They reveal nothing RLS would not show.
-- ---------------------------------------------------------------------------
create or replace function app.trgm_candidate_items(p_token text, p_unit_id uuid)
returns text[]
language sql stable security definer
set search_path = ''
as $$
  with scope as (
    select app.current_role() as role, app.current_unit_id() as unit_id
  ),
  units as (
    select case when s.role = 'ADMIN_PUSAT' then p_unit_id else s.unit_id end as unit_id,
           (s.role = 'ADMIN_PUSAT' and p_unit_id is null) as all_units
    from scope s where s.role is not null
  )
  select coalesce(pg_catalog.array_agg(distinct x.id), '{}'::text[])
  from units u
  cross join lateral (
    select i.id from public.item i
    where i.search_doc like '%' || p_token || '%'
      and (u.all_units or i.unit_id = u.unit_id)
    union
    select i.id from public.berkas b
    join public.item i on i.unit_id = b.unit_id and i.berkas_id = b.id
    where b.search_doc like '%' || p_token || '%'
      and (u.all_units or b.unit_id = u.unit_id)
  ) x
  where p_token ~ '^[A-Z0-9]{3,}$'
$$;

create or replace function app.trgm_item_ids(p_token text, p_unit_id uuid)
returns text[]
language sql stable security definer
set search_path = ''
as $$
  with scope as (
    select app.current_role() as role, app.current_unit_id() as unit_id
  )
  select coalesce(pg_catalog.array_agg(i.id), '{}'::text[])
  from scope s
  join public.item i
    on (case when s.role = 'ADMIN_PUSAT' then (p_unit_id is null or i.unit_id = p_unit_id) else i.unit_id = s.unit_id end)
  where s.role is not null
    and p_token ~ '^[A-Z0-9]{3,}$'
    and i.search_doc like '%' || p_token || '%'
$$;

revoke all on function app.trgm_candidate_items(text, uuid) from public, anon, authenticated, service_role;
revoke all on function app.trgm_item_ids(text, uuid) from public, anon, authenticated, service_role;
grant execute on function app.trgm_candidate_items(text, uuid) to authenticated, service_role;
grant execute on function app.trgm_item_ids(text, uuid) to authenticated, service_role;

-- search_archive (0006) re-created to use the candidates above; results unchanged.
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
  v_ids     text[];
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
  where pg_catalog.length(t) >= 3 order by (t ~ '[0-9]') desc, pg_catalog.length(t) desc, t limit 1;
  -- Kandidat lewat indeks trigram (fungsi definer, dibatasi unit pemanggil);
  -- baris akhirnya tetap disaring RLS di kueri di bawah.
  if v_lead is not null then
    v_ids := app.trgm_candidate_items(v_lead, p_unit_id);
  end if;

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
      and (v_ids is null or i.id = any (v_ids))
      and not exists (
             select 1 from pg_catalog.unnest(v_tokens) t
             where pg_catalog.strpos(i.search_doc, t) = 0
               and pg_catalog.strpos(b.search_doc, t) = 0)
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

-- ---------------------------------------------------------------------------
-- public.dashboard_overview — five counts + Daftar Isi Berkas (rows only;
-- items are loaded per berkas on expand, see dashboard_berkas_items).
-- ---------------------------------------------------------------------------
create or replace function public.dashboard_overview(p_unit_id uuid default null)
returns jsonb
language sql stable security invoker
set search_path = ''
as $$
  with rows as materialized (select * from app.dashboard_berkas(p_unit_id))
  select pg_catalog.jsonb_build_object(
    'today', app.today_jakarta(),
    'counts', pg_catalog.jsonb_build_object(
      'total_berkas', (select count(*) from rows),
      'total_item', (select coalesce(sum(item_count), 0) from rows),
      'sedang_dipinjam', (select count(*) from rows where dipinjam),
      'retensi_h7', (select count(*) from rows where days_to_active_limit between 0 and 7),
      'habis_aktif', (select count(*) from rows where days_to_active_limit < 0)),
    'groups', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'berkas_id', r.berkas_id, 'no_berkas', r.no_berkas, 'judul_berkas', r.judul_berkas,
               'kode_klasifikasi', r.kode_klasifikasi, 'kurun_waktu', r.kurun_waktu,
               'kabinet', r.kabinet, 'laci', r.laci, 'folder', r.folder, 'lokasi', r.lokasi,
               'item_count', r.item_count, 'total_lembar', r.total_lembar,
               'status_code', r.status_code, 'status_label', r.status_label,
               'batas_aktif', r.batas_aktif, 'days_to_active_limit', r.days_to_active_limit,
               'dipinjam', r.dipinjam)
             order by r.no_berkas, r.berkas_id)
      from rows r where r.no_berkas is not null), '[]'::jsonb))
$$;

-- ---------------------------------------------------------------------------
-- public.dashboard_shortcut — lists behind the three shortcut cards.
--   DIPINJAM: borrowed berkas (number order)
--   H7:       0..7 days to batas_aktif (soonest first)
--   HABIS:    batas_aktif passed (longest overdue first)
-- Zero rows is a valid answer (the page shows an empty list).
-- ---------------------------------------------------------------------------
create or replace function public.dashboard_shortcut(p_kind text, p_unit_id uuid default null)
returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_kind text := pg_catalog.upper(coalesce(p_kind, ''));
begin
  if v_kind not in ('DIPINJAM', 'H7', 'HABIS') then
    raise exception 'Jenis daftar tidak dikenal.' using errcode = '22023';
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'berkas_id', r.berkas_id, 'no_berkas', r.no_berkas, 'judul_berkas', r.judul_berkas,
             'kode_klasifikasi', r.kode_klasifikasi, 'kurun_waktu', r.kurun_waktu,
             'kabinet', r.kabinet, 'laci', r.laci, 'folder', r.folder, 'lokasi', r.lokasi,
             'item_count', r.item_count, 'total_lembar', r.total_lembar,
             'item_dipinjam', r.item_dipinjam, 'status_peminjaman', r.status_peminjaman,
             'status_code', r.status_code, 'status_label', r.status_label,
             'batas_aktif', r.batas_aktif, 'batas_inaktif', r.batas_inaktif,
             'days_to_active_limit', r.days_to_active_limit, 'usul_pindah_no', r.usul_pindah_no,
             'dipinjam', r.dipinjam)
           order by
             case when v_kind in ('H7', 'HABIS') then r.batas_aktif end,
             r.no_berkas nulls last, r.berkas_id)
    from app.dashboard_berkas(p_unit_id) r
    where (v_kind = 'DIPINJAM' and r.dipinjam)
       or (v_kind = 'H7' and r.days_to_active_limit between 0 and 7)
       or (v_kind = 'HABIS' and r.days_to_active_limit < 0)), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------------------
-- public.dashboard_berkas_items — items of up to 100 berkas in one call
-- ("Buka Semua" without one request per row). {berkas_id: [items...]}
-- ---------------------------------------------------------------------------
create or replace function public.dashboard_berkas_items(p_berkas_ids text[])
returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
begin
  if p_berkas_ids is null or pg_catalog.cardinality(p_berkas_ids) > 100 then
    raise exception 'Maksimal 100 berkas per permintaan.' using errcode = '22023';
  end if;
  return coalesce((
    select pg_catalog.jsonb_object_agg(g.berkas_id, g.items)
    from (
      select i.berkas_id,
             pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'item_id', i.id, 'no_item', i.no_item_definitif,
               'no_surat', app.display_no_surat(i.no_surat_display, i.no_surat_utama, i.no_surat_alternatif),
               'uraian', i.uraian_lengkap, 'jumlah_halaman', i.jumlah_halaman,
               'tanggal_naskah', i.tanggal_naskah, 'tingkat_perkembangan', i.tingkat_perkembangan,
               'has_file', nullif(pg_catalog.btrim(i.drive_file_id), '') is not null,
               'status_peminjaman', pg_catalog.upper(coalesce(i.status_peminjaman, 'TERSEDIA')))
               order by i.no_item_definitif nulls last, i.id) as items
      from public.item i
      join public.berkas b on b.unit_id = i.unit_id and b.id = i.berkas_id
      where i.berkas_id = any (p_berkas_ids)
        and not i.is_deleted and not b.is_deleted
      group by i.berkas_id
    ) g), '{}'::jsonb);
end
$$;

-- ---------------------------------------------------------------------------
-- public.dashboard_match_berkas — item-text part of the Daftar Isi filter
-- (3.x matched berkas fields OR any item's no. item / no. surat / uraian).
-- Uses the indexed item search document of 0006 (also covers nama file,
-- kode klasifikasi item and kondisi — a slight superset of 3.x).
-- Berkas fields are filtered in the browser; this returns the ids of active
-- berkas having an active item that contains every token. Max 2000 ids.
-- ---------------------------------------------------------------------------
create or replace function public.dashboard_match_berkas(p_query text, p_unit_id uuid default null)
returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_query  text := app.search_norm(pg_catalog.left(coalesce(p_query, ''), 250));
  v_tokens text[];
  v_lead   text;
  v_ids    text[];
begin
  if v_query = '' then
    return '[]'::jsonb;
  end if;
  v_tokens := pg_catalog.string_to_array(v_query, ' ');
  -- Most selective-looking token (digits first, then longest; >= 3 chars)
  -- goes through the trigram index (app.trgm_item_ids).
  select t into v_lead from pg_catalog.unnest(v_tokens) t
  where pg_catalog.length(t) >= 3 order by (t ~ '[0-9]') desc, pg_catalog.length(t) desc, t limit 1;
  if v_lead is not null then
    v_ids := app.trgm_item_ids(v_lead, p_unit_id);
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(x.berkas_id order by x.berkas_id)
    from (
      select distinct i.berkas_id
      from public.item i
      join public.berkas b on b.unit_id = i.unit_id and b.id = i.berkas_id
      where (p_unit_id is null or i.unit_id = p_unit_id)
        and not i.is_deleted and not b.is_deleted
        and b.status_berkas not in ('DIHAPUS', 'GAGAL')
        and pg_catalog.upper(coalesce(b.status_pemindahan, '')) <> 'SUDAH DIPINDAHKAN'
        and (v_ids is null or i.id = any (v_ids))
        and not exists (
          select 1 from pg_catalog.unnest(v_tokens) t
          where pg_catalog.strpos(i.search_doc, t) = 0)
      limit 2000
    ) x), '[]'::jsonb);
end
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on function app.today_jakarta() from public, anon, authenticated, service_role;
revoke all on function app.dashboard_berkas(uuid) from public, anon, authenticated, service_role;
grant execute on function app.today_jakarta() to authenticated, service_role;
grant execute on function app.dashboard_berkas(uuid) to authenticated, service_role;

revoke all on function public.search_archive(text, text, text, text, date, date, uuid, boolean, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.search_archive(text, text, text, text, date, date, uuid, boolean, integer, integer)
  to authenticated, service_role;
revoke all on function public.dashboard_overview(uuid) from public, anon, authenticated, service_role;
revoke all on function public.dashboard_shortcut(text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.dashboard_berkas_items(text[]) from public, anon, authenticated, service_role;
revoke all on function public.dashboard_match_berkas(text, uuid) from public, anon, authenticated, service_role;
grant execute on function public.dashboard_overview(uuid) to authenticated, service_role;
grant execute on function public.dashboard_shortcut(text, uuid) to authenticated, service_role;
grant execute on function public.dashboard_berkas_items(text[]) to authenticated, service_role;
grant execute on function public.dashboard_match_berkas(text, uuid) to authenticated, service_role;

do $$
declare
  f text;
begin
  foreach f in array array['public.dashboard_overview(uuid)', 'public.dashboard_shortcut(text, uuid)',
                           'public.dashboard_berkas_items(text[])', 'public.dashboard_match_berkas(text, uuid)',
                           'app.dashboard_berkas(uuid)',
                           'public.search_archive(text, text, text, text, date, date, uuid, boolean, integer, integer)'] loop
    if has_function_privilege('anon', f, 'EXECUTE') then
      raise exception 'dashboard self-check: anon can execute %', f;
    end if;
    if (select prosecdef from pg_proc where oid = f::regprocedure) then
      raise exception 'dashboard self-check: % must be SECURITY INVOKER', f;
    end if;
  end loop;
end
$$;

insert into public.schema_migrations_log (version, name)
values ('0009', 'dashboard_overview') on conflict (version) do nothing;
