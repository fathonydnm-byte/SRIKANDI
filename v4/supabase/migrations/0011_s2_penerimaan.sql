-- 0011_s2_penerimaan.sql
-- Penerimaan Arsip RPCs, ported from central-file/ReceiptService.js (3.32.5):
--   receipt_options, pegawai_add, receipt_save (create + edit), receipt_recover,
--   receipt_print_prepare, receipt_print_confirm, receipt_cancel.
-- Contract: v4/supabase/API_S2.md. Idempotent; no BEGIN/COMMIT.

-- ---------------------------------------------------------------------------
-- Input helpers
-- ---------------------------------------------------------------------------
create or replace function app.parse_date(p_value text, p_field text, p_label text)
returns date
language plpgsql immutable
set search_path = ''
as $$
declare
  v date;
begin
  if p_value is null or pg_catalog.btrim(p_value) = '' then
    perform app.fail('INVALID_INPUT', p_label || ' wajib diisi.', pg_catalog.jsonb_build_object('field', p_field));
  end if;
  if pg_catalog.btrim(p_value) !~ '^\d{4}-\d{2}-\d{2}$' then
    perform app.fail('INVALID_INPUT', p_label || ' tidak valid.', pg_catalog.jsonb_build_object('field', p_field));
  end if;
  begin
    v := pg_catalog.to_date(pg_catalog.btrim(p_value), 'YYYY-MM-DD');
  exception when others then
    perform app.fail('INVALID_INPUT', p_label || ' tidak valid.', pg_catalog.jsonb_build_object('field', p_field));
  end;
  if pg_catalog.to_char(v, 'YYYY-MM-DD') <> pg_catalog.btrim(p_value) then
    perform app.fail('INVALID_INPUT', p_label || ' tidak valid.', pg_catalog.jsonb_build_object('field', p_field));
  end if;
  return v;
end
$$;

-- Number(x) that must be an integer >= p_min (legacy positiveInteger_ / pageCount rules)
create or replace function app.parse_int(p_value jsonb, p_field text, p_label text, p_min integer)
returns integer
language plpgsql immutable
set search_path = ''
as $$
declare
  t text;
begin
  if p_value is null or pg_catalog.jsonb_typeof(p_value) = 'null' then
    perform app.fail('INVALID_INPUT', p_label || ' wajib diisi.', pg_catalog.jsonb_build_object('field', p_field));
  end if;
  t := pg_catalog.btrim(p_value #>> '{}');
  if pg_catalog.jsonb_typeof(p_value) not in ('number', 'string') or t !~ '^-?\d+(\.0+)?$'
     or t::numeric > 2147483647 or t::numeric < p_min then
    perform app.fail('INVALID_INPUT',
      p_label || case when p_min >= 1 then ' harus bilangan bulat minimal ' || p_min || '.'
                      else ' harus berupa bilangan bulat nol atau lebih.' end,
      pg_catalog.jsonb_build_object('field', p_field));
  end if;
  return t::numeric::integer;
end
$$;

-- normalizeReceiptItems_
create or replace function app.normalize_receipt_items(p_items jsonb)
returns jsonb
language plpgsql immutable
set search_path = ''
as $$
declare
  v_out jsonb := '[]'::jsonb;
  v_item jsonb;
  v_n integer;
  v_i integer := 0;
  v_dev text;
  v_cond text;
  v_sec text;
  v_desc text;
  f text;
begin
  if p_items is null or pg_catalog.jsonb_typeof(p_items) <> 'array' or pg_catalog.jsonb_array_length(p_items) = 0 then
    perform app.fail('INVALID_INPUT', 'Minimal satu item arsip wajib diisi.', '{"field":"items"}');
  end if;
  v_n := pg_catalog.jsonb_array_length(p_items);
  if v_n > 100 then
    perform app.fail('BATCH_LIMIT', 'Satu tanda terima maksimal memuat 100 item arsip.', '{"field":"items"}');
  end if;
  for v_item in select value from pg_catalog.jsonb_array_elements(p_items) loop
    v_i := v_i + 1;
    f := 'items[' || (v_i - 1) || '].';
    if pg_catalog.jsonb_typeof(v_item) <> 'object' then
      perform app.fail('INVALID_INPUT', 'Item ' || v_i || ' tidak valid.', pg_catalog.jsonb_build_object('field', 'items[' || (v_i - 1) || ']'));
    end if;
    v_dev := pg_catalog.upper(app.clean_text(v_item ->> 'development_level'));
    if v_dev = '' then
      perform app.fail('INVALID_INPUT', 'Tingkat perkembangan item ' || v_i || ' wajib diisi.', pg_catalog.jsonb_build_object('field', f || 'development_level'));
    elsif v_dev not in ('ASLI', 'COPY') then
      perform app.fail('INVALID_INPUT', 'Tingkat perkembangan item ' || v_i || ' tidak valid.', pg_catalog.jsonb_build_object('field', f || 'development_level'));
    end if;
    v_cond := pg_catalog.upper(app.clean_text(v_item ->> 'condition'));
    if v_cond = '' then
      perform app.fail('INVALID_INPUT', 'Kondisi item ' || v_i || ' wajib diisi.', pg_catalog.jsonb_build_object('field', f || 'condition'));
    elsif v_cond not in ('BAIK', 'RUSAK RINGAN', 'RUSAK SEDANG', 'RUSAK BERAT') then
      perform app.fail('INVALID_INPUT', 'Kondisi item ' || v_i || ' tidak valid.', pg_catalog.jsonb_build_object('field', f || 'condition'));
    end if;
    if app.clean_text(v_item ->> 'security_classification') = '' then
      perform app.fail('INVALID_INPUT', 'Klasifikasi keamanan dan akses item ' || v_i || ' wajib diisi.', pg_catalog.jsonb_build_object('field', f || 'security_classification'));
    end if;
    v_sec := app.valid_security(v_item ->> 'security_classification');
    if v_sec is null then
      perform app.fail('INVALID_INPUT', 'Klasifikasi keamanan dan akses item ' || v_i || ' tidak valid.', pg_catalog.jsonb_build_object('field', f || 'security_classification'));
    end if;
    v_desc := app.clean_text(v_item ->> 'description', 2000);
    if v_desc = '' then
      perform app.fail('INVALID_INPUT', 'Uraian item ' || v_i || ' wajib diisi.', pg_catalog.jsonb_build_object('field', f || 'description'));
    end if;
    v_out := v_out || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
      'receipt_item_id', nullif(app.clean_text(v_item ->> 'receipt_item_id', 90), ''),
      'archive_id', nullif(app.clean_text(v_item ->> 'archive_id', 90), ''),
      'description', v_desc,
      'page_count', app.parse_int(v_item -> 'page_count', f || 'page_count', 'Jumlah halaman item ' || v_i, 1),
      'development_level', v_dev,
      'condition', v_cond,
      'security_classification', v_sec,
      'primary_letter_number', app.clean_text(v_item ->> 'primary_letter_number', 250),
      'alternate_letter_number', app.clean_text(v_item ->> 'alternate_letter_number', 250),
      'document_date', app.parse_date(v_item ->> 'document_date', f || 'document_date', 'Tanggal naskah item ' || v_i),
      'notes', app.clean_text(v_item ->> 'notes', 1000)));
  end loop;
  return v_out;
end
$$;

-- ---------------------------------------------------------------------------
-- receipt_options (read, SECURITY INVOKER) — apiGetReceiptOptions
-- ---------------------------------------------------------------------------
create or replace function public.receipt_options(p_unit_id uuid default null)
returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  v_unit uuid := app.read_unit(p_unit_id);
  v_receipts jsonb;
begin
  with items as (
    select app.receipt_filing_status(pi.status_pemberkasan, pi.tanggal_naskah) as filing_status,
           app.receipt_item_complete(pi.arsip_id, pi.tanggal_naskah, pi.uraian_informasi, pi.jumlah_halaman,
                                     pi.tingkat_perkembangan, pi.kondisi, pi.klasifikasi_keamanan_akses) as complete,
           pi.*
    from public.penerimaan_item pi
    where pi.unit_id = v_unit and not pi.is_deleted
  ),
  items_json as (
    select penerimaan_id,
           pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'id', id, 'archive_id', arsip_id, 'number', no_item,
             'description', app.clean_text(uraian_informasi, 2000), 'page_count', coalesce(jumlah_halaman, 0),
             'development_level', pg_catalog.upper(coalesce(tingkat_perkembangan, '')),
             'condition', pg_catalog.upper(coalesce(kondisi, '')),
             'security_classification', app.normalize_security(klasifikasi_keamanan_akses),
             'primary_letter_number', app.clean_text(no_surat_utama, 250),
             'alternate_letter_number', app.clean_text(no_surat_alternatif, 250),
             'document_date', tanggal_naskah, 'notes', app.clean_text(catatan_item, 1000),
             'filing_status', filing_status, 'filed_berkas_id', berkas_id_tujuan, 'filed_item_id', item_id_definitif,
             'filed_berkas_number', no_berkas_definitif_snapshot, 'filed_item_number', no_item_definitif_snapshot,
             'metadata_complete', complete,
             'can_edit', filing_status not in ('SUDAH DIBERKASKAN', 'DIBATALKAN')) order by no_item, id) as items,
           pg_catalog.count(*) filter (where filing_status = 'SUDAH DIBERKASKAN') as filed,
           pg_catalog.count(*) filter (where filing_status = 'PERLU DILENGKAPI') as incomplete,
           pg_catalog.count(*) filter (where filing_status = 'BELUM DIBERKASKAN') as pending,
           pg_catalog.count(*) as n, pg_catalog.sum(coalesce(jumlah_halaman, 0)) as pages
    from items group by penerimaan_id
  ),
  prints as (
    select penerimaan_id, pg_catalog.count(*) as n from public.penerimaan_cetak_log where unit_id = v_unit group by penerimaan_id
  ),
  r as (
    select p.*, coalesce(ij.items, '[]'::jsonb) as items, coalesce(ij.filed, 0) as filed,
           coalesce(ij.incomplete, 0) as incomplete, coalesce(ij.pending, 0) as pending,
           coalesce(ij.n, 0) as n, coalesce(ij.pages, 0) as pages, coalesce(pr.n, 0) as print_count,
           pg_catalog.upper(coalesce(p.status, 'AKTIF')) as st,
           (coalesce(p.bukti_ttd_url, '') <> '' or coalesce(p.bukti_ttd_file_id, '') <> '') as has_evidence
    from public.penerimaan p
    left join items_json ij on ij.penerimaan_id = p.id
    left join prints pr on pr.penerimaan_id = p.id
    where p.unit_id = v_unit
  )
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id', id, 'number', nomor_tanda_terima, 'year', tahun, 'received_at', tanggal_waktu_terima,
           'sender_employee_id', penyerah_pegawai_id, 'sender_name', app.clean_text(nama_penyerah_snapshot, 250),
           'sender_unit', app.clean_text(unit_penyerah_snapshot, 250),
           'receiver_name', app.clean_text(nama_penerima, 250), 'receiver_unit', app.clean_text(unit_penerima, 250),
           'location', coalesce(nullif(lokasi, ''), 'Surabaya'), 'notes', app.clean_text(catatan_umum, 2000),
           'item_count', coalesce(jumlah_item, n), 'total_pages', coalesce(total_halaman, pages),
           'status', st, 'evidence_file_id', nullif(bukti_ttd_file_id, ''), 'evidence_name', bukti_ttd_nama,
           'cancellation_reason', app.clean_text(alasan_pembatalan, 2000),
           'cancellation_evidence_file_id', nullif(batal_bukti_file_id, ''), 'cancelled_at', dibatalkan_at,
           'filed_count', filed, 'pending_count', pending, 'incomplete_count', incomplete, 'print_count', print_count,
           'filing_progress_label', filed || ' dari ' || n || ' item sudah diberkaskan',
           'can_edit_header', st = 'AKTIF' and not has_evidence and filed = 0,
           'can_edit', st = 'AKTIF' and (incomplete > 0 or (not has_evidence and (pending > 0 or incomplete > 0))),
           'can_complete_metadata', st = 'AKTIF' and incomplete > 0,
           'items', items) order by tanggal_waktu_terima desc, id), '[]'::jsonb)
    into v_receipts from r;

  return pg_catalog.jsonb_build_object(
    'unit_id', v_unit,
    'employees', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'id', e.id, 'name', app.clean_text(e.nama_pegawai, 250), 'unit', app.clean_text(e.unit_kerja, 250),
        'label', app.clean_text(e.nama_pegawai, 250) || ' — ' || app.clean_text(e.unit_kerja, 250))
        order by e.nama_pegawai collate app.natural_ci, e.id)
      from public.pegawai e where e.unit_id = v_unit and e.aktif), '[]'::jsonb),
    'receipts', v_receipts,
    'defaults', pg_catalog.jsonb_build_object(
      'receiver_name', coalesce((select s.value #>> '{}' from public.unit_settings s where s.unit_id = v_unit and s.key = 'RECEIPT_RECEIVER_NAME'), ''),
      'receiver_unit', coalesce((select s.value #>> '{}' from public.unit_settings s where s.unit_id = v_unit and s.key = 'RECEIPT_RECEIVER_UNIT'), ''),
      'location', 'Surabaya'),
    'development_levels', '["ASLI","COPY"]'::jsonb,
    'conditions', '["BAIK","RUSAK RINGAN","RUSAK SEDANG","RUSAK BERAT"]'::jsonb,
    'security_classifications', '["BIASA/TERBUKA","TERBATAS","RAHASIA","SANGAT RAHASIA"]'::jsonb,
    'summary', pg_catalog.jsonb_build_object(
      'total', pg_catalog.jsonb_array_length(v_receipts),
      'active', (select pg_catalog.count(*) from pg_catalog.jsonb_array_elements(v_receipts) x where x ->> 'status' = 'AKTIF'),
      'with_evidence', (select pg_catalog.count(*) from pg_catalog.jsonb_array_elements(v_receipts) x where x ->> 'evidence_file_id' is not null),
      'cancelled', (select pg_catalog.count(*) from pg_catalog.jsonb_array_elements(v_receipts) x where x ->> 'status' = 'DIBATALKAN')));
end
$$;

-- ---------------------------------------------------------------------------
-- pegawai_add — apiAddReceiptEmployee
-- ---------------------------------------------------------------------------
create or replace function public.pegawai_add(p_request_id uuid, p_name text, p_unit_kerja text, p_unit_id uuid default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  a app.actor := app.require_actor(p_unit_id, true);
  v_name text := app.clean_text(p_name, 250);
  v_unit_kerja text := app.clean_text(p_unit_kerja, 250);
  v_hash text;
  v_prev jsonb;
  e public.pegawai;
  v_res jsonb;
  v_created boolean := false;
  v_reactivated boolean := false;
begin
  perform app.lock_unit(a.unit_id);
  v_hash := pg_catalog.md5(pg_catalog.jsonb_build_object('name', p_name, 'unit', p_unit_kerja)::text);
  v_prev := app.idem_lookup(a.unit_id, p_request_id, 'PEGAWAI_ADD', v_hash);
  if v_prev is not null then return v_prev; end if;
  if v_name = '' then perform app.fail('INVALID_INPUT', 'Nama pegawai wajib diisi.', '{"field":"p_name"}'); end if;
  if v_unit_kerja = '' then perform app.fail('INVALID_INPUT', 'Unit kerja pegawai wajib diisi.', '{"field":"p_unit_kerja"}'); end if;

  select * into e from public.pegawai
   where unit_id = a.unit_id
     and pg_catalog.upper(app.clean_text(nama_pegawai)) = pg_catalog.upper(v_name)
     and pg_catalog.upper(app.clean_text(unit_kerja)) = pg_catalog.upper(v_unit_kerja)
   order by created_at, id limit 1 for update;
  if found then
    if not e.aktif then
      update public.pegawai set aktif = true, updated_at = now(), updated_by = a.email where id = e.id;
      v_reactivated := true;
    end if;
  else
    insert into public.pegawai (id, unit_id, nama_pegawai, unit_kerja, aktif, created_at, created_by, updated_at, updated_by)
    values ('PGW-' || gen_random_uuid(), a.unit_id, v_name, v_unit_kerja, true, now(), a.email, now(), a.email)
    returning * into e;
    v_created := true;
    perform app.audit(a, 'CREATE', 'PENERIMAAN_ARSIP', 'PEGAWAI', e.id, 'Menambah pegawai penyerah: ' || v_name,
                      v_unit_kerja, p_request_id::text);
  end if;
  v_res := pg_catalog.jsonb_build_object(
    'ok', true,
    'employee', pg_catalog.jsonb_build_object('id', e.id, 'name', app.clean_text(e.nama_pegawai, 250),
                 'unit', app.clean_text(e.unit_kerja, 250),
                 'label', app.clean_text(e.nama_pegawai, 250) || ' — ' || app.clean_text(e.unit_kerja, 250)),
    'created', v_created, 'reactivated', v_reactivated,
    'message', case when v_created then 'Pegawai berhasil ditambahkan dan dipilih.' else 'Pegawai sudah tersedia dan dipilih.' end);
  return app.idem_store(a.unit_id, p_request_id, 'PEGAWAI_ADD', v_hash, a.user_id, v_res);
end
$$;

-- ---------------------------------------------------------------------------
-- receipt_save — apiSaveReceipt (create and edit)
-- ---------------------------------------------------------------------------
create or replace function public.receipt_save(p_request_id uuid, p_payload jsonb, p_unit_id uuid default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  a app.actor := app.require_actor(p_unit_id, true);
  v_hash text := pg_catalog.md5(coalesce(p_payload, 'null'::jsonb)::text);
  v_prev jsonb;
  v_receipt_id text;
  v_emp public.pegawai;
  v_receiver_name text;
  v_receiver_unit text;
  v_notes text;
  v_items jsonb;
  v_total integer;
  v_count integer;
  r public.penerimaan;
  old public.penerimaan_item;
  v_item jsonb;
  v_i integer := 0;
  v_year integer;
  v_seq bigint;
  v_number text;
  v_max integer;
  v_has_evidence boolean;
  v_has_filed boolean;
  v_header_changed boolean;
  v_submitted text[] := '{}';
  v_new_id text;
  v_status text;
  v_full_equal boolean;
  v_printed_equal boolean;
  v_res jsonb;
begin
  perform app.lock_unit(a.unit_id);
  v_prev := app.idem_lookup(a.unit_id, p_request_id, 'RECEIPT_SAVE', v_hash);
  if v_prev is not null then return v_prev; end if;
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    perform app.fail('INVALID_INPUT', 'Data penerimaan tidak valid.', '{"field":"p_payload"}');
  end if;

  v_receipt_id := nullif(app.clean_text(p_payload ->> 'receipt_id', 90), '');
  if v_receipt_id is not null then
    select * into r from public.penerimaan where unit_id = a.unit_id and id = v_receipt_id for update;
    if not found then perform app.fail('NOT_FOUND', 'Tanda terima yang akan diedit tidak ditemukan.'); end if;
  end if;
  if app.clean_text(p_payload ->> 'sender_employee_id') = '' then
    perform app.fail('INVALID_INPUT', 'Pegawai penyerah wajib diisi.', '{"field":"sender_employee_id"}');
  end if;
  select * into v_emp from public.pegawai
   where unit_id = a.unit_id and id = app.clean_text(p_payload ->> 'sender_employee_id', 90) and aktif;
  if not found then perform app.fail('NOT_FOUND', 'Pegawai penyerah tidak aktif atau tidak ditemukan.'); end if;
  v_receiver_name := app.clean_text(p_payload ->> 'receiver_name', 250);
  if v_receiver_name = '' then perform app.fail('INVALID_INPUT', 'Nama penerima arsip wajib diisi.', '{"field":"receiver_name"}'); end if;
  v_receiver_unit := app.clean_text(p_payload ->> 'receiver_unit', 250);
  if v_receiver_unit = '' then perform app.fail('INVALID_INPUT', 'Unit kerja penerima wajib diisi.', '{"field":"receiver_unit"}'); end if;
  v_notes := app.clean_text(p_payload ->> 'notes', 2000);
  v_items := app.normalize_receipt_items(p_payload -> 'items');
  v_count := pg_catalog.jsonb_array_length(v_items);
  select coalesce(pg_catalog.sum((x ->> 'page_count')::int), 0) into v_total from pg_catalog.jsonb_array_elements(v_items) x;

  if v_receipt_id is null then
    -- ------------------------------------------------------------- create
    v_receipt_id := 'RCV-' || pg_catalog.upper(p_request_id::text);
    if exists (select 1 from public.penerimaan where id = v_receipt_id) then
      perform app.fail('IDEMPOTENCY_CONFLICT', 'ID permintaan ini sudah dipakai. Muat ulang halaman lalu ulangi.');
    end if;
    v_year := pg_catalog.date_part('year', now() at time zone 'Asia/Jakarta')::int;
    select pg_catalog.max((pg_catalog.substring(nomor_tanda_terima, '^TRM-' || v_year || '-(\d+)$'))::int) into v_max
      from public.penerimaan where unit_id = a.unit_id and nomor_tanda_terima like 'TRM-' || v_year || '-%';
    insert into public.counters as c (unit_id, scope, year, last_value) values (a.unit_id, 'TRM', v_year, coalesce(v_max, 0))
    on conflict (unit_id, scope, year) do update set last_value = greatest(c.last_value, excluded.last_value);
    v_seq := app.next_counter(a.unit_id, 'TRM', v_year);
    v_number := 'TRM-' || v_year || '-' || case when pg_catalog.length(v_seq::text) >= 4 then v_seq::text else pg_catalog.lpad(v_seq::text, 4, '0') end;

    insert into public.penerimaan (id, unit_id, nomor_tanda_terima, tahun, tanggal_waktu_terima, penyerah_pegawai_id,
      nama_penyerah_snapshot, unit_penyerah_snapshot, nama_penerima, unit_penerima, lokasi, catatan_umum,
      jumlah_item, total_halaman, status, created_at, created_by, updated_at, updated_by, version)
    values (v_receipt_id, a.unit_id, v_number, v_year, now(), v_emp.id, v_emp.nama_pegawai, v_emp.unit_kerja,
      v_receiver_name, v_receiver_unit, 'Surabaya', nullif(v_notes, ''), v_count, v_total, 'AKTIF',
      now(), a.email, now(), a.email, 1);

    for v_item in select value from pg_catalog.jsonb_array_elements(v_items) loop
      v_i := v_i + 1;
      insert into public.penerimaan_item (id, unit_id, penerimaan_id, no_item, uraian_informasi, jumlah_halaman,
        tingkat_perkembangan, kondisi, klasifikasi_keamanan_akses, media_sumber, status_bentuk_digital,
        status_verifikasi_metadata, metadata_schema_version, created_at, created_by, updated_at, updated_by,
        is_deleted, arsip_id, no_surat_utama, no_surat_alternatif, tanggal_naskah, catatan_item, status_pemberkasan)
      values ('RCVI-' || gen_random_uuid(), a.unit_id, v_receipt_id, v_i, v_item ->> 'description', (v_item ->> 'page_count')::int,
        v_item ->> 'development_level', v_item ->> 'condition', v_item ->> 'security_classification', 'TEKSTUAL', 'TIDAK ADA',
        'TERVERIFIKASI', 4, now(), a.email, now(), a.email, false, 'ARS-' || gen_random_uuid(),
        nullif(v_item ->> 'primary_letter_number', ''), nullif(v_item ->> 'alternate_letter_number', ''),
        (v_item ->> 'document_date')::date, nullif(v_item ->> 'notes', ''), 'BELUM DIBERKASKAN');
    end loop;

    perform app.audit(a, 'CREATE', 'PENERIMAAN_ARSIP', 'TANDA_TERIMA', v_receipt_id,
      'Membuat ' || v_number || ' dari ' || v_emp.nama_pegawai, v_count || ' item · ' || v_total || ' halaman', p_request_id::text);
    v_res := pg_catalog.jsonb_build_object('ok', true, 'receipt_id', v_receipt_id, 'number', v_number, 'is_update', false,
      'item_count', v_count, 'total_pages', v_total, 'message', 'Penerimaan arsip berhasil dicatat.');
    return app.idem_store(a.unit_id, p_request_id, 'RECEIPT_SAVE', v_hash, a.user_id, v_res);
  end if;

  -- --------------------------------------------------------------- edit (buildReceiptEditPlan_)
  if pg_catalog.upper(coalesce(r.status, 'AKTIF')) <> 'AKTIF' then
    perform app.fail('RECEIPT_CANCELLED', 'Tanda terima yang dibatalkan tidak dapat diedit.');
  end if;
  v_has_evidence := coalesce(r.bukti_ttd_file_id, '') <> '' or coalesce(r.bukti_ttd_url, '') <> '';
  select exists (select 1 from public.penerimaan_item pi where pi.unit_id = a.unit_id and pi.penerimaan_id = r.id
                 and not pi.is_deleted and app.receipt_filing_status(pi.status_pemberkasan, pi.tanggal_naskah) = 'SUDAH DIBERKASKAN')
    into v_has_filed;
  v_header_changed := r.penyerah_pegawai_id is distinct from v_emp.id
    or app.clean_text(r.nama_penyerah_snapshot, 250) <> app.clean_text(v_emp.nama_pegawai, 250)
    or app.clean_text(r.unit_penyerah_snapshot, 250) <> app.clean_text(v_emp.unit_kerja, 250)
    or app.clean_text(r.nama_penerima, 250) <> v_receiver_name
    or app.clean_text(r.unit_penerima, 250) <> v_receiver_unit
    or app.clean_text(r.catatan_umum, 2000) <> v_notes;
  if (v_has_evidence or v_has_filed) and v_header_changed then
    perform app.fail('RECEIPT_LOCKED', 'Identitas dan catatan umum terkunci karena tanda terima sudah ' ||
      case when v_has_evidence then 'memiliki bukti tertandatangani.' else 'memiliki item yang sudah diberkaskan.' end);
  end if;

  for v_item in select value from pg_catalog.jsonb_array_elements(v_items) loop
    v_i := v_i + 1;
    if v_item ->> 'receipt_item_id' is null then
      if v_has_evidence then
        perform app.fail('RECEIPT_LOCKED', 'Item baru tidak dapat ditambahkan setelah bukti tertandatangani diunggah.');
      end if;
      insert into public.penerimaan_item (id, unit_id, penerimaan_id, no_item, uraian_informasi, jumlah_halaman,
        tingkat_perkembangan, kondisi, klasifikasi_keamanan_akses, media_sumber, status_bentuk_digital,
        status_verifikasi_metadata, metadata_schema_version, created_at, created_by, updated_at, updated_by,
        is_deleted, arsip_id, no_surat_utama, no_surat_alternatif, tanggal_naskah, catatan_item, status_pemberkasan)
      values ('RCVI-' || gen_random_uuid(), a.unit_id, r.id, v_i, v_item ->> 'description', (v_item ->> 'page_count')::int,
        v_item ->> 'development_level', v_item ->> 'condition', v_item ->> 'security_classification', 'TEKSTUAL', 'TIDAK ADA',
        'TERVERIFIKASI', 4, now(), a.email, now(), a.email, false, coalesce(v_item ->> 'archive_id', 'ARS-' || gen_random_uuid()),
        nullif(v_item ->> 'primary_letter_number', ''), nullif(v_item ->> 'alternate_letter_number', ''),
        (v_item ->> 'document_date')::date, nullif(v_item ->> 'notes', ''), 'BELUM DIBERKASKAN')
      returning id into v_new_id;
      v_submitted := v_submitted || v_new_id;
      continue;
    end if;
    if (v_item ->> 'receipt_item_id') = any (v_submitted) then
      perform app.fail('INVALID_INPUT', 'Item penerimaan yang sama terkirim lebih dari satu kali.');
    end if;
    v_submitted := v_submitted || (v_item ->> 'receipt_item_id');
    select * into old from public.penerimaan_item
     where unit_id = a.unit_id and penerimaan_id = r.id and id = v_item ->> 'receipt_item_id' and not is_deleted for update;
    if not found then perform app.fail('NOT_FOUND', 'Item penerimaan tidak ditemukan atau sudah dihapus.'); end if;
    if v_item ->> 'archive_id' is not null and coalesce(old.arsip_id, '') <> '' and v_item ->> 'archive_id' <> old.arsip_id then
      perform app.fail('INVALID_INPUT', 'Identitas arsip tidak cocok. Muat ulang halaman.');
    end if;
    v_status := app.receipt_filing_status(old.status_pemberkasan, old.tanggal_naskah);
    v_printed_equal := app.clean_text(old.uraian_informasi, 2000) = v_item ->> 'description'
      and coalesce(old.jumlah_halaman, 0) = (v_item ->> 'page_count')::int
      and pg_catalog.upper(coalesce(old.tingkat_perkembangan, '')) = v_item ->> 'development_level'
      and pg_catalog.upper(coalesce(old.kondisi, '')) = v_item ->> 'condition';
    v_full_equal := v_printed_equal
      and app.clean_text(old.no_surat_utama, 250) = v_item ->> 'primary_letter_number'
      and app.clean_text(old.no_surat_alternatif, 250) = v_item ->> 'alternate_letter_number'
      and old.tanggal_naskah is not distinct from (v_item ->> 'document_date')::date
      and app.clean_text(old.catatan_item, 1000) = v_item ->> 'notes'
      and app.normalize_security(old.klasifikasi_keamanan_akses) = v_item ->> 'security_classification';
    if v_status = 'SUDAH DIBERKASKAN' and not v_full_equal then
      perform app.fail('ITEM_ALREADY_FILED', 'Item ' || coalesce(old.no_item, v_i) || ' sudah diberkaskan dan tidak dapat diubah dari Penerimaan Arsip.');
    end if;
    if v_has_evidence and not v_printed_equal then
      perform app.fail('RECEIPT_LOCKED', 'Data yang tercetak pada item ' || coalesce(old.no_item, v_i) || ' terkunci karena bukti tertandatangani sudah diunggah.');
    end if;
    if v_has_evidence and v_status <> 'PERLU DILENGKAPI' and not v_full_equal then
      perform app.fail('RECEIPT_LOCKED', 'Metadata item ' || coalesce(old.no_item, v_i) || ' sudah lengkap dan terkunci oleh bukti tertandatangani.');
    end if;
    update public.penerimaan_item set
      no_item = v_i, uraian_informasi = v_item ->> 'description', jumlah_halaman = (v_item ->> 'page_count')::int,
      tingkat_perkembangan = v_item ->> 'development_level', kondisi = v_item ->> 'condition',
      klasifikasi_keamanan_akses = v_item ->> 'security_classification', media_sumber = 'TEKSTUAL',
      status_bentuk_digital = 'TIDAK ADA', status_verifikasi_metadata = 'TERVERIFIKASI', metadata_schema_version = 4,
      arsip_id = coalesce(nullif(old.arsip_id, ''), v_item ->> 'archive_id', 'ARS-' || gen_random_uuid()),
      no_surat_utama = nullif(v_item ->> 'primary_letter_number', ''), no_surat_alternatif = nullif(v_item ->> 'alternate_letter_number', ''),
      tanggal_naskah = (v_item ->> 'document_date')::date, catatan_item = nullif(v_item ->> 'notes', ''),
      status_pemberkasan = case when v_status = 'SUDAH DIBERKASKAN' then v_status else 'BELUM DIBERKASKAN' end,
      updated_at = now(), updated_by = a.email
    where id = old.id;
  end loop;

  for old in select * from public.penerimaan_item
              where unit_id = a.unit_id and penerimaan_id = r.id and not is_deleted and not (id = any (v_submitted))
              order by no_item, id for update loop
    if app.receipt_filing_status(old.status_pemberkasan, old.tanggal_naskah) = 'SUDAH DIBERKASKAN' then
      perform app.fail('ITEM_ALREADY_FILED', 'Item ' || coalesce(old.no_item, 0) || ' sudah diberkaskan dan tidak dapat dihapus dari tanda terima.');
    end if;
    if v_has_evidence then
      perform app.fail('RECEIPT_LOCKED', 'Item tidak dapat dihapus setelah bukti tertandatangani diunggah.');
    end if;
    update public.penerimaan_item set is_deleted = true, deleted_at = now(), deleted_by = a.email,
      updated_at = now(), updated_by = a.email where id = old.id;
  end loop;

  update public.penerimaan set penyerah_pegawai_id = v_emp.id, nama_penyerah_snapshot = v_emp.nama_pegawai,
    unit_penyerah_snapshot = v_emp.unit_kerja, nama_penerima = v_receiver_name, unit_penerima = v_receiver_unit,
    catatan_umum = nullif(v_notes, ''), jumlah_item = v_count, total_halaman = v_total,
    updated_at = now(), updated_by = a.email, version = coalesce(version, 1) + 1
  where id = r.id;
  perform app.audit(a, 'UPDATE', 'PENERIMAAN_ARSIP', 'TANDA_TERIMA', r.id, 'Memperbarui ' || r.nomor_tanda_terima,
    v_count || ' item · ' || v_total || ' halaman', p_request_id::text);
  v_res := pg_catalog.jsonb_build_object('ok', true, 'receipt_id', r.id, 'number', r.nomor_tanda_terima, 'is_update', true,
    'item_count', v_count, 'total_pages', v_total, 'message', 'Tanda terima berhasil diperbarui.');
  return app.idem_store(a.unit_id, p_request_id, 'RECEIPT_SAVE', v_hash, a.user_id, v_res);
end
$$;

-- ---------------------------------------------------------------------------
-- receipt_recover — apiRecoverReceiptSave
-- ---------------------------------------------------------------------------
create or replace function public.receipt_recover(p_request_id uuid, p_unit_id uuid default null)
returns jsonb
language plpgsql stable security definer
set search_path = ''
as $$
declare
  a app.actor := app.require_actor(p_unit_id, true);
  r public.penerimaan;
begin
  if p_request_id is null then perform app.fail('INVALID_INPUT', 'ID permintaan wajib diisi.', '{"field":"p_request_id"}'); end if;
  select * into r from public.penerimaan where unit_id = a.unit_id and id = 'RCV-' || pg_catalog.upper(p_request_id::text);
  if not found then
    return pg_catalog.jsonb_build_object('ok', true, 'found', false, 'receipt_id', 'RCV-' || pg_catalog.upper(p_request_id::text));
  end if;
  return pg_catalog.jsonb_build_object('ok', true, 'found', true, 'recovered', true, 'receipt_id', r.id,
    'number', r.nomor_tanda_terima, 'is_update', false,
    'message', 'Penerimaan arsip sudah tersimpan dan berhasil dipulihkan tanpa data ganda.');
end
$$;

-- ---------------------------------------------------------------------------
-- receipt_print_prepare (read, SECURITY INVOKER) — apiPrepareReceiptPrint
-- ---------------------------------------------------------------------------
create or replace function public.receipt_print_prepare(p_receipt_id text)
returns jsonb
language plpgsql stable security invoker
set search_path = ''
as $$
declare
  r public.penerimaan;
  v_items jsonb;
  v_prints integer;
begin
  if app.current_role() is null then
    perform app.fail('ACCOUNT_INACTIVE', 'Akun Anda belum aktif atau sudah dinonaktifkan.');
  end if;
  select * into r from public.penerimaan where id = app.clean_text(p_receipt_id, 90);
  if not found then perform app.fail('NOT_FOUND', 'Tanda terima tidak ditemukan.'); end if;
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'id', pi.id, 'number', pi.no_item, 'description', app.clean_text(pi.uraian_informasi, 2000),
           'page_count', coalesce(pi.jumlah_halaman, 0), 'development_level', pg_catalog.upper(coalesce(pi.tingkat_perkembangan, '')),
           'condition', pg_catalog.upper(coalesce(pi.kondisi, ''))) order by pi.no_item, pi.id)
    into v_items from public.penerimaan_item pi
   where pi.unit_id = r.unit_id and pi.penerimaan_id = r.id and not pi.is_deleted;
  if v_items is null then perform app.fail('NOT_FOUND', 'Tanda terima tidak memiliki item aktif.'); end if;
  select pg_catalog.count(*) into v_prints from public.penerimaan_cetak_log l where l.unit_id = r.unit_id and l.penerimaan_id = r.id;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'print_token', 'RCPRINT-' || gen_random_uuid(), 'receipt_id', r.id, 'number', r.nomor_tanda_terima,
    'received_at', r.tanggal_waktu_terima, 'sender_name', coalesce(r.nama_penyerah_snapshot, ''),
    'sender_unit', coalesce(r.unit_penyerah_snapshot, ''), 'receiver_name', coalesce(r.nama_penerima, ''),
    'receiver_unit', coalesce(r.unit_penerima, ''), 'location', coalesce(nullif(r.lokasi, ''), 'Surabaya'),
    'notes', coalesce(r.catatan_umum, ''), 'status', coalesce(r.status, 'AKTIF'),
    'cancellation_reason', coalesce(r.alasan_pembatalan, ''), 'cancelled_at', r.dibatalkan_at,
    'is_reprint', v_prints > 0, 'print_number', v_prints + 1, 'generated_at', now(),
    'file_name', app.clean_file_name(r.nomor_tanda_terima) || '_Tanda-Terima-Penyerahan-Arsip.pdf',
    'items', v_items);
end
$$;

-- ---------------------------------------------------------------------------
-- receipt_print_confirm — apiConfirmReceiptPrint (idempotent on print token)
-- ---------------------------------------------------------------------------
create or replace function public.receipt_print_confirm(p_receipt_id text, p_print_token text, p_file_name text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  r public.penerimaan;
  a app.actor;
  v_token text := app.clean_text(p_print_token, 100);
  v_existing public.penerimaan_cetak_log;
  v_count integer;
  v_file text;
begin
  select * into r from public.penerimaan where id = app.clean_text(p_receipt_id, 90);
  a := app.require_actor_object(r.unit_id, 'Tanda terima', true);
  if v_token = '' then perform app.fail('INVALID_INPUT', 'Token cetak wajib diisi.', '{"field":"p_print_token"}'); end if;
  if not exists (select 1 from public.penerimaan_item pi where pi.unit_id = r.unit_id and pi.penerimaan_id = r.id and not pi.is_deleted) then
    perform app.fail('NOT_FOUND', 'Tanda terima tidak memiliki item aktif.');
  end if;
  perform app.lock_unit(a.unit_id);
  select * into v_existing from public.penerimaan_cetak_log where unit_id = a.unit_id and print_token = v_token;
  if found then
    if v_existing.penerimaan_id <> r.id then
      perform app.fail('IDEMPOTENCY_CONFLICT', 'Token cetak ini milik tanda terima lain.');
    end if;
    return pg_catalog.jsonb_build_object('ok', true, 'print_count', v_existing.cetak_ke, 'replayed', true);
  end if;
  select pg_catalog.count(*) + 1 into v_count from public.penerimaan_cetak_log where unit_id = a.unit_id and penerimaan_id = r.id;
  v_file := coalesce(nullif(app.clean_text(p_file_name, 250), ''),
                     app.clean_file_name(r.nomor_tanda_terima) || '_Tanda-Terima-Penyerahan-Arsip.pdf');
  insert into public.penerimaan_cetak_log (id, unit_id, penerimaan_id, nomor_tanda_terima_snapshot, print_token, cetak_ke,
    jenis_cetak, status_snapshot, printed_at, user_email, pdf_file_name, actor_user_id)
  values ('RCPL-' || gen_random_uuid(), a.unit_id, r.id, r.nomor_tanda_terima, v_token, v_count,
    case when v_count > 1 then 'CETAK ULANG' else 'PERTAMA' end, coalesce(r.status, 'AKTIF'), now(), a.email, v_file, a.user_id);
  perform app.audit(a, 'GENERATE_PDF', 'PENERIMAAN_ARSIP', 'TANDA_TERIMA', r.id, 'Mencetak ' || r.nomor_tanda_terima,
    case when v_count > 1 then 'CETAK ULANG ke-' || v_count else 'Cetak pertama' end || ' · ' || v_file, v_token);
  return pg_catalog.jsonb_build_object('ok', true, 'print_count', v_count, 'replayed', false);
end
$$;

-- ---------------------------------------------------------------------------
-- receipt_cancel — apiCancelReceipt (+ cancel evidence finalize)
-- ---------------------------------------------------------------------------
create or replace function public.receipt_cancel(p_request_id uuid, p_receipt_id text, p_reason text, p_confirmation text,
                                                 p_evidence_session_id uuid default null)
returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  r public.penerimaan;
  a app.actor;
  v_reason text := app.clean_text(p_reason, 2000);
  v_hash text;
  v_prev jsonb;
  v_linked integer;
  v_refs text[];
  s public.upload_sessions;
  v_res jsonb;
begin
  select * into r from public.penerimaan where id = app.clean_text(p_receipt_id, 90);
  a := app.require_actor_object(r.unit_id, 'Tanda terima', true);
  perform app.lock_unit(a.unit_id);
  v_hash := pg_catalog.md5(pg_catalog.jsonb_build_object('receipt', r.id, 'reason', p_reason,
              'confirmation', p_confirmation, 'evidence', p_evidence_session_id)::text);
  v_prev := app.idem_lookup(a.unit_id, p_request_id, 'RECEIPT_CANCEL', v_hash);
  if v_prev is not null then return v_prev; end if;
  if v_reason = '' then perform app.fail('INVALID_INPUT', 'Alasan pembatalan wajib diisi.', '{"field":"p_reason"}'); end if;
  if pg_catalog.length(v_reason) < 10 then
    perform app.fail('INVALID_INPUT', 'Alasan pembatalan minimal 10 karakter.', '{"field":"p_reason"}');
  end if;
  if pg_catalog.upper(pg_catalog.btrim(coalesce(p_confirmation, ''))) <> 'BATALKAN' then
    perform app.fail('INVALID_INPUT', 'Ketik BATALKAN pada kolom konfirmasi.', '{"field":"p_confirmation"}');
  end if;
  select * into r from public.penerimaan where id = r.id for update;
  if pg_catalog.upper(coalesce(r.status, '')) = 'DIBATALKAN' then
    v_res := pg_catalog.jsonb_build_object('ok', true, 'receipt_id', r.id, 'already_cancelled', true,
      'message', 'Tanda terima sudah dibatalkan sebelumnya.');
    return app.idem_store(a.unit_id, p_request_id, 'RECEIPT_CANCEL', v_hash, a.user_id, v_res);
  end if;
  select pg_catalog.count(*), (pg_catalog.array_agg(coalesce(i.no_berkas_snapshot::text, '–') || '/' || coalesce(i.no_item_definitif::text, '–')
                                 order by i.no_berkas_snapshot, i.no_item_definitif))[1:5]
    into v_linked, v_refs
    from public.item i where i.unit_id = a.unit_id and i.penerimaan_id = r.id and not i.is_deleted;
  if v_linked > 0 then
    perform app.fail('RECEIPT_HAS_FILED_ITEMS',
      'Tanda terima belum dapat dibatalkan karena ' || v_linked || ' item masih berada di dalam berkas (' ||
      pg_catalog.array_to_string(v_refs, ', ') || case when v_linked > 5 then ', …' else '' end ||
      '). Keluarkan item terkait melalui Koreksi & Pembatalan terlebih dahulu.',
      pg_catalog.jsonb_build_object('items', pg_catalog.to_jsonb(v_refs), 'count', v_linked));
  end if;
  if p_evidence_session_id is not null then
    select * into s from public.upload_sessions
     where id = p_evidence_session_id and unit_id = a.unit_id and purpose = 'RECEIPT_CANCEL_EVIDENCE'
       and object_id = r.id and owner_user_id = a.user_id and status = 'COMMITTED' and consumed_at is null
     for update;
    if not found then
      perform app.fail('UPLOAD_SESSION_STATE', 'Bukti pembatalan belum selesai diunggah atau sudah dipakai. Unggah ulang bukti.');
    end if;
    update public.upload_sessions set consumed_at = now() where id = s.id;
  end if;
  update public.penerimaan set status = 'DIBATALKAN', alasan_pembatalan = v_reason,
    batal_bukti_file_id = s.drive_file_id, batal_bukti_url = s.drive_url, batal_bukti_nama = s.drive_name,
    batal_bukti_size_bytes = s.size_bytes, batal_bukti_md5 = s.md5,
    dibatalkan_at = now(), dibatalkan_by = a.email, updated_at = now(), updated_by = a.email,
    version = coalesce(version, 1) + 1
  where id = r.id;
  update public.penerimaan_item set status_pemberkasan = 'DIBATALKAN', updated_at = now(), updated_by = a.email
   where unit_id = a.unit_id and penerimaan_id = r.id and not is_deleted;
  perform app.audit(a, 'CANCEL', 'PENERIMAAN_ARSIP', 'TANDA_TERIMA', r.id, 'Membatalkan ' || r.nomor_tanda_terima,
    v_reason || case when s.drive_file_id is not null then ' · Bukti: ' || s.drive_file_id else '' end, p_request_id::text,
    pg_catalog.jsonb_build_object('status', r.status), pg_catalog.jsonb_build_object('status', 'DIBATALKAN'));
  v_res := pg_catalog.jsonb_build_object('ok', true, 'receipt_id', r.id, 'already_cancelled', false,
    'evidence_file_id', s.drive_file_id,
    'message', 'Tanda terima berhasil dibatalkan. Bukti tertandatangani yang sudah ada tetap disimpan.');
  return app.idem_store(a.unit_id, p_request_id, 'RECEIPT_CANCEL', v_hash, a.user_id, v_res);
end
$$;

insert into public.schema_migrations_log (version, name)
values ('0011', 's2_penerimaan') on conflict (version) do nothing;
