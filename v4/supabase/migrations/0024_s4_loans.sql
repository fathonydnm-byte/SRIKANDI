-- S4 core: group transactions, snapshots, and unit scoped RPCs.
create table if not exists public.loan_groups (
  unit_id uuid not null references public.units(id),
  id text not null,
  borrower_name text not null,
  borrower_position text not null,
  borrower_unit text not null,
  borrower_identity_enc bytea,
  borrower_whatsapp_enc bytea,
  officer_name text not null,
  officer_position text not null,
  officer_identity_enc bytea,
  purpose text not null,
  borrowed_on date not null,
  due_on date not null check (due_on >= borrowed_on),
  borrow_condition text not null check (borrow_condition in ('BAIK', 'RUSAK RINGAN', 'RUSAK SEDANG', 'RUSAK BERAT')),
  notes text,
  page_count integer not null check (page_count > 0),
  returned_on date check (returned_on >= borrowed_on),
  return_condition text check (return_condition in ('BAIK', 'RUSAK RINGAN', 'RUSAK SEDANG', 'RUSAK BERAT')),
  return_officer_name text,
  return_officer_position text,
  return_officer_identity_enc bytea,
  return_notes text,
  created_at timestamptz not null default now(),
  created_by uuid,
  returned_at timestamptz,
  returned_by uuid,
  primary key (unit_id, id)
);
create index if not exists loan_groups_open_idx on public.loan_groups (unit_id, borrowed_on desc, id) where returned_on is null;

create table if not exists public.loan_objects (
  unit_id uuid not null,
  id text not null,
  loan_id text not null,
  berkas_id text not null,
  item_id text,
  berkas_no integer not null,
  berkas_title text not null,
  item_no integer,
  item_description text,
  location text not null,
  page_count integer not null check (page_count >= 0),
  primary key (unit_id, id),
  foreign key (unit_id, loan_id) references public.loan_groups(unit_id, id),
  foreign key (unit_id, berkas_id) references public.berkas(unit_id, id),
  foreign key (unit_id, item_id) references public.item(unit_id, id)
);
create index if not exists loan_objects_group_idx on public.loan_objects (unit_id, loan_id);
create index if not exists loan_objects_archive_idx on public.loan_objects (unit_id, berkas_id, item_id);

alter table public.loan_groups enable row level security;
alter table public.loan_objects enable row level security;
alter table public.loan_groups force row level security;
alter table public.loan_objects force row level security;
revoke all on public.loan_groups, public.loan_objects from public, anon, authenticated, service_role;
grant select on public.loan_groups, public.loan_objects to service_role;

create or replace function app.loan_private_text(p_value text)
returns bytea language plpgsql volatile set search_path = '' as $$
begin
  if nullif(p_value, '') is null then return null; end if;
  return extensions.pgp_sym_encrypt(p_value, app.server_secret('LOAN_PII_KEY'), 'cipher-algo=aes256, compress-algo=0');
end
$$;
revoke all on function app.loan_private_text(text) from public, anon, authenticated, service_role;

create or replace function app.loan_status_refresh(p_unit_id uuid, p_loan_id text, p_returned boolean)
returns void language plpgsql volatile set search_path = '' as $$
begin
  -- Only selected items change. Retain unrelated migrated/partially borrowed items.
  update public.item i set status_peminjaman = case when p_returned then 'TERSEDIA'
    when o.item_id is null then 'DIPINJAM DALAM BERKAS' else 'DIPINJAM' end
  from public.loan_objects o
  where o.unit_id = p_unit_id and o.loan_id = p_loan_id and i.unit_id = o.unit_id
    and i.berkas_id = o.berkas_id and not i.is_deleted and (o.item_id is null or o.item_id = i.id);

  update public.berkas b set status_peminjaman = case
    when not p_returned and exists (select 1 from public.loan_objects o
      where o.unit_id = b.unit_id and o.loan_id = p_loan_id and o.berkas_id = b.id and o.item_id is null) then 'DIPINJAM'
    when exists (select 1 from public.item i where i.unit_id = b.unit_id and i.berkas_id = b.id and not i.is_deleted
      and i.status_peminjaman <> 'TERSEDIA') then 'SEBAGIAN DIPINJAM'
    else 'TERSEDIA' end
  where b.unit_id = p_unit_id and exists (select 1 from public.loan_objects o
    where o.unit_id = b.unit_id and o.loan_id = p_loan_id and o.berkas_id = b.id);
end
$$;
revoke all on function app.loan_status_refresh(uuid,text,boolean) from public, anon, authenticated, service_role;

create or replace function public.loan_create(
  p_unit_id uuid, p_request_id uuid, p_borrower jsonb, p_choices jsonb,
  p_borrowed_on date, p_due_on date, p_condition text, p_purpose text, p_notes text, p_page_count integer)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  a app.actor := app.require_actor(p_unit_id, true);
  v_id text := 'PIN-' || gen_random_uuid();
  v_hash text;
  v_replay jsonb;
  v_choice jsonb;
  v_b public.berkas;
  v_i public.item;
  v_item_id text;
  v_seen_berkas text[] := '{}';
  v_seen_items text[];
  v_location text;
  v_count integer := 0;
  v_pages integer;
  v_name text := app.clean_text(p_borrower->>'name',250);
  v_position text := app.clean_text(p_borrower->>'position',250);
  v_unit text := app.clean_text(p_borrower->>'unit',250);
  v_officer text := app.clean_text(p_borrower->>'officer_name',250);
  v_officer_position text := app.clean_text(p_borrower->>'officer_position',250);
  v_purpose text := app.clean_text(p_purpose,1000);
begin
  perform app.lock_unit(a.unit_id);
  v_hash := encode(extensions.digest(jsonb_build_array(p_borrower,p_choices,p_borrowed_on,p_due_on,p_condition,p_purpose,p_notes,p_page_count)::text, 'sha256'), 'hex');
  v_replay := app.idem_lookup(a.unit_id,p_request_id,'loan_create',v_hash);
  if v_replay is not null then return v_replay; end if;
  if v_name = '' or v_position = '' or v_unit = '' or v_officer = '' or v_officer_position = '' or v_purpose = ''
    or p_borrowed_on is null or p_borrowed_on > app.today_jakarta() or p_due_on is null or p_due_on < p_borrowed_on
    or coalesce(p_condition,'') not in ('BAIK','RUSAK RINGAN','RUSAK SEDANG','RUSAK BERAT') or coalesce(p_page_count,0) < 1 then
    perform app.fail('INVALID_INPUT','Lengkapi data peminjam, petugas, tanggal, kondisi fisik, dan jumlah lembar.');
  end if;
  if jsonb_typeof(p_choices) is distinct from 'array' then
    perform app.fail('INVALID_INPUT','Pilih arsip yang akan dipinjam.');
  end if;
  if jsonb_array_length(p_choices) not between 1 and 100 then
    perform app.fail('INVALID_INPUT','Maksimal 100 objek per transaksi.');
  end if;

  insert into public.loan_groups (unit_id,id,borrower_name,borrower_position,borrower_unit,borrower_identity_enc,
    borrower_whatsapp_enc,officer_name,officer_position,officer_identity_enc,purpose,borrowed_on,due_on,borrow_condition,notes,page_count,created_by)
  values (a.unit_id,v_id,v_name,v_position,v_unit,app.loan_private_text(app.clean_text(p_borrower->>'identity',100)),
    app.loan_private_text(app.clean_text(p_borrower->>'whatsapp',50)),v_officer,v_officer_position,
    app.loan_private_text(app.clean_text(p_borrower->>'officer_identity',100)),v_purpose,p_borrowed_on,p_due_on,p_condition,
    nullif(app.clean_text(p_notes,2000),''),p_page_count,a.user_id);

  for v_choice in select value from jsonb_array_elements(p_choices) loop
    select * into v_b from public.berkas b where b.unit_id = a.unit_id and b.id = v_choice->>'berkas_id'
      and not b.is_deleted and b.no_berkas_definitif is not null and b.status_berkas not in ('DIHAPUS','GAGAL')
      and upper(coalesce(b.status_pemindahan,'')) <> 'SUDAH DIPINDAHKAN';
    if not found then perform app.fail('NOT_FOUND','Berkas tidak ditemukan atau tidak dapat dipinjam.'); end if;
    if v_b.id = any(v_seen_berkas) then perform app.fail('INVALID_INPUT','Satu berkas hanya boleh dipilih sekali.'); end if;
    v_seen_berkas := array_append(v_seen_berkas,v_b.id);
    v_location := coalesce(app.lokasi_label(v_b.no_filling_kabinet,v_b.no_laci,v_b.no_folder,v_b.no_berkas_definitif),'—');
    if jsonb_typeof(v_choice->'item_ids') is distinct from 'array' then
      perform app.fail('INVALID_INPUT','Pilihan item tidak valid.');
    end if;

    if jsonb_array_length(v_choice->'item_ids') = 0 then
      if v_b.status_peminjaman <> 'TERSEDIA' or exists (select 1 from public.item i where i.unit_id = a.unit_id
        and i.berkas_id = v_b.id and not i.is_deleted and i.status_peminjaman <> 'TERSEDIA') then
        perform app.fail('OBJECT_BORROWED','Berkas atau salah satu itemnya masih dipinjam.');
      end if;
      select coalesce(sum(i.jumlah_halaman),0) into v_pages from public.item i
        where i.unit_id = a.unit_id and i.berkas_id = v_b.id and not i.is_deleted;
      v_count := v_count + 1;
      insert into public.loan_objects (unit_id,id,loan_id,berkas_id,berkas_no,berkas_title,location,page_count)
        values (a.unit_id,gen_random_uuid()::text,v_id,v_b.id,v_b.no_berkas_definitif,v_b.judul_berkas,v_location,v_pages);
    else
      if v_b.status_peminjaman not in ('TERSEDIA','SEBAGIAN DIPINJAM') then
        perform app.fail('OBJECT_BORROWED','Berkas sedang dipinjam seluruhnya.');
      end if;
      if v_count + jsonb_array_length(v_choice->'item_ids') > 100 then
        perform app.fail('INVALID_INPUT','Maksimal 100 objek per transaksi.');
      end if;
      v_seen_items := '{}';
      for v_item_id in select value from jsonb_array_elements_text(v_choice->'item_ids') loop
        if v_item_id = any(v_seen_items) then perform app.fail('INVALID_INPUT','Item dipilih lebih dari sekali.'); end if;
        v_seen_items := array_append(v_seen_items,v_item_id);
        select * into v_i from public.item i where i.unit_id = a.unit_id and i.berkas_id = v_b.id and i.id = v_item_id and not i.is_deleted;
        if not found then perform app.fail('NOT_FOUND','Item tidak ditemukan di dalam berkas yang dipilih.'); end if;
        if v_i.status_peminjaman <> 'TERSEDIA' then perform app.fail('OBJECT_BORROWED','Item masih dipinjam.'); end if;
        v_count := v_count + 1;
        insert into public.loan_objects (unit_id,id,loan_id,berkas_id,item_id,berkas_no,berkas_title,item_no,item_description,location,page_count)
          values (a.unit_id,gen_random_uuid()::text,v_id,v_b.id,v_i.id,v_b.no_berkas_definitif,v_b.judul_berkas,v_i.no_item_definitif,
            v_i.uraian_lengkap,v_location,coalesce(v_i.jumlah_halaman,0));
      end loop;
    end if;
    if v_count > 100 then perform app.fail('INVALID_INPUT','Maksimal 100 objek per transaksi.'); end if;
  end loop;
  perform app.loan_status_refresh(a.unit_id,v_id,false);
  perform app.audit(a,'LOAN_CREATE','PEMINJAMAN','LOAN',v_id,'Peminjaman arsip dicatat',null,p_request_id::text,
    null,jsonb_build_object('object_count',v_count));
  return app.idem_store(a.unit_id,p_request_id,'loan_create',v_hash,a.user_id,jsonb_build_object('id',v_id));
end
$$;

create or replace function public.loan_return(p_unit_id uuid, p_request_id uuid, p_loan_id text, p_returned_on date,
  p_condition text, p_officer jsonb, p_notes text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  a app.actor := app.require_actor(p_unit_id,true);
  v_hash text := encode(extensions.digest(jsonb_build_array(p_loan_id,p_returned_on,p_condition,p_officer,p_notes)::text,'sha256'),'hex');
  v_replay jsonb;
  v_loan public.loan_groups;
  v_name text := app.clean_text(p_officer->>'name',250);
  v_position text := app.clean_text(p_officer->>'position',250);
begin
  perform app.lock_unit(a.unit_id);
  v_replay := app.idem_lookup(a.unit_id,p_request_id,'loan_return',v_hash);
  if v_replay is not null then return v_replay; end if;
  select * into v_loan from public.loan_groups where unit_id = a.unit_id and id = p_loan_id;
  if not found then perform app.fail('NOT_FOUND','Transaksi peminjaman tidak ditemukan.'); end if;
  if v_loan.returned_on is not null then perform app.fail('LOAN_RETURNED','Transaksi ini sudah dikembalikan.'); end if;
  if v_name = '' or v_position = '' or p_returned_on is null or p_returned_on < v_loan.borrowed_on
    or p_returned_on > app.today_jakarta() or coalesce(p_condition,'') not in ('BAIK','RUSAK RINGAN','RUSAK SEDANG','RUSAK BERAT') then
    perform app.fail('INVALID_INPUT','Lengkapi tanggal kembali, kondisi fisik, dan data petugas.');
  end if;
  update public.loan_groups set returned_on = p_returned_on, return_condition = p_condition,
    return_officer_name = v_name, return_officer_position = v_position,
    return_officer_identity_enc = app.loan_private_text(app.clean_text(p_officer->>'identity',100)),
    return_notes = nullif(app.clean_text(p_notes,2000),''), returned_at = now(), returned_by = a.user_id
    where unit_id = a.unit_id and id = p_loan_id;
  perform app.loan_status_refresh(a.unit_id,p_loan_id,true);
  perform app.audit(a,'LOAN_RETURN','PEMINJAMAN','LOAN',p_loan_id,'Seluruh objek transaksi dikembalikan',null,p_request_id::text);
  return app.idem_store(a.unit_id,p_request_id,'loan_return',v_hash,a.user_id,jsonb_build_object('id',p_loan_id));
end
$$;

create or replace function public.loan_options(p_unit_id uuid, p_query text, p_berkas_id text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  a app.actor := app.require_actor(p_unit_id,true);
  q text := app.clean_text(p_query,200);
begin
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id',b.id,'number',b.no_berkas_definitif,'title',b.judul_berkas,'status',b.status_peminjaman,
    'pages',coalesce((select sum(i.jumlah_halaman) from public.item i where i.unit_id = b.unit_id and i.berkas_id = b.id and not i.is_deleted),0),
    'items', case when p_berkas_id is null then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object(
      'id',i.id,'number',i.no_item_definitif,'title',i.uraian_lengkap,'status',i.status_peminjaman,'pages',coalesce(i.jumlah_halaman,0))
      order by i.no_item_definitif nulls last,i.id) from public.item i where i.unit_id = b.unit_id and i.berkas_id = b.id and not i.is_deleted),'[]'::jsonb) end
    ) order by b.no_berkas_definitif,b.id) from (select * from public.berkas a_b
      where a_b.unit_id = a.unit_id and not a_b.is_deleted and a_b.no_berkas_definitif is not null
        and a_b.status_berkas not in ('DIHAPUS','GAGAL') and upper(coalesce(a_b.status_pemindahan,'')) <> 'SUDAH DIPINDAHKAN'
        and (case when p_berkas_id is not null then a_b.id = p_berkas_id else
          q = '' or a_b.no_berkas_definitif::text = q or strpos(lower(a_b.judul_berkas),lower(q)) > 0 end)
      order by a_b.no_berkas_definitif,a_b.id limit 30) b),'[]'::jsonb);
end
$$;

create or replace function public.loan_list(p_unit_id uuid, p_status text, p_offset integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  a app.actor := app.require_actor(p_unit_id,true);
begin
  if coalesce(p_status,'') not in ('ACTIVE','RETURNED') then perform app.fail('INVALID_INPUT','Filter transaksi tidak valid.'); end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
    'id',g.id,'borrower_name',g.borrower_name,'borrower_unit',g.borrower_unit,'borrower_position',g.borrower_position,
    'officer_name',g.officer_name,'purpose',g.purpose,'borrow_condition',g.borrow_condition,'notes',g.notes,
    'borrowed_on',g.borrowed_on,'due_on',g.due_on,'returned_on',g.returned_on,'return_condition',g.return_condition,'page_count',g.page_count,
    'objects', coalesce((select jsonb_agg(jsonb_build_object(
      'berkas_id',o.berkas_id,'item_id',o.item_id,'berkas_no',o.berkas_no,'berkas_title',o.berkas_title,'item_no',o.item_no,
      'item_description',o.item_description,'location',o.location,'page_count',o.page_count) order by o.berkas_no,o.item_no,o.id)
      from public.loan_objects o where o.unit_id = g.unit_id and o.loan_id = g.id),'[]'::jsonb))
    order by g.borrowed_on desc,g.created_at desc,g.id) from (select * from public.loan_groups l
      where l.unit_id = a.unit_id and (l.returned_on is null) = (p_status = 'ACTIVE')
      order by l.borrowed_on desc,l.created_at desc,l.id limit 25 offset greatest(0,coalesce(p_offset,0))) g),'[]'::jsonb);
end
$$;

-- Explicit privileges: contacts are never exposed via the read RPCs or direct API access.
revoke all on function public.loan_create(uuid,uuid,jsonb,jsonb,date,date,text,text,text,integer),
  public.loan_return(uuid,uuid,text,date,text,jsonb,text), public.loan_options(uuid,text,text), public.loan_list(uuid,text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.loan_create(uuid,uuid,jsonb,jsonb,date,date,text,text,text,integer),
  public.loan_return(uuid,uuid,text,date,text,jsonb,text), public.loan_options(uuid,text,text), public.loan_list(uuid,text,integer)
  to authenticated;

-- Preserve migrated status-only berkas until legacy loan groups are reconciled.
create or replace function app.active_loan_summary(p_unit_id uuid)
returns table (n bigint, ids text[]) language sql stable security definer set search_path = '' as $$
  select count(distinct (g.unit_id,g.id)),coalesce(array_agg(distinct o.berkas_id),'{}')
  from public.loan_groups g join public.loan_objects o on o.unit_id = g.unit_id and o.loan_id = g.id
  where g.returned_on is null and (p_unit_id is null or g.unit_id = p_unit_id)
    and (current_setting('role',true) = 'service_role' or app.current_role() = 'ADMIN_PUSAT' or g.unit_id = app.current_unit_id())
$$;
revoke all on function app.active_loan_summary(uuid) from public, anon, authenticated, service_role;
grant execute on function app.active_loan_summary(uuid) to authenticated, service_role;

create or replace function public.dashboard_overview(p_unit_id uuid default null)
returns jsonb
language sql stable security invoker
set search_path = ''
as $$
  with rows as materialized (select * from app.dashboard_berkas(p_unit_id)),
       tally as (select * from app.active_loan_summary(p_unit_id))
  select pg_catalog.jsonb_build_object(
    'today', app.today_jakarta(),
    'counts', pg_catalog.jsonb_build_object(
      'total_berkas', (select count(*) from rows),
      'total_item', (select coalesce(sum(item_count), 0) from rows),
      'sedang_dipinjam', ((select n from tally) + (select count(*) from rows r cross join tally t where r.dipinjam and not (r.berkas_id = any(t.ids)))),
      'retensi_h7', (select count(*) from rows where days_to_active_limit between 0 and 7),
      'habis_aktif', (select count(*) from rows where days_to_active_limit < 0)),
    'groups', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'berkas_id', r.berkas_id, 'no_berkas', r.no_berkas, 'judul_berkas', r.judul_berkas,
               'kode_klasifikasi', r.kode_klasifikasi, 'kurun_waktu', r.kurun_waktu,
               'kabinet', r.kabinet, 'laci', r.laci, 'folder', r.folder, 'lokasi', r.lokasi,
               'item_count', r.item_count, 'total_lembar', r.total_lembar,
               'status_code', r.status_code, 'status_label', r.status_label,
               'batas_aktif', r.batas_aktif, 'days_to_active_limit', r.days_to_active_limit,
               'dipinjam', r.dipinjam)
             order by r.no_berkas, r.berkas_id)
      from rows r where r.no_berkas is not null), '[]'::jsonb))
$$;

insert into public.schema_migrations_log (version,name) values ('0024','s4_loans') on conflict (version) do nothing;
