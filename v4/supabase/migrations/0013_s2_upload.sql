-- 0013_s2_upload.sql
-- Upload sessions (DB side of the Drive bridge) and Drive rename tasks.
--   upload_begin / upload_commit / upload_cancel / upload_register_folder
--   drive_task_list / drive_task_complete
-- A Drive file id only becomes attached to a record through upload_commit with
-- a valid, fresh HMAC attestation from the trusted Pages Function (secret
-- UPLOAD_ATTEST_SECRET). Without it a user could attach any Drive file id and
-- download it through the file bridge (0008), which authorizes by the record
-- that references the id. Contract: v4/supabase/API_S2.md.

create or replace function app.attestation_ok(p_canonical text, p_attested_at bigint, p_attestation text)
returns void
language plpgsql stable security definer
set search_path = ''
as $$
declare
  v_expected text;
begin
  if p_attestation is null or p_attested_at is null or p_attestation !~ '^[0-9a-fA-F]{64}$' then
    perform app.fail('UPLOAD_ATTESTATION_INVALID', 'Bukti verifikasi file dari server tidak valid. Ulangi unggah.');
  end if;
  v_expected := app.hmac_hex(p_canonical, app.server_secret('UPLOAD_ATTEST_SECRET'));
  if pg_catalog.lower(p_attestation) <> v_expected then
    perform app.fail('UPLOAD_ATTESTATION_INVALID', 'Bukti verifikasi file dari server tidak valid. Ulangi unggah.');
  end if;
  if pg_catalog.abs(pg_catalog.date_part('epoch', now())::bigint - p_attested_at) > 300 then
    perform app.fail('UPLOAD_ATTESTATION_EXPIRED', 'Bukti verifikasi file sudah kedaluwarsa. Ulangi penyelesaian unggah.');
  end if;
end
$$;

create or replace function app.drive_id_in_use(p_drive_id text, p_except_session uuid)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.item where pg_catalog.btrim(drive_file_id) = p_drive_id)
      or exists (select 1 from public.penerimaan where pg_catalog.btrim(bukti_ttd_file_id) = p_drive_id or pg_catalog.btrim(batal_bukti_file_id) = p_drive_id)
      or exists (select 1 from public.penerimaan_item where pg_catalog.btrim(file_digital_id) = p_drive_id)
      or exists (select 1 from public.berkas where pg_catalog.btrim(bukti_pemindahan_file_id) = p_drive_id
                                              or pg_catalog.btrim(drive_folder_id) = p_drive_id)
      or exists (select 1 from public.upload_sessions where drive_file_id = p_drive_id and status = 'COMMITTED'
                   and id is distinct from p_except_session)
$$;

create or replace function app.setting_text(p_unit_id uuid, p_key text)
returns text
language sql stable security definer
set search_path = ''
as $$
  select nullif(pg_catalog.btrim(value #>> '{}'), '') from public.unit_settings where unit_id = p_unit_id and key = p_key
$$;

create or replace function app.item_drive_name(i public.item, p_berkas_no integer)
returns text
language sql immutable
set search_path = ''
as $$
  select coalesce(i.no_berkas_snapshot, p_berkas_no)::text || '_' || coalesce(i.no_item_definitif::text, '') || '_' ||
         coalesce(nullif(i.uraian_nama_file, ''), app.clean_file_name(coalesce(nullif(i.uraian_lengkap, ''), 'arsip'))) || '.pdf'
$$;

-- ---------------------------------------------------------------------------
-- upload_begin
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
begin
  if v_purpose not in ('ITEM_PDF', 'RECEIPT_EVIDENCE', 'RECEIPT_CANCEL_EVIDENCE') then
    perform app.actor_base(true);
    perform app.fail('INVALID_INPUT', 'Jenis unggahan tidak dikenal.', '{"field":"p_purpose"}');
  end if;
  if v_purpose = 'ITEM_PDF' then
    select * into i from public.item where id = v_object;
    v_unit := i.unit_id;
    v_object_type := 'ITEM';
  else
    select * into r from public.penerimaan where id = v_object;
    v_unit := r.unit_id;
    v_object_type := 'PENERIMAAN';
  end if;
  if p_unit_id is not null and v_unit is distinct from p_unit_id then v_unit := null; end if;
  a := app.require_actor_object(v_unit, case when v_purpose = 'ITEM_PDF' then 'Item arsip' else 'Tanda terima' end, true);
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
      'folder_path', pg_catalog.to_jsonb(s.folder_path), 'drive_name', s.drive_name, 'known_folder_id', s.known_folder_id,
      'root_folder_id', app.setting_text(a.unit_id, 'ARCHIVE_FOLDER_ID'), 'max_bytes', s.max_bytes,
      'expires_at', s.expires_at, 'status', s.status, 'replayed', true);
  end if;

  -- object rules
  if v_purpose = 'ITEM_PDF' then
    select * into b from public.berkas where unit_id = a.unit_id and id = i.berkas_id;
    if i.is_deleted or b.id is null or b.is_deleted then
      perform app.fail('NOT_FOUND', 'Item arsip tidak ditemukan atau sudah dihapus.');
    end if;
    if nullif(pg_catalog.btrim(i.drive_file_id), '') is not null then
      perform app.fail('ITEM_HAS_FILE', 'Item ini sudah memiliki PDF. Gunakan menu Edit Arsip untuk mengganti file.');
    end if;
    if pg_catalog.upper(coalesce(b.status_peminjaman, 'TERSEDIA')) <> 'TERSEDIA'
       or pg_catalog.upper(coalesce(i.status_peminjaman, 'TERSEDIA')) <> 'TERSEDIA' then
      perform app.fail('OBJECT_BORROWED', 'Berkas atau item sedang dipinjam. Selesaikan transaksi peminjaman sebelum mengedit.');
    end if;
    v_max := 104857599;  -- < 100 MB
    v_drive_name := app.item_drive_name(i, b.no_berkas_definitif);
    v_folder := array[coalesce(b.no_berkas_definitif::text, 'DRAFT') || '_' || app.clean_file_name(b.judul_berkas)];
    v_known := nullif(pg_catalog.btrim(b.drive_folder_id), '');
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
    v_known := app.setting_text(a.unit_id, 'RECEIPT_PROOF_FOLDER_ID');
  end if;

  -- file rules (validateMediaUploadRequest_ / validateReceiptEvidenceFile_)
  if v_name = '' then perform app.fail('INVALID_INPUT', 'Nama file wajib diisi.', '{"field":"p_file_name"}'); end if;
  if pg_catalog.lower(v_name) !~ '\.pdf$' or v_mime not in ('application/pdf', 'application/octet-stream', '') then
    perform app.fail('FILE_TYPE', case when v_purpose = 'ITEM_PDF' then 'File alih media harus PDF.' else 'Bukti penerimaan harus berformat PDF.' end);
  end if;
  if p_size is null or p_size < 1 then
    perform app.fail('INVALID_INPUT', 'Ukuran file tidak valid.', '{"field":"p_size"}');
  end if;
  if p_size > v_max then
    perform app.fail('FILE_TOO_LARGE', case when v_purpose = 'ITEM_PDF' then 'Ukuran PDF harus kurang dari 100 MB.'
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
    case when v_purpose = 'ITEM_PDF' then 'ALIH_MEDIA' else 'PENERIMAAN_ARSIP' end,
    case v_purpose when 'ITEM_PDF' then 'ITEM' when 'RECEIPT_EVIDENCE' then 'BUKTI_TTD' else 'BUKTI_PEMBATALAN' end,
    v_object, 'Memulai unggah: ' || v_name, p_size || ' byte', p_request_id::text);
  return pg_catalog.jsonb_build_object('session_id', s.id, 'unit_id', s.unit_id, 'unit_code', a.unit_code,
    'folder_path', pg_catalog.to_jsonb(s.folder_path), 'drive_name', s.drive_name, 'known_folder_id', s.known_folder_id,
    'root_folder_id', app.setting_text(a.unit_id, 'ARCHIVE_FOLDER_ID'), 'max_bytes', s.max_bytes,
    'expires_at', s.expires_at, 'status', s.status, 'replayed', false);
end
$$;

-- ---------------------------------------------------------------------------
-- upload_commit
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
    perform app.fail('FILE_TOO_LARGE', case when s.purpose = 'ITEM_PDF' then 'Ukuran PDF harus kurang dari 100 MB.'
                                            else 'Ukuran bukti penerimaan maksimal 10 MB.' end);
  end if;
  if s.declared_size is not null and p_size <> s.declared_size then
    perform app.fail('UPLOAD_MISMATCH', 'Ukuran file berubah selama unggah. Pilih ulang file.');
  end if;
  if (s.purpose = 'ITEM_PDF' and v_mime <> 'application/pdf')
     or (s.purpose <> 'ITEM_PDF' and v_mime not in ('application/pdf', 'application/octet-stream')) then
    perform app.fail('FILE_TYPE', 'File hasil unggah bukan PDF.');
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
    if pg_catalog.upper(coalesce(b.status_peminjaman, 'TERSEDIA')) <> 'TERSEDIA'
       or pg_catalog.upper(coalesce(i.status_peminjaman, 'TERSEDIA')) <> 'TERSEDIA' then
      perform app.fail('OBJECT_BORROWED', 'Berkas atau item sedang dipinjam. Selesaikan transaksi peminjaman sebelum mengedit.');
    end if;
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
-- upload_cancel
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
  if s.status = 'COMMITTED' and not (s.purpose = 'RECEIPT_CANCEL_EVIDENCE' and s.consumed_at is null) then
    perform app.fail('UPLOAD_SESSION_STATE', 'File sesi ini sudah terhubung ke data dan tidak dapat dibatalkan dari sini.');
  end if;
  update public.upload_sessions set status = 'CANCELLED', cancelled_at = now() where id = s.id;
  return pg_catalog.jsonb_build_object('ok', true, 'status', 'CANCELLED', 'drive_file_id', s.drive_file_id);
end
$$;

-- ---------------------------------------------------------------------------
-- upload_register_folder (attested): cache the Drive folder the gateway used
-- ---------------------------------------------------------------------------
create or replace function public.upload_register_folder(p_session_id uuid, p_folder_id text, p_attested_at bigint, p_attestation text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  s public.upload_sessions;
  a app.actor;
  v_folder text := pg_catalog.btrim(coalesce(p_folder_id, ''));
  v_count integer := 0;
begin
  select * into s from public.upload_sessions where id = p_session_id for update;
  a := app.require_actor_object(s.unit_id, 'Sesi unggah', true);
  if s.owner_user_id <> a.user_id then perform app.fail('NOT_FOUND', 'Sesi unggah tidak ditemukan.'); end if;
  if v_folder !~ '^[A-Za-z0-9_-]{10,200}$' then
    perform app.fail('INVALID_INPUT', 'ID folder Drive tidak valid.', '{"field":"p_folder_id"}');
  end if;
  perform app.attestation_ok('CFFD1' || chr(10) || s.id || chr(10) || v_folder || chr(10) || coalesce(p_attested_at::text, ''),
                             p_attested_at, p_attestation);
  if s.status not in ('OPEN', 'COMMITTED') then
    perform app.fail('UPLOAD_SESSION_STATE', 'Sesi unggah sudah dibatalkan atau diganti.');
  end if;
  perform app.lock_unit(a.unit_id);
  if s.purpose = 'ITEM_PDF' then
    update public.berkas b set drive_folder_id = v_folder, drive_folder_url = 'https://drive.google.com/drive/folders/' || v_folder,
      updated_at = now(), updated_by = a.email
    from public.item i
    where i.unit_id = s.unit_id and i.id = s.object_id and b.unit_id = i.unit_id and b.id = i.berkas_id
      and nullif(pg_catalog.btrim(b.drive_folder_id), '') is null;
    get diagnostics v_count = row_count;
  else
    insert into public.unit_settings as us (unit_id, key, value, value_type, description, updated_at, updated_by)
    values (s.unit_id, 'RECEIPT_PROOF_FOLDER_ID', pg_catalog.to_jsonb(v_folder), 'STRING',
            'Folder bukti tanda terima dan pembatalan penerimaan arsip', now(), a.email)
    on conflict (unit_id, key) do update set value = excluded.value, updated_at = now(), updated_by = a.email
    where nullif(pg_catalog.btrim(us.value #>> '{}'), '') is null;
    get diagnostics v_count = row_count;
  end if;
  update public.upload_sessions set known_folder_id = coalesce(known_folder_id, v_folder) where id = s.id;
  if v_count > 0 then
    perform app.audit(a, 'REGISTER_FOLDER', case when s.purpose = 'ITEM_PDF' then 'ALIH_MEDIA' else 'PENERIMAAN_ARSIP' end,
      'DRIVE_FOLDER', v_folder, 'Mencatat folder Drive untuk ' || s.object_id, null, s.request_id::text);
  end if;
  return pg_catalog.jsonb_build_object('ok', true, 'folder_id', v_folder, 'registered', v_count > 0);
end
$$;

-- ---------------------------------------------------------------------------
-- Drive tasks
-- ---------------------------------------------------------------------------
create or replace function public.drive_task_list(p_unit_id uuid default null)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  a app.actor := app.require_actor(p_unit_id, true);
begin
  return pg_catalog.jsonb_build_object('ok', true, 'unit_id', a.unit_id,
    'tasks', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', t.id, 'kind', t.kind, 'drive_id', t.drive_id,
        'new_name', t.new_name, 'object_type', t.object_type, 'object_id', t.object_id, 'attempts', t.attempts,
        'created_at', t.created_at) order by t.created_at, t.id)
      from public.drive_tasks t where t.unit_id = a.unit_id and t.status = 'PENDING'), '[]'::jsonb));
end
$$;

create or replace function public.drive_task_complete(p_task_id uuid, p_ok boolean, p_error text, p_attested_at bigint, p_attestation text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  t public.drive_tasks;
  a app.actor;
begin
  select * into t from public.drive_tasks where id = p_task_id for update;
  a := app.require_actor_object(t.unit_id, 'Tugas Drive', true);
  if p_ok is null then perform app.fail('INVALID_INPUT', 'Status tugas wajib diisi.', '{"field":"p_ok"}'); end if;
  perform app.attestation_ok('CFDT1' || chr(10) || t.id || chr(10) || case when p_ok then 'ok' else 'fail' end || chr(10)
                             || coalesce(p_attested_at::text, ''), p_attested_at, p_attestation);
  if t.status <> 'PENDING' then
    return pg_catalog.jsonb_build_object('ok', true, 'status', t.status, 'replayed', true);
  end if;
  if p_ok then
    update public.drive_tasks set status = 'DONE', completed_at = now(), attempts = attempts + 1 where id = t.id;
    return pg_catalog.jsonb_build_object('ok', true, 'status', 'DONE', 'replayed', false);
  end if;
  update public.drive_tasks set attempts = attempts + 1, last_error = pg_catalog.left(coalesce(p_error, ''), 1000),
    status = case when attempts + 1 >= 5 then 'FAILED' else 'PENDING' end,
    completed_at = case when attempts + 1 >= 5 then now() end
  where id = t.id returning * into t;
  perform app.audit(a, 'RENAME_WARNING', 'PENOMORAN', t.object_type, t.object_id, 'Nama Drive gagal diperbarui',
    coalesce(p_error, ''), t.source_request_id, null, null, 'WARNING');
  return pg_catalog.jsonb_build_object('ok', true, 'status', t.status, 'attempts', t.attempts, 'replayed', false);
end
$$;

insert into public.schema_migrations_log (version, name)
values ('0013', 's2_upload') on conflict (version) do nothing;
