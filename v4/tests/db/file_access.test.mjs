// 0008_file_access: get_file_access (INVOKER) / log_file_access (DEFINER).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { newPool, createFixture, asUser, asAnon, asService, expectSqlError } from './helpers.mjs';

const pool = newPool();
let fx;
let F; // file ids

before(async () => {
  fx = await createFixture(pool);
  const t = fx.tag;
  F = {
    itemA: `DRVITEMA${t}`, itemB: `DRVITEMB${t}`, deletedItemA: `DRVDELA${t}`, dihapusBerkasA: `DRVDIHAPUSA${t}`,
    bukti: `DRVBUKTIA${t}`, batal: `DRVBATALA${t}`, rcvi: `DRVRCVIA${t}`, pindah: `DRVPINDAHA${t}`
  };
  const { A, B } = fx.unit;
  await asService(pool, async (c) => {
    await c.query(`update public.item set drive_file_id = $1, nama_file = 'surat a.pdf', mime_type = 'application/pdf',
                   drive_file_size_bytes = 12345 where id = $2`, [F.itemA, fx.ids.A.item]);
    await c.query('update public.item set drive_file_id = $1 where id = $2', [F.itemB, fx.ids.B.item]);
    await c.query(
      `insert into public.item (id, unit_id, berkas_id, no_item_definitif, drive_file_id, is_deleted)
       values ($1, $2, $3, 2, $4, true)`, [`ITM-DEL-${t}`, A, fx.ids.A.berkas, F.deletedItemA]);
    await c.query(
      `insert into public.berkas (id, unit_id, no_berkas_definitif, judul_berkas, status_berkas, is_deleted)
       values ($1, $2, 77, 'Berkas dihapus', 'DIHAPUS', true)`, [`BRK-DEL-${t}`, A]);
    await c.query(
      `insert into public.item (id, unit_id, berkas_id, no_item_definitif, drive_file_id)
       values ($1, $2, $3, 1, $4)`, [`ITM-INDEL-${t}`, A, `BRK-DEL-${t}`, F.dihapusBerkasA]);
    await c.query('update public.penerimaan set bukti_ttd_file_id = $1, bukti_ttd_nama = $2, batal_bukti_file_id = $3 where id = $4',
      [F.bukti, 'ttd.pdf', F.batal, fx.ids.A.penerimaan]);
    await c.query('update public.penerimaan_item set file_digital_id = $1 where id = $2', [F.rcvi, fx.ids.A.penerimaanItem]);
    await c.query('update public.berkas set bukti_pemindahan_file_id = $1 where id = $2', [F.pindah, fx.ids.A.berkas]);
  });
});
after(async () => { await pool.end(); });

const access = (u, fid) => asUser(pool, fx.user[u], async (c) =>
  (await c.query('select public.get_file_access($1) a', [fid])).rows[0].a);

test('function settings and grants: INVOKER probe, DEFINER logger, authenticated only', async () => {
  const { rows } = await pool.query(
    `select p.oid::regprocedure::text sig, p.prosecdef secdef, p.proconfig cfg,
            has_function_privilege('anon', p.oid, 'EXECUTE') anon,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') auth,
            has_function_privilege('service_role', p.oid, 'EXECUTE') svc
     from pg_proc p
     where p.oid in ('public.get_file_access(text)'::regprocedure, 'public.log_file_access(text, text, text)'::regprocedure)
     order by 1`);
  assert.deepEqual(rows, [
    { sig: 'get_file_access(text)', secdef: false, cfg: ['search_path=""'], anon: false, auth: true, svc: false },
    { sig: 'log_file_access(text,text,text)', secdef: true, cfg: ['search_path=""'], anon: false, auth: true, svc: false }
  ]);
});

test('anon is denied', async () => {
  await asAnon(pool, async (c) => { await expectSqlError(c.query('select public.get_file_access($1)', [F.itemA])); });
  await asAnon(pool, async (c) => { await expectSqlError(c.query("select public.log_file_access($1, 'inline')", [F.itemA])); });
});

test('item PDF: own unit only; ADMIN_PUSAT all; inactive users nothing', async () => {
  const a = await access('pimpinanA', F.itemA);
  assert.deepEqual(a, {
    file_name: 'surat a.pdf', mime: 'application/pdf', size: 12345,
    object_type: 'ITEM', object_id: fx.ids.A.item, unit_id: fx.unit.A
  });
  for (const u of ['adminA', 'petugasA']) assert.equal((await access(u, F.itemA)).object_id, fx.ids.A.item, u);
  for (const u of ['adminB', 'petugasB', 'inactiveA', 'unitInactive', 'noProfile']) assert.equal(await access(u, F.itemA), null, u);
  assert.equal((await access('petugasB', F.itemB)).unit_id, fx.unit.B);
  assert.equal((await access('pusat', F.itemA)).unit_id, fx.unit.A);
  assert.equal((await access('pusat', F.itemB)).unit_id, fx.unit.B);
});

test('unknown, blank or null id -> null (existence never revealed)', async () => {
  for (const fid of ['TIDAKADA', '', '   ', null]) assert.equal(await access('pusat', fid), null, String(fid));
});

test('quarantined (deleted item / DIHAPUS berkas): admins only', async () => {
  for (const fid of [F.deletedItemA, F.dihapusBerkasA]) {
    assert.equal(await access('petugasA', fid), null);
    assert.equal(await access('pimpinanA', fid), null);
    assert.equal((await access('adminA', fid)).object_type, 'ITEM');
    assert.equal((await access('pusat', fid)).object_type, 'ITEM');
    assert.equal(await access('adminB', fid), null);
  }
});

test('receipt / receipt-line / transfer evidence: operational roles only', async () => {
  const expected = { [F.bukti]: 'PENERIMAAN', [F.batal]: 'PENERIMAAN', [F.rcvi]: 'PENERIMAAN_ITEM', [F.pindah]: 'BERKAS' };
  for (const [fid, type] of Object.entries(expected)) {
    for (const u of ['petugasA', 'adminA', 'pusat']) assert.equal((await access(u, fid)).object_type, type, `${u} ${type}`);
    assert.equal(await access('pimpinanA', fid), null, `pimpinan ${type}`);
    assert.equal(await access('petugasB', fid), null, `other unit ${type}`);
  }
  assert.equal((await access('petugasA', F.bukti)).file_name, 'ttd.pdf');
});

/** Run log_file_access as `u`, then read the audit row in the same transaction as the owner. */
function logAndRead(u, fid, disposition, requestId) {
  return asUser(pool, fx.user[u], async (c) => {
    const { rows: [{ r }] } = await c.query('select public.log_file_access($1, $2, $3) r', [fid, disposition, requestId]);
    await c.query('reset role');
    const { rows: [row] } = await c.query('select * from public.audit_log where id = $1', [r.log_id]);
    return { r, row };
  });
}

test('log_file_access writes one audit row with the caller as actor and the file unit', async () => {
  const { r, row } = await logAndRead('pimpinanA', F.itemA, 'inline', 'REQ-123');
  assert.equal(r.user_id, fx.user.pimpinanA);
  assert.equal(row.actor_user_id, fx.user.pimpinanA);
  assert.equal(row.actor_email_snapshot, `${fx.user.pimpinanA}@test.invalid`);
  assert.equal(row.actor_name_snapshot, 'User PIMPINAN');
  assert.equal(row.unit_id, fx.unit.A);
  assert.equal(row.action, 'VIEW_FILE');
  assert.equal(row.module, 'AKSES_FILE');
  assert.equal(row.object_type, 'ITEM');
  assert.equal(row.object_id, fx.ids.A.item);
  assert.equal(row.request_id, 'REQ-123');
  assert.equal(row.result, 'SUCCESS');
  assert.deepEqual(row.after_data, { drive_file_id: F.itemA, file_name: 'surat a.pdf', disposition: 'inline' });

  const pusat = await logAndRead('pusat', F.itemB, 'attachment', null);
  assert.equal(pusat.row.unit_id, fx.unit.B);
  assert.equal(pusat.row.action, 'DOWNLOAD_FILE');
  assert.equal(pusat.row.request_id, null);
});

test('log_file_access refuses files the caller cannot open, and bad input', async () => {
  const cases = [
    ['petugasB', F.itemA, 'inline', '42501'],      // other unit
    ['pimpinanA', F.bukti, 'inline', '42501'],     // ops-only evidence
    ['petugasA', F.deletedItemA, 'inline', '42501'], // quarantined
    ['inactiveA', F.itemA, 'inline', '42501'],
    ['noProfile', F.itemA, 'inline', '42501'],
    ['petugasA', 'TIDAKADA', 'inline', '42501'],
    ['petugasA', F.itemA, 'preview', '22023']
  ];
  for (const [u, fid, disp, code] of cases) {
    await asUser(pool, fx.user[u], async (c) => {
      await expectSqlError(c.query('select public.log_file_access($1, $2)', [fid, disp]), code);
    });
  }
  // nothing was written for those attempts
  const { rows: [{ n }] } = await pool.query(
    "select count(*)::int n from public.audit_log where module = 'AKSES_FILE' and after_data ->> 'drive_file_id' = any($1)",
    [[F.itemA, F.bukti, F.deletedItemA, 'TIDAKADA']]);
  assert.equal(n, 0);
});

test('authenticated still cannot write audit_log directly', async () => {
  await asUser(pool, fx.user.adminA, async (c) => {
    await expectSqlError(c.query("insert into public.audit_log (unit_id, action) values ($1, 'FAKE')", [fx.unit.A]));
  });
});

test('get_item_detail exposes mime type and file size', async () => {
  const d = await asUser(pool, fx.user.petugasA, async (c) =>
    (await c.query('select public.get_item_detail($1) d', [fx.ids.A.item])).rows[0].d);
  assert.equal(d.mime_type, 'application/pdf');
  assert.equal(d.drive_file_size_bytes, 12345);
});
