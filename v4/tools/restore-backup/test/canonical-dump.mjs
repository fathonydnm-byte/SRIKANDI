// Canonical dump of every restorable table: one line per row (to_jsonb), ordered by primary key, per table.
// Two databases are "equal" when these dumps are byte-for-byte identical.
import crypto from 'node:crypto';
import { RESTORE_TABLES } from '../lib/tables.mjs';

export async function canonicalDump(client, units) {
  const out = {};
  for (const t of RESTORE_TABLES) {
    const { rows: pk } = await client.query(
      `select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
        where i.indrelid = $1::regclass and i.indisprimary order by array_position(i.indkey::int2[], a.attnum)`, [`public.${t}`]);
    const order = pk.map((r) => `"${r.attname}"::text`).join(', ');
    const where = t === 'units' ? 'where id = any ($1::uuid[])' : t === 'audit_log' ? 'where unit_id = any ($1::uuid[]) or unit_id is null' : 'where unit_id = any ($1::uuid[])';
    const { rows } = await client.query(`select to_jsonb(t)::text as j from public."${t}" t ${where} order by ${order}`, [units]);
    const text = rows.map((r) => r.j).join('\n');
    out[t] = { rows: rows.length, sha256: crypto.createHash('sha256').update(text).digest('hex'), text };
  }
  return out;
}
