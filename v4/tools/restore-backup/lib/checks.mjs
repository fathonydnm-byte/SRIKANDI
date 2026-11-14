// Integrity checks that run INSIDE the restore transaction (a failure rolls everything back).
import { RESTORE_TABLES, UNIT_COLUMN } from './tables.mjs';

const unitIdsOf = (packages) => packages.map((p) => p.manifest.unit.id).filter((id) => id && id !== 'GLOBAL');

export async function runIntegrityChecks(client, packages, summary) {
  const q = (n) => client.escapeIdentifier(n);
  const results = [];
  const units = unitIdsOf(packages);
  const add = (name, ok, detail) => results.push({ name, ok, detail });

  // 1) row counts: every restored table holds at least as many rows as the package carried (per unit)
  for (const { manifest } of packages) {
    const isGlobal = manifest.unit.id === 'GLOBAL';
    for (const table of RESTORE_TABLES) {
      const expected = manifest.tables[table]?.rows ?? 0;
      if (!expected) continue;
      const col = q(UNIT_COLUMN(table));
      const sql = isGlobal ? `select count(*)::int n from public.${q(table)} where ${col} is null` : `select count(*)::int n from public.${q(table)} where ${col} = $1`;
      const { rows } = await client.query(sql, isGlobal ? [] : [manifest.unit.id]);
      add(`baris ${table} (${manifest.unit.code})`, rows[0].n >= expected, `${rows[0].n} di database, ${expected} di paket`);
    }
  }

  // 2) orphans: every foreign key whose child table we restored (generic, from the catalog; MATCH SIMPLE like Postgres)
  const { rows: fks } = await client.query(
    `select c.conname, cl.relname as child, pl.relname as parent,
            (select array_agg(a.attname::text order by k.ord) from unnest(c.conkey) with ordinality k(attnum, ord)
               join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as child_cols,
            (select array_agg(a.attname::text order by k.ord) from unnest(c.confkey) with ordinality k(attnum, ord)
               join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum) as parent_cols
       from pg_constraint c
       join pg_class cl on cl.oid = c.conrelid
       join pg_class pl on pl.oid = c.confrelid
      where c.contype = 'f' and c.connamespace = 'public'::regnamespace`);
  for (const fk of fks) {
    if (!RESTORE_TABLES.includes(fk.child)) continue;
    const cond = fk.child_cols.map((c) => `c.${q(c)} is not null`).join(' and ');
    const join = fk.child_cols.map((c, i) => `p.${q(fk.parent_cols[i])} = c.${q(c)}`).join(' and ');
    const scope = units.length && fk.child_cols.includes('unit_id') ? ' and c.unit_id = any ($1::uuid[])' : '';
    const sql = `select count(*)::int n from public.${q(fk.child)} c
                  where ${cond}${scope} and not exists (select 1 from public.${q(fk.parent)} p where ${join})`;
    const { rows } = await client.query(sql, scope ? [units] : []);
    add(`yatim: ${fk.child}.${fk.conname}`, rows[0].n === 0, rows[0].n === 0 ? 'tidak ada' : `${rows[0].n} baris menunjuk ke induk yang tidak ada`);
  }

  // 3) numbering uniqueness per unit (soft-deleted rows do not count, like the database constraints)
  const dup = async (name, sql) => { const { rows } = await client.query(sql, [units]); add(name, rows.length === 0, rows.length ? `${rows.length} kelompok ganda, contoh ${JSON.stringify(rows[0])}` : 'unik'); };
  if (units.length) {
    await dup('nomor berkas unik per unit', `select unit_id, no_berkas_definitif, count(*) from public.berkas where not is_deleted and no_berkas_definitif is not null and unit_id = any ($1::uuid[]) group by 1, 2 having count(*) > 1`);
    await dup('nomor item unik per berkas', `select unit_id, berkas_id, no_item_definitif, count(*) from public.item where not is_deleted and no_item_definitif is not null and unit_id = any ($1::uuid[]) group by 1, 2, 3 having count(*) > 1`);
    await dup('nomor tanda terima unik per unit', `select unit_id, nomor_tanda_terima, count(*) from public.penerimaan where unit_id = any ($1::uuid[]) group by 1, 2 having count(*) > 1`);

    // 4) counters >= the highest number already handed out (a smaller counter would re-issue a used number)
    const { rows: low } = await client.query(
      `select c.unit_id, c.year, c.last_value, m.max_used
         from public.counters c
         join (select unit_id, tahun as year, max(substring(nomor_tanda_terima from '^TRM-\\d{4}-(\\d+)$')::bigint) as max_used
                 from public.penerimaan where unit_id = any ($1::uuid[]) group by 1, 2) m
           on m.unit_id = c.unit_id and m.year = c.year
        where c.scope = 'TRM' and c.unit_id = any ($1::uuid[]) and c.last_value < m.max_used`, [units]);
    add('counter TRM >= nomor tanda terima tertinggi', low.length === 0, low.length ? `${low.length} counter terlalu kecil, contoh ${JSON.stringify(low[0])}` : 'cocok');
    const { rows: missing } = await client.query(
      `select p.unit_id, p.tahun from public.penerimaan p
        where p.unit_id = any ($1::uuid[]) and p.nomor_tanda_terima ~ '^TRM-\\d{4}-\\d+$'
          and not exists (select 1 from public.counters c where c.unit_id = p.unit_id and c.scope = 'TRM' and c.year = p.tahun)
        group by 1, 2`, [units]);
    add('counter TRM ada untuk setiap tahun yang punya tanda terima', missing.length === 0, missing.length ? `${missing.length} tahun tanpa counter` : 'ada');
  }

  // 5) let Postgres validate every deferred constraint now (FKs and the deferrable numbering exclusion constraints)
  try {
    await client.query('set constraints all immediate');
    add('constraint basis data (FK, nomor unik)', true, 'lolos');
  } catch (e) {
    add('constraint basis data (FK, nomor unik)', false, e.message);
  }
  summary.checkCount = results.length;
  return results;
}
