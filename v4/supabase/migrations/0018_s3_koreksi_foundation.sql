-- 0018_s3_koreksi_foundation.sql
-- Sprint 3 foundation for Edit/Perubahan and Koreksi & Pembatalan (see v4/supabase/API_S3.md):
--   * public.karantina          (SYSTEM_QUARANTINE): old Drive files/folders bound to reason + action
--   * public.pembatalan_arsip   (new): one row per cancellation (reason, evidence, items, released sources)
--   * item.file_replaced_at     + app.invalidate_file_derivatives (hook for Sprint 6 content index)
--   * app.assert_not_borrowed   the ONE loan guard (status columns now; Sprint 4 re-points it to the loan table)
--   * app.quarantine_add, app.release_receipt_sources (releaseReceiptItemsAfterDeletion_)
--   * upload purposes ITEM_PDF_REPLACE and DELETION_EVIDENCE (upload_begin/commit/cancel/register_folder)
--   * drive_id_in_use / resolve_file_access know quarantined files and cancellation evidence
-- Re-runnable; no BEGIN/COMMIT. 0010–0015 are reused, not duplicated (renumbering stays app.renumber_unit).

-- ---------------------------------------------------------------------------
-- karantina  (SYSTEM_QUARANTINE)
-- ---------------------------------------------------------------------------
create table if not exists public.karantina (
  id                    text primary key,               -- QUARANTINE_ID (QRT-…)
  unit_id               uuid not null references public.units(id),
  occurred_at           timestamptz not null default now(), -- TIMESTAMP
  user_email            text,                           -- USER_EMAIL
  object_type           text not null,                  -- OBJECT_TYPE (FILE | FOLDER)
  object_id             text not null,                  -- OBJECT_ID (Drive id)
  original_name         text,                           -- ORIGINAL_NAME
  original_url          text,                           -- ORIGINAL_URL
  original_parent_ids   text,                           -- ORIGINAL_PARENT_IDS (comma separated)
  quarantine_folder_id  text,                           -- QUARANTINE_FOLDER_ID (NULL: not moved in Drive, see API_S3 §6)
  quarantine_url        text,                           -- QUARANTINE_URL
  module                text,                           -- MODULE (EDIT_ARSIP | PENGHAPUSAN_ITEM | PENGHAPUSAN_BERKAS)
  reason                text,                           -- REASON
  status                text not null default 'QUARANTINED', -- STATUS (QUARANTINED | FAILED)
  notes                 text,                           -- NOTES
  -- new in v4: what the object belonged to and which action quarantined it
  actor_user_id         uuid,
  related_object_type   text,                           -- ITEM | BERKAS
  related_object_id     text,
  berkas_id             text,
  mime_type             text,
  size_bytes            bigint,
  md5                   text,
  app_owned             boolean,                        -- created by the app (gateway may write it)
  request_id            text,
  pembatalan_id         text,
  created_at            timestamptz not null default now(),
  constraint karantina_unit_id_key unique (unit_id, id),
  constraint karantina_object_type_check check (object_type in ('FILE', 'FOLDER')),
  constraint karantina_status_check check (status in ('QUARANTINED', 'FAILED')),
  constraint karantina_related_type_check check (related_object_type is null or related_object_type in ('ITEM', 'BERKAS'))
);
create index if not exists karantina_object_idx on public.karantina (object_id);
create index if not exists karantina_unit_time_idx on public.karantina (unit_id, occurred_at desc);
create index if not exists karantina_related_idx on public.karantina (unit_id, related_object_id);
create or replace trigger karantina_no_hard_delete before delete or truncate on public.karantina
  for each statement execute function app.tg_forbid_hard_delete();

-- ---------------------------------------------------------------------------
-- pembatalan_arsip: the cancellation record (3.x kept it only in AUDIT_LOG + CATATAN)
-- ---------------------------------------------------------------------------
create table if not exists public.pembatalan_arsip (
  id                         text primary key,          -- BTL-…
  unit_id                    uuid not null references public.units(id),
  scope                      text not null,             -- ITEM | BERKAS
  berkas_id                  text not null,
  item_id                    text,                      -- scope ITEM
  item_ids                   text[] not null default '{}', -- every item cancelled by this action
  no_berkas_snapshot         integer,
  no_item_snapshot           integer,
  judul_berkas_snapshot      text,
  uraian_item_snapshot       text,
  alasan                     text not null,
  bukti_file_id              text,
  bukti_url                  text,
  bukti_nama                 text,
  bukti_mime                 text,
  bukti_size_bytes           bigint,
  bukti_md5                  text,
  released_receipt_item_ids  text[] not null default '{}',
  quarantine_ids             text[] not null default '{}',
  request_id                 text not null,
  actor_user_id              uuid,
  created_by                 text,
  created_at                 timestamptz not null default now(),
  constraint pembatalan_arsip_unit_id_key unique (unit_id, id),
  constraint pembatalan_arsip_berkas_fk foreign key (unit_id, berkas_id)
    references public.berkas (unit_id, id) deferrable initially deferred,
  constraint pembatalan_arsip_scope_check check (scope in ('ITEM', 'BERKAS')),
  constraint pembatalan_arsip_item_check check ((scope = 'ITEM') = (item_id is not null))
);
create index if not exists pembatalan_arsip_berkas_idx on public.pembatalan_arsip (unit_id, berkas_id);
create index if not exists pembatalan_arsip_bukti_idx on public.pembatalan_arsip (bukti_file_id) where bukti_file_id is not null;
create or replace trigger pembatalan_arsip_append_only before update or delete or truncate on public.pembatalan_arsip
  for each statement execute function app.tg_append_only();

-- RLS: admins of the unit and ADMIN_PUSAT only (like audit_log). Server writes via SECURITY DEFINER RPCs.
do $$
declare
  t text;
begin
  foreach t in array array['karantina', 'pembatalan_arsip'] loop
    execute format('revoke all on table public.%I from public, anon, authenticated, service_role', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('grant select, insert, update on table public.%I to service_role', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using ('
      || '(select app.current_role()) = ''ADMIN_PUSAT'' '
      || 'or ((select app.current_role()) = ''ADMIN_UNIT'' and unit_id = (select app.current_unit_id())))',
      t || '_select', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- New columns
-- ---------------------------------------------------------------------------
alter table public.item add column if not exists file_replaced_at timestamptz;
comment on column public.item.file_replaced_at is
  'Last PDF replacement (Edit). Anything derived from an earlier PDF is stale; the old file is in public.karantina.';

-- upload purposes for Sprint 3
alter table public.upload_sessions drop constraint if exists upload_sessions_purpose_check;
alter table public.upload_sessions add constraint upload_sessions_purpose_check check (purpose in
  ('ITEM_PDF', 'RECEIPT_EVIDENCE', 'RECEIPT_CANCEL_EVIDENCE', 'ITEM_PDF_REPLACE', 'DELETION_EVIDENCE'));

-- ---------------------------------------------------------------------------
-- app.assert_not_borrowed — THE loan guard (assertItemAvailableForEdit_,
-- assertBerkasAvailableForEdit_, assertNotBorrowedForDeletion_).
-- Sprint 3: STATUS_PEMINJAMAN on berkas/item. Sprint 4 re-points this one
-- function to the loan table (active loan on the berkas or one of the items);
-- every caller (upload_begin/commit, item_update, berkas_update_title,
-- archive_cancel) goes through it.
--   p_item_ids: the items whose own loan status matters (edit: the item;
--   cancel item: the item; cancel berkas: all its active items; title: none).
--   p_action: 'EDIT' | 'HAPUS' (message wording only).
-- ---------------------------------------------------------------------------
create or replace function app.assert_not_borrowed(p_unit_id uuid, p_berkas_id text, p_item_ids text[], p_action text)
returns void
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_berkas text;
  v_item record;
  v_verb text := case when p_action = 'HAPUS' then 'menghapus' else 'mengedit' end;
begin
  select pg_catalog.upper(coalesce(nullif(pg_catalog.btrim(status_peminjaman), ''), 'TERSEDIA')) into v_berkas
    from public.berkas where unit_id = p_unit_id and id = p_berkas_id;
  select i.id, i.no_item_definitif into v_item from public.item i
   where i.unit_id = p_unit_id and i.id = any (coalesce(p_item_ids, '{}'))
     and pg_catalog.upper(coalesce(nullif(pg_catalog.btrim(i.status_peminjaman), ''), 'TERSEDIA')) <> 'TERSEDIA'
   order by i.no_item_definitif nulls last, i.id limit 1;
  if p_action = 'EDIT' and (coalesce(v_berkas, 'TERSEDIA') <> 'TERSEDIA' or v_item.id is not null) then
    perform app.fail('OBJECT_BORROWED',
      case when pg_catalog.cardinality(coalesce(p_item_ids, '{}')) = 0
           then 'Berkas sedang dipinjam. Selesaikan transaksi peminjaman sebelum mengedit.'
           else 'Berkas atau item sedang dipinjam. Selesaikan transaksi peminjaman sebelum mengedit.' end,
      pg_catalog.jsonb_build_object('berkas_id', p_berkas_id, 'item_id', v_item.id));
  end if;
  if coalesce(v_berkas, 'TERSEDIA') <> 'TERSEDIA' then
    perform app.fail('OBJECT_BORROWED', 'Berkas sedang dipinjam. Selesaikan transaksi peminjaman sebelum ' || v_verb || '.',
      pg_catalog.jsonb_build_object('berkas_id', p_berkas_id));
  end if;
  if v_item.id is not null then
    perform app.fail('OBJECT_BORROWED', 'Item ' || coalesce(v_item.no_item_definitif::text, v_item.id) ||
      ' sedang dipinjam. Selesaikan transaksi peminjaman sebelum ' || v_verb || '.',
      pg_catalog.jsonb_build_object('berkas_id', p_berkas_id, 'item_id', v_item.id));
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Quarantine record (quarantineDriveObject_, DB side). The Drive object is
-- not moved here (the DB cannot call Drive, and legacy objects are not
-- writable by the gateway); the binding makes it admin-only (resolve_file_access).
-- ---------------------------------------------------------------------------
create or replace function app.quarantine_add(
  a app.actor, p_object_type text, p_object_id text, p_name text, p_url text, p_mime text, p_size bigint, p_md5 text,
  p_module text, p_reason text, p_notes text, p_related_type text, p_related_id text, p_berkas_id text,
  p_request_id text, p_pembatalan_id text)
returns text
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_id text := 'QRT-' || gen_random_uuid();
begin
  insert into public.karantina (id, unit_id, occurred_at, user_email, object_type, object_id, original_name, original_url,
    module, reason, status, notes, actor_user_id, related_object_type, related_object_id, berkas_id, mime_type, size_bytes,
    md5, app_owned, request_id, pembatalan_id)
  values (v_id, a.unit_id, now(), a.email, p_object_type, pg_catalog.btrim(p_object_id), nullif(p_name, ''), nullif(p_url, ''),
    p_module, pg_catalog.left(coalesce(p_reason, ''), 2000), 'QUARANTINED', p_notes, a.user_id, p_related_type, p_related_id,
    p_berkas_id, nullif(p_mime, ''), p_size, nullif(p_md5, ''), app.is_app_drive_object(pg_catalog.btrim(p_object_id)),
    p_request_id, p_pembatalan_id);
  return v_id;
end
$$;

-- ---------------------------------------------------------------------------
-- Derived data of a Drive file that is no longer the item's current file.
--   * pending Drive renames of that object are superseded (no more renames of a quarantined object);
--   * Sprint 6 hook: content-search rows built from that PDF become STALE.
--     3.x (ContentDocumentService) keys the index by SOURCE_PDF_ID and reports
--     STALE when it differs from DB_ITEM.DRIVE_FILE_ID. The table does not exist
--     yet; when Sprint 6 creates public.content_documents(unit_id, item_id,
--     source_pdf_id, status) this hook marks matching rows STALE automatically.
--     Until then it reports content_index = 'NOT_INSTALLED'.
-- ---------------------------------------------------------------------------
create or replace function app.invalidate_file_derivatives(p_unit_id uuid, p_item_id text, p_old_drive_id text, p_request_id text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_tasks integer := 0;
  v_stale integer;
  v_status text := 'NOT_INSTALLED';
begin
  if nullif(pg_catalog.btrim(coalesce(p_old_drive_id, '')), '') is null then
    return pg_catalog.jsonb_build_object('superseded_drive_tasks', 0, 'content_index', 'NONE');
  end if;
  update public.drive_tasks set status = 'SUPERSEDED', completed_at = now(),
         last_error = 'Objek dikarantina (' || coalesce(p_request_id, '') || ')'
   where unit_id = p_unit_id and drive_id = pg_catalog.btrim(p_old_drive_id) and status = 'PENDING';
  get diagnostics v_tasks = row_count;
  if p_item_id is not null and pg_catalog.to_regclass('public.content_documents') is not null
     and (select pg_catalog.count(*) from pg_catalog.pg_attribute
           where attrelid = 'public.content_documents'::regclass and not attisdropped
             and attname in ('unit_id', 'item_id', 'source_pdf_id', 'status')) = 4 then
    execute 'update public.content_documents set status = ''STALE'' where unit_id = $1 and item_id = $2 '
            'and source_pdf_id = $3 and status is distinct from ''STALE'''
      using p_unit_id, p_item_id, pg_catalog.btrim(p_old_drive_id);
    get diagnostics v_stale = row_count;
    v_status := 'MARKED';
  end if;
  return pg_catalog.jsonb_build_object('superseded_drive_tasks', v_tasks, 'content_index', v_status,
                                       'content_documents_stale', v_stale);
end
$$;

-- ---------------------------------------------------------------------------
-- releaseReceiptItemsAfterDeletion_: receipt lines of cancelled items return
-- to the filing queue (BELUM DIBERKASKAN, or PERLU DILENGKAPI when incomplete).
-- Returns the released receipt line ids.
-- ---------------------------------------------------------------------------
create or replace function app.release_receipt_sources(a app.actor, p_item_ids text[])
returns text[]
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_ids text[];
begin
  with src as (
    select pi.id
    from public.item i
    join public.penerimaan_item pi on pi.unit_id = i.unit_id and pi.id = i.penerimaan_item_id
    where i.unit_id = a.unit_id and i.id = any (coalesce(p_item_ids, '{}'))
      and nullif(pg_catalog.btrim(i.penerimaan_item_id), '') is not null and not pi.is_deleted
      and (pi.item_id_definitif is null or pi.item_id_definitif = i.id)
  ), upd as (
    update public.penerimaan_item pi set
      status_pemberkasan = case when app.receipt_item_complete(pi.arsip_id, pi.tanggal_naskah, pi.uraian_informasi, pi.jumlah_halaman,
                                       pi.tingkat_perkembangan, pi.kondisi, pi.klasifikasi_keamanan_akses)
                                then 'BELUM DIBERKASKAN' else 'PERLU DILENGKAPI' end,
      berkas_id_tujuan = null, item_id_definitif = null, no_berkas_definitif_snapshot = null,
      no_item_definitif_snapshot = null, diberkaskan_at = null, diberkaskan_by = null, pemberkasan_request_id = null,
      updated_at = now(), updated_by = a.email
    from src where pi.unit_id = a.unit_id and pi.id = src.id
    returning pi.id
  )
  select coalesce(pg_catalog.array_agg(id order by id), '{}') into v_ids from upd;
  return v_ids;
end
$$;

-- appendDeletionNote_
create or replace function app.deletion_note(p_existing text, p_reason text)
returns text
language sql stable
set search_path = ''
as $$
  select app.clean_text(case when app.clean_text(p_existing, 1000) <> ''
                             then app.clean_text(p_existing, 1000) || ' | ' else '' end
                        || '[DIHAPUS ' || app.jakarta_iso(now()) || '] ' || app.clean_text(p_reason, 1000), 2000)
$$;

-- ---------------------------------------------------------------------------
-- Drive ids already bound anywhere: also quarantined objects and cancellation
-- evidence, so a quarantined (admin-only) file can never be re-attached to an
-- active record and become readable by every role again.
-- ---------------------------------------------------------------------------
create or replace function app.drive_id_in_use(p_drive_id text, p_except_session uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.item where pg_catalog.btrim(drive_file_id) = p_drive_id)
      or exists (select 1 from public.penerimaan where pg_catalog.btrim(bukti_ttd_file_id) = p_drive_id or pg_catalog.btrim(batal_bukti_file_id) = p_drive_id)
      or exists (select 1 from public.penerimaan_item where pg_catalog.btrim(file_digital_id) = p_drive_id)
      or exists (select 1 from public.berkas where pg_catalog.btrim(bukti_pemindahan_file_id) = p_drive_id
                                              or pg_catalog.btrim(drive_folder_id) = p_drive_id
                                              or pg_catalog.btrim(v4_drive_folder_id) = p_drive_id)
      or exists (select 1 from public.karantina where object_id = p_drive_id)
      or exists (select 1 from public.pembatalan_arsip where bukti_file_id = p_drive_id)
      or exists (select 1 from public.upload_sessions where drive_file_id = p_drive_id and status = 'COMMITTED'
                   and id is distinct from p_except_session)
$$;

-- ---------------------------------------------------------------------------
-- File access (0008) + quarantined files + cancellation evidence. Both new
-- kinds are admin-only (ADMIN_PUSAT, ADMIN_UNIT of the unit), as the 3.x
-- "90 KARANTINA APLIKASI" folder. Under SECURITY INVOKER (get_file_access) the
-- RLS of karantina / pembatalan_arsip gives the same answer.
-- ---------------------------------------------------------------------------
create or replace function app.resolve_file_access(p_drive_file_id text)
returns jsonb
language sql stable
set search_path = ''
as $$
  with me as (
    select app.current_role() as role, app.current_unit_id() as unit_id
  ),
  scope as (
    select role, unit_id,
           role in ('ADMIN_PUSAT', 'ADMIN_UNIT') as is_admin,
           role in ('ADMIN_PUSAT', 'ADMIN_UNIT', 'PETUGAS') as is_ops
    from me where role is not null
  ),
  wanted as (
    select pg_catalog.btrim(p_drive_file_id) as fid
    where nullif(pg_catalog.btrim(coalesce(p_drive_file_id, '')), '') is not null
  ),
  candidates as (
    select 1 as prio, 'ITEM'::text as object_type, i.id as object_id, i.unit_id,
           coalesce(nullif(pg_catalog.btrim(i.nama_file), ''),
                    'Berkas_' || coalesce(b.no_berkas_definitif::text, '-') || '_Item_' || coalesce(i.no_item_definitif::text, '-') || '.pdf') as file_name,
           coalesce(nullif(pg_catalog.btrim(i.mime_type), ''), 'application/pdf') as mime,
           i.drive_file_size_bytes as size,
           (i.is_deleted or b.is_deleted or b.status_berkas in ('DIHAPUS', 'GAGAL')) as quarantined,
           false as ops_only
    from public.item i
    join public.berkas b on b.unit_id = i.unit_id and b.id = i.berkas_id
    join wanted w on pg_catalog.btrim(i.drive_file_id) = w.fid
    union all
    select 2, 'PENERIMAAN', p.id, p.unit_id,
           coalesce(nullif(pg_catalog.btrim(p.bukti_ttd_nama), ''), 'Tanda_terima_' || p.nomor_tanda_terima || '.pdf'),
           'application/pdf', null::bigint, false, true
    from public.penerimaan p join wanted w on pg_catalog.btrim(p.bukti_ttd_file_id) = w.fid
    union all
    select 3, 'PENERIMAAN', p.id, p.unit_id,
           coalesce(nullif(pg_catalog.btrim(p.batal_bukti_nama), ''), 'Bukti_batal_' || p.nomor_tanda_terima || '.pdf'),
           'application/pdf', null::bigint, false, true
    from public.penerimaan p join wanted w on pg_catalog.btrim(p.batal_bukti_file_id) = w.fid
    union all
    select 4, 'PENERIMAAN_ITEM', pi.id, pi.unit_id,
           'Penerimaan_' || pi.penerimaan_id || '_item_' || coalesce(pi.no_item::text, '-') || '.pdf',
           coalesce(nullif(pg_catalog.btrim(pi.file_digital_mime_type), ''), 'application/pdf'),
           pi.file_digital_size_bytes, pi.is_deleted, true
    from public.penerimaan_item pi join wanted w on pg_catalog.btrim(pi.file_digital_id) = w.fid
    union all
    select 5, 'BERKAS', b.id, b.unit_id,
           'Bukti_pemindahan_berkas_' || coalesce(b.no_berkas_definitif::text, b.id) || '.pdf',
           'application/pdf', null::bigint,
           (b.is_deleted or b.status_berkas in ('DIHAPUS', 'GAGAL')), true
    from public.berkas b join wanted w on pg_catalog.btrim(b.bukti_pemindahan_file_id) = w.fid
    union all
    -- 0018: quarantined files (e.g. the PDF before a replacement), admin only
    select 6, 'KARANTINA', q.id, q.unit_id,
           coalesce(nullif(pg_catalog.btrim(q.original_name), ''), 'Karantina_' || q.id || '.pdf'),
           coalesce(nullif(pg_catalog.btrim(q.mime_type), ''), 'application/pdf'), q.size_bytes, true, false
    from public.karantina q join wanted w on q.object_id = w.fid
    where q.object_type = 'FILE'
    union all
    -- 0018: cancellation evidence, admin only
    select 7, 'PEMBATALAN', p.id, p.unit_id,
           coalesce(nullif(pg_catalog.btrim(p.bukti_nama), ''), 'Bukti_pembatalan_' || p.id),
           coalesce(nullif(pg_catalog.btrim(p.bukti_mime), ''), 'application/pdf'), p.bukti_size_bytes, true, false
    from public.pembatalan_arsip p join wanted w on p.bukti_file_id = w.fid
  )
  select pg_catalog.jsonb_build_object(
           'file_name', c.file_name,
           'mime', c.mime,
           'size', c.size,
           'object_type', c.object_type,
           'object_id', c.object_id,
           'unit_id', c.unit_id)
  from candidates c
  cross join scope s
  where (s.role = 'ADMIN_PUSAT' or c.unit_id = s.unit_id)
    and (not c.quarantined or s.is_admin)
    and (not c.ops_only or s.is_ops)
  order by c.prio, c.object_id
  limit 1
$$;

-- ---------------------------------------------------------------------------
-- upload_begin: + ITEM_PDF_REPLACE (Edit, PDF pengganti) and DELETION_EVIDENCE
-- (bukti disposisi). Loan rules through app.assert_not_borrowed.
-- ---------------------------------------------------------------------------
create or replace function public.upload_begin(p_request_id uuid, p_purpose text, p_object_id text, p_file_name text,
                                               p_mime text, p_size bigint, p_unit_id uuid default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_purpose text := pg_catalog.upper(app.clean_text(p_purpose, 40));
  v_object text := app.clean_text(p_object_id, 90);
  v_name text := app.clean_text(p_file_name, 250);
  v_mime text := pg_catalog.lower(app.clean_text(p_mime, 100));
  v_ext text;
  v_unit uuid;
  a app.actor;
  i public.item;
  b public.berkas;
  r public.penerimaan;
  s public.upload_sessions;
  v_drive_name text;
  v_folder text[];
  v_known text;
  v_max bigint;
  v_object_type text;
  v_active text[];
begin
  if v_purpose not in ('ITEM_PDF', 'ITEM_PDF_REPLACE', 'RECEIPT_EVIDENCE', 'RECEIPT_CANCEL_EVIDENCE', 'DELETION_EVIDENCE') then
    perform app.actor_base(true);
    perform app.fail('INVALID_INPUT', 'Jenis unggahan tidak dikenal.', '{"field":"p_purpose"}');
  end if;
  if v_purpose in ('ITEM_PDF', 'ITEM_PDF_REPLACE') then
    select * into i from public.item where id = v_object;
    v_unit := i.unit_id;
    v_object_type := 'ITEM';
  elsif v_purpose = 'DELETION_EVIDENCE' then
    -- the evidence belongs to the object being cancelled: an item (scope ITEM) or a berkas (scope BERKAS)
    select * into i from public.item where id = v_object;
    if found then
      v_unit := i.unit_id;
      v_object_type := 'ITEM';
    else
      select * into b from public.berkas where id = v_object;
      v_unit := b.unit_id;
      v_object_type := 'BERKAS';
    end if;
  else
    select * into r from public.penerimaan where id = v_object;
    v_unit := r.unit_id;
    v_object_type := 'PENERIMAAN';
  end if;
  if p_unit_id is not null and v_unit is distinct from p_unit_id then v_unit := null; end if;
  a := app.require_actor_object(v_unit, case v_object_type when 'ITEM' then 'Item arsip' when 'BERKAS' then 'Berkas' else 'Tanda terima' end, true);
  if p_request_id is null then perform app.fail('INVALID_INPUT', 'ID permintaan wajib diisi.', '{"field":"p_request_id"}'); end if;
  perform app.lock_unit(a.unit_id);

  -- same request -> same session
  select * into s from public.upload_sessions where unit_id = a.unit_id and request_id = p_request_id;
  if found then
    if s.owner_user_id <> a.user_id or s.purpose <> v_purpose or s.object_id <> v_object
       or s.declared_size is distinct from p_size or coalesce(s.original_name, '') <> v_name then
      perform app.fail('IDEMPOTENCY_CONFLICT', 'ID permintaan unggah ini sudah dipakai untuk file lain. Mulai ulang unggah.');
    end if;
    return pg_catalog.jsonb_build_object('session_id', s.id, 'unit_id', s.unit_id, 'unit_code', a.unit_code,
      'folder_path', pg_catalog.to_jsonb(s.folder_path), 'drive_name', s.drive_name,
      'known_folder_id', case when app.is_app_drive_object(s.known_folder_id)
                                or s.known_folder_id = app.setting_text(a.unit_id, 'V4_RECEIPT_PROOF_FOLDER_ID')
                                or s.known_folder_id = app.setting_text(a.unit_id, 'V4_DELETION_EVIDENCE_FOLDER_ID') then s.known_folder_id end,
      'root_folder_id', app.setting_text(a.unit_id, 'V4_ROOT_FOLDER_ID'), 'max_bytes', s.max_bytes,
      'expires_at', s.expires_at, 'status', s.status, 'replayed', true);
  end if;

  -- object rules
  if v_purpose in ('ITEM_PDF', 'ITEM_PDF_REPLACE') then
    select * into b from public.berkas where unit_id = a.unit_id and id = i.berkas_id;
    if i.is_deleted or b.id is null or b.is_deleted then
      perform app.fail('NOT_FOUND', 'Item arsip tidak ditemukan atau sudah dihapus.');
    end if;
    if v_purpose = 'ITEM_PDF' and nullif(pg_catalog.btrim(i.drive_file_id), '') is not null then
      perform app.fail('ITEM_HAS_FILE', 'Item ini sudah memiliki PDF. Gunakan menu Edit Arsip untuk mengganti file.');
    end if;
    perform app.assert_not_borrowed(a.unit_id, b.id, array[i.id], 'EDIT');
    v_max := 104857599;  -- < 100 MB
    v_drive_name := app.item_drive_name(i, b.no_berkas_definitif);
    v_folder := array[coalesce(b.no_berkas_definitif::text, 'DRAFT') || '_' || app.clean_file_name(b.judul_berkas)];
    v_known := nullif(pg_catalog.btrim(b.v4_drive_folder_id), '');
  elsif v_purpose = 'DELETION_EVIDENCE' then
    -- validateDeletionUploadRequest_ -> resolveDeletionContext_ (object part; reason/confirmation via archive_cancel(p_validate_only))
    if v_object_type = 'ITEM' then
      select * into b from public.berkas where unit_id = a.unit_id and id = i.berkas_id;
      if i.is_deleted or b.id is null or b.is_deleted then
        perform app.fail('NOT_FOUND', 'Item tidak ditemukan atau sudah dihapus.');
      end if;
      perform app.assert_not_borrowed(a.unit_id, b.id, array[i.id], 'HAPUS');
      if (select pg_catalog.count(*) from public.item x where x.unit_id = a.unit_id and x.berkas_id = b.id and not x.is_deleted) <= 1 then
        perform app.fail('LAST_ITEM_IN_BERKAS', 'Item ini adalah item terakhir. Gunakan pilihan Hapus seluruh berkas agar database tetap konsisten.');
      end if;
    else
      if b.is_deleted then perform app.fail('NOT_FOUND', 'Berkas tidak ditemukan atau sudah dihapus.'); end if;
      select coalesce(pg_catalog.array_agg(x.id), '{}') into v_active from public.item x
       where x.unit_id = a.unit_id and x.berkas_id = b.id and not x.is_deleted;
      perform app.assert_not_borrowed(a.unit_id, b.id, v_active, 'HAPUS');
    end if;
    v_max := 26214400;   -- 25 MB (inclusive, DELETION_EVIDENCE_UPLOAD_MAX_SIZE_)
    v_ext := pg_catalog.lower(coalesce(pg_catalog.substring(v_name, '\.([^.]+)$'), ''));
    -- saveDeletionEvidence_: <yyyyMMdd-HHmmss>_<SCOPE>_<no berkas>[-<no item>]_<judul/uraian>.<ext>
    v_drive_name := pg_catalog.to_char(now() at time zone 'Asia/Jakarta', 'YYYYMMDD-HH24MISS') || '_' || v_object_type || '_' ||
      coalesce(b.no_berkas_definitif::text, 'DRAFT') ||
      case when v_object_type = 'ITEM' then '-' || coalesce(i.no_item_definitif::text, 'ITEM') else '' end || '_' ||
      app.clean_file_name(case when v_object_type = 'ITEM' then i.uraian_lengkap else b.judul_berkas end) || '.' || v_ext;
    v_folder := array['BUKTI PENGHAPUSAN'];
    v_known := app.setting_text(a.unit_id, 'V4_DELETION_EVIDENCE_FOLDER_ID');
  else
    if v_purpose = 'RECEIPT_EVIDENCE' and (coalesce(r.bukti_ttd_file_id, '') <> '' or coalesce(r.bukti_ttd_url, '') <> '') then
      perform app.fail('EVIDENCE_EXISTS', 'Bukti tertandatangani sudah tersimpan.');
    end if;
    if v_purpose = 'RECEIPT_CANCEL_EVIDENCE' and pg_catalog.upper(coalesce(r.status, '')) <> 'AKTIF' then
      perform app.fail('RECEIPT_CANCELLED', 'Tanda terima sudah dibatalkan.');
    end if;
    v_max := 10485760;   -- 10 MB
    v_drive_name := app.clean_file_name(coalesce(nullif(r.nomor_tanda_terima, ''), 'Tanda-Terima')) ||
      case when v_purpose = 'RECEIPT_EVIDENCE' then '_Tanda-Terima-Tertandatangani.pdf' else '_Bukti-Pembatalan.pdf' end;
    v_folder := array['BUKTI PENERIMAAN ARSIP'];
    v_known := app.setting_text(a.unit_id, 'V4_RECEIPT_PROOF_FOLDER_ID');
  end if;

  -- file rules (validateMediaUploadRequest_ / validateEditUploadRequest_ / validateDeletionUploadRequest_ / validateReceiptEvidenceFile_)
  if v_name = '' then perform app.fail('INVALID_INPUT', 'Nama file wajib diisi.', '{"field":"p_file_name"}'); end if;
  if v_purpose = 'DELETION_EVIDENCE' then
    if v_ext not in ('pdf', 'jpg', 'jpeg', 'png')
       or v_mime not in ('application/pdf', 'image/jpeg', 'image/png', 'application/octet-stream', '') then
      perform app.fail('FILE_TYPE', 'Bukti disposisi harus PDF, JPG, JPEG, atau PNG.');
    end if;
  elsif pg_catalog.lower(v_name) !~ '\.pdf$' or v_mime not in ('application/pdf', 'application/octet-stream', '') then
    perform app.fail('FILE_TYPE', case v_purpose when 'ITEM_PDF' then 'File alih media harus PDF.'
                                                 when 'ITEM_PDF_REPLACE' then 'File alih media pengganti harus PDF.'
                                                 else 'Bukti penerimaan harus berformat PDF.' end);
  end if;
  if p_size is null or p_size < 1 then
    perform app.fail('INVALID_INPUT', 'Ukuran file tidak valid.', '{"field":"p_size"}');
  end if;
  if p_size > v_max then
    perform app.fail('FILE_TOO_LARGE', case v_purpose when 'ITEM_PDF' then 'Ukuran PDF harus kurang dari 100 MB.'
                                                      when 'ITEM_PDF_REPLACE' then 'Ukuran PDF pengganti harus kurang dari 100 MB.'
                                                      when 'DELETION_EVIDENCE' then 'Ukuran bukti disposisi maksimal 25 MB.'
                                                      else 'Ukuran bukti penerimaan maksimal 10 MB.' end);
  end if;

  -- one active session per object and purpose
  update public.upload_sessions set status = 'EXPIRED'
   where unit_id = a.unit_id and purpose = v_purpose and object_id = v_object and status = 'OPEN' and expires_at < now();
  select * into s from public.upload_sessions
   where unit_id = a.unit_id and purpose = v_purpose and object_id = v_object and status = 'OPEN' for update;
  if found then
    if s.owner_user_id <> a.user_id then
      perform app.fail('UPLOAD_SESSION_ACTIVE', 'File untuk data ini sedang diunggah oleh pengguna lain. Coba lagi nanti.');
    end if;
    update public.upload_sessions set status = 'SUPERSEDED', cancelled_at = now() where id = s.id;
  end if;

  insert into public.upload_sessions (unit_id, request_id, owner_user_id, purpose, object_type, object_id, original_name,
    declared_mime, declared_size, drive_name, folder_path, known_folder_id, max_bytes)
  values (a.unit_id, p_request_id, a.user_id, v_purpose, v_object_type, v_object, v_name, nullif(v_mime, ''), p_size,
    v_drive_name, v_folder, v_known, v_max)
  returning * into s;
  perform app.audit(a, 'UPLOAD_START',
    case v_purpose when 'ITEM_PDF' then 'ALIH_MEDIA' when 'ITEM_PDF_REPLACE' then 'EDIT_ARSIP'
                   when 'DELETION_EVIDENCE' then 'PENGHAPUSAN' else 'PENERIMAAN_ARSIP' end,
    case v_purpose when 'ITEM_PDF' then 'ITEM' when 'ITEM_PDF_REPLACE' then 'PDF_PENGGANTI'
                   when 'DELETION_EVIDENCE' then 'BUKTI_DISPOSISI'
                   when 'RECEIPT_EVIDENCE' then 'BUKTI_TTD' else 'BUKTI_PEMBATALAN' end,
    v_object, 'Memulai unggah: ' || v_name, p_size || ' byte', p_request_id::text);
  return pg_catalog.jsonb_build_object('session_id', s.id, 'unit_id', s.unit_id, 'unit_code', a.unit_code,
    'folder_path', pg_catalog.to_jsonb(s.folder_path), 'drive_name', s.drive_name, 'known_folder_id', s.known_folder_id,
    'root_folder_id', app.setting_text(a.unit_id, 'V4_ROOT_FOLDER_ID'), 'max_bytes', s.max_bytes,
    'expires_at', s.expires_at, 'status', s.status, 'replayed', false);
end
$$;

-- ---------------------------------------------------------------------------
-- upload_commit: + ITEM_PDF_REPLACE / DELETION_EVIDENCE. Both only store the
-- attested file on the session; item_update / archive_cancel consume it inside
-- the business transaction (as 3.x finalize* called updateArchiveItem_/deleteArchive_).
-- ---------------------------------------------------------------------------
create or replace function public.upload_commit(p_session_id uuid, p_drive_file_id text, p_drive_url text, p_size bigint,
                                                p_md5 text, p_mime text, p_attested_at bigint, p_attestation text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  s public.upload_sessions;
  a app.actor;
  v_file text := pg_catalog.btrim(coalesce(p_drive_file_id, ''));
  v_mime text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_mime, '')));
  v_md5 text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_md5, '')));
  i public.item;
  b public.berkas;
  r public.penerimaan;
  v_name text;
  v_task uuid;
  v_tasks jsonb := '[]'::jsonb;
  v_res jsonb;
begin
  select * into s from public.upload_sessions where id = p_session_id for update;
  a := app.require_actor_object(s.unit_id, 'Sesi unggah', true);
  if s.owner_user_id <> a.user_id then perform app.fail('NOT_FOUND', 'Sesi unggah tidak ditemukan.'); end if;
  if v_file = '' or v_file !~ '^[A-Za-z0-9_-]{10,200}$' then
    perform app.fail('INVALID_INPUT', 'ID file Drive tidak valid.', '{"field":"p_drive_file_id"}');
  end if;
  -- canonical string uses the values exactly as passed (only trimmed)
  perform app.attestation_ok('CFUP1' || chr(10) || s.id || chr(10) || v_file || chr(10) || coalesce(p_size::text, '') || chr(10)
                             || pg_catalog.btrim(coalesce(p_md5, '')) || chr(10) || pg_catalog.btrim(coalesce(p_mime, '')) || chr(10)
                             || coalesce(p_attested_at::text, ''),
                             p_attested_at, p_attestation);
  perform app.lock_unit(a.unit_id);
  if s.status = 'COMMITTED' then
    if s.drive_file_id = v_file then return s.result || '{"replayed": true}'::jsonb; end if;
    perform app.fail('UPLOAD_SESSION_STATE', 'Sesi unggah ini sudah selesai dengan file lain.');
  end if;
  if s.status <> 'OPEN' then
    perform app.fail('UPLOAD_SESSION_STATE', 'Sesi unggah sudah dibatalkan atau diganti. Mulai ulang unggah.');
  end if;
  if s.expires_at < now() then
    perform app.fail('UPLOAD_SESSION_EXPIRED', 'Sesi unggah sudah kedaluwarsa. Mulai ulang unggah.');
  end if;
  if p_size is null or p_size < 1 or p_size > s.max_bytes then
    perform app.fail('FILE_TOO_LARGE', case s.purpose when 'ITEM_PDF' then 'Ukuran PDF harus kurang dari 100 MB.'
                                                      when 'ITEM_PDF_REPLACE' then 'Ukuran PDF pengganti harus kurang dari 100 MB.'
                                                      when 'DELETION_EVIDENCE' then 'Ukuran bukti disposisi maksimal 25 MB.'
                                                      else 'Ukuran bukti penerimaan maksimal 10 MB.' end);
  end if;
  if s.declared_size is not null and p_size <> s.declared_size then
    perform app.fail('UPLOAD_MISMATCH', 'Ukuran file berubah selama unggah. Pilih ulang file.');
  end if;
  if (s.purpose in ('ITEM_PDF', 'ITEM_PDF_REPLACE') and v_mime <> 'application/pdf')
     or (s.purpose in ('RECEIPT_EVIDENCE', 'RECEIPT_CANCEL_EVIDENCE') and v_mime not in ('application/pdf', 'application/octet-stream'))
     or (s.purpose = 'DELETION_EVIDENCE' and v_mime not in ('application/pdf', 'image/jpeg', 'image/png', 'application/octet-stream')) then
    perform app.fail('FILE_TYPE', case when s.purpose = 'DELETION_EVIDENCE' then 'Bukti disposisi harus PDF, JPG, JPEG, atau PNG.'
                                       else 'File hasil unggah bukan PDF.' end);
  end if;
  if app.drive_id_in_use(v_file, s.id) then
    perform app.fail('UPLOAD_FILE_IN_USE', 'File Drive ini sudah terhubung ke data lain.');
  end if;

  if s.purpose = 'ITEM_PDF' then
    select * into i from public.item where unit_id = s.unit_id and id = s.object_id for update;
    select * into b from public.berkas where unit_id = s.unit_id and id = i.berkas_id;
    if i.id is null or i.is_deleted or b.is_deleted then
      perform app.fail('NOT_FOUND', 'Item arsip tidak ditemukan atau sudah dihapus.');
    end if;
    if nullif(pg_catalog.btrim(i.drive_file_id), '') is not null then
      perform app.fail('ITEM_HAS_FILE', 'Item ini sudah memiliki PDF. Gunakan menu Edit Arsip bila ingin mengganti file.');
    end if;
    perform app.assert_not_borrowed(s.unit_id, b.id, array[i.id], 'EDIT');
    v_name := app.item_drive_name(i, b.no_berkas_definitif);
    update public.item set nama_file = v_name, drive_file_id = v_file, drive_file_url = nullif(app.clean_text(p_drive_url, 500), ''),
      mime_type = 'application/pdf', drive_file_size_bytes = p_size, drive_file_md5 = nullif(v_md5, ''), status_file = 'TERSEDIA',
      status_bentuk_digital = case when coalesce(status_bentuk_digital, 'TIDAK ADA') = 'TIDAK ADA' then 'ALIH MEDIA' else status_bentuk_digital end,
      updated_at = now(), updated_by = a.email, version = coalesce(version, 0) + 1
    where unit_id = s.unit_id and id = i.id;
    if v_name <> s.drive_name then
      v_task := app.queue_rename(s.unit_id, 'RENAME_FILE', v_file, v_name, 'ITEM', i.id, s.request_id::text);
      v_tasks := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id', v_task, 'kind', 'RENAME_FILE', 'drive_id', v_file, 'new_name', v_name));
    end if;
    perform app.audit(a, 'UPLOAD', 'ALIH_MEDIA', 'ITEM', i.id, 'Melengkapi PDF alih media item yang sudah tersimpan', v_name,
      s.request_id::text, null, pg_catalog.jsonb_build_object('drive_file_id', v_file, 'size', p_size, 'md5', v_md5));
    v_res := pg_catalog.jsonb_build_object('ok', true, 'session_id', s.id, 'purpose', s.purpose, 'object_id', i.id,
      'berkas_id', b.id, 'drive_file_id', v_file, 'file_name', v_name, 'drive_tasks', v_tasks,
      'message', 'PDF alih media berhasil dihubungkan ke item ' || coalesce(i.no_item_definitif::text, '') || '.');
  elsif s.purpose = 'ITEM_PDF_REPLACE' then
    select * into i from public.item where unit_id = s.unit_id and id = s.object_id;
    select * into b from public.berkas where unit_id = s.unit_id and id = i.berkas_id;
    if i.id is null or i.is_deleted or b.is_deleted then
      perform app.fail('NOT_FOUND', 'Item arsip tidak ditemukan atau sudah dihapus.');
    end if;
    perform app.audit(a, 'UPLOAD', 'EDIT_ARSIP', 'PDF_PENGGANTI', i.id, 'PDF pengganti siap untuk item ' ||
      coalesce(b.no_berkas_definitif::text, '–') || '/' || coalesce(i.no_item_definitif::text, '–'), v_file, s.request_id::text,
      null, pg_catalog.jsonb_build_object('drive_file_id', v_file, 'size', p_size, 'md5', v_md5));
    v_res := pg_catalog.jsonb_build_object('ok', true, 'session_id', s.id, 'purpose', s.purpose, 'object_id', i.id,
      'berkas_id', b.id, 'drive_file_id', v_file, 'file_name', s.drive_name, 'drive_tasks', v_tasks,
      'message', 'PDF pengganti tersimpan. Lanjutkan simpan perubahan.');
  elsif s.purpose = 'DELETION_EVIDENCE' then
    perform app.audit(a, 'UPLOAD', 'PENGHAPUSAN', 'BUKTI_DISPOSISI', s.object_id, 'Bukti disposisi siap untuk ' || s.object_id,
      v_file, s.request_id::text, null, pg_catalog.jsonb_build_object('drive_file_id', v_file, 'size', p_size, 'mime', v_mime));
    v_res := pg_catalog.jsonb_build_object('ok', true, 'session_id', s.id, 'purpose', s.purpose, 'object_id', s.object_id,
      'drive_file_id', v_file, 'file_name', s.drive_name, 'drive_tasks', v_tasks,
      'message', 'Bukti disposisi tersimpan. Lanjutkan konfirmasi pembatalan.');
  elsif s.purpose = 'RECEIPT_EVIDENCE' then
    select * into r from public.penerimaan where unit_id = s.unit_id and id = s.object_id for update;
    if coalesce(r.bukti_ttd_file_id, '') <> '' or coalesce(r.bukti_ttd_url, '') <> '' then
      perform app.fail('EVIDENCE_EXISTS', 'Bukti tertandatangani sudah tersimpan.');
    end if;
    update public.penerimaan set bukti_ttd_file_id = v_file, bukti_ttd_url = nullif(app.clean_text(p_drive_url, 500), ''),
      bukti_ttd_nama = s.drive_name, bukti_ttd_size_bytes = p_size, bukti_ttd_md5 = nullif(v_md5, ''),
      bukti_ttd_uploaded_at = now(), bukti_ttd_uploaded_by = a.email, updated_at = now(), updated_by = a.email,
      version = coalesce(version, 1) + 1
    where unit_id = s.unit_id and id = r.id;
    perform app.audit(a, 'UPLOAD', 'PENERIMAAN_ARSIP', 'BUKTI_TTD', r.id, 'Mengunggah bukti tertandatangani ' || r.nomor_tanda_terima,
      v_file, s.request_id::text);
    v_res := pg_catalog.jsonb_build_object('ok', true, 'session_id', s.id, 'purpose', s.purpose, 'object_id', r.id,
      'drive_file_id', v_file, 'file_name', s.drive_name, 'drive_tasks', v_tasks,
      'message', 'Bukti tanda terima tertandatangani berhasil disimpan.');
  else
    select * into r from public.penerimaan where unit_id = s.unit_id and id = s.object_id;
    perform app.audit(a, 'UPLOAD', 'PENERIMAAN_ARSIP', 'BUKTI_PEMBATALAN', r.id, 'Bukti pembatalan siap untuk ' || r.nomor_tanda_terima,
      v_file, s.request_id::text);
    v_res := pg_catalog.jsonb_build_object('ok', true, 'session_id', s.id, 'purpose', s.purpose, 'object_id', r.id,
      'drive_file_id', v_file, 'file_name', s.drive_name, 'drive_tasks', v_tasks,
      'message', 'Bukti pembatalan tersimpan. Lanjutkan konfirmasi pembatalan.');
  end if;

  update public.upload_sessions set status = 'COMMITTED', committed_at = now(), drive_file_id = v_file,
    drive_url = nullif(app.clean_text(p_drive_url, 500), ''), size_bytes = p_size, md5 = nullif(v_md5, ''), mime = v_mime,
    attested_at = p_attested_at, result = v_res
  where id = s.id;
  return v_res || '{"replayed": false}'::jsonb;
end
$$;

-- ---------------------------------------------------------------------------
-- upload_cancel: committed-but-unconsumed files of the "consumed later"
-- purposes may be cancelled (the gateway may then trash the file).
-- ---------------------------------------------------------------------------
create or replace function public.upload_cancel(p_session_id uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  s public.upload_sessions;
  a app.actor;
begin
  select * into s from public.upload_sessions where id = p_session_id for update;
  a := app.require_actor_object(s.unit_id, 'Sesi unggah', true);
  if s.owner_user_id <> a.user_id then perform app.fail('NOT_FOUND', 'Sesi unggah tidak ditemukan.'); end if;
  if s.status in ('CANCELLED', 'EXPIRED', 'SUPERSEDED') then
    return pg_catalog.jsonb_build_object('ok', true, 'status', s.status, 'drive_file_id', s.drive_file_id);
  end if;
  if s.status = 'COMMITTED' and not (s.purpose in ('RECEIPT_CANCEL_EVIDENCE', 'ITEM_PDF_REPLACE', 'DELETION_EVIDENCE')
                                     and s.consumed_at is null) then
    perform app.fail('UPLOAD_SESSION_STATE', 'File sesi ini sudah terhubung ke data dan tidak dapat dibatalkan dari sini.');
  end if;
  update public.upload_sessions set status = 'CANCELLED', cancelled_at = now() where id = s.id;
  return pg_catalog.jsonb_build_object('ok', true, 'status', 'CANCELLED', 'drive_file_id', s.drive_file_id);
end
$$;

-- ---------------------------------------------------------------------------
-- upload_register_folder (5-argument form; the 4-argument form of 0015 calls it):
--   TARGET of ITEM_PDF_REPLACE -> berkas.v4_drive_folder_id (as ITEM_PDF);
--   TARGET of DELETION_EVIDENCE -> unit setting V4_DELETION_EVIDENCE_FOLDER_ID.
-- ---------------------------------------------------------------------------
create or replace function public.upload_register_folder(p_session_id uuid, p_folder_id text, p_kind text,
                                                         p_attested_at bigint, p_attestation text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  s public.upload_sessions;
  a app.actor;
  v_folder text := pg_catalog.btrim(coalesce(p_folder_id, ''));
  v_kind text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_kind, 'TARGET')));
  v_key text;
  v_count integer := 0;
begin
  select * into s from public.upload_sessions where id = p_session_id for update;
  a := app.require_actor_object(s.unit_id, 'Sesi unggah', true);
  if s.owner_user_id <> a.user_id then perform app.fail('NOT_FOUND', 'Sesi unggah tidak ditemukan.'); end if;
  if v_kind not in ('TARGET', 'ROOT') then
    perform app.fail('INVALID_INPUT', 'Jenis folder tidak dikenal.', '{"field":"p_kind"}');
  end if;
  if v_folder !~ '^[A-Za-z0-9_-]{10,200}$' then
    perform app.fail('INVALID_INPUT', 'ID folder Drive tidak valid.', '{"field":"p_folder_id"}');
  end if;
  perform app.attestation_ok('CFFD1' || chr(10) || s.id || chr(10) || v_folder || chr(10) || coalesce(p_attested_at::text, '')
                             || case when v_kind = 'ROOT' then chr(10) || 'ROOT' else '' end,
                             p_attested_at, p_attestation);
  if s.status not in ('OPEN', 'COMMITTED') then
    perform app.fail('UPLOAD_SESSION_STATE', 'Sesi unggah sudah dibatalkan atau diganti.');
  end if;
  perform app.lock_unit(a.unit_id);
  if v_kind = 'TARGET' and s.purpose in ('ITEM_PDF', 'ITEM_PDF_REPLACE') then
    update public.berkas b set v4_drive_folder_id = v_folder, updated_at = now(), updated_by = a.email
    from public.item i
    where i.unit_id = s.unit_id and i.id = s.object_id and b.unit_id = i.unit_id and b.id = i.berkas_id
      and nullif(pg_catalog.btrim(b.v4_drive_folder_id), '') is null;
    get diagnostics v_count = row_count;
    update public.upload_sessions set known_folder_id = v_folder where id = s.id;
  else
    v_key := case when v_kind = 'ROOT' then 'V4_ROOT_FOLDER_ID'
                  when s.purpose = 'DELETION_EVIDENCE' then 'V4_DELETION_EVIDENCE_FOLDER_ID'
                  else 'V4_RECEIPT_PROOF_FOLDER_ID' end;
    insert into public.unit_settings as us (unit_id, key, value, value_type, description, updated_at, updated_by)
    values (s.unit_id, v_key, pg_catalog.to_jsonb(v_folder), 'STRING',
            case v_key when 'V4_ROOT_FOLDER_ID' then 'Folder induk Drive milik aplikasi v4 untuk unit ini'
                       when 'V4_DELETION_EVIDENCE_FOLDER_ID' then 'Folder bukti penghapusan/pembatalan arsip (Drive milik aplikasi v4)'
                       else 'Folder bukti penerimaan arsip (Drive milik aplikasi v4)' end, now(), a.email)
    on conflict (unit_id, key) do update set value = excluded.value, updated_at = now(), updated_by = a.email
    where nullif(pg_catalog.btrim(us.value #>> '{}'), '') is null;
    get diagnostics v_count = row_count;
    if v_kind = 'TARGET' then
      update public.upload_sessions set known_folder_id = v_folder where id = s.id;
    end if;
  end if;
  if v_count > 0 then
    perform app.audit(a, 'REGISTER_FOLDER', case s.purpose when 'ITEM_PDF' then 'ALIH_MEDIA' when 'ITEM_PDF_REPLACE' then 'EDIT_ARSIP'
                                                           when 'DELETION_EVIDENCE' then 'PENGHAPUSAN' else 'PENERIMAAN_ARSIP' end,
      'DRIVE_FOLDER', v_folder, 'Mencatat folder Drive v4 (' || v_kind || ') untuk ' || s.object_id, null, s.request_id::text);
  end if;
  return pg_catalog.jsonb_build_object('ok', true, 'folder_id', v_folder, 'kind', v_kind, 'registered', v_count > 0);
end
$$;

insert into public.schema_migrations_log (version, name)
values ('0018', 's3_koreksi_foundation') on conflict (version) do nothing;
