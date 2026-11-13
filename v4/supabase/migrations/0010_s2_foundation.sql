-- 0010_s2_foundation.sql
-- Sprint 2 foundation for write RPCs (see v4/supabase/API_S2.md):
--   * error convention  app.fail(code, message, detail)
--   * caller resolution app.require_actor / app.require_actor_object
--   * per-unit lock, idempotency, audit helpers
--   * legacy text/date helpers ported from 3.32.5 (cleanText_, cleanFileName_,
--     normalizedLetterNumber_, addDuration_, retentionStatus_, security rank)
--   * app.server_secret (Supabase Vault, local GUC fallback)
--   * tables: jenis_naskah, penerimaan_cetak_log, upload_sessions, drive_tasks
-- Idempotent; no BEGIN/COMMIT.

-- ---------------------------------------------------------------------------
-- Natural, case/accent-insensitive ordering (JS localeCompare('id', {numeric, base}))
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_collation c join pg_namespace n on n.oid = c.collnamespace
                 where n.nspname = 'app' and c.collname = 'natural_ci') then
    create collation app.natural_ci (provider = icu, locale = 'id-u-kn-true-ks-level1', deterministic = false);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Error convention: SQLSTATE P0001, message "<CODE>: <pesan>", hint = CODE.
-- ---------------------------------------------------------------------------
create or replace function app.fail(p_code text, p_message text, p_detail jsonb default null)
returns void
language plpgsql volatile
set search_path = ''
as $$
begin
  raise exception '%: %', p_code, p_message
    using errcode = 'P0001', hint = p_code, detail = coalesce(p_detail::text, '');
end
$$;

-- ---------------------------------------------------------------------------
-- Legacy helpers (pure)
-- ---------------------------------------------------------------------------
-- cleanText_: collapse whitespace, trim, cut to max length; '' for null.
create or replace function app.clean_text(p_value text, p_max integer default null)
returns text
language sql immutable
set search_path = ''
as $$
  select case when p_max is null then t else pg_catalog.left(t, p_max) end
  from (select pg_catalog.btrim(pg_catalog.regexp_replace(coalesce(p_value, ''), '\s+', ' ', 'g')) as t) s
$$;

-- cleanFileName_
create or replace function app.clean_file_name(p_value text)
returns text
language sql immutable
set search_path = ''
as $$
  select coalesce(nullif(
    pg_catalog.regexp_replace(
      pg_catalog.regexp_replace(app.clean_text(p_value, 120), '[\\/:*?"<>|#%{}~]', '-', 'g'),
      '[. ]+$', ''), ''), 'Tanpa Judul')
$$;

-- normalizedLetterNumber_
create or replace function app.normalized_letter(p_primary text, p_alternate text)
returns text
language sql immutable
set search_path = ''
as $$
  select coalesce(nullif(pg_catalog.btrim(pg_catalog.regexp_replace(
           pg_catalog.upper(app.clean_text(coalesce(nullif(p_primary, ''), nullif(p_alternate, ''), ''), 250)),
           '[^A-Z0-9]+', ' ', 'g')), ''), 'ZZZZZZ')
$$;

-- displayLetterNumber_
create or replace function app.display_letter(p_primary text, p_alternate text)
returns text
language sql immutable
set search_path = ''
as $$
  select case
    when nullif(p_primary, '') is not null and nullif(p_alternate, '') is not null then p_primary || ' atau ' || p_alternate
    else coalesce(nullif(p_primary, ''), nullif(p_alternate, ''), '') end
$$;

-- addDuration_ with JavaScript Date#setMonth / #setFullYear overflow semantics
-- (31 Jan + 1 month = 3 Mar; 29 Feb + 1 year = 1 Mar).
create or replace function app.add_duration(p_date date, p_amount integer, p_unit text)
returns date
language sql immutable
set search_path = ''
as $$
  select case when p_date is null then null else
    (pg_catalog.make_date(
       ((pg_catalog.date_part('year', p_date)::int * 12 + pg_catalog.date_part('month', p_date)::int - 1
         + coalesce(p_amount, 0) * case when pg_catalog.upper(coalesce(p_unit, '')) = 'TAHUN' then 12 else 1 end) / 12),
       ((pg_catalog.date_part('year', p_date)::int * 12 + pg_catalog.date_part('month', p_date)::int - 1
         + coalesce(p_amount, 0) * case when pg_catalog.upper(coalesce(p_unit, '')) = 'TAHUN' then 12 else 1 end) % 12) + 1,
       1) + (pg_catalog.date_part('day', p_date)::int - 1))::date
  end
$$;

-- retentionStatus_ (today in Asia/Jakarta)
create or replace function app.retention_status(p_active_limit date, p_today date)
returns text
language sql immutable
set search_path = ''
as $$
  select case
    when p_active_limit is null then null
    when p_active_limit - p_today < 0 then 'HABIS AKTIF – PERLU PERSETUJUAN PEMINDAHAN'
    when p_active_limit - p_today <= 7 then 'H-' || (p_active_limit - p_today)::text
    else 'AKTIF' end
$$;

-- centralFileMetadataNormalizeSecurity_ / archiveSecurityRank_
create or replace function app.normalize_security(p_value text)
returns text
language sql immutable
set search_path = ''
as $$
  select case
    when v in ('BIASA', 'TERBUKA', 'BIASA TERBUKA', 'BIASA/TERBUKA') then 'BIASA/TERBUKA'
    when v in ('TERBATAS', 'RAHASIA', 'SANGAT RAHASIA') then v
    else 'BIASA/TERBUKA' end
  from (select pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.regexp_replace(
          pg_catalog.upper(app.clean_text(p_value, 50)), '[-_]+', ' ', 'g'), '\s+', ' ', 'g')) as v) s
$$;

create or replace function app.security_rank(p_value text)
returns integer
language sql immutable
set search_path = ''
as $$
  select case app.normalize_security(p_value)
    when 'TERBATAS' then 2 when 'RAHASIA' then 3 when 'SANGAT RAHASIA' then 4 else 1 end
$$;

-- validateArchiveSecurityClassification_: required and recognised, else NULL (caller fails).
create or replace function app.valid_security(p_value text)
returns text
language sql immutable
set search_path = ''
as $$
  select case when pg_catalog.upper(app.clean_text(p_value, 50)) in ('BIASA/TERBUKA', 'TERBATAS', 'RAHASIA', 'SANGAT RAHASIA')
              or pg_catalog.regexp_replace(pg_catalog.upper(app.clean_text(p_value, 50)), '[-_]+', ' ', 'g')
                 in ('BIASA', 'TERBUKA', 'BIASA TERBUKA', 'BIASA/TERBUKA')
         then app.normalize_security(p_value) end
$$;

-- nowIso_-style text for an instant, in Asia/Jakarta (+07:00)
create or replace function app.jakarta_iso(p_ts timestamptz)
returns text
language sql immutable
set search_path = ''
as $$
  select pg_catalog.to_char(p_ts at time zone 'Asia/Jakarta', 'YYYY-MM-DD"T"HH24:MI:SS') || '+07:00'
$$;

-- Receipt line helpers (receiptItemMetadataComplete_, normalizeReceiptFilingStatus_)
create or replace function app.receipt_item_complete(
  p_arsip_id text, p_tanggal date, p_uraian text, p_halaman integer, p_tingkat text, p_kondisi text, p_keamanan text)
returns boolean
language sql immutable
set search_path = ''
as $$
  select app.clean_text(p_arsip_id) <> '' and p_tanggal is not null and app.clean_text(p_uraian) <> ''
     and coalesce(p_halaman, 0) >= 1 and app.clean_text(p_tingkat) <> '' and app.clean_text(p_kondisi) <> ''
     and app.clean_text(p_keamanan) <> ''
$$;

create or replace function app.receipt_filing_status(p_status text, p_tanggal date)
returns text
language sql immutable
set search_path = ''
as $$
  select case
    when pg_catalog.upper(coalesce(p_status, '')) in ('BELUM DIBERKASKAN', 'SUDAH DIBERKASKAN', 'PERLU DILENGKAPI', 'DIBATALKAN')
      then pg_catalog.upper(p_status)
    when p_tanggal is not null then 'BELUM DIBERKASKAN'
    else 'PERLU DILENGKAPI' end
$$;

create or replace function app.hmac_hex(p_data text, p_key text)
returns text
language sql immutable
set search_path = ''
as $$
  select pg_catalog.encode(extensions.hmac(pg_catalog.convert_to(p_data, 'UTF8'), pg_catalog.convert_to(p_key, 'UTF8'), 'sha256'), 'hex')
$$;

-- ---------------------------------------------------------------------------
-- Server secrets: Supabase Vault; local tests (no vault schema) use the GUC
-- app.secret.<name>. Never granted to API roles.
-- ---------------------------------------------------------------------------
create or replace function app.server_secret(p_name text)
returns text
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v text;
begin
  if p_name is null or p_name !~ '^[A-Z][A-Z0-9_]{2,62}$' then
    perform app.fail('INVALID_INPUT', 'Nama secret tidak valid.');
  end if;
  if exists (select 1 from pg_catalog.pg_namespace where nspname = 'vault') then
    execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1' into v using p_name;
  else
    v := nullif(pg_catalog.current_setting('app.secret.' || p_name, true), '');
  end if;
  if v is null or pg_catalog.length(v) < 32 then
    perform app.fail('SERVER_SECRET_MISSING', 'Konfigurasi server belum lengkap (secret ' || p_name || '). Hubungi Admin Pusat.');
  end if;
  return v;
end
$$;

-- ---------------------------------------------------------------------------
-- Caller resolution
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type t join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'app' and t.typname = 'actor') then
    create type app.actor as (
      user_id uuid, unit_id uuid, role public.app_role, full_name text, email text, unit_code text, is_pusat boolean);
  end if;
end
$$;

-- Base: logged in, active profile, active unit, role allowed for writes.
create or replace function app.actor_base(p_write boolean)
returns app.actor
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  p public.profiles;
  a app.actor;
begin
  if v_uid is null then
    perform app.fail('AUTH_REQUIRED', 'Sesi login tidak ditemukan. Silakan masuk kembali.');
  end if;
  select * into p from public.profiles where user_id = v_uid;
  if not found or not p.active then
    perform app.fail('ACCOUNT_INACTIVE', 'Akun Anda belum aktif atau sudah dinonaktifkan. Hubungi admin unit.');
  end if;
  if p.unit_id is not null and not exists (select 1 from public.units u where u.id = p.unit_id and u.active) then
    perform app.fail('ACCOUNT_INACTIVE', 'Unit Anda sedang nonaktif. Hubungi Admin Pusat.');
  end if;
  if p_write and p.role not in ('ADMIN_PUSAT', 'ADMIN_UNIT', 'PETUGAS') then
    perform app.fail('FORBIDDEN_ROLE', 'Peran Anda hanya dapat mencari dan membuka arsip; perubahan data dilakukan oleh petugas atau admin.');
  end if;
  a.user_id := v_uid;
  a.role := p.role;
  a.full_name := p.full_name;
  a.is_pusat := p.role = 'ADMIN_PUSAT';
  a.unit_id := p.unit_id;
  select email into a.email from auth.users where id = v_uid;
  return a;
end
$$;

-- For operations that create data in a unit (ADMIN_PUSAT passes it explicitly).
create or replace function app.require_actor(p_unit_id uuid, p_write boolean default true)
returns app.actor
language plpgsql stable security definer
set search_path = ''
as $$
declare
  a app.actor := app.actor_base(p_write);
  v_code text;
begin
  if a.is_pusat then
    if p_unit_id is null then
      perform app.fail('UNIT_REQUIRED', 'Admin Pusat wajib memilih unit tujuan.');
    end if;
    select code into v_code from public.units where id = p_unit_id and active;
    if v_code is null then
      perform app.fail('UNIT_NOT_FOUND', 'Unit tujuan tidak ditemukan atau nonaktif.');
    end if;
    a.unit_id := p_unit_id;
  else
    if p_unit_id is not null and p_unit_id <> a.unit_id then
      perform app.fail('FORBIDDEN_UNIT', 'Anda hanya dapat mengelola data unit Anda sendiri.');
    end if;
    select code into v_code from public.units where id = a.unit_id;
  end if;
  a.unit_code := v_code;
  return a;
end
$$;

-- For operations on an existing object: the object's unit decides. Objects of
-- other units are reported as NOT_FOUND (existence is not revealed).
create or replace function app.require_actor_object(p_object_unit uuid, p_what text, p_write boolean default true)
returns app.actor
language plpgsql stable security definer
set search_path = ''
as $$
declare
  a app.actor := app.actor_base(p_write);
  v_code text;
begin
  if p_object_unit is null or (not a.is_pusat and p_object_unit <> a.unit_id) then
    perform app.fail('NOT_FOUND', coalesce(p_what, 'Data') || ' tidak ditemukan.');
  end if;
  select code into v_code from public.units where id = p_object_unit and active;
  if v_code is null then
    perform app.fail('UNIT_NOT_FOUND', 'Unit data ini nonaktif.');
  end if;
  a.unit_id := p_object_unit;
  a.unit_code := v_code;
  return a;
end
$$;

-- Unit for read RPCs (SECURITY INVOKER): own unit, or the explicit unit for ADMIN_PUSAT.
create or replace function app.read_unit(p_unit_id uuid)
returns uuid
language plpgsql stable
set search_path = ''
as $$
declare
  v_role public.app_role := app.current_role();
begin
  if v_role is null then
    perform app.fail('ACCOUNT_INACTIVE', 'Akun Anda belum aktif atau sudah dinonaktifkan.');
  end if;
  if v_role = 'ADMIN_PUSAT' then
    if p_unit_id is null then perform app.fail('UNIT_REQUIRED', 'Admin Pusat wajib memilih unit.'); end if;
    return p_unit_id;
  end if;
  if p_unit_id is not null and p_unit_id <> app.current_unit_id() then
    perform app.fail('FORBIDDEN_UNIT', 'Anda hanya dapat melihat data unit Anda sendiri.');
  end if;
  return app.current_unit_id();
end
$$;

-- ---------------------------------------------------------------------------
-- Per-unit serialisation (numbering, cross-table invariants, idempotency)
-- ---------------------------------------------------------------------------
create or replace function app.lock_unit(p_unit_id uuid)
returns void
language sql volatile
set search_path = ''
as $$
  select pg_catalog.pg_advisory_xact_lock(5407, pg_catalog.hashtext(p_unit_id::text))
$$;

-- ---------------------------------------------------------------------------
-- Idempotency
-- ---------------------------------------------------------------------------
alter table public.idempotency_keys add column if not exists request_hash text;

-- Stored response (with "replayed": true) or NULL. Conflicts raise.
create or replace function app.idem_lookup(p_unit_id uuid, p_request_id uuid, p_operation text, p_hash text)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  k public.idempotency_keys;
begin
  if p_request_id is null then
    perform app.fail('INVALID_INPUT', 'ID permintaan wajib diisi.', '{"field":"p_request_id"}');
  end if;
  select * into k from public.idempotency_keys where unit_id = p_unit_id and request_id = p_request_id::text;
  if not found then return null; end if;
  if k.operation <> p_operation or coalesce(k.request_hash, '') <> coalesce(p_hash, '') then
    perform app.fail('IDEMPOTENCY_CONFLICT',
      'ID permintaan ini sudah dipakai untuk transaksi lain. Muat ulang halaman lalu ulangi.');
  end if;
  return k.response || '{"replayed": true}'::jsonb;
end
$$;

create or replace function app.idem_store(p_unit_id uuid, p_request_id uuid, p_operation text, p_hash text,
                                          p_actor uuid, p_response jsonb)
returns jsonb
language sql volatile security definer
set search_path = ''
as $$
  insert into public.idempotency_keys (unit_id, request_id, operation, request_hash, actor_user_id, response)
  values (p_unit_id, p_request_id::text, p_operation, p_hash, p_actor, p_response);
  select p_response || '{"replayed": false}'::jsonb
$$;

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------
create or replace function app.audit(
  a app.actor, p_action text, p_module text, p_object_type text, p_object_id text,
  p_summary text, p_reason text, p_request_id text,
  p_before jsonb default null, p_after jsonb default null, p_result text default 'SUCCESS')
returns text
language sql volatile security definer
set search_path = ''
as $$
  insert into public.audit_log (unit_id, actor_user_id, actor_name_snapshot, actor_email_snapshot, action, module,
                                object_type, object_id, summary, reason, request_id, result, before_data, after_data)
  values (a.unit_id, a.user_id, a.full_name, a.email, p_action, p_module, p_object_type, p_object_id,
          pg_catalog.left(p_summary, 500), nullif(pg_catalog.left(coalesce(p_reason, ''), 2000), ''),
          p_request_id, p_result, p_before, p_after)
  returning id
$$;

-- ---------------------------------------------------------------------------
-- New columns for verified uploads
-- ---------------------------------------------------------------------------
alter table public.item       add column if not exists drive_file_md5      text;
alter table public.penerimaan add column if not exists bukti_ttd_size_bytes bigint;
alter table public.penerimaan add column if not exists bukti_ttd_md5        text;
alter table public.penerimaan add column if not exists batal_bukti_size_bytes bigint;
alter table public.penerimaan add column if not exists batal_bukti_md5      text;

-- ---------------------------------------------------------------------------
-- jenis_naskah  (MASTER_JENIS_NASKAH)
-- ---------------------------------------------------------------------------
create table if not exists public.jenis_naskah (
  unit_id                uuid not null references public.units(id),
  subjenis_naskah_id     text not null,   -- SUBJENIS_NASKAH_ID (unique in the pilot)
  jenis_naskah_id        text not null,   -- JENIS_NASKAH_ID (category level; DB_BERKAS.KATEGORI_NASKAH_ID refers to it)
  kategori               text,            -- KATEGORI
  subjenis               text,            -- SUBJENIS
  pola_default           text,            -- POLA_DEFAULT (SERI | RUBRIK_ATAU_SERI)
  periode_default        text,            -- PERIODE_DEFAULT (BULAN | TAHUN | DINAMIS)
  template_judul_berkas  text,            -- TEMPLATE_JUDUL_BERKAS
  perlu_kelengkapan      boolean not null default false, -- PERLU_KELENGKAPAN
  opsi_kelengkapan       text,            -- OPSI_KELENGKAPAN ('a|b')
  aktif                  boolean not null default false, -- AKTIF
  urutan                 integer,         -- URUTAN
  catatan                text,            -- CATATAN
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  primary key (unit_id, subjenis_naskah_id)
);
create index if not exists jenis_naskah_jenis_idx on public.jenis_naskah (unit_id, jenis_naskah_id);
create or replace trigger jenis_naskah_no_hard_delete before delete or truncate on public.jenis_naskah
  for each statement execute function app.tg_forbid_hard_delete();

-- ---------------------------------------------------------------------------
-- penerimaan_cetak_log  (LOG_CETAK_PENERIMAAN), append-only
-- ---------------------------------------------------------------------------
create table if not exists public.penerimaan_cetak_log (
  id                            text primary key,     -- CETAK_ID (RCPL-…)
  unit_id                       uuid not null references public.units(id),
  penerimaan_id                 text not null,        -- PENERIMAAN_ID
  nomor_tanda_terima_snapshot   text,                 -- NOMOR_TANDA_TERIMA_SNAPSHOT
  print_token                   text not null,        -- PRINT_TOKEN (RCPRINT-…)
  cetak_ke                      integer not null,     -- CETAK_KE
  jenis_cetak                   text not null,        -- JENIS_CETAK (PERTAMA | CETAK ULANG)
  status_snapshot               text,                 -- STATUS_SNAPSHOT
  printed_at                    timestamptz not null default now(), -- TIMESTAMP
  user_email                    text,                 -- USER_EMAIL
  pdf_file_name                 text,                 -- PDF_FILE_NAME
  actor_user_id                 uuid,                 -- (new)
  constraint penerimaan_cetak_log_unit_id_key unique (unit_id, id),
  constraint penerimaan_cetak_log_token_key unique (unit_id, print_token),
  constraint penerimaan_cetak_log_penerimaan_fk foreign key (unit_id, penerimaan_id)
    references public.penerimaan (unit_id, id) deferrable initially deferred,
  constraint penerimaan_cetak_log_jenis_check check (jenis_cetak in ('PERTAMA', 'CETAK ULANG'))
);
create index if not exists penerimaan_cetak_log_penerimaan_idx on public.penerimaan_cetak_log (unit_id, penerimaan_id);
create or replace trigger penerimaan_cetak_log_append_only before update or delete or truncate on public.penerimaan_cetak_log
  for each statement execute function app.tg_append_only();

-- ---------------------------------------------------------------------------
-- upload_sessions (server-side; clients use the upload_* RPCs)
-- ---------------------------------------------------------------------------
create table if not exists public.upload_sessions (
  id               uuid primary key default gen_random_uuid(),
  unit_id          uuid not null references public.units(id),
  request_id       uuid not null,
  owner_user_id    uuid not null,
  purpose          text not null,
  object_type      text not null,
  object_id        text not null,
  original_name    text,
  declared_mime    text,
  declared_size    bigint,
  drive_name       text not null,
  folder_path      text[] not null default '{}',
  known_folder_id  text,
  max_bytes        bigint not null,
  status           text not null default 'OPEN',
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null default now() + interval '24 hours',
  committed_at     timestamptz,
  consumed_at      timestamptz,
  cancelled_at     timestamptz,
  drive_file_id    text,
  drive_url        text,
  size_bytes       bigint,
  md5              text,
  mime             text,
  attested_at      bigint,
  result           jsonb,
  constraint upload_sessions_request_key unique (unit_id, request_id),
  constraint upload_sessions_purpose_check check (purpose in ('ITEM_PDF', 'RECEIPT_EVIDENCE', 'RECEIPT_CANCEL_EVIDENCE')),
  constraint upload_sessions_status_check check (status in ('OPEN', 'COMMITTED', 'CANCELLED', 'EXPIRED', 'SUPERSEDED'))
);
-- one active session per object and purpose
create unique index if not exists upload_sessions_one_open on public.upload_sessions (unit_id, purpose, object_id)
  where status = 'OPEN';
create index if not exists upload_sessions_drive_file_idx on public.upload_sessions (drive_file_id) where drive_file_id is not null;
create or replace trigger upload_sessions_no_hard_delete before delete or truncate on public.upload_sessions
  for each statement execute function app.tg_forbid_hard_delete();

-- ---------------------------------------------------------------------------
-- drive_tasks: Drive renames to perform after a commit (numbering changes)
-- ---------------------------------------------------------------------------
create table if not exists public.drive_tasks (
  id                 uuid primary key default gen_random_uuid(),
  unit_id            uuid not null references public.units(id),
  kind               text not null,
  drive_id           text not null,
  new_name           text not null,
  object_type        text not null,
  object_id          text not null,
  status             text not null default 'PENDING',
  attempts           integer not null default 0,
  last_error         text,
  source_request_id  text,
  created_at         timestamptz not null default now(),
  completed_at       timestamptz,
  constraint drive_tasks_kind_check check (kind in ('RENAME_FOLDER', 'RENAME_FILE')),
  constraint drive_tasks_status_check check (status in ('PENDING', 'DONE', 'FAILED', 'SUPERSEDED'))
);
create index if not exists drive_tasks_pending_idx on public.drive_tasks (unit_id, created_at) where status = 'PENDING';
create or replace trigger drive_tasks_no_hard_delete before delete or truncate on public.drive_tasks
  for each statement execute function app.tg_forbid_hard_delete();

-- Queue one rename; an older pending rename of the same Drive object is superseded.
create or replace function app.queue_rename(p_unit_id uuid, p_kind text, p_drive_id text, p_new_name text,
                                            p_object_type text, p_object_id text, p_request_id text)
returns uuid
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if nullif(pg_catalog.btrim(coalesce(p_drive_id, '')), '') is null then return null; end if;
  update public.drive_tasks set status = 'SUPERSEDED', completed_at = now()
   where unit_id = p_unit_id and drive_id = p_drive_id and status = 'PENDING';
  insert into public.drive_tasks (unit_id, kind, drive_id, new_name, object_type, object_id, source_request_id)
  values (p_unit_id, p_kind, pg_catalog.btrim(p_drive_id), p_new_name, p_object_type, p_object_id, p_request_id)
  returning id into v_id;
  return v_id;
end
$$;

-- ---------------------------------------------------------------------------
-- RLS + privileges for the new tables
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['jenis_naskah', 'penerimaan_cetak_log', 'upload_sessions', 'drive_tasks'] loop
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('grant select, insert, update on table public.%I to service_role', t);
  end loop;
  foreach t in array array['jenis_naskah', 'penerimaan_cetak_log'] loop
    execute format('grant select on table public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using ('
      || '(select app.current_role()) = ''ADMIN_PUSAT'' or unit_id = (select app.current_unit_id()))',
      t || '_select', t);
  end loop;
end
$$;

insert into public.schema_migrations_log (version, name)
values ('0010', 's2_foundation') on conflict (version) do nothing;
