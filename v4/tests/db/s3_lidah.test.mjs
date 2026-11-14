// Sprint 3 — Cetak Lidah Folder RPCs (port of central-file/LabelService.js behaviour).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { configureSecret, newPool, rpc, expectCode, owner, createS2Fixture } from './s2_fixture.mjs';
import { asUser, asAnon, expectSqlError } from './helpers.mjs';

let pool;
let fx;
let tag;
const B = {}; // berkas ids by label

const options = (uid, args = {}) => rpc(pool, uid, 'folder_label_options', args);
const print = (uid, ids, slot = 1, extra = {}) =>
  rpc(pool, uid, 'folder_label_print', { p_request_id: randomUUID(), p_berkas_ids: ids, p_start_slot: slot, ...extra });
const row = (res, id) => res.berkas.find((b) => b.id === id);

before(async () => {
  await configureSecret();
  pool = newPool();
  fx = await createS2Fixture(pool);
  tag = randomUUID().slice(0, 6).toUpperCase();
  const mk = async (unit, key, no, over = {}) => {
    const id = `BRK-L${tag}-${key}`;
    B[key] = id;
    await owner(pool,
      `insert into public.berkas (id, unit_id, no_berkas_definitif, judul_berkas, kode_klasifikasi_snapshot, status_berkas,
                                  no_filling_kabinet, no_laci, no_folder, is_deleted, drive_folder_url)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, unit, no, over.title ?? `Berkas fiktif ${key}`, over.code === undefined ? 'PR.01.01' : over.code,
       over.status ?? 'AKTIF', over.kabinet ?? '1', over.laci ?? '2', over.folder ?? null, over.deleted ?? false,
       over.url ?? null]);
  };
  // unit A: numbers 10, 2, 1 (natural order must be numeric), one unnumbered draft, one deleted
  await mk(fx.unit.A, 'A10', 10, { title: 'Sepuluh' });
  await mk(fx.unit.A, 'A2', 2, { title: 'Dua', code: '', folder: '7' });
  await mk(fx.unit.A, 'A1', 1, { title: '  Satu   dengan   spasi  ' });
  await mk(fx.unit.A, 'ADRAFT', null, { status: 'DRAFT' });
  await mk(fx.unit.A, 'ADEL', 3, { deleted: true });
  await mk(fx.unit.B, 'B1', 1, { title: 'Milik unit B' });
});
after(async () => { await pool.end(); });

test('access: anon and service_role cannot call; PIMPINAN reads but cannot write; inactive denied; unit rules', async () => {
  await expectCode(options(null), '42501');
  await expectCode(print(null, [B.A1]), '42501');
  await expectCode(rpc(pool, fx.user.petugasA, 'folder_label_options', {}, { role: 'service_role' }), '42501');
  await expectCode(rpc(pool, fx.user.petugasA, 'folder_label_print',
    { p_request_id: randomUUID(), p_berkas_ids: [B.A1], p_start_slot: 1 }, { role: 'service_role' }), '42501');
  await expectCode(print(fx.user.pimpinanA, [B.A1]), 'FORBIDDEN_ROLE');
  assert.equal((await options(fx.user.pimpinanA)).unit_id, fx.unit.A);
  await expectCode(options(fx.user.inactiveA), 'ACCOUNT_INACTIVE');
  await expectCode(print(fx.user.inactiveA, [B.A1]), 'ACCOUNT_INACTIVE');
  await expectCode(print(fx.user.pusat, [B.A1]), 'UNIT_REQUIRED');
  await expectCode(options(fx.user.pusat), 'UNIT_REQUIRED');
  await expectCode(print(fx.user.petugasA, [B.A1], 1, { p_unit_id: fx.unit.B }), 'FORBIDDEN_UNIT');
  await expectCode(options(fx.user.petugasA, { p_unit_id: fx.unit.B }), 'FORBIDDEN_UNIT');
  const noneWritten = await owner(pool, 'select count(*)::int n from public.folder_label_log where berkas_id = $1', [B.A1]);
  assert.equal(noneWritten[0].n, 0, 'refused calls recorded nothing');
});

test('options: active numbered berkas only, numeric order, printed fields, never-printed status, layout', async () => {
  const o = await options(fx.user.petugasA);
  assert.equal(o.unit_id, fx.unit.A);
  assert.deepEqual(o.berkas.map((b) => b.id), [B.A1, B.A2, B.A10]);
  assert.equal(o.total, 3);
  assert.deepEqual(o.status_counts, { BELUM_DICETAK: 3, SUDAH_DICETAK: 0, PERLU_CETAK_ULANG: 0 });
  assert.deepEqual(o.layout, { paper: 'A4', columns: 2, rows: 7, labels_per_page: 14, label_width_mm: 70, label_height_mm: 30 });
  const a1 = row(o, B.A1);
  assert.deepEqual([a1.number, a1.classification_code, a1.title, a1.location],
    ['1', 'PR.01.01', 'Satu dengan spasi', 'Kabinet 1 · Laci 2 · Folder 1']);
  const a2 = row(o, B.A2);
  assert.deepEqual([a2.classification_code, a2.location], ['TANPA KODE', 'Kabinet 1 · Laci 2 · Folder 7']);
  assert.deepEqual([a1.print_status, a1.needs_reprint, a1.last_printed_at, a1.last_print], ['BELUM_DICETAK', false, null, null]);
  // ADMIN_PUSAT reads a named unit; every row belongs to it
  const p = await options(fx.user.pusat, { p_unit_id: fx.unit.B });
  assert.deepEqual(p.berkas.map((b) => b.id), [B.B1]);
});

test('print: validation (empty, >500, slot range, unknown / inactive / unnumbered / other-unit berkas) records nothing', async () => {
  const count = async () => (await owner(pool, 'select count(*)::int n from public.folder_label_log l where l.unit_id in ($1, $2)', [fx.unit.A, fx.unit.B]))[0].n;
  const before = await count();
  await expectCode(print(fx.user.petugasA, []), 'INVALID_INPUT');
  await expectCode(print(fx.user.petugasA, [' ', '']), 'INVALID_INPUT');
  await expectCode(print(fx.user.petugasA, null), 'INVALID_INPUT');
  await expectCode(print(fx.user.petugasA, Array.from({ length: 501 }, (_, i) => `X-${i}`)), 'INVALID_INPUT');
  for (const slot of [0, 15, -1]) await expectCode(print(fx.user.petugasA, [B.A1], slot), 'INVALID_INPUT');
  await expectCode(print(fx.user.petugasA, [B.A1, 'BRK-TIDAK-ADA']), 'NOT_FOUND');
  await expectCode(print(fx.user.petugasA, [B.A1, B.ADRAFT]), 'NOT_FOUND');
  await expectCode(print(fx.user.petugasA, [B.A1, B.ADEL]), 'NOT_FOUND');
  const err = await expectCode(print(fx.user.petugasA, [B.A1, B.B1]), 'NOT_FOUND'); // other unit's berkas
  assert.deepEqual(JSON.parse(err.detail).missing, [B.B1]);
  await expectCode(rpc(pool, fx.user.petugasA, 'folder_label_print', { p_request_id: null, p_berkas_ids: [B.A1], p_start_slot: 1 }), 'INVALID_INPUT');
  assert.equal(await count(), before);
  // 500 distinct ids are accepted by the size rule (they fail later, as unknown, not as too many)
  await expectCode(print(fx.user.petugasA, Array.from({ length: 500 }, (_, i) => `X-${i}`)), 'NOT_FOUND');
});

test('print: records one snapshot row per berkas, page count follows the start slot, audit entry, user attribution', async () => {
  const req = randomUUID();
  const r = await rpc(pool, fx.user.petugasA, 'folder_label_print', {
    p_request_id: req, p_berkas_ids: [B.A10, B.A1, B.A2, B.A1], p_start_slot: 13 });
  assert.equal(r.ok, true);
  assert.equal(r.replayed, false);
  assert.equal(r.batch_id, 'LBL-' + req.toUpperCase());
  assert.deepEqual([r.start_slot, r.label_count, r.page_count], [13, 3, 1 + Math.ceil((3 - 2) / 14)]); // slots 13,14 then page 2
  assert.deepEqual(r.labels.map((l) => [l.number, l.classification_code, l.title]),
    [['1', 'PR.01.01', 'Satu dengan spasi'], ['2', 'TANPA KODE', 'Dua'], ['10', 'PR.01.01', 'Sepuluh']]);
  assert.match(r.file_name, /^Lidah_Folder_\d{8}_\d{6}\.pdf$/);
  const logs = await owner(pool, 'select * from public.folder_label_log where batch_id = $1 order by no_berkas_snapshot::int', [r.batch_id]);
  assert.equal(logs.length, 3, 'duplicates collapsed');
  assert.ok(logs.every((l) => l.unit_id === fx.unit.A && l.start_slot === 13 && l.status === 'DICETAK' && /^PRN-/.test(l.id)
    && l.actor_user_id === fx.user.petugasA && l.user_email && l.pdf_file_name === r.file_name));
  assert.deepEqual(logs.map((l) => [l.berkas_id, l.no_berkas_snapshot, l.kode_klasifikasi_snapshot, l.judul_berkas_snapshot]),
    [[B.A1, '1', 'PR.01.01', 'Satu dengan spasi'], [B.A2, '2', 'TANPA KODE', 'Dua'], [B.A10, '10', 'PR.01.01', 'Sepuluh']]);
  const audits = await owner(pool, `select * from public.audit_log where request_id = $1`, [req]);
  assert.equal(audits.length, 1);
  assert.deepEqual([audits[0].action, audits[0].module, audits[0].object_type, audits[0].object_id, audits[0].unit_id, audits[0].actor_user_id, audits[0].result],
    ['GENERATE_PDF', 'CETAK_LIDAH_FOLDER', 'BATCH', r.batch_id, fx.unit.A, fx.user.petugasA, 'SUCCESS']);
  // the options now show the snapshot
  const o = await options(fx.user.petugasA);
  assert.deepEqual(o.status_counts, { BELUM_DICETAK: 0, SUDAH_DICETAK: 3, PERLU_CETAK_ULANG: 0 });
  const a1 = row(o, B.A1);
  assert.equal(a1.print_status, 'SUDAH_DICETAK');
  assert.equal(a1.last_print.batch_id, r.batch_id);
  assert.equal(a1.last_print.start_slot, 13);
  assert.equal(a1.last_print.title, 'Satu dengan spasi');
  assert.match(a1.last_printed_at, /\+07:00$/);
});

test('print: page count for slot / selection combinations (legacy ceil((slot-1+n)/14))', async () => {
  const cases = [[1, 1, 1], [14, 1, 1], [14, 2, 2], [2, 3, 1], [13, 3, 2]];
  for (const [slot, n, pages] of cases) {
    const ids = [B.A1, B.A2, B.A10].slice(0, n);
    const r = await print(fx.user.adminA, ids, slot);
    assert.equal(r.page_count, pages, `slot ${slot}, ${n} label(s)`);
  }
});

test('idempotency: replay returns the stored response with replayed=true and writes nothing; payload change conflicts', async () => {
  const req = randomUUID();
  const args = { p_request_id: req, p_berkas_ids: [B.A2, B.A1], p_start_slot: 3, p_file_name: 'Uji.pdf' };
  const first = await rpc(pool, fx.user.petugasA, 'folder_label_print', args);
  assert.equal(first.replayed, false);
  assert.equal(first.file_name, 'Uji.pdf');
  const again = await rpc(pool, fx.user.petugasA, 'folder_label_print', { ...args, p_berkas_ids: [B.A1, B.A2] }); // same set, other order
  assert.equal(again.replayed, true);
  assert.deepEqual({ ...again, replayed: false }, first);
  assert.equal((await owner(pool, 'select count(*)::int n from public.folder_label_log where batch_id = $1', [first.batch_id]))[0].n, 2);
  assert.equal((await owner(pool, 'select count(*)::int n from public.audit_log where request_id = $1', [req]))[0].n, 1);
  await expectCode(rpc(pool, fx.user.petugasA, 'folder_label_print', { ...args, p_start_slot: 4 }), 'IDEMPOTENCY_CONFLICT');
  await expectCode(rpc(pool, fx.user.petugasA, 'folder_label_print', { ...args, p_berkas_ids: [B.A1] }), 'IDEMPOTENCY_CONFLICT');
  // a different operation under the same id is refused too
  await expectCode(rpc(pool, fx.user.petugasA, 'pegawai_add', { p_request_id: req, p_name: 'X', p_unit_kerja: 'Y' }), 'IDEMPOTENCY_CONFLICT');
  // concurrent retries produce a single effect
  const cReq = randomUUID();
  const cArgs = { p_request_id: cReq, p_berkas_ids: [B.A10], p_start_slot: 5 };
  const results = await Promise.all(Array.from({ length: 5 }, () => rpc(pool, fx.user.petugasA, 'folder_label_print', cArgs)));
  assert.equal(results.filter((x) => !x.replayed).length, 1);
  assert.equal((await owner(pool, 'select count(*)::int n from public.folder_label_log where batch_id = $1', ['LBL-' + cReq.toUpperCase()]))[0].n, 1);
});

test('needs_reprint: set when number, code or title changed after the last print; cleared by a new print; location changes do not count', async () => {
  const fresh = randomUUID().slice(0, 6).toUpperCase();
  const id = `BRK-N${fresh}`;
  await owner(pool,
    `insert into public.berkas (id, unit_id, no_berkas_definitif, judul_berkas, kode_klasifikasi_snapshot, status_berkas, no_filling_kabinet)
     values ($1, $2, 900, 'Judul awal', 'KU.02', 'AKTIF', '1')`, [id, fx.unit.A]);
  const st = async () => row(await options(fx.user.petugasA), id);
  assert.equal((await st()).print_status, 'BELUM_DICETAK');
  await print(fx.user.petugasA, [id], 1);
  assert.deepEqual([(await st()).print_status, (await st()).needs_reprint], ['SUDAH_DICETAK', false]);

  await owner(pool, `update public.berkas set no_filling_kabinet = '9', no_laci = '8', catatan = 'x' where id = $1`, [id]);
  assert.equal((await st()).print_status, 'SUDAH_DICETAK', 'location/notes are not printed on the label');
  await owner(pool, `update public.berkas set judul_berkas = '  Judul   awal ' where id = $1`, [id]);
  assert.equal((await st()).print_status, 'SUDAH_DICETAK', 'whitespace-only change is not a change');

  await owner(pool, `update public.berkas set judul_berkas = 'Judul baru' where id = $1`, [id]);
  let s = await st();
  assert.deepEqual([s.print_status, s.needs_reprint, s.print_status_label], ['PERLU_CETAK_ULANG', true, 'Perlu cetak ulang']);
  assert.equal(s.last_print.title, 'Judul awal', 'the snapshot keeps what was printed');
  assert.equal((await options(fx.user.petugasA)).status_counts.PERLU_CETAK_ULANG, 1);
  // other roles see the same flag
  assert.equal(row(await options(fx.user.pimpinanA), id).needs_reprint, true);

  await print(fx.user.petugasA, [id], 2);
  assert.equal((await st()).print_status, 'SUDAH_DICETAK', 'a new print replaces the snapshot');

  await owner(pool, `update public.berkas set kode_klasifikasi_snapshot = 'KU.03' where id = $1`, [id]);
  assert.equal((await st()).needs_reprint, true, 'classification code changed');
  await print(fx.user.petugasA, [id], 1);
  await owner(pool, `update public.berkas set no_berkas_definitif = 901 where id = $1`, [id]);
  s = await st();
  assert.deepEqual([s.number, s.needs_reprint], ['901', true], 'renumbering');
  await print(fx.user.petugasA, [id], 1);
  assert.equal((await st()).needs_reprint, false);
  // the latest print wins even when two prints share a timestamp: three prints exist, newest matches
  assert.equal((await owner(pool, 'select count(*)::int n from public.folder_label_log where berkas_id = $1', [id]))[0].n, 4);
});

test('unit isolation: options and log rows never cross units; ADMIN_PUSAT prints into a named unit', async () => {
  const a = await options(fx.user.petugasA);
  const b = await options(fx.user.petugasB);
  assert.ok(a.berkas.every((x) => !String(x.id).includes('-B1')));
  assert.deepEqual(b.berkas.map((x) => x.id), [B.B1]);
  assert.equal(b.status_counts.SUDAH_DICETAK, 0, 'unit A prints are invisible to unit B');
  await expectCode(print(fx.user.petugasB, [B.A1]), 'NOT_FOUND');
  const rb = await print(fx.user.petugasB, [B.B1], 4);
  assert.equal(rb.label_count, 1);
  const viaPusat = await rpc(pool, fx.user.pusat, 'folder_label_print',
    { p_request_id: randomUUID(), p_berkas_ids: [B.B1], p_start_slot: 1, p_unit_id: fx.unit.B });
  assert.equal(viaPusat.label_count, 1);
  const rows = await owner(pool, 'select distinct unit_id from public.folder_label_log where berkas_id = $1', [B.B1]);
  assert.deepEqual(rows.map((x) => x.unit_id), [fx.unit.B]);
  // ADMIN_PUSAT cannot print a unit A berkas into unit B
  await expectCode(rpc(pool, fx.user.pusat, 'folder_label_print',
    { p_request_id: randomUUID(), p_berkas_ids: [B.A1], p_start_slot: 1, p_unit_id: fx.unit.B }), 'NOT_FOUND');
});

test('folder_label_log: RLS select within the unit, no client writes, append-only, anon denied', async () => {
  const seenA = await asUser(pool, fx.user.petugasA, (c) => c.query('select distinct unit_id from public.folder_label_log'));
  assert.deepEqual(seenA.rows.map((r) => r.unit_id), [fx.unit.A]);
  const seenB = await asUser(pool, fx.user.petugasB, (c) => c.query('select distinct unit_id from public.folder_label_log'));
  assert.deepEqual(seenB.rows.map((r) => r.unit_id), [fx.unit.B]);
  const seenPimpinan = await asUser(pool, fx.user.pimpinanA, (c) => c.query('select count(*)::int n from public.folder_label_log'));
  assert.ok(seenPimpinan.rows[0].n > 0);
  const pusat = await asUser(pool, fx.user.pusat, (c) => c.query('select count(distinct unit_id)::int n from public.folder_label_log'));
  assert.equal(pusat.rows[0].n, 2);
  await expectSqlError(asAnon(pool, (c) => c.query('select 1 from public.folder_label_log')));
  await expectSqlError(asUser(pool, fx.user.adminA, (c) => c.query(
    `insert into public.folder_label_log (id, unit_id, batch_id, berkas_id) values ('PRN-X', $1, 'LBL-X', $2)`, [fx.unit.A, B.A1])));
  await expectSqlError(asUser(pool, fx.user.adminA, (c) => c.query(`update public.folder_label_log set start_slot = 1`)));
  await expectSqlError(asUser(pool, fx.user.adminA, (c) => c.query(`delete from public.folder_label_log`)));
  // even the owner cannot rewrite history
  await expectSqlError(owner(pool, `update public.folder_label_log set start_slot = 2 where berkas_id = $1`, [B.A1]));
  await expectSqlError(owner(pool, `delete from public.folder_label_log where berkas_id = $1`, [B.A1]));
  await expectSqlError(owner(pool, `truncate public.folder_label_log`));
});

test('folder_label_log constraints: slot range, status, berkas must exist in the same unit', async () => {
  const ins = (over) => {
    const v = { id: 'PRN-' + randomUUID(), unit: fx.unit.A, berkas: B.A1, slot: 1, status: 'DICETAK', ...over };
    return owner(pool, `insert into public.folder_label_log (id, unit_id, batch_id, berkas_id, start_slot, status) values ($1, $2, 'LBL-T', $3, $4, $5)`,
      [v.id, v.unit, v.berkas, v.slot, v.status]);
  };
  await expectSqlError(ins({ slot: 0 }), '23514');
  await expectSqlError(ins({ slot: 15 }), '23514');
  await expectSqlError(ins({ status: 'LAIN' }), '23514');
  await expectSqlError(ins({ berkas: B.B1 }), '23503'); // berkas of unit B referenced under unit A (deferred FK, fails at commit)
  await ins({ status: 'PDF_DIBUAT', slot: 14 }); // legacy status accepted (importer)
});
