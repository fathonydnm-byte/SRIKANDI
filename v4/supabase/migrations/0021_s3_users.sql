-- 0021_s3_users.sql
-- Sprint 3: Kelola Pengguna (user management). Idempotent; no BEGIN/COMMIT.
--
-- Model
--   * Accounts are created by admins only (no self sign-up). The Auth user itself
--     is created/changed by the Cloudflare Pages Function with the Supabase
--     service key; this migration owns the PROFILE side and the RULES.
--   * public.user_admin_authorize(...)   gate, called AS THE CALLER (authenticated).
--                                        Decides ONLY from auth.uid()'s profile.
--   * public.user_profile_upsert_service(...)  write, service_role ONLY. It
--                                        re-validates the very same rules for p_actor
--                                        (defence in depth) and writes profile + audit
--                                        atomically; idempotent by request id.
--   * public.password_changed()          the user clears his/her own forced-change flag
--                                        (only if the Auth password really changed).
--   * public.user_list(unit)             read, SECURITY INVOKER (RLS of profiles).
--   Rules live in ONE place, app.user_admin_check(actor, action, target...), used by
--   both the gate and the write.
--
-- Error convention: P0001, message "<CODE>: <pesan>", hint = CODE (app.fail, 0010).

-- ---------------------------------------------------------------------------
-- A. Columns
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists must_change_password boolean not null default false;
alter table public.profiles add column if not exists email text;
alter table public.profiles add column if not exists updated_at timestamptz not null default now();
-- Fingerprint (md5 of the Auth password hash) taken when a temporary password is
-- set. password_changed() refuses to clear the flag while the hash is unchanged.
alter table public.profiles add column if not exists must_change_fp text;

comment on column public.profiles.must_change_password is
  'true after an admin created the account or reset the password; the user must choose a new one before using the app.';
comment on column public.profiles.email is 'Snapshot of auth.users.email (display and search; auth.users stays the source of truth).';
comment on column public.profiles.must_change_fp is 'md5 of the Auth password hash when the temporary password was set (internal).';

-- one-off backfill of the snapshot for profiles that predate this migration
update public.profiles p set email = u.email
  from auth.users u
 where u.id = p.user_id and p.email is null and u.email is not null;

create index if not exists audit_log_request_idx on public.audit_log (request_id) where module = 'PENGGUNA';

-- ---------------------------------------------------------------------------
-- B. Helpers (private: not executable by authenticated)
-- ---------------------------------------------------------------------------
create or replace function app.pw_fingerprint(p_user_id uuid)
returns text
language sql stable security definer
set search_path = ''
as $$
  -- to_jsonb keeps this working where the column is absent (test stub) -> NULL
  select pg_catalog.md5(nullif(pg_catalog.to_jsonb(u) ->> 'encrypted_password', ''))
    from auth.users u where u.id = p_user_id
$$;

-- The single rulebook. Raises with a stable code, returns {ok:true, actor_id, ...}.
--   p_action: create | update | deactivate | reactivate | reset_password
--   p_target_unit_id / p_target_role: the NEW values (create: the new user's; update:
--   only when changing them; NULL = unchanged).
create or replace function app.user_admin_check(
  p_actor uuid, p_action text, p_target_user_id uuid, p_target_unit_id uuid, p_target_role text)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  a public.profiles;
  t public.profiles;
  v_pusat boolean;
  v_new public.app_role;
  v_eff_role public.app_role;
  v_eff_unit uuid;
begin
  if p_actor is null then
    perform app.fail('AUTH_REQUIRED', 'Sesi login tidak ditemukan. Silakan masuk kembali.');
  end if;
  select * into a from public.profiles where user_id = p_actor;
  if not found or not a.active
     or (a.unit_id is not null and not exists (select 1 from public.units u where u.id = a.unit_id and u.active)) then
    perform app.fail('ACCOUNT_INACTIVE', 'Akun Anda belum aktif atau sudah dinonaktifkan. Hubungi admin unit.');
  end if;
  if a.role not in ('ADMIN_PUSAT', 'ADMIN_UNIT') then
    perform app.fail('FORBIDDEN_ROLE', 'Hanya Admin Unit dan Admin Pusat yang dapat mengelola pengguna.');
  end if;
  if p_action is null or p_action not in ('create', 'update', 'deactivate', 'reactivate', 'reset_password') then
    perform app.fail('INVALID_INPUT', 'Aksi pengelolaan pengguna tidak dikenal.');
  end if;
  v_pusat := a.role = 'ADMIN_PUSAT';

  if p_target_role is not null then
    begin
      v_new := p_target_role::public.app_role;
    exception when invalid_text_representation then
      perform app.fail('INVALID_INPUT', 'Peran tidak dikenal.');
    end;
  end if;

  -- ---- create -------------------------------------------------------------
  if p_action = 'create' then
    if v_new is null then
      perform app.fail('INVALID_INPUT', 'Peran wajib dipilih.');
    end if;
    if not v_pusat and v_new not in ('PETUGAS', 'PIMPINAN') then
      perform app.fail('FORBIDDEN_TARGET_ROLE', 'Admin Unit hanya dapat membuat akun Petugas Arsip dan Pimpinan.');
    end if;
    if v_new = 'ADMIN_PUSAT' then
      if p_target_unit_id is not null then
        perform app.fail('INVALID_INPUT', 'Admin Pusat tidak terikat pada satu unit.');
      end if;
    else
      if p_target_unit_id is null then
        perform app.fail('UNIT_REQUIRED', 'Unit wajib dipilih.');
      end if;
      if not v_pusat and p_target_unit_id <> a.unit_id then
        perform app.fail('FORBIDDEN_UNIT', 'Anda hanya dapat mengelola pengguna unit Anda sendiri.');
      end if;
      if not exists (select 1 from public.units u where u.id = p_target_unit_id and u.active) then
        perform app.fail('UNIT_NOT_FOUND', 'Unit tidak ditemukan atau nonaktif.');
      end if;
    end if;
    return pg_catalog.jsonb_build_object('ok', true, 'actor_id', a.user_id);
  end if;

  -- ---- existing target ----------------------------------------------------
  if p_target_user_id is null then
    perform app.fail('INVALID_INPUT', 'Pengguna yang dituju wajib diisi.');
  end if;
  select * into t from public.profiles where user_id = p_target_user_id;
  -- other units' users are not revealed to ADMIN_UNIT
  if not found or (not v_pusat and t.unit_id is distinct from a.unit_id) then
    perform app.fail('NOT_FOUND', 'Pengguna tidak ditemukan.');
  end if;

  if t.user_id = a.user_id then
    if p_action in ('deactivate', 'reactivate', 'reset_password') then
      perform app.fail('FORBIDDEN_SELF', 'Anda tidak dapat menonaktifkan atau mengatur ulang kata sandi akun Anda sendiri. Untuk kata sandi, pakai menu Ubah kata sandi.');
    end if;
    if (v_new is not null and v_new <> t.role) or (p_target_unit_id is not null and p_target_unit_id is distinct from t.unit_id) then
      perform app.fail('FORBIDDEN_SELF', 'Anda tidak dapat mengubah peran atau unit akun Anda sendiri.');
    end if;
  end if;

  if not v_pusat and t.role not in ('PETUGAS', 'PIMPINAN') then
    perform app.fail('FORBIDDEN_TARGET', 'Admin Unit hanya dapat mengelola Petugas Arsip dan Pimpinan.');
  end if;

  if p_action = 'update' then
    if not v_pusat then
      if v_new is not null and v_new not in ('PETUGAS', 'PIMPINAN') then
        perform app.fail('FORBIDDEN_TARGET_ROLE', 'Admin Unit hanya dapat memberi peran Petugas Arsip atau Pimpinan.');
      end if;
      if p_target_unit_id is not null and p_target_unit_id <> a.unit_id then
        perform app.fail('FORBIDDEN_UNIT', 'Anda hanya dapat mengelola pengguna unit Anda sendiri.');
      end if;
    end if;
    v_eff_role := coalesce(v_new, t.role);
    if v_eff_role = 'ADMIN_PUSAT' then
      if p_target_unit_id is not null then
        perform app.fail('INVALID_INPUT', 'Admin Pusat tidak terikat pada satu unit.');
      end if;
      v_eff_unit := null;
    else
      v_eff_unit := coalesce(p_target_unit_id, t.unit_id);
      if v_eff_unit is null then
        perform app.fail('UNIT_REQUIRED', 'Unit wajib dipilih.');
      end if;
      if p_target_unit_id is not null and not exists (select 1 from public.units u where u.id = p_target_unit_id and u.active) then
        perform app.fail('UNIT_NOT_FOUND', 'Unit tidak ditemukan atau nonaktif.');
      end if;
    end if;
    if t.role = 'ADMIN_PUSAT' and t.active and v_eff_role <> 'ADMIN_PUSAT' and not exists (
         select 1 from public.profiles o where o.role = 'ADMIN_PUSAT' and o.active and o.user_id <> t.user_id) then
      perform app.fail('LAST_ADMIN_PUSAT', 'Ini satu-satunya Admin Pusat aktif. Angkat Admin Pusat lain lebih dulu sebelum mengubah perannya.');
    end if;
  elsif p_action = 'deactivate' then
    if t.role = 'ADMIN_PUSAT' and t.active and not exists (
         select 1 from public.profiles o where o.role = 'ADMIN_PUSAT' and o.active and o.user_id <> t.user_id) then
      perform app.fail('LAST_ADMIN_PUSAT', 'Ini satu-satunya Admin Pusat aktif. Angkat Admin Pusat lain lebih dulu sebelum menonaktifkannya.');
    end if;
  end if;

  return pg_catalog.jsonb_build_object('ok', true, 'actor_id', a.user_id);
end
$$;

-- ---------------------------------------------------------------------------
-- C. Gate (authenticated): decides ONLY from auth.uid()
-- ---------------------------------------------------------------------------
create or replace function public.user_admin_authorize(
  p_action text, p_target_user_id uuid, p_target_unit_id uuid, p_target_role text)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  select app.user_admin_check(auth.uid(), p_action, p_target_user_id, p_target_unit_id, p_target_role)
$$;
comment on function public.user_admin_authorize(text, uuid, uuid, text) is
  'Authorisation gate for user management. Uses auth.uid() only; returns {ok:true, actor_id} or raises a stable code.';

-- ---------------------------------------------------------------------------
-- D. Read: user_list (SECURITY INVOKER; RLS of profiles/units applies)
-- ---------------------------------------------------------------------------
create or replace function public.user_list(p_unit_id uuid default null)
returns jsonb
language plpgsql stable
set search_path = ''
as $$
declare
  v_role public.app_role := app.current_role();
  v_unit uuid;
begin
  if v_role is null then
    perform app.fail('ACCOUNT_INACTIVE', 'Akun Anda belum aktif atau sudah dinonaktifkan.');
  end if;
  if v_role not in ('ADMIN_PUSAT', 'ADMIN_UNIT') then
    perform app.fail('FORBIDDEN_ROLE', 'Hanya Admin Unit dan Admin Pusat yang dapat melihat daftar pengguna.');
  end if;
  if v_role = 'ADMIN_UNIT' then
    if p_unit_id is not null and p_unit_id <> app.current_unit_id() then
      perform app.fail('FORBIDDEN_UNIT', 'Anda hanya dapat melihat pengguna unit Anda sendiri.');
    end if;
    v_unit := app.current_unit_id();
  else
    v_unit := p_unit_id;
  end if;
  return coalesce((
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'user_id', p.user_id, 'email', p.email, 'full_name', p.full_name, 'role', p.role,
             'unit_id', p.unit_id, 'unit_code', u.code, 'unit_name', u.name, 'active', p.active,
             'must_change_password', p.must_change_password, 'created_at', p.created_at, 'updated_at', p.updated_at)
           order by pg_catalog.lower(p.full_name), p.user_id)
      from public.profiles p
      left join public.units u on u.id = p.unit_id
     where v_unit is null or p.unit_id = v_unit
  ), '[]'::jsonb);
end
$$;
comment on function public.user_list(uuid) is
  'Users visible to the caller: ADMIN_UNIT own unit; ADMIN_PUSAT all or one unit. Others FORBIDDEN_ROLE.';

-- ---------------------------------------------------------------------------
-- E. Write (service_role ONLY): profile + audit, re-validated, idempotent
-- ---------------------------------------------------------------------------
create or replace function public.user_profile_upsert_service(
  p_actor uuid, p_user_id uuid, p_email text, p_full_name text, p_role text,
  p_unit_id uuid, p_active boolean, p_must_change boolean, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_hash text;
  v_prev public.audit_log;
  t public.profiles;
  n public.profiles;
  v_exists boolean;
  v_new public.app_role;
  v_name text;
  v_email text;
  v_actions text[] := '{}';
  v_action text;
  v_changed boolean := true;
  v_result jsonb;
  v_before jsonb;
  v_after jsonb;
  v_actor public.profiles;
  v_ra app.actor;
  v_summary text;
  v_labels constant jsonb := '{"ADMIN_PUSAT":"Admin Pusat","ADMIN_UNIT":"Admin Unit","PETUGAS":"Petugas Arsip","PIMPINAN":"Pimpinan"}';
begin
  if p_request_id is null then
    perform app.fail('INVALID_INPUT', 'ID permintaan wajib diisi.', '{"field":"p_request_id"}');
  end if;
  if p_actor is null or p_user_id is null then
    perform app.fail('INVALID_INPUT', 'Pelaku dan pengguna yang dituju wajib diisi.');
  end if;

  -- user administration is rare and tiny: one global lock serialises it, which also
  -- makes the "last ADMIN_PUSAT" guard race-free.
  perform pg_catalog.pg_advisory_xact_lock(5409, pg_catalog.hashtext('user_admin'));

  v_hash := pg_catalog.md5(pg_catalog.concat_ws('|', p_user_id, p_email, p_full_name, p_role, p_unit_id, p_active, p_must_change));
  select * into v_prev from public.audit_log
   where request_id = p_request_id::text and module = 'PENGGUNA' order by occurred_at limit 1;
  if found then
    if v_prev.actor_user_id is distinct from p_actor or v_prev.object_id is distinct from p_user_id::text
       or coalesce(v_prev.after_data ->> 'req_hash', '') <> v_hash then
      perform app.fail('IDEMPOTENCY_CONFLICT', 'ID permintaan ini sudah dipakai untuk tindakan lain. Muat ulang halaman lalu ulangi.');
    end if;
    return (v_prev.after_data -> 'result') || '{"replayed": true}'::jsonb;
  end if;

  if p_role is not null then
    begin
      v_new := p_role::public.app_role;
    exception when invalid_text_representation then
      perform app.fail('INVALID_INPUT', 'Peran tidak dikenal.');
    end;
  end if;
  if p_must_change is false then
    perform app.fail('INVALID_INPUT', 'Penanda ganti kata sandi hanya dapat dihapus oleh pengguna sendiri.');
  end if;
  v_name := nullif(app.clean_text(p_full_name, 120), '');

  select * into t from public.profiles where user_id = p_user_id;
  v_exists := found;

  if not v_exists then
    -- ---- create ----------------------------------------------------------
    if v_name is null then
      perform app.fail('INVALID_INPUT', 'Nama lengkap wajib diisi.', '{"field":"full_name"}');
    end if;
    if p_active is false then
      perform app.fail('INVALID_INPUT', 'Akun baru selalu dibuat aktif.');
    end if;
    perform app.user_admin_check(p_actor, 'create', null, p_unit_id, p_role);
    select u.email into v_email from auth.users u where u.id = p_user_id;
    if not found then
      perform app.fail('AUTH_USER_MISSING', 'Akun login untuk pengguna ini belum dibuat.');
    end if;
    v_email := coalesce(nullif(pg_catalog.btrim(v_email), ''), nullif(pg_catalog.btrim(p_email), ''));
    insert into public.profiles (user_id, unit_id, role, full_name, active, must_change_password, email, must_change_fp)
    values (p_user_id, case when v_new = 'ADMIN_PUSAT' then null else p_unit_id end, v_new, v_name, true, true, v_email,
            app.pw_fingerprint(p_user_id))
    returning * into n;
    v_action := 'USER_CREATE';
    v_before := null;
  else
    -- ---- update ----------------------------------------------------------
    if v_name is not null and v_name <> t.full_name then v_actions := pg_catalog.array_append(v_actions, 'update'); end if;
    if v_new is not null and v_new <> t.role then v_actions := pg_catalog.array_append(v_actions, 'update'); end if;
    if p_unit_id is not null and p_unit_id is distinct from t.unit_id then v_actions := pg_catalog.array_append(v_actions, 'update'); end if;
    if p_active is not null and p_active <> t.active then
      v_actions := pg_catalog.array_append(v_actions, case when p_active then 'reactivate' else 'deactivate' end);
    end if;
    if p_must_change is true then v_actions := pg_catalog.array_append(v_actions, 'reset_password'); end if;
    v_before := pg_catalog.to_jsonb(t) - 'must_change_fp';
    if pg_catalog.cardinality(v_actions) = 0 then
      -- nothing to change; still require that the actor may manage this user
      perform app.user_admin_check(p_actor, 'update', p_user_id, null, null);
      return pg_catalog.jsonb_build_object('ok', true, 'user_id', p_user_id, 'created', false, 'changed', false,
                                           'replayed', false);
    end if;
    for v_action in select distinct x from pg_catalog.unnest(v_actions) x loop
      perform app.user_admin_check(p_actor, v_action, p_user_id,
        case when v_action = 'update' then p_unit_id end, case when v_action = 'update' then p_role end);
    end loop;
    update public.profiles set
      full_name = coalesce(v_name, full_name),
      role = coalesce(v_new, role),
      unit_id = case when coalesce(v_new, role) = 'ADMIN_PUSAT' then null else coalesce(p_unit_id, unit_id) end,
      active = coalesce(p_active, active),
      must_change_password = case when p_must_change is true then true else must_change_password end,
      must_change_fp = case when p_must_change is true then app.pw_fingerprint(p_user_id) else must_change_fp end,
      email = coalesce((select u.email from auth.users u where u.id = p_user_id), email),
      updated_at = pg_catalog.now()
     where user_id = p_user_id
    returning * into n;
    v_action := case
      when 'reset_password' = any (v_actions) then 'USER_RESET_PASSWORD'
      when 'deactivate' = any (v_actions) then 'USER_DEACTIVATE'
      when 'reactivate' = any (v_actions) then 'USER_REACTIVATE'
      else 'USER_UPDATE' end;
  end if;

  v_result := pg_catalog.jsonb_build_object(
    'ok', true, 'user_id', n.user_id, 'created', not v_exists, 'changed', v_changed, 'role', n.role,
    'unit_id', n.unit_id, 'active', n.active, 'must_change_password', n.must_change_password, 'replayed', false);
  v_after := pg_catalog.jsonb_build_object('profile', pg_catalog.to_jsonb(n) - 'must_change_fp',
                                           'result', v_result, 'req_hash', v_hash);

  select * into v_actor from public.profiles where user_id = p_actor;
  v_ra.user_id := p_actor;
  v_ra.unit_id := n.unit_id;
  v_ra.role := v_actor.role;
  v_ra.full_name := v_actor.full_name;
  v_ra.email := coalesce(v_actor.email, (select u.email from auth.users u where u.id = p_actor));
  v_summary := case v_action
    when 'USER_CREATE' then 'Membuat akun ' || n.full_name || ' (' || (v_labels ->> n.role::text) || ')'
    when 'USER_RESET_PASSWORD' then 'Mengatur ulang kata sandi sementara ' || n.full_name
    when 'USER_DEACTIVATE' then 'Menonaktifkan akun ' || n.full_name
    when 'USER_REACTIVATE' then 'Mengaktifkan kembali akun ' || n.full_name
    else 'Mengubah data akun ' || n.full_name end;
  perform app.audit(v_ra, v_action, 'PENGGUNA', 'PROFILE', n.user_id::text, v_summary, null, p_request_id::text,
                    v_before, v_after);
  return v_result;
end
$$;
comment on function public.user_profile_upsert_service(uuid, uuid, text, text, text, uuid, boolean, boolean, uuid) is
  'service_role only. Creates/updates a profile for p_user_id on behalf of p_actor, re-validating the user_admin rules; audited; idempotent by p_request_id. NULL = unchanged (update).';

-- ---------------------------------------------------------------------------
-- F. The user clears his/her own forced-change flag
-- ---------------------------------------------------------------------------
create or replace function public.password_changed()
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  p public.profiles;
  v_ra app.actor;
begin
  if v_uid is null then
    perform app.fail('AUTH_REQUIRED', 'Sesi login tidak ditemukan. Silakan masuk kembali.');
  end if;
  select * into p from public.profiles where user_id = v_uid for update;
  if not found or not p.active then
    perform app.fail('ACCOUNT_INACTIVE', 'Akun Anda belum aktif atau sudah dinonaktifkan. Hubungi admin unit.');
  end if;
  if not p.must_change_password then
    return pg_catalog.jsonb_build_object('ok', true, 'changed', false);
  end if;
  -- The flag may only go away once the Auth password differs from the temporary one.
  if p.must_change_fp is not null and p.must_change_fp = app.pw_fingerprint(v_uid) then
    perform app.fail('PASSWORD_NOT_CHANGED', 'Kata sandi sementara belum diganti. Buat kata sandi baru terlebih dahulu.');
  end if;
  update public.profiles set must_change_password = false, must_change_fp = null, updated_at = pg_catalog.now()
   where user_id = v_uid;
  v_ra.user_id := v_uid;
  v_ra.unit_id := p.unit_id;
  v_ra.role := p.role;
  v_ra.full_name := p.full_name;
  v_ra.email := coalesce(p.email, (select u.email from auth.users u where u.id = v_uid));
  perform app.audit(v_ra, 'USER_PASSWORD_CHANGED', 'PENGGUNA', 'PROFILE', v_uid::text,
                    'Mengganti kata sandi sementara ' || p.full_name, null, null);
  return pg_catalog.jsonb_build_object('ok', true, 'changed', true);
end
$$;
comment on function public.password_changed() is
  'authenticated: clears the caller''s own must_change_password (audited) once the Auth password really changed.';

-- ---------------------------------------------------------------------------
-- G. Privileges
-- ---------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array[
    'app.pw_fingerprint(uuid)',
    'app.user_admin_check(uuid, text, uuid, uuid, text)',
    'public.user_admin_authorize(text, uuid, uuid, text)',
    'public.user_list(uuid)',
    'public.user_profile_upsert_service(uuid, uuid, text, text, text, uuid, boolean, boolean, uuid)',
    'public.password_changed()'] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
  grant execute on function public.user_admin_authorize(text, uuid, uuid, text) to authenticated;
  grant execute on function public.user_list(uuid) to authenticated;
  grant execute on function public.password_changed() to authenticated;
  grant execute on function public.user_profile_upsert_service(uuid, uuid, text, text, text, uuid, boolean, boolean, uuid) to service_role;
end
$$;

-- ---------------------------------------------------------------------------
-- Self-check (pattern of 0014)
-- ---------------------------------------------------------------------------
do $$
declare
  r record;
  f text;
begin
  for r in select p.oid, n.nspname, p.proname, p.proconfig
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname in ('public', 'app') and p.prosecdef loop
    if r.proconfig is null or not ('search_path=""' = any (r.proconfig)) then
      raise exception 's3 users self-check: %.% is SECURITY DEFINER without an empty search_path', r.nspname, r.proname;
    end if;
    if has_function_privilege('anon', r.oid, 'EXECUTE') then
      raise exception 's3 users self-check: anon can execute %.%', r.nspname, r.proname;
    end if;
  end loop;
  foreach f in array array[
    'public.user_admin_authorize(text, uuid, uuid, text)', 'public.user_list(uuid)', 'public.password_changed()',
    'public.user_profile_upsert_service(uuid, uuid, text, text, text, uuid, boolean, boolean, uuid)',
    'app.user_admin_check(uuid, text, uuid, uuid, text)', 'app.pw_fingerprint(uuid)'] loop
    if has_function_privilege('anon', f, 'EXECUTE') or has_function_privilege('public', f, 'EXECUTE') then
      raise exception 's3 users self-check: anon/public can execute %', f;
    end if;
  end loop;
  if has_function_privilege('authenticated', 'public.user_profile_upsert_service(uuid, uuid, text, text, text, uuid, boolean, boolean, uuid)', 'EXECUTE')
     or has_function_privilege('authenticated', 'app.user_admin_check(uuid, text, uuid, uuid, text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'app.pw_fingerprint(uuid)', 'EXECUTE') then
    raise exception 's3 users self-check: a service/private function is executable by authenticated';
  end if;
  if not has_function_privilege('service_role', 'public.user_profile_upsert_service(uuid, uuid, text, text, text, uuid, boolean, boolean, uuid)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.user_admin_authorize(text, uuid, uuid, text)', 'EXECUTE') then
    raise exception 's3 users self-check: service_role grants are wrong';
  end if;
  if has_table_privilege('authenticated', 'public.profiles', 'INSERT, UPDATE, DELETE, TRUNCATE') then
    raise exception 's3 users self-check: authenticated can write public.profiles';
  end if;
end
$$;

insert into public.schema_migrations_log (version, name)
values ('0021', 's3_users') on conflict (version) do nothing;
