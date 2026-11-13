-- 0014_s2_security.sql
-- Privileges for the Sprint 2 functions plus a self-check.
--   * public RPCs: EXECUTE for authenticated only (not anon, not service_role).
--   * app helpers: pure helpers needed by SECURITY INVOKER read RPCs are
--     executable by authenticated; everything that writes, resolves the actor,
--     reads secrets or checks attestations is not (they run inside the
--     SECURITY DEFINER RPCs as the owner).

do $$
declare
  f text;
  rpcs text[] := array[
    'public.receipt_options(uuid)',
    'public.pegawai_add(uuid, text, text, uuid)',
    'public.receipt_save(uuid, jsonb, uuid)',
    'public.receipt_recover(uuid, uuid)',
    'public.receipt_print_prepare(text)',
    'public.receipt_print_confirm(text, text, text)',
    'public.receipt_cancel(uuid, text, text, text, uuid)',
    'public.registration_options(uuid)',
    'public.filing_options(uuid)',
    'public.media_options(uuid)',
    'public.filing_commit(uuid, text[], jsonb, uuid)',
    'public.filing_recover(uuid, uuid)',
    'public.item_create_manual(uuid, jsonb, jsonb, uuid)',
    'public.upload_begin(uuid, text, text, text, text, bigint, uuid)',
    'public.upload_commit(uuid, text, text, bigint, text, text, bigint, text)',
    'public.upload_cancel(uuid)',
    'public.upload_register_folder(uuid, text, bigint, text)',
    'public.drive_task_list(uuid)',
    'public.drive_task_complete(uuid, boolean, text, bigint, text)'];
  reader_helpers text[] := array[
    'app.fail(text, text, jsonb)', 'app.clean_text(text, integer)', 'app.clean_file_name(text)',
    'app.normalized_letter(text, text)', 'app.display_letter(text, text)', 'app.add_duration(date, integer, text)',
    'app.retention_status(date, date)', 'app.normalize_security(text)', 'app.security_rank(text)',
    'app.valid_security(text)', 'app.security_label(integer)', 'app.jakarta_iso(timestamptz)',
    'app.receipt_item_complete(text, date, text, integer, text, text, text)', 'app.receipt_filing_status(text, date)',
    'app.read_unit(uuid)', 'app.parse_date(text, text, text)', 'app.parse_int(jsonb, text, text, integer)',
    'app.normalize_receipt_items(jsonb)'];
  private_helpers text[] := array[
    'app.hmac_hex(text, text)', 'app.server_secret(text)', 'app.actor_base(boolean)', 'app.require_actor(uuid, boolean)',
    'app.require_actor_object(uuid, text, boolean)', 'app.lock_unit(uuid)', 'app.idem_lookup(uuid, uuid, text, text)',
    'app.idem_store(uuid, uuid, text, text, uuid, jsonb)',
    'app.audit(app.actor, text, text, text, text, text, text, text, jsonb, jsonb, text)',
    'app.queue_rename(uuid, text, text, text, text, text, text)', 'app.validate_classification(uuid, text)',
    'app.resolve_target_berkas(app.actor, jsonb, text)', 'app.renumber_unit(app.actor, text[], text, text)',
    'app.attestation_ok(text, bigint, text)', 'app.drive_id_in_use(text, uuid)', 'app.setting_text(uuid, text)',
    'app.item_drive_name(public.item, integer)'];
begin
  foreach f in array rpcs || reader_helpers || private_helpers loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
  foreach f in array rpcs || reader_helpers loop
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end
$$;

-- Self-check
do $$
declare
  r record;
begin
  -- every table in public: RLS enabled + forced; no client writes; anon nothing
  for r in select c.oid, c.relname, c.relrowsecurity, c.relforcerowsecurity
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind in ('r', 'p') loop
    if not (r.relrowsecurity and r.relforcerowsecurity) then
      raise exception 's2 self-check: RLS not enabled+forced on public.%', r.relname;
    end if;
    if has_table_privilege('anon', r.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE')
       or has_table_privilege('authenticated', r.oid, 'INSERT, UPDATE, DELETE, TRUNCATE') then
      raise exception 's2 self-check: client role can write/read public.%', r.relname;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.upload_sessions', 'SELECT')
     or has_table_privilege('authenticated', 'public.drive_tasks', 'SELECT') then
    raise exception 's2 self-check: upload_sessions/drive_tasks must not be readable by clients';
  end if;
  -- SECURITY DEFINER functions in public/app: empty search_path, no anon execute
  for r in select p.oid, n.nspname, p.proname, p.proconfig
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname in ('public', 'app') and p.prosecdef loop
    if r.proconfig is null or not ('search_path=""' = any (r.proconfig)) then
      raise exception 's2 self-check: %.% is SECURITY DEFINER without an empty search_path', r.nspname, r.proname;
    end if;
    if has_function_privilege('anon', r.oid, 'EXECUTE') then
      raise exception 's2 self-check: anon can execute %.%', r.nspname, r.proname;
    end if;
  end loop;
  if has_function_privilege('authenticated', 'app.server_secret(text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'app.renumber_unit(app.actor, text[], text, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'app.audit(app.actor, text, text, text, text, text, text, text, jsonb, jsonb, text)', 'EXECUTE') then
    raise exception 's2 self-check: private helper executable by authenticated';
  end if;
end
$$;

insert into public.schema_migrations_log (version, name)
values ('0014', 's2_security') on conflict (version) do nothing;
