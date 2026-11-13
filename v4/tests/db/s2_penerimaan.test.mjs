// Sprint 2 — Penerimaan Arsip RPCs (port of ReceiptService.js behaviour).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  configureSecret, newPool, rpc, expectCode, owner, createS2Fixture, receiptItem, receiptPayload, makeReceipt,
  newBerkasTarget, gatewayCommit
} from './s2_fixture.mjs';

let pool;
let fx;
const year = Number(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Jakarta', year: 'numeric' }).format(new Date()));

before(async () => {
  await configureSecret();
  pool = newPool();
  fx = await createS2Fixture(pool);
});
after(async () => { await pool.end(); });

test('roles: PIMPINAN and inactive users cannot write; anon cannot call; ADMIN_PUSAT must name the unit', async () => {
  const save = (uid, extra = {}) => rpc(pool, uid, 'receipt_save', { p_request_id: randomUUID(), p_payload: receiptPayload(fx), ...extra });
  await expectCode(save(fx.user.pimpinanA), 'FORBIDDEN_ROLE');
  await expectCode(rpc(pool, fx.user.pimpinanA, 'pegawai_add', { p_request_id: randomUUID(), p_name: 'X', p_unit_kerja: 'Y' }), 'FORBIDDEN_ROLE');
  await expectCode(rpc(pool, fx.user.pimpinanA, 'filing_commit', { p_request_id: randomUUID(), p_receipt_item_ids: ['x'], p_target: newBerkasTarget() }), 'FORBIDDEN_ROLE');
  await expectCode(rpc(pool, fx.user.pimpinanA, 'item_create_manual', { p_request_id: randomUUID(), p_target: newBerkasTarget(), p_item: {} }), 'FORBIDDEN_ROLE');
  await expectCode(save(fx.user.inactiveA), 'ACCOUNT_INACTIVE');
  await expectCode(save(null), '42501');
  await expectCode(save(fx.user.pusat), 'UNIT_REQUIRED');
  await expectCode(save(fx.user.petugasA, { p_unit_id: fx.unit.B }), 'FORBIDDEN_UNIT');
  const ok = await rpc(pool, fx.user.pusat, 'receipt_save', {
    p_request_id: randomUUID(), p_payload: receiptPayload(fx, 'B'), p_unit_id: fx.unit.B });
  assert.match(ok.number, new RegExp(`^TRM-${year}-\\d{4}$`));
  // reads are allowed to every active role
  const opts = await rpc(pool, fx.user.pimpinanA, 'receipt_options', {});
  assert.equal(opts.unit_id, fx.unit.A);
  // service_role has no execute grant
  await expectCode(rpc(pool, fx.user.petugasA, 'receipt_options', {}, { role: 'service_role' }), '42501');
});

test('pegawai_add: creates, matches case/space-insensitively, reactivates, replays', async () => {
  const req = randomUUID();
  const a = await rpc(pool, fx.user.petugasA, 'pegawai_add', { p_request_id: req, p_name: 'Dewi  Fiktif', p_unit_kerja: 'Bagian Uji' });
  assert.equal(a.created, true);
  assert.match(a.employee.id, /^PGW-/);
  const again = await rpc(pool, fx.user.petugasA, 'pegawai_add', { p_request_id: req, p_name: 'Dewi  Fiktif', p_unit_kerja: 'Bagian Uji' });
  assert.deepEqual({ ...again, replayed: false }, { ...a, replayed: false });
  assert.equal(again.replayed, true);
  const same = await rpc(pool, fx.user.petugasA, 'pegawai_add', { p_request_id: randomUUID(), p_name: 'dewi fiktif', p_unit_kerja: ' BAGIAN UJI ' });
  assert.equal(same.created, false);
  assert.equal(same.employee.id, a.employee.id);
  const re = await rpc(pool, fx.user.petugasA, 'pegawai_add', { p_request_id: randomUUID(), p_name: 'Sari Fiktif', p_unit_kerja: 'Subbagian Uji' });
  assert.deepEqual([re.employee.id, re.reactivated], [fx.pegawai.Ainactive, true]);
  await expectCode(rpc(pool, fx.user.petugasA, 'pegawai_add', { p_request_id: randomUUID(), p_name: ' ', p_unit_kerja: 'x' }), 'INVALID_INPUT');
  await expectCode(rpc(pool, fx.user.petugasA, 'pegawai_add', { p_request_id: req, p_name: 'Lain', p_unit_kerja: 'x' }), 'IDEMPOTENCY_CONFLICT');
});

test('receipt_save create: TRM number per unit/year, server time, stable ids, idempotent replay', async () => {
  const req = randomUUID();
  const items = [receiptItem({ description: 'Satu' }), receiptItem({ description: 'Dua', page_count: 5, security_classification: 'terbatas' })];
  const r1 = await rpc(pool, fx.user.petugasA, 'receipt_save', { p_request_id: req, p_payload: receiptPayload(fx, 'A', items) });
  assert.equal(r1.receipt_id, 'RCV-' + req.toUpperCase());
  assert.equal(r1.is_update, false);
  assert.deepEqual([r1.item_count, r1.total_pages], [2, 8]);
  const [rec] = await owner(pool, 'select *, extract(epoch from now() - tanggal_waktu_terima) as age from public.penerimaan where id = $1', [r1.receipt_id]);
  assert.ok(Number(rec.age) < 60, 'server time');
  assert.equal(rec.tahun, year);
  const lines = await owner(pool, 'select * from public.penerimaan_item where penerimaan_id = $1 order by no_item', [r1.receipt_id]);
  assert.deepEqual(lines.map((l) => [l.no_item, l.status_pemberkasan, l.klasifikasi_keamanan_akses]),
    [[1, 'BELUM DIBERKASKAN', 'BIASA/TERBUKA'], [2, 'BELUM DIBERKASKAN', 'TERBATAS']]);
  assert.ok(lines.every((l) => /^RCVI-/.test(l.id) && /^ARS-/.test(l.arsip_id)));
  // replay: same response, nothing new
  const replay = await rpc(pool, fx.user.petugasA, 'receipt_save', { p_request_id: req, p_payload: receiptPayload(fx, 'A', items) });
  assert.equal(replay.replayed, true);
  assert.equal(replay.number, r1.number);
  assert.equal((await owner(pool, 'select count(*)::int n from public.penerimaan where id = $1', [r1.receipt_id]))[0].n, 1);
  await expectCode(rpc(pool, fx.user.petugasA, 'receipt_save', { p_request_id: req, p_payload: receiptPayload(fx, 'A', [receiptItem()]) }), 'IDEMPOTENCY_CONFLICT');
  const r2 = await rpc(pool, fx.user.petugasA, 'receipt_save', { p_request_id: randomUUID(), p_payload: receiptPayload(fx) });
  assert.equal(Number(r2.number.slice(-4)), Number(r1.number.slice(-4)) + 1);
  // recover
  const rec1 = await rpc(pool, fx.user.petugasA, 'receipt_recover', { p_request_id: req });
  assert.deepEqual([rec1.found, rec1.receipt_id, rec1.number], [true, r1.receipt_id, r1.number]);
  assert.equal((await rpc(pool, fx.user.petugasA, 'receipt_recover', { p_request_id: randomUUID() })).found, false);
  // audit
  const [aud] = await owner(pool, "select * from public.audit_log where object_id = $1 and action = 'CREATE'", [r1.receipt_id]);
  assert.equal(aud.actor_user_id, fx.user.petugasA);
  assert.equal(aud.module, 'PENERIMAAN_ARSIP');
});

test('receipt_save validation (every guard of normalizeReceiptForm_ / normalizeReceiptItems_)', async () => {
  const save = (payload) => rpc(pool, fx.user.petugasA, 'receipt_save', { p_request_id: randomUUID(), p_payload: payload });
  await expectCode(save(receiptPayload(fx, 'A', [])), 'INVALID_INPUT');
  await expectCode(save(receiptPayload(fx, 'A', Array.from({ length: 101 }, () => receiptItem()))), 'BATCH_LIMIT');
  for (const bad of [{ page_count: 0 }, { page_count: 1.5 }, { page_count: 'tiga' }, { development_level: 'SALINAN' },
    { condition: 'HILANG' }, { security_classification: '' }, { security_classification: 'PUBLIK' }, { document_date: '2025-02-30' },
    { document_date: '' }, { description: '  ' }]) {
    const e = await expectCode(save(receiptPayload(fx, 'A', [receiptItem(), receiptItem(bad)])), 'INVALID_INPUT');
    assert.match(JSON.parse(e.detail).field, /^items\[1\]\./, JSON.stringify(bad));
  }
  await owner(pool, 'update public.pegawai set aktif = false where id = $1', [fx.pegawai.Ainactive]); // reactivated by an earlier test
  await expectCode(save(receiptPayload(fx, 'A', [receiptItem()], { sender_employee_id: fx.pegawai.Ainactive })), 'NOT_FOUND');
  await expectCode(save(receiptPayload(fx, 'A', [receiptItem()], { sender_employee_id: fx.pegawai.B })), 'NOT_FOUND');
  await expectCode(save(receiptPayload(fx, 'A', [receiptItem()], { receiver_name: '' })), 'INVALID_INPUT');
  await expectCode(save(receiptPayload(fx, 'A', [receiptItem()], { receiver_unit: '' })), 'INVALID_INPUT');
  // security alias accepted and normalised (validateArchiveSecurityClassification_)
  const ok = await save(receiptPayload(fx, 'A', [receiptItem({ security_classification: 'biasa', development_level: 'copy', condition: 'rusak ringan' })]));
  const [l] = await owner(pool, 'select * from public.penerimaan_item where penerimaan_id = $1', [ok.receipt_id]);
  assert.deepEqual([l.klasifikasi_keamanan_akses, l.tingkat_perkembangan, l.kondisi], ['BIASA/TERBUKA', 'COPY', 'RUSAK RINGAN']);
});

test('TRM counter continues after imported legacy numbers and is per unit', async () => {
  await owner(pool, `insert into public.penerimaan (id, unit_id, nomor_tanda_terima, tahun, tanggal_waktu_terima)
                     values ($1, $2, $3, $4, now())`, [`RCV-IMPORT-${fx.tag}`, fx.unit.B, `TRM-${year}-0041`, year]);
  const r = await rpc(pool, fx.user.petugasB, 'receipt_save', { p_request_id: randomUUID(), p_payload: receiptPayload(fx, 'B') });
  assert.equal(r.number, `TRM-${year}-0042`);
});

test('concurrency: 12 parallel receipt saves get distinct consecutive numbers', async () => {
  const before = (await owner(pool, 'select count(*)::int n from public.penerimaan where unit_id = $1', [fx.unit.A]))[0].n;
  const users = [fx.user.petugasA, fx.user.petugasA2, fx.user.adminA];
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    rpc(pool, users[i % 3], 'receipt_save', { p_request_id: randomUUID(), p_payload: receiptPayload(fx) })));
  const seq = results.map((r) => Number(r.number.slice(-4))).sort((a, b) => a - b);
  assert.equal(new Set(seq).size, 12);
  assert.equal(seq[11] - seq[0], 11);
  assert.equal((await owner(pool, 'select count(*)::int n from public.penerimaan where unit_id = $1', [fx.unit.A]))[0].n, before + 12);
});

test('unit isolation: another unit cannot see, edit, print or cancel a receipt', async () => {
  const r = await makeReceipt(pool, fx, fx.user.petugasA, 'A', [receiptItem()]);
  await expectCode(rpc(pool, fx.user.petugasB, 'receipt_save', { p_request_id: randomUUID(),
    p_payload: receiptPayload(fx, 'B', [receiptItem()], { receipt_id: r.receipt_id }) }), 'NOT_FOUND');
  await expectCode(rpc(pool, fx.user.petugasB, 'receipt_print_prepare', { p_receipt_id: r.receipt_id }), 'NOT_FOUND');
  await expectCode(rpc(pool, fx.user.petugasB, 'receipt_print_confirm', { p_receipt_id: r.receipt_id, p_print_token: 'RCPRINT-x' }), 'NOT_FOUND');
  await expectCode(rpc(pool, fx.user.petugasB, 'receipt_cancel', { p_request_id: randomUUID(), p_receipt_id: r.receipt_id,
    p_reason: 'alasan yang cukup panjang', p_confirmation: 'BATALKAN' }), 'NOT_FOUND');
  const optsB = await rpc(pool, fx.user.petugasB, 'receipt_options', {});
  assert.ok(!optsB.receipts.some((x) => x.id === r.receipt_id));
  const optsA = await rpc(pool, fx.user.pimpinanA, 'receipt_options', {});
  assert.ok(optsA.receipts.some((x) => x.id === r.receipt_id));
  await expectCode(rpc(pool, fx.user.petugasA, 'receipt_options', { p_unit_id: fx.unit.B }), 'FORBIDDEN_UNIT');
});

test('edit before evidence: header, add, change, remove (soft) and renumber lines', async () => {
  const r = await makeReceipt(pool, fx, fx.user.petugasA, 'A', [receiptItem({ description: 'L1' }), receiptItem({ description: 'L2' }), receiptItem({ description: 'L3' })]);
  const [l1, l2, l3] = r.itemIds;
  const res = await rpc(pool, fx.user.petugasA, 'receipt_save', { p_request_id: randomUUID(), p_payload: receiptPayload(fx, 'A', [
    receiptItem({ receipt_item_id: l3, description: 'L3 diperbaiki' }), receiptItem({ receipt_item_id: l1, description: 'L1' }),
    receiptItem({ description: 'L4 baru' })], { receipt_id: r.receipt_id, notes: 'Catatan diubah', receiver_name: 'Penerima Lain' }) });
  assert.equal(res.is_update, true);
  const rows = await owner(pool, 'select id, no_item, uraian_informasi, is_deleted from public.penerimaan_item where penerimaan_id = $1 order by is_deleted, no_item', [r.receipt_id]);
  assert.deepEqual(rows.map((x) => [x.no_item, x.uraian_informasi, x.is_deleted]),
    [[1, 'L3 diperbaiki', false], [2, 'L1', false], [3, 'L4 baru', false], [2, 'L2', true]]);
  assert.equal(rows[3].id, l2);
  const [rec] = await owner(pool, 'select * from public.penerimaan where id = $1', [r.receipt_id]);
  assert.deepEqual([rec.nama_penerima, rec.catatan_umum, rec.jumlah_item, rec.version], ['Penerima Lain', 'Catatan diubah', 3, 2]);
  await expectCode(rpc(pool, fx.user.petugasA, 'receipt_save', { p_request_id: randomUUID(), p_payload: receiptPayload(fx, 'A', [
    receiptItem({ receipt_item_id: l1 }), receiptItem({ receipt_item_id: l1 })], { receipt_id: r.receipt_id }) }), 'INVALID_INPUT');
  await expectCode(rpc(pool, fx.user.petugasA, 'receipt_save', { p_request_id: randomUUID(), p_payload: receiptPayload(fx, 'A', [
    receiptItem({ receipt_item_id: 'RCVI-tidak-ada' })], { receipt_id: r.receipt_id }) }), 'NOT_FOUND');
  await expectCode(rpc(pool, fx.user.petugasA, 'receipt_save', { p_request_id: randomUUID(), p_payload: receiptPayload(fx, 'A', [
    receiptItem({ receipt_item_id: l1, archive_id: 'ARS-lain' })], { receipt_id: r.receipt_id }) }), 'INVALID_INPUT');
});

test('edit locks: after evidence and after filing; cancelled receipts are not editable', async () => {
  const r = await makeReceipt(pool, fx, fx.user.petugasA, 'A', [receiptItem({ description: 'E1' }), receiptItem({ description: 'E2' })]);
  const [e1, e2] = r.itemIds;
  // signed evidence via the attested upload flow
  const s = await rpc(pool, fx.user.petugasA, 'upload_begin', { p_request_id: randomUUID(), p_purpose: 'RECEIPT_EVIDENCE',
    p_object_id: r.receipt_id, p_file_name: 'ttd.pdf', p_mime: 'application/pdf', p_size: 1234 });
  await gatewayCommit(pool, fx.user.petugasA, s);
  const base = (items, over = {}) => ({ p_request_id: randomUUID(), p_payload: receiptPayload(fx, 'A', items, { receipt_id: r.receipt_id, ...over }) });
  const same = [receiptItem({ receipt_item_id: e1, description: 'E1' }), receiptItem({ receipt_item_id: e2, description: 'E2' })];
  await expectCode(rpc(pool, fx.user.petugasA, 'receipt_save', base(same, { notes: 'lain' })), 'RECEIPT_LOCKED');
  await expectCode(rpc(pool, fx.user.petugasA, 'receipt_save', base([...same, receiptItem()])), 'RECEIPT_LOCKED');
  await expectCode(rpc(pool, fx.user.petugasA, 'receipt_save', base([same[0]])), 'RECEIPT_LOCKED');
  await expectCode(rpc(pool, fx.user.petugasA, 'receipt_save', base([same[0], { ...same[1], page_count: 9 }])), 'RECEIPT_LOCKED');
  await expectCode(rpc(pool, fx.user.petugasA, 'receipt_save', base([same[0], { ...same[1], notes: 'lengkap terkunci' }])), 'RECEIPT_LOCKED');
  const unchanged = await rpc(pool, fx.user.petugasA, 'receipt_save', base(same));
  assert.equal(unchanged.is_update, true);

  // filed line: no change, no removal; header locked
  const r2 = await makeReceipt(pool, fx, fx.user.petugasA, 'A', [receiptItem({ description: 'F1' }), receiptItem({ description: 'F2' })]);
  await rpc(pool, fx.user.petugasA, 'filing_commit', { p_request_id: randomUUID(), p_receipt_item_ids: [r2.itemIds[0]], p_target: newBerkasTarget() });
  const b2 = (items, over = {}) => ({ p_request_id: randomUUID(), p_payload: receiptPayload(fx, 'A', items, { receipt_id: r2.receipt_id, ...over }) });
  const f = [receiptItem({ receipt_item_id: r2.itemIds[0], description: 'F1' }), receiptItem({ receipt_item_id: r2.itemIds[1], description: 'F2' })];
  await expectCode(rpc(pool, fx.user.petugasA, 'receipt_save', b2([{ ...f[0], description: 'F1 ubah' }, f[1]])), 'ITEM_ALREADY_FILED');
  await expectCode(rpc(pool, fx.user.petugasA, 'receipt_save', b2([f[1]])), 'ITEM_ALREADY_FILED');
  await expectCode(rpc(pool, fx.user.petugasA, 'receipt_save', b2(f, { receiver_unit: 'Unit lain' })), 'RECEIPT_LOCKED');
  const ok = await rpc(pool, fx.user.petugasA, 'receipt_save', b2([f[0], { ...f[1], description: 'F2 boleh diubah' }]));
  assert.equal(ok.is_update, true);

  const r3 = await makeReceipt(pool, fx, fx.user.petugasA, 'A', [receiptItem()]);
  await rpc(pool, fx.user.petugasA, 'receipt_cancel', { p_request_id: randomUUID(), p_receipt_id: r3.receipt_id, p_reason: 'salah unit penyerah', p_confirmation: 'batalkan' });
  await expectCode(rpc(pool, fx.user.petugasA, 'receipt_save', { p_request_id: randomUUID(),
    p_payload: receiptPayload(fx, 'A', [receiptItem({ receipt_item_id: r3.itemIds[0] })], { receipt_id: r3.receipt_id }) }), 'RECEIPT_CANCELLED');
});

test('print: prepare token, confirm first/reprint, idempotent per token, traceable log', async () => {
  const r = await makeReceipt(pool, fx, fx.user.petugasA, 'A', [receiptItem({ description: 'P1' }), receiptItem({ description: 'P2' })]);
  const p1 = await rpc(pool, fx.user.pimpinanA, 'receipt_print_prepare', { p_receipt_id: r.receipt_id });
  assert.deepEqual([p1.is_reprint, p1.print_number, p1.items.length], [false, 1, 2]);
  assert.match(p1.print_token, /^RCPRINT-/);
  assert.equal(p1.file_name, `${r.number}_Tanda-Terima-Penyerahan-Arsip.pdf`);
  await expectCode(rpc(pool, fx.user.pimpinanA, 'receipt_print_confirm', { p_receipt_id: r.receipt_id, p_print_token: p1.print_token }), 'FORBIDDEN_ROLE');
  const c1 = await rpc(pool, fx.user.petugasA, 'receipt_print_confirm', { p_receipt_id: r.receipt_id, p_print_token: p1.print_token });
  assert.deepEqual([c1.print_count, c1.replayed], [1, false]);
  const c1b = await rpc(pool, fx.user.petugasA, 'receipt_print_confirm', { p_receipt_id: r.receipt_id, p_print_token: p1.print_token });
  assert.deepEqual([c1b.print_count, c1b.replayed], [1, true]);
  const p2 = await rpc(pool, fx.user.petugasA, 'receipt_print_prepare', { p_receipt_id: r.receipt_id });
  assert.deepEqual([p2.is_reprint, p2.print_number], [true, 2]);
  const c2 = await rpc(pool, fx.user.petugasA2, 'receipt_print_confirm', { p_receipt_id: r.receipt_id, p_print_token: p2.print_token });
  assert.equal(c2.print_count, 2);
  const logs = await owner(pool, 'select cetak_ke, jenis_cetak, actor_user_id from public.penerimaan_cetak_log where penerimaan_id = $1 order by cetak_ke', [r.receipt_id]);
  assert.deepEqual(logs.map((l) => [l.cetak_ke, l.jenis_cetak, l.actor_user_id]),
    [[1, 'PERTAMA', fx.user.petugasA], [2, 'CETAK ULANG', fx.user.petugasA2]]);
  assert.equal((await owner(pool, "select count(*)::int n from public.audit_log where object_id = $1 and action = 'GENERATE_PDF'", [r.receipt_id]))[0].n, 2);
});

test('cancel: guards, refused while filed, effect, replay, evidence session consumed once', async () => {
  const r = await makeReceipt(pool, fx, fx.user.petugasA, 'A', [receiptItem({ description: 'C1' }), receiptItem({ description: 'C2' })]);
  const cancel = (over = {}) => rpc(pool, fx.user.petugasA, 'receipt_cancel', { p_request_id: randomUUID(), p_receipt_id: r.receipt_id,
    p_reason: 'Salah unit penyerah arsip', p_confirmation: 'BATALKAN', ...over });
  await expectCode(cancel({ p_reason: 'pendek' }), 'INVALID_INPUT');
  await expectCode(cancel({ p_confirmation: 'ya' }), 'INVALID_INPUT');
  const filed = await rpc(pool, fx.user.petugasA, 'filing_commit', { p_request_id: randomUUID(), p_receipt_item_ids: [r.itemIds[0]], p_target: newBerkasTarget() });
  const e = await expectCode(cancel(), 'RECEIPT_HAS_FILED_ITEMS');
  assert.deepEqual(JSON.parse(e.detail).items, [`${filed.berkas_number}/1`]);
  // release the filed item the way Koreksi & Pembatalan will (Sprint 3): soft-delete it
  await owner(pool, 'update public.item set is_deleted = true where penerimaan_item_id = $1', [r.itemIds[0]]);

  const s = await rpc(pool, fx.user.petugasA, 'upload_begin', { p_request_id: randomUUID(), p_purpose: 'RECEIPT_CANCEL_EVIDENCE',
    p_object_id: r.receipt_id, p_file_name: 'bukti-batal.pdf', p_mime: 'application/pdf', p_size: 2000 });
  assert.equal(s.drive_name, `${r.number}_Bukti-Pembatalan.pdf`);
  await expectCode(cancel({ p_evidence_session_id: s.session_id }), 'UPLOAD_SESSION_STATE'); // not committed yet
  const committed = await gatewayCommit(pool, fx.user.petugasA, s, { size: 2000 });
  const req = randomUUID();
  const res = await rpc(pool, fx.user.petugasA, 'receipt_cancel', { p_request_id: req, p_receipt_id: r.receipt_id,
    p_reason: 'Salah unit penyerah arsip', p_confirmation: 'BATALKAN', p_evidence_session_id: s.session_id });
  assert.equal(res.evidence_file_id, committed.drive_file_id);
  const [rec] = await owner(pool, 'select * from public.penerimaan where id = $1', [r.receipt_id]);
  assert.deepEqual([rec.status, rec.alasan_pembatalan, rec.batal_bukti_file_id, rec.batal_bukti_nama],
    ['DIBATALKAN', 'Salah unit penyerah arsip', committed.drive_file_id, `${r.number}_Bukti-Pembatalan.pdf`]);
  const lines = await owner(pool, 'select status_pemberkasan from public.penerimaan_item where penerimaan_id = $1 and not is_deleted', [r.receipt_id]);
  assert.ok(lines.every((l) => l.status_pemberkasan === 'DIBATALKAN'));
  const replay = await rpc(pool, fx.user.petugasA, 'receipt_cancel', { p_request_id: req, p_receipt_id: r.receipt_id,
    p_reason: 'Salah unit penyerah arsip', p_confirmation: 'BATALKAN', p_evidence_session_id: s.session_id });
  assert.equal(replay.replayed, true);
  const again = await cancel();
  assert.equal(again.already_cancelled, true);
  // the consumed evidence session cannot be reused
  const r2 = await makeReceipt(pool, fx, fx.user.petugasA, 'A', [receiptItem()]);
  await expectCode(rpc(pool, fx.user.petugasA, 'receipt_cancel', { p_request_id: randomUUID(), p_receipt_id: r2.receipt_id,
    p_reason: 'Salah unit penyerah arsip', p_confirmation: 'BATALKAN', p_evidence_session_id: s.session_id }), 'UPLOAD_SESSION_STATE');
  // cancelled receipt lines leave the filing queue
  const q = await rpc(pool, fx.user.petugasA, 'filing_options', {});
  assert.ok(!q.items.some((x) => x.receipt_id === r.receipt_id));
});
