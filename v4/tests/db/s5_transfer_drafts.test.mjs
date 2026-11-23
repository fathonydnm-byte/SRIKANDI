import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createS2Fixture, expectCode, newPool, owner, rpc } from './s2_fixture.mjs';
import { asUser, expectSqlError } from './helpers.mjs';

const pool = newPool();
let fx;
const folder = n => `S5-B-${fx.tag}-${n}`;
const item = n => `S5-I-${fx.tag}-${n}`;
const use = (fn, args, who = 'adminA', unit = null) => rpc(pool, fx.user[who], fn, { p_unit_id: unit, ...args });
const candidates = (filter, who, unit) => use('retention_candidates', { p_filter: filter, p_offset: 0 }, who, unit);
function create(ids, request = randomUUID(), who, unit, title = 'Usul uji') {
  return use('transfer_draft_create', { p_berkas_ids: ids, p_request_id: request, p_title: title, p_notes: '' }, who, unit);
}
function cancel(id, reason = 'Susunan perlu diperiksa ulang.', request = randomUUID()) {
  return use('transfer_draft_cancel', { p_draft_id: id, p_reason: reason, p_request_id: request });
}

before(async () => {
  fx = await createS2Fixture(pool);
  for (const [n, days] of [[1,-3],[2,0],[3,7],[4,-2],[5,-2],[6,-2],[7,-2],[8,-2],[9,8],[10,-1],[11,-1]]) {
    const u = n === 8 ? fx.unit.B : fx.unit.A;
    await owner(pool, `insert into public.berkas(unit_id,id,no_berkas_definitif,judul_berkas,status_berkas,batas_aktif,
      status_verifikasi_metadata,usul_pindah_id_aktif,status_pemindahan,retensi_acuan_mode,tgl_acuan_retensi,batas_inaktif)
      values ($1,$2,$3,$2,'AKTIF',app.today_jakarta()+$4::integer,$5,$6,$7,'MANUAL',app.today_jakarta()-365,app.today_jakarta()+365)`, [
      u,folder(n),n,days,n===5?'PERLU VERIFIKASI':'TERVERIFIKASI',n===6?'USP-LEGACY':null,n===7?'SUDAH DIPINDAHKAN':null,
    ]);
    if (n !== 10) await owner(pool, `insert into public.item(unit_id,id,berkas_id,no_item_definitif,uraian_lengkap,jumlah_halaman,status_peminjaman)
      values ($1,$2,$3,1,$2,2,$4)`, [u,item(n),folder(n),n===4?'DIPINJAM':'TERSEDIA']);
  }
});
after(() => pool.end());

test('retention day boundaries and blocking reasons use only selected unit data', async () => {
  assert.deepEqual((await candidates('H7')).map(r => r.no_berkas), [2,3]);
  const expired = await candidates('HABIS');
  assert.deepEqual(expired.map(r => r.no_berkas), [1,4,5,6,10,11]);
  assert.deepEqual(expired.filter(r => !r.blocked_reason).map(r => r.no_berkas), [1,11]);
  assert.match(expired.find(r => r.no_berkas===4).blocked_reason,/dipinjam/);
  assert.match(expired.find(r => r.no_berkas===5).blocked_reason,/belum terverifikasi/);
  assert.match(expired.find(r => r.no_berkas===6).blocked_reason,/usul pemindahan/);
  assert.match(expired.find(r => r.no_berkas===10).blocked_reason,/belum memiliki/);
  await expectCode(candidates('HABIS','petugasB',fx.unit.A),'FORBIDDEN_UNIT');
  await expectCode(candidates('HABIS','pimpinanA'),'FORBIDDEN_ROLE');
  await expectCode(candidates('HABIS','pusat'),'UNIT_REQUIRED');
  assert.deepEqual((await candidates('HABIS','pusat',fx.unit.B)).map(r=>r.no_berkas),[8]);
  await expectCode(create([folder(8)]),'NOT_FOUND');
  await expectCode(create(Array(201).fill(folder(1))),'INVALID_INPUT');
  await expectCode(create([folder(1),folder(1)]),'INVALID_INPUT');
  await expectCode(create([folder(1),folder(4)]),'TRANSFER_INELIGIBLE');
  assert.equal((await owner(pool,'select usul_pindah_id_aktif from public.berkas where unit_id=$1 and id=$2',[fx.unit.A,folder(1)]))[0].usul_pindah_id_aktif,null);
});

test('draft creation reserves folders once, captures immutable item metadata and cancel releases only its folders', async () => {
  const request = randomUUID();
  const draft = await create([folder(11),folder(1)],request);
  const again = await create([folder(1),folder(11)],request);
  assert.equal(again.id,draft.id);
  assert.equal(again.replayed,true);
  assert.match(draft.draft_number,/^DRAF-\d{4}-0001$/);
  await expectCode(create([folder(1)],request),'IDEMPOTENCY_CONFLICT');
  await expectCode(create([folder(1)]),'TRANSFER_INELIGIBLE');
  const get = (who,unit) => use('transfer_draft_get',{ p_draft_id: draft.id },who,unit);
  await expectCode(get('petugasB'),'NOT_FOUND');
  await asUser(pool,fx.user.adminA,c=>expectSqlError(c.query('select * from public.transfer_draft_items')));
  const expected = await get('petugasA2');
  assert.deepEqual(expected.map(r=>r.number),[1,11]);
  const check = (who, unit) => use('transfer_draft_check', { p_draft_id: draft.id }, who, unit);
  await expectCode(check('petugasB'), 'NOT_FOUND');
  await expectCode(check('pimpinanA'), 'FORBIDDEN_ROLE');
  assert.deepEqual(await check(), { eligible: true, issues: [] });
  await owner(pool, "update public.item set status_peminjaman='DIPINJAM' where unit_id=$1 and id=$2", [fx.unit.A,item(11)]);
  assert.match((await check()).issues[0].reason, /dipinjam/);
  await owner(pool, "update public.item set status_peminjaman='TERSEDIA' where unit_id=$1 and id=$2", [fx.unit.A,item(11)]);
  assert.deepEqual(await check(), { eligible: true, issues: [] });
  const rows = await owner(pool,'select snapshot from public.transfer_draft_items where unit_id=$1 and draft_id=$2 order by item_id',[fx.unit.A,draft.id]);
  assert.equal(rows.length,2);
  assert.equal(rows[0].snapshot.title,item(1));
  await owner(pool,"update public.item set uraian_lengkap='Diubah setelah draf' where unit_id=$1 and id=$2",[fx.unit.A,item(1)]);
  await owner(pool,"update public.berkas set judul_berkas='Diubah setelah draf' where unit_id=$1 and id=$2",[fx.unit.A,folder(11)]);
  const blocked = await check();
  assert.equal(blocked.eligible, false);
  assert.deepEqual(blocked.issues.map(r => r.number), [1, 11]);
  assert.match(blocked.issues[0].reason, /data item berubah/);
  assert.match(blocked.issues[1].reason, /Data berkas berubah/);
  assert.deepEqual(await get(),expected);
  assert.equal((await owner(pool,'select snapshot from public.transfer_draft_items where unit_id=$1 and draft_id=$2 and item_id=$3',[fx.unit.A,draft.id,item(1)]))[0].snapshot.title,item(1));

  await expectCode(cancel(draft.id,'x'),'INVALID_INPUT');
  const cancelId=randomUUID();
  await cancel(draft.id,undefined,cancelId);
  assert.equal((await cancel(draft.id,undefined,cancelId)).replayed,true);
  await expectCode(check(), 'ALREADY_CANCELLED');
  await expectCode(cancel(draft.id),'ALREADY_CANCELLED');
  assert.ok((await candidates('HABIS')).find(r=>r.berkas_id===folder(1) && !r.blocked_reason));
  const afterCancel = (await use('transfer_drafts_list',{ p_offset:0 }))[0];
  assert.ok(afterCancel.cancelled_at);
  assert.equal(afterCancel.item_count,2);
  assert.deepEqual(await get(),expected);
  const [other] = await owner(pool,'select usul_pindah_id_aktif from public.berkas where unit_id=$1 and id=$2',[fx.unit.A,folder(6)]);
  assert.equal(other.usul_pindah_id_aktif,'USP-LEGACY');
  const phases = await owner(pool,'select status_berkas,status_pemindahan from public.berkas where unit_id=$1 and id=$2',[fx.unit.A,folder(1)]);
  assert.deepEqual(phases,[{status_berkas:'AKTIF',status_pemindahan:null}]);
});

test('two operators cannot reserve the same folder concurrently', async () => {
  const rs = await Promise.allSettled([create([folder(11)]),create([folder(11)],randomUUID(),'petugasA2')]);
  const ok = rs.find(a=>a.status==='fulfilled');
  assert.equal(rs.filter(a=>a.status==='fulfilled').length,1);
  assert.equal(rs.find(a=>a.status==='rejected').reason.hint,'TRANSFER_INELIGIBLE');
  assert.match(ok.value.draft_number,/-0002$/);
});
