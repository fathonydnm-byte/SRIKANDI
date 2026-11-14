// Sprint 3 — Edit/Perubahan (ports of EditService.updateArchiveItem_ / updateBerkasTitle_,
// UploadService edit replacement upload, FIX 3.30.5 and 3.30.6) and the quarantine table.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  configureSecret, newPool, rpc, expectCode, owner, createS2Fixture, newBerkasTarget, gatewayCommit, attestation,
  nowSec, driveId
} from './s2_fixture.mjs';

let pool;
let fx;
let adminB;

before(async () => {
  await configureSecret();
  pool = newPool();
  fx = await createS2Fixture(pool);
  adminB = randomUUID();
  await owner(pool, 'insert into auth.users (id, email) values ($1, $2)', [adminB, `${adminB.slice(0, 8)}@uji.invalid`]);
  await owner(pool, `insert into public.profiles (user_id, unit_id, role, full_name, active) values ($1, $2, 'ADMIN_UNIT', 'Admin B', true)`,
    [adminB, fx.unit.B]);
});
after(async () => { await pool.end(); });

const manual = (user, target, item = {}) => rpc(pool, user, 'item_create_manual', {
  p_request_id: randomUUID(), p_target: target, p_item: {
    description: 'Item edit', page_count: 2, development_level: 'ASLI', security_classification: 'BIASA/TERBUKA',
    document_date: '2024-06-01', ...item } });
const existing = (berkasId) => ({ mode: 'EXISTING', berkas_id: berkasId });
const itemRow = async (id) => (await owner(pool, 'select * from public.item where id = $1', [id]))[0];
const berkasRow = async (id) => (await owner(pool, 'select * from public.berkas where id = $1', [id]))[0];
const iso = (d) => (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : d);
/** current metadata of an item as an item_update payload */
const payloadOf = async (id, over = {}) => {
  const i = await itemRow(id);
  return { berkas_id: i.berkas_id, description: i.uraian_lengkap, page_count: i.jumlah_halaman, document_date: iso(i.tanggal_naskah),
    development_level: i.tingkat_perkembangan, condition: i.kondisi_fisik || '', security_classification: i.klasifikasi_keamanan_akses, ...over };
};
const update = (user, itemId, payload, extra = {}) => rpc(pool, user, 'item_update', {
  p_request_id: extra.request_id || randomUUID(), p_item_id: itemId, p_payload: payload,
  p_reason: extra.reason ?? 'Koreksi data sesuai naskah asli', ...(extra.session ? { p_replacement_session_id: extra.session } : {}),
  ...(extra.validate ? { p_validate_only: true } : {}) });
const begin = (user, purpose, objectId, over = {}) => rpc(pool, user, 'upload_begin', {
  p_request_id: over.request_id || randomUUID(), p_purpose: purpose, p_object_id: objectId,
  p_file_name: over.name || 'pengganti.pdf', p_mime: over.mime ?? 'application/pdf', p_size: over.size ?? 2048 });
/** an item with an app-owned PDF (ITEM_PDF through the attested path) */
const withPdf = async (user, target, item) => {
  const m = await manual(user, target, item);
  const s = await begin(user, 'ITEM_PDF', m.item_id, { name: 'asli.pdf' });
  const fileId = driveId();
  await gatewayCommit(pool, user, s, { fileId, size: 2048 });
  return { ...m, fileId };
};
/** a committed ITEM_PDF_REPLACE session */
const replacement = async (user, itemId, over = {}) => {
  const s = await begin(user, 'ITEM_PDF_REPLACE', itemId, over);
  const fileId = over.fileId || driveId();
  await gatewayCommit(pool, user, s, { fileId, size: over.size ?? 2048 });
  return { session: s, fileId };
};

test('edit_options: berkas with nested items, legacy fields and option lists; unit-scoped reads', async () => {
  const m = await manual(fx.user.petugasA, newBerkasTarget({ title: 'Opsi edit' }), { description: 'Satu', condition: 'BAIK' });
  const o = await rpc(pool, fx.user.pimpinanA, 'edit_options', {});
  const b = o.berkas.find((x) => x.id === m.berkas_id);
  assert.equal(b.label, `${m.berkas_number} – Opsi edit`);
  assert.equal(b.can_edit, true);
  assert.deepEqual(Object.keys(b.items[0]).sort(), ['alternate_letter_number', 'can_edit', 'condition', 'description', 'development_level',
    'document_date', 'file_name', 'file_status', 'file_url', 'has_file', 'id', 'label', 'loan_status', 'number', 'page_count',
    'primary_letter_number', 'security_classification', 'version']);
  assert.deepEqual(o.conditions, ['BAIK', 'RUSAK RINGAN', 'RUSAK SEDANG', 'RUSAK BERAT']);
  const ob = await rpc(pool, fx.user.petugasB, 'edit_options', {});
  assert.ok(!ob.berkas.some((x) => x.id === m.berkas_id));
  await expectCode(rpc(pool, fx.user.pusat, 'edit_options', {}), 'UNIT_REQUIRED');
  assert.ok((await rpc(pool, fx.user.pusat, 'edit_options', { p_unit_id: fx.unit.A })).berkas.some((x) => x.id === m.berkas_id));
  await expectCode(rpc(pool, fx.user.petugasB, 'edit_options', { p_unit_id: fx.unit.A }), 'FORBIDDEN_UNIT');
});

test('item_update: same ITEM_ID, date change reorders with history, security recompute, audit before/after', async () => {
  const a1 = await manual(fx.user.petugasA, newBerkasTarget({ title: 'Kronologi' }), { description: 'Awal', document_date: '2024-01-10' });
  const a2 = await manual(fx.user.petugasA, existing(a1.berkas_id), { description: 'Akhir', document_date: '2024-03-10', security_classification: 'TERBATAS' });
  assert.deepEqual([(await itemRow(a1.item_id)).no_item_definitif, (await itemRow(a2.item_id)).no_item_definitif], [1, 2]);
  assert.equal((await berkasRow(a1.berkas_id)).klasifikasi_keamanan_akses, 'TERBATAS');
  const before = await itemRow(a2.item_id);
  const res = await update(fx.user.petugasA2, a2.item_id, await payloadOf(a2.item_id,
    { document_date: '2023-12-01', description: 'Akhir (dikoreksi)', condition: 'rusak ringan', security_classification: 'rahasia', page_count: 5 }));
  assert.equal(res.item_id, a2.item_id);
  assert.deepEqual(res.changed_fields, ['description', 'page_count', 'document_date', 'condition', 'security_classification']);
  assert.deepEqual([res.item_number, res.renumbered_item_count], [1, 2]);
  const after2 = await itemRow(a2.item_id);
  assert.deepEqual({ id: after2.id, no: after2.no_item_definitif, kondisi: after2.kondisi_fisik, sec: after2.klasifikasi_keamanan_akses,
    tahun: after2.tahun_kurun_waktu, nama: after2.nama_file, verif: after2.status_verifikasi_metadata, arsip: after2.arsip_id },
  { id: a2.item_id, no: 1, kondisi: 'RUSAK RINGAN', sec: 'RAHASIA', tahun: 2023, nama: `${a1.berkas_number}_1_Akhir (dikoreksi).pdf`,
    verif: 'TERVERIFIKASI', arsip: before.arsip_id });
  assert.ok(after2.version > before.version);
  assert.equal((await itemRow(a1.item_id)).no_item_definitif, 2);
  const b = await berkasRow(a1.berkas_id);
  assert.deepEqual([b.klasifikasi_keamanan_akses, b.total_halaman, iso(b.tgl_item_awal), b.kurun_waktu], ['RAHASIA', 7, '2023-12-01', '2023–2024']);
  const hist = await owner(pool, `select objek_id, nomor_lama, nomor_baru, alasan, batch_renumber_id from public.riwayat_nomor
                                  where objek_id = any($1) and nomor_lama is not null order by nomor_baru`, [[a1.item_id, a2.item_id]]);
  assert.deepEqual(hist.map((h) => [h.objek_id, h.nomor_lama, h.nomor_baru]), [[a2.item_id, 2, 1], [a1.item_id, 1, 2]]);
  assert.ok(hist.every((h) => h.alasan === 'Penomoran ulang kronologis setelah perubahan metadata item'));
  assert.equal(new Set(hist.map((h) => h.batch_renumber_id)).size, 1);
  const [aud] = await owner(pool, "select * from public.audit_log where action = 'UPDATE' and module = 'EDIT_ARSIP' and object_id = $1", [a2.item_id]);
  assert.equal(aud.actor_user_id, fx.user.petugasA2);
  assert.equal(aud.reason, 'Koreksi data sesuai naskah asli');
  assert.match(aud.summary, /^Sebelum: tanggal 2024-03-10, 2 lembar, ASLI, kondisi tidak dicatat, "Akhir" \| Sesudah: tanggal 2023-12-01, 5 lembar/);
  assert.deepEqual([aud.before_data.no_item, aud.after_data.no_item, aud.after_data.security_classification], [2, 1, 'RAHASIA']);
  // lowering the strictest item lowers the berkas again (strictest ACTIVE item)
  await update(fx.user.petugasA, a2.item_id, await payloadOf(a2.item_id, { security_classification: 'BIASA/TERBUKA' }));
  assert.equal((await berkasRow(a1.berkas_id)).klasifikasi_keamanan_akses, 'BIASA/TERBUKA');
  // a date change that moves a berkas before another renumbers berkas with history
  const other = await manual(fx.user.petugasA, newBerkasTarget({ title: 'Pembanding' }), { document_date: '2023-06-01' });
  const nOther = (await berkasRow(other.berkas_id)).no_berkas_definitif;
  const nKron = (await berkasRow(a1.berkas_id)).no_berkas_definitif;
  assert.ok(nOther < nKron);
  const r2 = await update(fx.user.petugasA, a2.item_id, await payloadOf(a2.item_id, { document_date: '2023-01-01' }));
  assert.ok(r2.renumbered_berkas_count >= 1);
  assert.equal((await berkasRow(a1.berkas_id)).no_berkas_definitif, nOther);
  assert.equal((await berkasRow(other.berkas_id)).no_berkas_definitif, nKron);
  const bh = await owner(pool, `select nomor_lama, nomor_baru from public.riwayat_nomor where objek_id = $1 and jenis_objek = 'BERKAS'
                                order by created_at desc limit 1`, [a1.berkas_id]);
  assert.deepEqual([bh[0].nomor_lama, bh[0].nomor_baru], [nKron, nOther]);
  const dup = await owner(pool, `select no_berkas_definitif from public.berkas where unit_id = $1 and not is_deleted and no_berkas_definitif is not null
                                 group by 1 having count(*) > 1`, [fx.unit.A]);
  assert.deepEqual(dup, []);
});

test('item_update guards: reason, berkas mismatch, deleted, borrowed, invalid fields, no change, roles and units', async () => {
  const m = await manual(fx.user.petugasA, newBerkasTarget({ title: 'Guard edit' }), { description: 'Guard' });
  // Input Manual has no condition field; set one so that clearing it is a change
  await owner(pool, `update public.item set kondisi_fisik = 'BAIK' where id = $1`, [m.item_id]);
  const p = await payloadOf(m.item_id);
  const changed = { ...p, description: 'Guard baru' };
  await expectCode(update(fx.user.petugasA, m.item_id, changed, { reason: 'pendek' }), 'INVALID_INPUT');
  await expectCode(update(fx.user.petugasA, m.item_id, changed, { reason: '' }), 'INVALID_INPUT');
  await expectCode(update(fx.user.petugasA, m.item_id, { ...changed, berkas_id: '' }), 'INVALID_INPUT');
  const other = await manual(fx.user.petugasA, newBerkasTarget({ title: 'Lain' }));
  await expectCode(update(fx.user.petugasA, m.item_id, { ...changed, berkas_id: other.berkas_id }), 'NOT_FOUND');
  for (const bad of [{ page_count: 0 }, { page_count: 'dua' }, { development_level: 'SALINAN' }, { development_level: '' },
    { condition: 'HANCUR' }, { security_classification: '' }, { security_classification: 'PUBLIK' }, { document_date: '2024-02-30' },
    { description: '   ' }]) {
    const e = await expectCode(update(fx.user.petugasA, m.item_id, { ...changed, ...bad }), 'INVALID_INPUT');
    assert.match(e.detail, /p_payload\./);
  }
  const nc = await expectCode(update(fx.user.petugasA, m.item_id, p), 'NO_CHANGES');
  assert.match(nc.message, /Tidak ada perubahan/);
  // blank condition is optional (3.30.5) and counts as a change from BAIK
  assert.deepEqual((await update(fx.user.petugasA, m.item_id, { ...p, condition: '' })).changed_fields, ['condition']);
  assert.equal((await itemRow(m.item_id)).kondisi_fisik, null);
  // loans (one guard: berkas or item status)
  await owner(pool, `update public.item set status_peminjaman = 'DIPINJAM' where id = $1`, [m.item_id]);
  await expectCode(update(fx.user.petugasA, m.item_id, changed), 'OBJECT_BORROWED');
  await owner(pool, `update public.item set status_peminjaman = 'TERSEDIA' where id = $1`, [m.item_id]);
  await owner(pool, `update public.berkas set status_peminjaman = 'DIPINJAM' where id = $1`, [m.berkas_id]);
  await expectCode(update(fx.user.petugasA, m.item_id, changed), 'OBJECT_BORROWED');
  await expectCode(begin(fx.user.petugasA, 'ITEM_PDF_REPLACE', m.item_id), 'OBJECT_BORROWED');
  await owner(pool, `update public.berkas set status_peminjaman = 'TERSEDIA' where id = $1`, [m.berkas_id]);
  // roles / units
  await expectCode(update(fx.user.pimpinanA, m.item_id, changed), 'FORBIDDEN_ROLE');
  await expectCode(update(fx.user.inactiveA, m.item_id, changed), 'ACCOUNT_INACTIVE');
  await expectCode(update(fx.user.petugasB, m.item_id, changed), 'NOT_FOUND');
  await expectCode(update(adminB, m.item_id, changed), 'NOT_FOUND');
  await expectCode(update(null, m.item_id, changed), '42501'); // anon has no EXECUTE
  await expectCode(update(fx.user.petugasA, 'ITM-tidak-ada', changed), 'NOT_FOUND');
  const pusat = await update(fx.user.pusat, m.item_id, changed);
  assert.equal(pusat.ok, true);
  const [aud] = await owner(pool, "select unit_id from public.audit_log where action = 'UPDATE' and request_id = $1", [pusat.request_id]);
  assert.equal(aud.unit_id, fx.unit.A);
  // deleted item
  // (an active numbered berkas never ends up without active items through the RPCs; cancel both)
  await owner(pool, 'update public.item set is_deleted = true where id = $1', [other.item_id]);
  await owner(pool, 'update public.berkas set is_deleted = true where id = $1', [other.berkas_id]);
  await expectCode(update(fx.user.petugasA, other.item_id, { ...(await payloadOf(other.item_id)), description: 'x baru' }), 'NOT_FOUND');
});

test('item_update idempotency: replay returns the stored result once, conflicting replay refused, validate_only has no effect', async () => {
  const m = await manual(fx.user.petugasA, newBerkasTarget({ title: 'Idem edit' }));
  const req = randomUUID();
  const p = await payloadOf(m.item_id, { description: 'Sekali saja' });
  const first = await update(fx.user.petugasA, m.item_id, p, { request_id: req });
  const v = (await itemRow(m.item_id)).version;
  const again = await update(fx.user.petugasA, m.item_id, p, { request_id: req });
  assert.equal(again.replayed, true);
  assert.equal(again.item_number, first.item_number);
  assert.equal((await itemRow(m.item_id)).version, v);
  const audits = await owner(pool, "select count(*)::int n from public.audit_log where action = 'UPDATE' and request_id = $1", [req]);
  assert.equal(audits[0].n, 1);
  await expectCode(update(fx.user.petugasA, m.item_id, { ...p, description: 'Lain lagi' }, { request_id: req }), 'IDEMPOTENCY_CONFLICT');
  await expectCode(rpc(pool, fx.user.petugasA, 'berkas_update_title', { p_request_id: req, p_berkas_id: m.berkas_id,
    p_title: 'x', p_reason: 'alasan cukup panjang' }), 'IDEMPOTENCY_CONFLICT');
  // concurrent identical requests: one effect
  const req2 = randomUUID();
  const p2 = { ...p, description: 'Paralel' };
  const both = await Promise.all([update(fx.user.petugasA, m.item_id, p2, { request_id: req2 }), update(fx.user.petugasA, m.item_id, p2, { request_id: req2 })]);
  assert.deepEqual(both.map((x) => x.replayed).sort(), [false, true]);
  // validate only: no write, no idempotency row, returns the would-be changes (also when there are none)
  const val = await update(fx.user.petugasA, m.item_id, { ...p2, page_count: 9 }, { validate: true, request_id: randomUUID() });
  assert.deepEqual([val.valid, val.changed_fields], [true, ['page_count']]);
  assert.equal((await itemRow(m.item_id)).jumlah_halaman, 2);
  assert.deepEqual((await update(fx.user.petugasA, m.item_id, p2, { validate: true })).changed_fields, []);
  await expectCode(update(fx.user.petugasA, m.item_id, { ...p2, page_count: 0 }, { validate: true }), 'INVALID_INPUT');
});

test('PDF replacement (3.30.5): classification and condition preserved, old file quarantined and admin-only, derivatives invalidated', async () => {
  const m = await withPdf(fx.user.petugasA, newBerkasTarget({ title: 'Ganti PDF' }),
    { description: 'Surat rahasia', security_classification: 'RAHASIA' });
  await owner(pool, `update public.item set kondisi_fisik = 'RUSAK SEDANG' where id = $1`, [m.item_id]);
  // a pending rename of the old file must not survive the replacement
  await owner(pool, `insert into public.drive_tasks (unit_id, kind, drive_id, new_name, object_type, object_id)
                     values ($1, 'RENAME_FILE', $2, 'lama.pdf', 'ITEM', $3)`, [fx.unit.A, m.fileId, m.item_id]);
  const before = await itemRow(m.item_id);
  const { session, fileId } = await replacement(fx.user.petugasA, m.item_id);
  assert.equal(session.drive_name, before.nama_file);
  // the uploaded replacement is not linked before the edit transaction
  assert.equal((await itemRow(m.item_id)).drive_file_id, m.fileId);
  const res = await update(fx.user.petugasA, m.item_id, await payloadOf(m.item_id), { session: session.session_id, reason: 'PDF hasil pindai ulang lebih jelas' });
  assert.deepEqual(res.changed_fields, ['pdf']);
  assert.deepEqual([res.file_replaced, res.drive_file_id, res.old_drive_file_id], [true, fileId, m.fileId]);
  const after = await itemRow(m.item_id);
  assert.deepEqual({ id: after.id, file: after.drive_file_id, sec: after.klasifikasi_keamanan_akses, kondisi: after.kondisi_fisik,
    status: after.status_file, bentuk: after.status_bentuk_digital, size: Number(after.drive_file_size_bytes), replaced: after.file_replaced_at !== null },
  { id: m.item_id, file: fileId, sec: 'RAHASIA', kondisi: 'RUSAK SEDANG', status: 'TERSEDIA', bentuk: 'ALIH MEDIA', size: 2048, replaced: true });
  const [q] = await owner(pool, 'select * from public.karantina where id = $1', [res.quarantine_id]);
  assert.deepEqual({ obj: q.object_id, type: q.object_type, module: q.module, reason: q.reason, status: q.status, rel: q.related_object_id,
    berkas: q.berkas_id, name: q.original_name, owned: q.app_owned, req: q.request_id, actor: q.actor_user_id },
  { obj: m.fileId, type: 'FILE', module: 'EDIT_ARSIP', reason: 'PDF hasil pindai ulang lebih jelas', status: 'QUARANTINED', rel: m.item_id,
    berkas: m.berkas_id, name: before.nama_file, owned: true, req: res.request_id, actor: fx.user.petugasA });
  const [sess] = await owner(pool, 'select consumed_at from public.upload_sessions where id = $1', [session.session_id]);
  assert.ok(sess.consumed_at);
  const [task] = await owner(pool, `select status from public.drive_tasks where drive_id = $1`, [m.fileId]);
  assert.equal(task.status, 'SUPERSEDED');
  const [aud] = await owner(pool, "select reason from public.audit_log where action = 'UPDATE' and request_id = $1", [res.request_id]);
  assert.match(aud.reason, /versi lama dipindahkan ke karantina/);
  // old file: admins of the unit and ADMIN_PUSAT only; new file: every active role of the unit
  const access = async (user, f) => rpc(pool, user, 'get_file_access', { p_drive_file_id: f });
  assert.equal((await access(fx.user.adminA, m.fileId)).object_type, 'KARANTINA');
  assert.equal((await access(fx.user.pusat, m.fileId)).object_id, res.quarantine_id);
  for (const u of [fx.user.petugasA, fx.user.pimpinanA, fx.user.petugasB, adminB]) assert.equal(await access(u, m.fileId), null);
  assert.equal((await access(fx.user.pimpinanA, fileId)).object_id, m.item_id);
  await expectCode(rpc(pool, fx.user.petugasA, 'log_file_access', { p_drive_file_id: m.fileId, p_disposition: 'inline' }), '42501');
  assert.ok((await rpc(pool, fx.user.adminA, 'log_file_access', { p_drive_file_id: m.fileId, p_disposition: 'attachment' })).log_id);
  // the quarantined file can never be re-attached to an active item (it would become readable by everyone)
  const victim = await manual(fx.user.petugasA, existing(m.berkas_id), { description: 'Penerima' });
  const s2 = await begin(fx.user.petugasA, 'ITEM_PDF', victim.item_id);
  await expectCode(gatewayCommit(pool, fx.user.petugasA, s2, { fileId: m.fileId, size: 2048 }), 'UPLOAD_FILE_IN_USE');
  // the consumed session cannot be used again
  await expectCode(update(fx.user.petugasA, m.item_id, await payloadOf(m.item_id), { session: session.session_id }), 'UPLOAD_SESSION_STATE');
  await expectCode(rpc(pool, fx.user.petugasA, 'upload_cancel', { p_session_id: session.session_id }), 'UPLOAD_SESSION_STATE');
});

test('PDF replacement of a LEGACY file (not app-owned): bound in karantina, admin-only, never re-attachable', async () => {
  const m = await manual(fx.user.petugasA, newBerkasTarget({ title: 'PDF lama' }), { description: 'Impor lama' });
  const legacy = 'legacyPdf' + randomUUID().replace(/-/g, '').slice(0, 20);
  await owner(pool, `update public.item set drive_file_id = $2, drive_file_url = 'https://drive.google.com/file/d/' || $2 || '/view',
                       status_file = 'TERSEDIA', nama_file = 'lama.pdf' where id = $1`, [m.item_id, legacy]);
  const r = await replacement(fx.user.petugasA, m.item_id);
  const res = await update(fx.user.petugasA, m.item_id, await payloadOf(m.item_id), { session: r.session.session_id });
  const [q] = await owner(pool, 'select object_id, app_owned, original_name from public.karantina where id = $1', [res.quarantine_id]);
  assert.deepEqual([q.object_id, q.app_owned, q.original_name], [legacy, false, 'lama.pdf']);
  // only the karantina row references the legacy id now: it must still count as "in use"
  const victim = await manual(fx.user.petugasA, existing(m.berkas_id), { description: 'Penerima lama' });
  const s2 = await begin(fx.user.petugasA, 'ITEM_PDF', victim.item_id);
  await expectCode(gatewayCommit(pool, fx.user.petugasA, s2, { fileId: legacy, size: 2048 }), 'UPLOAD_FILE_IN_USE');
  assert.equal(await rpc(pool, fx.user.pimpinanA, 'get_file_access', { p_drive_file_id: legacy }), null);
  assert.equal((await rpc(pool, fx.user.adminA, 'get_file_access', { p_drive_file_id: legacy })).object_type, 'KARANTINA');
  // no rename task is ever queued for the legacy file
  assert.equal((await owner(pool, 'select count(*)::int n from public.drive_tasks where drive_id = $1', [legacy]))[0].n, 0);
});

test('PDF replacement attestation/forgery: other unit, other user, other item, unattested, re-binding a used file', async () => {
  const m = await withPdf(fx.user.petugasA, newBerkasTarget({ title: 'Forgery' }), { description: 'Sasaran' });
  const other = await withPdf(fx.user.petugasA, existing(m.berkas_id), { description: 'Item lain' });
  await expectCode(begin(fx.user.petugasB, 'ITEM_PDF_REPLACE', m.item_id), 'NOT_FOUND');
  await expectCode(begin(fx.user.pimpinanA, 'ITEM_PDF_REPLACE', m.item_id), 'FORBIDDEN_ROLE');
  // unit B attacker: own item, own session, valid attestation, but binds unit A's Drive file id
  const mb = await withPdf(fx.user.petugasB, newBerkasTarget({ title: 'Umpan B' }), {});
  const sb = await begin(fx.user.petugasB, 'ITEM_PDF_REPLACE', mb.item_id);
  await expectCode(gatewayCommit(pool, fx.user.petugasB, sb, { fileId: m.fileId, size: 2048 }), 'UPLOAD_FILE_IN_USE');
  // forged / tampered attestation
  const s = await begin(fx.user.petugasA, 'ITEM_PDF_REPLACE', m.item_id);
  await expectCode(gatewayCommit(pool, fx.user.petugasA, s, { size: 2048, secret: 'kunci-palsu-0123456789-0123456789-abc' }), 'UPLOAD_ATTESTATION_INVALID');
  const at = nowSec();
  const f = driveId();
  const att = attestation({ sessionId: s.session_id, fileId: f, size: 2048, md5: 'aa', mime: 'application/pdf', at });
  await expectCode(rpc(pool, fx.user.petugasA, 'upload_commit', { p_session_id: s.session_id, p_drive_file_id: driveId(), p_drive_url: null,
    p_size: 2048, p_md5: 'aa', p_mime: 'application/pdf', p_attested_at: at, p_attestation: att }), 'UPLOAD_ATTESTATION_INVALID');
  // open (not yet committed) session cannot be consumed
  await expectCode(update(fx.user.petugasA, m.item_id, await payloadOf(m.item_id), { session: s.session_id }), 'UPLOAD_SESSION_STATE');
  await expectCode(gatewayCommit(pool, fx.user.petugasA, s, { size: 2048, mime: 'image/png' }), 'FILE_TYPE');
  await gatewayCommit(pool, fx.user.petugasA, s, { fileId: f, size: 2048 });
  // same unit, other user: cannot consume it
  await expectCode(update(fx.user.petugasA2, m.item_id, await payloadOf(m.item_id), { session: s.session_id }), 'UPLOAD_SESSION_STATE');
  // owner, other item: cannot consume it
  await expectCode(update(fx.user.petugasA, other.item_id, await payloadOf(other.item_id), { session: s.session_id }), 'UPLOAD_SESSION_STATE');
  // other unit with the session id: the item is not even visible
  await expectCode(update(fx.user.petugasB, m.item_id, await payloadOf(m.item_id), { session: s.session_id }), 'NOT_FOUND');
  assert.equal((await itemRow(m.item_id)).drive_file_id, m.fileId);
  // a committed-but-unused replacement may be cancelled (the gateway can trash the file)
  const c = await rpc(pool, fx.user.petugasA, 'upload_cancel', { p_session_id: s.session_id });
  assert.deepEqual([c.status, c.drive_file_id], ['CANCELLED', f]);
  await expectCode(update(fx.user.petugasA, m.item_id, await payloadOf(m.item_id), { session: s.session_id }), 'UPLOAD_SESSION_STATE');
  // size and type limits of the replacement
  await expectCode(begin(fx.user.petugasA, 'ITEM_PDF_REPLACE', m.item_id, { size: 104857600 }), 'FILE_TOO_LARGE');
  await expectCode(begin(fx.user.petugasA, 'ITEM_PDF_REPLACE', m.item_id, { name: 'scan.docx' }), 'FILE_TYPE');
  // replacing an item that has no PDF yet is allowed (3.x Edit) and quarantines nothing
  const bare = await manual(fx.user.petugasA, existing(m.berkas_id), { description: 'Tanpa PDF' });
  const r = await replacement(fx.user.petugasA, bare.item_id);
  const res = await update(fx.user.petugasA, bare.item_id, await payloadOf(bare.item_id), { session: r.session.session_id });
  assert.deepEqual([res.quarantine_id, res.old_drive_file_id, (await itemRow(bare.item_id)).status_bentuk_digital], [null, null, 'ALIH MEDIA']);
});

test('3.30.6: items in berkas with a secondary classification (with or without tertiary) edit and replace PDF; snapshot stays secondary', async () => {
  for (const klas of ['K-PR01', 'K-KU02']) {
    const m = await withPdf(fx.user.petugasA, newBerkasTarget({ title: `Sekunder ${klas}`, classification_id: klas }), { description: 'Sekunder' });
    const code = (await berkasRow(m.berkas_id)).kode_klasifikasi_snapshot;
    const r = await replacement(fx.user.petugasA, m.item_id);
    await update(fx.user.petugasA, m.item_id, await payloadOf(m.item_id, { description: 'Sekunder diubah' }), { session: r.session.session_id });
    assert.equal((await berkasRow(m.berkas_id)).kode_klasifikasi_snapshot, code);
    assert.equal((await berkasRow(m.berkas_id)).klasifikasi_id, klas);
    assert.equal((await itemRow(m.item_id)).kode_klasifikasi_snapshot, code);
  }
});

test('Sprint 6 hook: a content index built from the old PDF becomes STALE when the table exists', async () => {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('create table public.content_documents (unit_id uuid, item_id text, source_pdf_id text, status text)');
    await c.query(`insert into public.content_documents values ($1, 'ITM-x', 'old-pdf-0000001', 'READY'), ($1, 'ITM-x', 'new-pdf-0000001', 'READY')`, [fx.unit.A]);
    const { rows: [r] } = await c.query(`select app.invalidate_file_derivatives($1, 'ITM-x', 'old-pdf-0000001', 'REQ') as j`, [fx.unit.A]);
    assert.deepEqual([r.j.content_index, r.j.content_documents_stale], ['MARKED', 1]);
    const { rows } = await c.query('select source_pdf_id, status from public.content_documents order by 1');
    assert.deepEqual(rows.map((x) => [x.source_pdf_id, x.status]), [['new-pdf-0000001', 'READY'], ['old-pdf-0000001', 'STALE']]);
  } finally {
    await c.query('rollback');
    c.release();
  }
  const { rows: [r] } = await pool.query(`select app.invalidate_file_derivatives($1, 'ITM-x', 'old-pdf-0000001', 'REQ') as j`, [fx.unit.A]);
  assert.equal(r.j.content_index, 'NOT_INSTALLED');
});

test('berkas_update_title (3.27): guards, v4 folder rename task only, legacy folder untouched, idempotent, audited', async () => {
  const m = await manual(fx.user.petugasA, newBerkasTarget({ title: 'Judul lama' }));
  const call = (user, title, extra = {}) => rpc(pool, user, 'berkas_update_title', { p_request_id: extra.request_id || randomUUID(),
    p_berkas_id: extra.berkas || m.berkas_id, p_title: title, p_reason: extra.reason ?? 'Judul disesuaikan dengan isi berkas' });
  await expectCode(call(fx.user.petugasA, 'Judul baru', { reason: 'singkat' }), 'INVALID_INPUT');
  await expectCode(call(fx.user.petugasA, '  '), 'INVALID_INPUT');
  await expectCode(call(fx.user.petugasA, ' Judul   lama '), 'NO_CHANGES');
  await expectCode(call(fx.user.pimpinanA, 'Judul baru'), 'FORBIDDEN_ROLE');
  await expectCode(call(fx.user.petugasB, 'Judul baru'), 'NOT_FOUND');
  await owner(pool, `update public.berkas set status_peminjaman = 'DIPINJAM' where id = $1`, [m.berkas_id]);
  const e = await expectCode(call(fx.user.petugasA, 'Judul baru'), 'OBJECT_BORROWED');
  assert.match(e.message, /Berkas sedang dipinjam/);
  await owner(pool, `update public.berkas set status_peminjaman = 'TERSEDIA' where id = $1`, [m.berkas_id]);
  // no v4 folder yet: no task
  const r1 = await call(fx.user.petugasA, 'Judul baru');
  assert.deepEqual([r1.old_title, r1.title, r1.drive_tasks], ['Judul lama', 'Judul baru', []]);
  // legacy + v4 folder: only the app-owned v4 folder is renamed
  await owner(pool, `update public.berkas set drive_folder_id = 'fld-legacy-judul-01', v4_drive_folder_id = 'fld-v4-judul-0001' where id = $1`, [m.berkas_id]);
  const req = randomUUID();
  const r2 = await call(fx.user.petugasA, 'Judul: final/2024', { request_id: req });
  assert.deepEqual(r2.drive_tasks.map((t) => [t.kind, t.drive_id, t.new_name]),
    [['RENAME_FOLDER', 'fld-v4-judul-0001', `${m.berkas_number}_Judul- final-2024`]]);
  const b = await berkasRow(m.berkas_id);
  assert.deepEqual([b.judul_berkas, b.drive_folder_id], ['Judul: final/2024', 'fld-legacy-judul-01']);
  assert.equal((await call(fx.user.petugasA, 'Judul: final/2024', { request_id: req })).replayed, true);
  await expectCode(call(fx.user.petugasA, 'Judul lain', { request_id: req }), 'IDEMPOTENCY_CONFLICT');
  const tasks = await owner(pool, `select count(*)::int n from public.drive_tasks where drive_id = 'fld-v4-judul-0001' and status = 'PENDING'`);
  assert.equal(tasks[0].n, 1);
  const [aud] = await owner(pool, "select summary, reason from public.audit_log where action = 'UPDATE_TITLE' and request_id = $1", [req]);
  assert.deepEqual([aud.summary, aud.reason], ['Sebelum: "Judul baru" | Sesudah: "Judul: final/2024"', 'Judul disesuaikan dengan isi berkas']);
  await owner(pool, 'update public.berkas set is_deleted = true where id = $1', [m.berkas_id]);
  await expectCode(call(fx.user.petugasA, 'Setelah batal'), 'NOT_FOUND');
});

test('quarantine visibility: RLS admins of the unit and ADMIN_PUSAT only; quarantine_list for admins', async () => {
  const m = await withPdf(fx.user.petugasA, newBerkasTarget({ title: 'Karantina RLS' }), {});
  const r = await replacement(fx.user.petugasA, m.item_id);
  const res = await update(fx.user.petugasA, m.item_id, await payloadOf(m.item_id), { session: r.session.session_id });
  const mb = await withPdf(fx.user.petugasB, newBerkasTarget({ title: 'Karantina B' }), {});
  const rb = await replacement(fx.user.petugasB, mb.item_id);
  const resB = await update(fx.user.petugasB, mb.item_id, await payloadOf(mb.item_id), { session: rb.session.session_id });
  const visible = async (user) => {
    const c = await pool.connect();
    try {
      await c.query('begin');
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: 'authenticated' })]);
      await c.query('set local role authenticated');
      const { rows } = await c.query('select id from public.karantina where id = any($1)', [[res.quarantine_id, resB.quarantine_id]]);
      return rows.map((x) => x.id).sort();
    } finally { await c.query('rollback'); c.release(); }
  };
  assert.deepEqual(await visible(fx.user.adminA), [res.quarantine_id]);
  assert.deepEqual(await visible(adminB), [resB.quarantine_id]);
  assert.deepEqual(await visible(fx.user.pusat), [res.quarantine_id, resB.quarantine_id].sort());
  for (const u of [fx.user.petugasA, fx.user.pimpinanA, fx.user.petugasB, fx.user.inactiveA]) assert.deepEqual(await visible(u), []);
  const list = await rpc(pool, fx.user.adminA, 'quarantine_list', {});
  assert.ok(list.items.some((x) => x.id === res.quarantine_id && x.downloadable && x.moved_in_drive === false));
  assert.ok(!list.items.some((x) => x.id === resB.quarantine_id));
  await expectCode(rpc(pool, fx.user.petugasA, 'quarantine_list', {}), 'FORBIDDEN_ROLE');
  await expectCode(rpc(pool, fx.user.pimpinanA, 'quarantine_list', {}), 'FORBIDDEN_ROLE');
  await expectCode(rpc(pool, fx.user.pusat, 'quarantine_list', {}), 'UNIT_REQUIRED');
  assert.ok((await rpc(pool, fx.user.pusat, 'quarantine_list', { p_unit_id: fx.unit.B })).items.some((x) => x.id === resB.quarantine_id));
  // nobody can write the table directly, and rows are never hard-deleted
  await expectCode(rpc(pool, fx.user.adminA, 'quarantine_list', { p_unit_id: fx.unit.B }), 'FORBIDDEN_UNIT');
  await expectCode(owner(pool, 'delete from public.karantina where id = $1', [res.quarantine_id]), '42501');
});
