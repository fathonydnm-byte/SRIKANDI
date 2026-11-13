// Migrations idempotency and structural constraints.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newPool, createFixture, expectSqlError } from './helpers.mjs';

const pool = newPool();
const MIGRATIONS_DIR = process.env.CF_MIGRATIONS_DIR;
let fx;

before(async () => { fx = await createFixture(pool); });
after(async () => { await pool.end(); });

/** Run fn(client) as service_role inside a transaction that is always rolled back. */
async function serviceTx(fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local role service_role');
    return await fn(c);
  } finally {
    await c.query('rollback').catch(() => {});
    c.release();
  }
}

test('all migrations are recorded in schema_migrations_log', async () => {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  const { rows } = await pool.query('select version from public.schema_migrations_log order by version');
  assert.deepEqual(rows.map((r) => r.version), files.map((f) => f.slice(0, 4)));
});

test('re-applying every migration on a populated database is a no-op (3rd pass)', async () => {
  const count = async () => (await pool.query(
    "select (select count(*) from public.berkas) b, (select count(*) from pg_policies where schemaname = 'public') p")).rows[0];
  const beforeCounts = await count();
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  const c = await pool.connect();
  try {
    await c.query('set client_min_messages = warning');
    for (const f of files) {
      await c.query('begin');
      await c.query(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
      await c.query('commit');
    }
  } finally {
    c.release();
  }
  assert.deepEqual(await count(), beforeCounts);
});

test('berkas number is unique per unit (non-deleted), and may repeat across units', async () => {
  // Fixture already has no_berkas_definitif = 1 in units A, B and C.
  await serviceTx(async (c) => {
    await c.query(
      `insert into public.berkas (id, unit_id, no_berkas_definitif, judul_berkas) values ($1, $2, 1, 'dup')`,
      [`BRK-${fx.tag}-DUP`, fx.unit.A]);
    // deferred: violation is reported at commit
    await expectSqlError(c.query('commit'), '23P01');
  });
  await serviceTx(async (c) => {
    await c.query('set constraints all immediate');
    await expectSqlError(c.query(
      `insert into public.berkas (id, unit_id, no_berkas_definitif, judul_berkas) values ($1, $2, 1, 'dup')`,
      [`BRK-${fx.tag}-DUP`, fx.unit.A]), '23P01');
  });
  // A soft-deleted berkas keeps its old number without blocking reuse.
  await serviceTx(async (c) => {
    await c.query(
      `insert into public.berkas (id, unit_id, no_berkas_definitif, judul_berkas, is_deleted) values ($1, $2, 1, 'old', true)`,
      [`BRK-${fx.tag}-DEL`, fx.unit.A]);
    await c.query('set constraints all immediate');
  });
});

test('chronological renumbering can swap numbers inside one transaction', async () => {
  await serviceTx(async (c) => {
    await c.query(
      `insert into public.berkas (id, unit_id, no_berkas_definitif, judul_berkas) values ($1, $2, 2, 'second')`,
      [`BRK-${fx.tag}-A2`, fx.unit.A]);
    await c.query(`update public.berkas set no_berkas_definitif = 2 where id = $1`, [fx.ids.A.berkas]);
    await c.query(`update public.berkas set no_berkas_definitif = 1 where id = $1`, [`BRK-${fx.tag}-A2`]);
    await c.query('set constraints all immediate'); // forces the deferred checks now
  });
});

test('item number is unique per berkas', async () => {
  await serviceTx(async (c) => {
    await c.query('set constraints all immediate');
    await expectSqlError(c.query(
      `insert into public.item (id, unit_id, berkas_id, no_item_definitif) values ($1, $2, $3, 1)`,
      [`ITM-${fx.tag}-DUP`, fx.unit.A, fx.ids.A.berkas]), '23P01');
  });
});

test('receipt number (TRM) is unique per unit', async () => {
  await serviceTx(async (c) => {
    await expectSqlError(c.query(
      `insert into public.penerimaan (id, unit_id, nomor_tanda_terima, tahun, tanggal_waktu_terima)
       values ($1, $2, 'TRM-2026-0001', 2026, now())`, [`RCV-${fx.tag}-DUP`, fx.unit.A]), '23505');
  });
});

test('references cannot cross units (composite FKs)', async () => {
  await serviceTx(async (c) => {
    await c.query('set constraints all immediate');
    // item in unit B pointing at a berkas of unit A
    await expectSqlError(c.query(
      `insert into public.item (id, unit_id, berkas_id, no_item_definitif) values ($1, $2, $3, 9)`,
      [`ITM-${fx.tag}-X`, fx.unit.B, fx.ids.A.berkas]), '23503');
  });
  await serviceTx(async (c) => {
    await c.query('set constraints all immediate');
    await expectSqlError(c.query(
      `insert into public.berkas (id, unit_id, judul_berkas, klasifikasi_id) values ($1, $2, 'x', 'KLS-NOPE')`,
      [`BRK-${fx.tag}-X`, fx.unit.B]), '23503');
  });
});

test('closed legacy value lists are enforced', async () => {
  const cases = [
    [`insert into public.berkas (id, unit_id, judul_berkas, klasifikasi_keamanan_akses) values ('BRK-${fx.tag}-K', '${fx.unit.A}', 'x', 'PUBLIK')`],
    [`insert into public.berkas (id, unit_id, judul_berkas, retensi_aktif_satuan) values ('BRK-${fx.tag}-R', '${fx.unit.A}', 'x', 'HARI')`],
    [`insert into public.berkas (id, unit_id, judul_berkas, nasib_akhir) values ('BRK-${fx.tag}-N', '${fx.unit.A}', 'x', 'HILANG')`],
    [`insert into public.item (id, unit_id, berkas_id, tingkat_perkembangan) values ('ITM-${fx.tag}-T', '${fx.unit.A}', '${fx.ids.A.berkas}', 'SALINAN')`],
    [`insert into public.penerimaan (id, unit_id, nomor_tanda_terima, tahun, tanggal_waktu_terima, status) values ('RCV-${fx.tag}-S', '${fx.unit.A}', 'TRM-X', 2026, now(), 'HILANG')`]
  ];
  for (const [sql] of cases) {
    await serviceTx(async (c) => { await expectSqlError(c.query(sql), '23514'); });
  }
});

test('local calendar dates are date, technical timestamps are timestamptz', async () => {
  const { rows } = await pool.query(`
    select table_name || '.' || column_name as col, data_type from information_schema.columns
    where table_schema = 'public' and column_name in
      ('tanggal_naskah', 'batas_aktif', 'batas_inaktif', 'tgl_acuan_retensi', 'created_at', 'updated_at',
       'occurred_at', 'tanggal_waktu_terima', 'diberkaskan_at')`);
  for (const r of rows) {
    const isDate = /\.(tanggal_naskah|batas_aktif|batas_inaktif|tgl_acuan_retensi)$/.test(r.col);
    assert.equal(r.data_type, isDate ? 'date' : 'timestamp with time zone', r.col);
  }
});

test('every business table has unit_id not null', async () => {
  const { rows } = await pool.query(`
    select table_name, is_nullable from information_schema.columns
    where table_schema = 'public' and column_name = 'unit_id'
      and table_name in ('unit_settings','idempotency_keys','counters','klasifikasi','pegawai','berkas',
                         'item','penerimaan','penerimaan_item','riwayat_nomor')`);
  assert.equal(rows.length, 10);
  for (const r of rows) assert.equal(r.is_nullable, 'NO', r.table_name);
});
