-- Read-only check for the operator. A future submission must check again
-- in its write transaction; this result is not a reservation or approval.
create or replace function public.transfer_draft_check(p_unit_id uuid, p_draft_id text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  a app.actor := app.require_actor(p_unit_id, true);
  d public.transfer_drafts;
  b public.berkas;
  f jsonb;
  n_items bigint;
  item_borrowed boolean;
  item_changed boolean;
  reason text;
  issues jsonb := '[]'::jsonb;
begin
  select * into d from public.transfer_drafts where unit_id = a.unit_id and id = p_draft_id;
  if not found then perform app.fail('NOT_FOUND', 'Draf usul tidak ditemukan.'); end if;
  if d.cancelled_at is not null then
    perform app.fail('ALREADY_CANCELLED', 'Draf ini sudah dibatalkan.');
  end if;

  for f in select value from jsonb_array_elements(d.snapshot) loop
    select * into b from public.berkas where unit_id = a.unit_id and id = f->>'berkas_id';
    if not found then
      reason := 'Berkas sudah tidak ditemukan.';
    elsif b.usul_pindah_id_aktif is distinct from d.id then
      reason := 'Berkas tidak lagi tercatat dalam draf ini.';
    else
      with current_items as materialized (
        select x.id,
          upper(coalesce(x.status_peminjaman, 'TERSEDIA')) <> 'TERSEDIA' as borrowed,
          -- Compare the exact fields captured at draft creation (0026).
          jsonb_build_object('id',x.id,'number',x.no_item_definitif,'title',x.uraian_lengkap,
            'date',x.tanggal_naskah,'pages',x.jumlah_halaman,'letter_primary',x.no_surat_utama,
            'letter_alternate',x.no_surat_alternatif,'letter_display',x.no_surat_display,
            'development',x.tingkat_perkembangan,'security',x.klasifikasi_keamanan_akses,
            'media',x.media_sumber,'digital_form',x.status_bentuk_digital,'drive_file_id',x.drive_file_id) as snapshot
        from public.item x where x.unit_id = a.unit_id and x.berkas_id = b.id and not x.is_deleted
      ), draft_items as (
        select x.item_id, x.snapshot from public.transfer_draft_items x
        where x.unit_id = a.unit_id and x.draft_id = d.id and x.berkas_id = b.id
      )
      select count(c.id), coalesce(bool_or(c.borrowed), false),
        coalesce(bool_or(c.snapshot is distinct from s.snapshot), false)
        into n_items, item_borrowed, item_changed
      from current_items c full join draft_items s on c.id = s.item_id;

      -- This draft owns the reservation. Reuse all the other eligibility rules.
      b.usul_pindah_id_aktif := null;
      reason := app.transfer_block(b, n_items,
        item_borrowed or upper(coalesce(b.status_peminjaman, 'TERSEDIA')) <> 'TERSEDIA');
      if reason is null and (f - 'item_count') is distinct from jsonb_build_object(
        'berkas_id',b.id,'number',b.no_berkas_definitif,'title',b.judul_berkas,
        'classification_code',b.kode_klasifikasi_snapshot,'creator',b.pencipta_arsip_snapshot,
        'creator_unit_id',b.unit_pencipta_id,'creator_unit',b.unit_pencipta_snapshot,
        'kurun_waktu',b.kurun_waktu,'media',b.media_berkas,'security',b.klasifikasi_keamanan_akses,
        'vital',b.arsip_vital,'terjaga',b.arsip_terjaga,
        'location',app.lokasi_label(b.no_filling_kabinet,b.no_laci,b.no_folder,b.no_berkas_definitif),
        'active_value',b.retensi_aktif_nilai,'active_unit',b.retensi_aktif_satuan,
        'inactive_value',b.retensi_inaktif_nilai,'inactive_unit',b.retensi_inaktif_satuan,
        'disposition',b.nasib_akhir,'reference_date',b.tgl_acuan_retensi,'batas_aktif',b.batas_aktif,
        'batas_inaktif',b.batas_inaktif,'jra_id',b.jra_id,'jra_basis',b.jra_dasar_hukum,'jra_version',b.jra_versi)
      then
        reason := 'Data berkas berubah sejak draf dibuat.';
      elsif reason is null and (item_changed or f->'item_count' is distinct from to_jsonb(n_items)) then
        reason := 'Daftar item atau data item berubah sejak draf dibuat.';
      end if;
    end if;

    if reason is not null then
      issues := issues || jsonb_build_array(jsonb_build_object(
        'berkas_id',f->'berkas_id','number',f->'number','reason',reason));
    end if;
  end loop;

  return jsonb_build_object('eligible', jsonb_array_length(issues) = 0, 'issues', issues);
end
$$;

revoke all on function public.transfer_draft_check(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.transfer_draft_check(uuid,text) to authenticated;

insert into public.schema_migrations_log (version,name) values ('0029','s8_transfer_draft_check')
on conflict (version) do nothing;
