-- 0001_foundation.sql
-- Central File UINSA v4 — foundation: extensions, schemas, roles enum, units,
-- profiles, migration log, identity helpers, PII helpers, guard triggers.
--
-- Rules for every migration in this folder:
--   * plain SQL, idempotent (safe to apply twice), no BEGIN/COMMIT inside;
--   * depends only on what Supabase provides: roles anon / authenticated /
--     service_role, auth.users, auth.uid(), schema "extensions" with pgcrypto;
--   * every function uses an empty search_path and fully-qualified names.

-- ---------------------------------------------------------------------------
-- Extensions and schemas
-- ---------------------------------------------------------------------------
create schema if not exists extensions;
-- Supabase already has pgcrypto in schema "extensions"; this is a no-op there.
create extension if not exists pgcrypto with schema extensions;

create schema if not exists app;
comment on schema app is
  'Central File v4 internal helpers (identity, PII, counters). Not exposed via PostgREST.';
revoke all on schema app from public;

-- ---------------------------------------------------------------------------
-- Migration log (technical; not unit-scoped, no access for API roles)
-- ---------------------------------------------------------------------------
create table if not exists public.schema_migrations_log (
  version     text primary key,
  name        text not null,
  applied_at  timestamptz not null default now(),
  applied_by  text not null default current_user
);
comment on table public.schema_migrations_log is
  'Application-level record of v4 migrations applied (in addition to the Supabase CLI history).';

-- ---------------------------------------------------------------------------
-- Role enum
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'app_role'
  ) then
    create type public.app_role as enum ('ADMIN_PUSAT', 'ADMIN_UNIT', 'PETUGAS', 'PIMPINAN');
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Units
-- ---------------------------------------------------------------------------
create table if not exists public.units (
  id                  uuid primary key default gen_random_uuid(),
  code                text not null unique,                 -- legacy SETTINGS.UNIT_CODE
  name                text not null,                        -- legacy SETTINGS.UNIT_NAME
  legacy_instance_id  text unique,                          -- legacy SETTINGS.INSTANCE_ID (e.g. INS-6d92f552-...)
  legacy_unit_id      text,                                 -- legacy SETTINGS.UNIT_ID (used in UNIT_PENCIPTA_ID)
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  constraint units_code_not_blank check (btrim(code) <> '')
);
comment on table public.units is 'Unit kerja (one legacy Central File instance = one unit).';

-- ---------------------------------------------------------------------------
-- Profiles (one per auth user)
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  unit_id     uuid references public.units(id),
  role        public.app_role not null,
  full_name   text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  constraint profiles_unit_required
    check ((role = 'ADMIN_PUSAT' and unit_id is null) or (role <> 'ADMIN_PUSAT' and unit_id is not null))
);
create index if not exists profiles_unit_idx on public.profiles (unit_id);
comment on table public.profiles is
  'Application profile per login. unit_id is null only for ADMIN_PUSAT. Deactivate (active=false) instead of deleting.';

-- ---------------------------------------------------------------------------
-- Identity helpers (security definer, read profiles by auth.uid()).
-- They return NULL / false for unknown or inactive users and for users whose
-- unit is inactive, so RLS policies built on them deny by default.
-- ---------------------------------------------------------------------------
create or replace function app.is_active()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select coalesce((
    select p.active and (p.unit_id is null or u.active)
    from public.profiles p
    left join public.units u on u.id = p.unit_id
    where p.user_id = auth.uid()
  ), false)
$$;

create or replace function app.current_role()
returns public.app_role
language sql stable security definer
set search_path = ''
as $$
  select p.role
  from public.profiles p
  left join public.units u on u.id = p.unit_id
  where p.user_id = auth.uid()
    and p.active
    and (p.unit_id is null or u.active)
$$;

create or replace function app.current_unit_id()
returns uuid
language sql stable security definer
set search_path = ''
as $$
  select p.unit_id
  from public.profiles p
  join public.units u on u.id = p.unit_id
  where p.user_id = auth.uid()
    and p.active
    and u.active
$$;

comment on function app.is_active() is 'True when the caller has an active profile (and, for unit users, an active unit).';
comment on function app.current_role() is 'Role of the active caller, else NULL.';
comment on function app.current_unit_id() is 'Unit of the active caller, else NULL (always NULL for ADMIN_PUSAT).';

-- ---------------------------------------------------------------------------
-- PII column encryption (pgcrypto, symmetric). The key is supplied per
-- session/transaction by the server: select set_config('app.pii_key', $1, true)
-- It is never stored in the database or the repository.
-- ---------------------------------------------------------------------------
create or replace function app.encrypt_pii(plaintext text)
returns bytea
language plpgsql volatile
set search_path = ''
as $$
declare
  k text := current_setting('app.pii_key', true);
begin
  if plaintext is null then
    return null;
  end if;
  if k is null or length(k) < 16 then
    raise exception 'app.pii_key is not set (or shorter than 16 characters)' using errcode = '22023';
  end if;
  return extensions.pgp_sym_encrypt(plaintext, k, 'cipher-algo=aes256, compress-algo=0');
end
$$;

create or replace function app.decrypt_pii(ciphertext bytea)
returns text
language plpgsql volatile
set search_path = ''
as $$
declare
  k text := current_setting('app.pii_key', true);
begin
  if ciphertext is null then
    return null;
  end if;
  if k is null or length(k) < 16 then
    raise exception 'app.pii_key is not set (or shorter than 16 characters)' using errcode = '22023';
  end if;
  return extensions.pgp_sym_decrypt(ciphertext, k);
end
$$;

comment on function app.encrypt_pii(text) is 'Encrypt a PII value with the runtime key app.pii_key. service_role only.';
comment on function app.decrypt_pii(bytea) is 'Decrypt a PII value with the runtime key app.pii_key. service_role only.';

-- ---------------------------------------------------------------------------
-- Guard triggers
-- ---------------------------------------------------------------------------
create or replace function app.tg_forbid_hard_delete()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Hard delete is not allowed on %.% — use the status/soft-delete columns',
    tg_table_schema, tg_table_name using errcode = '42501';
end
$$;

create or replace function app.tg_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '%.% is append-only (% rejected)', tg_table_schema, tg_table_name, tg_op
    using errcode = '42501';
end
$$;

-- Units are never hard-deleted (set active = false).
create or replace trigger units_no_hard_delete
  before delete or truncate on public.units
  for each statement execute function app.tg_forbid_hard_delete();

insert into public.schema_migrations_log (version, name)
values ('0001', 'foundation') on conflict (version) do nothing;
