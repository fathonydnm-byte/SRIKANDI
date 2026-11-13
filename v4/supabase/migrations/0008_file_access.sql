-- 0008_file_access.sql
-- Secured file download bridge (authorization + audit side).
--
--   * public.get_file_access(drive_file_id)  SECURITY INVOKER
--       -> {file_name, mime, size, object_type, object_id, unit_id} when a row
--          the caller can see under RLS references that Drive file id, else NULL.
--          The Pages Function maps NULL to 404 (existence is never revealed).
--   * public.log_file_access(drive_file_id, disposition, request_id)  SECURITY DEFINER
--       -> writes one audit_log row with actor = auth.uid(); re-checks access
--          inside (same rules), so nothing else can be written through it.
--   * Both delegate to app.resolve_file_access, which filters EXPLICITLY by the
--     caller's role/unit (it must also be correct when RLS is bypassed in the
--     definer function).
--
-- Drive file columns covered (folders are not downloadable):
--   item.drive_file_id                    ITEM            (archive PDF)
--   penerimaan.bukti_ttd_file_id          PENERIMAAN      (signed receipt)
--   penerimaan.batal_bukti_file_id        PENERIMAAN      (cancellation evidence)
--   penerimaan_item.file_digital_id       PENERIMAAN_ITEM (digital file of a receipt line)
--   berkas.bukti_pemindahan_file_id       BERKAS          (transfer evidence, 0007)
--
-- Access policy (mirrors 3.x: deleted records are hidden from every normal
-- screen and their Drive files are moved to "90 KARANTINA APLIKASI", reviewed
-- by admins only):
--   * archive PDF of an active item in an active berkas: every active role
--     (PRD §4: Pimpinan may open/download, incl. TERBATAS/RAHASIA);
--   * receipt evidence / receipt-line files / transfer evidence: operational
--     roles only (ADMIN_PUSAT, ADMIN_UNIT, PETUGAS) — not archive softcopies;
--   * anything on a deleted / DIHAPUS / GAGAL record (quarantined in 3.x):
--     ADMIN_PUSAT and ADMIN_UNIT only.
-- Inactive users and users of inactive units get nothing (current_role() is NULL).

-- ---------------------------------------------------------------------------
-- Resolution (single source of truth)
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
    -- archive PDF
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

comment on function app.resolve_file_access(text) is
  'File access rules for the download bridge. Filters by caller role/unit explicitly (also correct without RLS).';

-- ---------------------------------------------------------------------------
-- public.get_file_access — authorization probe for the Pages Function.
-- ---------------------------------------------------------------------------
create or replace function public.get_file_access(p_drive_file_id text)
returns jsonb
language sql stable security invoker
set search_path = ''
as $$
  select app.resolve_file_access(p_drive_file_id)
$$;

comment on function public.get_file_access(text) is
  'Metadata of a Drive file the caller may open (RLS + role policy), else NULL. SECURITY INVOKER.';

-- ---------------------------------------------------------------------------
-- public.log_file_access — audit one file access by the caller.
-- ---------------------------------------------------------------------------
create or replace function public.log_file_access(
  p_drive_file_id text,
  p_disposition   text,
  p_request_id    text default null
)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_uid     uuid := auth.uid();
  v_access  jsonb;
  v_name    text;
  v_email   text;
  v_log_id  text;
begin
  if v_uid is null then
    raise exception 'Tidak ada sesi pengguna.' using errcode = '42501';
  end if;
  if p_disposition is null or p_disposition not in ('inline', 'attachment') then
    raise exception 'Disposisi file tidak valid.' using errcode = '22023';
  end if;

  -- Same rules as get_file_access; RLS is bypassed here, the rules are not.
  v_access := app.resolve_file_access(p_drive_file_id);
  if v_access is null then
    raise exception 'Akses file ditolak.' using errcode = '42501';
  end if;

  select p.full_name into v_name from public.profiles p where p.user_id = v_uid;
  select u.email into v_email from auth.users u where u.id = v_uid;

  insert into public.audit_log (
    unit_id, actor_user_id, actor_name_snapshot, actor_email_snapshot,
    action, module, object_type, object_id, summary, request_id, result, after_data)
  values (
    (v_access ->> 'unit_id')::uuid, v_uid, v_name, v_email,
    case p_disposition when 'inline' then 'VIEW_FILE' else 'DOWNLOAD_FILE' end,
    'AKSES_FILE',
    v_access ->> 'object_type', v_access ->> 'object_id',
    case p_disposition when 'inline' then 'Membuka file ' else 'Mengunduh file ' end || (v_access ->> 'file_name'),
    nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p_request_id, '')), 100), ''),
    'SUCCESS',
    pg_catalog.jsonb_build_object(
      'drive_file_id', pg_catalog.btrim(p_drive_file_id),
      'file_name', v_access ->> 'file_name',
      'disposition', p_disposition))
  returning id into v_log_id;

  return pg_catalog.jsonb_build_object('log_id', v_log_id, 'user_id', v_uid);
end
$$;

comment on function public.log_file_access(text, text, text) is
  'Audit a file view/download by auth.uid(). SECURITY DEFINER; re-checks access with app.resolve_file_access.';

-- ---------------------------------------------------------------------------
-- get_item_detail (0006) extended with mime type and file size, so the web
-- can decide whether a softcopy is small enough to share from the phone.
-- ---------------------------------------------------------------------------
create or replace function public.get_item_detail(p_item_id text)
returns jsonb
language sql stable security invoker
set search_path = ''
as $$
  select pg_catalog.jsonb_build_object(
    'item_id', i.id,
    'berkas_id', i.berkas_id,
    'unit_id', i.unit_id,
    'no_berkas', coalesce(b.no_berkas_definitif, i.no_berkas_snapshot),
    'no_item', i.no_item_definitif,
    'judul_berkas', b.judul_berkas,
    'no_surat', app.display_no_surat(i.no_surat_display, i.no_surat_utama, i.no_surat_alternatif),
    'no_surat_utama', i.no_surat_utama,
    'no_surat_alternatif', i.no_surat_alternatif,
    'tanggal_naskah', i.tanggal_naskah,
    'uraian', i.uraian_lengkap,
    'jumlah_halaman', i.jumlah_halaman,
    'tingkat_perkembangan', i.tingkat_perkembangan,
    'kondisi_fisik', i.kondisi_fisik,
    'media_sumber', i.media_sumber,
    'status_bentuk_digital', i.status_bentuk_digital,
    'kode_klasifikasi', coalesce(nullif(pg_catalog.btrim(i.kode_klasifikasi_snapshot), ''), b.kode_klasifikasi_snapshot),
    'uraian_klasifikasi', b.uraian_klasifikasi_snapshot,
    'kabinet', b.no_filling_kabinet,
    'laci', b.no_laci,
    'folder', coalesce(nullif(pg_catalog.btrim(b.no_folder), ''), b.no_berkas_definitif::text),
    'lokasi', app.lokasi_label(b.no_filling_kabinet, b.no_laci, b.no_folder, b.no_berkas_definitif),
    'klasifikasi_keamanan', coalesce(i.klasifikasi_keamanan_akses, b.klasifikasi_keamanan_akses),
    'has_file', nullif(pg_catalog.btrim(i.drive_file_id), '') is not null,
    'drive_file_id', nullif(pg_catalog.btrim(i.drive_file_id), ''),
    'drive_file_url', nullif(pg_catalog.btrim(i.drive_file_url), ''),
    'drive_folder_url', nullif(pg_catalog.btrim(b.drive_folder_url), ''),
    'nama_file', i.nama_file,
    'mime_type', coalesce(nullif(pg_catalog.btrim(i.mime_type), ''), 'application/pdf'),
    'drive_file_size_bytes', i.drive_file_size_bytes,
    'status_peminjaman',
      case when pg_catalog.upper(coalesce(i.status_peminjaman, 'TERSEDIA')) <> 'TERSEDIA'
           then pg_catalog.upper(i.status_peminjaman)
           else pg_catalog.upper(coalesce(b.status_peminjaman, 'TERSEDIA')) end,
    'status_berkas', b.status_berkas,
    'dibatalkan', (i.is_deleted or b.is_deleted or b.status_berkas in ('DIHAPUS', 'GAGAL')),
    'nomor_tanda_terima', i.nomor_tanda_terima_snapshot,
    'catatan', i.catatan)
  from public.item i
  join public.berkas b on b.unit_id = i.unit_id and b.id = i.berkas_id
  where i.id = p_item_id
$$;

-- ---------------------------------------------------------------------------
-- Privileges: authenticated only.
-- ---------------------------------------------------------------------------
revoke all on function app.resolve_file_access(text) from public, anon, authenticated, service_role;
grant execute on function app.resolve_file_access(text) to authenticated;

revoke all on function public.get_file_access(text) from public, anon, authenticated, service_role;
revoke all on function public.log_file_access(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.get_item_detail(text) from public, anon, authenticated, service_role;
grant execute on function public.get_file_access(text) to authenticated;
grant execute on function public.log_file_access(text, text, text) to authenticated;
grant execute on function public.get_item_detail(text) to authenticated, service_role;

-- Self-check
do $$
begin
  if has_function_privilege('anon', 'public.get_file_access(text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.log_file_access(text, text, text)', 'EXECUTE')
     or has_function_privilege('anon', 'app.resolve_file_access(text)', 'EXECUTE') then
    raise exception 'file access self-check: anon can execute a file access function';
  end if;
  if (select prosecdef from pg_proc where oid = 'public.get_file_access(text)'::regprocedure)
     or not (select prosecdef from pg_proc where oid = 'public.log_file_access(text, text, text)'::regprocedure)
     or (select prosecdef from pg_proc where oid = 'app.resolve_file_access(text)'::regprocedure) then
    raise exception 'file access self-check: wrong SECURITY INVOKER/DEFINER settings';
  end if;
end
$$;

insert into public.schema_migrations_log (version, name)
values ('0008', 'file_access') on conflict (version) do nothing;
