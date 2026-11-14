// Sprint 3 — Cermin & Backup (0022_s3_backup.sql): nonce replay protection, service-only
// run recording, RLS on backup_runs, backup_status (warnings, scoping), and that the service
// role can read every table the export API is allowed to serve.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { newPool, rpc, expectCode, owner, createS2Fixture } from './s2_fixture.mjs';
import { asUser, asAnon, asService, expectSqlError } from './helpers.mjs';

let pool;
let fx;
const nonce = () => randomUUID().replace(/-/g, '');
const svc = (fn, args) => rpc(pool, null, fn, args, { role: 'service_role' });
const begin = (kind, unit) => svc('job_run_begin', { p_kind: kind, p_unit_id: unit });
const finish = (id, status = 'SUCCESS', over = {}) => svc('job_run_finish', {
  p_run_id: id, p_status: status, p_stats: { total_rows: 12, tables: { item: 10, berkas: 2 } },
  p_mirror_url: null, p_mirror_file_id: null, p_backup_file_id: null, p_error: null, ...over });
const status = (uid, unit) => rpc(pool, uid, 'backup_status', unit === undefined ? {} : { p_unit_id: unit });
const unitRow = (st, id) => st.units.find((u) => u.unit_id === id);
/** Put run timestamps in the past (the migration owner may; clients and service_role may not). */
const backdate = (id, hoursAgo) => owner(pool,
  "update public.backup_runs set started_at = now() - make_interval(hours => $2), finished_at = case when finished_at is null then null else now() - make_interval(hours => $2) end where id = $1",
  [id, hoursAgo]);

before(async () => {
  pool = newPool();
  fx = await createS2Fixture(pool);
});
after(async () => { await pool.end(); });

test('job_nonce_record: first use true, replay false, malformed refused', async () => {
  const n = nonce();
  assert.equal(await svc('job_nonce_record', { p_nonce: n, p_action: 'TABLE_PAGE' }), true);
  assert.equal(await svc('job_nonce_record', { p_nonce: n, p_action: 'TABLE_PAGE' }), false);
  assert.equal(await svc('job_nonce_record', { p_nonce: n, p_action: 'LIST_UNITS' }), false, 'same nonce, other action, still a replay');
  await expectCode(svc('job_nonce_record', { p_nonce: 'short', p_action: 'TABLE_PAGE' }), 'INVALID_INPUT');
  await expectCode(svc('job_nonce_record', { p_nonce: nonce(), p_action: 'drop table' }), 'INVALID_INPUT');
});

test('job_nonce_record: rows older than one hour are pruned on the next call', async () => {
  const old = nonce();
  await svc('job_nonce_record', { p_nonce: old, p_action: 'LIST_UNITS' });
  await owner(pool, "update public.job_nonces set seen_at = now() - interval '2 hours' where nonce = $1", [old]);
  await svc('job_nonce_record', { p_nonce: nonce(), p_action: 'LIST_UNITS' });
  const rows = await owner(pool, 'select 1 from public.job_nonces where nonce = $1', [old]);
  assert.equal(rows.length, 0);
});

test('concurrent use of one nonce: exactly one caller wins', async () => {
  const n = nonce();
  const results = await Promise.all(Array.from({ length: 6 }, () => svc('job_nonce_record', { p_nonce: n, p_action: 'TABLE_PAGE' })));
  assert.equal(results.filter(Boolean).length, 1);
});

test('the service RPCs and the tables are unreachable for anon and authenticated', async () => {
  const run = await begin('MIRROR', fx.unit.A);
  for (const who of [fx.user.adminA, fx.user.pusat, null]) {
    await expectSqlError(rpc(pool, who, 'job_nonce_record', { p_nonce: nonce(), p_action: 'TABLE_PAGE' }));
    await expectSqlError(rpc(pool, who, 'job_run_begin', { p_kind: 'MIRROR', p_unit_id: fx.unit.A }));
    await expectSqlError(rpc(pool, who, 'job_run_finish', { p_run_id: run, p_status: 'SUCCESS', p_stats: {}, p_mirror_url: null, p_mirror_file_id: null, p_backup_file_id: null, p_error: null }));
  }
  await expectSqlError(rpc(pool, null, 'backup_status', {}));
  // direct table writes by service_role are not possible either (only through the RPCs)
  await expectSqlError(asService(pool, (c) => c.query("insert into public.backup_runs (kind) values ('MIRROR')")));
  await expectSqlError(asService(pool, (c) => c.query('delete from public.job_nonces')));
  await expectSqlError(asService(pool, (c) => c.query('select * from public.job_nonces')));
  await asUser(pool, fx.user.pusat, async (c) => {
    await c.query('savepoint s');
    await expectSqlError(c.query('select * from public.job_nonces'));
    await c.query('rollback to savepoint s');
    await expectSqlError(c.query("insert into public.backup_runs (kind) values ('MIRROR')"));
  });
  await asAnon(pool, async (c) => { await expectSqlError(c.query('select * from public.backup_runs')); });
});

test('run lifecycle: begin -> finish, idempotent for the same status, conflicting finish refused', async () => {
  const id = await begin('BACKUP', fx.unit.A);
  const [r0] = await owner(pool, 'select * from public.backup_runs where id = $1', [id]);
  assert.equal(r0.status, 'RUNNING');
  assert.equal(r0.finished_at, null);
  const url = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit';
  const out = await finish(id, 'SUCCESS', { p_mirror_url: url, p_mirror_file_id: '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', p_backup_file_id: 'folderIdAbCdEfGh0123456789' });
  assert.deepEqual({ ok: out.ok, status: out.status, replayed: out.replayed }, { ok: true, status: 'SUCCESS', replayed: false });
  const [r1] = await owner(pool, 'select * from public.backup_runs where id = $1', [id]);
  assert.equal(r1.status, 'SUCCESS');
  assert.ok(r1.finished_at);
  assert.equal(r1.mirror_url, url);
  assert.deepEqual(r1.stats, { total_rows: 12, tables: { item: 10, berkas: 2 } });
  assert.equal((await finish(id, 'SUCCESS')).replayed, true);
  await expectCode(finish(id, 'FAILED'), 'RUN_FINISHED');
  await expectCode(finish(randomUUID()), 'NOT_FOUND');
  await expectCode(finish(await begin('BACKUP', fx.unit.A), 'RUNNING'), 'INVALID_INPUT');
  await expectCode(svc('job_run_begin', { p_kind: 'DROP', p_unit_id: fx.unit.A }), 'INVALID_INPUT');
  await expectCode(svc('job_run_begin', { p_kind: 'BACKUP', p_unit_id: randomUUID() }), 'UNIT_NOT_FOUND');
});

test('run input hygiene: error text is cut to 500, non-spreadsheet URLs are refused, oversize stats refused', async () => {
  const id = await begin('MIRROR', fx.unit.A);
  await assert.rejects(finish(id, 'FAILED', { p_mirror_url: 'javascript:alert(1)' }), (e) => e.code === '23514');
  await assert.rejects(finish(id, 'FAILED', { p_mirror_url: 'https://evil.example/spreadsheets/d/1AbCdEfGhIjKlMnOpQrSt' }), (e) => e.code === '23514');
  await assert.rejects(finish(id, 'FAILED', { p_backup_file_id: "x'; drop table--" }), (e) => e.code === '23514');
  await expectCode(finish(id, 'FAILED', { p_stats: { blob: 'x'.repeat(20000) } }), 'INVALID_INPUT');
  await finish(id, 'FAILED', { p_error: 'e'.repeat(900) });
  const [r] = await owner(pool, 'select error from public.backup_runs where id = $1', [id]);
  assert.equal(r.error.length, 500);
});

test('a stale RUNNING run (> 12 h) is closed as FAILED by the next begin of the same kind and unit', async () => {
  const unit = fx.unit.B;
  const a = await begin('MIRROR', unit);
  await backdate(a, 13);
  const b = await begin('MIRROR', unit);
  const [ra] = await owner(pool, 'select status, error from public.backup_runs where id = $1', [a]);
  assert.equal(ra.status, 'FAILED');
  assert.match(ra.error, /Dihentikan/);
  const [rb] = await owner(pool, 'select status from public.backup_runs where id = $1', [b]);
  assert.equal(rb.status, 'RUNNING');
  // a recent RUNNING run of another kind is untouched
  const c = await begin('BACKUP', unit);
  await begin('BACKUP', unit);
  const [rc] = await owner(pool, 'select status from public.backup_runs where id = $1', [c]);
  assert.equal(rc.status, 'RUNNING');
});

test('RLS: ADMIN_PUSAT reads all runs (also cross-unit), ADMIN_UNIT only its unit, PETUGAS/PIMPINAN nothing', async () => {
  const ra = await begin('MIRROR', fx.unit.A);
  const rb = await begin('MIRROR', fx.unit.B);
  const rg = await begin('BACKUP', null);
  const ids = (rows) => rows.map((r) => r.id);
  await asUser(pool, fx.user.pusat, async (c) => {
    const { rows } = await c.query('select id from public.backup_runs');
    for (const id of [ra, rb, rg]) assert.ok(ids(rows).includes(id));
  });
  await asUser(pool, fx.user.adminA, async (c) => {
    const { rows } = await c.query('select id, unit_id from public.backup_runs');
    assert.ok(ids(rows).includes(ra));
    assert.ok(!ids(rows).includes(rb) && !ids(rows).includes(rg));
    assert.ok(rows.every((r) => r.unit_id === fx.unit.A));
  });
  for (const who of ['petugasA', 'pimpinanA']) {
    await asUser(pool, fx.user[who], async (c) => {
      const { rows } = await c.query('select id from public.backup_runs');
      assert.equal(rows.length, 0, who);
    });
  }
});

test('backup_status: authorisation', async () => {
  await expectCode(status(fx.user.petugasA), 'FORBIDDEN_ROLE');
  await expectCode(status(fx.user.pimpinanA), 'FORBIDDEN_ROLE');
  await expectCode(status(fx.user.adminA, fx.unit.B), 'FORBIDDEN_UNIT');
  await expectCode(status(randomUUID()), 'ACCOUNT_INACTIVE'); // a signed-in user without a profile
  await expectCode(status(fx.user.inactiveA), 'ACCOUNT_INACTIVE');
});

test('backup_status: scoping, NEVER / OK / STALE (> 36 h) / FAILED, and history', async () => {
  // a unit nobody has run yet
  const unit = randomUUID();
  await owner(pool, 'insert into public.units (id, code, name, active) values ($1, $2, $3, true)', [unit, `BK${unit.slice(0, 6)}`, 'Unit cadangan']);
  const pusat = fx.user.pusat;
  let st = await status(pusat, unit);
  assert.equal(st.stale_after_hours, 36);
  assert.equal(st.units.length, 1);
  assert.equal(st.units[0].mirror.warning, 'NEVER');
  assert.equal(st.units[0].backup.warning, 'NEVER');
  assert.equal(st.units[0].mirror.last_success_at, null);

  // fresh success
  const ok = await begin('MIRROR', unit);
  const url = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit';
  await finish(ok, 'SUCCESS', { p_mirror_url: url, p_mirror_file_id: '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789' });
  const okb = await begin('BACKUP', unit);
  await finish(okb, 'SUCCESS', { p_backup_file_id: 'backupFolderId0123456789' });
  st = await status(pusat, unit);
  assert.equal(st.units[0].mirror.warning, null);
  assert.equal(st.units[0].mirror.url, url);
  assert.equal(st.units[0].backup.backup_file_id, 'backupFolderId0123456789');
  assert.ok(st.units[0].mirror.age_hours >= 0 && st.units[0].mirror.age_hours < 1);
  assert.equal(st.units[0].mirror.stats.total_rows, 12);

  // 35 h still fine, 37 h stale
  await backdate(ok, 35);
  assert.equal((await status(pusat, unit)).units[0].mirror.warning, null);
  await backdate(ok, 37);
  const stale = (await status(pusat, unit)).units[0].mirror;
  assert.equal(stale.warning, 'STALE');
  assert.ok(stale.age_hours >= 36.9 && stale.age_hours <= 37.2, String(stale.age_hours));

  // a newer failed run turns the warning into FAILED, with its error, while the old success is still reported
  const bad = await begin('MIRROR', unit);
  await finish(bad, 'FAILED', { p_error: 'Hitungan baris tidak cocok: item' });
  let m = (await status(pusat, unit)).units[0].mirror;
  assert.equal(m.warning, 'FAILED');
  assert.equal(m.last_done.error, 'Hitungan baris tidak cocok: item');
  assert.ok(m.last_success_at);

  // a RUNNING run does not mask a failure; the next success clears it
  await begin('MIRROR', unit);
  assert.equal((await status(pusat, unit)).units[0].mirror.warning, 'FAILED');
  assert.ok((await status(pusat, unit)).units[0].mirror.running);
  const good = await begin('MIRROR', unit);
  await finish(good, 'SUCCESS', { p_mirror_url: url });
  m = (await status(pusat, unit)).units[0].mirror;
  assert.equal(m.warning, null);

  const h = (await status(pusat, unit)).history;
  assert.ok(h.length >= 4 && h.length <= 20);
  assert.ok(h.every((r) => r.unit_id === unit));
  const times = h.map((r) => r.started_at);
  assert.deepEqual(times, [...times].sort().reverse());
});

test('backup_status: ADMIN_UNIT sees only its unit; ADMIN_PUSAT without a filter sees all units plus the cross-unit row', async () => {
  await begin('BACKUP', null);
  const own = await status(fx.user.adminA);
  assert.deepEqual(own.units.map((u) => u.unit_id), [fx.unit.A]);
  assert.ok(own.history.every((r) => r.unit_id === fx.unit.A));
  assert.deepEqual((await status(fx.user.adminA, fx.unit.A)).units.map((u) => u.unit_id), [fx.unit.A]);
  const all = await status(fx.user.pusat);
  const ids = all.units.map((u) => u.unit_id);
  assert.ok(ids.includes(fx.unit.A) && ids.includes(fx.unit.B) && ids.includes(null));
  const cross = unitRow(all, null);
  assert.equal(cross.unit_code, '_PLATFORM');
  assert.equal(cross.mirror, null, 'cross-unit audit rows have a backup but no mirror');
  assert.ok(cross.backup);
});

test('service_role can read every table the export API may serve (and nothing under auth)', async () => {
  const tables = ['units', 'unit_settings', 'counters', 'klasifikasi', 'jenis_naskah', 'pegawai', 'berkas', 'item', 'penerimaan',
    'penerimaan_item', 'riwayat_nomor', 'penerimaan_cetak_log', 'folder_label_log', 'karantina', 'pembatalan_arsip', 'drive_tasks', 'audit_log'];
  for (const t of tables) {
    await asService(pool, (c) => c.query(`select * from public.${t} limit 1`));
  }
  await asService(pool, (c) => c.query('select version from public.schema_migrations_log order by version desc limit 1'));
  const [{ v }] = await owner(pool, 'select max(version) v from public.schema_migrations_log');
  assert.equal(v, '0022');
});

test('every public table is classified: exported by the backup, or deliberately excluded', async () => {
  // Keep in step with v4/web/server/jobsExport.ts (EXPORT_TABLES) and v4/tools/restore-backup. A new table must be
  // added to one of the two lists on purpose: a forgotten table would silently be missing from every backup.
  const exported = ['units', 'unit_settings', 'counters', 'klasifikasi', 'jenis_naskah', 'pegawai', 'berkas', 'item', 'penerimaan',
    'penerimaan_item', 'riwayat_nomor', 'penerimaan_cetak_log', 'folder_label_log', 'karantina', 'pembatalan_arsip', 'drive_tasks', 'audit_log'];
  const excluded = [
    'profiles',              // tied to auth.users; accounts are re-created by an admin after a disaster
    'idempotency_keys',      // request replay cache, no business data
    'upload_sessions',       // short-lived upload sessions (attestation data)
    'schema_migrations_log', // technical
    'job_nonces', 'backup_runs'];
  const rows = await owner(pool, "select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p') order by 1");
  assert.deepEqual(rows.map((r) => r.relname), [...exported, ...excluded].sort());
});
