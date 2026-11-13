-- 0002_platform_tables.sql
-- Per-unit settings, append-only audit log, idempotency keys, numbering counters.

-- ---------------------------------------------------------------------------
-- unit_settings  (legacy sheet SETTINGS: KEY, VALUE, TYPE, DESCRIPTION)
-- Secrets (e.g. RECORD_CENTER_SHARED_SECRET) must NOT be stored here: this
-- table is readable by every user of the unit. Federation secrets get their
-- own encrypted, service-role-only table in Sprint 5.
-- ---------------------------------------------------------------------------
create table if not exists public.unit_settings (
  unit_id      uuid not null references public.units(id),
  key          text not null,                  -- KEY
  value        jsonb,                          -- VALUE
  value_type   text not null default 'STRING', -- TYPE (STRING | NUMBER | BOOLEAN | URL | JSON ...)
  description  text,                           -- DESCRIPTION
  updated_at   timestamptz not null default now(),
  updated_by   text,
  primary key (unit_id, key),
  constraint unit_settings_key_format check (key ~ '^[A-Z][A-Z0-9_]*$'),
  constraint unit_settings_no_secrets check (key !~ '(SECRET|PASSWORD|TOKEN|PRIVATE_KEY|API_KEY)')
);

-- ---------------------------------------------------------------------------
-- audit_log  (legacy sheet AUDIT_LOG: LOG_ID, TIMESTAMP, USER_EMAIL, AKSI,
-- MODUL, JENIS_OBJEK, OBJEK_ID, RINGKASAN, ALASAN, REQUEST_ID, STATUS)
-- Append-only: UPDATE / DELETE / TRUNCATE are rejected by trigger for every
-- role, including service_role. unit_id is NULL only for cross-unit actions
-- of ADMIN_PUSAT (e.g. creating a unit).
-- ---------------------------------------------------------------------------
create table if not exists public.audit_log (
  id                    text primary key default ('LOG-' || gen_random_uuid()::text), -- LOG_ID
  unit_id               uuid references public.units(id),
  occurred_at           timestamptz not null default now(),   -- TIMESTAMP
  actor_user_id         uuid,                                 -- (new) auth user; NULL for imported legacy rows
  actor_name_snapshot   text,                                 -- (new) profile full_name at the time
  actor_email_snapshot  text,                                 -- USER_EMAIL
  action                text not null,                        -- AKSI
  module                text,                                 -- MODUL
  object_type           text,                                 -- JENIS_OBJEK
  object_id             text,                                 -- OBJEK_ID
  summary               text,                                 -- RINGKASAN
  reason                text,                                 -- ALASAN
  request_id            text,                                 -- REQUEST_ID
  result                text not null default 'SUCCESS',      -- STATUS
  before_data           jsonb,
  after_data            jsonb,
  constraint audit_log_result_check check (result in ('SUCCESS', 'FAILED', 'WARNING'))
);
create index if not exists audit_log_unit_time_idx on public.audit_log (unit_id, occurred_at desc);
create index if not exists audit_log_object_idx on public.audit_log (unit_id, object_type, object_id);

create or replace trigger audit_log_append_only
  before update or delete or truncate on public.audit_log
  for each statement execute function app.tg_append_only();

-- ---------------------------------------------------------------------------
-- idempotency_keys: one row per write request handled by an Edge Function.
-- ---------------------------------------------------------------------------
create table if not exists public.idempotency_keys (
  unit_id        uuid not null references public.units(id),
  request_id     text not null,
  operation      text not null,
  actor_user_id  uuid,
  response       jsonb,
  created_at     timestamptz not null default now(),
  primary key (unit_id, request_id),
  constraint idempotency_request_id_not_blank check (btrim(request_id) <> '')
);
create index if not exists idempotency_keys_created_idx on public.idempotency_keys (created_at);

-- ---------------------------------------------------------------------------
-- counters: per-unit display-number sequences (TRM = tanda terima, UP = usul
-- pindah, ...). year = 0 for sequences that do not reset yearly.
-- ---------------------------------------------------------------------------
create table if not exists public.counters (
  unit_id     uuid not null references public.units(id),
  scope       text not null,
  year        integer not null,
  last_value  bigint not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (unit_id, scope, year),
  constraint counters_scope_format check (scope ~ '^[A-Z][A-Z0-9_]*$'),
  constraint counters_year_range check (year between 0 and 9999),
  constraint counters_last_value_nonneg check (last_value >= 0)
);

create or replace trigger counters_no_hard_delete
  before delete or truncate on public.counters
  for each statement execute function app.tg_forbid_hard_delete();

-- Atomically increments and returns the next value. Concurrent callers on the
-- same (unit, scope, year) serialise on the row lock taken by ON CONFLICT DO
-- UPDATE, so values are distinct and gap-free while transactions commit.
create or replace function app.next_counter(p_unit_id uuid, p_scope text, p_year integer)
returns bigint
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v bigint;
begin
  if p_unit_id is null or p_scope is null or p_year is null then
    raise exception 'next_counter: unit_id, scope and year are required' using errcode = '22004';
  end if;
  insert into public.counters as c (unit_id, scope, year, last_value, updated_at)
  values (p_unit_id, p_scope, p_year, 1, now())
  on conflict (unit_id, scope, year)
  do update set last_value = c.last_value + 1, updated_at = now()
  returning c.last_value into v;
  return v;
end
$$;
comment on function app.next_counter(uuid, text, integer) is
  'Next per-unit display number for (scope, year). service_role only.';

insert into public.schema_migrations_log (version, name)
values ('0002', 'platform_tables') on conflict (version) do nothing;
