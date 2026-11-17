-- Old sheets may not record the condition. loan_create still requires it for every new loan.
alter table public.loan_groups alter column borrow_condition drop not null;

create or replace function public.loan_out_indicator_open(p_unit_id uuid, p_request_id uuid, p_loan_id text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  a app.actor := app.require_actor(p_unit_id,true);
  v_hash text := encode(extensions.digest(jsonb_build_array(p_loan_id)::text,'sha256'),'hex');
  v_replay jsonb;
  v_pages bigint;
begin
  perform app.lock_unit(a.unit_id);
  v_replay := app.idem_lookup(a.unit_id,p_request_id,'loan_out_indicator_open',v_hash);
  if v_replay is not null then return v_replay; end if;
  select count(distinct o.berkas_id) into v_pages from public.loan_objects o
  where o.unit_id = a.unit_id and o.loan_id = p_loan_id;
  if v_pages = 0 then perform app.fail('NOT_FOUND','Transaksi atau rincian arsip tidak ditemukan.'); end if;
  perform app.audit(a,'OUT_INDICATOR_OPEN','PEMINJAMAN','LOAN',p_loan_id,
    'Out Indicator disiapkan untuk dialog cetak browser',null,p_request_id::text,
    null,jsonb_build_object('page_count',v_pages));
  return app.idem_store(a.unit_id,p_request_id,'loan_out_indicator_open',v_hash,a.user_id,jsonb_build_object('id',p_loan_id));
end
$$;

create or replace function public.loan_document_history(p_unit_id uuid, p_loan_id text, p_offset integer)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  a app.actor := app.require_actor(p_unit_id,true);
begin
  if not exists(select 1 from public.loan_groups g where g.unit_id = a.unit_id and g.id = p_loan_id) then
    perform app.fail('NOT_FOUND','Transaksi peminjaman tidak ditemukan.');
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id',h.id,'action',h.action,
    'occurred_at',h.occurred_at,'actor_name',h.actor_name_snapshot,'source_status',h.after_data->>'source_status')
    order by h.occurred_at desc,h.id desc)
    from (select * from public.audit_log l where l.unit_id = a.unit_id and l.module = 'PEMINJAMAN'
      and l.object_type = 'LOAN' and l.object_id = p_loan_id and l.action in
      ('OUT_INDICATOR_OPEN','LEGACY_OUT_INDICATOR','LEGACY_BERITA_ACARA')
      order by l.occurred_at desc,l.id desc limit 25 offset greatest(0,coalesce(p_offset,0))) h),'[]'::jsonb);
end
$$;

revoke all on function public.loan_out_indicator_open(uuid,uuid,text), public.loan_document_history(uuid,text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.loan_out_indicator_open(uuid,uuid,text), public.loan_document_history(uuid,text,integer)
  to authenticated;

insert into public.schema_migrations_log (version,name) values ('0025','s4_loan_history') on conflict (version) do nothing;
