// Sprint 2 — upload sessions with attested commit, folder registration, Drive tasks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  configureSecret, newPool, rpc, expectCode, owner, createS2Fixture, receiptItem, makeReceipt, newBerkasTarget,
  gatewayCommit, attestation, folderAttestation, taskAttestation, nowSec, driveId
} from './s2_fixture.mjs';

let pool;
let fx;

before(async () => {
  await configureSecret();
  pool = newPool();
  fx = await createS2Fixture(pool);
});
after(async () => { await pool.end(); });

const manualItem = async (user, over = {}) => rpc(pool, user, 'item_create_manual', {
  p_request_id: randomUUID(), p_target: newBerkasTarget({ title: over.title || 'Berkas unggah' }),
  p_item: { description: over.description || 'Surat/uji: "PDF"', page_count: 1, development_level: 'ASLI',
    security_classification: 'BIASA/TERBUKA', document_date: over.date || '2024-01-01' } });
const begin = (user, purpose, objectId, over = {}) => rpc(pool, user, 'upload_begin', {
  p_request_id: over.request_id || randomUUID(), p_purpose: purpose, p_object_id: objectId,
  p_file_name: over.name || 'scan.pdf', p_mime: over.mime ?? 'application/pdf', p_size: over.size ?? 1234, ...(over.unit ? { p_unit_id: over.unit } : {}) });

test('upload_begin ITEM_PDF: legacy name and folder, limits, guards, idempotent per request', async () => {
  const m = await manualItem(fx.user.petugasA);
  const req = randomUUID();
  const s = await begin(fx.user.petugasA, 'ITEM_PDF', m.item_id, { request_id: req });
  assert.equal(s.unit_id, fx.unit.A);
  assert.match(s.unit_code, /^S2/);
  assert.equal(s.drive_name, `${m.berkas_number}_${m.item_number}_Surat-uji- -PDF-.pdf`);
  assert.deepEqual(s.folder_path, [`${m.berkas_number}_Berkas unggah`]);
  assert.equal(s.known_folder_id, null);
  assert.equal(s.root_folder_id, 'root-folder-fiktif-0001');
  assert.equal(s.max_bytes, 104857599);
  const again = await begin(fx.user.petugasA, 'ITEM_PDF', m.item_id, { request_id: req });
  assert.deepEqual([again.session_id, again.replayed], [s.session_id, true]);
  await expectCode(begin(fx.user.petugasA, 'ITEM_PDF', m.item_id, { request_id: req, size: 99 }), 'IDEMPOTENCY_CONFLICT');
  await expectCode(begin(fx.user.petugasA, 'ITEM_PDF', m.item_id, { size: 104857600 }), 'FILE_TOO_LARGE');
  await expectCode(begin(fx.user.petugasA, 'ITEM_PDF', m.item_id, { name: 'scan.docx' }), 'FILE_TYPE');
  await expectCode(begin(fx.user.petugasA, 'ITEM_PDF', m.item_id, { mime: 'image/png' }), 'FILE_TYPE');
  await expectCode(begin(fx.user.petugasA, 'ITEM_PDF', m.item_id, { size: 0 }), 'INVALID_INPUT');
  await expectCode(begin(fx.user.petugasA, 'LAINNYA', m.item_id), 'INVALID_INPUT');
  await expectCode(begin(fx.user.pimpinanA, 'ITEM_PDF', m.item_id), 'FORBIDDEN_ROLE');
  await expectCode(begin(fx.user.petugasB, 'ITEM_PDF', m.item_id), 'NOT_FOUND');
  await expectCode(begin(fx.user.petugasA, 'ITEM_PDF', 'ITM-tidak-ada'), 'NOT_FOUND');
  await owner(pool, `update public.berkas set status_peminjaman = 'DIPINJAM' where id = $1`, [m.berkas_id]);
  await expectCode(begin(fx.user.petugasA, 'ITEM_PDF', m.item_id), 'OBJECT_BORROWED');
  await owner(pool, `update public.berkas set status_peminjaman = 'TERSEDIA' where id = $1`, [m.berkas_id]);
  // ADMIN_PUSAT works on the object's unit
  const sp = await begin(fx.user.pusat, 'ITEM_PDF', (await manualItem(fx.user.petugasA)).item_id);
  assert.equal(sp.unit_id, fx.unit.A);
});

test('commit with a valid attestation links the PDF atomically; replay is idempotent; then ITEM_HAS_FILE', async () => {
  const m = await manualItem(fx.user.petugasA);
  const s = await begin(fx.user.petugasA, 'ITEM_PDF', m.item_id);
  const fileId = driveId();
  const res = await gatewayCommit(pool, fx.user.petugasA, s, { fileId, md5: 'ABCDEF0123456789abcdef0123456789' });
  assert.equal(res.drive_file_id, fileId);
  assert.equal(res.replayed, false);
  const [i] = await owner(pool, 'select * from public.item where id = $1', [m.item_id]);
  assert.deepEqual({ id: i.drive_file_id, st: i.status_file, bentuk: i.status_bentuk_digital, size: Number(i.drive_file_size_bytes),
    md5: i.drive_file_md5, mime: i.mime_type, nama: i.nama_file, v: i.version },
  { id: fileId, st: 'TERSEDIA', bentuk: 'ALIH MEDIA', size: 1234, md5: 'abcdef0123456789abcdef0123456789',
    mime: 'application/pdf', nama: s.drive_name, v: 3 });
  const replay = await gatewayCommit(pool, fx.user.petugasA, s, { fileId, md5: 'ABCDEF0123456789abcdef0123456789' });
  assert.equal(replay.replayed, true);
  await expectCode(gatewayCommit(pool, fx.user.petugasA, s, { fileId: driveId() }), 'UPLOAD_SESSION_STATE');
  await expectCode(begin(fx.user.petugasA, 'ITEM_PDF', m.item_id), 'ITEM_HAS_FILE');
  const [aud] = await owner(pool, "select * from public.audit_log where action = 'UPLOAD' and object_id = $1", [m.item_id]);
  assert.equal(aud.module, 'ALIH_MEDIA');
  // the uploader can now open it through the download bridge
  const acc = await rpc(pool, fx.user.pimpinanA, 'get_file_access', { p_drive_file_id: fileId });
  assert.equal(acc.object_id, m.item_id);
});

test('attestation: forged, tampered, expired, future, missing and wrong-owner commits are refused', async () => {
  const m = await manualItem(fx.user.petugasA);
  const s = await begin(fx.user.petugasA, 'ITEM_PDF', m.item_id);
  await expectCode(gatewayCommit(pool, fx.user.petugasA, s, { secret: 'kunci-palsu-0123456789-0123456789-abc' }), 'UPLOAD_ATTESTATION_INVALID');
  // tamper: attestation computed for one size, commit claims another
  const fileId = driveId();
  const at = nowSec();
  const att = attestation({ sessionId: s.session_id, fileId, size: 1234, md5: 'aa', mime: 'application/pdf', at });
  await expectCode(rpc(pool, fx.user.petugasA, 'upload_commit', { p_session_id: s.session_id, p_drive_file_id: fileId, p_drive_url: null,
    p_size: 4321, p_md5: 'aa', p_mime: 'application/pdf', p_attested_at: at, p_attestation: att }), 'UPLOAD_ATTESTATION_INVALID');
  // tamper: file id swapped
  await expectCode(rpc(pool, fx.user.petugasA, 'upload_commit', { p_session_id: s.session_id, p_drive_file_id: driveId(), p_drive_url: null,
    p_size: 1234, p_md5: 'aa', p_mime: 'application/pdf', p_attested_at: at, p_attestation: att }), 'UPLOAD_ATTESTATION_INVALID');
  await expectCode(gatewayCommit(pool, fx.user.petugasA, s, { at: nowSec() - 305 }), 'UPLOAD_ATTESTATION_EXPIRED');
  await expectCode(gatewayCommit(pool, fx.user.petugasA, s, { at: nowSec() + 305 }), 'UPLOAD_ATTESTATION_EXPIRED');
  await expectCode(rpc(pool, fx.user.petugasA, 'upload_commit', { p_session_id: s.session_id, p_drive_file_id: fileId, p_drive_url: null,
    p_size: 1234, p_md5: 'aa', p_mime: 'application/pdf', p_attested_at: at, p_attestation: null }), 'UPLOAD_ATTESTATION_INVALID');
  await expectCode(gatewayCommit(pool, fx.user.petugasA2, s), 'NOT_FOUND'); // same unit, not the owner
  await expectCode(gatewayCommit(pool, fx.user.petugasB, s), 'NOT_FOUND');
  // the item is still without a file
  const [i] = await owner(pool, 'select drive_file_id from public.item where id = $1', [m.item_id]);
  assert.equal(i.drive_file_id, null);
  // replaying a valid attestation from another session is useless (session id is in the canonical string)
  const m2 = await manualItem(fx.user.petugasA);
  const s2 = await begin(fx.user.petugasA, 'ITEM_PDF', m2.item_id);
  const att2 = attestation({ sessionId: s2.session_id, fileId, size: 1234, md5: 'aa', mime: 'application/pdf', at });
  await expectCode(rpc(pool, fx.user.petugasA, 'upload_commit', { p_session_id: s.session_id, p_drive_file_id: fileId, p_drive_url: null,
    p_size: 1234, p_md5: 'aa', p_mime: 'application/pdf', p_attested_at: at, p_attestation: att2 }), 'UPLOAD_ATTESTATION_INVALID');
  // an attestation 290 s old is still inside the window
  const m3 = await manualItem(fx.user.petugasA);
  const s3 = await begin(fx.user.petugasA, 'ITEM_PDF', m3.item_id);
  assert.equal((await gatewayCommit(pool, fx.user.petugasA, s3, { at: nowSec() - 290 })).ok, true);
  // the secret helper is not callable by clients
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local role authenticated');
    await expectCode(c.query("select app.server_secret('UPLOAD_ATTEST_SECRET')"), '42501');
  } finally {
    await c.query('rollback');
    c.release();
  }
});

test('ATTACK: a user of unit B cannot attach unit A\'s Drive file to read it through the download bridge', async () => {
  // victim: unit A item with a confidential PDF
  const ma = await manualItem(fx.user.petugasA, { title: 'Rahasia A' });
  const sa = await begin(fx.user.petugasA, 'ITEM_PDF', ma.item_id);
  const victimFile = driveId();
  await gatewayCommit(pool, fx.user.petugasA, sa, { fileId: victimFile });
  assert.equal(await rpc(pool, fx.user.petugasB, 'get_file_access', { p_drive_file_id: victimFile }), null);
  // attacker: own item in unit B, own session, then tries to bind the victim's Drive id
  const mb = await manualItem(fx.user.petugasB, { title: 'Umpan B' });
  const sb = await begin(fx.user.petugasB, 'ITEM_PDF', mb.item_id);
  const at = nowSec();
  for (const forged of ['0'.repeat(64), attestation({ sessionId: sb.session_id, fileId: victimFile, size: 1234, md5: 'x', mime: 'application/pdf', at, secret: 'tebakan-tebakan-tebakan-tebakan-01' })]) {
    await expectCode(rpc(pool, fx.user.petugasB, 'upload_commit', { p_session_id: sb.session_id, p_drive_file_id: victimFile,
      p_drive_url: null, p_size: 1234, p_md5: 'x', p_mime: 'application/pdf', p_attested_at: at, p_attestation: forged }), 'UPLOAD_ATTESTATION_INVALID');
  }
  // defence in depth: even a genuine attestation for an id already bound elsewhere is refused
  await expectCode(gatewayCommit(pool, fx.user.petugasB, sb, { fileId: victimFile }), 'UPLOAD_FILE_IN_USE');
  assert.equal(await rpc(pool, fx.user.petugasB, 'get_file_access', { p_drive_file_id: victimFile }), null);
  const [b] = await owner(pool, 'select drive_file_id from public.item where id = $1', [mb.item_id]);
  assert.equal(b.drive_file_id, null);
  // and tables stay non-writable for clients
  await expectCode(rpc(pool, fx.user.petugasB, 'get_file_access', { p_drive_file_id: victimFile }, { role: 'anon' }), '42501');
});

test('sessions: one active per object, supersede by the same user, refusal for another user, expiry, cancel', async () => {
  const m = await manualItem(fx.user.petugasA);
  const s1 = await begin(fx.user.petugasA, 'ITEM_PDF', m.item_id);
  await expectCode(begin(fx.user.petugasA2, 'ITEM_PDF', m.item_id), 'UPLOAD_SESSION_ACTIVE');
  const s2 = await begin(fx.user.petugasA, 'ITEM_PDF', m.item_id);
  await expectCode(gatewayCommit(pool, fx.user.petugasA, s1), 'UPLOAD_SESSION_STATE'); // superseded
  await owner(pool, `update public.upload_sessions set expires_at = now() - interval '1 minute' where id = $1`, [s2.session_id]);
  await expectCode(gatewayCommit(pool, fx.user.petugasA, s2), 'UPLOAD_SESSION_EXPIRED');
  const s3 = await begin(fx.user.petugasA2, 'ITEM_PDF', m.item_id); // expired session no longer blocks others
  const [old] = await owner(pool, 'select status from public.upload_sessions where id = $1', [s2.session_id]);
  assert.equal(old.status, 'EXPIRED');
  await expectCode(rpc(pool, fx.user.petugasA, 'upload_cancel', { p_session_id: s3.session_id }), 'NOT_FOUND');
  const c = await rpc(pool, fx.user.petugasA2, 'upload_cancel', { p_session_id: s3.session_id });
  assert.equal(c.status, 'CANCELLED');
  assert.equal((await rpc(pool, fx.user.petugasA2, 'upload_cancel', { p_session_id: s3.session_id })).status, 'CANCELLED');
  await expectCode(gatewayCommit(pool, fx.user.petugasA2, s3), 'UPLOAD_SESSION_STATE');
  // a committed archive PDF session cannot be cancelled
  const s4 = await begin(fx.user.petugasA, 'ITEM_PDF', m.item_id);
  await gatewayCommit(pool, fx.user.petugasA, s4);
  await expectCode(rpc(pool, fx.user.petugasA, 'upload_cancel', { p_session_id: s4.session_id }), 'UPLOAD_SESSION_STATE');
  // commit refuses a different size than declared and a non-PDF mime
  const m2 = await manualItem(fx.user.petugasA);
  const s5 = await begin(fx.user.petugasA, 'ITEM_PDF', m2.item_id, { size: 1000 });
  await expectCode(gatewayCommit(pool, fx.user.petugasA, s5, { size: 999 }), 'UPLOAD_MISMATCH');
  await expectCode(gatewayCommit(pool, fx.user.petugasA, s5, { size: 1000, mime: 'application/octet-stream' }), 'FILE_TYPE');
});

test('receipt evidence: ≤10 MB, attached once, name per legacy, locks the receipt', async () => {
  const r = await makeReceipt(pool, fx, fx.user.petugasA, 'A', [receiptItem()]);
  await expectCode(begin(fx.user.petugasA, 'RECEIPT_EVIDENCE', r.receipt_id, { size: 10485761 }), 'FILE_TOO_LARGE');
  const s = await begin(fx.user.petugasA, 'RECEIPT_EVIDENCE', r.receipt_id, { size: 10485760 });
  assert.equal(s.drive_name, `${r.number}_Tanda-Terima-Tertandatangani.pdf`);
  assert.deepEqual(s.folder_path, ['BUKTI PENERIMAAN ARSIP']);
  assert.equal(s.max_bytes, 10485760);
  const fileId = driveId();
  await gatewayCommit(pool, fx.user.petugasA, s, { fileId, size: 10485760, mime: 'application/octet-stream' });
  const [rec] = await owner(pool, 'select * from public.penerimaan where id = $1', [r.receipt_id]);
  assert.deepEqual([rec.bukti_ttd_file_id, rec.bukti_ttd_nama, Number(rec.bukti_ttd_size_bytes)], [fileId, s.drive_name, 10485760]);
  await expectCode(begin(fx.user.petugasA, 'RECEIPT_EVIDENCE', r.receipt_id), 'EVIDENCE_EXISTS');
  const opts = await rpc(pool, fx.user.petugasA, 'receipt_options', {});
  const ro = opts.receipts.find((x) => x.id === r.receipt_id);
  assert.deepEqual([ro.can_edit_header, ro.evidence_file_id], [false, fileId]);
  // evidence is operational, not an archive softcopy: PIMPINAN cannot open it, PETUGAS can
  assert.equal(await rpc(pool, fx.user.pimpinanA, 'get_file_access', { p_drive_file_id: fileId }), null);
  assert.equal((await rpc(pool, fx.user.petugasA2, 'get_file_access', { p_drive_file_id: fileId })).object_id, r.receipt_id);
  // cancel evidence requires an active receipt
  await rpc(pool, fx.user.petugasA, 'receipt_cancel', { p_request_id: randomUUID(), p_receipt_id: r.receipt_id, p_reason: 'dibatalkan untuk uji', p_confirmation: 'BATALKAN' });
  await expectCode(begin(fx.user.petugasA, 'RECEIPT_CANCEL_EVIDENCE', r.receipt_id), 'RECEIPT_CANCELLED');
});

test('register folder (attested) caches the berkas folder; forged refused', async () => {
  const m = await manualItem(fx.user.petugasA);
  const s = await begin(fx.user.petugasA, 'ITEM_PDF', m.item_id);
  const folder = 'fld' + randomUUID().replace(/-/g, '');
  const at = nowSec();
  await expectCode(rpc(pool, fx.user.petugasA, 'upload_register_folder', { p_session_id: s.session_id, p_folder_id: folder, p_attested_at: at,
    p_attestation: folderAttestation({ sessionId: s.session_id, folderId: folder, at, secret: 'salah-salah-salah-salah-salah-01234' }) }), 'UPLOAD_ATTESTATION_INVALID');
  const ok = await rpc(pool, fx.user.petugasA, 'upload_register_folder', { p_session_id: s.session_id, p_folder_id: folder, p_attested_at: at,
    p_attestation: folderAttestation({ sessionId: s.session_id, folderId: folder, at }) });
  assert.equal(ok.registered, true);
  const [b] = await owner(pool, 'select drive_folder_id, drive_folder_url from public.berkas where id = $1', [m.berkas_id]);
  assert.deepEqual([b.drive_folder_id, b.drive_folder_url], [folder, `https://drive.google.com/drive/folders/${folder}`]);
  const second = await rpc(pool, fx.user.petugasA, 'upload_register_folder', { p_session_id: s.session_id, p_folder_id: 'fld' + randomUUID().replace(/-/g, ''),
    p_attested_at: at, p_attestation: folderAttestation({ sessionId: s.session_id, folderId: folder, at }) }).catch((e) => e);
  assert.equal(second.hint, 'UPLOAD_ATTESTATION_INVALID');
  const s2 = await begin(fx.user.petugasA, 'ITEM_PDF', (await rpc(pool, fx.user.petugasA, 'item_create_manual', { p_request_id: randomUUID(),
    p_target: { mode: 'EXISTING', berkas_id: m.berkas_id }, p_item: { description: 'kedua', page_count: 1, development_level: 'ASLI',
      security_classification: 'BIASA/TERBUKA', document_date: '2024-02-01' } })).item_id);
  assert.equal(s2.known_folder_id, folder);
});

test('drive tasks after renumbering: listed, completed with attestation, failures audited', async () => {
  const x = await manualItem(fx.user.petugasA, { title: 'Tugas X', date: '2030-01-01' });
  await owner(pool, `update public.berkas set drive_folder_id = 'fld-tugas-x-000001' where id = $1`, [x.berkas_id]);
  const y = await manualItem(fx.user.petugasA, { title: 'Tugas Y', date: '2000-01-01' });
  const task = y.drive_tasks.find((t) => t.drive_id === 'fld-tugas-x-000001');
  assert.ok(task, 'folder rename queued');
  const list = await rpc(pool, fx.user.petugasA, 'drive_task_list', {});
  assert.ok(list.tasks.some((t) => t.id === task.id));
  await expectCode(rpc(pool, fx.user.pimpinanA, 'drive_task_list', {}), 'FORBIDDEN_ROLE');
  const at = nowSec();
  await expectCode(rpc(pool, fx.user.petugasA, 'drive_task_complete', { p_task_id: task.id, p_ok: true, p_error: null, p_attested_at: at,
    p_attestation: taskAttestation({ taskId: task.id, ok: false, at }) }), 'UPLOAD_ATTESTATION_INVALID');
  const fail = await rpc(pool, fx.user.petugasA, 'drive_task_complete', { p_task_id: task.id, p_ok: false, p_error: 'rate limit', p_attested_at: at,
    p_attestation: taskAttestation({ taskId: task.id, ok: false, at }) });
  assert.deepEqual([fail.status, fail.attempts], ['PENDING', 1]);
  const done = await rpc(pool, fx.user.petugasA, 'drive_task_complete', { p_task_id: task.id, p_ok: true, p_error: null, p_attested_at: at,
    p_attestation: taskAttestation({ taskId: task.id, ok: true, at }) });
  assert.equal(done.status, 'DONE');
  assert.ok(!(await rpc(pool, fx.user.petugasA, 'drive_task_list', {})).tasks.some((t) => t.id === task.id));
  await expectCode(rpc(pool, fx.user.petugasB, 'drive_task_complete', { p_task_id: task.id, p_ok: true, p_error: null, p_attested_at: at,
    p_attestation: taskAttestation({ taskId: task.id, ok: true, at }) }), 'NOT_FOUND');
});
