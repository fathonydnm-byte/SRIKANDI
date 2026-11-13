// app.next_counter under concurrency, and PII column encryption.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { newPool, createFixture, asService, expectSqlError } from './helpers.mjs';

const pool = newPool(25);
let fx;

before(async () => { fx = await createFixture(pool); });
after(async () => { await pool.end(); });

async function nextCounter(unitId, scope, year) {
  return asService(pool, async (c) => {
    const { rows: [r] } = await c.query('select app.next_counter($1, $2, $3) as v', [unitId, scope, year]);
    return Number(r.v);
  });
}

test('next_counter: 20 parallel connections x 25 calls give 1..500 with no duplicates', async () => {
  const connections = 20;
  const callsEach = 25;
  const scope = 'CONC';
  const year = 2031;
  // Hold all clients open first so the calls really overlap.
  const clients = await Promise.all(Array.from({ length: connections }, () => pool.connect()));
  try {
    const perClient = await Promise.all(clients.map(async (c) => {
      const got = [];
      for (let i = 0; i < callsEach; i++) {
        await c.query('begin');
        await c.query('set local role service_role');
        const { rows: [r] } = await c.query('select app.next_counter($1, $2, $3) as v', [fx.unit.A, scope, year]);
        // small random delay inside the transaction to widen the race window
        if (Math.random() < 0.3) await c.query('select pg_sleep(0.002)');
        await c.query('commit');
        got.push(Number(r.v));
      }
      return got;
    }));
    const all = perClient.flat().sort((a, b) => a - b);
    assert.equal(all.length, connections * callsEach);
    assert.equal(new Set(all).size, all.length, 'duplicate counter values');
    assert.deepEqual(all, Array.from({ length: all.length }, (_, i) => i + 1));
    // each connection saw strictly increasing values
    for (const seq of perClient) {
      for (let i = 1; i < seq.length; i++) assert.ok(seq[i] > seq[i - 1]);
    }
  } finally {
    clients.forEach((c) => c.release());
  }
  const { rows: [row] } = await pool.query(
    'select last_value from public.counters where unit_id = $1 and scope = $2 and year = $3', [fx.unit.A, scope, year]);
  assert.equal(Number(row.last_value), connections * callsEach);
});

test('next_counter: independent per unit, scope and year', async () => {
  assert.equal(await nextCounter(fx.unit.A, 'UP', 2026), 1);
  assert.equal(await nextCounter(fx.unit.A, 'UP', 2026), 2);
  assert.equal(await nextCounter(fx.unit.B, 'UP', 2026), 1);
  assert.equal(await nextCounter(fx.unit.A, 'UP', 2027), 1);
  assert.equal(await nextCounter(fx.unit.A, 'TRM', 2027), 1);
  assert.equal(await nextCounter(fx.unit.A, 'UP', 2026), 3);
  assert.equal(await nextCounter(fx.unit.B, 'UP', 2026), 2);
});

test('next_counter: a rolled-back call does not consume a value', async () => {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local role service_role');
    await c.query('select app.next_counter($1, $2, 2026)', [fx.unit.B, 'RB']);
    await c.query('rollback');
  } finally {
    c.release();
  }
  assert.equal(await nextCounter(fx.unit.B, 'RB', 2026), 1);
});

test('next_counter: rejects null arguments, bad scope and unknown unit', async () => {
  await expectSqlError(nextCounter(null, 'TRM', 2026), '22004');
  await expectSqlError(nextCounter(fx.unit.A, 'bad scope', 2026), '23514');
  await expectSqlError(nextCounter('00000000-0000-4000-8000-0000000000ff', 'TRM', 2026), '23503');
});

const KEY = 'test-only-pii-key-0123456789abcdef';

test('PII: encrypt/decrypt round-trip, stored value is not plaintext', async () => {
  const nip = '198703152019031007';
  const phone = '+62 812-3456-7890';
  const pegawaiId = `PGW-${fx.tag}-PII`;
  await asService(pool, async (c) => {
    await c.query("select set_config('app.pii_key', $1, true)", [KEY]);
    await c.query(
      `insert into public.pegawai (id, unit_id, nama_pegawai, nip_nik_enc, kontak_enc)
       values ($1, $2, 'Pegawai PII', app.encrypt_pii($3), app.encrypt_pii($4))`,
      [pegawaiId, fx.unit.A, nip, phone]
    );
  });

  // Raw stored bytes (read as owner, no key): must not contain the plaintext.
  const { rows: [raw] } = await pool.query(
    'select nip_nik_enc, kontak_enc, encode(nip_nik_enc, \'escape\') as esc from public.pegawai where id = $1', [pegawaiId]);
  assert.ok(Buffer.isBuffer(raw.nip_nik_enc) && raw.nip_nik_enc.length > nip.length);
  assert.ok(!raw.nip_nik_enc.includes(Buffer.from(nip)), 'NIP stored in plaintext');
  assert.ok(!raw.kontak_enc.includes(Buffer.from(phone)), 'phone stored in plaintext');
  assert.ok(!raw.esc.includes(nip));

  // Round trip with the key.
  const out = await asService(pool, async (c) => {
    await c.query("select set_config('app.pii_key', $1, true)", [KEY]);
    const { rows: [r] } = await c.query(
      'select app.decrypt_pii(nip_nik_enc) nip, app.decrypt_pii(kontak_enc) phone from public.pegawai where id = $1', [pegawaiId]);
    return r;
  });
  assert.deepEqual(out, { nip, phone });

  // Same plaintext encrypts differently each time (random session key / IV).
  const twice = await asService(pool, async (c) => {
    await c.query("select set_config('app.pii_key', $1, true)", [KEY]);
    const { rows: [r] } = await c.query('select app.encrypt_pii($1) = app.encrypt_pii($1) as same', [nip]);
    return r.same;
  });
  assert.equal(twice, false);
});

test('PII: missing key or wrong key fails; NULL passes through', async () => {
  await expectSqlError(asService(pool, (c) => c.query("select app.encrypt_pii('x')")), '22023');
  const cipher = await asService(pool, async (c) => {
    await c.query("select set_config('app.pii_key', $1, true)", [KEY]);
    const { rows: [r] } = await c.query("select app.encrypt_pii('rahasia') v, app.encrypt_pii(null) n");
    assert.equal(r.n, null);
    return r.v;
  });
  await expectSqlError(asService(pool, (c) => c.query('select app.decrypt_pii($1)', [cipher])), '22023');
  await assert.rejects(asService(pool, async (c) => {
    await c.query("select set_config('app.pii_key', $1, true)", ['another-wrong-key-0123456789']);
    await c.query('select app.decrypt_pii($1)', [cipher]);
  }), /Wrong key or corrupt data/i);
});

test('PII key is not persisted in the database', async () => {
  const { rows } = await pool.query(`
    select 1 from pg_db_role_setting where array_to_string(setconfig, ',') like '%app.pii_key%'`);
  assert.equal(rows.length, 0);
  const { rows: [r] } = await pool.query("select current_setting('app.pii_key', true) as k");
  assert.ok(r.k === null || r.k === '');
});
