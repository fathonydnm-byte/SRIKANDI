// Privileges: authenticated can never write; anon can do nothing; privileged
// functions are service_role only; soft-delete / append-only guards.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { newPool, createFixture, asUser, asAnon, expectSqlError, ALL_PUBLIC_TABLES } from './helpers.mjs';

const pool = newPool();
let fx;

before(async () => { fx = await createFixture(pool); });
after(async () => { await pool.end(); });

test('every public table is covered by the test list and has RLS enabled + forced', async () => {
  const { rows } = await pool.query(`
    select c.relname, c.relrowsecurity, c.relforcerowsecurity
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1`);
  assert.deepEqual(rows.map((r) => r.relname), [...ALL_PUBLIC_TABLES].sort());
  for (const r of rows) {
    assert.ok(r.relrowsecurity && r.relforcerowsecurity, `RLS on ${r.relname}`);
  }
});

for (const table of ALL_PUBLIC_TABLES) {
  test(`authenticated (ADMIN_PUSAT and ADMIN_UNIT) cannot insert/update/delete/truncate ${table}`, async () => {
    for (const who of ['pusat', 'adminA']) {
      await asUser(pool, fx.user[who], async (c) => {
        // Default-values insert: privilege is checked before constraints.
        await c.query('savepoint s');
        await expectSqlError(c.query(`insert into public.${table} default values`));
        await c.query('rollback to savepoint s');
        const col = { units: 'name', profiles: 'full_name', schema_migrations_log: 'name' }[table] ?? 'unit_id';
        await expectSqlError(c.query(`update public.${table} set ${col} = ${col} where false`));
        await c.query('rollback to savepoint s');
        await expectSqlError(c.query(`delete from public.${table} where false`));
        await c.query('rollback to savepoint s');
        await expectSqlError(c.query(`truncate public.${table}`));
        await c.query('rollback to savepoint s');
      });
    }
  });

  test(`anon cannot read or write ${table}`, async () => {
    await asAnon(pool, async (c) => {
      await c.query('savepoint s');
      await expectSqlError(c.query(`select * from public.${table} limit 1`));
      await c.query('rollback to savepoint s');
      await expectSqlError(c.query(`insert into public.${table} default values`));
      await c.query('rollback to savepoint s');
      await expectSqlError(c.query(`delete from public.${table} where false`));
    });
  });
}

test('schema_migrations_log is not readable by authenticated', async () => {
  await asUser(pool, fx.user.pusat, async (c) => {
    await expectSqlError(c.query('select * from public.schema_migrations_log'));
  });
});

test('anon cannot use the app schema at all', async () => {
  await asAnon(pool, async (c) => {
    await expectSqlError(c.query('select app.current_unit_id()'));
  });
});

test('authenticated cannot call next_counter / encrypt_pii / decrypt_pii', async () => {
  await asUser(pool, fx.user.pusat, async (c) => {
    await c.query('savepoint s');
    await expectSqlError(c.query('select app.next_counter($1, $2, 2026)', [fx.unit.A, 'TRM']));
    await c.query('rollback to savepoint s');
    await expectSqlError(c.query("select app.encrypt_pii('x')"));
    await c.query('rollback to savepoint s');
    await expectSqlError(c.query("select app.decrypt_pii('\\x00'::bytea)"));
  });
});

test('privileges in the catalog: authenticated has SELECT only, anon nothing', async () => {
  const { rows } = await pool.query(`
    select table_name, grantee, privilege_type
    from information_schema.role_table_grants
    where table_schema = 'public' and grantee in ('anon', 'authenticated', 'PUBLIC')`);
  for (const r of rows) {
    assert.equal(r.grantee, 'authenticated', `${r.grantee} has ${r.privilege_type} on ${r.table_name}`);
    assert.equal(r.privilege_type, 'SELECT', `authenticated has ${r.privilege_type} on ${r.table_name}`);
  }
});

test('service_role cannot hard-delete business rows (soft delete only)', async () => {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local role postgres'); // even the owner is blocked by the trigger
    for (const table of ['units', 'berkas', 'item', 'penerimaan', 'penerimaan_item', 'pegawai', 'klasifikasi', 'counters']) {
      await c.query('savepoint s');
      await expectSqlError(c.query(`delete from public.${table} where false`));
      await c.query('rollback to savepoint s');
    }
  } finally {
    await c.query('rollback');
    c.release();
  }
  const s = await pool.connect();
  try {
    await s.query('begin');
    await s.query('set local role service_role');
    await expectSqlError(s.query('delete from public.berkas where id = $1', [fx.ids.A.berkas]));
  } finally {
    await s.query('rollback');
    s.release();
  }
});

test('audit_log and riwayat_nomor are append-only, even for service_role', async () => {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local role service_role');
    for (const sql of [
      `update public.audit_log set reason = 'x' where id = '${fx.ids.A.audit}'`,
      `delete from public.audit_log where id = '${fx.ids.A.audit}'`,
      'truncate public.audit_log',
      `update public.riwayat_nomor set alasan = 'x'`
    ]) {
      await c.query('savepoint s');
      await expectSqlError(c.query(sql));
      await c.query('rollback to savepoint s');
    }
    // inserting is allowed
    const { rowCount } = await c.query(
      `insert into public.audit_log (unit_id, action, result) values ($1, 'TEST', 'SUCCESS')`, [fx.unit.A]);
    assert.equal(rowCount, 1);
  } finally {
    await c.query('rollback');
    c.release();
  }
});

test('unit_settings refuses secret-looking keys', async () => {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local role service_role');
    await expectSqlError(
      c.query(`insert into public.unit_settings (unit_id, key, value) values ($1, 'RECORD_CENTER_SHARED_SECRET', '"x"')`, [fx.unit.A]),
      '23514'
    );
  } finally {
    await c.query('rollback');
    c.release();
  }
});
