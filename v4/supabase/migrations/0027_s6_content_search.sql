-- Searchable pages derived from a committed browser OCR upload.
-- Raw text is private; the read RPC returns only an excerpt for current PDFs.
create table if not exists public.content_documents (
  unit_id uuid not null,
  item_id text not null,
  source_pdf_id text not null,
  status text not null default 'READY' check (status in ('READY', 'STALE')),
  indexed_at timestamptz not null default now(),
  primary key (unit_id, item_id, source_pdf_id),
  foreign key (unit_id, item_id) references public.item (unit_id, id) on delete cascade
);
create table if not exists app.content_pages (
  unit_id uuid not null,
  item_id text not null,
  source_pdf_id text not null,
  page_no integer not null check (page_no between 1 and 30),
  body text not null check (pg_catalog.char_length(body) between 1 and 8000),
  lexemes tsvector generated always as (pg_catalog.to_tsvector('pg_catalog.simple'::regconfig, body)) stored,
  primary key (unit_id, item_id, source_pdf_id, page_no),
  foreign key (unit_id, item_id, source_pdf_id)
    references public.content_documents (unit_id, item_id, source_pdf_id) on delete cascade
);
create index if not exists content_pages_lexemes_idx on app.content_pages using gin (lexemes);
alter table public.content_documents enable row level security;
alter table public.content_documents force row level security;
alter table app.content_pages enable row level security;
alter table app.content_pages force row level security;
revoke all on public.content_documents, app.content_pages from public, anon, authenticated, service_role;

-- 0018 marks the matching document STALE when the source file is replaced
-- or cancelled. Keep its status but purge old OCR text from the live index.
create or replace function app.purge_stale_content()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  delete from app.content_pages
  where unit_id = new.unit_id and item_id = new.item_id and source_pdf_id = new.source_pdf_id;
  return new;
end
$$;
revoke all on function app.purge_stale_content() from public, anon, authenticated;
drop trigger if exists purge_stale_content on public.content_documents;
create trigger purge_stale_content after update of status on public.content_documents
for each row when (old.status is distinct from new.status and new.status = 'STALE')
execute function app.purge_stale_content();

-- Idempotent by the attested source upload. No worker, service key or folder grant.
create or replace function public.index_scan_content(p_session_id uuid, p_pages jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  s public.upload_sessions;
  a app.actor;
  v_count integer;
  v_total integer;
begin
  select * into s from public.upload_sessions where id = p_session_id and owner_user_id = auth.uid();
  a := app.require_actor_object(s.unit_id, 'Sesi unggah', true);
  if s.owner_user_id <> a.user_id or s.status <> 'COMMITTED' or s.purpose <> 'ITEM_PDF'
     or s.drive_file_id is null then
    perform app.fail('UPLOAD_SESSION_STATE', 'PDF hasil pindai belum selesai diunggah.');
  end if;
  if pg_catalog.jsonb_typeof(p_pages) is distinct from 'array'
     or pg_catalog.octet_length(p_pages::text) > 260000 then
    perform app.fail('INVALID_INPUT', 'Data OCR tidak valid atau terlalu panjang.');
  end if;
  if pg_catalog.jsonb_array_length(p_pages) not between 1 and 30 then
    perform app.fail('INVALID_INPUT', 'Jumlah halaman OCR tidak valid.');
  end if;
  if exists (select 1 from pg_catalog.jsonb_array_elements(p_pages) v
             where pg_catalog.jsonb_typeof(v) not in ('string','null')
                or pg_catalog.char_length(v #>> '{}') > 8000) then
    perform app.fail('INVALID_INPUT', 'Teks OCR halaman tidak valid atau terlalu panjang.');
  end if;
  select coalesce(pg_catalog.sum(pg_catalog.char_length(v)), 0) into v_total
  from pg_catalog.jsonb_array_elements_text(p_pages) v;
  if v_total > 48000 then
    perform app.fail('INVALID_INPUT', 'Teks OCR melampaui batas satu PDF.');
  end if;

  perform app.lock_unit(a.unit_id);
  -- Match the source and exclude cancelled/failed records, even if a
  -- retry of indexing arrives after another operator replaces the PDF.
  if not exists (
    select 1 from public.item i join public.berkas b on (b.unit_id, b.id) = (i.unit_id, i.berkas_id)
    where (i.unit_id, i.id, i.drive_file_id) = (s.unit_id, s.object_id, s.drive_file_id)
      and not i.is_deleted and not b.is_deleted and b.status_berkas not in ('DIHAPUS', 'GAGAL')
  ) then
    perform app.fail('NOT_FOUND', 'File pindai tidak lagi terhubung dengan item aktif.');
  end if;
  -- Replays leave the originally indexed text unchanged.
  insert into public.content_documents (unit_id, item_id, source_pdf_id)
  values (s.unit_id, s.object_id, s.drive_file_id) on conflict do nothing;
  if found then
    insert into app.content_pages (unit_id, item_id, source_pdf_id, page_no, body)
    select s.unit_id, s.object_id, s.drive_file_id, n::integer, pg_catalog.btrim(v)
    from pg_catalog.jsonb_array_elements_text(p_pages) with ordinality as p(v, n)
    where nullif(pg_catalog.btrim(v), '') is not null;
  end if;
  select pg_catalog.count(*) into v_count from app.content_pages p
  where (p.unit_id, p.item_id, p.source_pdf_id) = (s.unit_id, s.object_id, s.drive_file_id);
  if v_count = 0 then
    perform app.fail('INVALID_INPUT', 'Tidak ada teks OCR yang dapat diindeks.');
  end if;
  return pg_catalog.jsonb_build_object('indexed_pages', v_count);
end
$$;

-- Read permissions mirror active archive PDFs in 0008: all active archive
-- reader roles for their own unit; a central admin can choose all/one unit.
-- Only snippets from the paginated hits leave the private table.
create or replace function public.search_scan_content(
  p_query text, p_unit_id uuid default null, p_phrase boolean default false,
  p_limit integer default 12, p_offset integer default 0
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  a app.actor := app.actor_base(false);
  v_scope uuid;
  v_words text := pg_catalog.btrim(pg_catalog.left(coalesce(p_query, ''), 150));
  v_query tsquery;
  v_limit integer := least(greatest(coalesce(p_limit, 12), 1), 24);
  v_offset integer := least(greatest(coalesce(p_offset, 0), 0), 10000);
  v_result jsonb;
begin
  if not a.is_pusat and (a.unit_id is null or (p_unit_id is not null and p_unit_id <> a.unit_id)) then
    perform app.fail('FORBIDDEN_UNIT', 'Anda hanya dapat mencari data unit Anda sendiri.');
  end if;
  v_scope := case when a.is_pusat then p_unit_id else a.unit_id end;
  if pg_catalog.char_length(v_words) < 2 then
    perform app.fail('INVALID_INPUT', 'Masukkan sedikitnya 2 karakter pencarian.');
  end if;
  v_query := case when p_phrase
    then pg_catalog.phraseto_tsquery('pg_catalog.simple'::regconfig, v_words)
    else pg_catalog.plainto_tsquery('pg_catalog.simple'::regconfig, v_words) end;
  if pg_catalog.numnode(v_query) = 0 then
    return '{"results":[],"has_more":false}';
  end if;

  with hits as materialized (
    select p.page_no, p.body, i.id as item_id, b.id as berkas_id,
      i.no_item_definitif as no_item, b.no_berkas_definitif as no_berkas,
      b.judul_berkas as title, i.uraian_lengkap as description, u.code as unit_code,
      pg_catalog.ts_rank_cd(p.lexemes, v_query) as rank
    from app.content_pages p
    join public.content_documents d using (unit_id, item_id, source_pdf_id)
    join public.item i on (i.unit_id, i.id, i.drive_file_id) = (p.unit_id, p.item_id, p.source_pdf_id)
    join public.berkas b on (b.unit_id, b.id) = (i.unit_id, i.berkas_id)
    join public.units u on u.id = p.unit_id and u.active
    where d.status = 'READY' and p.lexemes @@ v_query
      and (v_scope is null or p.unit_id = v_scope)
      and not i.is_deleted and not b.is_deleted and b.status_berkas not in ('DIHAPUS', 'GAGAL')
    order by rank desc, i.id, p.page_no
    limit v_limit + 1 offset v_offset
  ), shown as (
    select h.item_id, h.berkas_id, h.no_item, h.no_berkas, h.title, h.description, h.unit_code, h.page_no, h.rank,
      pg_catalog.left(pg_catalog.replace(pg_catalog.replace(
        pg_catalog.ts_headline('pg_catalog.simple'::regconfig, h.body, v_query, 'MaxFragments=1,MaxWords=24,MinWords=10'),
        '<b>', ''), '</b>', ''), 360) as snippet
    from hits h order by h.rank desc, h.item_id, h.page_no limit v_limit
  )
  select pg_catalog.jsonb_build_object(
    'results', coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(s) - 'rank'
      order by s.rank desc, s.item_id, s.page_no) from shown s), '[]'::jsonb),
    'has_more', v_offset + v_limit <= 10000 and (select pg_catalog.count(*) from hits) > v_limit)
  into v_result;
  return v_result;
end
$$;

revoke all on function public.index_scan_content(uuid, jsonb),
  public.search_scan_content(text, uuid, boolean, integer, integer) from public, anon, authenticated, service_role;
grant execute on function public.index_scan_content(uuid, jsonb),
  public.search_scan_content(text, uuid, boolean, integer, integer) to authenticated;

insert into public.schema_migrations_log(version, name) values ('0027', 's6_content_search')
on conflict (version) do nothing;
