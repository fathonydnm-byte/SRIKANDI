// Load verified packages into a database that already has the migrations applied. One transaction.
import { RESTORE_TABLES, UNIT_COLUMN } from './tables.mjs';
import { readPart } from './package.mjs';
import { runIntegrityChecks } from './checks.mjs';

const BATCH = 500;

export class RestoreError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function tableMeta(client, table) {
  const reg = `public.${client.escapeIdentifier(table)}`;
  const { rows: cols } = await client.query(
    `select a.attname as name, a.attgenerated as generated, a.attidentity as identity
       from pg_attribute a where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum`, [reg]);
  const { rows: pk } = await client.query(
    `select a.attname as name from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
      where i.indrelid = $1::regclass and i.indisprimary order by array_position(i.indkey::int2[], a.attnum)`, [reg]);
  const { rows: ao } = await client.query(
    `select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
      where t.tgrelid = $1::regclass and not t.tgisinternal and p.proname = 'tg_append_only'`, [reg]);
  if (!cols.length) throw new RestoreError('SCHEMA', `Tabel public.${table} tidak ada di database tujuan.`);
  return { cols, pk: pk.map((r) => r.name), appendOnly: ao.length > 0 };
}

export async function schemaVersion(client) {
  const { rows } = await client.query('select max(version) as v from public.schema_migrations_log');
  return rows[0]?.v ?? null;
}

function insertSql(client, table, meta) {
  const q = (n) => client.escapeIdentifier(n);
  const writable = meta.cols.filter((c) => c.generated === '');
  const names = writable.map((c) => q(c.name));
  const hasAlwaysIdentity = writable.some((c) => c.identity === 'a');
  const nonPk = writable.filter((c) => !meta.pk.includes(c.name));
  const conflict = meta.pk.length === 0 ? ''
    : meta.appendOnly || nonPk.length === 0 ? ` on conflict (${meta.pk.map(q).join(', ')}) do nothing`
      : ` on conflict (${meta.pk.map(q).join(', ')}) do update set ${nonPk.map((c) => `${q(c.name)} = excluded.${q(c.name)}`).join(', ')}`;
  return `insert into public.${q(table)} (${names.join(', ')})${hasAlwaysIdentity ? ' overriding system value' : ''}
          select ${names.join(', ')} from jsonb_populate_recordset(null::public.${q(table)}, $1::jsonb)${conflict}`;
}

/**
 * @param client   connected pg client (one session; this function runs begin ... commit/rollback itself)
 * @param packages [{pkg, manifest, counts}] already verified
 * @param options  {dryRun, forceSchema, log}
 * @returns summary {schema, tables:{table:{packageRows, affected}}, checks:[...], committed}
 */
export async function restorePackages(client, packages, { dryRun = false, forceSchema = false, log = () => {} } = {}) {
  const dbSchema = await schemaVersion(client);
  for (const { manifest } of packages) {
    if (manifest.schema_version !== dbSchema) {
      const msg = `Versi skema berbeda: paket ${manifest.unit.code} = ${manifest.schema_version}, database = ${dbSchema}.`;
      if (!forceSchema) throw new RestoreError('SCHEMA_MISMATCH', `${msg} Terapkan migrasi yang sesuai lebih dulu, atau gunakan --force-schema bila Anda yakin.`);
      log(`PERINGATAN (--force-schema): ${msg}`);
    }
  }
  const summary = { schema: dbSchema, tables: {}, checks: [], committed: false, units: [] };
  await client.query('begin');
  try {
    const tables = RESTORE_TABLES.filter((t) => {
      if (t === 'transfer_drafts' || t === 'transfer_draft_items') return dbSchema >= '0026';
      if (t === 'loan_groups' || t === 'loan_objects') return dbSchema >= '0024';
      return true;
    });
    const metas = {};
    for (const t of tables) metas[t] = await tableMeta(client, t);
    for (const { manifest } of packages) summary.units.push(manifest.unit);
    // load order: table by table across all packages (units first), so "units" rows exist before anything references them
    for (const table of tables) {
      const meta = metas[table];
      const known = new Set(meta.cols.map((c) => c.name));
      const sql = insertSql(client, table, meta);
      let packageRows = 0;
      let affected = 0;
      for (const { pkg, manifest } of packages) {
        for (const part of manifest.tables[table]?.parts ?? []) {
          const rows = readPart(pkg, part.file);
          for (const r of rows) {
            for (const k of Object.keys(r)) {
              if (!known.has(k)) {
                const msg = `Kolom ${table}.${k} ada di paket tetapi tidak di database (skema berbeda).`;
                if (!forceSchema) throw new RestoreError('SCHEMA_MISMATCH', msg);
              }
            }
          }
          for (let i = 0; i < rows.length; i += BATCH) {
            const res = await client.query(sql, [JSON.stringify(rows.slice(i, i + BATCH))]);
            affected += res.rowCount;
          }
          packageRows += rows.length;
        }
      }
      summary.tables[table] = { packageRows, affected };
      // identity sequences must continue after the restored maximum (otherwise the next insert collides)
      for (const c of meta.cols.filter((x) => x.identity !== '')) {
        const q = client.escapeIdentifier;
        await client.query(
          `select setval(pg_get_serial_sequence($1, $2), coalesce(max(${q.call(client, c.name)}), 1), max(${q.call(client, c.name)}) is not null) from public.${q.call(client, table)}`,
          [`public.${q.call(client, table)}`, c.name]);
      }
    }
    summary.checks = await runIntegrityChecks(client, packages, summary);
    const failed = summary.checks.filter((c) => !c.ok);
    if (failed.length) throw new RestoreError('INTEGRITY', `Pemeriksaan integritas gagal: ${failed.map((c) => c.name).join('; ')}`);
    if (dryRun) {
      await client.query('rollback');
    } else {
      await client.query('commit');
      summary.committed = true;
    }
  } catch (e) {
    await client.query('rollback').catch(() => {});
    if (e instanceof RestoreError) { e.summary = summary; throw e; }
    const err = new RestoreError(e.code === '23503' || e.code === '23P01' || e.code === '23505' ? 'INTEGRITY' : 'DATABASE', `Basis data menolak data: ${e.message}`);
    err.summary = summary;
    throw err;
  }
  return summary;
}

export { UNIT_COLUMN };
