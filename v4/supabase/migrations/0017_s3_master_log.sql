-- 0017_s3_master_log.sql
-- Master Log Perubahan (audit log viewer), port of 3.x apiGetMasterLog /
-- getMasterLog_ (Services.js) with filters and paging. Idempotent.
--
-- Access (decision, error convention of 0010):
--   The two RPCs are SECURITY INVOKER, so audit_log RLS (0004: ADMIN_PUSAT all
--   units, ADMIN_UNIT own unit) is the real gate. On top of it they raise a
--   clear coded error instead of returning an empty page for callers who may
--   not read the log, because "0 rows" is indistinguishable from "no activity"
--   and 3.x showed an explicit "only the unit admin may open this" message:
--     AUTH_REQUIRED     no auth.uid()
--     ACCOUNT_INACTIVE  no profile / inactive profile / inactive unit
--     FORBIDDEN_ROLE    PETUGAS, PIMPINAN
--     FORBIDDEN_UNIT    ADMIN_UNIT asked for another unit's log
--     INVALID_INPUT     malformed filter (detail.field names it)
--   ADMIN_PUSAT: p_unit_id null = every unit (including cross-unit rows whose
--   unit_id is NULL); a uuid narrows to that unit.
--
-- master_log(p_filters jsonb, p_limit, p_offset, p_unit_id) -> jsonb
--   {total, limit, offset, rows:[...]}  newest first (occurred_at desc, id desc).
--   p_filters keys (all optional, blank = ignored):
--     date_from, date_to  'YYYY-MM-DD', calendar dates in Asia/Jakarta, both inclusive
--     action, object_type, module, result   exact match (values from master_log_filter_values)
--     object_id           exact match
--     actor               case-insensitive substring of actor name or e-mail
--     q                   case-insensitive substring of reason, object id, action or summary
--   limit: default 50, capped to 100; offset >= 0; total is an exact count.
--   Unknown keys are ignored. Rows carry before_data/after_data for the detail view.
--
-- Not reproduced from 3.x: nothing is cut to 500 characters here (the UI
-- truncates visually); 3.x capped the list at the newest 200-500 rows, v4 pages.

-- ---------------------------------------------------------------------------
-- Indexes. Existing: (unit_id, occurred_at desc) and (unit_id, object_type, object_id).
--  * audit_log_time_id_idx: ADMIN_PUSAT without a unit filter sorts the whole
--    table newest-first; without this index that is a top-N sort over every
--    row at each page. Also serves the tie-break (id) so paging is index-ordered.
--  * audit_log_unit_time_id_idx: same for one unit (ADMIN_UNIT, or Pusat with
--    a unit); the old (unit_id, occurred_at) index cannot satisfy ORDER BY
--    occurred_at desc, id desc without an extra sort step.
-- No trigram index for the free-text filter: under RLS Postgres will not use
-- an index for a non-leakproof LIKE (see 0009), so it would only cost writes;
-- the text filter runs on the already unit-/date-narrowed range.
-- ---------------------------------------------------------------------------
create index if not exists audit_log_time_id_idx on public.audit_log (occurred_at desc, id desc);
create index if not exists audit_log_unit_time_id_idx on public.audit_log (unit_id, occurred_at desc, id desc);

-- ---------------------------------------------------------------------------
-- Guard shared by both RPCs (SECURITY INVOKER; app.current_role is the same
-- helper the RLS policy uses).
-- ---------------------------------------------------------------------------
create or replace function app.master_log_guard(p_unit_id uuid)
returns void
language plpgsql stable
set search_path = ''
as $$
declare
  v_role public.app_role := app.current_role();
begin
  if auth.uid() is null then
    perform app.fail('AUTH_REQUIRED', 'Sesi login tidak ditemukan. Silakan masuk kembali.');
  end if;
  if v_role is null then
    perform app.fail('ACCOUNT_INACTIVE', 'Akun Anda belum aktif atau sudah dinonaktifkan. Hubungi admin unit.');
  end if;
  if v_role not in ('ADMIN_PUSAT', 'ADMIN_UNIT') then
    perform app.fail('FORBIDDEN_ROLE', 'Master Log Perubahan hanya dapat dibuka oleh Admin Unit atau Admin Pusat.');
  end if;
  if v_role = 'ADMIN_UNIT' and p_unit_id is not null and p_unit_id <> app.current_unit_id() then
    perform app.fail('FORBIDDEN_UNIT', 'Anda hanya dapat melihat log unit Anda sendiri.');
  end if;
end
$$;

-- Text filter value: collapsed, trimmed, max length; NULL when blank.
create or replace function app.master_log_text(p_filters jsonb, p_key text, p_max integer)
returns text
language sql stable
set search_path = ''
as $$
  select nullif(app.clean_text(p_filters ->> p_key, p_max), '')
$$;

-- Calendar date filter ('YYYY-MM-DD'); NULL when blank, INVALID_INPUT otherwise malformed.
create or replace function app.master_log_date(p_filters jsonb, p_key text)
returns date
language plpgsql stable
set search_path = ''
as $$
declare
  v_text text := app.master_log_text(p_filters, p_key, 40);
begin
  if v_text is null then
    return null;
  end if;
  begin
    if v_text !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception 'bad date' using errcode = '22007';
    end if;
    return v_text::date;
  exception when others then
    perform app.fail('INVALID_INPUT', 'Tanggal harus berformat TTTT-BB-HH yang valid.',
                     pg_catalog.jsonb_build_object('field', p_key));
  end;
  return null;
end
$$;

-- ---------------------------------------------------------------------------
-- public.master_log
-- ---------------------------------------------------------------------------
create or replace function public.master_log(
  p_filters jsonb   default '{}'::jsonb,
  p_limit   integer default 50,
  p_offset  integer default 0,
  p_unit_id uuid    default null
)
returns jsonb
language plpgsql stable security invoker
set search_path = ''
set plan_cache_mode = 'force_custom_plan'
as $$
declare
  v_filters jsonb := coalesce(p_filters, '{}'::jsonb);
  v_limit   integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_offset  integer := greatest(coalesce(p_offset, 0), 0);
  v_from    date;
  v_to      date;
  v_from_ts timestamptz;
  v_to_ts   timestamptz;     -- exclusive upper bound
  v_action  text;
  v_otype   text;
  v_module  text;
  v_result  text;
  v_oid     text;
  v_actor   text;
  v_q       text;
  v_total   bigint;
  v_rows    jsonb;
begin
  perform app.master_log_guard(p_unit_id);
  if pg_catalog.jsonb_typeof(v_filters) <> 'object' then
    perform app.fail('INVALID_INPUT', 'Filter harus berupa objek.', pg_catalog.jsonb_build_object('field', 'p_filters'));
  end if;

  v_from := app.master_log_date(v_filters, 'date_from');
  v_to := app.master_log_date(v_filters, 'date_to');
  if v_from is not null and v_to is not null and v_from > v_to then
    perform app.fail('INVALID_INPUT', 'Tanggal awal tidak boleh lebih besar daripada tanggal akhir.',
                     pg_catalog.jsonb_build_object('field', 'date_from'));
  end if;
  -- Jakarta calendar days -> half-open timestamptz range (index friendly).
  v_from_ts := case when v_from is null then null else (v_from::timestamp at time zone 'Asia/Jakarta') end;
  v_to_ts := case when v_to is null then null else ((v_to + 1)::timestamp at time zone 'Asia/Jakarta') end;

  v_action := app.master_log_text(v_filters, 'action', 100);
  v_otype  := app.master_log_text(v_filters, 'object_type', 100);
  v_module := app.master_log_text(v_filters, 'module', 100);
  v_result := pg_catalog.upper(app.master_log_text(v_filters, 'result', 30));
  v_oid    := app.master_log_text(v_filters, 'object_id', 200);
  v_actor  := pg_catalog.lower(app.master_log_text(v_filters, 'actor', 200));
  v_q      := pg_catalog.lower(app.master_log_text(v_filters, 'q', 200));

  select count(*) into v_total
  from public.audit_log a
  where (p_unit_id is null or a.unit_id = p_unit_id)
    and (v_from_ts is null or a.occurred_at >= v_from_ts)
    and (v_to_ts is null or a.occurred_at < v_to_ts)
    and (v_action is null or a.action = v_action)
    and (v_otype is null or a.object_type = v_otype)
    and (v_module is null or a.module = v_module)
    and (v_result is null or a.result = v_result)
    and (v_oid is null or a.object_id = v_oid)
    and (v_actor is null
         or pg_catalog.strpos(pg_catalog.lower(coalesce(a.actor_name_snapshot, '')), v_actor) > 0
         or pg_catalog.strpos(pg_catalog.lower(coalesce(a.actor_email_snapshot, '')), v_actor) > 0)
    and (v_q is null
         or pg_catalog.strpos(pg_catalog.lower(coalesce(a.reason, '')), v_q) > 0
         or pg_catalog.strpos(pg_catalog.lower(coalesce(a.object_id, '')), v_q) > 0
         or pg_catalog.strpos(pg_catalog.lower(a.action), v_q) > 0
         or pg_catalog.strpos(pg_catalog.lower(coalesce(a.summary, '')), v_q) > 0);

  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id', p.id,
           'occurred_at', p.occurred_at,
           'unit_id', p.unit_id,
           'unit_code', u.code,
           'unit_name', u.name,
           'actor_user_id', p.actor_user_id,
           'actor_name', p.actor_name_snapshot,
           'actor_email', p.actor_email_snapshot,
           'action', p.action,
           'module', p.module,
           'object_type', p.object_type,
           'object_id', p.object_id,
           'summary', p.summary,
           'reason', p.reason,
           'request_id', p.request_id,
           'result', p.result,
           'before_data', p.before_data,
           'after_data', p.after_data) order by p.occurred_at desc, p.id desc), '[]'::jsonb)
  into v_rows
  from (
    select a.*
    from public.audit_log a
    where (p_unit_id is null or a.unit_id = p_unit_id)
      and (v_from_ts is null or a.occurred_at >= v_from_ts)
      and (v_to_ts is null or a.occurred_at < v_to_ts)
      and (v_action is null or a.action = v_action)
      and (v_otype is null or a.object_type = v_otype)
      and (v_module is null or a.module = v_module)
      and (v_result is null or a.result = v_result)
      and (v_oid is null or a.object_id = v_oid)
      and (v_actor is null
           or pg_catalog.strpos(pg_catalog.lower(coalesce(a.actor_name_snapshot, '')), v_actor) > 0
           or pg_catalog.strpos(pg_catalog.lower(coalesce(a.actor_email_snapshot, '')), v_actor) > 0)
      and (v_q is null
           or pg_catalog.strpos(pg_catalog.lower(coalesce(a.reason, '')), v_q) > 0
           or pg_catalog.strpos(pg_catalog.lower(coalesce(a.object_id, '')), v_q) > 0
           or pg_catalog.strpos(pg_catalog.lower(a.action), v_q) > 0
           or pg_catalog.strpos(pg_catalog.lower(coalesce(a.summary, '')), v_q) > 0)
    order by a.occurred_at desc, a.id desc
    limit v_limit offset v_offset
  ) p
  left join public.units u on u.id = p.unit_id;

  return pg_catalog.jsonb_build_object('total', v_total, 'limit', v_limit, 'offset', v_offset, 'rows', v_rows);
end
$$;

-- ---------------------------------------------------------------------------
-- public.master_log_filter_values: distinct values for the filter dropdowns,
-- limited to what the caller may see (RLS) and the optional unit.
-- ---------------------------------------------------------------------------
create or replace function public.master_log_filter_values(p_unit_id uuid default null)
returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
begin
  perform app.master_log_guard(p_unit_id);
  return (
    select pg_catalog.jsonb_build_object(
      'actions', coalesce(pg_catalog.jsonb_agg(distinct a.action) filter (where a.action is not null), '[]'::jsonb),
      'object_types', coalesce(pg_catalog.jsonb_agg(distinct a.object_type) filter (where nullif(a.object_type, '') is not null), '[]'::jsonb),
      'modules', coalesce(pg_catalog.jsonb_agg(distinct a.module) filter (where nullif(a.module, '') is not null), '[]'::jsonb))
    from public.audit_log a
    where p_unit_id is null or a.unit_id = p_unit_id);
end
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on function app.master_log_guard(uuid) from public, anon, authenticated, service_role;
revoke all on function app.master_log_text(jsonb, text, integer) from public, anon, authenticated, service_role;
revoke all on function app.master_log_date(jsonb, text) from public, anon, authenticated, service_role;
grant execute on function app.master_log_guard(uuid) to authenticated, service_role;
grant execute on function app.master_log_text(jsonb, text, integer) to authenticated, service_role;
grant execute on function app.master_log_date(jsonb, text) to authenticated, service_role;
revoke all on function public.master_log(jsonb, integer, integer, uuid) from public, anon, authenticated, service_role;
revoke all on function public.master_log_filter_values(uuid) from public, anon, authenticated, service_role;
grant execute on function public.master_log(jsonb, integer, integer, uuid) to authenticated, service_role;
grant execute on function public.master_log_filter_values(uuid) to authenticated, service_role;

do $$
declare
  f text;
begin
  foreach f in array array['public.master_log(jsonb, integer, integer, uuid)', 'public.master_log_filter_values(uuid)',
                           'app.master_log_guard(uuid)', 'app.master_log_text(jsonb, text, integer)',
                           'app.master_log_date(jsonb, text)'] loop
    if has_function_privilege('anon', f, 'EXECUTE') then
      raise exception 'master_log self-check: anon can execute %', f;
    end if;
    if (select prosecdef from pg_proc where oid = f::regprocedure) then
      raise exception 'master_log self-check: % must be SECURITY INVOKER', f;
    end if;
  end loop;
end
$$;

insert into public.schema_migrations_log (version, name)
values ('0017', 's3_master_log') on conflict (version) do nothing;
