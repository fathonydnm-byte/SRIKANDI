-- Operator-selected retention origin. Record dates still drive chronology only.
-- Existing (and imported legacy) dates are preserved exactly and must be confirmed before a new transfer draft.
alter table public.berkas add column if not exists retensi_acuan_mode text not null default 'LEGACY';
do $$
begin
  if not exists (select 1 from pg_catalog.pg_constraint where conrelid = 'public.berkas'::regclass and conname = 'berkas_retensi_acuan_mode_check') then
    alter table public.berkas add constraint berkas_retensi_acuan_mode_check check (
      retensi_acuan_mode = 'LEGACY'
      or (retensi_acuan_mode = 'MANUAL' and tgl_acuan_retensi is not null and batas_aktif is not null and batas_inaktif is not null)
      or (retensi_acuan_mode = 'PENDING' and tgl_acuan_retensi is null and batas_aktif is null and batas_inaktif is null)
    );
  end if;
end
$$;

create or replace function app.retention_schedule(p jsonb)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  d date := case when nullif(pg_catalog.btrim(p->>'retention_reference_date'), '') is not null
    then app.parse_date(p->>'retention_reference_date', 'retention_reference_date', 'Tanggal acuan retensi') end;
  av integer := app.parse_int(p->'active_retention_value', 'active_retention_value', 'Retensi aktif', 0);
  iv integer := app.parse_int(p->'inactive_retention_value', 'inactive_retention_value', 'Retensi inaktif', 0);
  au text := pg_catalog.upper(app.clean_text(p->>'active_retention_unit'));
  iu text := pg_catalog.upper(app.clean_text(p->>'inactive_retention_unit'));
  fd text := pg_catalog.upper(app.clean_text(p->>'final_disposition'));
  al date;
  il date;
begin
  if au not in ('TAHUN','BULAN') or iu not in ('TAHUN','BULAN') then
    perform app.fail('INVALID_INPUT', 'Satuan retensi harus Tahun atau Bulan.');
  end if;
  if fd not in ('MUSNAH','PERMANEN','DINILAI KEMBALI') then
    perform app.fail('INVALID_INPUT', 'Pilih nasib akhir arsip.');
  end if;
  if av > 12000 or iv > 12000 then
    perform app.fail('INVALID_INPUT', 'Durasi retensi terlalu besar.');
  end if;
  al := app.add_duration(d, av, au);
  il := app.add_duration(al, iv, iu);
  if il > DATE '9999-12-31' then
    perform app.fail('INVALID_INPUT', 'Batas retensi melampaui tahun 9999.');
  end if;
  return pg_catalog.jsonb_build_object(
    'retention_reference_date', d, 'reference_mode', case when d is null then 'PENDING' else 'MANUAL' end,
    'active_retention_value', av, 'active_retention_unit', au, 'inactive_retention_value', iv, 'inactive_retention_unit', iu,
    'final_disposition', fd, 'active_limit', al, 'inactive_limit', il,
    'retention_status', coalesce(app.retention_status(al, app.today_jakarta()), 'MENUNGGU TANGGAL ACUAN'));
end
$$;

create or replace function app.resolve_target_berkas(a app.actor, p_target jsonb, p_initial_security text)
returns public.berkas
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  b public.berkas;
  k public.klasifikasi;
  v_mode text := pg_catalog.upper(app.clean_text(coalesce(p_target ->> 'mode', 'EXISTING')));
  v_title text;
  v_schedule jsonb;
  v_kategori text;
  v_vital boolean;
  v_terjaga boolean;
begin
  if p_target is null or pg_catalog.jsonb_typeof(p_target) <> 'object' then
    perform app.fail('INVALID_INPUT', 'Berkas tujuan wajib dipilih.', '{"field":"p_target"}');
  end if;
  if v_mode not in ('EXISTING', 'NEW') then
    perform app.fail('INVALID_INPUT', 'Mode berkas tidak valid.', '{"field":"p_target.mode"}');
  end if;
  if v_mode = 'EXISTING' then
    if app.clean_text(p_target ->> 'berkas_id') = '' then
      perform app.fail('INVALID_INPUT', 'Berkas tujuan wajib diisi.', '{"field":"p_target.berkas_id"}');
    end if;
    select * into b from public.berkas where unit_id = a.unit_id and id = app.clean_text(p_target ->> 'berkas_id', 80)
       and not is_deleted for update;
    if not found then perform app.fail('NOT_FOUND', 'Berkas tujuan tidak ditemukan.'); end if;
    if pg_catalog.upper(coalesce(b.status_pemindahan, '')) = 'SUDAH DIPINDAHKAN' then
      perform app.fail('BERKAS_TRANSFERRED', 'Berkas sudah dipindahkan ke arsip inaktif dan tidak dapat menerima item.');
    end if;
    return b;
  end if;

  v_title := app.clean_text(p_target ->> 'title', 500);
  if v_title = '' then perform app.fail('INVALID_INPUT', 'Judul berkas wajib diisi.', '{"field":"p_target.title"}'); end if;
  k := app.validate_classification(a.unit_id, p_target ->> 'classification_id');
  v_schedule := app.retention_schedule(p_target);
  v_kategori := nullif(app.clean_text(p_target ->> 'kategori_naskah_id', 80), '');
  if v_kategori is not null and not exists (select 1 from public.jenis_naskah j where j.unit_id = a.unit_id
                                             and j.jenis_naskah_id = v_kategori and j.aktif) then
    perform app.fail('INVALID_INPUT', 'Jenis naskah tidak aktif atau tidak ditemukan.', '{"field":"p_target.kategori_naskah_id"}');
  end if;

  -- CF-01 category flags (default false, as the 3.x backfill)
  begin
    v_vital := coalesce((p_target ->> 'arsip_vital')::boolean, false);
    v_terjaga := coalesce((p_target ->> 'arsip_terjaga')::boolean, false);
  exception when others then
    perform app.fail('INVALID_INPUT', 'Kategori arsip vital/terjaga harus benar atau salah.', '{"field":"p_target.arsip_vital"}');
  end;

  insert into public.berkas (id, unit_id, judul_berkas, kategori_naskah_id, pola_pemberkasan, klasifikasi_id,
    kode_klasifikasi_snapshot, uraian_klasifikasi_snapshot, retensi_aktif_nilai, retensi_aktif_satuan,
    retensi_inaktif_nilai, retensi_inaktif_satuan, nasib_akhir, status_retensi, retensi_acuan_mode, tgl_acuan_retensi, batas_aktif, batas_inaktif, no_filling_kabinet, no_laci,
    status_peminjaman, status_berkas, catatan, klasifikasi_keamanan_akses, status_verifikasi_metadata,
    metadata_schema_version, created_at, created_by, updated_at, updated_by, version, is_deleted,
    arsip_vital, arsip_terjaga, pencipta_arsip_snapshot, unit_pencipta_id, unit_pencipta_snapshot)
  values ('BRK-' || gen_random_uuid(), a.unit_id, v_title, v_kategori,
    nullif(app.clean_text(p_target ->> 'pola_pemberkasan', 50), ''), k.id, k.kode_lengkap, k.uraian,
    (v_schedule->>'active_retention_value')::int, v_schedule->>'active_retention_unit',
    (v_schedule->>'inactive_retention_value')::int, v_schedule->>'inactive_retention_unit',
    v_schedule->>'final_disposition', v_schedule->>'retention_status', v_schedule->>'reference_mode',
    (v_schedule->>'retention_reference_date')::date, (v_schedule->>'active_limit')::date, (v_schedule->>'inactive_limit')::date,
    nullif(app.clean_text(p_target ->> 'filing_cabinet', 50), ''), nullif(app.clean_text(p_target ->> 'drawer', 50), ''),
    'TERSEDIA', 'DRAFT', nullif(app.clean_text(coalesce(p_target ->> 'notes', p_target ->> 'berkas_notes'), 1000), ''),
    coalesce(p_initial_security, 'BIASA/TERBUKA'), 'TERVERIFIKASI', 4, now(), a.email, now(), a.email, 1, false,
    v_vital, v_terjaga,
    coalesce(app.setting_text(a.unit_id, 'ARCHIVE_CREATOR_NAME'), 'UIN Sunan Ampel Surabaya'),
    coalesce(app.setting_text(a.unit_id, 'UNIT_ID'), (select u.legacy_unit_id from public.units u where u.id = a.unit_id)),
    coalesce(app.setting_text(a.unit_id, 'UNIT_NAME'), (select u.name from public.units u where u.id = a.unit_id)))
  returning * into b;
  return b;
end
$$;

create or replace function app.renumber_unit(a app.actor, p_targets text[], p_reason text, p_request_id text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
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
    tgl_item_awal = t.earliest, tgl_item_akhir = t.latest, tgl_urut_berkas = t.earliest,
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

create or replace function app.transfer_block(p_berkas public.berkas, p_items bigint, p_borrowed boolean)
returns text language sql stable set search_path = '' as $$
  select case
    when p_berkas.is_deleted or p_berkas.status_berkas <> 'AKTIF' or p_berkas.no_berkas_definitif is null then 'Berkas belum aktif dan bernomor definitif.'
    when upper(btrim(coalesce(p_berkas.status_pemindahan,''))) = 'SUDAH DIPINDAHKAN' then 'Berkas sudah dipindahkan.'
    when nullif(btrim(p_berkas.usul_pindah_id_aktif),'') is not null then 'Berkas sudah berada dalam usul pemindahan.'
    when p_berkas.retensi_acuan_mode = 'LEGACY' then 'Konfirmasi tanggal acuan retensi lama di Perubahan Arsip.'
    when p_berkas.retensi_acuan_mode = 'PENDING' then 'Tanggal acuan retensi belum ditetapkan.'
    when p_berkas.batas_aktif is null or p_berkas.batas_aktif >= app.today_jakarta() then 'Masa retensi aktif belum berakhir.'
    when p_borrowed then 'Berkas atau salah satu item sedang dipinjam.'
    when p_items = 0 then 'Berkas belum memiliki item aktif.'
    when coalesce(p_berkas.status_verifikasi_metadata,'') <> 'TERVERIFIKASI' then 'Metadata berkas belum terverifikasi.'
  end
$$;

create or replace function app.retention_snapshot(b public.berkas)
returns jsonb language sql stable set search_path = '' as $$
  select pg_catalog.jsonb_build_object(
    'reference_mode', b.retensi_acuan_mode, 'retention_reference_date', b.tgl_acuan_retensi,
    'active_retention_value', b.retensi_aktif_nilai, 'active_retention_unit', b.retensi_aktif_satuan,
    'inactive_retention_value', b.retensi_inaktif_nilai, 'inactive_retention_unit', b.retensi_inaktif_satuan,
    'final_disposition', b.nasib_akhir, 'active_limit', b.batas_aktif, 'inactive_limit', b.batas_inaktif)
$$;

create or replace function app.retention_edit_block(b public.berkas)
returns text language sql stable set search_path = '' as $$
  select case
    when pg_catalog.upper(pg_catalog.btrim(coalesce(b.status_pemindahan, ''))) = 'SUDAH DIPINDAHKAN'
      then 'Berkas sudah dipindahkan. Jadwal tidak dapat diubah dari Central File.'
    when nullif(pg_catalog.btrim(b.usul_pindah_id_aktif), '') is not null
      then 'Batalkan draf usul pemindahan terkait sebelum mengubah jadwal retensi.'
    when pg_catalog.upper(pg_catalog.btrim(coalesce(b.status_peminjaman, 'TERSEDIA'))) <> 'TERSEDIA'
      or exists (select 1 from public.item i where i.unit_id=b.unit_id and i.berkas_id=b.id and not i.is_deleted
        and pg_catalog.upper(pg_catalog.btrim(coalesce(i.status_peminjaman,'TERSEDIA'))) <> 'TERSEDIA')
      then 'Berkas atau salah satu item sedang dipinjam.'
    end
$$;

create or replace function public.berkas_retention_get(p_berkas_id text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare b public.berkas;
begin
  select * into b from public.berkas where id = app.clean_text(p_berkas_id, 80) and not is_deleted
    and status_berkas not in ('DIHAPUS','GAGAL');
  perform app.require_actor_object(b.unit_id, 'Berkas', true);
  return app.retention_snapshot(b) || pg_catalog.jsonb_build_object(
    'version', coalesce(b.version,0), 'blocked_reason', app.retention_edit_block(b));
end
$$;

create or replace function public.berkas_retention_update(
  p_request_id uuid, p_berkas_id text, p_expected_version bigint, p_schedule jsonb, p_reason text
)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  b public.berkas;
  saved public.berkas;
  a app.actor;
  v_reason text := app.clean_text(p_reason, 2000);
  v_limits jsonb;
  v_hash text;
  v_replayed jsonb;
  v_block text;
begin
  select * into b from public.berkas where id = app.clean_text(p_berkas_id, 80);
  a := app.require_actor_object(b.unit_id, 'Berkas', true);
  perform app.lock_unit(a.unit_id);
  v_hash := pg_catalog.md5(pg_catalog.jsonb_build_array(b.id,p_expected_version,p_schedule,p_reason)::text);
  v_replayed := app.idem_lookup(a.unit_id,p_request_id,'BERKAS_RETENTION_UPDATE',v_hash);
  if v_replayed is not null then return v_replayed; end if;
  select * into b from public.berkas where id = b.id and unit_id = a.unit_id and not is_deleted
    and status_berkas not in ('DIHAPUS','GAGAL') for update;
  if not found then perform app.fail('NOT_FOUND', 'Berkas tidak ditemukan.'); end if;
  v_block := app.retention_edit_block(b);
  if v_block is not null then perform app.fail('RETENTION_LOCKED', v_block); end if;
  if p_expected_version is distinct from coalesce(b.version,0)::bigint then
    perform app.fail('VERSION_CONFLICT', 'Berkas berubah sejak dibuka. Muat ulang sebelum menyimpan.');
  end if;
  if pg_catalog.length(v_reason) < 10 then
    perform app.fail('INVALID_INPUT', 'Alasan perubahan minimal 10 karakter.');
  end if;
  v_limits := app.retention_schedule(p_schedule);
  if app.retention_snapshot(b) = v_limits - 'retention_status' then
    perform app.fail('NO_CHANGES', 'Tidak ada perubahan jadwal retensi.');
  end if;
  update public.berkas set retensi_acuan_mode=v_limits->>'reference_mode',
    tgl_acuan_retensi=(v_limits->>'retention_reference_date')::date,
    retensi_aktif_nilai=(v_limits->>'active_retention_value')::int, retensi_aktif_satuan=v_limits->>'active_retention_unit',
    retensi_inaktif_nilai=(v_limits->>'inactive_retention_value')::int, retensi_inaktif_satuan=v_limits->>'inactive_retention_unit',
    nasib_akhir=v_limits->>'final_disposition', batas_aktif=(v_limits->>'active_limit')::date,
    batas_inaktif=(v_limits->>'inactive_limit')::date, status_retensi=v_limits->>'retention_status',
    updated_at=now(), updated_by=a.email, version=coalesce(b.version,0)+1
  where unit_id=a.unit_id and id=b.id returning * into saved;
  perform app.audit(a,'UPDATE_RETENTION','EDIT_ARSIP','BERKAS',b.id,'Mengubah jadwal retensi berkas',v_reason,p_request_id::text,
    app.retention_snapshot(b),app.retention_snapshot(saved));
  return app.idem_store(a.unit_id,p_request_id,'BERKAS_RETENTION_UPDATE',v_hash,a.user_id,
    app.retention_snapshot(saved) || pg_catalog.jsonb_build_object('version',saved.version,'blocked_reason',null));
end
$$;

revoke all on function app.retention_schedule(jsonb), app.retention_snapshot(public.berkas),
  app.retention_edit_block(public.berkas), public.berkas_retention_get(text),
  public.berkas_retention_update(uuid,text,bigint,jsonb,text) from public, anon, authenticated, service_role;
grant execute on function public.berkas_retention_get(text),public.berkas_retention_update(uuid,text,bigint,jsonb,text) to authenticated;

insert into public.schema_migrations_log(version,name) values ('0028','manual_retention') on conflict (version) do nothing;
