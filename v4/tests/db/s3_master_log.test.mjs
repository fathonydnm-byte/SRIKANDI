// 0017_s3_master_log: public.master_log + public.master_log_filter_values.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { newPool, createFixture, asService, asAnon, expectSqlError } from './helpers.mjs';
import { rpc, expectCode } from './s2_fixture.mjs';

const pool = newPool();
let fx;
let T; // unique tag in every object_id so other suites' audit rows never interfere
const oid = (k) => `OBJ-${T}-${k}`;

// Fixed instants (UTC) around Jakarta (UTC+7) midnight of 10 March 2026.
const BEFORE_MIDNIGHT = '2026-03-09T16:59:59.999Z'; // 9 Mar 23:59:59.999 WIB
const AT_MIDNIGHT = '2026-03-09T17:00:00Z';         // 10 Mar 00:00:00 WIB
const END_OF_DAY = '2026-03-10T16:59:59.999Z';      // 10 Mar 23:59:59.999 WIB
const NEXT_MIDNIGHT = '2026-03-10T17:00:00Z';       // 11 Mar 00:00:00 WIB

async function insertLog(c, unit, id, at, o = {}) {
  await c.query(
    `insert into public.audit_log (id, unit_id, occurred_at, actor_name_snapshot, actor_email_snapshot, action, module,
       object_type, object_id, summary, reason, request_id, result, before_data, after_data)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [id, unit, at, o.name ?? 'Siti Aminah', o.email ?? 'siti@uinsa.test', o.action ?? 'UPDATE', o.module ?? 'BERKAS',
     o.type ?? 'BERKAS', o.object ?? oid('x'), o.summary ?? null, o.reason ?? null, o.request ?? null, o.result ?? 'SUCCESS',
     o.before ?? null, o.after ?? null]);
}

before(async () => {
  fx = await createFixture(pool);
  T = `M${fx.tag}`;
  const A = fx.unit.A;
  const B = fx.unit.B;
  await asService(pool, async (c) => {
    // Jakarta date boundaries (unit A)
    await insertLog(c, A, `LOG-${T}-b1`, BEFORE_MIDNIGHT, { object: oid('edge-before') });
    await insertLog(c, A, `LOG-${T}-b2`, AT_MIDNIGHT, { object: oid('edge-start') });
    await insertLog(c, A, `LOG-${T}-b3`, END_OF_DAY, { object: oid('edge-end') });
    await insertLog(c, A, `LOG-${T}-b4`, NEXT_MIDNIGHT, { object: oid('edge-after') });
    // Filter variety (unit A), all on 2026-04-01
    await insertLog(c, A, `LOG-${T}-f1`, '2026-04-01T01:00:00Z', {
      action: 'CREATE', module: 'PENERIMAAN', type: 'PENERIMAAN', object: oid('rcv'), name: 'Budi Santoso', email: 'budi@uinsa.test',
      summary: 'Tanda terima dibuat', reason: 'Naskah baru dari Fakultas', result: 'SUCCESS',
      before: null, after: { nomor: 'TRM-1', status: 'DRAFT' } });
    await insertLog(c, A, `LOG-${T}-f2`, '2026-04-01T02:00:00Z', {
      action: 'UPDATE', module: 'BERKAS', type: 'BERKAS', object: oid('brk'), name: 'Siti Aminah', email: 'siti@uinsa.test',
      summary: 'Judul berkas diubah', reason: 'Koreksi salah ketik', result: 'SUCCESS',
      before: { judul: 'Lapran' }, after: { judul: 'Laporan' } });
    await insertLog(c, A, `LOG-${T}-f3`, '2026-04-01T03:00:00Z', {
      action: 'DELETE', module: 'ITEM', type: 'ITEM', object: oid('itm'), name: null, email: 'ani@uinsa.test',
      summary: 'Item 100% dibatalkan_', reason: 'Salah input', result: 'FAILED' });
    // Paging / ordering: 7 rows with the SAME timestamp (unit A, own action to isolate)
    for (let i = 1; i <= 7; i++) {
      await insertLog(c, A, `LOG-${T}-p${i}`, '2026-05-01T00:00:00Z', { action: 'PAGE', object: oid('page') });
    }
    // Unit B
    await insertLog(c, B, `LOG-${T}-bb1`, '2026-04-01T04:00:00Z', { action: 'CREATE', object: oid('unitB'), type: 'BERKAS' });
    // Cross-unit action of ADMIN_PUSAT (unit_id NULL)
    await insertLog(c, null, `LOG-${T}-null1`, '2026-04-01T05:00:00Z', { action: 'UNIT_CREATE', module: 'UNIT', type: 'UNIT', object: oid('cross') });
  });
});
after(async () => { await pool.end(); });

const log = (user, filters = {}, { limit, offset, unit = null } = {}) =>
  rpc(pool, fx.user[user], 'master_log', { p_filters: filters, p_limit: limit ?? 100, p_offset: offset ?? 0, p_unit_id: unit });
const ids = (r) => r.rows.map((x) => x.id.replace(`LOG-${T}-`, ''));
/** Rows of this suite only (ADMIN_UNIT A already sees only unit A; filter by object_id prefix via q). */
const mine = (user, filters = {}, opts = {}) => log(user, { q: T, ...filters }, opts);

test('SECURITY INVOKER, authenticated only; anon denied', async () => {
  for (const f of ['public.master_log(jsonb, integer, integer, uuid)', 'public.master_log_filter_values(uuid)']) {
    const { rows: [r] } = await pool.query(
      `select prosecdef secdef, has_function_privilege('anon', $1, 'EXECUTE') anon,
              has_function_privilege('authenticated', $1, 'EXECUTE') auth from pg_proc where oid = $1::regprocedure`, [f]);
    assert.deepEqual(r, { secdef: false, anon: false, auth: true }, f);
  }
  await asAnon(pool, async (c) => { await expectSqlError(c.query('select public.master_log()')); });
  await asAnon(pool, async (c) => { await expectSqlError(c.query('select public.master_log_filter_values()')); });
  await expectSqlError(rpc(pool, null, 'master_log', {}));
});

test('role matrix: ADMIN_PUSAT sees every unit, ADMIN_UNIT only its own', async () => {
  const pusat = await mine('pusat', { action: 'CREATE' });
  assert.deepEqual(ids(pusat).sort(), ['bb1', 'f1']);
  const adminA = await mine('adminA', { action: 'CREATE' });
  assert.deepEqual(ids(adminA), ['f1']);
  const adminB = await mine('adminB', { action: 'CREATE' });
  assert.deepEqual(ids(adminB), ['bb1']);
  // Pusat also sees the cross-unit (unit_id NULL) row; unit admins never do.
  assert.deepEqual(ids(await mine('pusat', { action: 'UNIT_CREATE' })), ['null1']);
  assert.equal((await mine('adminA', { action: 'UNIT_CREATE' })).total, 0);
});

test('ADMIN_PUSAT narrows with p_unit_id; ADMIN_UNIT passing its own unit is fine, another is FORBIDDEN_UNIT', async () => {
  const pusatA = await mine('pusat', { action: 'CREATE' }, { unit: fx.unit.A });
  assert.deepEqual(ids(pusatA), ['f1']);
  assert.equal(pusatA.rows[0].unit_code, `T${fx.tag}-A`.replace(/^T/, 'T'));
  assert.deepEqual(ids(await mine('adminA', { action: 'CREATE' }, { unit: fx.unit.A })), ['f1']);
  await expectCode(mine('adminA', {}, { unit: fx.unit.B }), 'FORBIDDEN_UNIT');
  await expectCode(rpc(pool, fx.user.adminA, 'master_log_filter_values', { p_unit_id: fx.unit.B }), 'FORBIDDEN_UNIT');
});

test('PETUGAS and PIMPINAN get a clear FORBIDDEN_ROLE (no silent empty page)', async () => {
  for (const u of ['petugasA', 'pimpinanA', 'petugasB']) {
    await expectCode(log(u), 'FORBIDDEN_ROLE');
    await expectCode(rpc(pool, fx.user[u], 'master_log_filter_values', {}), 'FORBIDDEN_ROLE');
  }
});

test('inactive profile, inactive unit, no profile -> ACCOUNT_INACTIVE; no session -> AUTH_REQUIRED', async () => {
  for (const u of ['inactiveA', 'unitInactive', 'noProfile']) {
    await expectCode(log(u), 'ACCOUNT_INACTIVE');
    await expectCode(rpc(pool, fx.user[u], 'master_log_filter_values', {}), 'ACCOUNT_INACTIVE');
  }
  await expectCode(rpc(pool, null, 'master_log', {}, { role: 'authenticated' }), 'AUTH_REQUIRED');
});

test('RLS still holds underneath: a direct audit_log read by PETUGAS returns nothing', async () => {
  const { rows } = await asRoleQuery(fx.user.petugasA, 'select count(*)::int n from public.audit_log');
  assert.equal(rows[0].n, 0);
});
async function asRoleQuery(userId, sql) {
  const { asUser } = await import('./helpers.mjs');
  return asUser(pool, userId, (c) => c.query(sql));
}

test('result shape and row fields', async () => {
  const r = await mine('adminA', { object_id: oid('brk') });
  assert.equal(r.total, 1);
  assert.equal(r.limit, 100);
  assert.equal(r.offset, 0);
  const [row] = r.rows;
  assert.deepEqual(Object.keys(row).sort(), [
    'action', 'actor_email', 'actor_name', 'actor_user_id', 'after_data', 'before_data', 'id', 'module', 'object_id',
    'object_type', 'occurred_at', 'reason', 'request_id', 'result', 'summary', 'unit_code', 'unit_id', 'unit_name']);
  assert.deepEqual(row.before_data, { judul: 'Lapran' });
  assert.deepEqual(row.after_data, { judul: 'Laporan' });
  assert.equal(row.unit_id, fx.unit.A);
});

test('filter: action, object_type, module, result, object_id are exact', async () => {
  assert.deepEqual(ids(await mine('adminA', { action: 'DELETE' })), ['f3']);
  assert.deepEqual(ids(await mine('adminA', { object_type: 'PENERIMAAN' })), ['f1']);
  assert.deepEqual(ids(await mine('adminA', { module: 'ITEM' })), ['f3']);
  assert.deepEqual(ids(await mine('adminA', { result: 'FAILED' })), ['f3']);
  assert.deepEqual(ids(await mine('adminA', { result: 'failed' })), ['f3'], 'result is case-insensitive');
  assert.deepEqual(ids(await mine('adminA', { object_id: oid('itm') })), ['f3']);
  assert.equal((await mine('adminA', { object_id: oid('it') })).total, 0, 'object_id is not a prefix match');
  assert.equal((await mine('adminA', { action: 'UPD' })).total, 0, 'action is not a substring match');
});

test('filter: actor matches name or e-mail, case-insensitive substring', async () => {
  assert.deepEqual(ids(await mine('adminA', { actor: 'BUDI' })), ['f1']);
  assert.deepEqual(ids(await mine('adminA', { actor: 'santoso' })), ['f1']);
  assert.deepEqual(ids(await mine('adminA', { actor: 'ani@uinsa' })), ['f3'], 'name is NULL, e-mail matches');
  assert.equal((await mine('adminA', { actor: 'tidak-ada' })).total, 0);
});

test('filter: free text over reason, object id, action and summary; wildcards are literal', async () => {
  assert.deepEqual(ids(await mine('adminA', { q: 'KOREKSI salah' })), ['f2'], 'reason');
  assert.deepEqual(ids(await mine('adminA', { q: `${T}-rcv`.toLowerCase() })), ['f1'], 'object id');
  assert.deepEqual(ids(await mine('adminA', { q: 'delet' })), ['f3'], 'action');
  assert.deepEqual(ids(await mine('adminA', { q: 'judul berkas' })), ['f2'], 'summary');
  assert.deepEqual(ids(await mine('adminA', { q: '100%' })), ['f3'], '% is literal');
  assert.equal((await mine('adminA', { q: '%' })).total, 1, 'only the row containing a literal percent sign');
  assert.equal((await mine('adminA', { q: 'dibatalkan_' })).total, 1);
  assert.equal((await mine('adminA', { q: 'dibatalkan?' })).total, 0);
});

test('filter: combined filters are ANDed; blank values are ignored', async () => {
  assert.deepEqual(ids(await mine('adminA', { action: 'UPDATE', actor: 'siti', object_type: 'BERKAS', date_from: '2026-04-01', date_to: '2026-04-01' })), ['f2']);
  assert.equal((await mine('adminA', { action: 'UPDATE', actor: 'budi' })).total, 0);
  const blank = await mine('adminA', { action: '', actor: '   ', object_id: null, date_from: '', date_to: '' });
  assert.equal(blank.total, (await mine('adminA')).total);
});

test('dates are Asia/Jakarta calendar days, inclusive on both ends', async () => {
  const day = async (f, t) => ids(await mine('adminA', { date_from: f, date_to: t, object_type: 'BERKAS', action: 'UPDATE' }))
    .filter((x) => x.startsWith('b'));
  assert.deepEqual(await day('2026-03-10', '2026-03-10'), ['b3', 'b2'], 'whole Jakarta day, newest first');
  assert.deepEqual(await day('2026-03-09', '2026-03-09'), ['b1']);
  assert.deepEqual(await day('2026-03-11', '2026-03-11'), ['b4']);
  assert.deepEqual(await day('2026-03-10', '2026-03-11'), ['b4', 'b3', 'b2']);
  assert.deepEqual(await day('2026-03-09', '2026-03-10'), ['b3', 'b2', 'b1']);
  // from only / to only
  assert.deepEqual((await day('2026-03-11', undefined)).includes('b4'), true);
  assert.deepEqual((await day('2026-03-11', undefined)).includes('b3'), false);
  assert.deepEqual((await day(undefined, '2026-03-09')).includes('b2'), false);
  assert.deepEqual((await day(undefined, '2026-03-09')).includes('b1'), true);
});

test('invalid filters: INVALID_INPUT with the field name', async () => {
  for (const [filters, field] of [
    [{ date_from: '10-03-2026' }, 'date_from'], [{ date_to: '2026-13-01' }, 'date_to'], [{ date_from: '2026-02-30' }, 'date_from'],
    [{ date_from: 'x' }, 'date_from']]) {
    const e = await expectCode(log('adminA', filters), 'INVALID_INPUT');
    assert.equal(JSON.parse(e.detail).field, field);
  }
  await expectCode(log('adminA', { date_from: '2026-03-11', date_to: '2026-03-10' }), 'INVALID_INPUT');
  await expectCode(rpc(pool, fx.user.adminA, 'master_log', { p_filters: '[1,2]' }), 'INVALID_INPUT');
  await expectCode(rpc(pool, fx.user.adminA, 'master_log', { p_filters: '"teks"' }), 'INVALID_INPUT');
  // null / unknown keys are tolerated
  assert.ok((await rpc(pool, fx.user.adminA, 'master_log', { p_filters: null })).total >= 1);
  assert.ok((await log('adminA', { nope: 'x' })).total >= 1);
});

test('pagination: exact total, limit cap, offset, no overlap and no gaps among equal timestamps', async () => {
  const f = { object_id: oid('page') };
  const all = await mine('adminA', f);
  assert.equal(all.total, 7);
  const order = ids(all);
  assert.deepEqual(order, ['p7', 'p6', 'p5', 'p4', 'p3', 'p2', 'p1'], 'same timestamp: id desc tie-break');
  const seen = [];
  for (let off = 0; off < 9; off += 3) {
    const page = await mine('adminA', f, { limit: 3, offset: off });
    assert.equal(page.total, 7, 'total stays exact on every page');
    assert.equal(page.limit, 3);
    assert.equal(page.offset, off);
    seen.push(...ids(page));
  }
  assert.deepEqual(seen, order);
  const beyond = await mine('adminA', f, { limit: 3, offset: 50 });
  assert.equal(beyond.total, 7);
  assert.deepEqual(beyond.rows, []);
  // repeatable
  assert.deepEqual(ids(await mine('adminA', f, { limit: 3, offset: 3 })), order.slice(3, 6));
});

test('limit is capped at 100, floored at 1, defaults to 50; negative offset becomes 0', async () => {
  assert.equal((await log('adminA', {}, { limit: 1000 })).limit, 100);
  assert.equal((await log('adminA', {}, { limit: 0 })).limit, 1);
  assert.equal((await log('adminA', {}, { limit: -5 })).limit, 1);
  const d = await rpc(pool, fx.user.adminA, 'master_log', {});
  assert.equal(d.limit, 50);
  assert.equal(d.offset, 0);
  assert.equal((await log('adminA', {}, { offset: -10 })).offset, 0);
  const big = await log('adminA', { object_type: 'BERKAS' }, { limit: 1000 });
  assert.ok(big.rows.length <= 100);
});

test('ordering: newest first across timestamps', async () => {
  const r = await mine('adminA');
  const times = r.rows.map((x) => Date.parse(x.occurred_at));
  assert.deepEqual([...times].sort((a, b) => b - a), times);
  assert.equal(ids(r)[0], 'p7');
});

test('master_log_filter_values: distinct values within the caller scope', async () => {
  const a = await rpc(pool, fx.user.adminA, 'master_log_filter_values', {});
  for (const x of ['CREATE', 'UPDATE', 'DELETE', 'PAGE']) assert.ok(a.actions.includes(x), x);
  assert.ok(!a.actions.includes('UNIT_CREATE'), 'unit admin never sees cross-unit actions');
  assert.ok(a.object_types.includes('ITEM') && a.object_types.includes('PENERIMAAN'));
  assert.ok(a.modules.includes('BERKAS'));
  assert.deepEqual([...a.actions].sort(), a.actions, 'sorted, no duplicates');
  assert.equal(new Set(a.actions).size, a.actions.length);
  const p = await rpc(pool, fx.user.pusat, 'master_log_filter_values', {});
  assert.ok(p.actions.includes('UNIT_CREATE'));
  const pu = await rpc(pool, fx.user.pusat, 'master_log_filter_values', { p_unit_id: fx.unit.B });
  assert.ok(!pu.actions.includes('UNIT_CREATE') && pu.actions.includes('CREATE'));
  assert.ok(!pu.actions.includes('DELETE'), 'unit B has no DELETE rows');
});

test('indexes used for the newest-first page (no full sort)', async () => {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local enable_seqscan = off');
    await c.query('set local enable_bitmapscan = off');
    const plan = async (sql) => (await c.query(`explain ${sql}`)).rows.map((r) => r['QUERY PLAN']).join('\n');
    const pusat = await plan('select id from public.audit_log order by occurred_at desc, id desc limit 50');
    assert.match(pusat, /audit_log_time_id_idx/);
    assert.doesNotMatch(pusat, /Sort/);
    const unit = await plan(`select id from public.audit_log where unit_id = '${fx.unit.A}' order by occurred_at desc, id desc limit 50`);
    assert.match(unit, /audit_log_unit_time_id_idx/);
    assert.doesNotMatch(unit, /Sort/);
  } finally {
    await c.query('rollback');
    c.release();
  }
});
