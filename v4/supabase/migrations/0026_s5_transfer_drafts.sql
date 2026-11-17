-- S5 slice one: retention and local drafts. No outbox, document creation or RC calls.
create table if not exists public.transfer_drafts (
  unit_id uuid not null references public.units(id),
  id text not null,
  draft_number text not null,
  title text not null,
  notes text,
  created_at timestamptz not null default now(),
  created_by uuid,
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancel_reason text,
  berkas_count integer not null check (berkas_count between 1 and 200),
  item_count integer not null check (item_count >= berkas_count),
  -- A document packet uses these frozen values, never the current archive rows.
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'array' and jsonb_array_length(snapshot) = berkas_count),
  primary key (unit_id,id),
  unique (unit_id,draft_number),
  check ((cancelled_at is null) = (cancel_reason is null))
);
create index if not exists transfer_drafts_unit_time on public.transfer_drafts (unit_id,created_at desc,id);
alter table public.transfer_drafts enable row level security;
alter table public.transfer_drafts force row level security;
revoke all on public.transfer_drafts from public,anon,authenticated,service_role;
grant select on public.transfer_drafts to service_role;

-- One item snapshot per row keeps backed-up rows and document-generation reads bounded.
create table if not exists public.transfer_draft_items (
  unit_id uuid not null,
  id text not null,
  draft_id text not null,
  berkas_id text not null,
  item_id text not null,
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object'),
  primary key (unit_id,id),
  unique (unit_id,draft_id,item_id),
  foreign key (unit_id,draft_id) references public.transfer_drafts(unit_id,id)
);
alter table public.transfer_draft_items enable row level security;
alter table public.transfer_draft_items force row level security;
revoke all on public.transfer_draft_items from public,anon,authenticated,service_role;
grant select on public.transfer_draft_items to service_role;

create or replace function app.transfer_block(p_berkas public.berkas, p_items bigint, p_borrowed boolean)
returns text language sql stable set search_path = '' as $$
  select case
    when p_berkas.is_deleted or p_berkas.status_berkas <> 'AKTIF' or p_berkas.no_berkas_definitif is null then 'Berkas belum aktif dan bernomor definitif.'
    when upper(btrim(coalesce(p_berkas.status_pemindahan,''))) = 'SUDAH DIPINDAHKAN' then 'Berkas sudah dipindahkan.'
    when nullif(btrim(p_berkas.usul_pindah_id_aktif),'') is not null then 'Berkas sudah berada dalam usul pemindahan.'
    when p_berkas.batas_aktif is null or p_berkas.batas_aktif >= app.today_jakarta() then 'Masa retensi aktif belum berakhir.'
    when p_borrowed then 'Berkas atau salah satu item sedang dipinjam.'
    when p_items = 0 then 'Berkas belum memiliki item aktif.'
    when coalesce(p_berkas.status_verifikasi_metadata,'') <> 'TERVERIFIKASI' then 'Metadata berkas belum terverifikasi.'
  end
$$;

create or replace function public.retention_candidates(p_unit_id uuid,p_filter text,p_offset integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare a app.actor := app.require_actor(p_unit_id,true);
begin
  if coalesce(p_filter,'') not in ('H7','HABIS') then perform app.fail('INVALID_INPUT','Pilih filter retensi yang valid.'); end if;
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.batas_aktif,x.no_berkas,x.berkas_id)
    from (select r.berkas_id,r.no_berkas,r.judul_berkas,r.lokasi,r.kode_klasifikasi,r.kurun_waktu,
      r.item_count,r.batas_aktif,r.batas_inaktif,r.days_to_active_limit,r.usul_pindah_no,r.status_code,r.status_label,
      b.nasib_akhir,app.transfer_block(b,r.item_count,r.dipinjam) blocked_reason
      from app.dashboard_berkas(a.unit_id) r join public.berkas b on b.unit_id=a.unit_id and b.id=r.berkas_id
      where b.status_berkas='AKTIF' and r.no_berkas is not null and
        case when p_filter='H7' then r.days_to_active_limit between 0 and 7 else r.days_to_active_limit < 0 end
      order by r.batas_aktif,r.no_berkas,r.berkas_id limit 25 offset greatest(0,coalesce(p_offset,0))) x),'[]'::jsonb);
end
$$;

create or replace function public.transfer_drafts_list(p_unit_id uuid,p_offset integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare a app.actor := app.require_actor(p_unit_id,true);
begin
  return coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at desc,x.id)
    from (select d.id,d.draft_number,d.title,d.notes,d.created_at,d.cancelled_at,d.cancel_reason,d.berkas_count,d.item_count
      from public.transfer_drafts d where d.unit_id=a.unit_id
      order by d.created_at desc,d.id limit 25 offset greatest(0,coalesce(p_offset,0))) x),'[]'::jsonb);
end
$$;

create or replace function public.transfer_draft_get(p_unit_id uuid,p_draft_id text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare a app.actor := app.require_actor(p_unit_id,true); v_snapshot jsonb;
begin
  select jsonb_agg(jsonb_build_object('berkas_id',f.value->'berkas_id','number',f.value->'number',
      'title',f.value->'title','batas_aktif',f.value->'batas_aktif','location',f.value->'location',
      'item_count',f.value->'item_count') order by f.ordinality) into v_snapshot
    from public.transfer_drafts d cross join lateral jsonb_array_elements(d.snapshot) with ordinality f(value,ordinality)
    where d.unit_id=a.unit_id and d.id=p_draft_id;
  if v_snapshot is null then perform app.fail('NOT_FOUND','Draf usul tidak ditemukan.'); end if;
  return v_snapshot;
end
$$;

create or replace function public.transfer_draft_create(p_unit_id uuid,p_request_id uuid,p_berkas_ids text[],p_title text,p_notes text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  a app.actor := app.require_actor(p_unit_id,true);
  v_ids text[]; v_title text := coalesce(nullif(app.clean_text(p_title,300),''),'Usul Pemindahan Arsip Inaktif');
  v_notes text := nullif(app.clean_text(p_notes,2000),'');
  v_id text := 'USP-'||p_request_id::text;
  v_year text := extract(year from app.today_jakarta())::text;
  v_number text;
  v_hash text; v_replay jsonb; v_reason text; v_found integer; v_snapshot jsonb; v_items integer;
begin
  if coalesce(cardinality(p_berkas_ids),0) not between 1 and 200 or array_ndims(p_berkas_ids) <> 1
     or exists (select 1 from unnest(p_berkas_ids) x where x is null or btrim(x)='' or length(x)>100) then
    perform app.fail('INVALID_INPUT','Pilih 1–200 berkas berbeda untuk satu draf.');
  end if;
  select array_agg(distinct x order by x) into v_ids from unnest(p_berkas_ids) x;
  if cardinality(v_ids) <> cardinality(p_berkas_ids) then perform app.fail('INVALID_INPUT','Jangan pilih berkas yang sama dua kali.'); end if;

  perform app.lock_unit(a.unit_id);
  v_hash := encode(extensions.digest(jsonb_build_array(v_ids,v_title,v_notes)::text,'sha256'),'hex');
  v_replay := app.idem_lookup(a.unit_id,p_request_id,'transfer_draft_create',v_hash);
  if v_replay is not null then return v_replay; end if;
  select count(*) into v_found from app.dashboard_berkas(a.unit_id) r where r.berkas_id=any(v_ids);
  if v_found<>cardinality(v_ids) then perform app.fail('NOT_FOUND','Ada berkas yang tidak ditemukan atau sudah dipindahkan.'); end if;

  select 'Berkas '||coalesce(r.no_berkas::text,'tanpa nomor')||': '||x.reason into v_reason
    from app.dashboard_berkas(a.unit_id) r join public.berkas b on b.unit_id=a.unit_id and b.id=r.berkas_id
    cross join lateral (select app.transfer_block(b,r.item_count,r.dipinjam) as reason) x
    where r.berkas_id=any(v_ids) and x.reason is not null order by r.no_berkas,r.berkas_id limit 1;
  if v_reason is not null then perform app.fail('TRANSFER_INELIGIBLE',v_reason); end if;

  select jsonb_agg(jsonb_build_object(
    'berkas_id', b.id,'number',b.no_berkas_definitif,'title',b.judul_berkas,'classification_code',b.kode_klasifikasi_snapshot,
    'creator',b.pencipta_arsip_snapshot,'creator_unit_id',b.unit_pencipta_id,'creator_unit',b.unit_pencipta_snapshot,
    'kurun_waktu',b.kurun_waktu,'media',b.media_berkas,'security',b.klasifikasi_keamanan_akses,
    'vital',b.arsip_vital,'terjaga',b.arsip_terjaga,
    'location',app.lokasi_label(b.no_filling_kabinet,b.no_laci,b.no_folder,b.no_berkas_definitif),
    'active_value',b.retensi_aktif_nilai,'active_unit',b.retensi_aktif_satuan,'inactive_value',b.retensi_inaktif_nilai,
    'inactive_unit',b.retensi_inaktif_satuan,'disposition',b.nasib_akhir,'reference_date',b.tgl_acuan_retensi,
    'batas_aktif',b.batas_aktif,'batas_inaktif',b.batas_inaktif,'jra_id',b.jra_id,'jra_basis',b.jra_dasar_hukum,'jra_version',b.jra_versi,
    'item_count',i.n) order by b.no_berkas_definitif,b.id),sum(i.n)
  into v_snapshot,v_items
  from public.berkas b cross join lateral (
    select count(*)::integer n from public.item x where x.unit_id=b.unit_id and x.berkas_id=b.id and not x.is_deleted
  ) i where b.unit_id=a.unit_id and b.id=any(v_ids);

  -- An internal draft number avoids colliding with any legacy UP numbers that
  -- are still to be imported. A formal UP number is assigned in a later slice.
  select 'DRAF-'||v_year||'-'||lpad(n::text,greatest(4,length(n::text)),'0') into v_number
  from (select coalesce(max(split_part(d.draft_number,'-',3)::integer),0)+1 n from public.transfer_drafts d
    where d.unit_id=a.unit_id and d.draft_number like ('DRAF-'||v_year||'-%')) s;
  insert into public.transfer_drafts (unit_id,id,draft_number,title,notes,created_by,berkas_count,item_count,snapshot)
    values (a.unit_id,v_id,v_number,v_title,v_notes,a.user_id,cardinality(v_ids),v_items,v_snapshot);
  insert into public.transfer_draft_items (unit_id,id,draft_id,berkas_id,item_id,snapshot)
    select a.unit_id,'USPI-'||gen_random_uuid(),v_id,x.berkas_id,x.id,
      jsonb_build_object('id',x.id,'number',x.no_item_definitif,'title',x.uraian_lengkap,
        'date',x.tanggal_naskah,'pages',x.jumlah_halaman,'letter_primary',x.no_surat_utama,'letter_alternate',x.no_surat_alternatif,
        'letter_display',x.no_surat_display,'development',x.tingkat_perkembangan,'security',x.klasifikasi_keamanan_akses,
        'media',x.media_sumber,'digital_form',x.status_bentuk_digital,'drive_file_id',x.drive_file_id)
    from public.item x where x.unit_id=a.unit_id and x.berkas_id=any(v_ids) and not x.is_deleted;
  update public.berkas b set usul_pindah_id_aktif=v_id,usul_pindah_no_aktif=v_number,
    status_retensi='DALAM DRAFT USUL PEMINDAHAN',updated_at=now(),updated_by=a.email,version=b.version+1
    where b.unit_id=a.unit_id and b.id=any(v_ids);
  perform app.audit(a,'TRANSFER_DRAFT_CREATE','USUL_PEMINDAHAN','USUL_PINDAH',v_id,'Draf usul pemindahan dibuat',null,p_request_id::text);
  return app.idem_store(a.unit_id,p_request_id,'transfer_draft_create',v_hash,a.user_id,jsonb_build_object('id',v_id,'draft_number',v_number));
end
$$;

create or replace function public.transfer_draft_cancel(p_unit_id uuid,p_request_id uuid,p_draft_id text,p_reason text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  a app.actor := app.require_actor(p_unit_id,true);
  v_reason text := app.clean_text(p_reason,1000);
  v_hash text := encode(extensions.digest(jsonb_build_array(p_draft_id,v_reason)::text,'sha256'),'hex');
  v_replay jsonb; v_draft public.transfer_drafts;
begin
  perform app.lock_unit(a.unit_id);
  v_replay := app.idem_lookup(a.unit_id,p_request_id,'transfer_draft_cancel',v_hash);
  if v_replay is not null then return v_replay; end if;
  if coalesce(length(v_reason),0) < 3 then perform app.fail('INVALID_INPUT','Isi alasan pembatalan minimal 3 karakter.'); end if;
  select * into v_draft from public.transfer_drafts d where d.unit_id=a.unit_id and d.id=p_draft_id;
  if not found then perform app.fail('NOT_FOUND','Draf usul tidak ditemukan.'); end if;
  if v_draft.cancelled_at is not null then perform app.fail('ALREADY_CANCELLED','Draf ini sudah dibatalkan.'); end if;
  update public.transfer_drafts set cancelled_at=now(),cancelled_by=a.user_id,cancel_reason=v_reason
    where unit_id=a.unit_id and id=p_draft_id;
  update public.berkas b set usul_pindah_id_aktif=null,usul_pindah_no_aktif=null,
    status_retensi=case when b.batas_aktif<app.today_jakarta() then 'HABIS AKTIF – KANDIDAT USUL PINDAH'
      when b.batas_aktif-app.today_jakarta() between 0 and 7 then 'H-'||(b.batas_aktif-app.today_jakarta())
      when b.batas_aktif is null then 'MENUNGGU ITEM' else 'AKTIF' end,
    updated_at=now(),updated_by=a.email,version=b.version+1 where b.unit_id=a.unit_id and b.usul_pindah_id_aktif=p_draft_id;
  perform app.audit(a,'TRANSFER_DRAFT_CANCEL','USUL_PEMINDAHAN','USUL_PINDAH',p_draft_id,'Draf usul pemindahan dibatalkan',v_reason,p_request_id::text);
  return app.idem_store(a.unit_id,p_request_id,'transfer_draft_cancel',v_hash,a.user_id,jsonb_build_object('id',p_draft_id));
end
$$;

revoke all on function app.transfer_block(public.berkas,bigint,boolean) from public,anon,authenticated,service_role;
revoke all on function public.retention_candidates(uuid,text,integer),public.transfer_drafts_list(uuid,integer),
  public.transfer_draft_get(uuid,text),public.transfer_draft_create(uuid,uuid,text[],text,text),
  public.transfer_draft_cancel(uuid,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.retention_candidates(uuid,text,integer),public.transfer_drafts_list(uuid,integer),
  public.transfer_draft_get(uuid,text),public.transfer_draft_create(uuid,uuid,text[],text,text),
  public.transfer_draft_cancel(uuid,uuid,text,text) to authenticated;

insert into public.schema_migrations_log (version,name) values ('0026','s5_transfer_drafts') on conflict (version) do nothing;
