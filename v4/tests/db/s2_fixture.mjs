// Sprint 2 test helpers: committed RPC calls as a given user, error-code
// assertions, upload attestations, and a fixture with two units.
import pg from 'pg';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';

// Set on the test database by run.sh (cluster_set_test_secrets); Vault on Supabase.
export const SECRET = process.env.CF_TEST_UPLOAD_SECRET || 'test-only-upload-attest-secret-0123456789abcdef';

/** The local (vault-less) secret must be visible to new connections. */
export async function configureSecret() {
  const c = new pg.Client();
  await c.connect();
  try {
    const { rows: [r] } = await c.query("select current_setting('app.secret.UPLOAD_ATTEST_SECRET', true) as v");
    if (r.v !== SECRET) throw new Error('test secret not configured: run the tests through run.sh');
  } finally {
    await c.end();
  }
}

export function newPool(max = 20) {
  return new pg.Pool({ max });
}

/** Call public.<fn>(named args) as an authenticated user (or anon when userId is null) and COMMIT. */
export async function rpc(pool, userId, fn, args = {}, { role } = {}) {
  const client = await pool.connect();
  const names = Object.keys(args);
  const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as r`;
  const values = names.map((n) => {
    const v = args[n];
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? JSON.stringify(v) : v;
  });
  try {
    await client.query('begin');
    await client.query("select set_config('request.jwt.claims', $1, true)",
      [JSON.stringify(userId ? { sub: userId, role: 'authenticated' } : { role: 'anon' })]);
    await client.query(`set local role ${role || (userId ? 'authenticated' : 'anon')}`);
    const { rows: [row] } = await client.query(sql, values);
    await client.query('commit');
    return row.r;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Assert a promise rejects with our stable code (error.hint) or a SQLSTATE. */
export async function expectCode(promise, code) {
  try {
    await promise;
  } catch (error) {
    const got = error.hint || error.code;
    assert.equal(got, code, `expected ${code}, got ${got}: ${error.message}`);
    if (error.hint) assert.match(error.message, new RegExp(`^${code}: `));
    return error;
  }
  assert.fail(`expected ${code} but the call succeeded`);
}

export function attestation({ sessionId, fileId, size, md5, mime, at, secret = SECRET }) {
  const canonical = ['CFUP1', sessionId, fileId, String(size), md5, mime, String(at)].join('\n');
  return createHmac('sha256', secret).update(canonical).digest('hex');
}
export function folderAttestation({ sessionId, folderId, at, secret = SECRET }) {
  return createHmac('sha256', secret).update(['CFFD1', sessionId, folderId, String(at)].join('\n')).digest('hex');
}
export function taskAttestation({ taskId, ok, at, secret = SECRET }) {
  return createHmac('sha256', secret).update(['CFDT1', taskId, ok ? 'ok' : 'fail', String(at)].join('\n')).digest('hex');
}
export const nowSec = () => Math.floor(Date.now() / 1000);
export const driveId = () => 'drv' + randomUUID().replace(/-/g, '');

/** Commit an upload exactly like the trusted gateway would. */
export async function gatewayCommit(pool, userId, session, { fileId = driveId(), size, md5 = 'd41d8cd98f00b204e9800998ecf8427e', mime = 'application/pdf', at = nowSec(), secret } = {}) {
  const sz = size ?? 1234;
  return rpc(pool, userId, 'upload_commit', {
    p_session_id: session.session_id, p_drive_file_id: fileId, p_drive_url: `https://drive.google.com/file/d/${fileId}/view`,
    p_size: sz, p_md5: md5, p_mime: mime, p_attested_at: at,
    p_attestation: attestation({ sessionId: session.session_id, fileId, size: sz, md5, mime, at, secret })
  });
}

/** Run SQL as the migration owner (bypasses RLS) for setup/inspection. */
export async function owner(pool, sql, params) {
  return (await pool.query(sql, params)).rows;
}

export async function createS2Fixture(pool) {
  const tag = randomUUID().slice(0, 6).toUpperCase();
  const unit = { A: randomUUID(), B: randomUUID() };
  const user = {
    pusat: randomUUID(), adminA: randomUUID(), petugasA: randomUUID(), petugasA2: randomUUID(), pimpinanA: randomUUID(),
    inactiveA: randomUUID(), petugasB: randomUUID()
  };
  const c = await pool.connect();
  try {
    await c.query('begin');
    for (const id of Object.values(user)) {
      await c.query('insert into auth.users (id, email) values ($1, $2)', [id, `${id.slice(0, 8)}@uji.invalid`]);
    }
    await c.query(`insert into public.units (id, code, name) values ($1, $3, 'Unit A uji'), ($2, $4, 'Unit B uji')`,
      [unit.A, unit.B, `S2${tag}A`, `S2${tag}B`]);
    const prof = [
      [user.pusat, null, 'ADMIN_PUSAT', true], [user.adminA, unit.A, 'ADMIN_UNIT', true], [user.petugasA, unit.A, 'PETUGAS', true],
      [user.petugasA2, unit.A, 'PETUGAS', true], [user.pimpinanA, unit.A, 'PIMPINAN', true], [user.inactiveA, unit.A, 'PETUGAS', false],
      [user.petugasB, unit.B, 'PETUGAS', true]
    ];
    for (const [id, u, role, active] of prof) {
      await c.query('insert into public.profiles (user_id, unit_id, role, full_name, active) values ($1, $2, $3, $4, $5)',
        [id, u, role, `Petugas uji ${role}`, active]);
    }
    for (const u of [unit.A, unit.B]) {
      // PR (primary with children) > PR.01 (secondary) > PR.01.01 (tertiary); KU > KU.02 (secondary without tertiary);
      // LEAF (primary without children); OLD (inactive)
      await c.query(`insert into public.klasifikasi (unit_id, id, parent_id, level, kode_lengkap, uraian, aktif, urutan) values
        ($1, 'K-PR', null, 'PRIMER', 'PR', 'Perencanaan', true, 1),
        ($1, 'K-PR01', 'K-PR', 'SEKUNDER', 'PR.01', 'Rencana strategis', true, 2),
        ($1, 'K-PR0101', 'K-PR01', 'TERSIER', 'PR.01.01', 'Renstra', true, 3),
        ($1, 'K-KU', null, 'PRIMER', 'KU', 'Keuangan', true, 4),
        ($1, 'K-KU02', 'K-KU', 'SEKUNDER', 'KU.02', 'Pelaksanaan anggaran', true, 5),
        ($1, 'K-LEAF', null, 'PRIMER', 'LF', 'Primer tanpa turunan', true, 6),
        ($1, 'K-OLD', 'K-KU', 'SEKUNDER', 'KU.99', 'Nonaktif', false, 7)`, [u]);
      await c.query(`insert into public.pegawai (id, unit_id, nama_pegawai, unit_kerja, aktif) values
        ($2, $1, 'Budi Fiktif', 'Subbagian Uji', true), ($3, $1, 'Sari Fiktif', 'Subbagian Uji', false)`,
        [u, `PGW-${tag}-${u === unit.A ? 'A' : 'B'}1`, `PGW-${tag}-${u === unit.A ? 'A' : 'B'}2`]);
      await c.query(`insert into public.unit_settings (unit_id, key, value) values
        ($1, 'RECEIPT_RECEIVER_NAME', '"Penerima Fiktif"'), ($1, 'ARCHIVE_FOLDER_ID', '"root-folder-fiktif-0001"')`, [u]);
      await c.query(`insert into public.jenis_naskah (unit_id, subjenis_naskah_id, jenis_naskah_id, kategori, subjenis, pola_default, aktif, urutan)
        values ($1, 'SJ-1', 'JN-1', 'Kategori uji', 'Subjenis uji', 'SERI', true, 1)`, [u]);
    }
    await c.query('commit');
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
  return {
    tag, unit, user,
    pegawai: { A: `PGW-${tag}-A1`, Ainactive: `PGW-${tag}-A2`, B: `PGW-${tag}-B1` }
  };
}

export function receiptItem(over = {}) {
  return {
    description: 'Surat uji fiktif', page_count: 3, development_level: 'ASLI', condition: 'BAIK',
    security_classification: 'BIASA/TERBUKA', primary_letter_number: 'B-1/UJI/2025', document_date: '2025-03-10', ...over
  };
}

export function receiptPayload(fx, unitKey = 'A', items = [receiptItem()], over = {}) {
  return { sender_employee_id: fx.pegawai[unitKey], receiver_name: 'Penerima Fiktif', receiver_unit: 'Bagian Umum Fiktif',
    notes: 'Catatan uji', items, ...over };
}

export const newBerkasTarget = (over = {}) => ({
  mode: 'NEW', title: 'Berkas uji fiktif', classification_id: 'K-PR0101', active_retention_value: 2,
  active_retention_unit: 'TAHUN', inactive_retention_value: 3, inactive_retention_unit: 'TAHUN',
  final_disposition: 'PERMANEN', filing_cabinet: '1', drawer: '2', ...over
});

/** Create a receipt (as user) and return {receipt_id, number, itemIds[]} */
export async function makeReceipt(pool, fx, userId, unitKey, items, unitId) {
  const res = await rpc(pool, userId, 'receipt_save', {
    p_request_id: randomUUID(), p_payload: receiptPayload(fx, unitKey, items), ...(unitId ? { p_unit_id: unitId } : {})
  });
  const rows = await owner(pool, 'select id from public.penerimaan_item where penerimaan_id = $1 and not is_deleted order by no_item', [res.receipt_id]);
  return { ...res, itemIds: rows.map((r) => r.id) };
}
