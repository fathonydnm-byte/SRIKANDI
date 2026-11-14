-- 0019_s3_edit_batal.sql
-- Edit/Perubahan and Koreksi & Pembatalan RPCs, ported from EditService.js,
-- DeletionService.js and the edit/deletion parts of UploadService.js (3.32.5):
--   edit_options, cancel_options, quarantine_list (reads)
--   item_update, berkas_update_title, archive_cancel (writes)
-- Renumbering is app.renumber_unit (0012/0015; re-created below with clock_timestamp()
-- for the history timestamps only); loan rules app.assert_not_borrowed (0018).
-- Contract: v4/supabase/API_S3.md. Re-runnable; no BEGIN/COMMIT.

-- ---------------------------------------------------------------------------
-- app.renumber_unit (0015) re-created UNCHANGED except for three timestamps:
-- the batch id and riwayat_nomor.created_at / dikonfirmasi_at use
-- clock_timestamp() instead of now(). now() is the transaction START, so an
-- operation that waited for the unit lock wrote history rows that sorted
-- before those of the operation it waited for (found by the S3 concurrency
-- test: "latest history row = current number" failed). Under the unit lock
-- clock_timestamp() follows the real order of the renumberings.
-- ---------------------------------------------------------------------------
create or replace function app.renumber_unit(a app.actor, p_targets text[], p_reason text, p_request_id text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_today date := app.today_jakarta();
  v_batch text := 'REN-' || app.jakarta_iso(clock_timestamp());
  v_tasks jsonb := '[]'::jsonb;
  v_task uuid;
  r record;
  v_parent_changes integer;
  v_renum_berkas integer;
  v_renum_items integer;
begin
  create temp table if not exists _rn_b (
    berkas_id text primary key, old_no integer, new_no integer, earliest date, latest date, cnt integer,
    pages integer, min_year integer, max_year integer, sec_rank integer, affected boolean, judul text,
    drive_folder_id text) on commit drop;
  -- 0015: the folder that may be renamed is the app-owned v4 folder
  create temp table if not exists _rn_i (
    item_id text primary key, berkas_id text, old_no integer, new_no integer, old_snapshot integer,
    new_snapshot integer, old_nama text, new_nama text, drive_file_id text) on commit drop;
  truncate pg_temp._rn_b, pg_temp._rn_i;

  insert into pg_temp._rn_b (berkas_id, old_no, earliest, latest, cnt, pages, min_year, max_year, sec_rank, judul, drive_folder_id)
  select b.id, b.no_berkas_definitif, pg_catalog.min(i.tanggal_naskah), pg_catalog.max(i.tanggal_naskah), pg_catalog.count(*)::int,
         pg_catalog.sum(coalesce(i.jumlah_halaman, 0))::int,
         pg_catalog.min(pg_catalog.date_part('year', i.tanggal_naskah))::int, pg_catalog.max(pg_catalog.date_part('year', i.tanggal_naskah))::int,
         pg_catalog.max(app.security_rank(i.klasifikasi_keamanan_akses)), b.judul_berkas, nullif(pg_catalog.btrim(b.v4_drive_folder_id), '')
  from public.berkas b
  join public.item i on i.unit_id = b.unit_id and i.berkas_id = b.id and not i.is_deleted
  where b.unit_id = a.unit_id and not b.is_deleted
  group by b.id;

  update pg_temp._rn_b t set new_no = o.rn
  from (select x.berkas_id, pg_catalog.row_number() over (
          order by x.earliest, case when x.old_no > 0 then x.old_no end nulls last, b.created_at, b.id) as rn
        from pg_temp._rn_b x join public.berkas b on b.unit_id = a.unit_id and b.id = x.berkas_id) o
  where o.berkas_id = t.berkas_id;
  update pg_temp._rn_b set affected = (berkas_id = any (coalesce(p_targets, '{}')) or new_no is distinct from old_no);

  insert into pg_temp._rn_i (item_id, berkas_id, old_no, new_no, old_snapshot, new_snapshot, old_nama, new_nama, drive_file_id)
  select i.id, i.berkas_id, i.no_item_definitif,
         pg_catalog.row_number() over (partition by i.berkas_id order by
           i.tanggal_naskah,
           app.normalized_letter(i.no_surat_utama, i.no_surat_alternatif) collate app.natural_ci,
           coalesce(nullif(i.sort_created_at, ''), app.jakarta_iso(i.created_at), i.id) collate app.natural_ci,
           i.id),
         i.no_berkas_snapshot, t.new_no, i.nama_file, null,
         case when app.is_app_drive_object(nullif(pg_catalog.btrim(i.drive_file_id), '')) then pg_catalog.btrim(i.drive_file_id) end
  from public.item i join pg_temp._rn_b t on t.berkas_id = i.berkas_id
  where i.unit_id = a.unit_id and not i.is_deleted;
  update pg_temp._rn_i ti set new_nama = ti.new_snapshot || '_' || ti.new_no || '_' ||
         coalesce(nullif(i.uraian_nama_file, ''), app.clean_file_name(nullif(i.uraian_lengkap, ''))) || '.pdf'
  from public.item i where i.unit_id = a.unit_id and i.id = ti.item_id;

  -- berkas updates (target + number changed)
  update public.berkas b set
    no_berkas_definitif = t.new_no,
    tgl_item_awal = t.earliest, tgl_item_akhir = t.latest, tgl_urut_berkas = t.earliest, tgl_acuan_retensi = t.latest,
    batas_aktif = app.add_duration(t.latest, b.retensi_aktif_nilai, b.retensi_aktif_satuan),
    batas_inaktif = app.add_duration(app.add_duration(t.latest, b.retensi_aktif_nilai, b.retensi_aktif_satuan),
                                     b.retensi_inaktif_nilai, b.retensi_inaktif_satuan),
    status_retensi = app.retention_status(app.add_duration(t.latest, b.retensi_aktif_nilai, b.retensi_aktif_satuan), v_today),
    jumlah_item = t.cnt, total_halaman = t.pages,
    kurun_waktu = case when t.min_year = t.max_year then t.min_year::text else t.min_year || '–' || t.max_year end,
    klasifikasi_keamanan_akses = app.security_label(t.sec_rank),
    no_folder = t.new_no::text, status_berkas = 'AKTIF',
    updated_at = now(), updated_by = a.email, version = coalesce(b.version, 0) + 1
  from pg_temp._rn_b t
  where b.unit_id = a.unit_id and b.id = t.berkas_id and t.affected;

  insert into public.riwayat_nomor (id, unit_id, jenis_objek, objek_id, berkas_id, nomor_lama, nomor_baru, nama_lama, nama_baru,
    alasan, batch_renumber_id, dikonfirmasi_oleh, dikonfirmasi_at, created_at, created_by)
  select 'HIS-' || gen_random_uuid(), a.unit_id, 'BERKAS', t.berkas_id, t.berkas_id, t.old_no, t.new_no, t.judul, t.judul,
         coalesce(p_reason, 'Penomoran ulang kronologis setelah penambahan item'), v_batch, a.email, clock_timestamp(), clock_timestamp(), a.email
  from pg_temp._rn_b t where t.affected and t.new_no is distinct from t.old_no
  order by t.new_no;

  for r in select * from pg_temp._rn_b t where t.affected and t.new_no is distinct from t.old_no and t.drive_folder_id is not null order by t.new_no loop
    v_task := app.queue_rename(a.unit_id, 'RENAME_FOLDER', r.drive_folder_id, r.new_no || '_' || app.clean_file_name(r.judul),
                               'BERKAS', r.berkas_id, p_request_id);
    v_tasks := v_tasks || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id', v_task, 'kind', 'RENAME_FOLDER',
                 'drive_id', r.drive_folder_id, 'new_name', r.new_no || '_' || app.clean_file_name(r.judul)));
  end loop;

  -- item updates, only inside affected berkas (as in 3.x)
  update public.item i set no_item_definitif = ti.new_no, no_berkas_snapshot = ti.new_snapshot, nama_file = ti.new_nama,
         updated_at = now(), updated_by = a.email, version = coalesce(i.version, 0) + 1
  from pg_temp._rn_i ti join pg_temp._rn_b t on t.berkas_id = ti.berkas_id
  where i.unit_id = a.unit_id and i.id = ti.item_id and t.affected
    and (ti.old_no is distinct from ti.new_no or ti.old_snapshot is distinct from ti.new_snapshot
         or coalesce(ti.old_nama, '') <> ti.new_nama);

  insert into public.riwayat_nomor (id, unit_id, jenis_objek, objek_id, berkas_id, nomor_lama, nomor_baru, nama_lama, nama_baru,
    alasan, batch_renumber_id, dikonfirmasi_oleh, dikonfirmasi_at, created_at, created_by)
  select 'HIS-' || gen_random_uuid(), a.unit_id, 'ITEM', ti.item_id, ti.berkas_id, ti.old_no, ti.new_no,
         nullif(ti.old_nama, ''), ti.new_nama,
         coalesce(p_reason, 'Penomoran ulang kronologis setelah penambahan item'), v_batch, a.email, clock_timestamp(), clock_timestamp(), a.email
  from pg_temp._rn_i ti join pg_temp._rn_b t on t.berkas_id = ti.berkas_id
  where t.affected and ti.old_no is distinct from ti.new_no
  order by ti.new_snapshot, ti.new_no;

  for r in select ti.* from pg_temp._rn_i ti join pg_temp._rn_b t on t.berkas_id = ti.berkas_id
            where t.affected and ti.drive_file_id is not null and coalesce(ti.old_nama, '') <> ti.new_nama
            order by ti.new_snapshot, ti.new_no loop
    v_task := app.queue_rename(a.unit_id, 'RENAME_FILE', r.drive_file_id, r.new_nama, 'ITEM', r.item_id, p_request_id);
    v_tasks := v_tasks || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id', v_task, 'kind', 'RENAME_FILE',
                 'drive_id', r.drive_file_id, 'new_name', r.new_nama));
  end loop;

  -- CF-01 media summary for the target berkas (centralFileMetadataSummarizeItems_)
  update public.berkas b set media_berkas = m ->> 'media_berkas', jumlah_item_fisik = (m ->> 'fisik')::int,
         jumlah_item_born_digital = (m ->> 'born_digital')::int, jumlah_item_alih_media = (m ->> 'alih_media')::int
  from (select t.berkas_id, app.media_berkas(a.unit_id, t.berkas_id) as m from pg_temp._rn_b t
        where t.berkas_id = any (coalesce(p_targets, '{}'))) x
  where b.unit_id = a.unit_id and b.id = x.berkas_id;

  select pg_catalog.count(*) filter (where new_no is distinct from old_no),
         pg_catalog.count(*) filter (where new_no is distinct from old_no
                                      and (old_no is not null or not (berkas_id = any (coalesce(p_targets, '{}')))))
    into v_parent_changes, v_renum_berkas from pg_temp._rn_b;
  select pg_catalog.count(*) into v_renum_items from pg_temp._rn_i
   where old_no is not null and (old_no is distinct from new_no or old_snapshot is distinct from new_snapshot);

  return pg_catalog.jsonb_build_object('batch_id', v_batch, 'berkas_number_changes', v_parent_changes,
    'renumbered_berkas_count', v_renum_berkas, 'renumbered_item_count', v_renum_items, 'drive_tasks', v_tasks);
end
$$;

-- ---------------------------------------------------------------------------
-- edit_options (read) — getEditOptions_
-- ---------------------------------------------------------------------------
create or replace function public.edit_options(p_unit_id uuid default null)
returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_unit uuid := app.read_unit(p_unit_id);
begin
  return pg_catalog.jsonb_build_object('ok', true, 'unit_id', v_unit,
    'berkas', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', b.id, 'number', b.no_berkas_definitif, 'title', b.judul_berkas,
        'classification_code', b.kode_klasifikasi_snapshot, 'classification_description', b.uraian_klasifikasi_snapshot,
        'security_classification', app.normalize_security(b.klasifikasi_keamanan_akses),
        'loan_status', coalesce(nullif(b.status_peminjaman, ''), 'TERSEDIA'),
        'can_edit', pg_catalog.upper(coalesce(nullif(b.status_peminjaman, ''), 'TERSEDIA')) = 'TERSEDIA',
        'label', coalesce(b.no_berkas_definitif::text, 'DRAFT') || ' – ' || b.judul_berkas,
        'items', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'id', i.id, 'number', i.no_item_definitif, 'description', coalesce(i.uraian_lengkap, ''),
            'document_date', i.tanggal_naskah, 'page_count', coalesce(i.jumlah_halaman, 0),
            'development_level', coalesce(nullif(i.tingkat_perkembangan, ''), 'ASLI'),
            'condition', coalesce(i.kondisi_fisik, ''),
            'security_classification', app.normalize_security(i.klasifikasi_keamanan_akses),
            'primary_letter_number', coalesce(i.no_surat_utama, ''), 'alternate_letter_number', coalesce(i.no_surat_alternatif, ''),
            'file_name', coalesce(i.nama_file, ''), 'file_url', coalesce(i.drive_file_url, ''),
            'has_file', nullif(pg_catalog.btrim(i.drive_file_id), '') is not null,
            'file_status', coalesce(i.status_file, 'BELUM DIUNGGAH'),
            'loan_status', coalesce(nullif(i.status_peminjaman, ''), 'TERSEDIA'),
            'can_edit', pg_catalog.upper(coalesce(nullif(b.status_peminjaman, ''), 'TERSEDIA')) = 'TERSEDIA'
                        and pg_catalog.upper(coalesce(nullif(i.status_peminjaman, ''), 'TERSEDIA')) = 'TERSEDIA',
            'version', i.version,
            'label', coalesce(i.no_item_definitif::text, '–') || ' – ' || app.clean_text(coalesce(nullif(i.uraian_lengkap, ''), 'Tanpa uraian'), 140))
            order by coalesce(i.no_item_definitif, 999999), i.id)
          from public.item i where i.unit_id = b.unit_id and i.berkas_id = b.id and not i.is_deleted), '[]'::jsonb))
        order by coalesce(b.no_berkas_definitif, 999999), b.created_at, b.id)
      from public.berkas b where b.unit_id = v_unit and not b.is_deleted), '[]'::jsonb),
    'development_levels', '["ASLI","COPY"]'::jsonb,
    'conditions', '["BAIK","RUSAK RINGAN","RUSAK SEDANG","RUSAK BERAT"]'::jsonb,
    'security_classifications', '["BIASA/TERBUKA","TERBATAS","RAHASIA","SANGAT RAHASIA"]'::jsonb,
    'min_reason_length', 10,
    'replacement_max_bytes', 104857599);
end
$$;

-- ---------------------------------------------------------------------------
-- cancel_options (read) — getDeletionOptions_
-- ---------------------------------------------------------------------------
create or replace function public.cancel_options(p_unit_id uuid default null)
returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_unit uuid := app.read_unit(p_unit_id);
begin
  return (
    with it as (
      select i.*, pg_catalog.count(*) over (partition by i.berkas_id) as n_active,
             pg_catalog.upper(coalesce(nullif(i.status_peminjaman, ''), 'TERSEDIA')) <> 'TERSEDIA' as borrowed
      from public.item i where i.unit_id = v_unit and not i.is_deleted
    ), bk as (
      select b.*, pg_catalog.upper(coalesce(nullif(b.status_peminjaman, ''), 'TERSEDIA')) <> 'TERSEDIA' as borrowed,
             (select pg_catalog.count(*) from it where it.berkas_id = b.id) as n_items,
             exists (select 1 from it where it.berkas_id = b.id and it.borrowed) as any_item_borrowed
      from public.berkas b where b.unit_id = v_unit and not b.is_deleted
    )
    select pg_catalog.jsonb_build_object('ok', true, 'unit_id', v_unit,
      'berkas', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', bk.id, 'number', bk.no_berkas_definitif, 'title', bk.judul_berkas,
          'item_count', bk.n_items, 'page_count', coalesce(bk.total_halaman, 0),
          'loan_status', coalesce(nullif(bk.status_peminjaman, ''), 'TERSEDIA'),
          'can_cancel', not bk.borrowed and not bk.any_item_borrowed,
          'label', coalesce(bk.no_berkas_definitif::text, 'DRAFT') || ' – ' || bk.judul_berkas,
          'items', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
              'id', it.id, 'number', it.no_item_definitif, 'description', coalesce(it.uraian_lengkap, ''),
              'document_date', it.tanggal_naskah, 'page_count', coalesce(it.jumlah_halaman, 0),
              'loan_status', coalesce(nullif(it.status_peminjaman, ''), 'TERSEDIA'),
              'has_file', nullif(pg_catalog.btrim(it.drive_file_id), '') is not null,
              'from_receipt', nullif(pg_catalog.btrim(it.penerimaan_item_id), '') is not null,
              'receipt_number', it.nomor_tanda_terima_snapshot,
              'is_last_item', it.n_active <= 1,
              'can_cancel', it.n_active > 1 and not it.borrowed and not bk.borrowed,
              'label', coalesce(it.no_item_definitif::text, '–') || ' – ' || app.clean_text(coalesce(nullif(it.uraian_lengkap, ''), 'Tanpa uraian'), 140))
              order by coalesce(it.no_item_definitif, 999999), it.id)
            from it where it.berkas_id = bk.id), '[]'::jsonb))
          order by coalesce(bk.no_berkas_definitif, 999999), bk.created_at, bk.id), '[]'::jsonb),
      'scopes', '["ITEM","BERKAS"]'::jsonb,
      'confirmation_word', 'HAPUS',
      'min_reason_length', 10,
      'evidence', pg_catalog.jsonb_build_object('optional', true, 'max_bytes', 26214400,
        'extensions', '["pdf","jpg","jpeg","png"]'::jsonb,
        'mime_types', '["application/pdf","image/jpeg","image/png"]'::jsonb))
    from bk);
end
$$;

-- ---------------------------------------------------------------------------
-- quarantine_list (read, admins only) — SYSTEM_QUARANTINE
-- ---------------------------------------------------------------------------
create or replace function public.quarantine_list(p_unit_id uuid default null, p_limit integer default 200)
returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_role public.app_role := app.current_role();
  v_unit uuid;
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 1000);
begin
  if v_role is null then
    perform app.fail('ACCOUNT_INACTIVE', 'Akun Anda belum aktif atau sudah dinonaktifkan.');
  end if;
  if v_role not in ('ADMIN_PUSAT', 'ADMIN_UNIT') then
    perform app.fail('FORBIDDEN_ROLE', 'Karantina hanya dapat dilihat oleh admin unit atau Admin Pusat.');
  end if;
  v_unit := app.read_unit(p_unit_id);
  return pg_catalog.jsonb_build_object('ok', true, 'unit_id', v_unit,
    'total', (select pg_catalog.count(*) from public.karantina q where q.unit_id = v_unit),
    'items', coalesce((select pg_catalog.jsonb_agg(x.j order by x.occurred_at desc, x.id) from (
        select q.occurred_at, q.id, pg_catalog.jsonb_build_object(
          'id', q.id, 'occurred_at', q.occurred_at, 'user_email', q.user_email, 'object_type', q.object_type,
          'object_id', q.object_id, 'original_name', q.original_name, 'original_url', q.original_url,
          'module', q.module, 'reason', q.reason, 'status', q.status, 'notes', q.notes,
          'related_object_type', q.related_object_type, 'related_object_id', q.related_object_id, 'berkas_id', q.berkas_id,
          'pembatalan_id', q.pembatalan_id, 'request_id', q.request_id, 'app_owned', q.app_owned,
          'moved_in_drive', q.quarantine_folder_id is not null, 'quarantine_url', q.quarantine_url,
          'downloadable', q.object_type = 'FILE') as j
        from public.karantina q where q.unit_id = v_unit
        order by q.occurred_at desc, q.id limit v_limit) x), '[]'::jsonb));
end
$$;

-- ---------------------------------------------------------------------------
-- item_update — updateArchiveItem_ (+ finalizeEditReplacementUpload_)
-- ITEM_ID never changes. Classification (berkas) is untouched; the item's
-- security level is taken from the payload, the berkas follows the strictest
-- active item through app.renumber_unit.
-- ---------------------------------------------------------------------------
create or replace function public.item_update(p_request_id uuid, p_item_id text, p_payload jsonb, p_reason text,
                                              p_replacement_session_id uuid default null,
                                              p_validate_only boolean default false)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  i public.item;
  b public.berkas;
  a app.actor;
  s public.upload_sessions;
  v_validate boolean := coalesce(p_validate_only, false);
  v_hash text;
  v_prev jsonb;
  v_reason text := app.clean_text(p_reason, 2000);
  v_berkas text;
  v_desc text;
  v_pages integer;
  v_date date;
  v_dev text;
  v_cond text;
  v_sec text;
  v_changed text[] := '{}';
  v_old_file text;
  v_q text;
  v_hook jsonb;
  v_num jsonb;
  v_before jsonb;
  v_after jsonb;
  v_summary text;
  v_res jsonb;
begin
  select * into i from public.item where id = app.clean_text(p_item_id, 80);
  a := app.require_actor_object(i.unit_id, 'Item arsip', true);
  if not v_validate then
    perform app.lock_unit(a.unit_id);
    v_hash := pg_catalog.md5(pg_catalog.jsonb_build_object('item', i.id, 'payload', p_payload, 'reason', p_reason,
                'session', p_replacement_session_id)::text);
    v_prev := app.idem_lookup(a.unit_id, p_request_id, 'ITEM_UPDATE', v_hash);
    if v_prev is not null then return v_prev; end if;
  end if;
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    perform app.fail('INVALID_INPUT', 'Data perubahan tidak valid.', '{"field":"p_payload"}');
  end if;
  v_berkas := app.clean_text(p_payload ->> 'berkas_id', 80);
  if v_berkas = '' then perform app.fail('INVALID_INPUT', 'Berkas induk wajib diisi.', '{"field":"p_payload.berkas_id"}'); end if;
  if v_reason = '' then perform app.fail('INVALID_INPUT', 'Alasan perubahan wajib diisi.', '{"field":"p_reason"}'); end if;
  if pg_catalog.length(v_reason) < 10 then
    perform app.fail('INVALID_INPUT', 'Alasan perubahan minimal 10 karakter agar jejak audit cukup jelas.', '{"field":"p_reason"}');
  end if;

  select * into b from public.berkas where unit_id = a.unit_id and id = v_berkas and not is_deleted;
  if not found then perform app.fail('NOT_FOUND', 'Berkas induk tidak ditemukan atau sudah dihapus.'); end if;
  select * into i from public.item where unit_id = a.unit_id and id = i.id and berkas_id = b.id and not is_deleted for update;
  if not found then perform app.fail('NOT_FOUND', 'Item arsip tidak ditemukan atau sudah dihapus.'); end if;
  perform app.assert_not_borrowed(a.unit_id, b.id, array[i.id], 'EDIT');

  v_desc := app.clean_text(p_payload ->> 'description', 2000);
  if v_desc = '' then perform app.fail('INVALID_INPUT', 'Uraian informasi arsip wajib diisi.', '{"field":"p_payload.description"}'); end if;
  v_pages := app.parse_int(p_payload -> 'page_count', 'p_payload.page_count', 'Jumlah halaman', 1);
  v_date := app.parse_date(p_payload ->> 'document_date', 'p_payload.document_date', 'Tanggal naskah');
  v_dev := pg_catalog.upper(app.clean_text(p_payload ->> 'development_level'));
  if v_dev = '' then perform app.fail('INVALID_INPUT', 'Tingkat perkembangan wajib diisi.', '{"field":"p_payload.development_level"}'); end if;
  if v_dev not in ('ASLI', 'COPY') then
    perform app.fail('INVALID_INPUT', 'Tingkat perkembangan harus ASLI atau COPY.', '{"field":"p_payload.development_level"}');
  end if;
  v_cond := pg_catalog.upper(app.clean_text(p_payload ->> 'condition'));
  if v_cond <> '' and v_cond not in ('BAIK', 'RUSAK RINGAN', 'RUSAK SEDANG', 'RUSAK BERAT') then
    perform app.fail('INVALID_INPUT', 'Kondisi fisik tidak valid.', '{"field":"p_payload.condition"}');
  end if;
  -- 3.30.5: the classification is required and never defaulted, with or without a replacement PDF
  if app.clean_text(p_payload ->> 'security_classification') = '' then
    perform app.fail('INVALID_INPUT', 'Klasifikasi keamanan dan akses arsip wajib diisi.', '{"field":"p_payload.security_classification"}');
  end if;
  v_sec := app.valid_security(p_payload ->> 'security_classification');
  if v_sec is null then
    perform app.fail('INVALID_INPUT', 'Klasifikasi keamanan dan akses arsip tidak valid.', '{"field":"p_payload.security_classification"}');
  end if;

  if p_replacement_session_id is not null then
    -- only an attested, committed, unused ITEM_PDF_REPLACE session of this caller for this very item
    select * into s from public.upload_sessions
     where id = p_replacement_session_id and unit_id = a.unit_id and purpose = 'ITEM_PDF_REPLACE' and object_id = i.id
       and owner_user_id = a.user_id and status = 'COMMITTED' and consumed_at is null
     for update;
    if not found then
      perform app.fail('UPLOAD_SESSION_STATE', 'PDF pengganti belum selesai diunggah atau sudah dipakai. Unggah ulang PDF pengganti.');
    end if;
    if app.drive_id_in_use(s.drive_file_id, s.id) then
      perform app.fail('UPLOAD_FILE_IN_USE', 'File Drive ini sudah terhubung ke data lain.');
    end if;
  end if;

  if v_desc <> app.clean_text(i.uraian_lengkap, 2000) then v_changed := pg_catalog.array_append(v_changed, 'description'); end if;
  if v_pages <> coalesce(i.jumlah_halaman, 0) then v_changed := pg_catalog.array_append(v_changed, 'page_count'); end if;
  if v_date is distinct from i.tanggal_naskah then v_changed := pg_catalog.array_append(v_changed, 'document_date'); end if;
  if v_dev <> pg_catalog.upper(coalesce(i.tingkat_perkembangan, '')) then v_changed := pg_catalog.array_append(v_changed, 'development_level'); end if;
  if v_cond <> pg_catalog.upper(coalesce(i.kondisi_fisik, '')) then v_changed := pg_catalog.array_append(v_changed, 'condition'); end if;
  if v_sec <> app.normalize_security(i.klasifikasi_keamanan_akses) then v_changed := pg_catalog.array_append(v_changed, 'security_classification'); end if;
  if s.id is not null then v_changed := pg_catalog.array_append(v_changed, 'pdf'); end if;

  if v_validate then
    return pg_catalog.jsonb_build_object('ok', true, 'valid', true, 'item_id', i.id, 'berkas_id', b.id,
      'changed_fields', pg_catalog.to_jsonb(v_changed), 'has_file', nullif(pg_catalog.btrim(i.drive_file_id), '') is not null);
  end if;
  if pg_catalog.cardinality(v_changed) = 0 then
    perform app.fail('NO_CHANGES', 'Tidak ada perubahan yang perlu disimpan.');
  end if;

  v_before := pg_catalog.jsonb_build_object('document_date', i.tanggal_naskah, 'page_count', i.jumlah_halaman,
    'development_level', i.tingkat_perkembangan, 'condition', i.kondisi_fisik,
    'security_classification', i.klasifikasi_keamanan_akses, 'description', i.uraian_lengkap,
    'drive_file_id', i.drive_file_id, 'nama_file', i.nama_file, 'no_berkas', b.no_berkas_definitif,
    'no_item', i.no_item_definitif, 'version', i.version);

  update public.item set tanggal_naskah = v_date, tahun_kurun_waktu = pg_catalog.date_part('year', v_date)::int,
    uraian_lengkap = v_desc, uraian_nama_file = app.clean_file_name(v_desc), jumlah_halaman = v_pages,
    tingkat_perkembangan = v_dev, kondisi_fisik = nullif(v_cond, ''), klasifikasi_keamanan_akses = v_sec,
    status_verifikasi_metadata = 'TERVERIFIKASI', metadata_schema_version = 4,
    updated_at = now(), updated_by = a.email, version = coalesce(version, 0) + 1
  where unit_id = a.unit_id and id = i.id;

  if s.id is not null then
    v_old_file := nullif(pg_catalog.btrim(i.drive_file_id), '');
    update public.item set drive_file_id = s.drive_file_id, drive_file_url = s.drive_url, mime_type = 'application/pdf',
      drive_file_size_bytes = s.size_bytes, drive_file_md5 = s.md5, drive_file_sha256 = null, nama_file = s.drive_name,
      status_file = 'TERSEDIA',
      status_bentuk_digital = case when coalesce(status_bentuk_digital, 'TIDAK ADA') = 'TIDAK ADA' then 'ALIH MEDIA' else status_bentuk_digital end,
      file_replaced_at = now()
    where unit_id = a.unit_id and id = i.id;
    update public.upload_sessions set consumed_at = now() where id = s.id;
    if v_old_file is not null then
      -- the old version is never deleted: it is bound to this edit and becomes admin-only
      v_q := app.quarantine_add(a, 'FILE', v_old_file, i.nama_file, i.drive_file_url, i.mime_type, i.drive_file_size_bytes,
        i.drive_file_md5, 'EDIT_ARSIP', v_reason, 'Versi alih media sebelum penggantian', 'ITEM', i.id, b.id,
        p_request_id::text, null);
      v_hook := app.invalidate_file_derivatives(a.unit_id, i.id, v_old_file, p_request_id::text);
    end if;
  end if;

  v_num := app.renumber_unit(a, array[b.id], 'Penomoran ulang kronologis setelah perubahan metadata item', p_request_id::text);
  select * into i from public.item where unit_id = a.unit_id and id = i.id;
  select * into b from public.berkas where unit_id = a.unit_id and id = b.id;

  v_after := pg_catalog.jsonb_build_object('document_date', i.tanggal_naskah, 'page_count', i.jumlah_halaman,
    'development_level', i.tingkat_perkembangan, 'condition', i.kondisi_fisik,
    'security_classification', i.klasifikasi_keamanan_akses, 'description', i.uraian_lengkap,
    'drive_file_id', i.drive_file_id, 'nama_file', i.nama_file, 'no_berkas', b.no_berkas_definitif,
    'no_item', i.no_item_definitif, 'version', i.version, 'changed_fields', pg_catalog.to_jsonb(v_changed),
    'quarantine_id', v_q, 'renumbering', v_num - 'drive_tasks', 'derivatives', v_hook);
  v_summary := 'Sebelum: tanggal ' || coalesce(v_before ->> 'document_date', '–') || ', ' || coalesce(v_before ->> 'page_count', '0') ||
    ' lembar, ' || coalesce(v_before ->> 'development_level', '–') || ', kondisi ' || coalesce(v_before ->> 'condition', 'tidak dicatat') ||
    ', "' || app.clean_text(v_before ->> 'description', 250) || '" | Sesudah: tanggal ' || v_date || ', ' || v_pages || ' lembar, ' ||
    v_dev || ', kondisi ' || coalesce(nullif(v_cond, ''), 'tidak dicatat') || ', "' || app.clean_text(v_desc, 250) || '"';
  perform app.audit(a, 'UPDATE', 'EDIT_ARSIP', 'ITEM', i.id, v_summary,
    v_reason || case when s.id is not null then ' | File alih media diganti; versi lama dipindahkan ke karantina.' else '' end,
    p_request_id::text, v_before, v_after);

  v_res := pg_catalog.jsonb_build_object('ok', true, 'request_id', p_request_id, 'item_id', i.id, 'berkas_id', b.id,
    'berkas_number', b.no_berkas_definitif, 'item_number', i.no_item_definitif,
    'changed_fields', pg_catalog.to_jsonb(v_changed), 'file_replaced', s.id is not null,
    'drive_file_id', i.drive_file_id, 'old_drive_file_id', v_old_file, 'quarantine_id', v_q,
    'security_classification', i.klasifikasi_keamanan_akses, 'berkas_security_classification', b.klasifikasi_keamanan_akses,
    'renumbered_item_count', v_num -> 'renumbered_item_count', 'renumbered_berkas_count', v_num -> 'renumbered_berkas_count',
    'drive_tasks', v_num -> 'drive_tasks', 'warnings', '[]'::jsonb,
    'message', 'Perubahan item berhasil disimpan.');
  return app.idem_store(a.unit_id, p_request_id, 'ITEM_UPDATE', v_hash, a.user_id, v_res);
end
$$;

-- ---------------------------------------------------------------------------
-- berkas_update_title — updateBerkasTitle_ (3.27). The v4 (app-owned) berkas
-- folder gets a rename task; the legacy folder is left as it is (3.27 never renamed it).
-- ---------------------------------------------------------------------------
create or replace function public.berkas_update_title(p_request_id uuid, p_berkas_id text, p_title text, p_reason text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  b public.berkas;
  a app.actor;
  v_hash text;
  v_prev jsonb;
  v_title text := app.clean_text(p_title, 500);
  v_reason text := app.clean_text(p_reason, 2000);
  v_old text;
  v_folder text;
  v_name text;
  v_task uuid;
  v_tasks jsonb := '[]'::jsonb;
  v_res jsonb;
begin
  select * into b from public.berkas where id = app.clean_text(p_berkas_id, 80);
  a := app.require_actor_object(b.unit_id, 'Berkas', true);
  perform app.lock_unit(a.unit_id);
  v_hash := pg_catalog.md5(pg_catalog.jsonb_build_object('berkas', b.id, 'title', p_title, 'reason', p_reason)::text);
  v_prev := app.idem_lookup(a.unit_id, p_request_id, 'BERKAS_UPDATE_TITLE', v_hash);
  if v_prev is not null then return v_prev; end if;
  if v_title = '' then perform app.fail('INVALID_INPUT', 'Judul berkas baru wajib diisi.', '{"field":"p_title"}'); end if;
  if v_reason = '' then perform app.fail('INVALID_INPUT', 'Alasan perubahan wajib diisi.', '{"field":"p_reason"}'); end if;
  if pg_catalog.length(v_reason) < 10 then
    perform app.fail('INVALID_INPUT', 'Alasan perubahan minimal 10 karakter agar jejak audit cukup jelas.', '{"field":"p_reason"}');
  end if;
  select * into b from public.berkas where unit_id = a.unit_id and id = b.id and not is_deleted for update;
  if not found then perform app.fail('NOT_FOUND', 'Berkas induk tidak ditemukan atau sudah dihapus.'); end if;
  perform app.assert_not_borrowed(a.unit_id, b.id, '{}', 'EDIT');
  v_old := app.clean_text(b.judul_berkas, 500);
  if v_title = v_old then perform app.fail('NO_CHANGES', 'Tidak ada perubahan yang perlu disimpan.'); end if;

  update public.berkas set judul_berkas = v_title, updated_at = now(), updated_by = a.email,
    version = coalesce(version, 0) + 1
  where unit_id = a.unit_id and id = b.id;

  v_folder := nullif(pg_catalog.btrim(b.v4_drive_folder_id), '');
  if v_folder is not null then
    v_name := coalesce(b.no_berkas_definitif::text, 'DRAFT') || '_' || app.clean_file_name(v_title);
    v_task := app.queue_rename(a.unit_id, 'RENAME_FOLDER', v_folder, v_name, 'BERKAS', b.id, p_request_id::text);
    v_tasks := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('id', v_task, 'kind', 'RENAME_FOLDER',
                 'drive_id', v_folder, 'new_name', v_name));
  end if;
  perform app.audit(a, 'UPDATE_TITLE', 'EDIT_ARSIP', 'BERKAS', b.id,
    'Sebelum: "' || v_old || '" | Sesudah: "' || v_title || '"', v_reason, p_request_id::text,
    pg_catalog.jsonb_build_object('judul_berkas', b.judul_berkas, 'version', b.version),
    pg_catalog.jsonb_build_object('judul_berkas', v_title, 'version', coalesce(b.version, 0) + 1, 'drive_tasks', v_tasks));
  v_res := pg_catalog.jsonb_build_object('ok', true, 'request_id', p_request_id, 'berkas_id', b.id,
    'berkas_number', b.no_berkas_definitif, 'old_title', v_old, 'title', v_title, 'drive_tasks', v_tasks,
    'warnings', '[]'::jsonb, 'message', 'Judul berkas berhasil diubah.');
  return app.idem_store(a.unit_id, p_request_id, 'BERKAS_UPDATE_TITLE', v_hash, a.user_id, v_res);
end
$$;

-- ---------------------------------------------------------------------------
-- archive_cancel — deleteArchive_ (+ finalizeDeletionEvidenceUpload_).
-- Soft delete only; nothing is ever removed. Files stay in Drive, bound in
-- karantina; receipt lines return to the filing queue; the unit is renumbered.
-- ---------------------------------------------------------------------------
create or replace function public.archive_cancel(p_request_id uuid, p_scope text, p_berkas_id text, p_item_id text,
                                                 p_reason text, p_confirmation text,
                                                 p_evidence_session_id uuid default null,
                                                 p_validate_only boolean default false)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  b public.berkas;
  i public.item;
  a app.actor;
  s public.upload_sessions;
  r record;
  v_validate boolean := coalesce(p_validate_only, false);
  v_scope text := pg_catalog.upper(app.clean_text(p_scope, 20));
  v_reason text := app.clean_text(p_reason, 2000);
  v_item_id text := app.clean_text(p_item_id, 80);
  v_hash text;
  v_prev jsonb;
  v_active text[];
  v_targets text[];
  v_btl text := 'BTL-' || gen_random_uuid();
  v_module text;
  v_q text;
  v_qids text[] := '{}';
  v_released text[];
  v_num jsonb;
  v_audit_reason text;
  v_res jsonb;
begin
  select * into b from public.berkas where id = app.clean_text(p_berkas_id, 80);
  a := app.require_actor_object(b.unit_id, 'Berkas', true);
  if not v_validate then
    perform app.lock_unit(a.unit_id);
    v_hash := pg_catalog.md5(pg_catalog.jsonb_build_object('scope', p_scope, 'berkas', b.id, 'item', p_item_id,
                'reason', p_reason, 'confirmation', p_confirmation, 'evidence', p_evidence_session_id)::text);
    v_prev := app.idem_lookup(a.unit_id, p_request_id, 'ARCHIVE_CANCEL', v_hash);
    if v_prev is not null then return v_prev; end if;
  end if;

  -- resolveDeletionContext_
  if v_scope not in ('BERKAS', 'ITEM') then
    perform app.fail('INVALID_INPUT', 'Objek penghapusan tidak valid.', '{"field":"p_scope"}');
  end if;
  if v_reason = '' then perform app.fail('INVALID_INPUT', 'Alasan penghapusan wajib diisi.', '{"field":"p_reason"}'); end if;
  if pg_catalog.length(v_reason) < 10 then
    perform app.fail('INVALID_INPUT', 'Alasan penghapusan minimal 10 karakter agar jejak audit cukup jelas.', '{"field":"p_reason"}');
  end if;
  if pg_catalog.upper(pg_catalog.btrim(coalesce(p_confirmation, ''))) <> 'HAPUS' then
    perform app.fail('INVALID_INPUT', 'Ketik HAPUS pada kolom konfirmasi.', '{"field":"p_confirmation"}');
  end if;
  select * into b from public.berkas where unit_id = a.unit_id and id = b.id for update;
  if b.is_deleted then
    perform app.fail('ALREADY_CANCELLED', 'Berkas sudah dibatalkan sebelumnya.', pg_catalog.jsonb_build_object('berkas_id', b.id));
  end if;
  select coalesce(pg_catalog.array_agg(x.id order by x.no_item_definitif nulls last, x.id), '{}') into v_active
    from public.item x where x.unit_id = a.unit_id and x.berkas_id = b.id and not x.is_deleted;
  perform app.assert_not_borrowed(a.unit_id, b.id, case when v_scope = 'BERKAS' then v_active else '{}' end, 'HAPUS');
  if v_scope = 'ITEM' then
    if v_item_id = '' then perform app.fail('INVALID_INPUT', 'Item arsip wajib diisi.', '{"field":"p_item_id"}'); end if;
    select * into i from public.item where unit_id = a.unit_id and id = v_item_id and berkas_id = b.id for update;
    if not found then perform app.fail('NOT_FOUND', 'Item tidak ditemukan atau sudah dihapus.'); end if;
    if i.is_deleted then
      perform app.fail('ALREADY_CANCELLED', 'Item sudah dibatalkan sebelumnya.', pg_catalog.jsonb_build_object('item_id', i.id));
    end if;
    perform app.assert_not_borrowed(a.unit_id, b.id, array[i.id], 'HAPUS');
    if pg_catalog.cardinality(v_active) <= 1 then
      perform app.fail('LAST_ITEM_IN_BERKAS', 'Item ini adalah item terakhir. Gunakan pilihan Hapus seluruh berkas agar database tetap konsisten.');
    end if;
    v_targets := array[i.id];
  else
    v_targets := v_active;
  end if;
  if p_evidence_session_id is not null then
    select * into s from public.upload_sessions
     where id = p_evidence_session_id and unit_id = a.unit_id and purpose = 'DELETION_EVIDENCE'
       and object_id = case when v_scope = 'ITEM' then i.id else b.id end
       and owner_user_id = a.user_id and status = 'COMMITTED' and consumed_at is null
     for update;
    if not found then
      perform app.fail('UPLOAD_SESSION_STATE', 'Bukti disposisi belum selesai diunggah atau sudah dipakai. Unggah ulang bukti.');
    end if;
    if app.drive_id_in_use(s.drive_file_id, s.id) then
      perform app.fail('UPLOAD_FILE_IN_USE', 'File Drive ini sudah terhubung ke data lain.');
    end if;
  end if;
  if v_validate then
    return pg_catalog.jsonb_build_object('ok', true, 'valid', true, 'scope', v_scope, 'berkas_id', b.id,
      'item_id', i.id, 'item_count', pg_catalog.cardinality(v_targets));
  end if;

  v_module := case when v_scope = 'BERKAS' then 'PENGHAPUSAN_BERKAS' else 'PENGHAPUSAN_ITEM' end;
  v_audit_reason := v_reason || case when s.id is not null
    then ' | Bukti disposisi: ' || coalesce(s.drive_url, s.drive_file_id) else '' end;

  -- quarantine bindings: every item file, and (scope BERKAS) the berkas folders
  for r in select x.* from public.item x where x.unit_id = a.unit_id and x.id = any (v_targets)
            and nullif(pg_catalog.btrim(x.drive_file_id), '') is not null
            order by x.no_item_definitif nulls last, x.id loop
    v_q := app.quarantine_add(a, 'FILE', r.drive_file_id, r.nama_file, r.drive_file_url, r.mime_type, r.drive_file_size_bytes,
      r.drive_file_md5, v_module, v_reason, null, 'ITEM', r.id, b.id, p_request_id::text, v_btl);
    v_qids := v_qids || v_q;
    perform app.invalidate_file_derivatives(a.unit_id, r.id, r.drive_file_id, p_request_id::text);
  end loop;
  if v_scope = 'BERKAS' then
    for r in select distinct f from pg_catalog.unnest(array[nullif(pg_catalog.btrim(b.drive_folder_id), ''),
                                                          nullif(pg_catalog.btrim(b.v4_drive_folder_id), '')]) f
              where f is not null order by f loop
      v_q := app.quarantine_add(a, 'FOLDER', r.f, coalesce(b.no_berkas_definitif::text, 'DRAFT') || '_' || app.clean_file_name(b.judul_berkas),
        case when r.f = pg_catalog.btrim(b.drive_folder_id) then b.drive_folder_url end, null, null, null,
        v_module, v_reason, null, 'BERKAS', b.id, b.id, p_request_id::text, v_btl);
      v_qids := v_qids || v_q;
      perform app.invalidate_file_derivatives(a.unit_id, null, r.f, p_request_id::text);
    end loop;
  end if;

  -- soft delete
  update public.item set is_deleted = true, status_file = 'DIHAPUS', deleted_at = now(),
    catatan = app.deletion_note(catatan, v_reason), updated_at = now(), updated_by = a.email,
    version = coalesce(version, 0) + 1
  where unit_id = a.unit_id and id = any (v_targets);
  if v_scope = 'BERKAS' then
    update public.berkas set is_deleted = true, status_berkas = 'DIHAPUS', deleted_at = now(),
      catatan = app.deletion_note(catatan, v_reason), updated_at = now(), updated_by = a.email,
      version = coalesce(version, 0) + 1
    where unit_id = a.unit_id and id = b.id;
  end if;
  if s.id is not null then
    update public.upload_sessions set consumed_at = now() where id = s.id;
  end if;

  -- audit (one DELETE per object, as 3.x)
  if v_scope = 'BERKAS' then
    for r in select x.* from public.item x where x.unit_id = a.unit_id and x.id = any (v_targets)
              order by x.no_item_definitif nulls last, x.id loop
      perform app.audit(a, 'DELETE', 'PENGHAPUSAN', 'ITEM', r.id,
        'Item ' || coalesce(r.no_berkas_snapshot::text, b.no_berkas_definitif::text, '–') || '/' || coalesce(r.no_item_definitif::text, '–') ||
        ' dihapus bersama berkas induk', v_audit_reason, p_request_id::text, null,
        pg_catalog.jsonb_build_object('pembatalan_id', v_btl, 'is_deleted', true));
    end loop;
    perform app.audit(a, 'DELETE', 'PENGHAPUSAN', 'BERKAS', b.id,
      'Menghapus berkas ' || coalesce(b.no_berkas_definitif::text, 'DRAFT') || ' – ' || b.judul_berkas || ' beserta ' ||
      pg_catalog.cardinality(v_targets) || ' item', v_audit_reason, p_request_id::text,
      pg_catalog.jsonb_build_object('status_berkas', b.status_berkas, 'is_deleted', false),
      pg_catalog.jsonb_build_object('status_berkas', 'DIHAPUS', 'is_deleted', true, 'pembatalan_id', v_btl, 'quarantine_ids', v_qids));
  else
    perform app.audit(a, 'DELETE', 'PENGHAPUSAN', 'ITEM', i.id,
      'Menghapus item ' || coalesce(b.no_berkas_definitif::text, '–') || '/' || coalesce(i.no_item_definitif::text, '–') || ' – ' ||
      app.clean_text(i.uraian_lengkap, 300), v_audit_reason, p_request_id::text,
      pg_catalog.jsonb_build_object('is_deleted', false, 'no_item', i.no_item_definitif),
      pg_catalog.jsonb_build_object('is_deleted', true, 'pembatalan_id', v_btl, 'quarantine_ids', v_qids));
  end if;

  -- receipt lines back to the filing queue
  v_released := app.release_receipt_sources(a, v_targets);
  if pg_catalog.cardinality(v_released) > 0 then
    perform app.audit(a, 'RELEASE_SOURCE', 'PENGHAPUSAN', 'PENERIMAAN_ITEM', case when v_scope = 'BERKAS' then b.id else i.id end,
      case when v_scope = 'BERKAS' then pg_catalog.cardinality(v_released) || ' sumber penerimaan dikembalikan ke antrean pemberkasan'
           else 'Sumber penerimaan dikembalikan ke antrean pemberkasan' end,
      case when v_scope = 'BERKAS' then 'Berkas definitif dihapus' else 'Item definitif dihapus' end, p_request_id::text,
      null, pg_catalog.jsonb_build_object('receipt_item_ids', pg_catalog.to_jsonb(v_released)));
  end if;

  -- renumbering of what remains (buildReindexPlan_([]) for a berkas, ([parent]) for an item)
  if v_scope = 'BERKAS' then
    v_num := app.renumber_unit(a, '{}', 'Penomoran ulang kronologis setelah penghapusan berkas', p_request_id::text);
  else
    v_num := app.renumber_unit(a, array[b.id], 'Penomoran ulang kronologis setelah penghapusan item', p_request_id::text);
  end if;

  insert into public.pembatalan_arsip (id, unit_id, scope, berkas_id, item_id, item_ids, no_berkas_snapshot, no_item_snapshot,
    judul_berkas_snapshot, uraian_item_snapshot, alasan, bukti_file_id, bukti_url, bukti_nama, bukti_mime, bukti_size_bytes,
    bukti_md5, released_receipt_item_ids, quarantine_ids, request_id, actor_user_id, created_by)
  values (v_btl, a.unit_id, v_scope, b.id, i.id, v_targets, b.no_berkas_definitif, i.no_item_definitif, b.judul_berkas,
    i.uraian_lengkap, v_reason, s.drive_file_id, s.drive_url, s.drive_name, s.mime, s.size_bytes, s.md5, v_released, v_qids,
    p_request_id::text, a.user_id, a.email);

  v_res := pg_catalog.jsonb_build_object('ok', true, 'request_id', p_request_id, 'cancellation_id', v_btl, 'scope', v_scope,
    'berkas_id', b.id, 'item_id', i.id, 'cancelled_item_ids', pg_catalog.to_jsonb(v_targets),
    'cancelled_item_count', pg_catalog.cardinality(v_targets),
    'released_receipt_item_ids', pg_catalog.to_jsonb(v_released), 'quarantine_ids', pg_catalog.to_jsonb(v_qids),
    'evidence_file_id', s.drive_file_id,
    'renumbered_item_count', v_num -> 'renumbered_item_count', 'renumbered_berkas_count', v_num -> 'renumbered_berkas_count',
    'drive_tasks', v_num -> 'drive_tasks', 'warnings', '[]'::jsonb,
    'message', case when v_scope = 'BERKAS'
                    then 'Berkas dan ' || pg_catalog.cardinality(v_targets) || ' item berhasil dihapus dari arsip aktif.'
                    else 'Item berhasil dihapus dan nomor item telah disusun ulang.' end);
  return app.idem_store(a.unit_id, p_request_id, 'ARCHIVE_CANCEL', v_hash, a.user_id, v_res);
end
$$;

insert into public.schema_migrations_log (version, name)
values ('0019', 's3_edit_batal') on conflict (version) do nothing;
