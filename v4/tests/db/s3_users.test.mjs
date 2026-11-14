// Sprint 3 — Kelola Pengguna (0021_s3_users.sql): authorisation matrix, service-only
// writes, last-ADMIN_PUSAT invariant, self-change guard, audit, idempotency, forced
// password change.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { newPool, rpc, expectCode, owner, createS2Fixture } from './s2_fixture.mjs';
import { asUser, asAnon, expectSqlError } from './helpers.mjs';

let pool;
let fx;
let U; // extra users
const tag = randomUUID().slice(0, 6);

async function authUser(email) {
  const id = randomUUID();
  await owner(pool, 'insert into auth.users (id, email) values ($1, $2)', [id, email ?? `${id.slice(0, 8)}@uji.invalid`]);
  return id;
}
async function profile(userId, unitId, role, { active = true, name } = {}) {
  await owner(pool,
    'insert into public.profiles (user_id, unit_id, role, full_name, active) values ($1, $2, $3, $4, $5)',
    [userId, unitId, role, name ?? `Uji ${role}`, active]);
}

const authorize = (uid, action, target, unit, role) =>
  rpc(pool, uid, 'user_admin_authorize', {
    p_action: action, p_target_user_id: target ?? null, p_target_unit_id: unit ?? null, p_target_role: role ?? null });
const list = (uid, unit) => rpc(pool, uid, 'user_list', unit === undefined ? {} : { p_unit_id: unit });
/** user_profile_upsert_service exactly as the Pages Function would call it (service_role). */
const svc = (a) => rpc(pool, null, 'user_profile_upsert_service', {
  p_actor: null, p_user_id: null, p_email: null, p_full_name: null, p_role: null, p_unit_id: null, p_active: null,
  p_must_change: null, p_request_id: randomUUID(), ...a }, { role: 'service_role' });
const prof = async (id) => (await owner(pool, 'select * from public.profiles where user_id = $1', [id]))[0];
const audits = (id) => owner(pool, "select * from public.audit_log where module = 'PENGGUNA' and object_id = $1 order by occurred_at, id", [id]);

before(async () => {
  pool = newPool();
  fx = await createS2Fixture(pool);
  U = {
    pusat2: await authUser(), adminA2: await authUser(), adminB: await authUser(), unitC: randomUUID(),
    pimpinanB: await authUser(), noProfile: await authUser()
  };
  await owner(pool, 'insert into public.units (id, code, name, active) values ($1, $2, $3, false)', [U.unitC, `S3U${tag}C`, 'Unit C nonaktif']);
  await profile(U.pusat2, null, 'ADMIN_PUSAT');
  await profile(U.adminA2, fx.unit.A, 'ADMIN_UNIT');
  await profile(U.adminB, fx.unit.B, 'ADMIN_UNIT');
  await profile(U.pimpinanB, fx.unit.B, 'PIMPINAN');
});
after(async () => { await pool.end(); });

// ---------------------------------------------------------------------------
test('ADMIN_UNIT: may create/manage only PETUGAS and PIMPINAN of its OWN unit', async () => {
  const a = fx.user.adminA;
  for (const role of ['PETUGAS', 'PIMPINAN']) {
    const ok = await authorize(a, 'create', null, fx.unit.A, role);
    assert.deepEqual(ok, { ok: true, actor_id: a });
  }
  // forbidden: roles above
  await expectCode(authorize(a, 'create', null, fx.unit.A, 'ADMIN_UNIT'), 'FORBIDDEN_TARGET_ROLE');
  await expectCode(authorize(a, 'create', null, fx.unit.A, 'ADMIN_PUSAT'), 'FORBIDDEN_TARGET_ROLE');
  await expectCode(authorize(a, 'create', null, null, 'ADMIN_PUSAT'), 'FORBIDDEN_TARGET_ROLE');
  // forbidden: another unit (also an inactive/unknown one)
  await expectCode(authorize(a, 'create', null, fx.unit.B, 'PETUGAS'), 'FORBIDDEN_UNIT');
  await expectCode(authorize(a, 'create', null, U.unitC, 'PETUGAS'), 'FORBIDDEN_UNIT');
  await expectCode(authorize(a, 'create', null, null, 'PETUGAS'), 'UNIT_REQUIRED');
  await expectCode(authorize(a, 'create', null, fx.unit.A, 'SUPERUSER'), 'INVALID_INPUT');
  await expectCode(authorize(a, 'create', null, fx.unit.A, null), 'INVALID_INPUT');
  await expectCode(authorize(a, 'hapus', fx.user.petugasA), 'INVALID_INPUT');
  await expectCode(authorize(a, null, fx.user.petugasA), 'INVALID_INPUT');

  // manage own-unit PETUGAS/PIMPINAN: every action allowed
  for (const target of [fx.user.petugasA, fx.user.pimpinanA]) {
    for (const action of ['update', 'deactivate', 'reactivate', 'reset_password']) {
      assert.equal((await authorize(a, action, target)).ok, true, `${action} ${target}`);
    }
  }
  assert.equal((await authorize(a, 'update', fx.user.petugasA, fx.unit.A, 'PIMPINAN')).ok, true);

  // forbidden: another unit's users are not even revealed, nor is the ADMIN_PUSAT
  for (const action of ['update', 'deactivate', 'reactivate', 'reset_password']) {
    await expectCode(authorize(a, action, fx.user.petugasB), 'NOT_FOUND');
    await expectCode(authorize(a, action, U.pimpinanB), 'NOT_FOUND');
    await expectCode(authorize(a, action, U.adminB), 'NOT_FOUND');
    await expectCode(authorize(a, action, fx.user.pusat), 'NOT_FOUND');
    await expectCode(authorize(a, action, randomUUID()), 'NOT_FOUND');
  }
  // forbidden: peer admin of the same unit
  for (const action of ['update', 'deactivate', 'reactivate', 'reset_password']) {
    await expectCode(authorize(a, action, U.adminA2), 'FORBIDDEN_TARGET');
  }
  // forbidden: promote/move
  await expectCode(authorize(a, 'update', fx.user.petugasA, null, 'ADMIN_UNIT'), 'FORBIDDEN_TARGET_ROLE');
  await expectCode(authorize(a, 'update', fx.user.petugasA, null, 'ADMIN_PUSAT'), 'FORBIDDEN_TARGET_ROLE');
  await expectCode(authorize(a, 'update', fx.user.petugasA, fx.unit.B, null), 'FORBIDDEN_UNIT');
  // forbidden: itself
  await expectCode(authorize(a, 'deactivate', a), 'FORBIDDEN_SELF');
  await expectCode(authorize(a, 'reactivate', a), 'FORBIDDEN_SELF');
  await expectCode(authorize(a, 'reset_password', a), 'FORBIDDEN_SELF');
  await expectCode(authorize(a, 'update', a, null, 'PETUGAS'), 'FORBIDDEN_SELF');
  await expectCode(authorize(a, 'update', a, fx.unit.B, null), 'FORBIDDEN_SELF');
  await expectCode(authorize(a, 'update', a), 'FORBIDDEN_TARGET'); // not even renaming itself
});

test('PETUGAS, PIMPINAN, inactive and anonymous callers are refused for every action', async () => {
  for (const who of [fx.user.petugasA, fx.user.pimpinanA, fx.user.petugasB]) {
    for (const action of ['create', 'update', 'deactivate', 'reactivate', 'reset_password']) {
      await expectCode(authorize(who, action, fx.user.petugasA2, fx.unit.A, 'PETUGAS'), 'FORBIDDEN_ROLE');
    }
    await expectCode(list(who), 'FORBIDDEN_ROLE');
  }
  await expectCode(authorize(fx.user.inactiveA, 'create', null, fx.unit.A, 'PETUGAS'), 'ACCOUNT_INACTIVE');
  await expectCode(authorize(U.noProfile, 'create', null, fx.unit.A, 'PETUGAS'), 'ACCOUNT_INACTIVE');
  await expectCode(list(fx.user.inactiveA), 'ACCOUNT_INACTIVE');
  // authenticated without a user id in the token
  await expectCode(rpc(pool, null, 'user_admin_authorize', { p_action: 'create', p_target_user_id: null, p_target_unit_id: fx.unit.A, p_target_role: 'PETUGAS' }, { role: 'authenticated' }), 'AUTH_REQUIRED');
  // anon: no EXECUTE at all
  await expectCode(authorize(null, 'create', null, fx.unit.A, 'PETUGAS'), '42501');
  await expectCode(list(null), '42501');
  await expectCode(rpc(pool, null, 'password_changed', {}), '42501');
  // service_role holds no grant on the gate / read / password RPCs either
  await expectCode(rpc(pool, null, 'user_admin_authorize', { p_action: 'create', p_target_user_id: null, p_target_unit_id: fx.unit.A, p_target_role: 'PETUGAS' }, { role: 'service_role' }), '42501');
});

test('ADMIN_PUSAT: any role, any unit; but not itself', async () => {
  const p = fx.user.pusat;
  for (const [unit, role] of [[fx.unit.A, 'PETUGAS'], [fx.unit.B, 'PIMPINAN'], [fx.unit.B, 'ADMIN_UNIT'], [null, 'ADMIN_PUSAT']]) {
    assert.equal((await authorize(p, 'create', null, unit, role)).ok, true, `${role}`);
  }
  await expectCode(authorize(p, 'create', null, fx.unit.A, 'ADMIN_PUSAT'), 'INVALID_INPUT'); // pusat has no unit
  await expectCode(authorize(p, 'create', null, null, 'ADMIN_UNIT'), 'UNIT_REQUIRED');
  await expectCode(authorize(p, 'create', null, U.unitC, 'PETUGAS'), 'UNIT_NOT_FOUND'); // inactive unit
  await expectCode(authorize(p, 'create', null, randomUUID(), 'PETUGAS'), 'UNIT_NOT_FOUND');
  for (const target of [fx.user.adminA, fx.user.petugasB, U.adminB, U.pusat2, fx.user.pimpinanA]) {
    for (const action of ['update', 'deactivate', 'reactivate', 'reset_password']) {
      assert.equal((await authorize(p, action, target)).ok, true, `${action}`);
    }
  }
  assert.equal((await authorize(p, 'update', fx.user.petugasA, fx.unit.B, 'ADMIN_UNIT')).ok, true);
  assert.equal((await authorize(p, 'update', fx.user.petugasA, null, 'ADMIN_PUSAT')).ok, true); // unit is then cleared
  await expectCode(authorize(p, 'update', fx.user.petugasA, fx.unit.A, 'ADMIN_PUSAT'), 'INVALID_INPUT');
  await expectCode(authorize(p, 'update', U.pusat2, null, 'PETUGAS'), 'UNIT_REQUIRED');
  assert.equal((await authorize(p, 'update', U.pusat2, fx.unit.A, 'PETUGAS')).ok, true); // another pusat remains active
  // itself: no deactivate, role change or password reset; renaming is fine
  await expectCode(authorize(p, 'deactivate', p), 'FORBIDDEN_SELF');
  await expectCode(authorize(p, 'reset_password', p), 'FORBIDDEN_SELF');
  await expectCode(authorize(p, 'update', p, fx.unit.A, 'PETUGAS'), 'FORBIDDEN_SELF');
  await expectCode(authorize(p, 'update', p, fx.unit.A, null), 'FORBIDDEN_SELF');
  assert.equal((await authorize(p, 'update', p, null, 'ADMIN_PUSAT')).ok, true);
  assert.equal((await authorize(p, 'update', p)).ok, true);
});

test('user_profile_upsert_service / app helpers: service_role only', async () => {
  const args = { p_actor: fx.user.pusat, p_user_id: fx.user.petugasA, p_full_name: 'Nama Baru' };
  await expectCode(rpc(pool, fx.user.pusat, 'user_profile_upsert_service', { p_actor: fx.user.pusat, p_user_id: fx.user.petugasA, p_email: null, p_full_name: 'X', p_role: null, p_unit_id: null, p_active: null, p_must_change: null, p_request_id: randomUUID() }), '42501');
  await expectCode(rpc(pool, fx.user.adminA, 'user_profile_upsert_service', { p_actor: fx.user.adminA, p_user_id: fx.user.petugasA, p_email: null, p_full_name: 'X', p_role: null, p_unit_id: null, p_active: null, p_must_change: null, p_request_id: randomUUID() }), '42501');
  await expectCode(rpc(pool, null, 'user_profile_upsert_service', { p_actor: fx.user.pusat, p_user_id: fx.user.petugasA, p_email: null, p_full_name: 'X', p_role: null, p_unit_id: null, p_active: null, p_must_change: null, p_request_id: randomUUID() }), '42501');
  assert.equal((await prof(fx.user.petugasA)).full_name, 'Petugas uji PETUGAS');
  // private helpers cannot be reached through SQL by clients either
  await asUser(pool, fx.user.pusat, async (c) => {
    await c.query('savepoint s');
    await expectSqlError(c.query('select app.user_admin_check($1, $2, null, null, $3)', [fx.user.pusat, 'create', 'PETUGAS']));
    await c.query('rollback to savepoint s');
    await expectSqlError(c.query('select app.pw_fingerprint($1)', [fx.user.pusat]));
    await c.query('rollback to savepoint s');
    // columns added by 0021 are still write-protected
    await expectSqlError(c.query('update public.profiles set must_change_password = false where user_id = $1', [fx.user.petugasA]));
    await c.query('rollback to savepoint s');
    await expectSqlError(c.query('update public.profiles set role = $2 where user_id = $1', [fx.user.petugasA, 'ADMIN_PUSAT']));
  });
  await asAnon(pool, async (c) => {
    await expectSqlError(c.query('select app.user_admin_check($1, $2, null, null, $3)', [fx.user.pusat, 'create', 'PETUGAS']));
  });
  void args;
});

test('service create: profile, email snapshot, must_change, audit row by the actor; replay is idempotent', async () => {
  const id = await authUser(`budi.${tag}@uji.invalid`);
  const req = randomUUID();
  const call = (extra = {}) => svc({
    p_actor: fx.user.adminA, p_user_id: id, p_email: `budi.${tag}@uji.invalid`, p_full_name: '  Budi   Santoso ',
    p_role: 'PETUGAS', p_unit_id: fx.unit.A, p_must_change: true, p_request_id: req, ...extra });
  const r = await call();
  assert.deepEqual([r.ok, r.created, r.replayed, r.role, r.unit_id, r.active, r.must_change_password],
    [true, true, false, 'PETUGAS', fx.unit.A, true, true]);
  const p = await prof(id);
  assert.deepEqual([p.full_name, p.email, p.must_change_password, p.active, p.role, p.unit_id],
    ['Budi Santoso', `budi.${tag}@uji.invalid`, true, true, 'PETUGAS', fx.unit.A]);
  const [a] = await audits(id);
  assert.deepEqual([a.action, a.module, a.object_type, a.actor_user_id, a.unit_id, a.request_id, a.result],
    ['USER_CREATE', 'PENGGUNA', 'PROFILE', fx.user.adminA, fx.unit.A, req, 'SUCCESS']);
  assert.match(a.summary, /Budi Santoso/);
  assert.equal(JSON.stringify(a).includes('must_change_fp'), false);

  const again = await call();
  assert.equal(again.replayed, true);
  assert.equal(again.user_id, id);
  assert.equal((await audits(id)).length, 1);
  assert.equal((await owner(pool, 'select count(*)::int n from public.profiles where user_id = $1', [id]))[0].n, 1);
  // same request id, different content or other actor: conflict, nothing changes
  await expectCode(call({ p_full_name: 'Orang Lain' }), 'IDEMPOTENCY_CONFLICT');
  await expectCode(call({ p_actor: fx.user.pusat }), 'IDEMPOTENCY_CONFLICT');
  assert.equal((await prof(id)).full_name, 'Budi Santoso');
  await expectCode(svc({ p_actor: fx.user.adminA, p_user_id: id, p_request_id: null }), 'INVALID_INPUT');
});

test('service re-validates every rule for p_actor itself (never trusts the caller)', async () => {
  const mk = async () => authUser();
  // ADMIN_UNIT creating the forbidden things directly through the service function
  for (const [unit, role, code] of [
    [fx.unit.A, 'ADMIN_UNIT', 'FORBIDDEN_TARGET_ROLE'], [fx.unit.A, 'ADMIN_PUSAT', 'FORBIDDEN_TARGET_ROLE'],
    [null, 'ADMIN_PUSAT', 'FORBIDDEN_TARGET_ROLE'], [fx.unit.B, 'PETUGAS', 'FORBIDDEN_UNIT'], [null, 'PETUGAS', 'UNIT_REQUIRED']]) {
    const id = await mk();
    await expectCode(svc({ p_actor: fx.user.adminA, p_user_id: id, p_full_name: 'Tidak Boleh', p_role: role, p_unit_id: unit, p_must_change: true }), code);
    assert.equal(await prof(id), undefined, `${role}/${unit} must not create a profile`);
    assert.equal((await audits(id)).length, 0);
  }
  // wrong kinds of actor
  const id = await mk();
  for (const [actor, code] of [[fx.user.petugasA, 'FORBIDDEN_ROLE'], [fx.user.pimpinanA, 'FORBIDDEN_ROLE'],
    [fx.user.inactiveA, 'ACCOUNT_INACTIVE'], [U.noProfile, 'ACCOUNT_INACTIVE'], [randomUUID(), 'ACCOUNT_INACTIVE']]) {
    await expectCode(svc({ p_actor: actor, p_user_id: id, p_full_name: 'X', p_role: 'PETUGAS', p_unit_id: fx.unit.A, p_must_change: true }), code);
  }
  await expectCode(svc({ p_actor: null, p_user_id: id, p_full_name: 'X', p_role: 'PETUGAS', p_unit_id: fx.unit.A }), 'INVALID_INPUT');
  assert.equal(await prof(id), undefined);
  // input validation
  await expectCode(svc({ p_actor: fx.user.adminA, p_user_id: id, p_full_name: '   ', p_role: 'PETUGAS', p_unit_id: fx.unit.A, p_must_change: true }), 'INVALID_INPUT');
  await expectCode(svc({ p_actor: fx.user.adminA, p_user_id: id, p_full_name: 'A', p_role: 'PETUGAS', p_unit_id: fx.unit.A, p_must_change: false }), 'INVALID_INPUT');
  await expectCode(svc({ p_actor: fx.user.adminA, p_user_id: id, p_full_name: 'A', p_role: 'PETUGAS', p_unit_id: fx.unit.A, p_active: false, p_must_change: true }), 'INVALID_INPUT');
  await expectCode(svc({ p_actor: fx.user.adminA, p_user_id: id, p_full_name: 'A', p_role: 'RAJA', p_unit_id: fx.unit.A, p_must_change: true }), 'INVALID_INPUT');
  await expectCode(svc({ p_actor: fx.user.adminA, p_user_id: randomUUID(), p_full_name: 'A', p_role: 'PETUGAS', p_unit_id: fx.unit.A, p_must_change: true }), 'AUTH_USER_MISSING');
  assert.equal(await prof(id), undefined);

  // existing users: ADMIN_UNIT cannot touch other units, admins, pusat, itself
  const before = await prof(fx.user.petugasB);
  for (const target of [fx.user.petugasB, U.adminB, fx.user.pusat]) {
    await expectCode(svc({ p_actor: fx.user.adminA, p_user_id: target, p_full_name: 'Diretas', p_active: false }), 'NOT_FOUND');
  }
  await expectCode(svc({ p_actor: fx.user.adminA, p_user_id: U.adminA2, p_full_name: 'Diretas' }), 'FORBIDDEN_TARGET');
  await expectCode(svc({ p_actor: fx.user.adminA, p_user_id: U.adminA2, p_active: false }), 'FORBIDDEN_TARGET');
  await expectCode(svc({ p_actor: fx.user.adminA, p_user_id: fx.user.adminA, p_active: false }), 'FORBIDDEN_SELF');
  await expectCode(svc({ p_actor: fx.user.adminA, p_user_id: fx.user.adminA, p_role: 'PETUGAS', p_unit_id: fx.unit.A }), 'FORBIDDEN_SELF');
  await expectCode(svc({ p_actor: fx.user.adminA, p_user_id: fx.user.petugasA, p_role: 'ADMIN_UNIT', p_unit_id: fx.unit.A }), 'FORBIDDEN_TARGET_ROLE');
  await expectCode(svc({ p_actor: fx.user.adminA, p_user_id: fx.user.petugasA, p_unit_id: fx.unit.B }), 'FORBIDDEN_UNIT');
  await expectCode(svc({ p_actor: fx.user.petugasA, p_user_id: fx.user.petugasA2, p_active: false }), 'FORBIDDEN_ROLE');
  await expectCode(svc({ p_actor: fx.user.pusat, p_user_id: fx.user.pusat, p_active: false }), 'FORBIDDEN_SELF');
  await expectCode(svc({ p_actor: fx.user.pusat, p_user_id: fx.user.pusat, p_role: 'PETUGAS', p_unit_id: fx.unit.A }), 'FORBIDDEN_SELF');
  await expectCode(svc({ p_actor: fx.user.pusat, p_user_id: fx.user.pusat, p_must_change: true }), 'FORBIDDEN_SELF');
  assert.deepEqual(await prof(fx.user.petugasB), before);
  assert.equal((await prof(fx.user.petugasA)).role, 'PETUGAS');
  assert.equal((await prof(fx.user.adminA)).active, true);
  assert.equal((await prof(fx.user.pusat)).active, true);
});

test('service update: rename, role, move unit, deactivate/reactivate, reset password, no-op; one audit row each', async () => {
  const id = await authUser();
  await svc({ p_actor: fx.user.pusat, p_user_id: id, p_full_name: 'Citra Dewi', p_role: 'PETUGAS', p_unit_id: fx.unit.A, p_must_change: true });
  await owner(pool, 'update public.profiles set must_change_password = false where user_id = $1', [id]); // as if she changed it

  const rename = await svc({ p_actor: fx.user.adminA, p_user_id: id, p_full_name: 'Citra Dewi Lestari', p_role: 'PIMPINAN' });
  assert.deepEqual([rename.created, rename.changed, rename.role], [false, true, 'PIMPINAN']);
  assert.equal((await prof(id)).full_name, 'Citra Dewi Lestari');

  const off = await svc({ p_actor: fx.user.adminA, p_user_id: id, p_active: false });
  assert.equal(off.active, false);
  const on = await svc({ p_actor: fx.user.adminA, p_user_id: id, p_active: true });
  assert.equal(on.active, true);

  const reset = await svc({ p_actor: fx.user.adminA, p_user_id: id, p_must_change: true });
  assert.equal(reset.must_change_password, true);
  assert.equal((await prof(id)).must_change_password, true);

  const noop = await svc({ p_actor: fx.user.adminA, p_user_id: id, p_full_name: 'Citra Dewi Lestari' });
  assert.equal(noop.changed, false);

  assert.deepEqual((await audits(id)).map((a) => a.action),
    ['USER_CREATE', 'USER_UPDATE', 'USER_DEACTIVATE', 'USER_REACTIVATE', 'USER_RESET_PASSWORD']);
  const [, upd] = await audits(id);
  assert.equal(upd.before_data.role, 'PETUGAS');
  assert.equal(upd.after_data.profile.role, 'PIMPINAN');

  // ADMIN_PUSAT: move across units, promote (unit cleared), demote needs a unit
  const moved = await svc({ p_actor: fx.user.pusat, p_user_id: id, p_unit_id: fx.unit.B });
  assert.equal(moved.unit_id, fx.unit.B);
  const up = await svc({ p_actor: fx.user.pusat, p_user_id: id, p_role: 'ADMIN_PUSAT' });
  assert.deepEqual([up.role, up.unit_id], ['ADMIN_PUSAT', null]);
  await expectCode(svc({ p_actor: fx.user.pusat, p_user_id: id, p_role: 'PETUGAS' }), 'UNIT_REQUIRED');
  const down = await svc({ p_actor: fx.user.pusat, p_user_id: id, p_role: 'PETUGAS', p_unit_id: fx.unit.A });
  assert.deepEqual([down.role, down.unit_id], ['PETUGAS', fx.unit.A]);
  await expectCode(svc({ p_actor: fx.user.pusat, p_user_id: id, p_unit_id: U.unitC }), 'UNIT_NOT_FOUND');
  // audit rows of unit A are visible to ADMIN_UNIT A only
  const seenA = await asUser(pool, fx.user.adminA, async (c) =>
    (await c.query("select object_id from public.audit_log where module = 'PENGGUNA' and object_id = $1", [id])).rowCount);
  assert.ok(seenA >= 1);
  const seenPetugas = await asUser(pool, fx.user.petugasA, async (c) =>
    (await c.query("select 1 from public.audit_log where module = 'PENGGUNA'")).rowCount);
  assert.equal(seenPetugas, 0);
  const seenAdminB = await asUser(pool, U.adminB, async (c) =>
    (await c.query("select 1 from public.audit_log where module = 'PENGGUNA' and object_id = $1 and unit_id = $2", [id, fx.unit.A])).rowCount);
  assert.equal(seenAdminB, 0);
});

test('last ADMIN_PUSAT: the invariant survives concurrent mutual deactivation', async () => {
  const pusats = (await owner(pool, "select user_id, active from public.profiles where role = 'ADMIN_PUSAT'"));
  try {
    const keep = [fx.user.pusat, U.pusat2];
    await owner(pool, "update public.profiles set active = false where role = 'ADMIN_PUSAT' and user_id <> all($1)", [keep]);
    await owner(pool, 'update public.profiles set active = true where user_id = any($1)', [keep]);
    // alone: cannot deactivate or demote itself
    await owner(pool, 'update public.profiles set active = false where user_id = $1', [U.pusat2]);
    await expectCode(svc({ p_actor: fx.user.pusat, p_user_id: fx.user.pusat, p_active: false }), 'FORBIDDEN_SELF');
    await expectCode(svc({ p_actor: fx.user.pusat, p_user_id: fx.user.pusat, p_role: 'PETUGAS', p_unit_id: fx.unit.A }), 'FORBIDDEN_SELF');
    // no other actor can take it away: ADMIN_UNIT cannot see it, an inactive pusat cannot act
    await expectCode(svc({ p_actor: fx.user.adminA, p_user_id: fx.user.pusat, p_active: false }), 'NOT_FOUND');
    await expectCode(svc({ p_actor: U.pusat2, p_user_id: fx.user.pusat, p_active: false }), 'ACCOUNT_INACTIVE');
    // two active pusats deactivate each other at the same moment: exactly one wins
    await owner(pool, 'update public.profiles set active = true where user_id = $1', [U.pusat2]);
    const results = await Promise.allSettled([
      svc({ p_actor: fx.user.pusat, p_user_id: U.pusat2, p_active: false }),
      svc({ p_actor: U.pusat2, p_user_id: fx.user.pusat, p_active: false })]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(results.map((r) => r.reason?.hint)));
    assert.equal(results.find((r) => r.status === 'rejected').reason.hint, 'ACCOUNT_INACTIVE');
    const active = (await owner(pool, "select count(*)::int n from public.profiles where role = 'ADMIN_PUSAT' and active"))[0].n;
    assert.equal(active, 1);
    // the guard itself (belt and braces) is part of the shared rulebook: the sole active pusat is protected even from a peer
    await owner(pool, 'update public.profiles set active = true where user_id = $1', [U.pusat2]);
  } finally {
    for (const p of pusats) await owner(pool, 'update public.profiles set active = $2 where user_id = $1', [p.user_id, p.active]);
  }
});

test('user_list: ADMIN_UNIT sees its unit only; ADMIN_PUSAT all or one unit; exact fields', async () => {
  const mine = await list(fx.user.adminA);
  assert.ok(mine.length >= 4);
  assert.ok(mine.every((u) => u.unit_id === fx.unit.A));
  const keys = Object.keys(mine[0]).sort();
  assert.deepEqual(keys, ['active', 'created_at', 'email', 'full_name', 'must_change_password', 'role', 'unit_code', 'unit_id', 'unit_name', 'updated_at', 'user_id'].sort());
  assert.ok(mine.some((u) => u.user_id === fx.user.petugasA && u.role === 'PETUGAS' && u.active === true));
  assert.deepEqual((await list(fx.user.adminA, fx.unit.A)).map((u) => u.user_id), mine.map((u) => u.user_id));
  await expectCode(list(fx.user.adminA, fx.unit.B), 'FORBIDDEN_UNIT');
  const all = await list(fx.user.pusat);
  assert.ok(all.some((u) => u.unit_id === fx.unit.B) && all.some((u) => u.unit_id === fx.unit.A) && all.some((u) => u.role === 'ADMIN_PUSAT' && u.unit_id === null));
  const onlyB = await list(fx.user.pusat, fx.unit.B);
  assert.ok(onlyB.length >= 2 && onlyB.every((u) => u.unit_id === fx.unit.B));
  const names = mine.map((u) => u.full_name.toLowerCase());
  assert.deepEqual(names, [...names].sort());
});

test('forced password change: password_changed() clears the flag, only after the Auth password really changed', async () => {
  const id = await authUser();
  await svc({ p_actor: fx.user.pusat, p_user_id: id, p_full_name: 'Dani Fiktif', p_role: 'PETUGAS', p_unit_id: fx.unit.A, p_must_change: true });
  assert.equal((await prof(id)).must_change_password, true);
  // somebody without the flag / no profile / inactive
  assert.deepEqual(await rpc(pool, fx.user.petugasA2, 'password_changed', {}), { ok: true, changed: false });
  await expectCode(rpc(pool, U.noProfile, 'password_changed', {}), 'ACCOUNT_INACTIVE');
  await expectCode(rpc(pool, fx.user.inactiveA, 'password_changed', {}), 'ACCOUNT_INACTIVE');
  // Stub auth.users has no password hash: fingerprint is NULL, the flag clears
  assert.deepEqual(await rpc(pool, id, 'password_changed', {}), { ok: true, changed: true });
  const p = await prof(id);
  assert.deepEqual([p.must_change_password, p.must_change_fp], [false, null]);
  const last = (await audits(id)).at(-1);
  assert.deepEqual([last.action, last.actor_user_id], ['USER_PASSWORD_CHANGED', id]);
  assert.deepEqual(await rpc(pool, id, 'password_changed', {}), { ok: true, changed: false });
  assert.equal((await audits(id)).length, 2);

  // With a real hash column (Supabase has it; add it to the stub as superuser): the flag survives until the hash changes.
  const su = new pg.Client({ user: 'supabase_admin' });
  await su.connect();
  try {
    await su.query('alter table auth.users add column if not exists encrypted_password text');
  } finally {
    await su.end();
  }
  await owner(pool, "update auth.users set encrypted_password = 'hash-sementara' where id = $1", [id]);
  const reset = await svc({ p_actor: fx.user.adminA, p_user_id: id, p_must_change: true });
  assert.equal(reset.must_change_password, true);
  const err = await expectCode(rpc(pool, id, 'password_changed', {}), 'PASSWORD_NOT_CHANGED');
  assert.match(err.message, /belum diganti/);
  assert.equal((await prof(id)).must_change_password, true);
  await owner(pool, "update auth.users set encrypted_password = 'hash-baru' where id = $1", [id]);
  assert.deepEqual(await rpc(pool, id, 'password_changed', {}), { ok: true, changed: true });
  assert.equal((await prof(id)).must_change_password, false);
  // nobody can clear somebody else's flag: it always acts on auth.uid()
  await svc({ p_actor: fx.user.adminA, p_user_id: id, p_must_change: true });
  await owner(pool, "update auth.users set encrypted_password = 'hash-ketiga' where id = $1", [id]);
  assert.deepEqual(await rpc(pool, fx.user.adminA, 'password_changed', {}), { ok: true, changed: false });
  assert.equal((await prof(id)).must_change_password, true);
});

test('double submit: 6 identical parallel create requests make exactly one account and one audit row', async () => {
  const id = await authUser();
  const req = randomUUID();
  const run = () => svc({ p_actor: fx.user.adminA, p_user_id: id, p_email: null, p_full_name: 'Eka Paralel', p_role: 'PETUGAS', p_unit_id: fx.unit.A, p_must_change: true, p_request_id: req });
  const res = await Promise.all(Array.from({ length: 6 }, run));
  assert.equal(res.filter((r) => !r.replayed).length, 1);
  assert.ok(res.every((r) => r.user_id === id && r.created === true));
  assert.equal((await audits(id)).length, 1);
});
