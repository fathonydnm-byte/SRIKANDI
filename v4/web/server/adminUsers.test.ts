// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { checkTempPassword, handleAdminUsers, MAX_BODY_BYTES, parseAdminRequest } from './adminUsers';
import type { FetchFn, FileEnv } from './env';

const SERVICE_KEY = 'sb_secret_SERVICE_KEY_must_never_leak_0123456789';
const ANON = 'anon-key-public';
const ENV: FileEnv = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_ANON_KEY: ANON, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY };
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln';
const ACTOR = '11111111-1111-4111-8111-111111111111';
const NEW_ID = '22222222-2222-4222-8222-222222222222';
const TARGET = '33333333-3333-4333-8333-333333333333';
const UNIT = '44444444-4444-4444-8444-444444444444';
const RID = '2b8f0c3e-1d2a-4b5c-9d8e-7f6a5b4c3d2e';
const PASSWORD = 'Sementara-Kuat-2026';
const UPSTREAM_SECRET = 'UPSTREAM-BODY-DETAIL-xyz';

interface Call { url: string; path: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null; usesServiceKey: boolean }

interface Opts {
  gate?: Record<string, { error: string; message?: string } | 'ok' | 'throw' | 'weird'>;
  authCreate?: { status: number; body: Record<string, unknown> };
  authPut?: { status: number; body?: Record<string, unknown> };
  authDelete?: { status: number };
  profile?: { status: number; body: Record<string, unknown> };
  userList?: { status: number; body: unknown };
  authGet?: Record<string, unknown>;
}

const business = (code: string, message: string) => ({ code: 'P0001', message: `${code}: ${message}`, hint: code, details: UPSTREAM_SECRET });

function world(o: Opts = {}) {
  const calls: Call[] = [];
  const fetchFn = vi.fn<FetchFn>(async (input, init) => {
    const u = new URL(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const usesServiceKey = JSON.stringify(headers).includes(SERVICE_KEY) || (init?.body ? String(init.body).includes(SERVICE_KEY) : false) || input.includes(SERVICE_KEY);
    calls.push({ url: input, path: u.pathname, method: init?.method ?? 'GET', headers, body, usesServiceKey });
    const method = init?.method ?? 'GET';
    if (u.pathname === '/rest/v1/rpc/user_admin_authorize') {
      const g = o.gate?.[String(body?.p_action)] ?? 'ok';
      if (g === 'throw') throw new TypeError('network down');
      if (g === 'weird') return Response.json({ ok: false });
      if (g === 'ok') return Response.json({ ok: true, actor_id: ACTOR });
      return Response.json(business(g.error, g.message ?? 'Ditolak.'), { status: 400 });
    }
    if (u.pathname === '/rest/v1/rpc/user_list') {
      const l = o.userList ?? { status: 200, body: [{ user_id: TARGET, email: 'siti.rahma@uinsa.ac.id' }] };
      return Response.json(l.body, { status: l.status });
    }
    if (u.pathname === '/rest/v1/rpc/user_profile_upsert_service') {
      const p = o.profile ?? { status: 200, body: { ok: true, user_id: String(body?.p_user_id), created: body?.p_must_change === true && body?.p_full_name != null && body?.p_role != null, changed: true, role: body?.p_role ?? 'PETUGAS', unit_id: UNIT, active: true, must_change_password: true, replayed: false } };
      return Response.json(p.body, { status: p.status });
    }
    if (u.pathname === '/auth/v1/admin/users' && method === 'POST') {
      const c = o.authCreate ?? { status: 200, body: { id: NEW_ID, email: body?.email, encrypted_password: UPSTREAM_SECRET, raw_user_meta_data: { s: UPSTREAM_SECRET } } };
      return Response.json(c.body, { status: c.status });
    }
    if (u.pathname.startsWith('/auth/v1/admin/users/') && method === 'PUT') {
      const p = o.authPut ?? { status: 200, body: { id: TARGET, encrypted_password: UPSTREAM_SECRET } };
      return Response.json(p.body ?? {}, { status: p.status });
    }
    if (u.pathname.startsWith('/auth/v1/admin/users/') && method === 'DELETE') return Response.json({}, { status: o.authDelete?.status ?? 200 });
    if (u.pathname.startsWith('/auth/v1/admin/users/') && method === 'GET') return Response.json(o.authGet ?? { id: TARGET, email: 'siti.rahma@uinsa.ac.id' });
    throw new Error(`unexpected ${method} ${input}`);
  });
  return { fetchFn, calls };
}

function post(body: unknown, init: { auth?: boolean; type?: string; raw?: string; method?: string } = {}) {
  return new Request('https://cf.example/api/admin/users', {
    method: init.method ?? 'POST',
    headers: { ...(init.type === '' ? {} : { 'Content-Type': init.type ?? 'application/json' }), ...(init.auth === false ? {} : { Authorization: `Bearer ${JWT}` }) },
    ...(init.method === 'GET' ? {} : { body: init.raw ?? JSON.stringify(body) }),
  });
}

const CREATE = { action: 'create', requestId: RID, email: 'budi@uinsa.ac.id', fullName: 'Budi Santoso', role: 'PETUGAS', unitId: UNIT, tempPassword: PASSWORD };
const UPDATE = { action: 'update', requestId: RID, userId: TARGET };
const RESET = { action: 'reset-password', requestId: RID, userId: TARGET, tempPassword: PASSWORD };

const serviceCalls = (calls: Call[]) => calls.filter((c) => c.usesServiceKey);
const keyIndexes = (calls: Call[]) => calls.map((c, i) => (c.usesServiceKey ? i : -1)).filter((i) => i >= 0);

let logs: string[];
beforeEach(() => {
  logs = [];
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  }
});
afterEach(() => {
  // Nothing sensitive may ever reach the logs, in any scenario.
  const all = logs.join('\n');
  for (const secret of [SERVICE_KEY, PASSWORD, JWT, UPSTREAM_SECRET, 'budi@uinsa.ac.id']) expect(all).not.toContain(secret);
});

describe('gate first: the service key is untouched unless user_admin_authorize approves', () => {
  const FORBIDDEN = { error: 'FORBIDDEN_TARGET_ROLE', message: 'Admin Unit hanya dapat membuat akun Petugas Arsip dan Pimpinan.' };

  it.each([
    ['create', CREATE, 'create'],
    ['update (role)', { ...UPDATE, role: 'ADMIN_UNIT' }, 'update'],
    ['update (deactivate)', { ...UPDATE, active: false }, 'deactivate'],
    ['update (reactivate)', { ...UPDATE, active: true }, 'reactivate'],
    ['reset-password', RESET, 'reset_password'],
  ])('%s: refused by the gate -> 403, NO request carries the service key, no Auth or profile call', async (_n, body, action) => {
    const { fetchFn, calls } = world({ gate: { [action]: FORBIDDEN } });
    const res = await handleAdminUsers(post(body), ENV, fetchFn);
    expect(res.status).toBe(403);
    const json = (await res.json()) as { ok: boolean; message: string };
    expect(json.ok).toBe(false);
    expect(json.message).toBe(FORBIDDEN.message);
    expect(res.headers.get('X-Api-Code')).toBe('FORBIDDEN_TARGET_ROLE');
    expect(serviceCalls(calls)).toHaveLength(0);
    expect(calls.every((c) => c.path === '/rest/v1/rpc/user_admin_authorize')).toBe(true);
    expect(calls.some((c) => c.path.startsWith('/auth/'))).toBe(false);
  });

  it('the gate is called as the caller: user JWT + anon key, never the service key; p_action/p_target decided by the server', async () => {
    const { fetchFn, calls } = world();
    await handleAdminUsers(post(CREATE), ENV, fetchFn);
    const gate = calls[0]!;
    expect(gate.path).toBe('/rest/v1/rpc/user_admin_authorize');
    expect(gate.headers.Authorization).toBe(`Bearer ${JWT}`);
    expect(gate.headers.apikey).toBe(ANON);
    expect(gate.usesServiceKey).toBe(false);
    expect(gate.body).toEqual({ p_action: 'create', p_target_user_id: null, p_target_unit_id: UNIT, p_target_role: 'PETUGAS' });
    // every service-key call comes after the gate
    expect(Math.min(...keyIndexes(calls))).toBeGreaterThan(0);
  });

  it('several changes -> one gate call per kind, in order; the first refusal stops everything', async () => {
    const ok = world();
    await handleAdminUsers(post({ ...UPDATE, role: 'PIMPINAN', unitId: UNIT, active: false }), ENV, ok.fetchFn);
    expect(ok.calls.filter((c) => c.path.endsWith('user_admin_authorize')).map((c) => c.body?.p_action)).toEqual(['update', 'deactivate']);
    const refused = world({ gate: { deactivate: { error: 'FORBIDDEN_SELF', message: 'Tidak boleh.' } } });
    const res = await handleAdminUsers(post({ ...UPDATE, role: 'PIMPINAN', active: false }), ENV, refused.fetchFn);
    expect(res.status).toBe(403);
    expect(serviceCalls(refused.calls)).toHaveLength(0);
  });

  it('fails closed: an unexpected gate answer, a thrown fetch, or a 401 never reaches the service key', async () => {
    for (const [gate, status] of [[{ create: 'weird' as const }, 403], [{ create: 'throw' as const }, 502]] as const) {
      const w = world({ gate });
      const res = await handleAdminUsers(post(CREATE), ENV, w.fetchFn);
      expect(res.status).toBe(status);
      expect(serviceCalls(w.calls)).toHaveLength(0);
    }
    const unauth = vi.fn<FetchFn>(async () => Response.json({ code: 'PGRST301', message: 'JWT expired' }, { status: 401 }));
    const res = await handleAdminUsers(post(CREATE), ENV, unauth);
    expect(res.status).toBe(401);
    expect(unauth).toHaveBeenCalledTimes(1);
  });

  it('no Authorization header -> 401 without any network call', async () => {
    const { fetchFn, calls } = world();
    const res = await handleAdminUsers(post(CREATE, { auth: false }), ENV, fetchFn);
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('SUPABASE_SERVICE_ROLE_KEY missing -> 503 SERVICE_KEY_MISSING, but only after the gate approved; nothing else is called', async () => {
    const { fetchFn, calls } = world();
    const res = await handleAdminUsers(post(CREATE), { ...ENV, SUPABASE_SERVICE_ROLE_KEY: undefined }, fetchFn);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe('SERVICE_KEY_MISSING');
    expect(calls.map((c) => c.path)).toEqual(['/rest/v1/rpc/user_admin_authorize']);
    // a refused caller learns nothing about configuration
    const refused = world({ gate: { create: { error: 'FORBIDDEN_ROLE', message: 'Tidak boleh.' } } });
    const r2 = await handleAdminUsers(post(CREATE), { ...ENV, SUPABASE_SERVICE_ROLE_KEY: undefined }, refused.fetchFn);
    expect(r2.status).toBe(403);
    const blank = await handleAdminUsers(post(CREATE), { ...ENV, SUPABASE_SERVICE_ROLE_KEY: '' }, world().fetchFn);
    expect(blank.status).toBe(503);
    const noUrl = await handleAdminUsers(post(CREATE), { ...ENV, SUPABASE_URL: undefined }, world().fetchFn);
    expect(noUrl.status).toBe(503);
    expect(((await noUrl.json()) as { code: string }).code).toBe('NOT_CONFIGURED');
  });
});

describe('create', () => {
  it('gate -> Auth admin create (email_confirm) -> profile upsert as the actor from the gate; no secrets in the answer', async () => {
    const { fetchFn, calls } = world();
    const res = await handleAdminUsers(post({ ...CREATE, actorId: 'attacker', p_actor: 'attacker' }), ENV, fetchFn);
    expect(res.status).toBe(200);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /rest/v1/rpc/user_admin_authorize', 'POST /auth/v1/admin/users', 'POST /rest/v1/rpc/user_profile_upsert_service']);
    const auth = calls[1]!;
    expect(auth.url).toBe('https://proj.supabase.co/auth/v1/admin/users');
    expect(auth.headers.Authorization).toBe(`Bearer ${SERVICE_KEY}`);
    expect(auth.body).toEqual({ email: 'budi@uinsa.ac.id', password: PASSWORD, email_confirm: true });
    const prof = calls[2]!;
    expect(prof.body).toEqual({
      p_actor: ACTOR, p_user_id: NEW_ID, p_email: 'budi@uinsa.ac.id', p_full_name: 'Budi Santoso', p_role: 'PETUGAS',
      p_unit_id: UNIT, p_active: null, p_must_change: true, p_request_id: RID });
    const text = await res.text();
    for (const s of [PASSWORD, SERVICE_KEY, UPSTREAM_SECRET, JWT, 'encrypted_password']) expect(text).not.toContain(s);
    const json = JSON.parse(text) as Record<string, unknown>;
    expect(json).toMatchObject({ ok: true, userId: NEW_ID, created: true, mustChangePassword: true, replayed: false });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('email already registered -> 409 EMAIL_EXISTS, no profile call, nothing to compensate', async () => {
    const { fetchFn, calls } = world({ authCreate: { status: 422, body: { code: 422, error_code: 'email_exists', msg: UPSTREAM_SECRET } } });
    const res = await handleAdminUsers(post(CREATE), ENV, fetchFn);
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(text).toContain('EMAIL_EXISTS');
    expect(text).not.toContain(UPSTREAM_SECRET);
    expect(calls.some((c) => c.path.endsWith('user_profile_upsert_service'))).toBe(false);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('Auth rejects the key (401) -> 503 NOT_CONFIGURED; Auth down -> 502; weak_password -> 422', async () => {
    for (const [status, body, expected, code] of [
      [401, { msg: 'bad key' }, 503, 'NOT_CONFIGURED'], [500, { msg: UPSTREAM_SECRET }, 502, 'UPSTREAM'],
      [422, { error_code: 'weak_password' }, 422, 'WEAK_PASSWORD']] as const) {
      const w = world({ authCreate: { status, body } });
      const res = await handleAdminUsers(post(CREATE), ENV, w.fetchFn);
      expect(res.status).toBe(expected);
      expect(((await res.json()) as { code: string }).code).toBe(code);
    }
  });

  it('profile call fails (business error) -> the new auth user is deleted again and the error is mapped', async () => {
    const { fetchFn, calls } = world({ profile: { status: 400, body: business('FORBIDDEN_TARGET_ROLE', 'Admin Unit hanya dapat membuat akun Petugas Arsip dan Pimpinan.') } });
    const res = await handleAdminUsers(post(CREATE), ENV, fetchFn);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message: string }).message).toMatch(/Petugas Arsip dan Pimpinan/);
    const del = calls.find((c) => c.method === 'DELETE')!;
    expect(del.path).toBe(`/auth/v1/admin/users/${NEW_ID}`);
    expect(del.headers.Authorization).toBe(`Bearer ${SERVICE_KEY}`);
    expect(calls.at(-1)).toBe(del);
  });

  it('profile call breaks (500 / network) -> compensated and reported as UPSTREAM', async () => {
    const w = world({ profile: { status: 500, body: { message: UPSTREAM_SECRET } } });
    const res = await handleAdminUsers(post(CREATE), ENV, w.fetchFn);
    expect(res.status).toBe(502);
    expect(w.calls.some((c) => c.method === 'DELETE' && c.path.endsWith(NEW_ID))).toBe(true);
    expect(await res.text()).not.toContain(UPSTREAM_SECRET);
  });

  it('compensation itself fails -> PARTIAL_FAILURE with actionable text and a log without secrets', async () => {
    const w = world({ profile: { status: 500, body: {} }, authDelete: { status: 500 } });
    const res = await handleAdminUsers(post(CREATE), ENV, w.fetchFn);
    expect(res.status).toBe(502);
    const json = (await res.json()) as { code: string; message: string };
    expect(json.code).toBe('PARTIAL_FAILURE');
    expect(json.message).toMatch(/Admin Pusat/);
    expect(logs.some((l) => l.includes('create-compensation-failed') && l.includes(NEW_ID))).toBe(true);
  });

  it('a replayed request id is passed through', async () => {
    const w = world({ profile: { status: 200, body: { ok: true, user_id: NEW_ID, created: true, replayed: true, role: 'PETUGAS', unit_id: UNIT, active: true, must_change_password: true } } });
    const res = await handleAdminUsers(post(CREATE), ENV, w.fetchFn);
    expect(((await res.json()) as { replayed: boolean }).replayed).toBe(true);
  });
});

describe('update', () => {
  it('rename/role only: no Auth call, profile upsert with only the changed fields', async () => {
    const { fetchFn, calls } = world();
    const res = await handleAdminUsers(post({ ...UPDATE, fullName: '  Siti   Rahma ', role: 'PIMPINAN' }), ENV, fetchFn);
    expect(res.status).toBe(200);
    expect(calls.some((c) => c.path.startsWith('/auth/'))).toBe(false);
    expect(calls.at(-1)!.body).toEqual({
      p_actor: ACTOR, p_user_id: TARGET, p_email: null, p_full_name: 'Siti Rahma', p_role: 'PIMPINAN', p_unit_id: null,
      p_active: null, p_must_change: null, p_request_id: RID });
  });

  it('deactivate: ban first, then profile; reactivate: ban cleared', async () => {
    const off = world();
    await handleAdminUsers(post({ ...UPDATE, active: false }), ENV, off.fetchFn);
    expect(off.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /rest/v1/rpc/user_admin_authorize', `PUT /auth/v1/admin/users/${TARGET}`, 'POST /rest/v1/rpc/user_profile_upsert_service']);
    expect(off.calls[1]!.body).toEqual({ ban_duration: '876000h' });
    const on = world();
    await handleAdminUsers(post({ ...UPDATE, active: true }), ENV, on.fetchFn);
    expect(on.calls[1]!.body).toEqual({ ban_duration: 'none' });
  });

  it('profile fails after the ban change -> the ban is restored (compensation)', async () => {
    const off = world({ profile: { status: 400, body: business('LAST_ADMIN_PUSAT', 'Ini satu-satunya Admin Pusat aktif.') } });
    const res = await handleAdminUsers(post({ ...UPDATE, active: false }), ENV, off.fetchFn);
    expect(res.status).toBe(409);
    const puts = off.calls.filter((c) => c.method === 'PUT');
    expect(puts.map((c) => c.body)).toEqual([{ ban_duration: '876000h' }, { ban_duration: 'none' }]);
    const on = world({ profile: { status: 400, body: business('NOT_FOUND', 'Pengguna tidak ditemukan.') } });
    await handleAdminUsers(post({ ...UPDATE, active: true }), ENV, on.fetchFn);
    expect(on.calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([{ ban_duration: 'none' }, { ban_duration: '876000h' }]);
  });

  it('restoring the ban fails too -> PARTIAL_FAILURE', async () => {
    let put = 0;
    const base = world({ profile: { status: 500, body: {} } });
    const fetchFn = vi.fn<FetchFn>(async (url, init) => {
      if (init?.method === 'PUT' && ++put === 2) return Response.json({}, { status: 500 });
      return base.fetchFn(url, init);
    });
    const res = await handleAdminUsers(post({ ...UPDATE, active: false }), ENV, fetchFn);
    expect(((await res.json()) as { code: string }).code).toBe('PARTIAL_FAILURE');
    expect(logs.some((l) => l.includes('update-compensation-failed'))).toBe(true);
  });

  it('Auth ban rejected -> no profile change', async () => {
    const w = world({ authPut: { status: 404, body: {} } });
    const res = await handleAdminUsers(post({ ...UPDATE, active: false }), ENV, w.fetchFn);
    expect(res.status).toBe(404);
    expect(w.calls.some((c) => c.path.endsWith('user_profile_upsert_service'))).toBe(false);
  });
});

describe('reset-password', () => {
  it('gate -> read target email as the caller -> policy -> Auth password -> profile must_change; password never echoed', async () => {
    const { fetchFn, calls } = world();
    const res = await handleAdminUsers(post(RESET), ENV, fetchFn);
    expect(res.status).toBe(200);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /rest/v1/rpc/user_admin_authorize', 'POST /rest/v1/rpc/user_list', `PUT /auth/v1/admin/users/${TARGET}`, 'POST /rest/v1/rpc/user_profile_upsert_service']);
    expect(calls[1]!.usesServiceKey).toBe(false); // read as the caller (RLS)
    expect(calls[1]!.headers.Authorization).toBe(`Bearer ${JWT}`);
    expect(calls[2]!.body).toEqual({ password: PASSWORD });
    expect(calls[3]!.body).toMatchObject({ p_actor: ACTOR, p_user_id: TARGET, p_must_change: true, p_full_name: null, p_active: null });
    const text = await res.text();
    expect(text).not.toContain(PASSWORD);
    expect(JSON.parse(text)).toMatchObject({ ok: true, mustChangePassword: true });
  });

  it("policy uses the TARGET's email: a password containing the local-part is refused before any Auth call", async () => {
    const w = world();
    const res = await handleAdminUsers(post({ ...RESET, tempPassword: 'xx-Siti.Rahma-99!' }), ENV, w.fetchFn);
    expect(res.status).toBe(422);
    expect(w.calls.some((c) => c.path.startsWith('/auth/'))).toBe(false);
    expect(await res.text()).not.toContain('xx-Siti');
  });

  it('falls back to the Auth admin lookup when the profile has no email snapshot', async () => {
    const w = world({ userList: { status: 200, body: [{ user_id: TARGET, email: null }] }, authGet: { id: TARGET, email: 'siti.rahma@uinsa.ac.id' } });
    const res = await handleAdminUsers(post({ ...RESET, tempPassword: 'abc-siti.rahma-123' }), ENV, w.fetchFn);
    expect(res.status).toBe(422);
    expect(w.calls.some((c) => c.method === 'GET' && c.path === `/auth/v1/admin/users/${TARGET}`)).toBe(true);
  });

  it('profile call fails after the password changed -> PARTIAL_FAILURE telling the admin to repeat', async () => {
    const w = world({ profile: { status: 500, body: {} } });
    const res = await handleAdminUsers(post(RESET), ENV, w.fetchFn);
    expect(res.status).toBe(502);
    const j = (await res.json()) as { code: string; message: string };
    expect(j.code).toBe('PARTIAL_FAILURE');
    expect(j.message).toMatch(/Ulangi/);
  });
});

describe('temporary password policy', () => {
  it.each([
    ['', 'wajib'], ['pendek12', 'minimal 10'], ['x'.repeat(73), 'maksimal 72'], [' spasi-di-awal1', 'spasi'], ['tab\tdi-tengah-1', 'tidak diizinkan'],
    ['xxBUDI-yy-123', 'nama pada email'], ['budi1234567', 'nama pada email'],
  ])('rejects %j', (pw, fragment) => {
    expect(checkTempPassword(pw, 'budi@uinsa.ac.id')).toContain(fragment);
  });
  it('accepts a good one; a 1-2 character local-part does not make everything fail', () => {
    expect(checkTempPassword('Kuat-Sekali-77', 'budi@uinsa.ac.id')).toBeNull();
    expect(checkTempPassword('Abcdefghij12', 'a@uinsa.ac.id')).toBeNull();
    expect(checkTempPassword(undefined, null)).toMatch(/wajib/);
    expect(checkTempPassword('x'.repeat(10), null)).toBeNull();
  });
  it('an invalid temp password is refused with 422 before ANY network call, and is not echoed', async () => {
    const { fetchFn, calls } = world();
    const res = await handleAdminUsers(post({ ...CREATE, tempPassword: 'budi-sementara' }), ENV, fetchFn);
    expect(res.status).toBe(422);
    expect(calls).toHaveLength(0);
    expect(await res.text()).not.toContain('budi-sementara');
  });
});

describe('request shape', () => {
  it('rejects wrong method, content type, invalid JSON, oversize body, unknown action, bad ids', async () => {
    const { fetchFn, calls } = world();
    expect((await handleAdminUsers(post(null, { method: 'GET' }), ENV, fetchFn)).status).toBe(405);
    expect((await handleAdminUsers(post(CREATE, { type: 'text/plain' }), ENV, fetchFn)).status).toBe(400);
    expect((await handleAdminUsers(post(null, { raw: '{nope' }), ENV, fetchFn)).status).toBe(400);
    expect((await handleAdminUsers(post(null, { raw: JSON.stringify({ ...CREATE, fullName: 'x'.repeat(MAX_BODY_BYTES) }) }), ENV, fetchFn)).status).toBe(413);
    expect((await handleAdminUsers(post({ ...CREATE, action: 'delete' }), ENV, fetchFn)).status).toBe(400);
    expect((await handleAdminUsers(post({ ...CREATE, requestId: 'x' }), ENV, fetchFn)).status).toBe(400);
    expect((await handleAdminUsers(post({ ...CREATE, role: 'ROOT' }), ENV, fetchFn)).status).toBe(400);
    expect((await handleAdminUsers(post({ ...CREATE, email: 'bukan-email' }), ENV, fetchFn)).status).toBe(400);
    expect((await handleAdminUsers(post({ ...CREATE, unitId: 'x' }), ENV, fetchFn)).status).toBe(400);
    expect((await handleAdminUsers(post({ ...UPDATE, userId: 'x', fullName: 'A' }), ENV, fetchFn)).status).toBe(400);
    expect((await handleAdminUsers(post({ ...UPDATE }), ENV, fetchFn)).status).toBe(400);
    expect((await handleAdminUsers(post({ ...UPDATE, active: 'ya' }), ENV, fetchFn)).status).toBe(400);
    expect((await handleAdminUsers(post([]), ENV, fetchFn)).status).toBe(400);
    expect(calls).toHaveLength(0);
  });
  it('normalises email and name', () => {
    const r = parseAdminRequest({ ...CREATE, email: '  Budi@UINSA.ac.id ', fullName: '  Budi   S  ' });
    expect(r.ok && r.value.action === 'create' && [r.value.email, r.value.fullName]).toEqual(['budi@uinsa.ac.id', 'Budi S']);
  });
});

describe('the service key stays inside two server modules', () => {
  const root = join(__dirname, '..');
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? (n === 'node_modules' ? [] : files(p)) : [p];
    });
  }
  const hits = [...files(join(root, 'src')), ...files(join(root, 'server')), ...files(join(root, 'functions')), ...files(join(root, 'public'))]
    .filter((f) => /\.(ts|tsx|js|json|html|svg|webmanifest)$/.test(f))
    .filter((f) => readFileSync(f, 'utf8').includes('SUPABASE_SERVICE_ROLE_KEY'))
    .map((f) => relative(root, f))
    .sort();
  it('is referenced by no browser code and by no other server module (deliberately: adminUsers.ts and, since Sprint 3, jobsExport.ts)', () => {
    expect(hits.filter((f) => !f.endsWith('.test.ts'))).toEqual(['server/adminUsers.ts', 'server/env.ts', 'server/jobsExport.ts']);
  });
  it('tests may mention it only in the two modules\' own tests and the export round-trip test', () => {
    expect(hits.filter((f) => f.endsWith('.test.ts'))).toEqual(['server/adminUsers.test.ts', 'server/jobsExport.test.ts', 'server/jobsRoundtrip.test.ts']);
  });
  it('the job secret is read only by jobsExport.ts', () => {
    const js = [...files(join(root, 'src')), ...files(join(root, 'server')), ...files(join(root, 'functions'))]
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith('.test.ts'))
      .filter((f) => readFileSync(f, 'utf8').includes('JOB_SECRET'))
      .map((f) => relative(root, f))
      .sort();
    expect(js).toEqual(['server/env.ts', 'server/jobsExport.ts']);
  });
});
