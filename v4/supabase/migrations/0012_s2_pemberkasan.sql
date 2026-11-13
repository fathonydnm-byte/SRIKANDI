-- 0012_s2_pemberkasan.sql
-- Pemberkasan RPCs, ported from ReceiptFilingService.js, ItemService.js,
-- NumberingService.js, Services.js and MediaService.js (3.32.5):
--   registration_options, filing_options, media_options (reads)
--   filing_commit, filing_recover, item_create_manual (writes)
--   app.renumber_unit — chronological renumbering (buildBatchNumberingPlan_ +
--   buildNumberingOperations_), run inside the unit lock.
-- Contract: v4/supabase/API_S2.md. Idempotent; no BEGIN/COMMIT.

-- ---------------------------------------------------------------------------
-- validateClassification_: active; a row that is not secondary (its parent is
-- not an active primary) must not have active children. So secondary is valid
-- with or without tertiary; a primary with children is not; a leaf is.
-- ---------------------------------------------------------------------------
create or replace function app.validate_classification(p_unit_id uuid, p_id text)
returns public.klasifikasi
language plpgsql stable security definer
set search_path = ''
as $$
declare
  k public.klasifikasi;
  v_secondary boolean;
begin
  if app.clean_text(p_id) = '' then
    perform app.fail('INVALID_INPUT', 'Kode klasifikasi wajib diisi.', '{"field":"classification_id"}');
  end if;
  select * into k from public.klasifikasi where unit_id = p_unit_id and id = app.clean_text(p_id, 80) and aktif;
  if not found then
    perform app.fail('CLASSIFICATION_INVALID', 'Kode klasifikasi tidak aktif atau tidak ditemukan.');
  end if;
  v_secondary := exists (select 1 from public.klasifikasi p
                          where p.unit_id = p_unit_id and p.id = k.parent_id and p.aktif and p.parent_id is null);
  if not v_secondary and exists (select 1 from public.klasifikasi c where c.unit_id = p_unit_id and c.parent_id = k.id and c.aktif) then
    perform app.fail('CLASSIFICATION_INVALID', 'Pilih kode klasifikasi sekunder atau tersier sesuai masalah arsip.');
  end if;
  return k;
end
$$;

create or replace function app.security_label(p_rank integer)
returns text
language sql immutable
set search_path = ''
as $$
  select case p_rank when 4 then 'SANGAT RAHASIA' when 3 then 'RAHASIA' when 2 then 'TERBATAS' else 'BIASA/TERBUKA' end
$$;

-- ---------------------------------------------------------------------------
-- Target berkas: EXISTING (validated) or NEW (normalizeNewBerkasPayload_, inserted as DRAFT)
-- ---------------------------------------------------------------------------
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

  insert into public.berkas (id, unit_id, judul_berkas, kategori_naskah_id, pola_pemberkasan, klasifikasi_id,
    kode_klasifikasi_snapshot, uraian_klasifikasi_snapshot, retensi_aktif_nilai, retensi_aktif_satuan,
    retensi_inaktif_nilai, retensi_inaktif_satuan, nasib_akhir, status_retensi, no_filling_kabinet, no_laci,
    status_peminjaman, status_berkas, catatan, klasifikasi_keamanan_akses, status_verifikasi_metadata,
    metadata_schema_version, created_at, created_by, updated_at, updated_by, version, is_deleted)
  values ('BRK-' || gen_random_uuid(), a.unit_id, v_title, v_kategori,
    nullif(app.clean_text(p_target ->> 'pola_pemberkasan', 50), ''), k.id, k.kode_lengkap, k.uraian,
    v_ra, v_ua, v_ri, v_ui, v_nasib, 'MENUNGGU ITEM',
    nullif(app.clean_text(p_target ->> 'filing_cabinet', 50), ''), nullif(app.clean_text(p_target ->> 'drawer', 50), ''),
    'TERSEDIA', 'DRAFT', nullif(app.clean_text(coalesce(p_target ->> 'notes', p_target ->> 'berkas_notes'), 1000), ''),
    coalesce(p_initial_security, 'BIASA/TERBUKA'), 'TERVERIFIKASI', 4, now(), a.email, now(), a.email, 1, false)
  returning * into b;
  return b;
end
$$;

-- ---------------------------------------------------------------------------
-- app.renumber_unit: chronological renumbering of a whole unit.
-- Must be called with the unit lock held, after the new rows are inserted
-- (new items with no_item_definitif / nama_file NULL, new berkas without number).
-- ---------------------------------------------------------------------------
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
  create temp table if not exists _rn_i (
    item_id text primary key, berkas_id text, old_no integer, new_no integer, old_snapshot integer,
    new_snapshot integer, old_nama text, new_nama text, drive_file_id text) on commit drop;
  truncate pg_temp._rn_b, pg_temp._rn_i;

  insert into pg_temp._rn_b (berkas_id, old_no, earliest, latest, cnt, pages, min_year, max_year, sec_rank, judul, drive_folder_id)
  select b.id, b.no_berkas_definitif, pg_catalog.min(i.tanggal_naskah), pg_catalog.max(i.tanggal_naskah), pg_catalog.count(*)::int,
         pg_catalog.sum(coalesce(i.jumlah_halaman, 0))::int,
         pg_catalog.min(pg_catalog.date_part('year', i.tanggal_naskah))::int, pg_catalog.max(pg_catalog.date_part('year', i.tanggal_naskah))::int,
         pg_catalog.max(app.security_rank(i.klasifikasi_keamanan_akses)), b.judul_berkas, nullif(pg_catalog.btrim(b.drive_folder_id), '')
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
         nullif(pg_catalog.btrim(i.drive_file_id), '')
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
-- registration_options (read) — apiGetBootstrap (registration parts)
-- ---------------------------------------------------------------------------
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
    'development_levels', '["ASLI","COPY"]'::jsonb);
end
$$;

-- ---------------------------------------------------------------------------
-- filing_options (read) — apiGetReceiptFilingOptions
-- ---------------------------------------------------------------------------
create or replace function public.filing_options(p_unit_id uuid default null)
returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_unit uuid := app.read_unit(p_unit_id);
  v_queue jsonb;
  v_total integer;
  v_pending integer;
  v_incomplete integer;
  v_filed integer;
begin
  with rows as (
    select pi.*, p.nomor_tanda_terima, p.tanggal_waktu_terima, p.nama_penyerah_snapshot, p.unit_penyerah_snapshot,
           app.receipt_filing_status(pi.status_pemberkasan, pi.tanggal_naskah) as st,
           app.receipt_item_complete(pi.arsip_id, pi.tanggal_naskah, pi.uraian_informasi, pi.jumlah_halaman,
             pi.tingkat_perkembangan, pi.kondisi, pi.klasifikasi_keamanan_akses) as complete
    from public.penerimaan_item pi
    join public.penerimaan p on p.unit_id = pi.unit_id and p.id = pi.penerimaan_id
    where pi.unit_id = v_unit and not pi.is_deleted and pg_catalog.upper(coalesce(p.status, '')) = 'AKTIF'
  ), q as (
    select * from rows where st in ('BELUM DIBERKASKAN', 'PERLU DILENGKAPI')
  )
  select (select pg_catalog.count(*) from q), (select pg_catalog.count(*) from rows where st = 'BELUM DIBERKASKAN'),
         (select pg_catalog.count(*) from rows where st = 'PERLU DILENGKAPI'), (select pg_catalog.count(*) from rows where st = 'SUDAH DIBERKASKAN'),
         (select pg_catalog.jsonb_agg(x.j order by x.tanggal_waktu_terima, x.nomor_tanda_terima collate app.natural_ci, x.no_item, x.id) from (
            select q.*, pg_catalog.jsonb_build_object(
              'id', q.id, 'archive_id', q.arsip_id, 'receipt_id', q.penerimaan_id, 'receipt_number', q.nomor_tanda_terima,
              'receipt_item_number', q.no_item, 'received_at', q.tanggal_waktu_terima,
              'sender_name', app.clean_text(q.nama_penyerah_snapshot, 250), 'sender_unit', app.clean_text(q.unit_penyerah_snapshot, 250),
              'primary_letter_number', app.clean_text(q.no_surat_utama, 250), 'alternate_letter_number', app.clean_text(q.no_surat_alternatif, 250),
              'document_date', q.tanggal_naskah, 'description', app.clean_text(q.uraian_informasi, 2000),
              'page_count', coalesce(q.jumlah_halaman, 0), 'development_level', pg_catalog.upper(coalesce(q.tingkat_perkembangan, '')),
              'condition', pg_catalog.upper(coalesce(q.kondisi, '')), 'security_classification', app.normalize_security(q.klasifikasi_keamanan_akses),
              'notes', app.clean_text(q.catatan_item, 1000), 'status', q.st,
              'selectable', q.st = 'BELUM DIBERKASKAN' and q.complete) as j
            from q order by q.tanggal_waktu_terima, q.nomor_tanda_terima collate app.natural_ci, q.no_item, q.id limit 500) x)
    into v_total, v_pending, v_incomplete, v_filed, v_queue;
  return pg_catalog.jsonb_build_object('ok', true, 'unit_id', v_unit, 'items', coalesce(v_queue, '[]'::jsonb),
    'total_queue', v_total, 'truncated', v_total > 500,
    'summary', pg_catalog.jsonb_build_object('pending', v_pending, 'incomplete', v_incomplete, 'filed', v_filed),
    'max_batch_size', 100);
end
$$;

-- ---------------------------------------------------------------------------
-- media_options (read) — apiGetMediaUploadOptions: items without PDF
-- ---------------------------------------------------------------------------
create or replace function public.media_options(p_unit_id uuid default null)
returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_unit uuid := app.read_unit(p_unit_id);
begin
  return (
    with missing as (
      select i.*, b.no_berkas_definitif as bno, b.judul_berkas
      from public.item i join public.berkas b on b.unit_id = i.unit_id and b.id = i.berkas_id and not b.is_deleted
      where i.unit_id = v_unit and not i.is_deleted and nullif(pg_catalog.btrim(i.drive_file_id), '') is null
    ), per_berkas as (
      select berkas_id, pg_catalog.min(bno) as bno, pg_catalog.min(judul_berkas) as judul, pg_catalog.count(*) as n,
             pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', id, 'number', no_item_definitif,
               'description', coalesce(uraian_lengkap, ''), 'document_date', tanggal_naskah,
               'page_count', coalesce(jumlah_halaman, 0), 'file_status', coalesce(status_file, 'BELUM DIUNGGAH'),
               'planned_file_name', coalesce(nama_file, ''),
               'label', coalesce(no_item_definitif::text, '–') || ' – ' || app.clean_text(coalesce(nullif(uraian_lengkap, ''), 'Tanpa uraian'), 140))
               order by no_item_definitif nulls last, id) as items
      from missing group by berkas_id
    )
    select pg_catalog.jsonb_build_object('ok', true, 'unit_id', v_unit,
      'berkas', coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', berkas_id, 'number', bno, 'title', judul,
          'label', coalesce(bno::text, 'DRAFT') || ' – ' || judul || ' (' || n || ' belum ada PDF)', 'items', items)
          order by coalesce(bno, 999999), berkas_id), '[]'::jsonb),
      'total_missing', coalesce(pg_catalog.sum(n), 0))
    from per_berkas);
end
$$;

-- ---------------------------------------------------------------------------
-- filing_commit — apiCommitReceiptFiling
-- ---------------------------------------------------------------------------
create or replace function public.filing_commit(p_request_id uuid, p_receipt_item_ids text[], p_target jsonb,
                                                p_unit_id uuid default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  a app.actor := app.require_actor(p_unit_id, true);
  v_hash text := pg_catalog.md5(pg_catalog.jsonb_build_object('ids', pg_catalog.to_jsonb(p_receipt_item_ids), 'target', p_target)::text);
  v_prev jsonb;
  v_ids text[];
  v_n integer;
  src record;
  b public.berkas;
  v_idx integer := 0;
  v_dup record;
  v_num jsonb;
  v_items jsonb;
  v_pages integer;
  v_receipts integer;
  v_res jsonb;
begin
  perform app.lock_unit(a.unit_id);
  v_prev := app.idem_lookup(a.unit_id, p_request_id, 'FILING_COMMIT', v_hash);
  if v_prev is not null then return v_prev; end if;

  -- normalizeReceiptFilingItemIds_
  if p_receipt_item_ids is null or pg_catalog.cardinality(p_receipt_item_ids) = 0 then
    perform app.fail('INVALID_INPUT', 'Pilih minimal satu item dari Penerimaan Arsip.', '{"field":"p_receipt_item_ids"}');
  end if;
  if pg_catalog.cardinality(p_receipt_item_ids) > 100 then
    perform app.fail('BATCH_LIMIT', 'Satu transaksi maksimal memuat 100 item arsip.', '{"field":"p_receipt_item_ids"}');
  end if;
  select pg_catalog.array_agg(app.clean_text(x, 90)) into v_ids from pg_catalog.unnest(p_receipt_item_ids) x;
  if exists (select 1 from pg_catalog.unnest(v_ids) x where x = '') then
    perform app.fail('INVALID_INPUT', 'ID item penerimaan wajib diisi.', '{"field":"p_receipt_item_ids"}');
  end if;
  if (select pg_catalog.count(distinct x) from pg_catalog.unnest(v_ids) x) <> pg_catalog.cardinality(v_ids) then
    perform app.fail('INVALID_INPUT', 'Item yang sama dipilih lebih dari satu kali.', '{"field":"p_receipt_item_ids"}');
  end if;
  v_n := pg_catalog.cardinality(v_ids);

  -- normalizeReceiptFilingContext_
  perform 1 from public.penerimaan_item pi where pi.unit_id = a.unit_id and pi.id = any (v_ids) for update;
  if (select pg_catalog.count(*) from public.penerimaan_item pi where pi.unit_id = a.unit_id and pi.id = any (v_ids) and not pi.is_deleted) <> v_n then
    perform app.fail('NOT_FOUND', 'Sebagian item tidak ditemukan. Segarkan antrean lalu pilih kembali.');
  end if;
  for src in
    select pi.*, p.status as receipt_status, p.nomor_tanda_terima, p.tanggal_waktu_terima
    from public.penerimaan_item pi
    left join public.penerimaan p on p.unit_id = pi.unit_id and p.id = pi.penerimaan_id
    where pi.unit_id = a.unit_id and pi.id = any (v_ids)
    order by pi.created_at, pi.penerimaan_id, pi.no_item, pi.id
  loop
    if src.receipt_status is null or pg_catalog.upper(src.receipt_status) <> 'AKTIF' then
      perform app.fail('RECEIPT_CANCELLED', 'Tanda terima asal item sudah dibatalkan atau tidak tersedia.');
    end if;
    if app.receipt_filing_status(src.status_pemberkasan, src.tanggal_naskah) = 'SUDAH DIBERKASKAN' then
      perform app.fail('ITEM_ALREADY_FILED', 'Item ' || src.id || ' sudah diberkaskan.');
    end if;
    if app.receipt_filing_status(src.status_pemberkasan, src.tanggal_naskah) <> 'BELUM DIBERKASKAN'
       or not app.receipt_item_complete(src.arsip_id, src.tanggal_naskah, src.uraian_informasi, src.jumlah_halaman,
                                        src.tingkat_perkembangan, src.kondisi, src.klasifikasi_keamanan_akses)
       or app.valid_security(src.klasifikasi_keamanan_akses) is null
       or pg_catalog.upper(coalesce(src.tingkat_perkembangan, '')) not in ('ASLI', 'COPY') then
      perform app.fail('ITEM_NOT_READY', 'Metadata item ' || src.id || ' belum lengkap. Lengkapi melalui Penerimaan Arsip.');
    end if;
    select i.no_berkas_snapshot, i.no_item_definitif into v_dup from public.item i
     where i.unit_id = a.unit_id and not i.is_deleted
       and (i.penerimaan_item_id = src.id or (app.clean_text(src.arsip_id) <> '' and i.arsip_id = src.arsip_id))
     limit 1;
    if found then
      perform app.fail('SOURCE_ALREADY_ACTIVE', 'Item ' || src.id || ' sudah memiliki arsip definitif aktif ' ||
        coalesce(v_dup.no_berkas_snapshot::text, '–') || '/' || coalesce(v_dup.no_item_definitif::text, '–') || '.');
    end if;
  end loop;

  b := app.resolve_target_berkas(a, p_target, 'BIASA/TERBUKA');

  -- new definitive items (numbers assigned by renumbering)
  for src in
    select pi.*, p.nomor_tanda_terima, p.tanggal_waktu_terima
    from public.penerimaan_item pi join public.penerimaan p on p.unit_id = pi.unit_id and p.id = pi.penerimaan_id
    where pi.unit_id = a.unit_id and pi.id = any (v_ids)
    order by pi.created_at, pi.penerimaan_id, pi.no_item, pi.id
  loop
    v_idx := v_idx + 1;
    insert into public.item (id, unit_id, berkas_id, no_surat_utama, no_surat_alternatif, no_surat_display, tanggal_naskah,
      tahun_kurun_waktu, uraian_lengkap, uraian_nama_file, jumlah_halaman, tingkat_perkembangan, klasifikasi_keamanan_akses,
      kode_klasifikasi_snapshot, lampiran, status_file, status_peminjaman, sort_no_surat_normalized, sort_created_at, catatan,
      created_at, created_by, updated_at, updated_by, version, is_deleted, arsip_id, sumber_registrasi, penerimaan_id,
      penerimaan_item_id, nomor_tanda_terima_snapshot, kondisi_fisik, media_sumber, status_bentuk_digital,
      status_verifikasi_metadata, metadata_schema_version)
    values ('ITM-' || gen_random_uuid(), a.unit_id, b.id,
      nullif(app.clean_text(src.no_surat_utama, 250), ''), nullif(app.clean_text(src.no_surat_alternatif, 250), ''),
      app.display_letter(app.clean_text(src.no_surat_utama, 250), app.clean_text(src.no_surat_alternatif, 250)),
      src.tanggal_naskah, pg_catalog.date_part('year', src.tanggal_naskah)::int,
      app.clean_text(src.uraian_informasi, 2000), app.clean_file_name(src.uraian_informasi), src.jumlah_halaman,
      pg_catalog.upper(src.tingkat_perkembangan), app.valid_security(src.klasifikasi_keamanan_akses),
      b.kode_klasifikasi_snapshot, '[]'::jsonb, 'BELUM DIUNGGAH', 'TERSEDIA',
      app.normalized_letter(src.no_surat_utama, src.no_surat_alternatif),
      app.jakarta_iso(coalesce(src.created_at, src.tanggal_waktu_terima)) || '-' || pg_catalog.lpad(v_idx::text, 3, '0'),
      nullif(app.clean_text(src.catatan_item, 1000), ''), now(), a.email, now(), a.email, 1, false,
      src.arsip_id, 'PENERIMAAN_ARSIP', src.penerimaan_id, src.id, src.nomor_tanda_terima, nullif(src.kondisi, ''),
      coalesce(nullif(src.media_sumber, ''), 'TEKSTUAL'), coalesce(nullif(src.status_bentuk_digital, ''), 'TIDAK ADA'),
      'TERVERIFIKASI', 4);
  end loop;

  v_num := app.renumber_unit(a, array[b.id], 'Penomoran ulang kronologis setelah pemberkasan item penerimaan', p_request_id::text);

  -- mark sources filed with the final numbers
  update public.penerimaan_item pi set status_pemberkasan = 'SUDAH DIBERKASKAN', berkas_id_tujuan = i.berkas_id,
    item_id_definitif = i.id, no_berkas_definitif_snapshot = i.no_berkas_snapshot, no_item_definitif_snapshot = i.no_item_definitif,
    diberkaskan_at = now(), diberkaskan_by = a.email, pemberkasan_request_id = p_request_id::text,
    updated_at = now(), updated_by = a.email
  from public.item i
  where pi.unit_id = a.unit_id and pi.id = any (v_ids) and i.unit_id = a.unit_id and i.penerimaan_item_id = pi.id and not i.is_deleted;

  select * into b from public.berkas where unit_id = a.unit_id and id = b.id;
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('receipt_item_id', i.penerimaan_item_id, 'item_id', i.id,
           'berkas_number', i.no_berkas_snapshot, 'item_number', i.no_item_definitif, 'description', i.uraian_lengkap)
           order by i.no_item_definitif),
         pg_catalog.sum(coalesce(i.jumlah_halaman, 0)), pg_catalog.count(distinct i.penerimaan_id)
    into v_items, v_pages, v_receipts
    from public.item i where i.unit_id = a.unit_id and i.penerimaan_item_id = any (v_ids) and not i.is_deleted;

  perform app.audit(a, 'FILE_BATCH', 'PEMBERKASAN_PENERIMAAN', 'BATCH', p_request_id::text,
    v_n || ' item penerimaan masuk ke Berkas ' || b.no_berkas_definitif,
    v_receipts || ' tanda terima · target ' || b.judul_berkas, p_request_id::text,
    null, pg_catalog.jsonb_build_object('berkas_id', b.id, 'items', v_items, 'renumbering', v_num - 'drive_tasks'));

  v_res := pg_catalog.jsonb_build_object('ok', true, 'request_id', p_request_id, 'berkas_id', b.id,
    'berkas_number', b.no_berkas_definitif, 'berkas_title', b.judul_berkas, 'item_count', v_n, 'total_pages', v_pages,
    'renumbered_item_count', v_num -> 'renumbered_item_count', 'renumbered_berkas_count', v_num -> 'renumbered_berkas_count',
    'items', v_items, 'drive_tasks', v_num -> 'drive_tasks', 'warnings', '[]'::jsonb,
    'message', v_n || ' item berhasil diberkaskan ke Berkas ' || b.no_berkas_definitif || '.');
  return app.idem_store(a.unit_id, p_request_id, 'FILING_COMMIT', v_hash, a.user_id, v_res);
end
$$;

-- ---------------------------------------------------------------------------
-- filing_recover — apiRecoverReceiptFiling
-- ---------------------------------------------------------------------------
create or replace function public.filing_recover(p_request_id uuid, p_unit_id uuid default null)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  a app.actor := app.require_actor(p_unit_id, true);
  v jsonb;
begin
  if p_request_id is null then perform app.fail('INVALID_INPUT', 'ID permintaan wajib diisi.', '{"field":"p_request_id"}'); end if;
  select response into v from public.idempotency_keys
   where unit_id = a.unit_id and request_id = p_request_id::text and operation = 'FILING_COMMIT';
  if v is null then
    return pg_catalog.jsonb_build_object('ok', true, 'found', false, 'request_id', p_request_id);
  end if;
  return v || pg_catalog.jsonb_build_object('found', true, 'recovered', true,
    'message', 'Pemberkasan sudah tersimpan dan dipulihkan tanpa data ganda.');
end
$$;

-- ---------------------------------------------------------------------------
-- item_create_manual — apiCommitItemMetadata (Input Manual; PDF afterwards)
-- ---------------------------------------------------------------------------
create or replace function public.item_create_manual(p_request_id uuid, p_target jsonb, p_item jsonb, p_unit_id uuid default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  a app.actor := app.require_actor(p_unit_id, true);
  v_hash text := pg_catalog.md5(pg_catalog.jsonb_build_object('target', p_target, 'item', p_item)::text);
  v_prev jsonb;
  b public.berkas;
  i public.item;
  v_pages integer;
  v_dev text;
  v_sec text;
  v_desc text;
  v_date date;
  v_primary text;
  v_alt text;
  v_num jsonb;
  v_res jsonb;
begin
  perform app.lock_unit(a.unit_id);
  v_prev := app.idem_lookup(a.unit_id, p_request_id, 'ITEM_CREATE_MANUAL', v_hash);
  if v_prev is not null then return v_prev; end if;
  if p_item is null or pg_catalog.jsonb_typeof(p_item) <> 'object' then
    perform app.fail('INVALID_INPUT', 'Data item tidak valid.', '{"field":"p_item"}');
  end if;
  -- normalizeItemPayload_
  v_pages := app.parse_int(p_item -> 'page_count', 'p_item.page_count', 'Jumlah halaman', 0);
  if v_pages < 1 then perform app.fail('INVALID_INPUT', 'Jumlah halaman minimal 1.', '{"field":"p_item.page_count"}'); end if;
  v_dev := pg_catalog.upper(app.clean_text(p_item ->> 'development_level'));
  if v_dev = '' then perform app.fail('INVALID_INPUT', 'Tingkat perkembangan wajib diisi.', '{"field":"p_item.development_level"}'); end if;
  if v_dev not in ('ASLI', 'COPY') then
    perform app.fail('INVALID_INPUT', 'Tingkat perkembangan harus ASLI atau COPY.', '{"field":"p_item.development_level"}');
  end if;
  if app.clean_text(p_item ->> 'security_classification') = '' then
    perform app.fail('INVALID_INPUT', 'Klasifikasi keamanan dan akses arsip wajib diisi.', '{"field":"p_item.security_classification"}');
  end if;
  v_sec := app.valid_security(p_item ->> 'security_classification');
  if v_sec is null then
    perform app.fail('INVALID_INPUT', 'Klasifikasi keamanan dan akses arsip tidak valid.', '{"field":"p_item.security_classification"}');
  end if;
  v_primary := app.clean_text(p_item ->> 'primary_letter_number', 250);
  v_alt := app.clean_text(p_item ->> 'alternate_letter_number', 250);
  v_date := app.parse_date(p_item ->> 'document_date', 'p_item.document_date', 'Tanggal naskah');
  v_desc := app.clean_text(p_item ->> 'description', 2000);
  if v_desc = '' then perform app.fail('INVALID_INPUT', 'Uraian informasi arsip wajib diisi.', '{"field":"p_item.description"}'); end if;

  b := app.resolve_target_berkas(a, p_target, v_sec);

  insert into public.item (id, unit_id, berkas_id, jenis_naskah_id, subjenis_naskah_id, kelengkapan, no_surat_utama,
    no_surat_alternatif, no_surat_display, tanggal_naskah, tahun_kurun_waktu, uraian_lengkap, uraian_nama_file, jumlah_halaman,
    tingkat_perkembangan, klasifikasi_keamanan_akses, kode_klasifikasi_snapshot, lampiran, status_file, status_peminjaman,
    sort_no_surat_normalized, sort_created_at, catatan, created_at, created_by, updated_at, updated_by, version, is_deleted,
    arsip_id, sumber_registrasi, media_sumber, status_bentuk_digital, status_verifikasi_metadata, metadata_schema_version)
  values ('ITM-' || gen_random_uuid(), a.unit_id, b.id, null, null, null, nullif(v_primary, ''), nullif(v_alt, ''),
    app.display_letter(v_primary, v_alt), v_date, pg_catalog.date_part('year', v_date)::int, v_desc, app.clean_file_name(v_desc),
    v_pages, v_dev, v_sec, b.kode_klasifikasi_snapshot, '[]'::jsonb, 'BELUM DIUNGGAH', 'TERSEDIA',
    app.normalized_letter(v_primary, v_alt), app.jakarta_iso(now()), nullif(app.clean_text(p_item ->> 'notes', 1000), ''),
    now(), a.email, now(), a.email, 1, false, null, 'INPUT_MANUAL', 'TEKSTUAL', 'TIDAK ADA', 'TERVERIFIKASI', 4)
  returning * into i;
  update public.item set arsip_id = id where unit_id = a.unit_id and id = i.id;

  v_num := app.renumber_unit(a, array[b.id], 'Penomoran ulang kronologis setelah penambahan item', p_request_id::text);
  select * into i from public.item where unit_id = a.unit_id and id = i.id;
  select * into b from public.berkas where unit_id = a.unit_id and id = b.id;

  perform app.audit(a, 'CREATE', 'ITEM', 'ITEM', i.id, 'Menyimpan item arsip dan menerapkan penomoran definitif',
    'PDF alih media belum diunggah', p_request_id::text, null,
    pg_catalog.jsonb_build_object('berkas_id', b.id, 'no_berkas', b.no_berkas_definitif, 'no_item', i.no_item_definitif));
  v_res := pg_catalog.jsonb_build_object('ok', true, 'item_id', i.id, 'berkas_id', b.id, 'berkas_number', b.no_berkas_definitif,
    'item_number', i.no_item_definitif, 'file_status', 'BELUM DIUNGGAH', 'planned_file_name', i.nama_file,
    'renumbered_item_count', v_num -> 'renumbered_item_count', 'renumbered_berkas_count', v_num -> 'renumbered_berkas_count',
    'drive_tasks', v_num -> 'drive_tasks',
    'message', 'Metadata item berhasil disimpan tanpa PDF. Alih media dapat dilengkapi kemudian.');
  return app.idem_store(a.unit_id, p_request_id, 'ITEM_CREATE_MANUAL', v_hash, a.user_id, v_res);
end
$$;

insert into public.schema_migrations_log (version, name)
values ('0012', 's2_pemberkasan') on conflict (version) do nothing;
