// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hmacSha256, sha256Hex, toHex } from './crypto';
import type { FetchFn, FileEnv } from './env';
import { canonicalJson, EXPORT_TABLES, handleJobsExport, jobCanonicalString, MAX_PAGE_LIMIT, signJobRequest } from './jobsExport';

const SECRET = 'job-secret-' + 'x'.repeat(40);
const SERVICE_KEY = 'sb_secret_SERVICE_KEY_must_never_leak_0123456789';
const ENV: FileEnv = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_ANON_KEY: 'anon-public', SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, JOB_SECRET: SECRET };
const UNIT = '44444444-4444-4444-8444-444444444444';
const OTHER_UNIT = '55555555-5555-4555-8555-555555555555';
const RUN = '66666666-6666-4666-8666-666666666666';
const NOW = 1_800_000_000_000;
const NOW_S = NOW / 1000;
let n = 0;
const nonce = () => `nonce${String(++n).padStart(4, '0')}abcdefghijkl`;

interface Call { url: string; path: string; method: string; headers: Record<string, string>; body: unknown }
interface Opts {
  fresh?: boolean | 'error' | 'throw';
  pageBody?: string;
  pageStatus?: number;
  contentRange?: string;
  units?: unknown;
  version?: string;
  rpc?: Record<string, { status?: number; body: unknown }>;
}

function world(o: Opts = {}) {
  const calls: Call[] = [];
  const fetchFn: FetchFn = async (input, init) => {
    const url = new URL(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    calls.push({ url: input, path: url.pathname, method: init?.method ?? 'GET', headers, body });
    const j = (b: unknown, status = 200, h: Record<string, string> = {}) => new Response(typeof b === 'string' ? b : JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json', ...h } });
    if (url.pathname === '/rest/v1/rpc/job_nonce_record') {
      if (o.fresh === 'throw') throw new Error('network');
      if (o.fresh === 'error') return j({ code: 'XX000', message: 'boom ' + SERVICE_KEY }, 500);
      return j(o.fresh !== false);
    }
    const rpc = /\/rest\/v1\/rpc\/(.+)$/.exec(url.pathname)?.[1];
    if (rpc && o.rpc?.[rpc]) return j(o.rpc[rpc]!.body, o.rpc[rpc]!.status ?? 200);
    if (rpc === 'job_run_begin') return j(JSON.stringify(RUN));
    if (rpc === 'job_run_finish') return j({ ok: true });
    if (url.pathname === '/rest/v1/units') return j(o.units ?? [{ id: UNIT, code: 'BAU', name: 'Biro Umum', active: true }]);
    if (url.pathname === '/rest/v1/schema_migrations_log') return j([{ version: o.version ?? '0022' }]);
    if (url.pathname.startsWith('/rest/v1/')) {
      return j(o.pageBody ?? '[{"id":"a"},{"id":"b"}]', o.pageStatus ?? 200, o.contentRange ? { 'Content-Range': o.contentRange } : {});
    }
    return j({}, 404);
  };
  return { fetchFn, calls, rest: () => calls.filter((c) => !c.path.includes('/rpc/')) };
}

async function post(action: string, params: Record<string, unknown> = {}, over: Record<string, unknown> = {}, secret = SECRET): Promise<Request> {
  const body = { ...(await signJobRequest(secret, action, NOW_S, nonce(), params)), ...over };
  return new Request('https://app.example/api/jobs/export', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } });
}
const call = (req: Request, fetchFn: FetchFn, env: FileEnv = ENV) => handleJobsExport(req, env, fetchFn, NOW);
const text = async (r: Response) => r.text();
const DENIED = { ok: false, code: 'JOB_DENIED', message: 'Permintaan ditolak.' };

let logs: string[];
beforeEach(() => {
  logs = [];
  for (const m of ['log', 'warn', 'error', 'info', 'debug'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('canonical string and signature (shared contract with mirror-apps-script)', () => {
  it('canonicalJson sorts keys recursively, keeps array order, no spaces', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null }, e: 'x"y' })).toBe('{"a":{"c":null,"d":[3,1]},"b":1,"e":"x\\"y"}');
    expect(canonicalJson({ a: undefined, b: 2 })).toBe('{"b":2}');
    expect(canonicalJson({})).toBe('{}');
  });
  it('fixed vector (the Apps Script test asserts the very same string and signature)', async () => {
    const params = { unit_id: UNIT, table: 'item', after: ['ITM-1'], limit: 1000 };
    const canonical = await jobCanonicalString('TABLE_PAGE', 1_800_000_000, 'abcdefghijklmnop', params);
    expect(canonical).toBe(`CFJOB1\nTABLE_PAGE\n1800000000\nabcdefghijklmnop\n${await sha256Hex('{"after":["ITM-1"],"limit":1000,"table":"item","unit_id":"44444444-4444-4444-8444-444444444444"}')}`);
    expect(toHex(await hmacSha256('s'.repeat(64), canonical))).toBe(VECTOR_SIG);
  });
});
// computed once from the line above; the Apps Script test pins the same value
const VECTOR_SIG = 'fa25fb9755694e94180c5e73bab1623dd19aa7cf5d08aa8a64955ee80d12b697';

describe('configuration', () => {
  it.each([
    ['JOB_SECRET missing', { JOB_SECRET: undefined }],
    ['JOB_SECRET too short', { JOB_SECRET: 'short' }],
    ['service key missing', { SUPABASE_SERVICE_ROLE_KEY: undefined }],
    ['service key blank', { SUPABASE_SERVICE_ROLE_KEY: '' }],
    ['SUPABASE_URL missing', { SUPABASE_URL: undefined }],
  ])('%s -> 503 JOB_NOT_CONFIGURED and nothing is called', async (_n, over) => {
    const w = world();
    const res = await call(await post('LIST_UNITS'), w.fetchFn, { ...ENV, ...over });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('JOB_NOT_CONFIGURED');
    expect(w.calls).toHaveLength(0);
  });
  it('only POST', async () => {
    const w = world();
    const res = await call(new Request('https://app.example/api/jobs/export', { method: 'GET' }), w.fetchFn);
    expect(res.status).toBe(405);
    expect(w.calls).toHaveLength(0);
  });
});

describe('authentication: every failure is the same generic 401 and touches nothing', () => {
  const cases: [string, () => Promise<Request>][] = [
    ['bad signature', () => post('LIST_UNITS', {}, { sig: '0'.repeat(64) })],
    ['wrong secret', () => post('LIST_UNITS', {}, {}, 'w'.repeat(64))],
    ['stale ts', async () => new Request('https://x/api', { method: 'POST', body: JSON.stringify(await signJobRequest(SECRET, 'LIST_UNITS', NOW_S - 121, nonce())) })],
    ['future ts', async () => new Request('https://x/api', { method: 'POST', body: JSON.stringify(await signJobRequest(SECRET, 'LIST_UNITS', NOW_S + 121, nonce())) })],
    ['ts as string', () => post('LIST_UNITS', {}, { ts: String(NOW_S) })],
    ['ts fractional', () => post('LIST_UNITS', {}, { ts: NOW_S + 0.5 })],
    ['short nonce', () => post('LIST_UNITS', {}, { nonce: 'short' })],
    ['nonce with spaces', () => post('LIST_UNITS', {}, { nonce: 'has spaces in it!!!!!!' })],
    ['unknown action', () => post('DROP_EVERYTHING')],
    ['action missing', () => post('LIST_UNITS', {}, { action: undefined })],
    ['sig uppercase/short', () => post('LIST_UNITS', {}, { sig: 'ABC' })],
    ['not json', async () => new Request('https://x/api', { method: 'POST', body: 'nope' })],
    ['json array', async () => new Request('https://x/api', { method: 'POST', body: '[]' })],
    ['json null', async () => new Request('https://x/api', { method: 'POST', body: 'null' })],
    ['too large', async () => new Request('https://x/api', { method: 'POST', body: JSON.stringify({ a: 'x'.repeat(40000) }) })],
    ['empty body', async () => new Request('https://x/api', { method: 'POST' })],
  ];
  it.each(cases)('%s', async (_name, make) => {
    const w = world();
    const res = await call(await make(), w.fetchFn);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(DENIED);
    expect(w.calls).toHaveLength(0);
  });

  it('the signature covers every parameter: changing the unit, table, cursor or limit after signing is refused', async () => {
    const params = { unit_id: UNIT, table: 'item', after: 'ITM-1', limit: 100 };
    for (const tamper of [{ unit_id: OTHER_UNIT }, { table: 'berkas' }, { after: 'ITM-0' }, { limit: 2000 }, { extra: 1 }]) {
      const w = world();
      const res = await call(await post('TABLE_PAGE', params, tamper), w.fetchFn);
      expect(res.status, JSON.stringify(tamper)).toBe(401);
      expect(w.calls).toHaveLength(0);
    }
    // sanity: untampered passes
    const w = world();
    expect((await call(await post('TABLE_PAGE', params), w.fetchFn)).status).toBe(200);
  });

  it('a signature made for another action cannot be reused (action is part of the canonical string)', async () => {
    const req = await signJobRequest(SECRET, 'LIST_UNITS', NOW_S, nonce());
    const w = world();
    const res = await call(new Request('https://x/api', { method: 'POST', body: JSON.stringify({ ...req, action: 'RUN_BEGIN', kind: 'BACKUP', unit_id: UNIT }) }), w.fetchFn);
    expect(res.status).toBe(401);
  });

  it('accepts a clock skew up to 120 s', async () => {
    for (const d of [-120, 119]) {
      const w = world();
      const req = new Request('https://x/api', { method: 'POST', body: JSON.stringify(await signJobRequest(SECRET, 'LIST_UNITS', NOW_S + d, nonce())) });
      expect((await call(req, w.fetchFn)).status).toBe(200);
    }
  });

  it('replay: the nonce is recorded in the DB; a nonce the DB has seen is refused and nothing else is called', async () => {
    const w = world({ fresh: false });
    const res = await call(await post('LIST_UNITS'), w.fetchFn);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(DENIED);
    expect(w.calls.map((c) => c.path)).toEqual(['/rest/v1/rpc/job_nonce_record']);
  });

  it('records the nonce through the service-only RPC with the action', async () => {
    const w = world();
    const req = await post('LIST_UNITS');
    await call(req, w.fetchFn);
    const first = w.calls[0]!;
    expect(first.path).toBe('/rest/v1/rpc/job_nonce_record');
    expect(first.body).toMatchObject({ p_action: 'LIST_UNITS' });
    expect(first.headers.Authorization).toBe(`Bearer ${SERVICE_KEY}`);
  });

  it('nonce store failing (DB down) -> 502, never fail-open', async () => {
    for (const fresh of ['error', 'throw'] as const) {
      const w = world({ fresh });
      const res = await call(await post('LIST_UNITS'), w.fetchFn);
      expect(res.status).toBe(502);
      expect(w.calls.filter((c) => !c.path.includes('job_nonce_record'))).toHaveLength(0);
      expect(await text(res)).not.toContain(SERVICE_KEY);
    }
  });
});

describe('TABLE_PAGE', () => {
  const page = (over: Record<string, unknown> = {}) => ({ unit_id: UNIT, table: 'item', ...over });

  it('streams the Supabase body through unchanged and reads with the service key, scoped to ONE unit, keyset-ordered', async () => {
    const body = '[{"id":"ITM-1","uraian":"Surat \\"A\\""},{"id":"ITM-2"}]';
    const w = world({ pageBody: body, contentRange: '0-1/4321' });
    const res = await call(await post('TABLE_PAGE', page()), w.fetchFn);
    expect(res.status).toBe(200);
    expect(await text(res)).toBe(body);
    expect(res.headers.get('X-Total-Count')).toBe('4321');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const rest = w.rest();
    expect(rest).toHaveLength(1);
    const u = new URL(rest[0]!.url);
    expect(u.pathname).toBe('/rest/v1/item');
    expect(u.searchParams.get('select')).toBe('*');
    expect(u.searchParams.get('unit_id')).toBe(`eq.${UNIT}`);
    expect(u.searchParams.get('order')).toBe('id.asc');
    expect(u.searchParams.get('limit')).toBe('1000');
    expect(rest[0]!.headers.Prefer).toBe('count=exact');
    expect(rest[0]!.headers.apikey).toBe(SERVICE_KEY);
  });

  it('later pages: keyset filter, no count (cheaper), no total header', async () => {
    const w = world({ contentRange: '0-1/4321' });
    const res = await call(await post('TABLE_PAGE', page({ after: 'ITM-9&x=1', limit: 50 })), w.fetchFn);
    const r = w.rest()[0]!;
    const u = new URL(r.url);
    expect(u.searchParams.get('id')).toBe('gt.ITM-9&x=1'); // encoded, cannot smuggle a parameter
    expect([...u.searchParams.keys()].sort()).toEqual(['id', 'limit', 'order', 'select', 'unit_id']);
    expect(u.searchParams.get('limit')).toBe('50');
    expect(r.headers.Prefer).toBeUndefined();
    expect(res.headers.get('X-Total-Count')).toBeNull();
  });

  it('limit is capped at 2000, defaults to 1000, and rejects nonsense', async () => {
    const lim = async (limit: unknown) => {
      const w = world();
      const res = await call(await post('TABLE_PAGE', page({ limit })), w.fetchFn);
      return { status: res.status, limit: w.rest()[0] ? new URL(w.rest()[0]!.url).searchParams.get('limit') : null };
    };
    expect(MAX_PAGE_LIMIT).toBe(2000);
    expect(await lim(5000)).toEqual({ status: 200, limit: '2000' });
    expect(await lim(2000)).toEqual({ status: 200, limit: '2000' });
    expect(await lim(1)).toEqual({ status: 200, limit: '1' });
    for (const bad of [0, -1, 1.5, '10', null, true]) expect((await lim(bad)).status, String(bad)).toBe(400);
  });

  it('composite key (counters) uses a safe or=() keyset; unsafe or non-numeric parts are refused', async () => {
    const w = world();
    const res = await call(await post('TABLE_PAGE', { unit_id: UNIT, table: 'counters', after: ['TRM', 2026] }), w.fetchFn);
    expect(res.status).toBe(200);
    const u = new URL(w.rest()[0]!.url);
    expect(u.searchParams.get('order')).toBe('scope.asc,year.asc');
    expect(u.searchParams.get('or')).toBe('(scope.gt.TRM,and(scope.eq.TRM,year.gt.2026))');
    for (const after of [['TRM)', 2026], ['TRM', '2026'], 'TRM', ['TRM'], ['a,b', 1], [1, 2, 3], [{}, 1], ['TRM', 2026.5]]) {
      const w2 = world();
      expect((await call(await post('TABLE_PAGE', { unit_id: UNIT, table: 'counters', after }), w2.fetchFn)).status, JSON.stringify(after)).toBe(400);
      expect(w2.rest()).toHaveLength(0);
    }
  });

  it('allow-list: auth.users, vault, unknown tables and deliberately excluded tables are refused (400) and never fetched', async () => {
    for (const table of ['auth.users', 'users', 'auth', 'vault.secrets', 'profiles', 'idempotency_keys', 'upload_sessions', 'schema_migrations_log',
      'job_nonces', 'backup_runs', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'item; drop table item', 'item?select=*', '../auth/v1/admin/users', '', 'ITEM', ' item', 7, null]) {
      const w = world();
      const res = await call(await post('TABLE_PAGE', page({ table })), w.fetchFn);
      expect(res.status, String(table)).toBe(400);
      expect(w.rest(), String(table)).toHaveLength(0);
    }
  });

  it('every allow-listed table is served; units is scoped by id, the rest by unit_id', async () => {
    for (const [table, def] of Object.entries(EXPORT_TABLES)) {
      const w = world();
      expect((await call(await post('TABLE_PAGE', { unit_id: UNIT, table }), w.fetchFn)).status, table).toBe(200);
      const u = new URL(w.rest()[0]!.url);
      expect(u.pathname).toBe(`/rest/v1/${table}`);
      expect(u.searchParams.get(def.unitColumn)).toBe(`eq.${UNIT}`);
      expect(u.searchParams.get('order')).toBe(def.key.map((k) => `${k}.asc`).join(','));
    }
  });

  it('exactly one unit per request: GLOBAL only for audit_log (unit_id IS NULL); malformed unit ids and extra params refused', async () => {
    const w = world();
    expect((await call(await post('TABLE_PAGE', { unit_id: 'GLOBAL', table: 'audit_log' }), w.fetchFn)).status).toBe(200);
    expect(new URL(w.rest()[0]!.url).searchParams.get('unit_id')).toBe('is.null');
    for (const body of [
      { unit_id: 'GLOBAL', table: 'berkas' }, { unit_id: 'GLOBAL', table: 'units' }, { unit_id: null, table: 'item' }, { unit_id: '*', table: 'item' },
      { unit_id: 'all', table: 'item' }, { unit_id: `${UNIT},${OTHER_UNIT}`, table: 'item' }, { unit_id: `${UNIT}&or=(id.neq.x)`, table: 'item' },
      { unit_id: [UNIT], table: 'item' }, { table: 'item' }, { unit_id: UNIT }, { unit_id: UNIT, table: 'item', select: 'password' },
      { unit_id: UNIT, table: 'item', filter: 'id=eq.1' },
    ]) {
      const w2 = world();
      expect((await call(await post('TABLE_PAGE', body), w2.fetchFn)).status, JSON.stringify(body)).toBe(400);
      expect(w2.rest()).toHaveLength(0);
    }
  });

  it('upstream trouble -> generic 502; upstream detail and the key never reach the caller or the logs', async () => {
    for (const w of [world({ pageStatus: 500, pageBody: `{"message":"relation leaked ${SERVICE_KEY}"}` }), world({ pageStatus: 401, pageBody: '{"message":"Invalid API key"}' })]) {
      const res = await call(await post('TABLE_PAGE', page()), w.fetchFn);
      expect(res.status).toBe(502);
      const t = await text(res);
      expect(t).not.toContain(SERVICE_KEY);
      expect(t).not.toContain('leaked');
      expect(t).not.toContain('Invalid API key');
    }
    const thrower: FetchFn = async (input) => { if (input.includes('/rpc/')) return new Response('true', { headers: { 'Content-Type': 'application/json' } }); throw new Error(`down ${SERVICE_KEY}`); };
    const res = await call(await post('TABLE_PAGE', page()), thrower);
    expect(res.status).toBe(502);
    expect(await text(res)).not.toContain(SERVICE_KEY);
    expect(logs.join('\n')).not.toContain(SERVICE_KEY);
  });

  it('the service key and the job secret never appear in any successful response, header or log', async () => {
    const w = world({ contentRange: '0-1/2' });
    const res = await call(await post('TABLE_PAGE', page()), w.fetchFn);
    const hdr = JSON.stringify([...res.headers.entries()]);
    expect(hdr + (await text(res)) + logs.join('\n')).not.toMatch(new RegExp(`${SERVICE_KEY}|${SECRET}`));
  });
});

describe('LIST_UNITS', () => {
  it('returns schema version, table keys and every unit plus the cross-unit pseudo unit', async () => {
    const w = world({ version: '0022', units: [{ id: UNIT, code: 'BAU', name: 'Biro Umum', active: true }, { id: OTHER_UNIT, code: 'LPM', name: 'LPM', active: false }] });
    const res = await call(await post('LIST_UNITS'), w.fetchFn);
    const j = (await res.json()) as { ok: boolean; schema_version: string; tables: Record<string, { key: string[] }>; units: { id: string; code: string; tables: string[]; backup_only: boolean }[] };
    expect(j.ok).toBe(true);
    expect(j.schema_version).toBe('0022');
    expect(j.tables.counters!.key).toEqual(['scope', 'year']);
    expect(Object.keys(j.tables).sort()).toEqual(Object.keys(EXPORT_TABLES).sort());
    expect(j.units.map((u) => u.code)).toEqual(['BAU', 'LPM', '_PLATFORM']);
    expect(j.units[2]).toMatchObject({ id: 'GLOBAL', tables: ['audit_log'], backup_only: true });
    expect(j.units[0]!.tables).toContain('item');
    expect(JSON.stringify(j)).not.toContain(SERVICE_KEY);
  });
  it('takes no parameters; unit tables are never returned', async () => {
    const w = world();
    expect((await call(await post('LIST_UNITS', { unit_id: UNIT }), w.fetchFn)).status).toBe(400);
  });
});

describe('RUN_BEGIN / RUN_FINISH', () => {
  it('begin: passes kind and unit; GLOBAL becomes NULL; returns the run id', async () => {
    const w = world();
    const res = await call(await post('RUN_BEGIN', { kind: 'BACKUP', unit_id: UNIT }), w.fetchFn);
    expect(await res.json()).toEqual({ ok: true, run_id: RUN });
    expect(w.calls.at(-1)!.body).toEqual({ p_kind: 'BACKUP', p_unit_id: UNIT });
    const w2 = world();
    await call(await post('RUN_BEGIN', { kind: 'BACKUP', unit_id: 'GLOBAL' }), w2.fetchFn);
    expect(w2.calls.at(-1)!.body).toEqual({ p_kind: 'BACKUP', p_unit_id: null });
  });
  it('begin: bad kind, a mirror without a unit, bad unit', async () => {
    for (const p of [{ kind: 'DROP', unit_id: UNIT }, { kind: 'MIRROR', unit_id: 'GLOBAL' }, { kind: 'MIRROR', unit_id: null }, { kind: 'BACKUP', unit_id: 'x' }, { kind: 'BACKUP' }]) {
      const w = world();
      expect((await call(await post('RUN_BEGIN', p), w.fetchFn)).status, JSON.stringify(p)).toBe(400);
      expect(w.calls.filter((c) => c.path.includes('job_run_begin'))).toHaveLength(0);
    }
  });
  const SHEET = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit';
  it('finish: maps every field to the RPC; control characters are stripped and the error is cut to 500', async () => {
    const w = world();
    const res = await call(await post('RUN_FINISH', {
      run_id: RUN, status: 'FAILED', stats: { total_rows: 5, tables: { item: 5 } }, mirror_url: SHEET, mirror_file_id: '1AbCdEfGhIjKlMnOpQrSt', backup_file_id: 'folderAbCdEfGh01', error: 'baris\n1\u0000 ' + 'e'.repeat(900),
    }), w.fetchFn);
    expect(await res.json()).toEqual({ ok: true });
    const b = w.calls.at(-1)!.body as Record<string, unknown>;
    expect(b).toMatchObject({ p_run_id: RUN, p_status: 'FAILED', p_stats: { total_rows: 5, tables: { item: 5 } }, p_mirror_url: SHEET, p_mirror_file_id: '1AbCdEfGhIjKlMnOpQrSt', p_backup_file_id: 'folderAbCdEfGh01' });
    expect(String(b.p_error)).toMatch(/^baris 1\s+e+$/);
    expect(String(b.p_error).length).toBeLessThanOrEqual(500);
  });
  it('finish: optional fields default to null; invalid values are refused before the DB', async () => {
    const w = world();
    await call(await post('RUN_FINISH', { run_id: RUN, status: 'SUCCESS', stats: {} }), w.fetchFn);
    expect(w.calls.at(-1)!.body).toMatchObject({ p_mirror_url: null, p_mirror_file_id: null, p_backup_file_id: null, p_error: null });
    for (const p of [
      { run_id: 'x', status: 'SUCCESS', stats: {} }, { run_id: RUN, status: 'RUNNING', stats: {} }, { run_id: RUN, status: 'SUCCESS', stats: [] },
      { run_id: RUN, status: 'SUCCESS', stats: { blob: 'x'.repeat(13000) } }, { run_id: RUN, status: 'SUCCESS', stats: {}, mirror_url: 'https://evil.example/spreadsheets/d/1AbCdEfGhIjKlMnOpQrSt' },
      { run_id: RUN, status: 'SUCCESS', stats: {}, mirror_url: 'javascript:alert(1)' }, { run_id: RUN, status: 'SUCCESS', stats: {}, backup_file_id: "a'b" },
      { run_id: RUN, status: 'SUCCESS', stats: {}, extra: 1 }, { run_id: RUN, status: 'SUCCESS' },
    ]) {
      const w2 = world();
      expect((await call(await post('RUN_FINISH', p), w2.fetchFn)).status, JSON.stringify(p).slice(0, 80)).toBe(400);
      expect(w2.calls.filter((c) => c.path.includes('job_run_finish'))).toHaveLength(0);
    }
  });
  it('finish: an already finished run -> 409; unknown run -> 404; other DB errors -> 502 without detail', async () => {
    const err = (hint: string, status = 400) => ({ status, body: { code: 'P0001', hint, message: `${hint}: pesan` } });
    for (const [hint, status] of [['RUN_FINISHED', 409], ['NOT_FOUND', 404]] as const) {
      const w = world({ rpc: { job_run_finish: err(hint) } });
      expect((await call(await post('RUN_FINISH', { run_id: RUN, status: 'SUCCESS', stats: {} }), w.fetchFn)).status).toBe(status);
    }
    const w = world({ rpc: { job_run_finish: { status: 500, body: { code: 'XX000', message: `secret ${SERVICE_KEY}` } } } });
    const res = await call(await post('RUN_FINISH', { run_id: RUN, status: 'SUCCESS', stats: {} }), w.fetchFn);
    expect(res.status).toBe(502);
    expect(await text(res)).not.toContain(SERVICE_KEY);
  });
});
