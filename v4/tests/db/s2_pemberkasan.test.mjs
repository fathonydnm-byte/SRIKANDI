// Sprint 2 — Pemberkasan + Input Manual + chronological renumbering
// (ports of ReceiptFilingService.commitReceiptFiling_, ItemService.commitItem_,
// NumberingService.buildBatchNumberingPlan_ and ItemService.buildNumberingOperations_).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  configureSecret, newPool, rpc, expectCode, owner, createS2Fixture, receiptItem, makeReceipt, newBerkasTarget
} from './s2_fixture.mjs';

let pool;
let fx;

before(async () => {
  await configureSecret();
  pool = newPool();
  fx = await createS2Fixture(pool);
});
after(async () => { await pool.end(); });

const file = (user, ids, target, extra = {}) =>
  rpc(pool, user, 'filing_commit', { p_request_id: randomUUID(), p_receipt_item_ids: ids, p_target: target, ...extra });
const manual = (user, target, item, extra = {}) =>
  rpc(pool, user, 'item_create_manual', { p_request_id: randomUUID(), p_target: target, p_item: {
    description: 'Item manual', page_count: 2, development_level: 'ASLI', security_classification: 'BIASA/TERBUKA',
    document_date: '2024-06-01', ...item }, ...extra });
const berkasRow = async (id) => (await owner(pool, 'select * from public.berkas where id = $1', [id]))[0];
const itemsOf = async (berkasId) => owner(pool,
  'select * from public.item where berkas_id = $1 and not is_deleted order by no_item_definitif', [berkasId]);

// Units are separate per test file, so numbers start at 1 here.
test('filing into a NEW berkas: inherited metadata, item order, aggregates, retention, history, sources filed', async () => {
  const rc = await makeReceipt(pool, fx, fx.user.petugasB, 'B', [
    receiptItem({ description: 'Ketiga', document_date: '2025-01-31', page_count: 4, security_classification: 'RAHASIA', condition: 'RUSAK RINGAN', notes: 'catatan item' }),
    receiptItem({ description: 'Pertama', document_date: '2023-12-05', page_count: 1, primary_letter_number: 'B-10/UJI' }),
    receiptItem({ description: 'Kedua', document_date: '2023-12-05', page_count: 2, primary_letter_number: 'B-9/UJI' })]);
  const res = await file(fx.user.petugasB, rc.itemIds, newBerkasTarget({ active_retention_value: 1, active_retention_unit: 'BULAN',
    inactive_retention_value: 1, inactive_retention_unit: 'TAHUN', title: 'Anggaran 2023–2025 (fiktif)', classification_id: 'K-KU02' }));
  assert.equal(res.item_count, 3);
  assert.equal(res.total_pages, 7);
  assert.equal(res.berkas_number, 1);
  assert.match(res.berkas_id, /^BRK-/);
  const b = await berkasRow(res.berkas_id);
  assert.deepEqual({
    no: b.no_berkas_definitif, folder: b.no_folder, status: b.status_berkas, jml: b.jumlah_item, hal: b.total_halaman,
    kurun: b.kurun_waktu, sec: b.klasifikasi_keamanan_akses, kode: b.kode_klasifikasi_snapshot
  }, { no: 1, folder: '1', status: 'AKTIF', jml: 3, hal: 7, kurun: '2023–2025', sec: 'RAHASIA', kode: 'KU.02' });
  const [dates] = await owner(pool, `select tgl_item_awal::text a, tgl_item_akhir::text z, tgl_acuan_retensi::text acuan,
      batas_aktif::text ba, batas_inaktif::text bi, status_retensi from public.berkas where id = $1`, [res.berkas_id]);
  // JS setMonth semantics: 2025-01-31 + 1 month = 2025-03-03; + 1 year = 2026-03-03
  assert.deepEqual(dates, { a: '2023-12-05', z: '2025-01-31', acuan: '2025-01-31', ba: '2025-03-03', bi: '2026-03-03',
    status_retensi: 'HABIS AKTIF – PERLU PERSETUJUAN PEMINDAHAN' });
  const items = await itemsOf(res.berkas_id);
  // same date: natural order of the normalised letter number (B 9 before B 10)
  assert.deepEqual(items.map((i) => [i.no_item_definitif, i.uraian_lengkap]), [[1, 'Kedua'], [2, 'Pertama'], [3, 'Ketiga']]);
  const third = items[2];
  assert.deepEqual({
    sec: third.klasifikasi_keamanan_akses, kondisi: third.kondisi_fisik, catatan: third.catatan, sumber: third.sumber_registrasi,
    nama: third.nama_file, status: third.status_file, snap: third.no_berkas_snapshot, trm: third.nomor_tanda_terima_snapshot
  }, { sec: 'RAHASIA', kondisi: 'RUSAK RINGAN', catatan: 'catatan item', sumber: 'PENERIMAAN_ARSIP', nama: '1_3_Ketiga.pdf',
    status: 'BELUM DIUNGGAH', snap: 1, trm: rc.number });
  const src = await owner(pool, 'select * from public.penerimaan_item where penerimaan_id = $1 order by no_item', [rc.receipt_id]);
  for (const s of src) {
    const it = items.find((i) => i.penerimaan_item_id === s.id);
    assert.equal(s.status_pemberkasan, 'SUDAH DIBERKASKAN');
    assert.equal(s.item_id_definitif, it.id);
    assert.equal(s.berkas_id_tujuan, res.berkas_id);
    assert.equal(s.arsip_id, it.arsip_id, 'ARSIP_ID stays');
    assert.notEqual(it.id, s.id);
    assert.equal(s.no_item_definitif_snapshot, it.no_item_definitif);
  }
  const hist = await owner(pool, 'select jenis_objek, nomor_lama, nomor_baru from public.riwayat_nomor where berkas_id = $1 order by jenis_objek, nomor_baru', [res.berkas_id]);
  assert.deepEqual(hist.map((h) => [h.jenis_objek, h.nomor_lama, h.nomor_baru]), [['BERKAS', null, 1], ['ITEM', null, 1], ['ITEM', null, 2], ['ITEM', null, 3]]);
  const [aud] = await owner(pool, "select * from public.audit_log where action = 'FILE_BATCH' and object_id = $1", [res.request_id]);
  assert.equal(aud.actor_user_id, fx.user.petugasB);
  // queue view
  const q = await rpc(pool, fx.user.petugasB, 'filing_options', {});
  assert.ok(!q.items.some((x) => rc.itemIds.includes(x.id)));
});

test('chronological renumbering across berkas: numbers move, IDs stay, history and Drive renames recorded', async () => {
  const x = await manual(fx.user.petugasA, newBerkasTarget({ title: 'Berkas X' }), { description: 'x1', document_date: '2024-05-01' });
  assert.deepEqual([x.berkas_number, x.item_number], [1, 1]);
  // give X a Drive folder and file so renames get queued
  await owner(pool, `update public.berkas set drive_folder_id = 'fld-x-0000000001' where id = $1`, [x.berkas_id]);
  await owner(pool, `update public.item set drive_file_id = 'fil-x-0000000001' where id = $1`, [x.item_id]);
  const y = await manual(fx.user.petugasA2, newBerkasTarget({ title: 'Berkas Y' }), { description: 'y1', document_date: '2023-01-01' });
  assert.equal(y.berkas_number, 1);
  assert.equal(y.renumbered_berkas_count, 1);
  const bx = await berkasRow(x.berkas_id);
  assert.equal(bx.no_berkas_definitif, 2);
  assert.equal(bx.no_folder, '2');
  const [ix] = await itemsOf(x.berkas_id);
  assert.deepEqual([ix.id, ix.no_berkas_snapshot, ix.nama_file], [x.item_id, 2, '2_1_x1.pdf']);
  const hist = await owner(pool, `select jenis_objek, nomor_lama, nomor_baru, nama_lama, nama_baru from public.riwayat_nomor
                                  where objek_id = any($1) and nomor_lama is not null order by jenis_objek`, [[x.berkas_id, x.item_id]]);
  assert.deepEqual(hist.map((h) => [h.jenis_objek, h.nomor_lama, h.nomor_baru]), [['BERKAS', 1, 2]]);
  const tasks = y.drive_tasks.map((t) => [t.kind, t.drive_id, t.new_name]).sort();
  assert.deepEqual(tasks, [['RENAME_FILE', 'fil-x-0000000001', '2_1_x1.pdf'], ['RENAME_FOLDER', 'fld-x-0000000001', '2_Berkas X']]);
  // an older item into X moves item numbers inside X
  const x0 = await manual(fx.user.petugasA, { mode: 'EXISTING', berkas_id: x.berkas_id }, { description: 'x0', document_date: '2023-06-01' });
  assert.equal(x0.item_number, 1);
  const xs = await itemsOf(x.berkas_id);
  assert.deepEqual(xs.map((i) => [i.uraian_lengkap, i.no_item_definitif]), [['x0', 1], ['x1', 2]]);
  // X now starts 2023-06-01 (after Y 2023-01-01): X stays 2
  assert.equal((await berkasRow(x.berkas_id)).no_berkas_definitif, 2);
  const itemHist = await owner(pool, `select nomor_lama, nomor_baru from public.riwayat_nomor where objek_id = $1 order by created_at, nomor_baru`, [x.item_id]);
  assert.deepEqual(itemHist.map((h) => [h.nomor_lama, h.nomor_baru]), [[null, 1], [1, 2]]);
  // deferred uniqueness held throughout
  const dup = await owner(pool, `select no_berkas_definitif, count(*) from public.berkas where unit_id = $1 and not is_deleted
                                 and no_berkas_definitif is not null group by 1 having count(*) > 1`, [fx.unit.A]);
  assert.deepEqual(dup, []);
});

test('manual item: ARSIP_ID = ITEM_ID, INPUT_MANUAL, no PDF, validation and classification rule', async () => {
  const m = await manual(fx.user.petugasA, newBerkasTarget({ classification_id: 'K-KU02', title: 'Sekunder tanpa tersier' }),
    { description: 'Manual satu', primary_letter_number: 'A/1', alternate_letter_number: 'V-9', notes: 'catatan' });
  const [i] = await owner(pool, 'select * from public.item where id = $1', [m.item_id]);
  assert.deepEqual({ arsip: i.arsip_id, sumber: i.sumber_registrasi, media: i.media_sumber, bentuk: i.status_bentuk_digital,
    file: i.status_file, display: i.no_surat_display, kondisi: i.kondisi_fisik },
  { arsip: m.item_id, sumber: 'INPUT_MANUAL', media: 'TEKSTUAL', bentuk: 'TIDAK ADA', file: 'BELUM DIUNGGAH',
    display: 'A/1 atau V-9', kondisi: null });
  assert.equal(m.file_status, 'BELUM DIUNGGAH');
  // classification rule (validateClassification_ + legacy test secondary-classification.test.cjs)
  await expectCode(manual(fx.user.petugasA, newBerkasTarget({ classification_id: 'K-PR' }), {}), 'CLASSIFICATION_INVALID');
  await expectCode(manual(fx.user.petugasA, newBerkasTarget({ classification_id: 'K-OLD' }), {}), 'CLASSIFICATION_INVALID');
  await expectCode(manual(fx.user.petugasA, newBerkasTarget({ classification_id: 'K-NONE' }), {}), 'CLASSIFICATION_INVALID');
  await expectCode(manual(fx.user.petugasA, newBerkasTarget({ classification_id: '' }), {}), 'INVALID_INPUT');
  const leaf = await manual(fx.user.petugasA, newBerkasTarget({ classification_id: 'K-LEAF' }), {});
  assert.ok(leaf.ok);
  const opts = await rpc(pool, fx.user.pimpinanA, 'registration_options', {});
  const sel = Object.fromEntries(opts.classifications.map((k) => [k.id, k.selectable]));
  assert.deepEqual(sel, { 'K-PR': false, 'K-PR01': true, 'K-PR0101': true, 'K-KU': false, 'K-KU02': true, 'K-LEAF': true });
  assert.equal(opts.jenis_naskah.length, 1);
  // item validation (normalizeItemPayload_) and new-berkas validation (normalizeNewBerkasPayload_)
  for (const bad of [{ page_count: 0 }, { development_level: 'X' }, { security_classification: 'PUBLIK' }, { document_date: '2024-13-01' }, { description: '' }]) {
    await expectCode(manual(fx.user.petugasA, newBerkasTarget(), bad), 'INVALID_INPUT');
  }
  for (const bad of [{ title: '' }, { active_retention_value: -1 }, { active_retention_unit: 'HARI' }, { final_disposition: 'HILANG' },
    { kategori_naskah_id: 'JN-TIDAK-ADA' }, { mode: 'LAIN' }]) {
    await expectCode(manual(fx.user.petugasA, newBerkasTarget(bad), {}), 'INVALID_INPUT');
  }
  const withJenis = await manual(fx.user.petugasA, newBerkasTarget({ kategori_naskah_id: 'JN-1', pola_pemberkasan: 'SERI' }), {});
  const bj = await berkasRow(withJenis.berkas_id);
  assert.deepEqual([bj.kategori_naskah_id, bj.pola_pemberkasan], ['JN-1', 'SERI']);
  await expectCode(manual(fx.user.petugasA, { mode: 'EXISTING', berkas_id: 'BRK-TIDAK-ADA' }, {}), 'NOT_FOUND');
});

test('filing guards: limits, duplicates, already filed, incomplete, cancelled, transferred, active duplicate source', async () => {
  const rc = await makeReceipt(pool, fx, fx.user.petugasA, 'A', [receiptItem({ description: 'G1' }), receiptItem({ description: 'G2' }), receiptItem({ description: 'G3' })]);
  const [g1, g2, g3] = rc.itemIds;
  await expectCode(file(fx.user.petugasA, [], newBerkasTarget()), 'INVALID_INPUT');
  await expectCode(file(fx.user.petugasA, Array.from({ length: 101 }, (_, i) => `RCVI-${i}`), newBerkasTarget()), 'BATCH_LIMIT');
  await expectCode(file(fx.user.petugasA, [g1, g1], newBerkasTarget()), 'INVALID_INPUT');
  await expectCode(file(fx.user.petugasA, [g1, 'RCVI-tidak-ada'], newBerkasTarget()), 'NOT_FOUND');
  const f1 = await file(fx.user.petugasA, [g1], newBerkasTarget());
  await expectCode(file(fx.user.petugasA, [g1], { mode: 'EXISTING', berkas_id: f1.berkas_id }), 'ITEM_ALREADY_FILED');
  // nothing written by a failed attempt
  assert.equal((await owner(pool, 'select count(*)::int n from public.item where penerimaan_item_id = $1', [g1]))[0].n, 1);
  await owner(pool, `update public.penerimaan_item set status_pemberkasan = 'PERLU DILENGKAPI', tanggal_naskah = null where id = $1`, [g2]);
  await expectCode(file(fx.user.petugasA, [g2], newBerkasTarget()), 'ITEM_NOT_READY');
  // an active definitive item already carries this ARSIP_ID (e.g. imported)
  const [src3] = await owner(pool, 'select arsip_id from public.penerimaan_item where id = $1', [g3]);
  await owner(pool, `update public.item set arsip_id = $1 where id = (select id from public.item where penerimaan_item_id = $2)`, [src3.arsip_id, g1]);
  await expectCode(file(fx.user.petugasA, [g3], newBerkasTarget()), 'SOURCE_ALREADY_ACTIVE');
  // transferred target
  const t = await manual(fx.user.petugasA, newBerkasTarget(), {});
  await owner(pool, `update public.berkas set status_pemindahan = 'SUDAH DIPINDAHKAN' where id = $1`, [t.berkas_id]);
  const rc2 = await makeReceipt(pool, fx, fx.user.petugasA, 'A', [receiptItem()]);
  await expectCode(file(fx.user.petugasA, rc2.itemIds, { mode: 'EXISTING', berkas_id: t.berkas_id }), 'BERKAS_TRANSFERRED');
  // cancelled receipt
  await rpc(pool, fx.user.petugasA, 'receipt_cancel', { p_request_id: randomUUID(), p_receipt_id: rc2.receipt_id, p_reason: 'dibatalkan untuk uji', p_confirmation: 'BATALKAN' });
  await expectCode(file(fx.user.petugasA, rc2.itemIds, newBerkasTarget()), 'RECEIPT_CANCELLED');
  // other unit's sources / berkas are invisible
  const rb = await makeReceipt(pool, fx, fx.user.petugasB, 'B', [receiptItem()]);
  await expectCode(file(fx.user.petugasA, rb.itemIds, newBerkasTarget()), 'NOT_FOUND');
  const rc3 = await makeReceipt(pool, fx, fx.user.petugasA, 'A', [receiptItem()]);
  const bB = (await owner(pool, 'select id from public.berkas where unit_id = $1 and not is_deleted limit 1', [fx.unit.B]))[0].id;
  await expectCode(file(fx.user.petugasA, rc3.itemIds, { mode: 'EXISTING', berkas_id: bB }), 'NOT_FOUND');
});

test('idempotent filing: replay returns the stored result, filing_recover finds it, no second effect', async () => {
  const rc = await makeReceipt(pool, fx, fx.user.petugasA, 'A', [receiptItem({ description: 'I1' }), receiptItem({ description: 'I2' })]);
  const req = randomUUID();
  const args = { p_request_id: req, p_receipt_item_ids: rc.itemIds, p_target: newBerkasTarget({ title: 'Idempoten' }) };
  const first = await rpc(pool, fx.user.petugasA, 'filing_commit', args);
  const second = await rpc(pool, fx.user.petugasA, 'filing_commit', args);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.items, first.items);
  assert.equal((await owner(pool, 'select count(*)::int n from public.item where penerimaan_item_id = any($1)', [rc.itemIds]))[0].n, 2);
  assert.equal((await owner(pool, "select count(*)::int n from public.berkas where judul_berkas = 'Idempoten' and unit_id = $1", [fx.unit.A]))[0].n, 1);
  const rec = await rpc(pool, fx.user.petugasA, 'filing_recover', { p_request_id: req });
  assert.deepEqual([rec.found, rec.berkas_id], [true, first.berkas_id]);
  assert.equal((await rpc(pool, fx.user.petugasA, 'filing_recover', { p_request_id: randomUUID() })).found, false);
  await expectCode(rpc(pool, fx.user.petugasA, 'filing_commit', { ...args, p_target: newBerkasTarget({ title: 'Lain' }) }), 'IDEMPOTENCY_CONFLICT');
});

test('concurrency: the same source filed in parallel — exactly one wins', async () => {
  const rc = await makeReceipt(pool, fx, fx.user.petugasA, 'A', [receiptItem({ description: 'Rebutan' })]);
  const results = await Promise.allSettled([fx.user.petugasA, fx.user.petugasA2, fx.user.adminA, fx.user.petugasA2]
    .map((u, i) => file(u, rc.itemIds, newBerkasTarget({ title: `Rebutan ${i}` }))));
  const ok = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1);
  assert.ok(failed.every((r) => r.reason.hint === 'ITEM_ALREADY_FILED'), failed.map((r) => r.reason.message).join('; '));
  assert.equal((await owner(pool, 'select count(*)::int n from public.item where penerimaan_item_id = $1 and not is_deleted', [rc.itemIds[0]]))[0].n, 1);
  assert.equal((await owner(pool, "select count(*)::int n from public.berkas where judul_berkas like 'Rebutan %' and unit_id = $1", [fx.unit.A]))[0].n, 1);
});

test('concurrency: parallel filings and manual inputs never produce duplicate numbers', async () => {
  const receipts = await Promise.all(Array.from({ length: 6 }, (_, i) =>
    makeReceipt(pool, fx, fx.user.petugasA, 'A', [receiptItem({ description: `Par ${i}`, document_date: `2022-0${(i % 9) + 1}-15` })])));
  const users = [fx.user.petugasA, fx.user.petugasA2, fx.user.adminA];
  await Promise.all([
    ...receipts.map((rc, i) => file(users[i % 3], rc.itemIds, newBerkasTarget({ title: `Paralel ${i}` }))),
    ...Array.from({ length: 4 }, (_, i) => manual(users[i % 3], newBerkasTarget({ title: `Manual paralel ${i}` }), { document_date: `2021-0${i + 1}-01` }))
  ]);
  const nums = await owner(pool, `select no_berkas_definitif n from public.berkas where unit_id = $1 and not is_deleted
                                  and no_berkas_definitif is not null order by 1`, [fx.unit.A]);
  assert.deepEqual(nums.map((r) => r.n), Array.from({ length: nums.length }, (_, i) => i + 1), 'berkas numbers are 1..n without gaps');
  const itemDup = await owner(pool, `select berkas_id, no_item_definitif, count(*) from public.item where unit_id = $1 and not is_deleted
                                     group by 1, 2 having count(*) > 1`, [fx.unit.A]);
  assert.deepEqual(itemDup, []);
  // chronological: berkas numbers follow the earliest item date
  const order = await owner(pool, `select no_berkas_definitif, tgl_item_awal from public.berkas where unit_id = $1 and not is_deleted
                                   and no_berkas_definitif is not null order by no_berkas_definitif`, [fx.unit.A]);
  for (let i = 1; i < order.length; i++) assert.ok(order[i].tgl_item_awal >= order[i - 1].tgl_item_awal);
});
