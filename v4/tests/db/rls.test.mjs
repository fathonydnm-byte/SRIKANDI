// Row Level Security: unit isolation, ADMIN_PUSAT scope, inactive users,
// audit_log and profiles visibility.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { newPool, createFixture, asUser } from './helpers.mjs';

const pool = newPool();
let fx;

before(async () => { fx = await createFixture(pool); });
after(async () => { await pool.end(); });

const UNIT_TABLES = [
  'berkas', 'item', 'penerimaan', 'penerimaan_item', 'klasifikasi', 'pegawai',
  'riwayat_nomor', 'unit_settings', 'idempotency_keys', 'counters'
];

/** Units (A/B/C) whose rows of `table` the user can see, restricted to fixture data. */
async function visibleUnits(userId, table) {
  const unitIds = Object.values(fx.unit);
  return asUser(pool, userId, async (c) => {
    const col = table === 'units' ? 'id' : 'unit_id';
    const { rows } = await c.query(
      `select distinct ${col} as unit_id from public.${table} where ${col} = any($1::uuid[])`, [unitIds]
    );
    const byId = Object.fromEntries(Object.entries(fx.unit).map(([k, v]) => [v, k]));
    return rows.map((r) => byId[r.unit_id]).sort();
  });
}

for (const table of UNIT_TABLES) {
  test(`${table}: unit A users see only unit A`, async () => {
    for (const u of ['adminA', 'petugasA', 'pimpinanA']) {
      assert.deepEqual(await visibleUnits(fx.user[u], table), ['A'], `${u} on ${table}`);
    }
  });

  test(`${table}: unit B users see only unit B`, async () => {
    for (const u of ['adminB', 'petugasB']) {
      assert.deepEqual(await visibleUnits(fx.user[u], table), ['B'], `${u} on ${table}`);
    }
  });

  test(`${table}: ADMIN_PUSAT sees every unit`, async () => {
    const expected = table === 'counters' ? ['A', 'B'] : ['A', 'B', 'C'];
    assert.deepEqual(await visibleUnits(fx.user.pusat, table), expected);
  });

  test(`${table}: inactive profile, inactive unit and no profile see nothing`, async () => {
    for (const u of ['inactiveA', 'unitInactive', 'noProfile']) {
      assert.deepEqual(await visibleUnits(fx.user[u], table), [], `${u} on ${table}`);
    }
  });
}

test('direct lookup of another unit\'s berkas/item/penerimaan by id returns nothing', async () => {
  await asUser(pool, fx.user.petugasA, async (c) => {
    for (const [table, id] of [['berkas', fx.ids.B.berkas], ['item', fx.ids.B.item], ['penerimaan', fx.ids.B.penerimaan]]) {
      const { rowCount } = await c.query(`select 1 from public.${table} where id = $1`, [id]);
      assert.equal(rowCount, 0, table);
    }
    const { rowCount } = await c.query('select 1 from public.berkas where id = $1', [fx.ids.A.berkas]);
    assert.equal(rowCount, 1);
  });
});

test('units: own unit only; ADMIN_PUSAT all; inactive nothing', async () => {
  assert.deepEqual(await visibleUnits(fx.user.petugasA, 'units'), ['A']);
  assert.deepEqual(await visibleUnits(fx.user.adminB, 'units'), ['B']);
  assert.deepEqual(await visibleUnits(fx.user.pusat, 'units'), ['A', 'B', 'C']);
  assert.deepEqual(await visibleUnits(fx.user.inactiveA, 'units'), []);
  assert.deepEqual(await visibleUnits(fx.user.unitInactive, 'units'), []);
});

test('audit_log: PETUGAS and PIMPINAN cannot read; ADMIN_UNIT own unit; ADMIN_PUSAT all', async () => {
  assert.deepEqual(await visibleUnits(fx.user.petugasA, 'audit_log'), []);
  assert.deepEqual(await visibleUnits(fx.user.pimpinanA, 'audit_log'), []);
  assert.deepEqual(await visibleUnits(fx.user.petugasB, 'audit_log'), []);
  assert.deepEqual(await visibleUnits(fx.user.adminA, 'audit_log'), ['A']);
  assert.deepEqual(await visibleUnits(fx.user.adminB, 'audit_log'), ['B']);
  assert.deepEqual(await visibleUnits(fx.user.pusat, 'audit_log'), ['A', 'B', 'C']);
  assert.deepEqual(await visibleUnits(fx.user.inactiveA, 'audit_log'), []);
  assert.deepEqual(await visibleUnits(fx.user.unitInactive, 'audit_log'), []);
});

test('profiles: own row; ADMIN_UNIT sees own unit; ADMIN_PUSAT sees all; inactive nothing', async () => {
  const fixtureUsers = Object.values(fx.user);
  const seen = (userId) => asUser(pool, userId, async (c) => {
    const { rows } = await c.query('select user_id from public.profiles where user_id = any($1::uuid[])', [fixtureUsers]);
    const byId = Object.fromEntries(Object.entries(fx.user).map(([k, v]) => [v, k]));
    return rows.map((r) => byId[r.user_id]).sort();
  });
  assert.deepEqual(await seen(fx.user.petugasA), ['petugasA']);
  assert.deepEqual(await seen(fx.user.pimpinanA), ['pimpinanA']);
  assert.deepEqual(await seen(fx.user.adminA), ['adminA', 'inactiveA', 'petugasA', 'pimpinanA']);
  assert.deepEqual(await seen(fx.user.adminB), ['adminB', 'petugasB']);
  assert.deepEqual(await seen(fx.user.pusat), Object.keys(fx.user).filter((k) => k !== 'noProfile').sort());
  assert.deepEqual(await seen(fx.user.inactiveA), []);
  assert.deepEqual(await seen(fx.user.unitInactive), []);
  assert.deepEqual(await seen(fx.user.noProfile), []);
});

test('identity helpers reflect the caller', async () => {
  await asUser(pool, fx.user.petugasA, async (c) => {
    const { rows: [r] } = await c.query('select app.current_unit_id() u, app.current_role() r, app.is_active() a');
    assert.deepEqual(r, { u: fx.unit.A, r: 'PETUGAS', a: true });
  });
  await asUser(pool, fx.user.pusat, async (c) => {
    const { rows: [r] } = await c.query('select app.current_unit_id() u, app.current_role() r, app.is_active() a');
    assert.deepEqual(r, { u: null, r: 'ADMIN_PUSAT', a: true });
  });
  await asUser(pool, fx.user.inactiveA, async (c) => {
    const { rows: [r] } = await c.query('select app.current_unit_id() u, app.current_role() r, app.is_active() a');
    assert.deepEqual(r, { u: null, r: null, a: false });
  });
});

test('profiles check: unit_id null only for ADMIN_PUSAT', async () => {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local role service_role');
    await assert.rejects(
      c.query(`insert into public.profiles (user_id, unit_id, role, full_name) values ($1, null, 'PETUGAS', 'x')`, [fx.user.noProfile]),
      (e) => e.code === '23514'
    );
  } finally {
    await c.query('rollback');
    c.release();
  }
  const c2 = await pool.connect();
  try {
    await c2.query('begin');
    await c2.query('set local role service_role');
    await assert.rejects(
      c2.query(`insert into public.profiles (user_id, unit_id, role, full_name) values ($1, $2, 'ADMIN_PUSAT', 'x')`, [fx.user.noProfile, fx.unit.A]),
      (e) => e.code === '23514'
    );
  } finally {
    await c2.query('rollback');
    c2.release();
  }
});
