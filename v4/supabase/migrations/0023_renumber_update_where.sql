-- 0023_renumber_update_where.sql
-- Backport to the live renumber function from 0019: a bare UPDATE on the
-- temporary numbering table raises SQLSTATE 21000 under the hosted API guard.
-- Keep the guard enabled and the numbering, audit, and Drive rules unchanged.
-- This function-only hotfix depends on 0019, not on the backup migration 0022.

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

  -- Compute both values in the keyed UPDATE; Supabase rejects a separate UPDATE without WHERE.
  update pg_temp._rn_b t set new_no = o.rn,
    affected = (t.berkas_id = any (coalesce(p_targets, '{}')) or o.rn is distinct from t.old_no)
  from (select x.berkas_id, pg_catalog.row_number() over (
          order by x.earliest, case when x.old_no > 0 then x.old_no end nulls last, b.created_at, b.id) as rn
        from pg_temp._rn_b x join public.berkas b on b.unit_id = a.unit_id and b.id = x.berkas_id) o
  where o.berkas_id = t.berkas_id;

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

insert into public.schema_migrations_log (version, name)
values ('0023', 'renumber_update_where') on conflict (version) do nothing;
