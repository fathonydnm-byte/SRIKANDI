// Shared helpers for the v4 database tests. Connection settings come from the
// standard PG* environment variables exported by run.sh (PGUSER=postgres, the
// non-superuser migration owner, like on Supabase).
import pg from 'pg';
import { randomUUID } from 'node:crypto';

export const ALL_PUBLIC_TABLES = [
  'units', 'profiles', 'unit_settings', 'audit_log', 'idempotency_keys', 'counters',
  'klasifikasi', 'pegawai', 'berkas', 'item', 'penerimaan', 'penerimaan_item',
  'riwayat_nomor', 'schema_migrations_log',
  // Sprint 2
  'jenis_naskah', 'penerimaan_cetak_log', 'upload_sessions', 'drive_tasks',
  // Sprint 3 (lidah folder)
  'folder_label_log',
  // Sprint 3 (edit / koreksi & pembatalan, 0018)
  'karantina', 'pembatalan_arsip',
  // Sprint 3 (cermin + backup, 0022)
  'job_nonces', 'backup_runs'
];

export function newPool(max = 10) {
  return new pg.Pool({ max });
}

/** Expect a promise to reject with the given SQLSTATE (default 42501 insufficient_privilege). */
export async function expectSqlError(promise, code = '42501') {
  try {
    await promise;
  } catch (error) {
    if (error.code !== code) {
      throw new Error(`expected SQLSTATE ${code}, got ${error.code}: ${error.message}`);
    }
    return error;
  }
  throw new Error(`expected SQLSTATE ${code}, but the statement succeeded`);
}

/**
 * Run fn(client) inside a transaction acting as a PostgREST request:
 * role `authenticated` (or `anon`) with request.jwt.claims.sub = userId.
 * Always rolled back. Errors inside fn propagate after rollback.
 */
export async function asRole(pool, role, userId, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const claims = userId ? JSON.stringify({ sub: userId, role }) : JSON.stringify({ role });
    await client.query("select set_config('request.jwt.claims', $1, true)", [claims]);
    await client.query(`set local role ${role}`);
    return await fn(client);
  } finally {
    await client.query('rollback').catch(() => {});
    client.release();
  }
}

export const asUser = (pool, userId, fn) => asRole(pool, 'authenticated', userId, fn);
export const asAnon = (pool, fn) => asRole(pool, 'anon', null, fn);

/** Run fn(client) as service_role in a committed transaction. */
export async function asService(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('set local role service_role');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Two active units (A, B), one inactive unit (C), users for every role, and
 * one berkas / item / penerimaan / audit row per unit. All writes as
 * service_role (verifies the server path works under RLS + grants).
 */
export async function createFixture(pool) {
  const tag = randomUUID().slice(0, 8).toUpperCase();
  const unit = { A: randomUUID(), B: randomUUID(), C: randomUUID() };
  const user = {
    pusat: randomUUID(), adminA: randomUUID(), petugasA: randomUUID(), pimpinanA: randomUUID(),
    adminB: randomUUID(), petugasB: randomUUID(), inactiveA: randomUUID(), unitInactive: randomUUID(),
    noProfile: randomUUID()
  };
  const ids = {};
  for (const u of ['A', 'B', 'C']) {
    ids[u] = {
      berkas: `BRK-${tag}-${u}`, item: `ITM-${tag}-${u}`, penerimaan: `RCV-${tag}-${u}`,
      penerimaanItem: `RCVI-${tag}-${u}`, pegawai: `PGW-${tag}-${u}`, klas: `KLS-${tag}`, audit: `LOG-${tag}-${u}`
    };
  }

  // auth.users is owned by the platform; the migration owner inserts test users.
  const owner = await pool.connect();
  try {
    for (const id of Object.values(user)) {
      await owner.query('insert into auth.users (id, email) values ($1, $2)', [id, `${id}@test.invalid`]);
    }
  } finally {
    owner.release();
  }

  await asService(pool, async (c) => {
    await c.query(
      `insert into public.units (id, code, name, active) values
         ($1, $4, 'Unit A', true), ($2, $5, 'Unit B', true), ($3, $6, 'Unit C (inactive)', false)`,
      [unit.A, unit.B, unit.C, `T${tag}-A`, `T${tag}-B`, `T${tag}-C`]
    );
    const profiles = [
      [user.pusat, null, 'ADMIN_PUSAT', true],
      [user.adminA, unit.A, 'ADMIN_UNIT', true],
      [user.petugasA, unit.A, 'PETUGAS', true],
      [user.pimpinanA, unit.A, 'PIMPINAN', true],
      [user.adminB, unit.B, 'ADMIN_UNIT', true],
      [user.petugasB, unit.B, 'PETUGAS', true],
      [user.inactiveA, unit.A, 'ADMIN_UNIT', false],
      [user.unitInactive, unit.C, 'ADMIN_UNIT', true]
    ];
    for (const [uid, unitId, role, active] of profiles) {
      await c.query(
        'insert into public.profiles (user_id, unit_id, role, full_name, active) values ($1, $2, $3, $4, $5)',
        [uid, unitId, role, `User ${role}`, active]
      );
    }
    for (const u of ['A', 'B', 'C']) {
      const i = ids[u];
      await c.query(
        `insert into public.klasifikasi (unit_id, id, kode_lengkap, uraian) values ($1, $2, 'PR', 'Perencanaan')`,
        [unit[u], i.klas]
      );
      await c.query(
        `insert into public.pegawai (id, unit_id, nama_pegawai) values ($1, $2, 'Pegawai ' || $3)`,
        [i.pegawai, unit[u], u]
      );
      await c.query(
        `insert into public.berkas (id, unit_id, no_berkas_definitif, judul_berkas, klasifikasi_id, status_berkas)
         values ($1, $2, 1, 'Berkas ' || $3, $4, 'AKTIF')`,
        [i.berkas, unit[u], u, i.klas]
      );
      await c.query(
        `insert into public.penerimaan (id, unit_id, nomor_tanda_terima, tahun, tanggal_waktu_terima, penyerah_pegawai_id)
         values ($1, $2, 'TRM-2026-0001', 2026, now(), $3)`,
        [i.penerimaan, unit[u], i.pegawai]
      );
      await c.query(
        `insert into public.penerimaan_item (id, unit_id, penerimaan_id, no_item, uraian_informasi, status_pemberkasan,
                                             berkas_id_tujuan, item_id_definitif)
         values ($1, $2, $3, 1, 'Uraian', 'SUDAH DIBERKASKAN', $4, $5)`,
        [i.penerimaanItem, unit[u], i.penerimaan, i.berkas, i.item]
      );
      await c.query(
        `insert into public.item (id, unit_id, berkas_id, no_item_definitif, tanggal_naskah, uraian_lengkap,
                                  jumlah_halaman, tingkat_perkembangan, penerimaan_id, penerimaan_item_id)
         values ($1, $2, $3, 1, '2026-01-02', 'Item ' || $4, 3, 'ASLI', $5, $6)`,
        [i.item, unit[u], i.berkas, u, i.penerimaan, i.penerimaanItem]
      );
      await c.query(
        `insert into public.riwayat_nomor (id, unit_id, jenis_objek, objek_id, berkas_id, nomor_lama, nomor_baru)
         values ($1, $2, 'BERKAS', $3, $3, null, 1)`,
        [`HIS-${tag}-${u}`, unit[u], i.berkas]
      );
      await c.query(
        `insert into public.unit_settings (unit_id, key, value) values ($1, 'UNIT_NAME', to_jsonb($2::text))`,
        [unit[u], `Unit ${u}`]
      );
      await c.query(
        `insert into public.idempotency_keys (unit_id, request_id, operation, response) values ($1, $2, 'TEST', '{}')`,
        [unit[u], `REQ-${tag}-${u}`]
      );
      await c.query(
        `insert into public.audit_log (id, unit_id, action, module, object_type, object_id, result)
         values ($1, $2, 'CREATE', 'BERKAS', 'BERKAS', $3, 'SUCCESS')`,
        [i.audit, unit[u], i.berkas]
      );
    }
    await c.query('select app.next_counter($1, $2, 2026)', [unit.A, 'TRM']);
    await c.query('select app.next_counter($1, $2, 2026)', [unit.B, 'TRM']);
  });

  return { tag, unit, user, ids };
}
