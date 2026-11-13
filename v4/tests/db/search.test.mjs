// 0006_search: search_archive / get_item_detail / get_berkas_detail /
// dashboard_counts. SECURITY INVOKER, so RLS decides visibility.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { newPool, createFixture, asUser, asAnon, asService, expectSqlError } from './helpers.mjs';

const pool = newPool();
let fx;
let T; // unique token present in every row created here

const SEARCH_SIG = 'public.search_archive(text, text, text, text, date, date, uuid, boolean, integer, integer)';

async function insertBerkas(c, unitId, id, no, judul, extra = {}) {
  const row = {
    kode_klasifikasi_snapshot: 'KU.01', uraian_klasifikasi_snapshot: 'Keuangan umum',
    no_filling_kabinet: null, no_laci: null, no_folder: null, status_berkas: 'AKTIF', is_deleted: false,
    drive_folder_url: null, klasifikasi_keamanan_akses: 'BIASA/TERBUKA', ...extra
  };
  await c.query(
    `insert into public.berkas (id, unit_id, no_berkas_definitif, judul_berkas, kode_klasifikasi_snapshot,
       uraian_klasifikasi_snapshot, no_filling_kabinet, no_laci, no_folder, status_berkas, is_deleted,
       drive_folder_url, klasifikasi_keamanan_akses)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, unitId, no, judul, row.kode_klasifikasi_snapshot, row.uraian_klasifikasi_snapshot, row.no_filling_kabinet,
     row.no_laci, row.no_folder, row.status_berkas, row.is_deleted, row.drive_folder_url, row.klasifikasi_keamanan_akses]
  );
}

async function insertItem(c, unitId, berkasId, id, no, extra = {}) {
  const r = {
    no_surat_utama: null, no_surat_alternatif: null, uraian_lengkap: null, tanggal_naskah: null,
    tingkat_perkembangan: 'ASLI', drive_file_id: null, drive_file_url: null, nama_file: null,
    jumlah_halaman: 1, is_deleted: false, kode_klasifikasi_snapshot: null, kondisi_fisik: null, ...extra
  };
  await c.query(
    `insert into public.item (id, unit_id, berkas_id, no_item_definitif, no_surat_utama, no_surat_alternatif,
       uraian_lengkap, tanggal_naskah, tingkat_perkembangan, drive_file_id, drive_file_url, nama_file,
       jumlah_halaman, is_deleted, kode_klasifikasi_snapshot, kondisi_fisik)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [id, unitId, berkasId, no, r.no_surat_utama, r.no_surat_alternatif, r.uraian_lengkap, r.tanggal_naskah,
     r.tingkat_perkembangan, r.drive_file_id, r.drive_file_url, r.nama_file, r.jumlah_halaman, r.is_deleted,
     r.kode_klasifikasi_snapshot, r.kondisi_fisik]
  );
}

before(async () => {
  fx = await createFixture(pool);
  T = `Q${fx.tag}`;
  const A = fx.unit.A;
  const B = fx.unit.B;
  await asService(pool, async (c) => {
    await insertBerkas(c, A, `BRK-${T}-X1`, 50, `Laporan Keuangan ${T}`, {
      no_filling_kabinet: '7', no_laci: '3', no_folder: '12', drive_folder_url: 'https://drive.google.com/drive/folders/F1'
    });
    await insertItem(c, A, `BRK-${T}-X1`, `ITM-${T}-1`, 1, {
      no_surat_utama: `B-014/${T}/2025`, uraian_lengkap: 'Laporan triwulan Pérencanaan', tanggal_naskah: '2025-01-10',
      drive_file_id: 'FILE1', drive_file_url: 'https://drive.google.com/file/d/FILE1/view', jumlah_halaman: 4
    });
    await insertItem(c, A, `BRK-${T}-X1`, `ITM-${T}-2`, 2, {
      no_surat_utama: `SK-${T}-02`, uraian_lengkap: 'Nota dinas anggaran', tanggal_naskah: '2025-06-01',
      tingkat_perkembangan: 'COPY', jumlah_halaman: 2, kode_klasifikasi_snapshot: 'KP.02'
    });
    await insertItem(c, A, `BRK-${T}-X1`, `ITM-${T}-3`, 3, {
      uraian_lengkap: 'Undangan rapat', nama_file: `undangan_zeta${fx.tag}.pdf`, kondisi_fisik: 'RUSAK RINGAN'
    });
    await insertItem(c, A, `BRK-${T}-X1`, `ITM-${T}-4`, 4, { uraian_lengkap: 'Item terhapus', is_deleted: true });
    await insertBerkas(c, A, `BRK-${T}-X2`, 51, `Berkas Batal ${T}`, { status_berkas: 'DIHAPUS', is_deleted: true });
    await insertItem(c, A, `BRK-${T}-X2`, `ITM-${T}-5`, 1, { uraian_lengkap: 'Item di berkas batal' });
    await insertBerkas(c, A, `BRK-${T}-X3`, 52, `Arsip Massal ${T}`, {
      no_filling_kabinet: '9', kode_klasifikasi_snapshot: 'KU.09', uraian_klasifikasi_snapshot: 'Lain lain'
    });
    for (let n = 1; n <= 5; n++) {
      await insertItem(c, A, `BRK-${T}-X3`, `ITM-${T}-M${n}`, n, { uraian_lengkap: `Massal ${n}`, tanggal_naskah: `2024-0${n}-01` });
    }
    // One receipt line waiting to be filed (dashboard), one cancelled line (ignored).
    await c.query(
      `insert into public.penerimaan_item (id, unit_id, penerimaan_id, no_item, uraian_informasi, status_pemberkasan)
       values ($1, $2, $3, 2, 'Menunggu', 'BELUM DIBERKASKAN'), ($4, $2, $3, 3, 'Batal', 'DIBATALKAN')`,
      [`RCVI-${T}-W`, A, fx.ids.A.penerimaan, `RCVI-${T}-C`]);
    // Same text in unit B: must never leak to unit A users.
    await insertBerkas(c, B, `BRK-${T}-BX`, 50, `Laporan Keuangan ${T}`);
    await insertItem(c, B, `BRK-${T}-BX`, `ITM-${T}-B1`, 1, { no_surat_utama: `B-014/${T}/2025`, uraian_lengkap: 'Milik unit B' });
  });
});
after(async () => { await pool.end(); });

/** Call search_archive as a user with named arguments. */
function search(userId, args = {}) {
  return asUser(pool, userId, async (c) => {
    const names = Object.keys(args);
    const sql = `select public.search_archive(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) r`;
    return (await c.query(sql, Object.values(args))).rows[0].r;
  });
}
const ids = (res) => res.results.map((r) => r.item_id).sort();
const mine = (suffixes) => suffixes.map((s) => `ITM-${T}-${s}`).sort();

test('search functions are SECURITY INVOKER with empty search_path; anon has no EXECUTE', async () => {
  for (const sig of [SEARCH_SIG, 'public.get_item_detail(text)', 'public.get_berkas_detail(text, boolean)', 'public.dashboard_counts(uuid)']) {
    const { rows: [r] } = await pool.query(
      `select p.prosecdef secdef, p.proconfig cfg,
              has_function_privilege('anon', p.oid, 'EXECUTE') anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') auth
       from pg_proc p where p.oid = $1::regprocedure`, [sig]);
    assert.deepEqual(r, { secdef: false, cfg: ['search_path=""'], anon: false, auth: true }, sig);
  }
});

test('anon is denied on every search function', async () => {
  for (const sql of [
    'select public.search_archive()',
    "select public.get_item_detail('x')",
    "select public.get_berkas_detail('x')",
    'select public.dashboard_counts()'
  ]) {
    await asAnon(pool, async (c) => { await expectSqlError(c.query(sql)); });
  }
});

test('trigram indexes exist when pg_trgm is installed', async () => {
  const { rows: [{ trgm }] } = await pool.query("select exists (select 1 from pg_extension where extname = 'pg_trgm') trgm");
  const { rows } = await pool.query(
    "select indexname from pg_indexes where schemaname = 'public' and indexname in ('item_search_doc_trgm', 'berkas_search_doc_trgm') order by 1");
  assert.deepEqual(rows.map((r) => r.indexname), trgm ? ['berkas_search_doc_trgm', 'item_search_doc_trgm'] : []);
});

test('unit isolation through the RPC', async () => {
  const active = mine(['1', '2', '3', 'M1', 'M2', 'M3', 'M4', 'M5']);
  for (const u of ['adminA', 'petugasA', 'pimpinanA']) {
    const res = await search(fx.user[u], { p_query: T, p_limit: 100 });
    assert.deepEqual(ids(res), active, u);
    assert.equal(res.total, active.length, u);
  }
  assert.deepEqual(ids(await search(fx.user.petugasB, { p_query: T })), mine(['B1']));
  // p_unit_id cannot widen the scope of a unit user
  assert.equal((await search(fx.user.petugasB, { p_query: T, p_unit_id: fx.unit.A })).total, 0);
  // inactive / no profile / inactive unit: nothing
  for (const u of ['inactiveA', 'noProfile', 'unitInactive']) {
    assert.equal((await search(fx.user[u], { p_query: T })).total, 0, u);
  }
  // ADMIN_PUSAT: all units, or one unit via p_unit_id
  assert.deepEqual(ids(await search(fx.user.pusat, { p_query: T, p_limit: 100 })), [...active, `ITM-${T}-B1`].sort());
  assert.deepEqual(ids(await search(fx.user.pusat, { p_query: T, p_unit_id: fx.unit.B })), mine(['B1']));
});

test('free text: all tokens must match, case/accent/punctuation-insensitive, across item and berkas fields', async () => {
  const u = fx.user.petugasA;
  const q = async (text) => ids(await search(u, { p_query: `${T} ${text}`, p_limit: 100 }));
  assert.deepEqual(await q('perencanaan'), mine(['1']));              // accent in data, none in query
  assert.deepEqual(await q('PÉRENCANAAN triwulan'), mine(['1']));     // accent in query, two tokens
  assert.deepEqual(await q('perencanaan anggaran'), []);              // AND, not OR
  assert.deepEqual(await q('b.014'), mine(['1']));                    // punctuation normalised
  assert.deepEqual(await q('kabinet 7 laci 3 folder 12'), mine(['1', '2', '3'])); // lokasi label (berkas)
  assert.deepEqual(await q('keuangan umum'), mine(['1', '2', '3']));  // uraian klasifikasi (berkas)
  assert.deepEqual(await q('kp 02'), mine(['2']));                    // item kode klasifikasi
  assert.deepEqual(await q(`zeta${fx.tag.toLowerCase()}`), mine(['3'])); // nama file
  assert.deepEqual(await q('rusak ringan'), mine(['3']));             // kondisi fisik
  assert.deepEqual(await q('massal'), mine(['M1', 'M2', 'M3', 'M4', 'M5'])); // judul berkas
  assert.equal((await search(u, { p_query: '   ' })).total >= 8, true); // blank query = no text filter
});

test('ranking: exact nomor surat first, then berkas/item number', async () => {
  const res = await search(fx.user.petugasA, { p_query: `B-014/${T}/2025` });
  assert.equal(res.results[0].item_id, `ITM-${T}-1`);
  assert.equal(res.results[0].score, 1000);
  const all = await search(fx.user.petugasA, { p_query: T, p_limit: 100 });
  const order = all.results.map((r) => [r.no_berkas, r.no_item]);
  assert.deepEqual(order, [...order].sort((a, b) => a[0] - b[0] || a[1] - b[1]));
});

test('filters: development, file status, dates, classification', async () => {
  const u = fx.user.petugasA;
  const f = async (args) => ids(await search(u, { p_query: T, p_limit: 100, ...args }));
  assert.deepEqual(await f({ p_development: 'COPY' }), mine(['2']));
  assert.deepEqual(await f({ p_development: 'asli', p_classification: 'ku' }), mine(['1', '3', 'M1', 'M2', 'M3', 'M4', 'M5']));
  assert.deepEqual(await f({ p_file_status: 'TERSEDIA' }), mine(['1']));
  assert.deepEqual(await f({ p_file_status: 'BELUM_DIUNGGAH', p_query: `${T} laporan` }), mine(['2', '3']));
  assert.deepEqual(await f({ p_date_from: '2025-01-01', p_date_to: '2025-12-31' }), mine(['1', '2']));
  assert.deepEqual(await f({ p_date_to: '2024-02-15' }), mine(['M1', 'M2']));      // undated items excluded
  assert.deepEqual(await f({ p_classification: 'KP.02' }), mine(['2']));
  const hit = (await search(u, { p_query: `B-014/${T}/2025` })).results[0];
  assert.equal(hit.has_file, true);
  assert.equal(hit.drive_file_id, 'FILE1');
  assert.equal(hit.lokasi, 'Kabinet 7 · Laci 3 · Folder 12');
  assert.equal(hit.drive_folder_url, 'https://drive.google.com/drive/folders/F1');
});

test('invalid filters are rejected with SQLSTATE 22023', async () => {
  for (const args of [{ p_development: 'X' }, { p_file_status: 'NOPE' }, { p_date_from: '2025-02-01', p_date_to: '2025-01-01' }]) {
    await asUser(pool, fx.user.petugasA, async (c) => {
      const names = Object.keys(args);
      await expectSqlError(
        c.query(`select public.search_archive(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')})`, Object.values(args)),
        '22023');
    });
  }
});

test('cancelled rows are excluded by default and flagged when included', async () => {
  const res = await search(fx.user.petugasA, { p_query: T, p_include_deleted: true, p_limit: 100 });
  assert.deepEqual(ids(res), mine(['1', '2', '3', '4', '5', 'M1', 'M2', 'M3', 'M4', 'M5']));
  const flagged = res.results.filter((r) => r.dibatalkan).map((r) => r.item_id).sort();
  assert.deepEqual(flagged, mine(['4', '5']));
});

test('pagination: total, limit/offset, stable non-overlapping pages', async () => {
  const u = fx.user.petugasA;
  const pages = [];
  for (let offset = 0; offset < 8; offset += 3) {
    const res = await search(u, { p_query: T, p_limit: 3, p_offset: offset });
    assert.equal(res.total, 8);
    assert.equal(res.limit, 3);
    assert.equal(res.offset, offset);
    pages.push(...res.results.map((r) => r.item_id));
  }
  assert.equal(pages.length, 8);
  assert.equal(new Set(pages).size, 8);
  const full = (await search(u, { p_query: T, p_limit: 100 })).results.map((r) => r.item_id);
  assert.deepEqual(pages, full);
  const beyond = await search(u, { p_query: T, p_limit: 3, p_offset: 50 });
  assert.deepEqual(beyond.results, []);
  assert.equal(beyond.total, 8);
  assert.equal((await search(u, { p_query: T, p_limit: 1000 })).limit, 100); // capped
});

test('get_item_detail: visible in own unit only', async () => {
  const get = (userId, id) => asUser(pool, userId, async (c) =>
    (await c.query('select public.get_item_detail($1) d', [id])).rows[0].d);
  const d = await get(fx.user.pimpinanA, `ITM-${T}-1`);
  assert.equal(d.no_surat, `B-014/${T}/2025`);
  assert.equal(d.judul_berkas, `Laporan Keuangan ${T}`);
  assert.equal(d.lokasi, 'Kabinet 7 · Laci 3 · Folder 12');
  assert.equal(await get(fx.user.petugasB, `ITM-${T}-1`), null);
  assert.equal(await get(fx.user.inactiveA, `ITM-${T}-1`), null);
});

test('get_berkas_detail: items in order, total lembar, date range; isolation', async () => {
  const get = (userId, id, inc = false) => asUser(pool, userId, async (c) =>
    (await c.query('select public.get_berkas_detail($1, $2) d', [id, inc])).rows[0].d);
  const d = await get(fx.user.petugasA, `BRK-${T}-X1`);
  assert.deepEqual(d.items.map((i) => i.no_item), [1, 2, 3]);
  assert.equal(d.jumlah_item, 3);
  assert.equal(d.total_lembar, 7);
  assert.equal(d.tanggal_awal, '2025-01-10');
  assert.equal(d.tanggal_akhir, '2025-06-01');
  assert.equal(d.lokasi, 'Kabinet 7 · Laci 3 · Folder 12');
  const withDeleted = await get(fx.user.petugasA, `BRK-${T}-X1`, true);
  assert.deepEqual(withDeleted.items.map((i) => i.no_item), [1, 2, 3, 4]);
  assert.equal(withDeleted.total_lembar, 7); // totals ignore deleted items
  const x3 = await get(fx.user.petugasA, `BRK-${T}-X3`);
  assert.equal(x3.lokasi, 'Kabinet 9 · Folder 52'); // folder falls back to no. berkas
  assert.equal(await get(fx.user.petugasB, `BRK-${T}-X1`), null);
});

test('dashboard_counts: own unit for unit users, per unit or all for ADMIN_PUSAT', async () => {
  const counts = (userId, unitId = null) => asUser(pool, userId, async (c) =>
    (await c.query('select public.dashboard_counts($1) d', [unitId])).rows[0].d);
  const a = await counts(fx.user.petugasA);
  assert.deepEqual(a, await counts(fx.user.pusat, fx.unit.A));
  assert.deepEqual(await counts(fx.user.petugasB), await counts(fx.user.pusat, fx.unit.B));
  // fixture berkas + X1 + X3 are active; X2 is deleted
  assert.equal(a.berkas_aktif, 3);
  // fixture item + 3 (X1) + 5 (X3)
  assert.equal(a.item_aktif, 9);
  assert.equal(a.item_tanpa_pdf, 8);
  // fixture receipt line is already filed; one waiting line added here
  assert.equal(a.penerimaan_menunggu, 1);
  const none = await counts(fx.user.inactiveA);
  assert.deepEqual(none, { berkas_aktif: 0, item_aktif: 0, item_tanpa_pdf: 0, penerimaan_menunggu: 0 });
  const all = await counts(fx.user.pusat);
  assert.ok(all.item_aktif >= a.item_aktif + 2);
});
