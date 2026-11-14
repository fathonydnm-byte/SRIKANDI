-- 0016_s3_lidah_folder.sql
-- Sprint 3: Cetak Lidah Folder (port of central-file/LabelService.js).
--   * table  folder_label_log      (LOG_CETAK_LIDAH): one row per berkas per print, append-only
--   * read   folder_label_options  (apiGetFolderLabelOptions)   SECURITY INVOKER, RLS applies
--   * write  folder_label_print    (apiPrepareFolderLabels)     SECURITY DEFINER, idempotent, audited
-- Idempotent; no BEGIN/COMMIT. Helpers (actor, lock, idempotency, audit, errors) come from 0010. The label itself is laid out and printed by the browser (A4, 2 x 7, 70 x 30 mm);
-- the database keeps the snapshot of what was printed so that a metadata change can be flagged
-- "Perlu cetak ulang" exactly like 3.32.5 did.

-- ---------------------------------------------------------------------------
-- folder_label_log (LOG_CETAK_LIDAH), append-only
-- ---------------------------------------------------------------------------
create table if not exists public.folder_label_log (
  id                          text primary key,      -- PRINT_ID (PRN-…)
  unit_id                     uuid not null references public.units(id),
  seq                         bigint generated always as identity, -- insertion order: "latest print" tie-breaker (sheet order in 3.x)
  printed_at                  timestamptz not null default now(),  -- TIMESTAMP
  user_email                  text,                  -- USER_EMAIL
  batch_id                    text not null,         -- BATCH_ID (LBL-…)
  berkas_id                   text not null,         -- BERKAS_ID
  no_berkas_snapshot          text,                  -- NO_BERKAS_SNAPSHOT
  kode_klasifikasi_snapshot   text,                  -- KODE_KLASIFIKASI_SNAPSHOT
  judul_berkas_snapshot       text,                  -- JUDUL_BERKAS_SNAPSHOT
  start_slot                  integer,               -- START_SLOT (1..14)
  pdf_file_name               text,                  -- PDF_FILE_NAME
  status                      text not null default 'DICETAK', -- STATUS (PDF_DIBUAT = 3.x, DICETAK = v4)
  actor_user_id               uuid,                  -- (new)
  constraint folder_label_log_unit_id_key unique (unit_id, id),
  constraint folder_label_log_berkas_fk foreign key (unit_id, berkas_id)
    references public.berkas (unit_id, id) deferrable initially deferred,
  constraint folder_label_log_slot_check check (start_slot is null or start_slot between 1 and 14),
  constraint folder_label_log_status_check check (status in ('PDF_DIBUAT', 'DICETAK'))
);
create index if not exists folder_label_log_berkas_idx
  on public.folder_label_log (unit_id, berkas_id, printed_at desc, seq desc);
create index if not exists folder_label_log_batch_idx on public.folder_label_log (unit_id, batch_id);
create or replace trigger folder_label_log_append_only before update or delete or truncate on public.folder_label_log
  for each statement execute function app.tg_append_only();

revoke all on table public.folder_label_log from public, anon, authenticated, service_role;
alter table public.folder_label_log enable row level security;
alter table public.folder_label_log force row level security;
grant select, insert, update on table public.folder_label_log to service_role;
grant select on table public.folder_label_log to authenticated;
drop policy if exists folder_label_log_select on public.folder_label_log;
create policy folder_label_log_select on public.folder_label_log for select to authenticated
  using ((select app.current_role()) = 'ADMIN_PUSAT' or unit_id = (select app.current_unit_id()));

-- ---------------------------------------------------------------------------
-- folder_label_options (read) — apiGetFolderLabelOptions
--   Active berkas that have a definitive number, ordered by number, each with the
--   fields printed on the label, the last print snapshot and print_status:
--     BELUM_DICETAK     never printed
--     SUDAH_DICETAK     last snapshot equals the current number / code / title
--     PERLU_CETAK_ULANG last snapshot differs (needs_reprint = true)
--   Empty code / title are compared in their printed form ('TANPA KODE' / 'Tanpa Judul'),
--   so a berkas without a code is not flagged forever (3.x compared the raw value with the
--   printed fallback).
-- ---------------------------------------------------------------------------
create or replace function public.folder_label_options(p_unit_id uuid default null)
returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_unit uuid := app.read_unit(p_unit_id);
  v_rows jsonb;
  v_counts jsonb;
begin
  with cur as (
    select b.id, b.no_berkas_definitif as no,
           coalesce(nullif(app.clean_text(b.kode_klasifikasi_snapshot, 80), ''), 'TANPA KODE') as code,
           coalesce(nullif(app.clean_text(b.judul_berkas, 500), ''), 'Tanpa Judul') as title,
           app.lokasi_label(b.no_filling_kabinet, b.no_laci, b.no_folder, b.no_berkas_definitif) as location,
           b.drive_folder_url
      from public.berkas b
     where b.unit_id = v_unit and not b.is_deleted and b.no_berkas_definitif is not null
  ), joined as (
    select cur.*, l.id as log_id, l.printed_at, l.user_email, l.batch_id, l.start_slot, l.pdf_file_name,
           l.no_berkas_snapshot, l.kode_klasifikasi_snapshot, l.judul_berkas_snapshot,
           case when l.id is null then 'BELUM_DICETAK'
                when coalesce(l.no_berkas_snapshot, '') = cur.no::text
                 and coalesce(nullif(app.clean_text(l.kode_klasifikasi_snapshot, 80), ''), 'TANPA KODE') = cur.code
                 and coalesce(nullif(app.clean_text(l.judul_berkas_snapshot, 500), ''), 'Tanpa Judul') = cur.title
                  then 'SUDAH_DICETAK'
                else 'PERLU_CETAK_ULANG' end as print_status
      from cur
      left join lateral (
        select x.* from public.folder_label_log x
         where x.unit_id = v_unit and x.berkas_id = cur.id
         order by x.printed_at desc, x.seq desc limit 1) l on true
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id', j.id, 'number', j.no::text, 'classification_code', j.code, 'title', j.title, 'location', j.location,
           'folder_url', coalesce(j.drive_folder_url, ''),
           'print_status', j.print_status,
           'print_status_label', case j.print_status when 'BELUM_DICETAK' then 'Belum dicetak'
                                   when 'SUDAH_DICETAK' then 'Sudah dicetak' else 'Perlu cetak ulang' end,
           'needs_reprint', j.print_status = 'PERLU_CETAK_ULANG',
           'last_printed_at', case when j.log_id is null then null else app.jakarta_iso(j.printed_at) end,
           'last_print', case when j.log_id is null then null else pg_catalog.jsonb_build_object(
              'id', j.log_id, 'printed_at', app.jakarta_iso(j.printed_at), 'printed_by', coalesce(j.user_email, ''),
              'batch_id', j.batch_id, 'start_slot', j.start_slot, 'file_name', coalesce(j.pdf_file_name, ''),
              'number', coalesce(j.no_berkas_snapshot, ''), 'classification_code', coalesce(j.kode_klasifikasi_snapshot, ''),
              'title', coalesce(j.judul_berkas_snapshot, '')) end
         ) order by j.no, j.id), '[]'::jsonb),
         pg_catalog.jsonb_build_object(
           'BELUM_DICETAK', pg_catalog.count(*) filter (where j.print_status = 'BELUM_DICETAK'),
           'SUDAH_DICETAK', pg_catalog.count(*) filter (where j.print_status = 'SUDAH_DICETAK'),
           'PERLU_CETAK_ULANG', pg_catalog.count(*) filter (where j.print_status = 'PERLU_CETAK_ULANG'))
    into v_rows, v_counts
    from joined j;
  return pg_catalog.jsonb_build_object(
    'unit_id', v_unit, 'berkas', v_rows, 'total', pg_catalog.jsonb_array_length(v_rows), 'status_counts', v_counts,
    'layout', pg_catalog.jsonb_build_object('paper', 'A4', 'columns', 2, 'rows', 7, 'labels_per_page', 14,
                                            'label_width_mm', 70, 'label_height_mm', 30));
end
$$;

-- ---------------------------------------------------------------------------
-- folder_label_print (write) — apiPrepareFolderLabels
--   Records that labels for the given berkas were printed starting at slot p_start_slot.
--   * writers only (PIMPINAN: FORBIDDEN_ROLE); unit users act on their own unit, ADMIN_PUSAT passes p_unit_id
--   * 1..500 distinct berkas ids; every one must be an active, numbered berkas of the unit,
--     otherwise NOT_FOUND (nothing is recorded)
--   * start slot 1..14 (null = 1)
--   * idempotent on p_request_id: a retry returns the stored response with "replayed": true
--   * batch id = 'LBL-' || upper(request id); one log row per berkas holding the printed snapshot
--   * one audit entry per batch
-- Errors: AUTH_REQUIRED, ACCOUNT_INACTIVE, FORBIDDEN_ROLE, UNIT_REQUIRED, UNIT_NOT_FOUND, FORBIDDEN_UNIT,
--         INVALID_INPUT, NOT_FOUND, IDEMPOTENCY_CONFLICT.
-- ---------------------------------------------------------------------------
create or replace function public.folder_label_print(
  p_request_id uuid, p_berkas_ids text[], p_start_slot integer default 1, p_file_name text default null,
  p_unit_id uuid default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  a app.actor := app.require_actor(p_unit_id, true);
  v_ids text[];
  v_slot integer := coalesce(p_start_slot, 1);
  v_file text;
  v_hash text;
  v_prev jsonb;
  v_missing text[];
  v_batch text;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_labels jsonb;
  v_n integer;
  v_res jsonb;
begin
  perform app.lock_unit(a.unit_id);
  select coalesce(pg_catalog.array_agg(x order by x), '{}') into v_ids
    from (select distinct app.clean_text(e, 100) as x from pg_catalog.unnest(coalesce(p_berkas_ids, '{}')) e) s
   where x <> '';
  v_hash := pg_catalog.md5(pg_catalog.jsonb_build_object('ids', v_ids, 'slot', v_slot,
              'file', nullif(app.clean_text(p_file_name, 250), ''))::text);
  v_prev := app.idem_lookup(a.unit_id, p_request_id, 'FOLDER_LABEL_PRINT', v_hash);
  if v_prev is not null then return v_prev; end if;

  v_n := pg_catalog.cardinality(v_ids);
  if v_n = 0 then
    perform app.fail('INVALID_INPUT', 'Pilih minimal satu berkas untuk dicetak.', '{"field":"p_berkas_ids"}');
  end if;
  if v_n > 500 then
    perform app.fail('INVALID_INPUT', 'Maksimal 500 lidah folder dalam satu cetakan. Pecah pilihan menjadi beberapa batch.',
      '{"field":"p_berkas_ids"}');
  end if;
  if v_slot < 1 or v_slot > 14 then
    perform app.fail('INVALID_INPUT', 'Posisi awal label harus antara 1 sampai 14.', '{"field":"p_start_slot"}');
  end if;

  select pg_catalog.array_agg(i order by i) into v_missing
    from pg_catalog.unnest(v_ids) i
   where not exists (select 1 from public.berkas b
                      where b.unit_id = a.unit_id and b.id = i and not b.is_deleted and b.no_berkas_definitif is not null);
  if v_missing is not null then
    perform app.fail('NOT_FOUND',
      'Sebagian berkas tidak lagi aktif atau belum mempunyai nomor definitif. Muat ulang daftar lalu pilih kembali.',
      pg_catalog.jsonb_build_object('field', 'p_berkas_ids', 'missing', pg_catalog.to_jsonb(v_missing)));
  end if;

  v_batch := 'LBL-' || pg_catalog.upper(p_request_id::text);
  v_file := coalesce(nullif(app.clean_text(p_file_name, 250), ''),
                     'Lidah_Folder_' || pg_catalog.to_char(v_now at time zone 'Asia/Jakarta', 'YYYYMMDD_HH24MISS') || '.pdf');

  with ordered as (
    select b.id, b.no_berkas_definitif as no,
           coalesce(nullif(app.clean_text(b.kode_klasifikasi_snapshot, 80), ''), 'TANPA KODE') as code,
           coalesce(nullif(app.clean_text(b.judul_berkas, 500), ''), 'Tanpa Judul') as title,
           app.lokasi_label(b.no_filling_kabinet, b.no_laci, b.no_folder, b.no_berkas_definitif) as location
      from public.berkas b
     where b.unit_id = a.unit_id and b.id = any (v_ids)
  ), ins as (
    insert into public.folder_label_log (id, unit_id, printed_at, user_email, batch_id, berkas_id, no_berkas_snapshot,
                                         kode_klasifikasi_snapshot, judul_berkas_snapshot, start_slot, pdf_file_name,
                                         status, actor_user_id)
    select 'PRN-' || gen_random_uuid(), a.unit_id, v_now, a.email, v_batch, o.id, o.no::text, o.code, o.title,
           v_slot, v_file, 'DICETAK', a.user_id
      from ordered o
    returning berkas_id
  )
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'berkas_id', o.id, 'number', o.no::text, 'classification_code', o.code, 'title', o.title,
           'location', o.location) order by o.no, o.id)
    into v_labels
    from ordered o join ins on ins.berkas_id = o.id;

  perform app.audit(a, 'GENERATE_PDF', 'CETAK_LIDAH_FOLDER', 'BATCH', v_batch,
    'Mencetak lidah folder untuk ' || v_n || ' berkas',
    'Posisi awal ' || v_slot || ' · ' || v_file, p_request_id::text,
    null, pg_catalog.jsonb_build_object('start_slot', v_slot, 'berkas_ids', pg_catalog.to_jsonb(v_ids)));

  v_res := pg_catalog.jsonb_build_object(
    'ok', true, 'batch_id', v_batch, 'printed_at', app.jakarta_iso(v_now), 'file_name', v_file,
    'start_slot', v_slot, 'label_count', v_n, 'page_count', (v_slot - 1 + v_n + 13) / 14, 'labels', v_labels,
    'message', 'Pencetakan ' || v_n || ' lidah folder tercatat.');
  return app.idem_store(a.unit_id, p_request_id, 'FOLDER_LABEL_PRINT', v_hash, a.user_id, v_res);
end
$$;

-- ---------------------------------------------------------------------------
-- Privileges: authenticated only (never anon / service_role)
-- ---------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array['public.folder_label_options(uuid)',
                           'public.folder_label_print(uuid, text[], integer, text, uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end
$$;

-- Self-check
do $$
begin
  if not (select c.relrowsecurity and c.relforcerowsecurity from pg_class c
           where c.oid = 'public.folder_label_log'::regclass) then
    raise exception 's3 lidah self-check: RLS not enabled+forced on public.folder_label_log';
  end if;
  if has_table_privilege('anon', 'public.folder_label_log', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
     or has_table_privilege('authenticated', 'public.folder_label_log', 'INSERT, UPDATE, DELETE, TRUNCATE') then
    raise exception 's3 lidah self-check: client role has too many privileges on public.folder_label_log';
  end if;
  if not has_table_privilege('authenticated', 'public.folder_label_log', 'SELECT') then
    raise exception 's3 lidah self-check: authenticated cannot read public.folder_label_log';
  end if;
  if not exists (select 1 from pg_proc p where p.oid = 'public.folder_label_print(uuid, text[], integer, text, uuid)'::regprocedure
                   and p.prosecdef and 'search_path=""' = any (p.proconfig)) then
    raise exception 's3 lidah self-check: folder_label_print must be SECURITY DEFINER with an empty search_path';
  end if;
  if has_function_privilege('anon', 'public.folder_label_print(uuid, text[], integer, text, uuid)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.folder_label_print(uuid, text[], integer, text, uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.folder_label_options(uuid)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.folder_label_print(uuid, text[], integer, text, uuid)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.folder_label_options(uuid)', 'EXECUTE') then
    raise exception 's3 lidah self-check: unexpected EXECUTE grants on folder_label_* functions';
  end if;
end
$$;

insert into public.schema_migrations_log (version, name)
values ('0016', 's3_lidah_folder') on conflict (version) do nothing;
