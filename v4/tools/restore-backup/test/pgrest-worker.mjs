// Worker thread: runs the REAL server/jobsExport.ts (bundled by test.sh) behind a tiny PostgREST-like adapter
// over the local Postgres. The Apps Script job is synchronous (UrlFetchApp.fetch blocks), so the main thread talks to this
// worker through a SharedArrayBuffer flag + MessageChannel (see sync-bridge.mjs).
//
// FAKED here: PostgREST itself. The adapter implements only the query shapes the module generates (select, eq / is.null / gt,
// or=(a.gt.x,and(a.eq.x,b.gt.y)), order, limit, Prefer count=exact -> Content-Range with 200/206, a max-rows cap, rpc/<fn>
// with named args) and runs every statement as role service_role inside a transaction, so GRANTs are really exercised.
// Real PostgREST/Supabase behaviour (JWT handling, exact JSON formatting of every type, db-max-rows setting) is NOT proven.
import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const { bundle, serviceKey, anonKey, supabaseUrl, jobSecret, maxRows } = workerData;
const { handleJobsExport } = await import(pathToFileURL(bundle).href);
const pool = new pg.Pool({ max: 4 });
const { rows: tableRows } = await pool.query("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'");
const TABLES = new Set(tableRows.map((r) => r.table_name));
const colCache = new Map();
async function columns(table) {
  if (!colCache.has(table)) {
    const { rows } = await pool.query("select column_name from information_schema.columns where table_schema = 'public' and table_name = $1", [table]);
    colCache.set(table, new Set(rows.map((r) => r.column_name)));
  }
  return colCache.get(table);
}
const q = (id) => `"${String(id).replace(/"/g, '""')}"`;
const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function parseOr(text, params, cols) {
  // (clause,clause,...) ; clause = col.gt.X | and(col.eq.X,col.gt.Y,...)
  if (!/^\(.*\)$/.test(text)) throw new Error('bad or=');
  const inner = text.slice(1, -1);
  const clauses = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { clauses.push(cur); cur = ''; } else cur += ch;
  }
  clauses.push(cur);
  const atom = (a) => {
    const m = /^([a-z_]+)\.(eq|gt)\.([A-Za-z0-9_.-]+)$/.exec(a);
    if (!m || !cols.has(m[1])) throw new Error(`bad or atom ${a}`);
    params.push(m[3]);
    return `${q(m[1])} ${m[2] === 'eq' ? '=' : '>'} $${params.length}`;
  };
  return clauses.map((c) => {
    const m = /^and\((.*)\)$/.exec(c);
    return m ? `(${m[1].split(',').map(atom).join(' and ')})` : `(${atom(c)})`;
  }).join(' or ');
}

async function inServiceRole(fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query('set local role service_role');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

async function postgrest(input, init = {}) {
  const url = new URL(input);
  const h = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  if (h.apikey !== serviceKey || h.authorization !== `Bearer ${serviceKey}`) return json({ message: 'Invalid API key' }, 401);
  let m;
  try {
    if ((m = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname))) {
      const args = JSON.parse(init.body || '{}');
      const names = Object.keys(args);
      const sql = `select public.${q(m[1])}(${names.map((n, i) => `${q(n)} => $${i + 1}`).join(', ')}) as r`;
      const vals = names.map((n) => (args[n] !== null && typeof args[n] === 'object' ? JSON.stringify(args[n]) : args[n]));
      const r = await inServiceRole((c) => c.query(sql, vals));
      return new Response(JSON.stringify(r.rows[0].r), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if ((m = /^\/rest\/v1\/([a-z_]+)$/.exec(url.pathname)) && TABLES.has(m[1])) {
      const table = m[1];
      const cols = await columns(table);
      const params = [];
      const where = [];
      let order = '';
      let limit = maxRows;
      let select = '*';
      for (const [k, v] of url.searchParams) {
        if (k === 'select') {
          select = v === '*' ? '*' : v.split(',').map((c) => { if (!cols.has(c)) throw new Error('col'); return q(c); }).join(', ');
        } else if (k === 'order') {
          order = ' order by ' + v.split(',').map((o) => { const [c, d] = o.split('.'); if (!cols.has(c) || !['asc', 'desc'].includes(d)) throw new Error('order'); return `${q(c)} ${d}`; }).join(', ');
        } else if (k === 'limit') {
          limit = Math.min(Number(v), maxRows);
        } else if (k === 'or') {
          where.push(`(${parseOr(v, params, cols)})`);
        } else {
          if (!cols.has(k)) throw new Error(`col ${k}`);
          const mm = /^(eq|gt|is)\.(.*)$/.exec(v);
          if (!mm) throw new Error('op');
          if (mm[1] === 'is') {
            if (mm[2] !== 'null') throw new Error('is');
            where.push(`${q(k)} is null`);
          } else {
            params.push(mm[2]);
            where.push(`${q(k)} ${mm[1] === 'eq' ? '=' : '>'} $${params.length}`);
          }
        }
      }
      const w = where.length ? ` where ${where.join(' and ')}` : '';
      const wantCount = /count=exact/.test(h.prefer ?? '');
      const out = await inServiceRole(async (c) => {
        const body = (await c.query(`select coalesce(json_agg(r), '[]'::json)::text as j, count(*)::int as n from (select ${select} from public.${q(table)}${w}${order} limit ${limit}) r`, params)).rows[0];
        const total = wantCount ? (await c.query(`select count(*)::int n from public.${q(table)}${w}`, params)).rows[0].n : null;
        return { body, total };
      });
      const headers = { 'Content-Type': 'application/json' };
      let status = 200;
      if (wantCount) {
        headers['Content-Range'] = out.body.n ? `0-${out.body.n - 1}/${out.total}` : `*/${out.total}`;
        if (out.body.n < out.total) status = 206;
      }
      return new Response(out.body.j, { status, headers });
    }
    return json({ message: 'not found' }, 404);
  } catch (e) {
    return json({ code: e.code ?? 'PGRST000', message: e.message, hint: e.hint ?? null }, 400);
  }
}

const env = { SUPABASE_URL: supabaseUrl, SUPABASE_ANON_KEY: anonKey, SUPABASE_SERVICE_ROLE_KEY: serviceKey, JOB_SECRET: jobSecret };
const fetchFn = (input, init) => {
  if (!input.startsWith(supabaseUrl)) throw new Error(`worker: unexpected outbound URL ${input}`);
  return postgrest(input, init);
};

parentPort.on('message', async (msg) => {
  if (msg.port) {
    const port = msg.port;
    port.on('message', async ({ payload, sab }) => {
      let out;
      try {
        const req = new Request(payload.url, { method: payload.method, headers: payload.headers, body: payload.body });
        const res = await handleJobsExport(req, env, fetchFn, payload.nowMs);
        out = { status: res.status, text: await res.text(), headers: Object.fromEntries(res.headers.entries()) };
      } catch (e) {
        out = { status: 599, text: String(e && e.stack), headers: {} };
      }
      port.postMessage(out);
      const flag = new Int32Array(sab);
      Atomics.store(flag, 0, 1);
      Atomics.notify(flag, 0);
    });
    parentPort.postMessage({ ready: true });
  }
});
