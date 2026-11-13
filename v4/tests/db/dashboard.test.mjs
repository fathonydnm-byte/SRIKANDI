// 0009_dashboard_overview: counts, Daftar Isi Berkas, shortcut lists.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { newPool, createFixture, asUser, asAnon, asService, expectSqlError } from './helpers.mjs';

const pool = newPool();
let fx;
let T;
const id = (k) => `BRK-${T}-${k}`;

before(async () => {
  fx = await createFixture(pool);
  T = `D${fx.tag}`;
  const A = fx.unit.A;
  await asService(pool, async (c) => {
    const berkas = [
      // key, no, days to batas_aktif, extra
      ['D0', 10, 0, {}],
      ['D7', 11, 7, {}],
      ['D8', 12, 8, {}],
      ['DM1', 13, -1, {}],
      ['P', 14, -3, { usul_pindah_id_aktif: 'USL-1', usul_pindah_no_aktif: 'UP-2025-001' }],
      ['TR', 15, -10, { status_pemindahan: 'SUDAH DIPINDAHKAN' }],
      ['DEL', 16, -5, { is_deleted: true, status_berkas: 'DIHAPUS' }],
      ['DR', null, null, { status_berkas: 'DRAFT' }],
      ['LOAN', 17, 100, { status_peminjaman: 'DIPINJAM' }],
      ['ITL', 18, 100, {}],
    ];
    for (const [k, no, days, extra] of berkas) {
      await c.query(
        `insert into public.berkas (id, unit_id, no_berkas_definitif, judul_berkas, kode_klasifikasi_snapshot, kurun_waktu,
           no_filling_kabinet, no_laci, batas_aktif, status_berkas, is_deleted, status_pemindahan, status_peminjaman,
           usul_pindah_id_aktif, usul_pindah_no_aktif)
         values ($1, $2, $3, $4, 'KS.01.1', '2023', 'A1', '1',
           case when $5::int is null then null else app.today_jakarta() + $5::int end,
           $6, $7, $8, $9, $10, $11)`,
        [id(k), A, no, `Berkas ${k} ${T}`, days, extra.status_berkas ?? 'AKTIF', extra.is_deleted ?? false,
         extra.status_pemindahan ?? null, extra.status_peminjaman ?? 'TERSEDIA', extra.usul_pindah_id_aktif ?? null,
         extra.usul_pindah_no_aktif ?? null]);
    }
    const items = [
      ['D0', 1, 3, 'Notulen rapat zebra', false, 'TERSEDIA'],
      ['D0', 2, 4, 'Undangan rapat', false, 'TERSEDIA'],
      ['D0', 3, 9, 'Item terhapus', true, 'TERSEDIA'],
      ['ITL', 1, 2, 'Item dipinjam', false, 'DIPINJAM'],
      ['TR', 1, 5, 'Item berkas pindah zebra', false, 'TERSEDIA'],
    ];
    for (const [k, no, pages, uraian, del, loan] of items) {
      await c.query(
        `insert into public.item (id, unit_id, berkas_id, no_item_definitif, jumlah_halaman, uraian_lengkap, is_deleted, status_peminjaman)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [`ITM-${T}-${k}-${no}`, A, id(k), no, pages, uraian, del, loan]);
    }
  });
});
after(async () => { await pool.end(); });

const call = (u, sql, params = []) => asUser(pool, fx.user[u], async (c) => (await c.query(sql, params)).rows[0].r);
const overview = (u, unit = null) => call(u, 'select public.dashboard_overview($1) r', [unit]);
const shortcut = (u, kind, unit = null) => call(u, 'select public.dashboard_shortcut($1, $2) r', [kind, unit]);

test('SECURITY INVOKER, authenticated only; anon denied', async () => {
  for (const f of ['public.dashboard_overview(uuid)', 'public.dashboard_shortcut(text, uuid)',
                   'public.dashboard_berkas_items(text[])', 'public.dashboard_match_berkas(text, uuid)']) {
    const { rows: [r] } = await pool.query(
      `select prosecdef secdef, has_function_privilege('anon', $1, 'EXECUTE') anon,
              has_function_privilege('authenticated', $1, 'EXECUTE') auth from pg_proc where oid = $1::regprocedure`, [f]);
    assert.deepEqual(r, { secdef: false, anon: false, auth: true }, f);
  }
  for (const sql of ['select public.dashboard_overview()', "select public.dashboard_shortcut('H7')",
                     "select public.dashboard_berkas_items(array['x'])", "select public.dashboard_match_berkas('x')"]) {
    await asAnon(pool, async (c) => { await expectSqlError(c.query(sql)); });
  }
});

test('five counts follow legacy getDashboardSummary_', async () => {
  const o = await overview('petugasA');
  // fixture berkas + D0 D7 D8 DM1 P DR LOAN ITL (TR transferred, DEL deleted)
  assert.deepEqual(o.counts, { total_berkas: 9, total_item: 4, sedang_dipinjam: 2, retensi_h7: 2, habis_aktif: 2 });
  assert.match(o.today, /^\d{4}-\d{2}-\d{2}$/);
  // all roles of the unit see the same; ADMIN_PUSAT can narrow to the unit
  assert.deepEqual((await overview('pimpinanA')).counts, o.counts);
  assert.deepEqual((await overview('pusat', fx.unit.A)).counts, o.counts);
});

test('Daftar Isi Berkas: numbered active berkas in order, totals, location, status badge', async () => {
  const o = await overview('petugasA');
  const nos = o.groups.map((g) => g.no_berkas);
  assert.deepEqual(nos, [1, 10, 11, 12, 13, 14, 17, 18]);
  const g = Object.fromEntries(o.groups.map((x) => [x.berkas_id, x]));
  assert.equal(g[id('D0')].item_count, 2);
  assert.equal(g[id('D0')].total_lembar, 7);
  assert.equal(g[id('D0')].lokasi, 'Kabinet A1 · Laci 1 · Folder 10');
  assert.equal(g[id('D0')].kode_klasifikasi, 'KS.01.1');
  assert.equal(g[id('D0')].kurun_waktu, '2023');
  const badges = Object.fromEntries(['D0', 'D7', 'D8', 'DM1', 'P', 'LOAN'].map((k) => [k, [g[id(k)].status_code, g[id(k)].status_label]]));
  assert.deepEqual(badges, {
    D0: ['DUE', 'H-0'], D7: ['DUE', 'H-7'], D8: ['ACTIVE', 'AKTIF'],
    DM1: ['EXPIRED', 'HABIS AKTIF – KANDIDAT USUL PINDAH'], P: ['PROPOSED', 'DALAM USUL PEMINDAHAN'],
    LOAN: ['ACTIVE', 'AKTIF'],
  });
  assert.equal(g[fx.ids.A.berkas].status_code, 'PENDING');
  assert.equal(g[id('LOAN')].dipinjam, true);
  assert.equal(g[id('ITL')].dipinjam, true);
});

test('shortcut lists: H-7 (0..7 incl. proposed), Habis Aktif (<0), Dipinjam', async () => {
  const ids = (rows) => rows.map((r) => r.berkas_id);
  assert.deepEqual(ids(await shortcut('petugasA', 'H7')), [id('D0'), id('D7')]);
  const habis = await shortcut('petugasA', 'habis');
  assert.deepEqual(ids(habis), [id('P'), id('DM1')]);
  assert.equal(habis[0].days_to_active_limit, -3);
  assert.equal(habis[0].usul_pindah_no, 'UP-2025-001');
  const loans = await shortcut('petugasA', 'DIPINJAM');
  assert.deepEqual(ids(loans), [id('LOAN'), id('ITL')]);
  assert.equal(loans[1].item_dipinjam, 1);
  assert.equal(loans[0].status_peminjaman, 'DIPINJAM');
  // empty list is a valid answer
  assert.deepEqual(await shortcut('petugasB', 'H7'), []);
  await asUser(pool, fx.user.petugasA, async (c) => {
    await expectSqlError(c.query("select public.dashboard_shortcut('SEMUA')"), '22023');
  });
});

test('unit isolation and inactive users', async () => {
  const b = await overview('petugasB');
  assert.deepEqual(b.counts, { total_berkas: 1, total_item: 1, sedang_dipinjam: 0, retensi_h7: 0, habis_aktif: 0 });
  assert.deepEqual(b.groups.map((x) => x.berkas_id), [fx.ids.B.berkas]);
  assert.deepEqual((await overview('pusat', fx.unit.B)).counts, b.counts);
  for (const u of ['inactiveA', 'noProfile', 'unitInactive']) {
    const o = await overview(u);
    assert.deepEqual(o.counts, { total_berkas: 0, total_item: 0, sedang_dipinjam: 0, retensi_h7: 0, habis_aktif: 0 }, u);
    assert.deepEqual(o.groups, [], u);
  }
  assert.deepEqual(await shortcut('petugasB', 'HABIS'), []);
});

test('dashboard_berkas_items: batch, ordered, active items only, RLS', async () => {
  const r = await call('petugasA', 'select public.dashboard_berkas_items($1) r', [[id('D0'), id('ITL'), fx.ids.B.berkas]]);
  assert.deepEqual(Object.keys(r).sort(), [id('D0'), id('ITL')].sort());
  assert.deepEqual(r[id('D0')].map((i) => [i.no_item, i.uraian, i.jumlah_halaman]), [[1, 'Notulen rapat zebra', 3], [2, 'Undangan rapat', 4]]);
  assert.equal(r[id('ITL')][0].status_peminjaman, 'DIPINJAM');
  const b = await call('petugasB', 'select public.dashboard_berkas_items($1) r', [[id('D0')]]);
  assert.deepEqual(b, {});
  await asUser(pool, fx.user.petugasA, async (c) => {
    await expectSqlError(c.query('select public.dashboard_berkas_items($1)', [Array.from({ length: 101 }, (_, i) => `X${i}`)]), '22023');
  });
});

test('dashboard_match_berkas: item text (no. item, no. surat, uraian), all tokens, RLS', async () => {
  const m = (u, q) => call(u, 'select public.dashboard_match_berkas($1) r', [q]);
  assert.deepEqual(await m('petugasA', 'ZEBRA notulen'), [id('D0')]);
  assert.deepEqual(await m('petugasA', 'zebra'), [id('D0')]); // transferred berkas TR is not offered
  assert.deepEqual(await m('petugasA', 'zebra undangan'), []);
  assert.deepEqual(await m('petugasA', '   '), []);
  assert.deepEqual(await m('petugasB', 'zebra'), []);
});

test('trigram candidates under RLS: definer helpers stay inside the caller unit', async () => {
  const ids = (u, tok, unit = null) => call(u, 'select app.trgm_item_ids($1, $2) r', [tok, unit]);
  const a = await ids('petugasA', 'ZEBRA');
  assert.deepEqual([...a].sort(), [`ITM-${T}-D0-1`, `ITM-${T}-TR-1`].sort()); // raw candidates; callers re-check status
  assert.deepEqual(await ids('petugasB', 'ZEBRA'), []);
  assert.deepEqual(await ids('petugasB', 'ZEBRA', fx.unit.A), []); // p_unit_id cannot widen a unit user
  assert.deepEqual(await ids('inactiveA', 'ZEBRA'), []);
  assert.equal((await ids('pusat', 'ZEBRA', fx.unit.A)).length, 2);
  assert.deepEqual(await ids('petugasA', '%'), []); // only normalised tokens are accepted
  const cand = await call('petugasA', 'select app.trgm_candidate_items($1, null) r', [T]); // berkas title token
  assert.ok(cand.includes(`ITM-${T}-D0-1`));
  assert.deepEqual(await call('petugasB', 'select app.trgm_candidate_items($1, null) r', [T]), []);
  const { rows: [r] } = await pool.query(
    `select has_function_privilege('anon', 'app.trgm_item_ids(text, uuid)', 'EXECUTE') a1,
            has_function_privilege('anon', 'app.trgm_candidate_items(text, uuid)', 'EXECUTE') a2`);
  assert.deepEqual(r, { a1: false, a2: false });
});

test('stored search_doc columns follow the 0006 normalisation', async () => {
  const { rows: [r] } = await pool.query(
    `select search_doc = app.item_search_doc(no_surat_utama, no_surat_alternatif, no_surat_display, uraian_lengkap,
              kode_klasifikasi_snapshot, no_item_definitif, nama_file, kondisi_fisik) ok, search_doc
       from public.item where id = $1`, [`ITM-${T}-D0-1`]);
  assert.equal(r.ok, true);
  assert.match(r.search_doc, /NOTULEN RAPAT ZEBRA/);
});
