// Synthetic data for the round-trip test: two units with every exported table filled, awkward values
// (quotes, newlines, emoji, backslashes, formulas, huge text), > 1000 rows in one table (paging),
// soft-deleted rows, NULL columns, bigint > 2^31, timestamps with microseconds, jsonb, text[], bytea,
// an identity column (folder_label_log.seq), and cross-unit audit rows (unit_id NULL).
export const UNIT = { A: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', B: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
export const SIZES = { itemsA: 2500, itemsB: 12, berkasA: 40 };

export async function seed(client) {
  const q = (sql, params) => client.query(sql, params);
  await q(`insert into public.units (id, code, name, legacy_instance_id, legacy_unit_id, active) values
    ($1, 'RT-A', 'Unit Uji A — “kutip” & émoji 🙂', 'INS-RT-A', 'U-A', true), ($2, 'RT-B', 'Unit Uji B', null, null, false)`, [UNIT.A, UNIT.B]);
  for (const [k, u] of Object.entries(UNIT)) {
    await q(`insert into public.unit_settings (unit_id, key, value, value_type, description, updated_by) values
      ($1, 'UNIT_NAME', to_jsonb($2::text), 'STRING', 'Nama', 'seed'), ($1, 'ARCHIVE_FOLDER_ID', '"root-folder-${k}"', 'STRING', null, null),
      ($1, 'MAX_LOAN_DAYS', '14', 'NUMBER', 'angka', null), ($1, 'FLAGS', '{"a":[1,2,{"b":null}],"c":"\\\\x"}', 'JSON', null, null)`, [u, `Unit ${k}`]);
    await q(`insert into public.klasifikasi (unit_id, id, parent_id, level, kode_lengkap, uraian, aktif, urutan, kode_primer) values
      ($1, 'K-PR', null, 'PRIMER', 'PR', 'Perencanaan', true, 1, 'PR'), ($1, 'K-PR01', 'K-PR', 'SEKUNDER', 'PR.01', 'Rencana', true, 2, 'PR'),
      ($1, 'K-PR0101', 'K-PR01', 'TERSIER', 'PR.01.01', 'Renstra', true, 3, 'PR'), ($1, 'K-OLD', null, 'PRIMER', 'KU', 'Nonaktif', false, 9, null)`, [u]);
    await q(`insert into public.jenis_naskah (unit_id, subjenis_naskah_id, jenis_naskah_id, kategori, subjenis, pola_default, aktif, urutan, perlu_kelengkapan, opsi_kelengkapan)
      values ($1, 'SJ-1', 'JN-1', 'Kategori', 'Subjenis', 'SERI', true, 1, true, 'a|b')`, [u]);
    await q(`insert into public.pegawai (id, unit_id, nama_pegawai, unit_kerja, aktif, nip_nik_enc, kontak_enc, created_by) values
      ($2, $1, 'Budi O''Brien', 'Subbagian', true, decode('00ff10aa5b7c', 'hex'), decode('deadbeefcafebabe00', 'hex'), 'seed'),
      ($3, $1, 'Sari', null, false, null, null, null)`, [u, `PGW-${k}-1`, `PGW-${k}-2`]);
  }

  // berkas + items for unit A (paging), a handful for B
  await q(`insert into public.berkas (id, unit_id, no_berkas_definitif, judul_berkas, klasifikasi_id, kode_klasifikasi_snapshot, uraian_klasifikasi_snapshot,
      status_berkas, status_peminjaman, kurun_waktu, no_filling_kabinet, no_laci, no_folder, drive_folder_id, klasifikasi_keamanan_akses, batas_aktif, tgl_item_awal,
      jumlah_item, total_halaman, is_deleted, created_by, created_at, nasib_akhir, retensi_aktif_nilai, retensi_aktif_satuan)
    select 'BRK-A-' || g, $1, case when g = 39 then null else g end, case when g % 7 = 0 then '=Berkas "ber-kutip"' || E'\\nbaris dua' else 'Berkas ' || g end,
           'K-PR0101', 'PR.01.01', 'Renstra', case when g = 39 then 'DRAFT' else 'AKTIF' end, 'TERSEDIA', '2026', '1', (g % 5)::text, g::text, 'drv-folder-' || g,
           case when g % 3 = 0 then 'TERBATAS' else 'BIASA/TERBUKA' end, date '2031-01-01' + g, date '2026-01-01' + g, 60, 120, g = 40,
           'seed', timestamptz '2026-03-04 05:06:07.123456+00' + (g || ' minutes')::interval, 'PERMANEN', 5, 'TAHUN'
      from generate_series(1, ${SIZES.berkasA}) g`, [UNIT.A]);
  await q(`insert into public.berkas (id, unit_id, no_berkas_definitif, judul_berkas, klasifikasi_id, status_berkas) values ('BRK-B-1', $1, 1, 'Berkas B', 'K-PR0101', 'AKTIF')`, [UNIT.B]);

  await q(`insert into public.penerimaan (id, unit_id, nomor_tanda_terima, tahun, tanggal_waktu_terima, penyerah_pegawai_id, nama_penerima, unit_penerima, status, created_by,
      bukti_ttd_file_id, bukti_ttd_nama, bukti_ttd_size_bytes, bukti_ttd_md5, version)
    values ('RCV-A-1', $1, 'TRM-2026-0001', 2026, '2026-05-06 07:08:09.654321+07', 'PGW-A-1', 'Penerima', 'Unit', 'AKTIF', 'seed', 'ttdfileidA123456', 'ttd.pdf', 5000000000, 'cd', 3),
      ('RCV-A-2', $1, 'TRM-2026-0012', 2026, '2026-05-07 07:08:09+07', 'PGW-A-1', 'Penerima', 'Unit', 'DIBATALKAN', 'seed', null, null, null, null, 1),
      ('RCV-B-1', $2, 'TRM-2026-0002', 2026, now(), 'PGW-B-1', 'P', 'U', 'AKTIF', 'seed', null, null, null, null, 1)`, [UNIT.A, UNIT.B]);
  await q(`insert into public.penerimaan_item (id, unit_id, penerimaan_id, no_item, uraian_informasi, jumlah_halaman, tingkat_perkembangan, kondisi, status_pemberkasan, berkas_id_tujuan,
      file_digital_id, file_digital_size_bytes, file_digital_sha256, is_deleted)
    values ('RCVI-A-1', $1, 'RCV-A-1', 1, 'Uraian \\ backslash', 3, 'ASLI', 'BAIK', 'SUDAH DIBERKASKAN', 'BRK-A-1', 'digfile00000001', 3000000000, repeat('ab', 32), false),
      ('RCVI-A-2', $1, 'RCV-A-1', 2, null, null, null, null, 'BELUM DIBERKASKAN', null, null, null, null, true)`, [UNIT.A]);

  await q(`insert into public.item (id, unit_id, berkas_id, no_item_definitif, no_surat_utama, no_surat_display, tanggal_naskah, tahun_kurun_waktu, uraian_lengkap, jumlah_halaman,
      tingkat_perkembangan, klasifikasi_keamanan_akses, kode_klasifikasi_snapshot, no_berkas_snapshot, nama_file, drive_file_id, drive_file_url, mime_type,
      drive_file_size_bytes, drive_file_sha256, lampiran, status_file, penerimaan_id, penerimaan_item_id, is_deleted, created_by, created_at, version)
    select 'ITM-A-' || lpad(g::text, 5, '0'), $1, 'BRK-A-' || (1 + g % 38), g,
           'S/' || g, case when g % 50 = 0 then '=HYPERLINK("http://x","y")' else 'S/' || g end, date '2026-02-03' + (g % 300), 2026,
           case g % 5 when 0 then 'Uraian "ganda" dengan ''petik'' dan baris' || E'\\n' || 'kedua 🙂 \\\\ ✓' when 1 then repeat('Panjang ', 400) when 2 then '-minus' when 3 then 'É é ñ 日本語' else 'biasa ' || g end,
           g % 9, 'ASLI', case when g % 4 = 0 then 'TERBATAS' else null end, 'PR.01.01', 1 + g % 38, 'Surat ' || g || '.pdf',
           case when g % 3 = 0 then 'drvfile' || lpad(g::text, 8, '0') end, case when g % 3 = 0 then 'https://drive.google.com/file/d/drvfile' || g || '/view' end, 'application/pdf',
           case when g % 3 = 0 then 3000000000 + g end, case when g % 3 = 0 then repeat('ef', 32) end,
           case when g % 10 = 0 then '[{"nama":"lampiran","id":"x","n":[1,2,3],"o":{"k":null}}]'::jsonb else '[]'::jsonb end,
           'TERSEDIA', case when g = 1 then 'RCV-A-1' end, case when g = 1 then 'RCVI-A-1' end, g % 97 = 0, 'seed',
           timestamptz '2026-04-05 06:07:08.987654+00' + (g || ' seconds')::interval, 1 + g % 4
      from generate_series(1, ${SIZES.itemsA}) g`, [UNIT.A]);
  await q(`insert into public.item (id, unit_id, berkas_id, no_item_definitif, uraian_lengkap, jumlah_halaman, is_deleted)
    select 'ITM-B-' || g, $1, 'BRK-B-1', g, 'Item B ' || g, 1, false from generate_series(1, ${SIZES.itemsB}) g`, [UNIT.B]);

  await q(`insert into public.riwayat_nomor (id, unit_id, jenis_objek, objek_id, berkas_id, nomor_lama, nomor_baru, nama_lama, nama_baru, alasan, created_by) values
    ('HIS-A-1', $1, 'BERKAS', 'BRK-A-1', 'BRK-A-1', null, 1, null, 'Berkas 1', 'awal', 'seed'), ('HIS-A-2', $1, 'ITEM', 'ITM-A-00001', 'BRK-A-1', 3, 1, 'a', 'b', 'renumber', 'seed')`, [UNIT.A]);
  await q(`insert into public.penerimaan_cetak_log (id, unit_id, penerimaan_id, nomor_tanda_terima_snapshot, print_token, cetak_ke, jenis_cetak, status_snapshot, user_email, pdf_file_name)
    values ('RCPL-1', $1, 'RCV-A-1', 'TRM-2026-0001', 'RCPRINT-1', 1, 'PERTAMA', 'AKTIF', 'a@b.c', 'x.pdf'), ('RCPL-2', $1, 'RCV-A-1', 'TRM-2026-0001', 'RCPRINT-2', 2, 'CETAK ULANG', 'AKTIF', null, null)`, [UNIT.A]);
  await q(`insert into public.folder_label_log (id, unit_id, user_email, batch_id, berkas_id, no_berkas_snapshot, kode_klasifikasi_snapshot, judul_berkas_snapshot, start_slot, status)
    values ('PRN-1', $1, 'a@b.c', 'LBL-1', 'BRK-A-1', '1', 'PR.01.01', 'Berkas 1', 3, 'DICETAK'), ('PRN-2', $1, 'a@b.c', 'LBL-1', 'BRK-A-2', '2', 'PR.01.01', 'Berkas 2', 4, 'DICETAK'),
           ('PRN-3', $1, null, 'LBL-2', 'BRK-A-3', null, null, null, null, 'PDF_DIBUAT')`, [UNIT.A]);
  await q(`insert into public.karantina (id, unit_id, object_type, object_id, original_name, module, reason, status, related_object_type, related_object_id, berkas_id, size_bytes, md5, app_owned, quarantine_folder_id)
    values ('QRT-1', $1, 'FILE', 'drvfile00000003', 'Surat 3.pdf', 'EDIT_ARSIP', 'ganti', 'QUARANTINED', 'ITEM', 'ITM-A-00003', 'BRK-A-1', 4000000000, 'ee', true, 'qfolder1'),
           ('QRT-2', $1, 'FOLDER', 'drv-folder-9', 'Folder', 'PENGHAPUSAN_BERKAS', null, 'FAILED', null, null, null, null, null, null, null)`, [UNIT.A]);
  await q(`insert into public.pembatalan_arsip (id, unit_id, scope, berkas_id, item_id, item_ids, alasan, request_id, released_receipt_item_ids, quarantine_ids, bukti_file_id, bukti_size_bytes, created_by)
    values ('BTL-1', $1, 'ITEM', 'BRK-A-1', 'ITM-A-00097', array['ITM-A-00097'], 'salah input', 'req-1', array['RCVI-A-2'], array['QRT-1'], 'buktifile0000001', 123, 'seed'),
           ('BTL-2', $1, 'BERKAS', 'BRK-A-2', null, '{}', 'dobel', 'req-2', '{}', '{}', null, null, null)`, [UNIT.A]);
  await q(`insert into public.drive_tasks (id, unit_id, kind, drive_id, new_name, object_type, object_id, status, attempts, last_error, completed_at)
    values ('11111111-2222-4333-8444-555555555555', $1, 'RENAME_FOLDER', 'drv-folder-1', 'Nama Baru', 'BERKAS', 'BRK-A-1', 'PENDING', 0, null, null),
           ('66666666-7777-4888-8999-000000000000', $1, 'RENAME_FILE', 'drvfile00000003', 'x.pdf', 'ITEM', 'ITM-A-00003', 'DONE', 2, 'sekali gagal', now())`, [UNIT.A]);
  await q(`insert into public.audit_log (id, unit_id, occurred_at, actor_email_snapshot, action, module, object_type, object_id, summary, reason, request_id, result, before_data, after_data)
    select 'LOG-A-' || g, $1, timestamptz '2026-06-07 08:09:10.111222+00' + (g || ' seconds')::interval, 'a@b.c', 'CREATE', 'BERKAS', 'BERKAS', 'BRK-A-1',
           case when g % 2 = 0 then '+plus awal' else 'ringkas' end, null, 'req-' || g, 'SUCCESS',
           case when g % 3 = 0 then '{"x":1}'::jsonb end, jsonb_build_object('n', g, 'arr', jsonb_build_array(1, 'dua', null))
      from generate_series(1, 1200) g`, [UNIT.A]);
  await q(`insert into public.audit_log (id, unit_id, action, summary, result) values ('LOG-B-1', $1, 'UPDATE', 'unit B', 'WARNING')`, [UNIT.B]);
  await q(`insert into public.audit_log (id, unit_id, occurred_at, action, module, summary, result) values
    ('LOG-G-1', null, '2026-07-01 00:00:00.5+00', 'USER_CREATE', 'PENGGUNA', 'akun dibuat (lintas unit)', 'SUCCESS'), ('LOG-G-2', null, '2026-07-02 00:00:00+00', 'USER_UPDATE', 'PENGGUNA', '-', 'FAILED')`);
  await q(`insert into public.loan_groups (unit_id,id,borrower_name,borrower_position,borrower_unit,borrower_identity_enc,
    officer_name,officer_position,purpose,borrowed_on,due_on,borrow_condition,page_count,returned_on)
    values ($1,'PIN-RT','Nama Contoh','Jabatan','Unit',decode('00abcd','hex'),'Petugas','Arsiparis','Tujuan',current_date,current_date,'BAIK',1,current_date)`, [UNIT.A]);
  await q(`insert into public.loan_objects (unit_id,id,loan_id,berkas_id,berkas_no,berkas_title,location,page_count)
    values ($1,'PO-RT','PIN-RT','BRK-A-1',1,'Berkas 1','Laci A',1)`, [UNIT.A]);
  await q(`insert into public.transfer_drafts (unit_id,id,draft_number,title,berkas_count,item_count,snapshot)
    values ($1,'USP-RT','DRAF-2026-0001','Usul uji',1,1,'[{"berkas_id":"BRK-A-1","item_count":1}]')`, [UNIT.A]);
  await q(`insert into public.transfer_draft_items (unit_id,id,draft_id,berkas_id,item_id,snapshot)
    values ($1,'USPI-RT','USP-RT','BRK-A-1','ITM-A-00003','{"title":"Item snapshot","pages":2}')`, [UNIT.A]);
  // counters: TRM numbers are in use up to 12 (A) and 2 (B); BRK counter is not used by the app but must still round-trip
  await q(`insert into public.counters (unit_id, scope, year, last_value) values ($1, 'TRM', 2026, 12), ($1, 'TRM', 2025, 77), ($2, 'TRM', 2026, 2), ($1, 'ZZ_EXTRA', 0, 9000000000)`, [UNIT.A, UNIT.B]);
}
