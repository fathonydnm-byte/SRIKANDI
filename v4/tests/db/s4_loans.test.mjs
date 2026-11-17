import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createS2Fixture, expectCode, newPool, owner, rpc } from './s2_fixture.mjs';
import { asUser, expectSqlError } from './helpers.mjs';

const pool = newPool();
let fx;
const date = '2026-01-01';
const b = (n) => `LOAN-B-${fx.tag}-${n}`;
const i = (n, m) => `LOAN-I-${fx.tag}-${n}-${m}`;
const choice = (n, items = []) => ({ berkas_id: b(n), item_ids: items.map((m) => i(n, m)) });
const defaults = () => ({
  p_unit_id: fx.unit.A, p_request_id: randomUUID(), p_borrower: { name: 'Uji Peminjam', position: 'Staf', unit: 'Unit',
    officer_name: 'Petugas Uji', officer_position: 'Arsiparis' },
  p_choices: JSON.stringify([choice(1)]), p_borrowed_on: date, p_due_on: date, p_condition: 'BAIK', p_purpose: 'Uji', p_notes: '', p_page_count: 4,
});
const create = (choices, over = {}, who = 'adminA') =>
  rpc(pool, fx.user[who], 'loan_create', { ...defaults(), p_choices: JSON.stringify(choices), ...over });
const read = (who = 'adminA', unit = null, status = 'ACTIVE') =>
  rpc(pool, fx.user[who], 'loan_list', { p_unit_id: unit, p_status: status, p_offset: 0 });
const returnLoan = (id, over = {}) => rpc(pool, fx.user.adminA, 'loan_return', {
  p_unit_id: fx.unit.A, p_loan_id: id, p_request_id: randomUUID(), p_returned_on: date, p_condition: 'BAIK',
  p_officer: { name: 'Petugas Uji', position: 'Arsiparis' }, p_notes: '', ...over,
});
const statusOf = (n) => owner(pool, 'select id,status_peminjaman from public.item where unit_id=$1 and berkas_id=$2 order by id', [fx.unit.A,b(n)]);

before(async () => {
  fx = await createS2Fixture(pool);
  for (let n = 1; n <= 5; n++) {
    await owner(pool, `insert into public.berkas (unit_id,id,no_berkas_definitif,judul_berkas,status_berkas,no_folder)
      values ($1,$2,$3::integer,$2,'AKTIF',($3::integer)::text)`, [n === 5 ? fx.unit.B : fx.unit.A, b(n), n]);
    for (const m of [1, 2]) await owner(pool, `insert into public.item (unit_id,id,berkas_id,no_item_definitif,uraian_lengkap,jumlah_halaman)
      values ($1,$2,$3,$4,$2,2)`, [n === 5 ? fx.unit.B : fx.unit.A, i(n,m), b(n), m]);
  }
});
after(() => pool.end());

test('one multi-berkas transaction is listed and counted once, replay is safe and return releases all objects', async () => {
  const request = randomUUID();
  const selection = [choice(1), choice(2,[1])];
  const saved = await create(selection, { p_request_id: request });
  const replay = await create(selection, { p_request_id: request });
  assert.equal(replay.id,saved.id);
  assert.equal(replay.replayed,true);
  await expectCode(create([choice(1)], { p_request_id: request }), 'IDEMPOTENCY_CONFLICT');
  const [g] = await read();
  assert.equal(g.id,saved.id);
  assert.equal(g.objects.length,2);
  assert.deepEqual((await statusOf(1)).map(x => x.status_peminjaman),['DIPINJAM DALAM BERKAS','DIPINJAM DALAM BERKAS']);
  assert.deepEqual((await statusOf(2)).map(x => x.status_peminjaman),['DIPINJAM','TERSEDIA']);
  const db = await rpc(pool, fx.user.pimpinanA, 'dashboard_overview', {});
  assert.equal(db.counts.sedang_dipinjam,1);
  await expectCode(create([choice(1,[1])]), 'OBJECT_BORROWED');
  await expectCode(create([choice(2)]), 'OBJECT_BORROWED');
  const other = await create([choice(2,[2])]);
  await returnLoan(saved.id);
  assert.deepEqual((await statusOf(1)).map(x => x.status_peminjaman),['TERSEDIA','TERSEDIA']);
  assert.deepEqual((await statusOf(2)).map(x => x.status_peminjaman),['TERSEDIA','DIPINJAM']);
  assert.equal((await read('adminA', null, 'RETURNED'))[0].id,saved.id);
  await returnLoan(other.id);
});

test('cross-unit access, read-only role and direct access to borrower columns are rejected', async () => {
  await expectCode(read('petugasB',fx.unit.A),'FORBIDDEN_UNIT');
  await expectCode(read('pimpinanA'),'FORBIDDEN_ROLE');
  await expectCode(read('pusat'),'UNIT_REQUIRED');
  await expectCode(create([choice(5)]),'NOT_FOUND');
  assert.deepEqual(await read('petugasB'),[]);
  await asUser(pool,fx.user.adminA,(c) => expectSqlError(c.query('select borrower_identity_enc from public.loan_groups')));
});

test('invalid mixed selection rolls back; concurrent whole vs item loans have just one winner', async () => {
  await expectCode(create([choice(3),choice(5)]),'NOT_FOUND');
  assert.deepEqual((await statusOf(3)).map(x => x.status_peminjaman),['TERSEDIA','TERSEDIA']);
  await expectCode(create([choice(3,[1]),choice(3)]),'INVALID_INPUT');
  const r = await Promise.allSettled([create([choice(3)]),create([choice(3,[1])],{},'petugasA2')]);
  assert.equal(r.filter(x => x.status === 'fulfilled').length,1);
  assert.equal(r.find(x => x.status === 'rejected').reason.hint,'OBJECT_BORROWED');
  await returnLoan(r.find(x => x.status === 'fulfilled').value.id);
});

test('optional identity and contact encrypted by server; omitted from the read RPC', async () => {
  const c = await pool.connect();
  const key = 'fixture-for-loan-pii-000000000000000000';
  const data = defaults();
  data.p_borrower.identity = '0000111122223333';
  data.p_borrower.whatsapp = '+628000000000';
  try {
    await c.query('begin');
    await c.query("select set_config('app.secret.LOAN_PII_KEY',$1,true)",[key]);
    await c.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({ sub:fx.user.adminA, role:'authenticated' })]);
    await c.query('set local role authenticated');
    const { rows:[{ r }] } = await c.query(
      'select public.loan_create($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) r',
      [data.p_unit_id,data.p_request_id,data.p_borrower,JSON.stringify([choice(4)]),date,date,'BAIK','Uji','',4]);
    await c.query('reset role');
    const { rows:[v] } = await c.query(`select extensions.pgp_sym_decrypt(borrower_identity_enc,$2) as identity,
      extensions.pgp_sym_decrypt(borrower_whatsapp_enc,$2) as whatsapp from public.loan_groups where id=$1`,[r.id,key]);
    assert.deepEqual(v,{ identity:data.p_borrower.identity, whatsapp:data.p_borrower.whatsapp });
    await c.query('set local role authenticated');
    const { rows:[{ l }] } = await c.query("select public.loan_list($1,'ACTIVE',0) l",[fx.unit.A]);
    assert.ok(l.some(x => x.id === r.id));
    assert.doesNotMatch(JSON.stringify(l),/0000111122223333|628000000000|borrower_identity|borrower_whatsapp/);
  } finally {
    await c.query('rollback');
    c.release();
  }
});
