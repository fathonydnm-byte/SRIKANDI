-- 0020_s3_edit_batal_security.sql
-- Privileges for the Sprint 3 Edit / Koreksi & Pembatalan functions plus a self-check
-- (pattern of 0014). Public RPCs: EXECUTE for authenticated only. App helpers that
-- write, guard or resolve the actor are private (they run inside SECURITY DEFINER RPCs).

do $$
declare
  f text;
  rpcs text[] := array[
    'public.edit_options(uuid)',
    'public.cancel_options(uuid)',
    'public.quarantine_list(uuid, integer)',
    'public.item_update(uuid, text, jsonb, text, uuid, boolean)',
    'public.berkas_update_title(uuid, text, text, text)',
    'public.archive_cancel(uuid, text, text, text, text, text, uuid, boolean)',
    -- redefined in 0018 (create or replace keeps grants; re-asserted here)
    'public.upload_begin(uuid, text, text, text, text, bigint, uuid)',
    'public.upload_commit(uuid, text, text, bigint, text, text, bigint, text)',
    'public.upload_cancel(uuid)',
    'public.upload_register_folder(uuid, text, text, bigint, text)'];
  private_helpers text[] := array[
    'app.assert_not_borrowed(uuid, text, text[], text)',
    'app.quarantine_add(app.actor, text, text, text, text, text, bigint, text, text, text, text, text, text, text, text, text)',
    'app.invalidate_file_derivatives(uuid, text, text, text)',
    'app.release_receipt_sources(app.actor, text[])',
    'app.deletion_note(text, text)',
    'app.drive_id_in_use(text, uuid)'];
begin
  foreach f in array rpcs || private_helpers loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
  foreach f in array rpcs loop
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end
$$;

-- Self-check
do $$
declare
  r record;
  t text;
begin
  foreach t in array array['karantina', 'pembatalan_arsip'] loop
    if not (select c.relrowsecurity and c.relforcerowsecurity from pg_class c where c.oid = ('public.' || t)::regclass) then
      raise exception 's3 edit/batal self-check: RLS not enabled+forced on public.%', t;
    end if;
    if has_table_privilege('anon', ('public.' || t)::regclass, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
       or has_table_privilege('authenticated', ('public.' || t)::regclass, 'INSERT, UPDATE, DELETE, TRUNCATE') then
      raise exception 's3 edit/batal self-check: client role can write public.%', t;
    end if;
    if (select pg_catalog.count(*) from pg_policies where schemaname = 'public' and tablename = t) <> 1 then
      raise exception 's3 edit/batal self-check: public.% must have exactly its admin select policy', t;
    end if;
  end loop;
  for r in select p.oid, n.nspname, p.proname, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname in ('public', 'app') and p.prosecdef loop
    if r.proconfig is null or not ('search_path=""' = any (r.proconfig)) then
      raise exception 's3 edit/batal self-check: %.% is SECURITY DEFINER without an empty search_path', r.nspname, r.proname;
    end if;
    if has_function_privilege('anon', r.oid, 'EXECUTE') then
      raise exception 's3 edit/batal self-check: anon can execute %.%', r.nspname, r.proname;
    end if;
  end loop;
  if has_function_privilege('authenticated', 'app.assert_not_borrowed(uuid, text, text[], text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'app.release_receipt_sources(app.actor, text[])', 'EXECUTE')
     or has_function_privilege('authenticated', 'app.invalidate_file_derivatives(uuid, text, text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'app.quarantine_add(app.actor, text, text, text, text, text, bigint, text, text, text, text, text, text, text, text, text)', 'EXECUTE') then
    raise exception 's3 edit/batal self-check: private helper executable by authenticated';
  end if;
  if has_function_privilege('service_role', 'public.archive_cancel(uuid, text, text, text, text, text, uuid, boolean)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.item_update(uuid, text, jsonb, text, uuid, boolean)', 'EXECUTE') then
    raise exception 's3 edit/batal self-check: service_role must not call the write RPCs (no auth.uid())';
  end if;
  if (select prosecdef from pg_proc where oid = 'public.edit_options(uuid)'::regprocedure)
     or (select prosecdef from pg_proc where oid = 'public.cancel_options(uuid)'::regprocedure)
     or (select prosecdef from pg_proc where oid = 'public.quarantine_list(uuid, integer)'::regprocedure)
     or not (select prosecdef from pg_proc where oid = 'public.archive_cancel(uuid, text, text, text, text, text, uuid, boolean)'::regprocedure)
     or not (select prosecdef from pg_proc where oid = 'public.item_update(uuid, text, jsonb, text, uuid, boolean)'::regprocedure)
     or not (select prosecdef from pg_proc where oid = 'public.berkas_update_title(uuid, text, text, text)'::regprocedure) then
    raise exception 's3 edit/batal self-check: wrong SECURITY INVOKER/DEFINER settings';
  end if;
end
$$;

insert into public.schema_migrations_log (version, name)
values ('0020', 's3_edit_batal_security') on conflict (version) do nothing;
