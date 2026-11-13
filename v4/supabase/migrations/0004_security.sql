-- 0004_security.sql
-- Privileges and Row Level Security for every table created so far.
--
-- Model
--   * anon: nothing.
--   * authenticated: SELECT only, limited by RLS to the caller's unit
--     (ADMIN_PUSAT: all units). Inactive profiles / inactive units see nothing.
--     All writes go through Edge Functions using service_role.
--   * audit_log: ADMIN_PUSAT (all) and ADMIN_UNIT (own unit) only.
--   * profiles: own row; admins also see their unit's rows (ADMIN_PUSAT: all).
--   * service_role: BYPASSRLS on Supabase; gets explicit DML grants here.
--     Hard delete is still blocked by triggers on business tables.
--   * RLS is enabled AND forced on every table in schema public; the
--     self-check at the end of this file fails the migration otherwise.
--
-- Policies call the helpers through scalar sub-selects so Postgres evaluates
-- them once per statement (initplan) instead of once per row.

-- ---------------------------------------------------------------------------
-- Schema / function privileges
-- ---------------------------------------------------------------------------
revoke all on schema app from public, anon;
grant usage on schema app to authenticated, service_role;

revoke all on all functions in schema app from public, anon, authenticated;

grant execute on function app.is_active()       to authenticated, service_role;
grant execute on function app.current_role()    to authenticated, service_role;
grant execute on function app.current_unit_id() to authenticated, service_role;

grant execute on function app.encrypt_pii(text)                  to service_role;
grant execute on function app.decrypt_pii(bytea)                 to service_role;
grant execute on function app.next_counter(uuid, text, integer)  to service_role;

-- Future objects created by the migration role are not exposed implicitly:
-- later migrations must grant explicitly (and add RLS policies).
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from public, anon, authenticated;
alter default privileges in schema app    revoke all on functions from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Table privileges. Supabase's default privileges grant ALL on new public
-- tables to anon/authenticated/service_role; strip them and grant explicitly.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  readable text[] := array[
    'units', 'profiles', 'unit_settings', 'audit_log', 'idempotency_keys', 'counters',
    'klasifikasi', 'pegawai', 'berkas', 'item', 'penerimaan', 'penerimaan_item', 'riwayat_nomor'
  ];
  all_tables text[] := readable || array['schema_migrations_log'];
begin
  foreach t in array all_tables loop
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
  end loop;

  foreach t in array readable loop
    execute format('grant select on table public.%I to authenticated', t);
  end loop;

  foreach t in array all_tables loop
    execute format('grant select, insert, update on table public.%I to service_role', t);
  end loop;
end
$$;

-- Only these allow DELETE by the server (no business meaning, housekeeping).
grant delete on table public.idempotency_keys to service_role;
grant delete on table public.profiles         to service_role;

-- ---------------------------------------------------------------------------
-- Policies (SELECT only, role authenticated)
-- ---------------------------------------------------------------------------

-- units
drop policy if exists units_select on public.units;
create policy units_select on public.units
  for select to authenticated
  using ((select app.current_role()) = 'ADMIN_PUSAT' or id = (select app.current_unit_id()));

-- profiles
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (
    (user_id = (select auth.uid()) and (select app.is_active()))
    or (select app.current_role()) = 'ADMIN_PUSAT'
    or ((select app.current_role()) = 'ADMIN_UNIT' and unit_id = (select app.current_unit_id()))
  );

-- audit_log
drop policy if exists audit_log_select on public.audit_log;
create policy audit_log_select on public.audit_log
  for select to authenticated
  using (
    (select app.current_role()) = 'ADMIN_PUSAT'
    or ((select app.current_role()) = 'ADMIN_UNIT' and unit_id = (select app.current_unit_id()))
  );

-- Unit-scoped tables: same rule everywhere.
do $$
declare
  t text;
  unit_tables text[] := array[
    'unit_settings', 'idempotency_keys', 'counters',
    'klasifikasi', 'pegawai', 'berkas', 'item', 'penerimaan', 'penerimaan_item', 'riwayat_nomor'
  ];
begin
  foreach t in array unit_tables loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using ('
      || '(select app.current_role()) = ''ADMIN_PUSAT'' '
      || 'or unit_id = (select app.current_unit_id()))',
      t || '_select', t);
  end loop;
end
$$;

-- schema_migrations_log: no policy -> invisible to API roles.

-- ---------------------------------------------------------------------------
-- Self-check: every table in public has RLS enabled + forced, and neither
-- anon nor authenticated holds any write privilege; anon holds no SELECT.
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
  loop
    if not (r.relrowsecurity and r.relforcerowsecurity) then
      raise exception 'security self-check: RLS not enabled+forced on public.%', r.relname;
    end if;
    if has_table_privilege('anon', r.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') then
      raise exception 'security self-check: anon has privileges on public.%', r.relname;
    end if;
    if has_table_privilege('authenticated', r.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') then
      raise exception 'security self-check: authenticated can write public.%', r.relname;
    end if;
  end loop;
end
$$;

insert into public.schema_migrations_log (version, name)
values ('0004', 'security') on conflict (version) do nothing;
