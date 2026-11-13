-- bootstrap_supabase_stub.sql — TEST ONLY.
-- Recreates, on plain Postgres 16, the small part of Supabase the v4
-- migrations depend on. Run as a superuser on an empty database, before
-- the migrations. Never run this against a real Supabase project.
--
--   * roles anon, authenticated (NOLOGIN, no BYPASSRLS), service_role
--     (NOLOGIN, BYPASSRLS), authenticator (LOGIN, may switch to those)
--   * role postgres: non-superuser migration owner with BYPASSRLS, as on Supabase
--   * schema auth with auth.users(id, email) and auth.uid() reading
--     request.jwt.claims ->> 'sub'
--   * schema extensions with pgcrypto
--   * Supabase-style default privileges (ALL on new public tables/functions
--     to anon, authenticated, service_role) so the migrations' revokes are tested.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'postgres') then
    create role postgres login createrole bypassrls;
  end if;
end
$$;

grant anon, authenticated, service_role to authenticator;
grant anon, authenticated, service_role to postgres;

-- The migration owner owns the database (needs CREATE for schemas/extensions).
do $$ begin execute format('alter database %I owner to postgres', current_database()); end $$;

create schema if not exists extensions;
grant usage on schema extensions to public;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role, postgres;

create table if not exists auth.users (
  id    uuid primary key,
  email text
);
grant select, references on auth.users to postgres;
grant all on auth.users to service_role;

create or replace function auth.uid()
returns uuid
language sql stable
as $$
  select nullif(
    (coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::json ->> 'sub'),
    ''
  )::uuid
$$;
grant execute on function auth.uid() to public;

grant usage on schema public to anon, authenticated, service_role;
grant create on schema public to postgres;

alter default privileges for role postgres in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on functions to anon, authenticated, service_role;
