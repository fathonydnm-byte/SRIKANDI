-- 0022_s3_backup.sql
-- Sprint 3: "Cermin Spreadsheet & Backup". Idempotent; no BEGIN/COMMIT. Does not touch other migrations.
--
-- Who writes here
--   The nightly Apps Script job (v4/mirror-apps-script) calls the Pages Function POST /api/jobs/export
--   (v4/web/server/jobsExport.ts). That function verifies an HMAC (JOB_SECRET) and only then uses the
--   Supabase service key to call the service-role-only RPCs below and to read the allow-listed tables.
--   Nothing in this migration is writable or callable by anon / authenticated, except the read RPC
--   public.backup_status (SECURITY INVOKER, so RLS of backup_runs and units is the real gate).
--
--   job_nonces           replay protection (service-only, auto-pruned on every insert)
--   backup_runs          one row per job run (MIRROR or BACKUP, per unit; unit_id NULL = cross-unit
--                        audit rows that belong to no unit)
--   job_nonce_record     service_role: true when the nonce is new, false on a replay
--   job_run_begin        service_role: start a run (closes older RUNNING runs of the same kind/unit as FAILED)
--   job_run_finish       service_role: finish a run (idempotent for the same status)
--   backup_status        admin page: last success per unit and kind, age, warning (> 36 h old, failed, never)
--
-- Error convention of 0010: P0001, message "<CODE>: <pesan>", hint = CODE (app.fail).

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table if not exists public.job_nonces (
  nonce    text primary key,
  action   text not null,
  seen_at  timestamptz not null default now(),
  constraint job_nonces_nonce_format check (nonce ~ '^[A-Za-z0-9_-]{16,64}$')
);
create index if not exists job_nonces_seen_idx on public.job_nonces (seen_at);
comment on table public.job_nonces is 'Nonces of signed job requests already used (replay protection). Service only; rows older than 1 hour are pruned.';

create table if not exists public.backup_runs (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null,
  unit_id         uuid references public.units(id),
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  status          text not null default 'RUNNING',
  stats           jsonb not null default '{}'::jsonb,     -- {tables:{<name>:rows}, total_rows, ...}
  mirror_url      text,
  mirror_file_id  text,
  backup_file_id  text,
  error           text,
  constraint backup_runs_kind_check check (kind in ('MIRROR', 'BACKUP')),
  constraint backup_runs_status_check check (status in ('RUNNING', 'SUCCESS', 'FAILED')),
  constraint backup_runs_finished_check check ((status = 'RUNNING') = (finished_at is null)),
  constraint backup_runs_stats_object check (jsonb_typeof(stats) = 'object'),
  constraint backup_runs_error_len check (error is null or char_length(error) <= 500),
  constraint backup_runs_mirror_url_check check (
    mirror_url is null or mirror_url ~ '^https://docs\.google\.com/spreadsheets/d/[A-Za-z0-9_-]{10,100}([/?#][^[:space:]]{0,250})?$'),
  constraint backup_runs_ids_check check (
    (mirror_file_id is null or mirror_file_id ~ '^[A-Za-z0-9_-]{10,100}$')
    and (backup_file_id is null or backup_file_id ~ '^[A-Za-z0-9_-]{10,100}$'))
);
create index if not exists backup_runs_unit_kind_idx on public.backup_runs (unit_id, kind, started_at desc);
create index if not exists backup_runs_started_idx on public.backup_runs (started_at desc);
comment on table public.backup_runs is 'History of nightly mirror/backup runs. Written only through job_run_begin / job_run_finish (service_role).';

-- ---------------------------------------------------------------------------
-- Privileges + RLS
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['job_nonces', 'backup_runs'] loop
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;
end
$$;
-- service_role is only needed to READ these (the RPCs below are SECURITY DEFINER and do the writes).
grant select on table public.backup_runs to service_role;
grant select on table public.backup_runs to authenticated;

drop policy if exists backup_runs_select on public.backup_runs;
create policy backup_runs_select on public.backup_runs for select to authenticated
  using (
    (select app.current_role()) = 'ADMIN_PUSAT'
    or ((select app.current_role()) = 'ADMIN_UNIT' and unit_id = (select app.current_unit_id()))
  );
-- job_nonces: no policy, no grant -> invisible and unwritable for API roles.

-- ---------------------------------------------------------------------------
-- Service-only RPCs
-- ---------------------------------------------------------------------------
create or replace function public.job_nonce_record(p_nonce text, p_action text)
returns boolean
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if p_nonce is null or p_nonce !~ '^[A-Za-z0-9_-]{16,64}$' then
    perform app.fail('INVALID_INPUT', 'Nonce tidak valid.');
  end if;
  if p_action is null or p_action !~ '^[A-Z_]{3,40}$' then
    perform app.fail('INVALID_INPUT', 'Aksi tidak valid.');
  end if;
  -- the accepted clock skew is 2 minutes; one hour is far more than enough to catch a replay
  delete from public.job_nonces where seen_at < pg_catalog.now() - interval '1 hour';
  insert into public.job_nonces (nonce, action) values (p_nonce, p_action) on conflict (nonce) do nothing;
  get diagnostics v_n = row_count;
  return v_n = 1;
end
$$;

create or replace function public.job_run_begin(p_kind text, p_unit_id uuid)
returns uuid
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_kind is null or p_kind not in ('MIRROR', 'BACKUP') then
    perform app.fail('INVALID_INPUT', 'Jenis pekerjaan tidak dikenal.');
  end if;
  if p_unit_id is not null and not exists (select 1 from public.units u where u.id = p_unit_id) then
    perform app.fail('UNIT_NOT_FOUND', 'Unit tidak ditemukan.');
  end if;
  -- a run that never reported back (script killed, quota) must not look "running" forever
  update public.backup_runs
     set status = 'FAILED', finished_at = pg_catalog.now(), error = 'Dihentikan: pekerjaan tidak melapor selesai dalam 12 jam.'
   where kind = p_kind and unit_id is not distinct from p_unit_id
     and status = 'RUNNING' and started_at < pg_catalog.now() - interval '12 hours';
  insert into public.backup_runs (kind, unit_id) values (p_kind, p_unit_id) returning id into v_id;
  return v_id;
end
$$;

create or replace function public.job_run_finish(
  p_run_id uuid, p_status text, p_stats jsonb, p_mirror_url text, p_mirror_file_id text, p_backup_file_id text, p_error text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  r public.backup_runs;
begin
  if p_status is null or p_status not in ('SUCCESS', 'FAILED') then
    perform app.fail('INVALID_INPUT', 'Status akhir harus SUCCESS atau FAILED.');
  end if;
  if p_stats is not null and pg_catalog.jsonb_typeof(p_stats) <> 'object' then
    perform app.fail('INVALID_INPUT', 'Statistik harus berupa objek.');
  end if;
  if p_stats is not null and pg_catalog.pg_column_size(p_stats) > 16384 then
    perform app.fail('INVALID_INPUT', 'Statistik terlalu besar.');
  end if;
  select * into r from public.backup_runs where id = p_run_id for update;
  if not found then
    perform app.fail('NOT_FOUND', 'Run tidak ditemukan.');
  end if;
  if r.status <> 'RUNNING' then
    if r.status = p_status then
      return pg_catalog.jsonb_build_object('ok', true, 'run_id', r.id, 'status', r.status, 'replayed', true);
    end if;
    perform app.fail('RUN_FINISHED', 'Run sudah selesai dengan status lain.');
  end if;
  update public.backup_runs
     set status = p_status,
         finished_at = pg_catalog.now(),
         stats = coalesce(p_stats, '{}'::jsonb),
         mirror_url = nullif(p_mirror_url, ''),
         mirror_file_id = nullif(p_mirror_file_id, ''),
         backup_file_id = nullif(p_backup_file_id, ''),
         error = nullif(pg_catalog.left(coalesce(p_error, ''), 500), '')
   where id = p_run_id;
  return pg_catalog.jsonb_build_object('ok', true, 'run_id', p_run_id, 'status', p_status, 'replayed', false);
end
$$;

-- ---------------------------------------------------------------------------
-- backup_status (admin page "Cadangan & Cermin"). SECURITY INVOKER: RLS applies.
--   ADMIN_PUSAT: every unit (p_unit_id narrows) plus the cross-unit pseudo row (backup only).
--   ADMIN_UNIT : own unit only. Others: FORBIDDEN_ROLE.
--   per kind: last_success_at, age_hours, last_run, url / backup_file_id, warning:
--     FAILED (last finished run failed) > NEVER (no success yet) > STALE (last success > 36 h) > null
-- ---------------------------------------------------------------------------
create or replace function public.backup_status(p_unit_id uuid default null)
returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_role public.app_role := app.current_role();
  v_unit uuid;
  v_now timestamptz := pg_catalog.now();
  v_stale constant integer := 36;
  v_units jsonb;
  v_history jsonb;
begin
  if auth.uid() is null then
    perform app.fail('AUTH_REQUIRED', 'Sesi login tidak ditemukan. Silakan masuk kembali.');
  end if;
  if v_role is null then
    perform app.fail('ACCOUNT_INACTIVE', 'Akun Anda belum aktif atau sudah dinonaktifkan. Hubungi admin unit.');
  end if;
  if v_role not in ('ADMIN_PUSAT', 'ADMIN_UNIT') then
    perform app.fail('FORBIDDEN_ROLE', 'Halaman Cadangan & Cermin hanya dapat dibuka oleh Admin Unit atau Admin Pusat.');
  end if;
  if v_role = 'ADMIN_UNIT' then
    if p_unit_id is not null and p_unit_id <> app.current_unit_id() then
      perform app.fail('FORBIDDEN_UNIT', 'Anda hanya dapat melihat cadangan unit Anda sendiri.');
    end if;
    v_unit := app.current_unit_id();
  else
    v_unit := p_unit_id;
  end if;

  select coalesce(pg_catalog.jsonb_agg(x.o order by x.ord, x.code), '[]'::jsonb) into v_units
    from (
      select s.ord, s.code,
             pg_catalog.jsonb_build_object(
               'unit_id', s.unit_id, 'unit_code', s.code, 'unit_name', s.name, 'active', s.active,
               'mirror', (max(s.j::text) filter (where s.kind = 'MIRROR'))::jsonb,
               'backup', (max(s.j::text) filter (where s.kind = 'BACKUP'))::jsonb) as o
        from (
          select g.unit_id, g.code, g.name, g.active, g.ord, g.kind,
                 pg_catalog.jsonb_build_object(
                   'last_success_at', ls.last_success_at,
                   'age_hours', case when ls.last_success_at is null then null
                                     else pg_catalog.round((extract(epoch from (v_now - ls.last_success_at)) / 3600.0)::numeric, 1) end,
                   'last_done', ld.j,
                   'running', rn.j,
                   'url', ok.j -> 'mirror_url',
                   'backup_file_id', ok.j -> 'backup_file_id',
                   'stats', ok.j -> 'stats',
                   'warning', case
                     when ld.j is not null and ld.j ->> 'status' = 'FAILED' then 'FAILED'
                     when ls.last_success_at is null then 'NEVER'
                     when v_now - ls.last_success_at > pg_catalog.make_interval(hours => v_stale) then 'STALE'
                     else null end) as j
            from (
              select u.id as unit_id, u.code, u.name, u.active, 0 as ord from public.units u where v_unit is null or u.id = v_unit
              union all
              select null::uuid, '_PLATFORM', 'Lintas unit (audit tanpa unit)', true, 1 where v_unit is null and v_role = 'ADMIN_PUSAT'
            ) g0
            cross join (values ('MIRROR'), ('BACKUP')) as k(kind)
            cross join lateral (select g0.unit_id, g0.code, g0.name, g0.active, g0.ord, k.kind) g
            cross join lateral (
              select max(r.finished_at) as last_success_at from public.backup_runs r
               where r.unit_id is not distinct from g.unit_id and r.kind = g.kind and r.status = 'SUCCESS') ls
            left join lateral (
              select pg_catalog.to_jsonb(x) as j from (
                select r.id, r.status, r.started_at, r.finished_at, r.error from public.backup_runs r
                 where r.unit_id is not distinct from g.unit_id and r.kind = g.kind and r.status <> 'RUNNING'
                 order by r.started_at desc limit 1) x) ld on true
            left join lateral (
              select pg_catalog.to_jsonb(x) as j from (
                select r.id, r.started_at from public.backup_runs r
                 where r.unit_id is not distinct from g.unit_id and r.kind = g.kind and r.status = 'RUNNING'
                   and r.started_at > v_now - interval '12 hours'
                 order by r.started_at desc limit 1) x) rn on true
            left join lateral (
              select pg_catalog.to_jsonb(x) as j from (
                select r.mirror_url, r.mirror_file_id, r.backup_file_id, r.stats from public.backup_runs r
                 where r.unit_id is not distinct from g.unit_id and r.kind = g.kind and r.status = 'SUCCESS'
                 order by r.finished_at desc limit 1) x) ok on true
           where not (g.unit_id is null and g.kind = 'MIRROR')
        ) s
       group by s.unit_id, s.code, s.name, s.active, s.ord
    ) x;

  select coalesce(pg_catalog.jsonb_agg(h order by (h ->> 'started_at') desc), '[]'::jsonb) into v_history
    from (
      select pg_catalog.to_jsonb(r2) as h from (
        select r.id, r.kind, r.unit_id, r.started_at, r.finished_at, r.status, r.error, r.stats ->> 'total_rows' as total_rows
          from public.backup_runs r
         where v_unit is null or r.unit_id = v_unit
         order by r.started_at desc limit 20) r2
    ) hh;

  return pg_catalog.jsonb_build_object('now', v_now, 'stale_after_hours', v_stale, 'units', v_units, 'history', v_history);
end
$$;
comment on function public.backup_status(uuid) is
  'Admin page Cadangan & Cermin: last success per unit and kind, age in hours, warning (FAILED | NEVER | STALE > 36 h), short history. RLS applies.';

-- ---------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.job_nonce_record(text, text)',
    'public.job_run_begin(text, uuid)',
    'public.job_run_finish(uuid, text, jsonb, text, text, text, text)',
    'public.backup_status(uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
  grant execute on function public.job_nonce_record(text, text) to service_role;
  grant execute on function public.job_run_begin(text, uuid) to service_role;
  grant execute on function public.job_run_finish(uuid, text, jsonb, text, text, text, text) to service_role;
  grant execute on function public.backup_status(uuid) to authenticated;
end
$$;

-- ---------------------------------------------------------------------------
-- Self-check (same pattern as 0014)
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in select c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relname in ('job_nonces', 'backup_runs') loop
    if not (r.relrowsecurity and r.relforcerowsecurity) then
      raise exception '0022 self-check: RLS not enabled+forced on public.%', r.relname;
    end if;
    if has_table_privilege('anon', r.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
       or has_table_privilege('authenticated', r.oid, 'INSERT, UPDATE, DELETE, TRUNCATE') then
      raise exception '0022 self-check: client role can touch public.%', r.relname;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.job_nonces', 'SELECT')
     or has_table_privilege('service_role', 'public.job_nonces', 'INSERT, UPDATE, DELETE') then
    raise exception '0022 self-check: job_nonces must only be reachable through job_nonce_record';
  end if;
  if has_table_privilege('service_role', 'public.backup_runs', 'INSERT, UPDATE, DELETE') then
    raise exception '0022 self-check: backup_runs must only be written through job_run_begin/job_run_finish';
  end if;
  for r in select p.oid, p.proname, p.prosecdef, p.proconfig
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('job_nonce_record', 'job_run_begin', 'job_run_finish', 'backup_status') loop
    if has_function_privilege('anon', r.oid, 'EXECUTE') or has_function_privilege('public', r.oid, 'EXECUTE') then
      raise exception '0022 self-check: anon/public can execute %', r.proname;
    end if;
    if r.proname <> 'backup_status' then
      if not r.prosecdef or r.proconfig is null or not ('search_path=""' = any (r.proconfig)) then
        raise exception '0022 self-check: % must be SECURITY DEFINER with an empty search_path', r.proname;
      end if;
      if has_function_privilege('authenticated', r.oid, 'EXECUTE') or not has_function_privilege('service_role', r.oid, 'EXECUTE') then
        raise exception '0022 self-check: % must be executable by service_role only', r.proname;
      end if;
    elsif r.prosecdef or not has_function_privilege('authenticated', r.oid, 'EXECUTE') then
      raise exception '0022 self-check: backup_status must be SECURITY INVOKER and executable by authenticated';
    end if;
  end loop;
end
$$;

insert into public.schema_migrations_log (version, name)
values ('0022', 's3_backup') on conflict (version) do nothing;
