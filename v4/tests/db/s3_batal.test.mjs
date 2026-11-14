// Sprint 3 — Koreksi & Pembatalan (ports of DeletionService.deleteArchive_ / resolveDeletionContext_,
// ReceiptFilingService.releaseReceiptItemsAfterDeletion_, UploadService deletion evidence upload).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  configureSecret, newPool, rpc, expectCode, owner, createS2Fixture, newBerkasTarget, gatewayCommit, driveId,
  receiptItem, makeReceipt
} from './s2_fixture.mjs';

let pool;
let fx;

before(async () => {
  await configureSecret();
  pool = newPool();
  fx = await createS2Fixture(pool);
});
after(async () => { await pool.end(); });

const manual = (user, target, item = {}) => rpc(pool, user, 'item_create_manual', {
  p_request_id: randomUUID(), p_target: target, p_item: {
    description: 'Item batal', page_count: 2, development_level: 'ASLI', security_classification: 'BIASA/TERBUKA',
    document_date: '2024-06-01', ...item } });
const existing = (berkasId) => ({ mode: 'EXISTING', berkas_id: berkasId });
const itemRow = async (id) => (await owner(pool, 'select * from public.item where id = $1', [id]))[0];
const berkasRow = async (id) => (await owner(pool, 'select * from public.berkas where id = $1', [id]))[0];
const cancel = (user, scope, berkasId, itemId, extra = {}) => rpc(pool, user, 'archive_cancel', {
  p_request_id: extra.request_id || randomUUID(), p_scope: scope, p_berkas_id: berkasId, p_item_id: itemId ?? null,
  p_reason: extra.reason ?? 'Salah input, arsip ganda', p_confirmation: extra.confirmation ?? 'HAPUS',
  ...(extra.session ? { p_evidence_session_id: extra.session } : {}), ...(extra.validate ? { p_validate_only: true } : {}) });
const begin = (user, purpose, objectId, over = {}) => rpc(pool, user, 'upload_begin', {
  p_request_id: over.request_id || randomUUID(), p_purpose: purpose, p_object_id: objectId,
  p_file_name: over.name || 'disposisi.pdf', p_mime: over.mime ?? 'application/pdf', p_size: over.size ?? 4096 });
const withPdf = async (user, target, item) => {
  const m = await manual(user, target, item);
  const s = await begin(user, 'ITEM_PDF', m.item_id, { name: 'asli.pdf' });
  const fileId = driveId();
  await gatewayCommit(pool, user, s, { fileId, size: 4096 });
  return { ...m, fileId };
};
/** 3 items in one berkas, dates d1 < d2 < d3 */
const threeItems = async (title, user = fx.user.petugasA) => {
  const a = await manual(user, newBerkasTarget({ title }), { description: `${title} satu`, document_date: '2024-01-01' });
  const b = await manual(user, existing(a.berkas_id), { description: `${title} dua`, document_date: '2024-02-01', security_classification: 'RAHASIA' });
  const c = await manual(user, existing(a.berkas_id), { description: `${title} tiga`, document_date: '2024-03-01' });
  return { berkasId: a.berkas_id, ids: [a.item_id, b.item_id, c.item_id] };
};
/** numbering invariant of a unit: active berkas with items are 1..n, items 1..m per berkas, no duplicates */
const assertContiguous = async (unitId) => {
  const b = await owner(pool, `select b.id, b.no_berkas_definitif n from public.berkas b where b.unit_id = $1 and not b.is_deleted
      and exists (select 1 from public.item i where i.berkas_id = b.id and not i.is_deleted) order by 2`, [unitId]);
  assert.deepEqual(b.map((x) => x.n), b.map((_, k) => k + 1), 'berkas numbers contiguous');
  for (const x of b) {
    const it = await owner(pool, 'select no_item_definitif n, no_berkas_snapshot s from public.item where berkas_id = $1 and not is_deleted order by 1', [x.id]);
    assert.deepEqual(it.map((y) => y.n), it.map((_, k) => k + 1), `items of ${x.id} contiguous`);
    assert.ok(it.every((y) => y.s === x.n), 'berkas snapshot follows the berkas number');
  }
};

test('cancel_options: berkas with items, last-item and loan flags, evidence rules', async () => {
  const t = await threeItems('Opsi batal');
  const single = await manual(fx.user.petugasA, newBerkasTarget({ title: 'Satu item' }));
  await owner(pool, `update public.item set status_peminjaman = 'DIPINJAM' where id = $1`, [t.ids[1]]);
  const o = await rpc(pool, fx.user.pimpinanA, 'cancel_options', {});
  const b = o.berkas.find((x) => x.id === t.berkasId);
  assert.deepEqual([b.item_count, b.page_count, b.can_cancel], [3, 6, false]);
  assert.deepEqual(b.items.map((x) => [x.number, x.can_cancel, x.is_last_item]), [[1, true, false], [2, false, false], [3, true, false]]);
  const s = o.berkas.find((x) => x.id === single.berkas_id);
  assert.deepEqual([s.can_cancel, s.items[0].can_cancel, s.items[0].is_last_item], [true, false, true]);
  assert.deepEqual([o.confirmation_word, o.evidence.max_bytes, o.min_reason_length], ['HAPUS', 26214400, 10]);
  await owner(pool, `update public.item set status_peminjaman = 'TERSEDIA' where id = $1`, [t.ids[1]]);
  assert.ok(!(await rpc(pool, fx.user.petugasB, 'cancel_options', {})).berkas.some((x) => x.id === t.berkasId));
});

test('cancel ITEM: soft delete, quarantine binding, renumbering with history, strictest-active security, audit, record', async () => {
  const a = await withPdf(fx.user.petugasA, newBerkasTarget({ title: 'Batal item' }), { description: 'Pertama', document_date: '2024-01-01' });
  const b = await manual(fx.user.petugasA, existing(a.berkas_id), { description: 'Kedua', document_date: '2024-02-01', security_classification: 'SANGAT RAHASIA' });
  const c = await manual(fx.user.petugasA, existing(a.berkas_id), { description: 'Ketiga', document_date: '2024-03-01' });
  assert.equal((await berkasRow(a.berkas_id)).klasifikasi_keamanan_akses, 'SANGAT RAHASIA');
  // cancel the first item (with a PDF): 2 -> 1, 3 -> 2
  const res = await cancel(fx.user.petugasA2, 'ITEM', a.berkas_id, a.item_id, { reason: 'Item salah berkas, dibatalkan' });
  assert.deepEqual([res.scope, res.cancelled_item_count, res.renumbered_item_count], ['ITEM', 1, 2]);
  assert.match(res.cancellation_id, /^BTL-/);
  const ia = await itemRow(a.item_id);
  assert.deepEqual([ia.is_deleted, ia.status_file, ia.drive_file_id, ia.no_item_definitif], [true, 'DIHAPUS', a.fileId, 1]);
  assert.ok(ia.deleted_at);
  assert.match(ia.catatan, /^\[DIHAPUS \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+07:00\] Item salah berkas, dibatalkan$/);
  assert.deepEqual([(await itemRow(b.item_id)).no_item_definitif, (await itemRow(c.item_id)).no_item_definitif], [1, 2]);
  const hist = await owner(pool, `select objek_id, nomor_lama, nomor_baru, alasan, batch_renumber_id from public.riwayat_nomor
                                  where objek_id = any($1) and nomor_lama is not null order by nomor_baru`, [[a.item_id, b.item_id, c.item_id]]);
  assert.deepEqual(hist.map((h) => [h.objek_id, h.nomor_lama, h.nomor_baru]), [[b.item_id, 2, 1], [c.item_id, 3, 2]]);
  assert.ok(hist.every((h) => h.alasan === 'Penomoran ulang kronologis setelah penghapusan item'));
  assert.equal(new Set(hist.map((h) => h.batch_renumber_id)).size, 1);
  const bk = await berkasRow(a.berkas_id);
  assert.deepEqual([bk.jumlah_item, bk.total_halaman, bk.is_deleted], [2, 4, false]);
  // cancel the SANGAT RAHASIA item: the berkas follows the strictest ACTIVE item again
  await cancel(fx.user.petugasA, 'ITEM', a.berkas_id, b.item_id);
  assert.equal((await berkasRow(a.berkas_id)).klasifikasi_keamanan_akses, 'BIASA/TERBUKA');
  // last item: refused, use scope BERKAS
  await expectCode(cancel(fx.user.petugasA, 'ITEM', a.berkas_id, c.item_id), 'LAST_ITEM_IN_BERKAS');
  // quarantine row for the file, pembatalan record, audit
  const [q] = await owner(pool, 'select * from public.karantina where id = any($1)', [res.quarantine_ids]);
  assert.deepEqual([q.object_id, q.module, q.reason, q.related_object_id, q.pembatalan_id], [a.fileId, 'PENGHAPUSAN_ITEM', 'Item salah berkas, dibatalkan', a.item_id, res.cancellation_id]);
  const [p] = await owner(pool, 'select * from public.pembatalan_arsip where id = $1', [res.cancellation_id]);
  assert.deepEqual([p.scope, p.item_id, p.item_ids, p.no_item_snapshot, p.alasan, p.actor_user_id],
    ['ITEM', a.item_id, [a.item_id], 1, 'Item salah berkas, dibatalkan', fx.user.petugasA2]);
  const [aud] = await owner(pool, "select * from public.audit_log where action = 'DELETE' and request_id = $1", [res.request_id]);
  assert.deepEqual([aud.module, aud.object_id, aud.reason], ['PENGHAPUSAN', a.item_id, 'Item salah berkas, dibatalkan']);
  // file of the cancelled item: admins only (3.x quarantine)
  assert.equal(await rpc(pool, fx.user.petugasA, 'get_file_access', { p_drive_file_id: a.fileId }), null);
  assert.equal(await rpc(pool, fx.user.pimpinanA, 'get_file_access', { p_drive_file_id: a.fileId }), null);
  assert.equal((await rpc(pool, fx.user.adminA, 'get_file_access', { p_drive_file_id: a.fileId })).object_id, a.item_id);
  // nothing is hard-deleted, and the rows cannot be deleted
  await expectCode(owner(pool, 'delete from public.item where id = $1', [a.item_id]), '42501');
  await expectCode(owner(pool, 'delete from public.pembatalan_arsip where id = $1', [res.cancellation_id]), '42501');
  await expectCode(owner(pool, 'update public.pembatalan_arsip set alasan = alasan where id = $1', [res.cancellation_id]), '42501');
  await assertContiguous(fx.unit.A);
});

test('cancel BERKAS: all items, folders quarantined, remaining berkas renumbered with history, never hard-deleted', async () => {
  const first = await manual(fx.user.petugasA, newBerkasTarget({ title: 'Awal unit' }), { document_date: '2000-01-01' });
  const t = await threeItems('Batal berkas');
  const later = await manual(fx.user.petugasA, newBerkasTarget({ title: 'Sesudahnya' }), { document_date: '2030-01-01' });
  await owner(pool, `update public.berkas set drive_folder_id = 'fld-legacy-batal-01', v4_drive_folder_id = 'fld-v4-batal-00001' where id = $1`, [t.berkasId]);
  await owner(pool, `update public.item set drive_file_id = 'fil-legacy-batal-1' where id = $1`, [t.ids[0]]);
  const nT = (await berkasRow(t.berkasId)).no_berkas_definitif;
  const nLater = (await berkasRow(later.berkas_id)).no_berkas_definitif;
  assert.ok(nLater > nT && (await berkasRow(first.berkas_id)).no_berkas_definitif < nT);
  const res = await cancel(fx.user.petugasA, 'BERKAS', t.berkasId, null, { reason: 'Berkas ganda dari impor lama' });
  assert.deepEqual([res.cancelled_item_count, res.cancelled_item_ids.sort()], [3, [...t.ids].sort()]);
  const b = await berkasRow(t.berkasId);
  assert.deepEqual([b.is_deleted, b.status_berkas, b.no_berkas_definitif], [true, 'DIHAPUS', nT]);
  assert.match(b.catatan, /\[DIHAPUS .*\] Berkas ganda dari impor lama$/);
  for (const id of t.ids) {
    const i = await itemRow(id);
    assert.deepEqual([i.is_deleted, i.status_file], [true, 'DIHAPUS']);
  }
  const q = await owner(pool, 'select object_type, object_id, module from public.karantina where id = any($1) order by object_type, object_id', [res.quarantine_ids]);
  assert.deepEqual(q.map((x) => [x.object_type, x.object_id]),
    [['FILE', 'fil-legacy-batal-1'], ['FOLDER', 'fld-legacy-batal-01'], ['FOLDER', 'fld-v4-batal-00001']]);
  assert.ok(q.every((x) => x.module === 'PENGHAPUSAN_BERKAS'));
  // the later berkas moved up; history with the berkas reason
  assert.equal((await berkasRow(later.berkas_id)).no_berkas_definitif, nLater - 1);
  const [h] = await owner(pool, `select nomor_lama, nomor_baru, alasan from public.riwayat_nomor where objek_id = $1 and jenis_objek = 'BERKAS'
                                 order by created_at desc limit 1`, [later.berkas_id]);
  assert.deepEqual([h.nomor_lama, h.nomor_baru, h.alasan], [nLater, nLater - 1, 'Penomoran ulang kronologis setelah penghapusan berkas']);
  const audits = await owner(pool, "select object_type, count(*)::int n from public.audit_log where action = 'DELETE' and request_id = $1 group by 1 order by 1", [res.request_id]);
  assert.deepEqual(audits.map((x) => [x.object_type, x.n]), [['BERKAS', 1], ['ITEM', 3]]);
  await expectCode(cancel(fx.user.petugasA, 'BERKAS', t.berkasId, null), 'ALREADY_CANCELLED');
  await expectCode(cancel(fx.user.petugasA, 'ITEM', t.berkasId, t.ids[1]), 'ALREADY_CANCELLED');
  // a cancelled berkas is no longer an edit or filing target
  await expectCode(rpc(pool, fx.user.petugasA, 'item_create_manual', { p_request_id: randomUUID(), p_target: existing(t.berkasId),
    p_item: { description: 'x', page_count: 1, development_level: 'ASLI', security_classification: 'BIASA/TERBUKA', document_date: '2024-01-01' } }), 'NOT_FOUND');
  await expectCode(owner(pool, 'delete from public.berkas where id = $1', [t.berkasId]), '42501');
  await assertContiguous(fx.unit.A);
});

test('cancel guards: scope, reason, confirmation, loans (berkas/item), item of another berkas, roles, units', async () => {
  const t = await threeItems('Guard batal');
  const other = await manual(fx.user.petugasA, newBerkasTarget({ title: 'Berkas lain' }));
  await expectCode(cancel(fx.user.petugasA, 'SEMUA', t.berkasId, null), 'INVALID_INPUT');
  await expectCode(cancel(fx.user.petugasA, 'ITEM', t.berkasId, t.ids[0], { reason: 'pendek' }), 'INVALID_INPUT');
  await expectCode(cancel(fx.user.petugasA, 'ITEM', t.berkasId, t.ids[0], { confirmation: 'BATALKAN' }), 'INVALID_INPUT');
  await expectCode(cancel(fx.user.petugasA, 'ITEM', t.berkasId, ''), 'INVALID_INPUT');
  assert.equal((await cancel(fx.user.petugasA, 'ITEM', t.berkasId, t.ids[0], { confirmation: ' hapus ', validate: true })).valid, true);
  await expectCode(cancel(fx.user.petugasA, 'ITEM', t.berkasId, other.item_id), 'NOT_FOUND');
  await expectCode(cancel(fx.user.petugasA, 'ITEM', 'BRK-tidak-ada', t.ids[0]), 'NOT_FOUND');
  // loans: berkas borrowed blocks both scopes; a borrowed item blocks itself and its berkas, not its siblings
  await owner(pool, `update public.berkas set status_peminjaman = 'DIPINJAM' where id = $1`, [t.berkasId]);
  await expectCode(cancel(fx.user.petugasA, 'ITEM', t.berkasId, t.ids[0]), 'OBJECT_BORROWED');
  await expectCode(cancel(fx.user.petugasA, 'BERKAS', t.berkasId, null), 'OBJECT_BORROWED');
  await expectCode(begin(fx.user.petugasA, 'DELETION_EVIDENCE', t.berkasId), 'OBJECT_BORROWED');
  await owner(pool, `update public.berkas set status_peminjaman = 'TERSEDIA' where id = $1`, [t.berkasId]);
  await owner(pool, `update public.item set status_peminjaman = 'DIPINJAM' where id = $1`, [t.ids[2]]);
  const e = await expectCode(cancel(fx.user.petugasA, 'ITEM', t.berkasId, t.ids[2]), 'OBJECT_BORROWED');
  assert.match(e.message, /^OBJECT_BORROWED: Item 3 sedang dipinjam/);
  await expectCode(cancel(fx.user.petugasA, 'BERKAS', t.berkasId, null), 'OBJECT_BORROWED');
  assert.equal((await cancel(fx.user.petugasA, 'ITEM', t.berkasId, t.ids[0], { validate: true })).valid, true);
  await owner(pool, `update public.item set status_peminjaman = 'TERSEDIA' where id = $1`, [t.ids[2]]);
  // roles and units
  await expectCode(cancel(fx.user.pimpinanA, 'ITEM', t.berkasId, t.ids[0]), 'FORBIDDEN_ROLE');
  await expectCode(cancel(fx.user.inactiveA, 'ITEM', t.berkasId, t.ids[0]), 'ACCOUNT_INACTIVE');
  await expectCode(cancel(fx.user.petugasB, 'ITEM', t.berkasId, t.ids[0]), 'NOT_FOUND');
  await expectCode(cancel(fx.user.petugasB, 'ITEM', t.berkasId, t.ids[0], { validate: true }), 'NOT_FOUND');
  await expectCode(cancel(null, 'ITEM', t.berkasId, t.ids[0]), '42501');
  // nothing changed by the refused calls
  assert.equal((await owner(pool, 'select count(*)::int n from public.item where berkas_id = $1 and not is_deleted', [t.berkasId]))[0].n, 3);
  // ADMIN_PUSAT acts in the object's unit
  const res = await cancel(fx.user.pusat, 'ITEM', t.berkasId, t.ids[0]);
  const [p] = await owner(pool, 'select unit_id from public.pembatalan_arsip where id = $1', [res.cancellation_id]);
  assert.equal(p.unit_id, fx.unit.A);
});

test('idempotency: replay returns the stored result, conflicting replay refused, concurrent identical requests one effect', async () => {
  const t = await threeItems('Idem batal');
  const req = randomUUID();
  const r1 = await cancel(fx.user.petugasA, 'ITEM', t.berkasId, t.ids[0], { request_id: req });
  const r2 = await cancel(fx.user.petugasA, 'ITEM', t.berkasId, t.ids[0], { request_id: req });
  assert.deepEqual([r2.replayed, r2.cancellation_id], [true, r1.cancellation_id]);
  await expectCode(cancel(fx.user.petugasA, 'ITEM', t.berkasId, t.ids[1], { request_id: req }), 'IDEMPOTENCY_CONFLICT');
  await expectCode(cancel(fx.user.petugasA, 'ITEM', t.berkasId, t.ids[0], { request_id: req, reason: 'Alasan lain yang panjang' }), 'IDEMPOTENCY_CONFLICT');
  const req2 = randomUUID();
  const both = await Promise.all([cancel(fx.user.petugasA, 'ITEM', t.berkasId, t.ids[1], { request_id: req2 }),
    cancel(fx.user.petugasA, 'ITEM', t.berkasId, t.ids[1], { request_id: req2 })]);
  assert.deepEqual(both.map((x) => x.replayed).sort(), [false, true]);
  assert.equal(both[0].cancellation_id, both[1].cancellation_id);
  assert.equal((await owner(pool, 'select count(*)::int n from public.pembatalan_arsip where request_id = $1', [req2]))[0].n, 1);
});

test('concurrency: two cancels of the same item (different requests) have one effect', async () => {
  for (let round = 0; round < 5; round++) {
    const t = await threeItems(`Ganda ${round}`);
    const results = await Promise.allSettled([cancel(fx.user.petugasA, 'ITEM', t.berkasId, t.ids[1]), cancel(fx.user.petugasA2, 'ITEM', t.berkasId, t.ids[1])]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    assert.equal(ok.length, 1);
    assert.equal(failed[0].reason.hint, 'ALREADY_CANCELLED');
    assert.equal((await owner(pool, 'select count(*)::int n from public.pembatalan_arsip where item_id = $1', [t.ids[1]]))[0].n, 1);
    assert.equal((await owner(pool, "select count(*)::int n from public.audit_log where action = 'DELETE' and object_id = $1", [t.ids[1]]))[0].n, 1);
  }
  await assertContiguous(fx.unit.A);
});

test('concurrency: parallel edits and cancels on the same berkas never leave gaps or duplicate numbers; history is consistent', async () => {
  const dates = ['2022-01-05', '2022-02-05', '2022-03-05', '2022-04-05', '2022-05-05', '2022-06-05'];
  const first = await manual(fx.user.petugasA, newBerkasTarget({ title: 'Balapan' }), { description: 'r0', document_date: dates[0] });
  const ids = [first.item_id];
  for (let k = 1; k < dates.length; k++) {
    ids.push((await manual(fx.user.petugasA, existing(first.berkas_id), { description: `r${k}`, document_date: dates[k] })).item_id);
  }
  const neighbour = await manual(fx.user.petugasA, newBerkasTarget({ title: 'Tetangga' }), { document_date: '2022-03-01' });
  const payload = async (id, date) => {
    const i = await itemRow(id);
    return { berkas_id: i.berkas_id, description: i.uraian_lengkap, page_count: i.jumlah_halaman, document_date: date,
      development_level: i.tingkat_perkembangan, condition: '', security_classification: i.klasifikasi_keamanan_akses };
  };
  const ops = [
    async () => rpc(pool, fx.user.petugasA, 'item_update', { p_request_id: randomUUID(), p_item_id: ids[5],
      p_payload: await payload(ids[5], '2021-12-01'), p_reason: 'Tanggal naskah salah ketik' }),
    async () => cancel(fx.user.petugasA2, 'ITEM', first.berkas_id, ids[2]),
    async () => rpc(pool, fx.user.adminA, 'item_update', { p_request_id: randomUUID(), p_item_id: ids[0],
      p_payload: await payload(ids[0], '2023-01-01'), p_reason: 'Tanggal naskah salah ketik' }),
    async () => cancel(fx.user.petugasA, 'ITEM', first.berkas_id, ids[4]),
    async () => rpc(pool, fx.user.petugasA2, 'item_update', { p_request_id: randomUUID(), p_item_id: ids[1],
      p_payload: await payload(ids[1], '2022-02-06'), p_reason: 'Tanggal naskah salah ketik' })
  ];
  const results = await Promise.allSettled(ops.map((f) => f()));
  assert.deepEqual(results.filter((r) => r.status === 'rejected').map((r) => r.reason.message), []);
  await assertContiguous(fx.unit.A);
  // history: for every active item of the berkas the latest riwayat row ends at its current number
  const active = await owner(pool, 'select id, no_item_definitif from public.item where berkas_id = $1 and not is_deleted', [first.berkas_id]);
  assert.equal(active.length, 4);
  for (const it of active) {
    const [h] = await owner(pool, `select nomor_baru from public.riwayat_nomor where objek_id = $1 order by created_at desc, nomor_baru limit 1`, [it.id]);
    assert.equal(h.nomor_baru, it.no_item_definitif);
  }
  // the earliest item moved to 2021-12-01 makes Balapan start before Tetangga
  assert.ok((await berkasRow(first.berkas_id)).no_berkas_definitif < (await berkasRow(neighbour.berkas_id)).no_berkas_definitif);
});

test('receipt e2e: cancelling filed items returns receipt lines to the queue; then receipt_cancel succeeds', async () => {
  const rc = await makeReceipt(pool, fx, fx.user.petugasA, 'A', [
    receiptItem({ description: 'Baris satu', document_date: '2025-01-10' }),
    receiptItem({ description: 'Baris dua', document_date: '2025-01-11' })]);
  const filed = await rpc(pool, fx.user.petugasA, 'filing_commit', { p_request_id: randomUUID(), p_receipt_item_ids: rc.itemIds,
    p_target: newBerkasTarget({ title: 'Dari penerimaan' }) });
  const cancelReceipt = (req = randomUUID()) => rpc(pool, fx.user.petugasA, 'receipt_cancel', { p_request_id: req, p_receipt_id: rc.receipt_id,
    p_reason: 'Tanda terima dibuat ganda', p_confirmation: 'BATALKAN' });
  const blocked = await expectCode(cancelReceipt(), 'RECEIPT_HAS_FILED_ITEMS');
  assert.match(blocked.message, /Koreksi & Pembatalan/);
  const queue = async () => (await rpc(pool, fx.user.petugasA, 'filing_options', {})).items.filter((x) => rc.itemIds.includes(x.id));
  assert.deepEqual(await queue(), []);
  // cancel one filed item -> its line is back in the queue, cleared; receipt still blocked by the other one
  const [it1] = filed.items.filter((x) => x.receipt_item_id === rc.itemIds[0]);
  const r1 = await cancel(fx.user.petugasA, 'ITEM', filed.berkas_id, it1.item_id);
  assert.deepEqual(r1.released_receipt_item_ids, [rc.itemIds[0]]);
  const [line] = await owner(pool, 'select * from public.penerimaan_item where id = $1', [rc.itemIds[0]]);
  assert.deepEqual([line.status_pemberkasan, line.berkas_id_tujuan, line.item_id_definitif, line.no_item_definitif_snapshot, line.diberkaskan_at,
    line.pemberkasan_request_id], ['BELUM DIBERKASKAN', null, null, null, null, null]);
  assert.deepEqual((await queue()).map((x) => [x.id, x.status, x.selectable]), [[rc.itemIds[0], 'BELUM DIBERKASKAN', true]]);
  const [rel] = await owner(pool, "select summary from public.audit_log where action = 'RELEASE_SOURCE' and request_id = $1", [r1.request_id]);
  assert.equal(rel.summary, 'Sumber penerimaan dikembalikan ke antrean pemberkasan');
  await expectCode(cancelReceipt(), 'RECEIPT_HAS_FILED_ITEMS');
  // an incomplete line goes back as PERLU DILENGKAPI (receiptItemMetadataComplete_)
  await owner(pool, 'update public.penerimaan_item set jumlah_halaman = 0 where id = $1', [rc.itemIds[1]]);
  const r2 = await cancel(fx.user.petugasA, 'BERKAS', filed.berkas_id, null);
  assert.deepEqual(r2.released_receipt_item_ids, [rc.itemIds[1]]);
  assert.deepEqual((await queue()).map((x) => [x.id, x.status]).sort(), [[rc.itemIds[0], 'BELUM DIBERKASKAN'], [rc.itemIds[1], 'PERLU DILENGKAPI']].sort());
  // the receipt can now be cancelled; its lines become DIBATALKAN and leave the queue
  const ok = await cancelReceipt();
  assert.equal(ok.already_cancelled, false);
  const lines = await owner(pool, 'select status_pemberkasan from public.penerimaan_item where penerimaan_id = $1', [rc.receipt_id]);
  assert.ok(lines.every((l) => l.status_pemberkasan === 'DIBATALKAN'));
  assert.deepEqual(await queue(), []);
});

test('a released receipt line can be filed again (new ITEM_ID, same ARSIP_ID)', async () => {
  const rc = await makeReceipt(pool, fx, fx.user.petugasA, 'A', [receiptItem({ description: 'Refile satu' }), receiptItem({ description: 'Refile dua' })]);
  const filed = await rpc(pool, fx.user.petugasA, 'filing_commit', { p_request_id: randomUUID(), p_receipt_item_ids: rc.itemIds,
    p_target: newBerkasTarget({ title: 'Refile' }) });
  const old = filed.items.find((x) => x.receipt_item_id === rc.itemIds[0]);
  await cancel(fx.user.petugasA, 'ITEM', filed.berkas_id, old.item_id);
  const again = await rpc(pool, fx.user.petugasA, 'filing_commit', { p_request_id: randomUUID(), p_receipt_item_ids: [rc.itemIds[0]],
    p_target: existing(filed.berkas_id) });
  assert.notEqual(again.items[0].item_id, old.item_id);
  const [n, o] = [await itemRow(again.items[0].item_id), await itemRow(old.item_id)];
  assert.equal(n.arsip_id, o.arsip_id);
  assert.deepEqual([o.is_deleted, n.is_deleted], [true, false]);
  await assertContiguous(fx.unit.A);
});

test('deletion evidence: upload rules, attested commit, consumed once, bound to the cancellation, admin-only access', async () => {
  const t = await threeItems('Bukti');
  await expectCode(begin(fx.user.petugasA, 'DELETION_EVIDENCE', t.ids[0], { name: 'bukti.docx' }), 'FILE_TYPE');
  await expectCode(begin(fx.user.petugasA, 'DELETION_EVIDENCE', t.ids[0], { name: 'bukti.png', mime: 'image/gif' }), 'FILE_TYPE');
  await expectCode(begin(fx.user.petugasA, 'DELETION_EVIDENCE', t.ids[0], { size: 26214401 }), 'FILE_TOO_LARGE');
  assert.equal((await begin(fx.user.petugasA, 'DELETION_EVIDENCE', t.ids[0], { size: 26214400, name: 'ok.jpg', mime: 'image/jpeg' })).max_bytes, 26214400);
  await expectCode(begin(fx.user.pimpinanA, 'DELETION_EVIDENCE', t.ids[0]), 'FORBIDDEN_ROLE');
  await expectCode(begin(fx.user.petugasB, 'DELETION_EVIDENCE', t.ids[0]), 'NOT_FOUND');
  const single = await manual(fx.user.petugasA, newBerkasTarget({ title: 'Bukti satu' }));
  await expectCode(begin(fx.user.petugasA, 'DELETION_EVIDENCE', single.item_id), 'LAST_ITEM_IN_BERKAS');
  // item-scope evidence (png)
  const s = await begin(fx.user.petugasA, 'DELETION_EVIDENCE', t.ids[0], { name: 'Disposisi Pimpinan.PNG', mime: 'image/png' });
  assert.match(s.drive_name, /^\d{8}-\d{6}_ITEM_\d+-1_Bukti satu\.png$/);
  assert.deepEqual(s.folder_path, ['BUKTI PENGHAPUSAN']);
  const fileId = driveId();
  await expectCode(gatewayCommit(pool, fx.user.petugasA, s, { fileId, size: 4096, mime: 'text/plain' }), 'FILE_TYPE');
  await gatewayCommit(pool, fx.user.petugasA, s, { fileId, size: 4096, mime: 'image/png' });
  // wrong object, wrong user, wrong scope
  await expectCode(cancel(fx.user.petugasA, 'ITEM', t.berkasId, t.ids[1], { session: s.session_id }), 'UPLOAD_SESSION_STATE');
  await expectCode(cancel(fx.user.petugasA2, 'ITEM', t.berkasId, t.ids[0], { session: s.session_id }), 'UPLOAD_SESSION_STATE');
  await expectCode(cancel(fx.user.petugasA, 'BERKAS', t.berkasId, null, { session: s.session_id }), 'UPLOAD_SESSION_STATE');
  assert.equal((await itemRow(t.ids[0])).is_deleted, false);
  const res = await cancel(fx.user.petugasA, 'ITEM', t.berkasId, t.ids[0], { session: s.session_id });
  assert.equal(res.evidence_file_id, fileId);
  const [p] = await owner(pool, 'select * from public.pembatalan_arsip where id = $1', [res.cancellation_id]);
  assert.deepEqual([p.bukti_file_id, p.bukti_mime, Number(p.bukti_size_bytes), p.bukti_nama], [fileId, 'image/png', 4096, s.drive_name]);
  const [aud] = await owner(pool, "select reason from public.audit_log where action = 'DELETE' and request_id = $1", [res.request_id]);
  assert.match(aud.reason, / \| Bukti disposisi: https:\/\/drive\.google\.com\/file\/d\//);
  // consumed once
  await expectCode(cancel(fx.user.petugasA, 'ITEM', t.berkasId, t.ids[1], { session: s.session_id }), 'UPLOAD_SESSION_STATE');
  await expectCode(rpc(pool, fx.user.petugasA, 'upload_cancel', { p_session_id: s.session_id }), 'UPLOAD_SESSION_STATE');
  // evidence: admins only; and it cannot be re-bound elsewhere
  assert.equal((await rpc(pool, fx.user.adminA, 'get_file_access', { p_drive_file_id: fileId })).object_type, 'PEMBATALAN');
  assert.equal(await rpc(pool, fx.user.petugasA, 'get_file_access', { p_drive_file_id: fileId }), null);
  assert.equal(await rpc(pool, fx.user.pimpinanA, 'get_file_access', { p_drive_file_id: fileId }), null);
  const s2 = await begin(fx.user.petugasA, 'ITEM_PDF', t.ids[1]);
  await expectCode(gatewayCommit(pool, fx.user.petugasA, s2, { fileId, size: 4096 }), 'UPLOAD_FILE_IN_USE');
  // berkas-scope evidence (pdf), registered v4 evidence folder
  const sb = await begin(fx.user.petugasA, 'DELETION_EVIDENCE', t.berkasId);
  assert.match(sb.drive_name, /^\d{8}-\d{6}_BERKAS_\d+_Bukti\.pdf$/);
  await gatewayCommit(pool, fx.user.petugasA, sb, { size: 4096 });
  const rb = await cancel(fx.user.petugasA, 'BERKAS', t.berkasId, null, { session: sb.session_id });
  assert.ok(rb.evidence_file_id);
});

test('quarantine/cancellation records: RLS admins only; cancellation rows readable by admins of the unit', async () => {
  const t = await threeItems('RLS batal');
  const res = await cancel(fx.user.petugasA, 'ITEM', t.berkasId, t.ids[0]);
  const visible = async (user) => {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: 'authenticated' })]);
      await c.query('set local role authenticated');
      return (await c.query('select id from public.pembatalan_arsip where id = $1', [res.cancellation_id])).rows.length;
    } finally { await c.query('rollback'); c.release(); }
  };
  assert.equal(await visible(fx.user.adminA), 1);
  assert.equal(await visible(fx.user.pusat), 1);
  for (const u of [fx.user.petugasA, fx.user.pimpinanA, fx.user.petugasB]) assert.equal(await visible(u), 0);
});
