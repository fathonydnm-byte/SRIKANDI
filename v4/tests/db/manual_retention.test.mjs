import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, before, after } from 'node:test';
import { createS2Fixture, newBerkasTarget, newPool, rpc, owner, expectCode } from './s2_fixture.mjs';

const pool = newPool();
let fx;
before(async () => { fx = await createS2Fixture(pool); });
after(() => pool.end());
const manual = (target,date='2026-01-01') => rpc(pool,fx.user.petugasA,'item_create_manual',{
  p_request_id:randomUUID(),p_target:target,p_item:{
    description:'Arsip uji',page_count:1,document_date:date,development_level:'ASLI',security_classification:'BIASA/TERBUKA',
  },
});
const get = (id,who='petugasA') => rpc(pool,fx.user[who],'berkas_retention_get',{p_berkas_id:id});
const schedule = (date) => ({ retention_reference_date:date, active_retention_value:2, active_retention_unit:'TAHUN',
  inactive_retention_value:3,inactive_retention_unit:'BULAN',final_disposition:'PERMANEN' });
const change = (id,v,date,request=randomUUID()) => rpc(pool,fx.user.petugasA,'berkas_retention_update',{
  p_request_id:request,p_berkas_id:id,p_expected_version:v,p_schedule:schedule(date),p_reason:'Tanggal selesai pekerjaan sudah dikonfirmasi',
});
const limits = (d) => [d.reference_mode,d.retention_reference_date,d.active_limit,d.inactive_limit];

test('registration and renumber use separate dates; a new item cannot move a fixed schedule', async () => {
  const item = await manual(newBerkasTarget(schedule('2026-09-15')));
  const before = await get(item.berkas_id);
  assert.deepEqual(limits(before),['MANUAL','2026-09-15','2028-09-15','2028-12-15']);
  await manual({mode:'EXISTING',berkas_id:item.berkas_id},'2027-01-04');
  const after = await get(item.berkas_id);
  assert.deepEqual(limits(after),limits(before));
  assert.equal((await owner(pool,'select tgl_item_akhir::text d from public.berkas where id=$1',[item.berkas_id]))[0].d,'2027-01-04');
});

test('pending archives have no dates until the reference is set; replay and concurrent edit are safe', async () => {
  const item = await manual(newBerkasTarget(schedule(null)));
  const old = await get(item.berkas_id);
  assert.deepEqual(limits(old),['PENDING',null,null,null]);
  const req = randomUUID();
  const now = await change(item.berkas_id,old.version,'2026-05-04',req);
  assert.deepEqual(limits(now),['MANUAL','2026-05-04','2028-05-04','2028-08-04']);
  assert.equal((await change(item.berkas_id,old.version,'2026-05-04',req)).replayed,true);
  await expectCode(change(item.berkas_id,old.version,'2026-06-04'),'VERSION_CONFLICT');
  await expectCode(get(item.berkas_id,'petugasB'),'NOT_FOUND');
  await expectCode(get(item.berkas_id,'pimpinanA'),'FORBIDDEN_ROLE');
  const [audit] = await owner(pool,"select before_data,after_data from public.audit_log where object_id=$1 and action='UPDATE_RETENTION'",[item.berkas_id]);
  assert.equal(audit.before_data.reference_mode,'PENDING');
  assert.equal(audit.after_data.retention_reference_date,'2026-05-04');
});

test('legacy dates stay visible but block proposals, and a reserved draft must be released first', async () => {
  const item = await manual(newBerkasTarget(schedule(null)));
  await owner(pool,`update public.berkas set retensi_acuan_mode='LEGACY',tgl_acuan_retensi='2020-01-01',
    batas_aktif='2022-01-01',batas_inaktif='2022-04-01' where id=$1`,[item.berkas_id]);
  await manual({mode:'EXISTING',berkas_id:item.berkas_id},'2026-10-04');
  const old = await get(item.berkas_id);
  assert.deepEqual(limits(old),['LEGACY','2020-01-01','2022-01-01','2022-04-01']);
  const candidates = await rpc(pool,fx.user.petugasA,'retention_candidates',{p_unit_id:null,p_filter:'HABIS',p_offset:0});
  assert.match(candidates.find(b=>b.berkas_id===item.berkas_id).blocked_reason,/Konfirmasi tanggal acuan/);
  await owner(pool,"update public.berkas set usul_pindah_id_aktif='DRAF-UJI' where id=$1",[item.berkas_id]);
  await expectCode(change(item.berkas_id,old.version,'2020-02-01'),'RETENTION_LOCKED');
  await owner(pool,"update public.berkas set usul_pindah_id_aktif=null where id=$1",[item.berkas_id]);
  const fixed=await change(item.berkas_id,old.version,'2020-02-01');
  assert.deepEqual(limits(fixed),['MANUAL','2020-02-01','2022-02-01','2022-05-01']);
  const after=await rpc(pool,fx.user.petugasA,'retention_candidates',{p_unit_id:null,p_filter:'HABIS',p_offset:0});
  assert.equal(after.find(b=>b.berkas_id===item.berkas_id).blocked_reason,null);
});
