-- 0015_s2_followups.sql
-- Sprint 2 follow-ups from the web/gateway integration (re-runnable; 0010–0014 unchanged):
--   1. App-owned Drive tree: berkas.v4_drive_folder_id and unit settings
--      V4_ROOT_FOLDER_ID / V4_RECEIPT_PROOF_FOLDER_ID. upload_begin returns only v4
--      folder ids; upload_register_folder writes only v4 fields. Legacy
--      drive_folder_id / RECEIPT_PROOF_FOLDER_ID / ARCHIVE_FOLDER_ID stay read-only.
--      Renames after renumbering are queued only for app-owned Drive objects
--      (v4 folders, files committed through upload_commit): the gateway token
--      (drive.file) cannot rename legacy objects.
--   2. drive_task_complete(..., p_permanent): permanent failures end the task at once.
--   3. New berkas take the CF-01 category flags (arsip vital / terjaga); creator
--      snapshot from unit settings; media berkas and item counts derived from the
--      items (centralFileMetadataSummarizeItems_). registration_options exposes them.
-- Contract: v4/supabase/API_S2.md.

alter table public.berkas add column if not exists v4_drive_folder_id text;
comment on column public.berkas.v4_drive_folder_id is
  'Folder in the app-owned Drive tree (writable by the gateway). Legacy drive_folder_id is read-only for v4.';

-- Drive objects the app may write: committed uploads and registered v4 folders.
create or replace function app.is_app_drive_object(p_drive_id text)
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (select 1 from public.upload_sessions where drive_file_id = p_drive_id and status = 'COMMITTED')
      or exists (select 1 from public.berkas where pg_catalog.btrim(v4_drive_folder_id) = p_drive_id)
$$;

-- centralFileMetadataSummarizeItems_: media of a berkas from its active items
create or replace function app.media_berkas(p_unit_id uuid, p_berkas_id text)
returns jsonb
language sql stable security definer
set search_path = ''
as $$
  with i as (
    select case when pg_catalog.upper(pg_catalog.regexp_replace(coalesce(media_sumber, 'TEKSTUAL'), '[-_]+', ' ', 'g')) in ('AUDIOVISUAL', 'AUDIO VISUAL') then 'AUDIO VISUAL'
                when pg_catalog.upper(pg_catalog.regexp_replace(coalesce(media_sumber, 'TEKSTUAL'), '[-_]+', ' ', 'g')) in ('DIGITAL', 'BORN DIGITAL') then 'DIGITAL'
                else 'TEKSTUAL' end as src,
           pg_catalog.upper(pg_catalog.regexp_replace(coalesce(status_bentuk_digital, 'TIDAK ADA'), '[-_]+', ' ', 'g')) as bentuk
    from public.item where unit_id = p_unit_id and berkas_id = p_berkas_id and not is_deleted
  )
  select pg_catalog.jsonb_build_object(
    'media_berkas', case when pg_catalog.count(*) = 0 then 'BELUM DITETAPKAN'
                         when pg_catalog.count(distinct src) = 1 then pg_catalog.min(src) else 'KOMBINASI' end,
    'fisik', pg_catalog.count(*) filter (where bentuk not in ('BORN DIGITAL', 'BORNDIGITAL')),
    'born_digital', pg_catalog.count(*) filter (where bentuk in ('BORN DIGITAL', 'BORNDIGITAL')),
    'alih_media', pg_catalog.count(*) filter (where bentuk = 'ALIH MEDIA'))
  from i
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
  v_ra integer; v_ri integer;
  v_ua text; v_ui text; v_nasib text;
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
  v_ra := app.parse_int(p_target -> 'active_retention_value', 'p_target.active_retention_value', 'Retensi aktif', 0);
  v_ri := app.parse_int(p_target -> 'inactive_retention_value', 'p_target.inactive_retention_value', 'Retensi inaktif', 0);
  v_ua := pg_catalog.upper(app.clean_text(p_target ->> 'active_retention_unit'));
  if v_ua = '' then perform app.fail('INVALID_INPUT', 'Satuan retensi aktif wajib diisi.', '{"field":"p_target.active_retention_unit"}'); end if;
  v_ui := pg_catalog.upper(app.clean_text(p_target ->> 'inactive_retention_unit'));
  if v_ui = '' then perform app.fail('INVALID_INPUT', 'Satuan retensi inaktif wajib diisi.', '{"field":"p_target.inactive_retention_unit"}'); end if;
  v_nasib := pg_catalog.upper(app.clean_text(p_target ->> 'final_disposition'));
  if v_nasib = '' then perform app.fail('INVALID_INPUT', 'Nasib akhir wajib diisi.', '{"field":"p_target.final_disposition"}'); end if;
  if v_ua not in ('TAHUN', 'BULAN') or v_ui not in ('TAHUN', 'BULAN') then
    perform app.fail('INVALID_INPUT', 'Satuan retensi harus TAHUN atau BULAN.', '{"field":"p_target.active_retention_unit"}');
  end if;
  if v_nasib not in ('MUSNAH', 'PERMANEN', 'DINILAI KEMBALI') then
    perform app.fail('INVALID_INPUT', 'Nasib akhir tidak valid.', '{"field":"p_target.final_disposition"}');
  end if;
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
    retensi_inaktif_nilai, retensi_inaktif_satuan, nasib_akhir, status_retensi, no_filling_kabinet, no_laci,
    status_peminjaman, status_berkas, catatan, klasifikasi_keamanan_akses, status_verifikasi_metadata,
    metadata_schema_version, created_at, created_by, updated_at, updated_by, version, is_deleted,
    arsip_vital, arsip_terjaga, pencipta_arsip_snapshot, unit_pencipta_id, unit_pencipta_snapshot)
  values ('BRK-' || gen_random_uuid(), a.unit_id, v_title, v_kategori,
    nullif(app.clean_text(p_target ->> 'pola_pemberkasan', 50), ''), k.id, k.kode_lengkap, k.uraian,
    v_ra, v_ua, v_ri, v_ui, v_nasib, 'MENUNGGU ITEM',
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
  v_today date := app.today_jakarta();
  v_batch text := 'REN-' || app.jakarta_iso(now());
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
         coalesce(p_reason, 'Penomoran ulang kronologis setelah penambahan item'), v_batch, a.email, now(), now(), a.email
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
         coalesce(p_reason, 'Penomoran ulang kronologis setelah penambahan item'), v_batch, a.email, now(), now(), a.email
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

create or replace function public.registration_options(p_unit_id uuid default null)
returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_unit uuid := app.read_unit(p_unit_id);
begin
  return pg_catalog.jsonb_build_object(
    'unit_id', v_unit,
    'berkas', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', b.id, 'number', b.no_berkas_definitif, 'title', b.judul_berkas,
        'classification_code', b.kode_klasifikasi_snapshot,
        'security_classification', app.normalize_security(b.klasifikasi_keamanan_akses),
        'label', coalesce(b.no_berkas_definitif::text || ' – ', 'DRAFT – ') || b.judul_berkas)
        order by coalesce(b.no_berkas_definitif, 999999), b.created_at, b.id)
      from public.berkas b
      where b.unit_id = v_unit and not b.is_deleted
        and pg_catalog.upper(coalesce(b.status_pemindahan, '')) <> 'SUDAH DIPINDAHKAN'), '[]'::jsonb),
    'classifications', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', k.id, 'parent_id', k.parent_id, 'level', k.level, 'code', k.kode_lengkap, 'description', k.uraian,
        'label', k.label_dropdown,
        'selectable', exists (select 1 from public.klasifikasi p where p.unit_id = k.unit_id and p.id = k.parent_id
                                and p.aktif and p.parent_id is null)
                      or not exists (select 1 from public.klasifikasi c where c.unit_id = k.unit_id and c.parent_id = k.id and c.aktif))
        order by k.urutan nulls last, k.kode_lengkap, k.id)
      from public.klasifikasi k where k.unit_id = v_unit and k.aktif), '[]'::jsonb),
    'jenis_naskah', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'jenis_naskah_id', j.jenis_naskah_id, 'kategori', j.kategori, 'subjenis_naskah_id', j.subjenis_naskah_id,
        'subjenis', j.subjenis, 'pola_default', j.pola_default, 'periode_default', j.periode_default,
        'template_judul_berkas', j.template_judul_berkas, 'perlu_kelengkapan', j.perlu_kelengkapan,
        'opsi_kelengkapan', j.opsi_kelengkapan) order by j.urutan nulls last, j.subjenis_naskah_id)
      from public.jenis_naskah j where j.unit_id = v_unit and j.aktif), '[]'::jsonb),
    'retention_units', '["TAHUN","BULAN"]'::jsonb,
    'final_dispositions', '["MUSNAH","PERMANEN","DINILAI KEMBALI"]'::jsonb,
    'security_classifications', '["BIASA/TERBUKA","TERBATAS","RAHASIA","SANGAT RAHASIA"]'::jsonb,
    'development_levels', '["ASLI","COPY"]'::jsonb,
    'archive_categories', '[{"key":"arsip_vital","label":"Arsip vital","default":false},{"key":"arsip_terjaga","label":"Arsip terjaga","default":false}]'::jsonb,
    'media_sources', '["TEKSTUAL","AUDIO VISUAL","DIGITAL"]'::jsonb,
    'media_berkas_values', '["TEKSTUAL","AUDIO VISUAL","DIGITAL","KOMBINASI","BELUM DITETAPKAN"]'::jsonb,
    'archive_creator', pg_catalog.jsonb_build_object(
      'name', coalesce((select s.value #>> '{}' from public.unit_settings s where s.unit_id = v_unit and s.key = 'ARCHIVE_CREATOR_NAME'), 'UIN Sunan Ampel Surabaya'),
      'unit_name', coalesce((select s.value #>> '{}' from public.unit_settings s where s.unit_id = v_unit and s.key = 'UNIT_NAME'),
                            (select u.name from public.units u where u.id = v_unit))));
end
$$;

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
      'folder_path', pg_catalog.to_jsonb(s.folder_path), 'drive_name', s.drive_name,
      'known_folder_id', case when app.is_app_drive_object(s.known_folder_id)
                                or s.known_folder_id = app.setting_text(a.unit_id, 'V4_RECEIPT_PROOF_FOLDER_ID') then s.known_folder_id end,
      'root_folder_id', app.setting_text(a.unit_id, 'V4_ROOT_FOLDER_ID'), 'max_bytes', s.max_bytes,
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
    v_known := nullif(pg_catalog.btrim(b.v4_drive_folder_id), '');
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
    'root_folder_id', app.setting_text(a.unit_id, 'V4_ROOT_FOLDER_ID'), 'max_bytes', s.max_bytes,
    'expires_at', s.expires_at, 'status', s.status, 'replayed', false);
end
$$;

-- ---------------------------------------------------------------------------
-- File ids already bound anywhere (v4 folders included)
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
      or exists (select 1 from public.upload_sessions where drive_file_id = p_drive_id and status = 'COMMITTED'
                   and id is distinct from p_except_session)
$$;

-- ---------------------------------------------------------------------------
-- upload_register_folder: v4 fields only.
--   p_kind 'TARGET' (default via the 4-argument form): the session's folder —
--     ITEM_PDF -> berkas.v4_drive_folder_id; receipt evidence -> V4_RECEIPT_PROOF_FOLDER_ID.
--     canonical "CFFD1\n<session_id>\n<folder_id>\n<attested_at>"
--   p_kind 'ROOT': the unit's app-owned root -> V4_ROOT_FOLDER_ID.
--     canonical "CFFD1\n<session_id>\n<folder_id>\n<attested_at>\nROOT"
-- Values already set are never overwritten.
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
  if v_kind = 'TARGET' and s.purpose = 'ITEM_PDF' then
    update public.berkas b set v4_drive_folder_id = v_folder, updated_at = now(), updated_by = a.email
    from public.item i
    where i.unit_id = s.unit_id and i.id = s.object_id and b.unit_id = i.unit_id and b.id = i.berkas_id
      and nullif(pg_catalog.btrim(b.v4_drive_folder_id), '') is null;
    get diagnostics v_count = row_count;
    update public.upload_sessions set known_folder_id = v_folder where id = s.id;
  else
    v_key := case when v_kind = 'ROOT' then 'V4_ROOT_FOLDER_ID' else 'V4_RECEIPT_PROOF_FOLDER_ID' end;
    insert into public.unit_settings as us (unit_id, key, value, value_type, description, updated_at, updated_by)
    values (s.unit_id, v_key, pg_catalog.to_jsonb(v_folder), 'STRING',
            case when v_kind = 'ROOT' then 'Folder induk Drive milik aplikasi v4 untuk unit ini'
                 else 'Folder bukti penerimaan arsip (Drive milik aplikasi v4)' end, now(), a.email)
    on conflict (unit_id, key) do update set value = excluded.value, updated_at = now(), updated_by = a.email
    where nullif(pg_catalog.btrim(us.value #>> '{}'), '') is null;
    get diagnostics v_count = row_count;
    if v_kind = 'TARGET' then
      update public.upload_sessions set known_folder_id = v_folder where id = s.id;
    end if;
  end if;
  if v_count > 0 then
    perform app.audit(a, 'REGISTER_FOLDER', case when s.purpose = 'ITEM_PDF' then 'ALIH_MEDIA' else 'PENERIMAAN_ARSIP' end,
      'DRIVE_FOLDER', v_folder, 'Mencatat folder Drive v4 (' || v_kind || ') untuk ' || s.object_id, null, s.request_id::text);
  end if;
  return pg_catalog.jsonb_build_object('ok', true, 'folder_id', v_folder, 'kind', v_kind, 'registered', v_count > 0);
end
$$;

-- 4-argument form = p_kind 'TARGET' (same canonical string as before)
create or replace function public.upload_register_folder(p_session_id uuid, p_folder_id text, p_attested_at bigint, p_attestation text)
returns jsonb
language sql volatile security definer
set search_path = ''
as $$
  select public.upload_register_folder(p_session_id, p_folder_id, 'TARGET', p_attested_at, p_attestation)
$$;

-- ---------------------------------------------------------------------------
-- drive_task_complete with p_permanent. A permanent failure (e.g. NOT_APP_FILE,
-- NOT_FOUND) ends the task as FAILED at once; transient failures keep the
-- 5-attempt behaviour. Exactly one RENAME_WARNING audit row per failure report.
-- The 5-argument form is p_permanent = false.
-- ---------------------------------------------------------------------------
create or replace function public.drive_task_complete(p_task_id uuid, p_ok boolean, p_error text, p_permanent boolean,
                                                      p_attested_at bigint, p_attestation text)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  t public.drive_tasks;
  a app.actor;
  v_perm boolean := coalesce(p_permanent, false);
begin
  select * into t from public.drive_tasks where id = p_task_id for update;
  a := app.require_actor_object(t.unit_id, 'Tugas Drive', true);
  if p_ok is null then perform app.fail('INVALID_INPUT', 'Status tugas wajib diisi.', '{"field":"p_ok"}'); end if;
  perform app.attestation_ok('CFDT1' || chr(10) || t.id || chr(10) || case when p_ok then 'ok' else 'fail' end || chr(10)
                             || coalesce(p_attested_at::text, ''), p_attested_at, p_attestation);
  if t.status <> 'PENDING' then
    return pg_catalog.jsonb_build_object('ok', true, 'status', t.status, 'attempts', t.attempts, 'replayed', true);
  end if;
  if p_ok then
    update public.drive_tasks set status = 'DONE', completed_at = now(), attempts = attempts + 1 where id = t.id
    returning * into t;
    return pg_catalog.jsonb_build_object('ok', true, 'status', 'DONE', 'attempts', t.attempts, 'replayed', false);
  end if;
  update public.drive_tasks set attempts = attempts + 1, last_error = pg_catalog.left(coalesce(p_error, ''), 1000),
    status = case when v_perm or attempts + 1 >= 5 then 'FAILED' else 'PENDING' end,
    completed_at = case when v_perm or attempts + 1 >= 5 then now() end
  where id = t.id returning * into t;
  perform app.audit(a, 'RENAME_WARNING', 'PENOMORAN', t.object_type, t.object_id, 'Nama Drive gagal diperbarui',
    case when v_perm then 'PERMANEN: ' else '' end || coalesce(p_error, ''), t.source_request_id, null,
    pg_catalog.jsonb_build_object('task_id', t.id, 'drive_id', t.drive_id, 'new_name', t.new_name, 'permanent', v_perm,
                                  'attempts', t.attempts), 'WARNING');
  return pg_catalog.jsonb_build_object('ok', true, 'status', t.status, 'attempts', t.attempts, 'permanent', v_perm, 'replayed', false);
end
$$;

create or replace function public.drive_task_complete(p_task_id uuid, p_ok boolean, p_error text, p_attested_at bigint, p_attestation text)
returns jsonb
language sql volatile security definer
set search_path = ''
as $$
  select public.drive_task_complete(p_task_id, p_ok, p_error, false, p_attested_at, p_attestation)
$$;

-- ---------------------------------------------------------------------------
-- Privileges + self-check
-- ---------------------------------------------------------------------------
do $$
declare
  f text;
begin
  foreach f in array array['public.upload_register_folder(uuid, text, text, bigint, text)',
                           'public.drive_task_complete(uuid, boolean, text, boolean, bigint, text)',
                           'public.upload_register_folder(uuid, text, bigint, text)',
                           'public.drive_task_complete(uuid, boolean, text, bigint, text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array array['app.is_app_drive_object(text)', 'app.media_berkas(uuid, text)'] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
end
$$;

do $$
declare
  r record;
begin
  for r in select p.oid, n.nspname, p.proname, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname in ('public', 'app') and p.prosecdef loop
    if r.proconfig is null or not ('search_path=""' = any (r.proconfig)) then
      raise exception 's2 followups self-check: %.% is SECURITY DEFINER without an empty search_path', r.nspname, r.proname;
    end if;
    if has_function_privilege('anon', r.oid, 'EXECUTE') then
      raise exception 's2 followups self-check: anon can execute %.%', r.nspname, r.proname;
    end if;
  end loop;
  if has_function_privilege('authenticated', 'app.is_app_drive_object(text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'app.media_berkas(uuid, text)', 'EXECUTE') then
    raise exception 's2 followups self-check: private helper executable by authenticated';
  end if;
end
$$;

insert into public.schema_migrations_log (version, name)
values ('0015', 's2_followups') on conflict (version) do nothing;
