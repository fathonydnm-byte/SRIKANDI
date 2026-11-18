import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  configureSecret, newPool, rpc, expectCode, owner, createS2Fixture, newBerkasTarget, gatewayCommit, driveId,
} from './s2_fixture.mjs';

let pool;
let fx;
before(async () => {
  await configureSecret();
  pool = newPool();
  fx = await createS2Fixture(pool);
});
after(async () => { await pool?.end(); });

async function prepare(who) {
  const user = fx.user[who];
  const item = await rpc(pool, user, 'item_create_manual', {
    p_request_id: randomUUID(), p_target: newBerkasTarget({ title: 'Judul metadata' }),
    p_item: { description: 'Uraian metadata', page_count: 3, development_level: 'ASLI',
      security_classification: 'RAHASIA', document_date: '2026-04-01' },
  });
  const session = await rpc(pool, user, 'upload_begin', {
    p_request_id: randomUUID(), p_purpose: 'ITEM_PDF', p_object_id: item.item_id,
    p_file_name: 'scan.pdf', p_mime: 'application/pdf', p_size: 1234,
  });
  return { ...item, ...session, owner: user };
}

const index = (session, pages, who) => rpc(pool, who ? fx.user[who] : session.owner, 'index_scan_content', {
  p_session_id: session.session_id, p_pages: JSON.stringify(pages),
});
const find = (query, who = 'petugasA', extra = {}) => rpc(pool, who ? fx.user[who] : null, 'search_scan_content', {
  p_query: query, ...extra,
});

test('stores only after a committed upload, checks its owner and rejects malformed content', async () => {
  const input = await prepare('petugasA');
  await expectCode(index(input, ['Mawar singa']), 'UPLOAD_SESSION_STATE');
  await gatewayCommit(pool, input.owner, input);
  await expectCode(index(input, ['Mawar singa'], 'petugasA2'), 'NOT_FOUND');
  await expectCode(index(input, ['Mawar singa'], 'petugasB'), 'NOT_FOUND');
  await expectCode(index(input, [null, { text: 'teks' }]), 'INVALID_INPUT');
  await expectCode(index(input, [null, '   ']), 'INVALID_INPUT');
  await expectCode(index(input, ['X'.repeat(8001)]), 'INVALID_INPUT');
  await expectCode(index(input, Array(7).fill('X'.repeat(8000))), 'INVALID_INPUT');
  assert.deepEqual(await index(input, [null, 'Mawar singa hari ini', 'Singa melihat mawar']), { indexed_pages: 2 });
  assert.deepEqual(await index(input, ['Teks pengganti yang diabaikan']), { indexed_pages: 2 });
  const found = await find('mawar singa', 'pimpinanA', { p_phrase: true });
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].page_no, 2);
  assert.equal(found.results[0].item_id, input.item_id);
  assert.match(found.results[0].snippet, /Mawar singa/);
  const page1 = await find('mawar singa', 'petugasA', { p_limit: 1 });
  assert.equal(page1.has_more, true);
  const page2 = await find('mawar singa', 'petugasA', { p_limit: 1, p_offset: 1 });
  assert.equal(page2.has_more, false);
  assert.notEqual(page2.results[0].page_no, page1.results[0].page_no);
  assert.deepEqual((await find('teks pengganti')).results, []);
  assert.deepEqual((await find('uraian metadata')).results, []);
});

test('isolates page excerpts by unit and hides raw documents from clients', async () => {
  const input = await prepare('petugasB');
  await gatewayCommit(pool, input.owner, input);
  await index(input, ['Kepala surat kamboja']);
  assert.deepEqual((await find('kamboja')).results, []);
  await expectCode(find('kamboja', 'petugasA', { p_unit_id: fx.unit.B }), 'FORBIDDEN_UNIT');
  const central = (await find('kamboja', 'pusat')).results;
  assert.equal(central[0]?.item_id, input.item_id);
  assert.deepEqual((await find('kamboja', 'pusat', { p_unit_id: fx.unit.A })).results, []);
  assert.deepEqual((await find('kamboja', 'pusat', { p_unit_id: fx.unit.B })).results, central);
  await expectCode(find('kamboja', 'inactiveA'), 'ACCOUNT_INACTIVE');
  await expectCode(find('kamboja', null), '42501');
  const [{ raw, docs }] = await owner(pool, "select has_table_privilege('authenticated', 'app.content_pages', 'SELECT') raw, has_table_privilege('authenticated', 'public.content_documents', 'SELECT') docs");
  assert.deepEqual([raw, docs], [false, false]);
});

test('removed/replaced sources are immediately hidden and old text is purged by the Sprint 3 hook', async () => {
  const input = await prepare('petugasA');
  const upload = await gatewayCommit(pool, input.owner, input);
  await index(input, ['Bagian astronomi']);
  assert.equal((await find('astronomi')).results.length, 1);
  await owner(pool, 'update public.item set is_deleted=true where id=$1', [input.item_id]);
  assert.deepEqual((await find('astronomi')).results, []);
  await expectCode(index(input, ['Astronomi']), 'NOT_FOUND');
  await owner(pool, 'update public.item set is_deleted=false, drive_file_id=$2 where id=$1', [input.item_id, driveId()]);
  assert.deepEqual((await find('astronomi')).results, []);
  const [{ change }] = await owner(pool, 'select app.invalidate_file_derivatives($1, $2, $3, $4) change',
    [fx.unit.A, input.item_id, upload.drive_file_id, 'UJI']);
  assert.deepEqual([change.content_index, change.content_documents_stale], ['MARKED', 1]);
  assert.deepEqual(await owner(pool, 'select status from public.content_documents where item_id=$1', [input.item_id]), [{ status: 'STALE' }]);
  assert.deepEqual(await owner(pool, 'select * from app.content_pages where item_id=$1', [input.item_id]), []);
});
