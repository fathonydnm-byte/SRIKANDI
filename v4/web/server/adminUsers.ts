import type { FetchFn, FileEnv } from './env';
import { json, jsonError, type ErrorCode } from './http';
import { bearer, callRpc, type RpcOutcome } from './supabaseRpc';

/**
 * Kelola Pengguna: POST /api/admin/users
 *   {action:'create', requestId, email, fullName, role, unitId, tempPassword}
 *   {action:'update', requestId, userId, fullName?, role?, unitId?, active?}
 *   {action:'reset-password', requestId, userId, tempPassword}
 * Authorization: Bearer <JWT Supabase pengguna>
 *
 * URUTAN (tidak boleh dibalik):
 *   1. validasi bentuk permintaan (tanpa jaringan);
 *   2. GERBANG: `user_admin_authorize` dipanggil SEBAGAI PEMANGGIL (anon key + JWT-nya).
 *      Ditolak => selesai; kunci service-role TIDAK PERNAH disentuh;
 *   3. baru kemudian SUPABASE_SERVICE_ROLE_KEY dipakai (Auth Admin REST + `user_profile_upsert_service`,
 *      yang memeriksa ulang aturan yang sama untuk p_actor);
 *   4. kegagalan sebagian dikompensasi (hapus akun login yang baru dibuat / pulihkan blokir login).
 *
 * Kunci service-role HANYA dipakai di modul ini. Kata sandi dan kunci tidak pernah dicatat di log,
 * tidak dikirim balik, dan badan jawaban Supabase Auth tidak diteruskan ke klien.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLES = ['ADMIN_PUSAT', 'ADMIN_UNIT', 'PETUGAS', 'PIMPINAN'] as const;
type Role = (typeof ROLES)[number];

export const MAX_BODY_BYTES = 16 * 1024;
export const TEMP_PASSWORD_MIN = 10;
/** Batas bcrypt/GoTrue: 72 byte. */
export const TEMP_PASSWORD_MAX = 72;
const BAN_FOREVER = '876000h'; // ±100 tahun
const AUTH_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Kebijakan kata sandi sementara
// ---------------------------------------------------------------------------
/** Alasan penolakan (Indonesia) atau null bila memenuhi syarat. Tidak pernah memuat kata sandinya. */
export function checkTempPassword(password: unknown, email: string | null): string | null {
  if (typeof password !== 'string' || password.length === 0) return 'Kata sandi sementara wajib diisi.';
  if (password.length < TEMP_PASSWORD_MIN) return `Kata sandi sementara minimal ${TEMP_PASSWORD_MIN} karakter.`;
  if (new TextEncoder().encode(password).length > TEMP_PASSWORD_MAX) return `Kata sandi sementara maksimal ${TEMP_PASSWORD_MAX} karakter.`;
  if (password !== password.trim()) return 'Kata sandi sementara tidak boleh diawali atau diakhiri spasi.';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(password)) return 'Kata sandi sementara memuat karakter yang tidak diizinkan.';
  const local = (email ?? '').split('@')[0]?.trim().toLowerCase() ?? '';
  // bagian lokal 1-2 karakter nyaris selalu "terkandung"; aturan berlaku mulai 3 karakter
  if (local.length >= 3 && password.toLowerCase().includes(local)) return 'Kata sandi sementara tidak boleh memuat nama pada email pengguna.';
  return null;
}

// ---------------------------------------------------------------------------
// Bentuk permintaan
// ---------------------------------------------------------------------------
type Parsed =
  | { action: 'create'; requestId: string; email: string; fullName: string; role: Role; unitId: string | null; tempPassword: string }
  | { action: 'update'; requestId: string; userId: string; fullName?: string; role?: Role; unitId?: string | null; active?: boolean }
  | { action: 'reset-password'; requestId: string; userId: string; tempPassword: string };

type ParseResult = { ok: true; value: Parsed } | { ok: false; code: ErrorCode; message: string };

const bad = (message: string): ParseResult => ({ ok: false, code: 'BAD_REQUEST', message });
const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as readonly string[]).includes(v);
const cleanName = (v: string) => v.replace(/\s+/g, ' ').trim();

export function parseAdminRequest(raw: unknown): ParseResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('Permintaan tidak valid.');
  const b = raw as Record<string, unknown>;
  const requestId = typeof b.requestId === 'string' && UUID_RE.test(b.requestId) ? b.requestId.toLowerCase() : null;
  if (!requestId) return bad('ID permintaan tidak valid. Muat ulang halaman lalu ulangi.');

  if (b.action === 'create') {
    const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
    if (!email || email.length > 254 || !EMAIL_RE.test(email)) return bad('Format email tidak valid. Contoh: nama@uinsa.ac.id');
    const fullName = typeof b.fullName === 'string' ? cleanName(b.fullName) : '';
    if (!fullName || fullName.length > 120) return bad('Nama lengkap wajib diisi (maksimal 120 karakter).');
    if (!isRole(b.role)) return bad('Peran tidak dikenal.');
    if (b.unitId !== undefined && b.unitId !== null && (typeof b.unitId !== 'string' || !UUID_RE.test(b.unitId))) return bad('Unit tidak valid.');
    const reason = checkTempPassword(b.tempPassword, email);
    if (reason) return { ok: false, code: 'WEAK_PASSWORD', message: reason };
    return {
      ok: true,
      value: { action: 'create', requestId, email, fullName, role: b.role, unitId: (b.unitId as string | null | undefined) ?? null, tempPassword: b.tempPassword as string },
    };
  }

  if (b.action === 'update' || b.action === 'reset-password') {
    const userId = typeof b.userId === 'string' && UUID_RE.test(b.userId) ? b.userId.toLowerCase() : null;
    if (!userId) return bad('Pengguna tidak valid.');
    if (b.action === 'reset-password') {
      // Kebijakan penuh (butuh email pengguna) diperiksa setelah gerbang; di sini hanya bentuknya.
      if (typeof b.tempPassword !== 'string' || b.tempPassword.length === 0) return { ok: false, code: 'WEAK_PASSWORD', message: 'Kata sandi sementara wajib diisi.' };
      return { ok: true, value: { action: 'reset-password', requestId, userId, tempPassword: b.tempPassword } };
    }
    const out: Extract<Parsed, { action: 'update' }> = { action: 'update', requestId, userId };
    if (b.fullName !== undefined) {
      const n = typeof b.fullName === 'string' ? cleanName(b.fullName) : '';
      if (!n || n.length > 120) return bad('Nama lengkap wajib diisi (maksimal 120 karakter).');
      out.fullName = n;
    }
    if (b.role !== undefined) {
      if (!isRole(b.role)) return bad('Peran tidak dikenal.');
      out.role = b.role;
    }
    if (b.unitId !== undefined) {
      if (b.unitId !== null && (typeof b.unitId !== 'string' || !UUID_RE.test(b.unitId))) return bad('Unit tidak valid.');
      out.unitId = b.unitId;
    }
    if (b.active !== undefined) {
      if (typeof b.active !== 'boolean') return bad('Status aktif tidak valid.');
      out.active = b.active;
    }
    if (out.fullName === undefined && out.role === undefined && out.unitId === undefined && out.active === undefined) return bad('Tidak ada perubahan yang dikirim.');
    return { ok: true, value: out };
  }
  return bad('Aksi tidak dikenal.');
}

// ---------------------------------------------------------------------------
// Pemetaan error
// ---------------------------------------------------------------------------
const CODE_TO_ERROR: Record<string, ErrorCode> = {
  AUTH_REQUIRED: 'UNAUTHENTICATED',
  ACCOUNT_INACTIVE: 'FORBIDDEN',
  FORBIDDEN_ROLE: 'FORBIDDEN',
  FORBIDDEN_UNIT: 'FORBIDDEN',
  FORBIDDEN_TARGET: 'FORBIDDEN',
  FORBIDDEN_TARGET_ROLE: 'FORBIDDEN',
  FORBIDDEN_SELF: 'FORBIDDEN',
  LAST_ADMIN_PUSAT: 'CONFLICT',
  NOT_FOUND: 'NOT_FOUND',
  UNIT_NOT_FOUND: 'BAD_REQUEST',
  UNIT_REQUIRED: 'BAD_REQUEST',
  INVALID_INPUT: 'BAD_REQUEST',
  IDEMPOTENCY_CONFLICT: 'CONFLICT',
  AUTH_USER_MISSING: 'UPSTREAM',
};

/** Error RPC -> jawaban. Hanya pesan bisnis Indonesia dari Postgres yang diteruskan; teks teknis tidak pernah. */
function rpcError(out: RpcOutcome<unknown>): Response {
  if (out.status === 401) return jsonError('UNAUTHENTICATED');
  const e = out.error;
  if (!e?.business) return out.status === 403 ? jsonError('FORBIDDEN') : jsonError('UPSTREAM');
  const res = jsonError(CODE_TO_ERROR[e.code] ?? 'BAD_REQUEST', e.message || undefined);
  res.headers.set('X-Api-Code', e.code);
  return res;
}

interface AuthReply {
  status: number;
  /** error_code GoTrue (mis. email_exists) bila ada. Badan jawaban tidak disimpan. */
  errorCode: string | null;
  /** hanya `id` pengguna dari jawaban sukses. */
  userId: string | null;
}

function authFailure(r: AuthReply): Response {
  if (r.status === 401 || r.status === 403) return jsonError('NOT_CONFIGURED', 'Kunci layanan Supabase ditolak server. Hubungi Admin Pusat.');
  if (r.status === 404) return jsonError('NOT_FOUND', 'Pengguna tidak ditemukan.');
  if (r.errorCode === 'email_exists' || r.errorCode === 'user_already_exists') return jsonError('EMAIL_EXISTS');
  if (r.errorCode === 'weak_password' || r.errorCode === 'same_password') return jsonError('WEAK_PASSWORD', 'Kata sandi sementara ditolak oleh sistem login. Gunakan kata sandi yang lebih panjang dan acak.');
  if (r.status >= 400 && r.status < 500 && r.status !== 429) return jsonError('BAD_REQUEST');
  return jsonError('UPSTREAM');
}

// ---------------------------------------------------------------------------
// Akses layanan (kunci service-role hanya hidup di closure ini)
// ---------------------------------------------------------------------------
interface Service {
  authAdmin(method: 'POST' | 'PUT' | 'DELETE' | 'GET', path: string, body?: Record<string, unknown>): Promise<AuthReply & { email?: string | null }>;
  profile(args: Record<string, unknown>): Promise<RpcOutcome<ProfileResult>>;
}

interface ProfileResult {
  ok: boolean;
  user_id: string;
  created?: boolean;
  changed?: boolean;
  role?: string;
  unit_id?: string | null;
  active?: boolean;
  must_change_password?: boolean;
  replayed?: boolean;
}

function makeService(env: FileEnv, key: string, fetchFn: FetchFn): Service {
  const base = (env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  return {
    async authAdmin(method, path, body) {
      let res: Response;
      try {
        res = await fetchFn(`${base}/auth/v1/admin/users${path}`, {
          method,
          headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
        });
      } catch {
        return { status: 0, errorCode: null, userId: null };
      }
      const parsed: unknown = await res.json().catch(() => null);
      const o = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      const errorCode = typeof o.error_code === 'string' ? o.error_code : typeof o.code === 'string' ? o.code : null;
      return {
        status: res.status,
        errorCode: res.ok ? null : errorCode,
        userId: res.ok && typeof o.id === 'string' && UUID_RE.test(o.id) ? o.id : null,
        email: res.ok && typeof o.email === 'string' ? o.email : null,
      };
    },
    // PostgREST dengan kunci service-role sebagai apikey dan Bearer.
    profile: (args) => callRpc<ProfileResult>({ SUPABASE_URL: env.SUPABASE_URL, SUPABASE_ANON_KEY: key }, key, 'user_profile_upsert_service', args, fetchFn),
  };
}

function logFailure(event: string, detail: Record<string, string | number | null>): void {
  // Hanya penanda dan kode; tidak pernah kata sandi, kunci, email, atau badan jawaban.
  console.error('admin-users', event, JSON.stringify(detail));
}

function success(r: ProfileResult | null, extra: Record<string, unknown> = {}): Response {
  return json({
    ok: true,
    userId: r?.user_id ?? null,
    created: r?.created ?? false,
    changed: r?.changed ?? true,
    role: r?.role ?? null,
    unitId: r?.unit_id ?? null,
    active: r?.active ?? null,
    mustChangePassword: r?.must_change_password ?? null,
    replayed: r?.replayed ?? false,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// Penangan
// ---------------------------------------------------------------------------
export async function handleAdminUsers(request: Request, env: FileEnv, fetchFn: FetchFn): Promise<Response> {
  if (request.method !== 'POST') return jsonError('METHOD');
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return jsonError('NOT_CONFIGURED');
  const jwt = bearer(request);
  if (!jwt) return jsonError('UNAUTHENTICATED');

  const type = request.headers.get('Content-Type') ?? '';
  if (!/^application\/json\b/i.test(type)) return jsonError('BAD_REQUEST');
  const text = await request.text().catch(() => '');
  if (text.length > MAX_BODY_BYTES) return jsonError('TOO_LARGE');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return jsonError('BAD_REQUEST');
  }
  const parsed = parseAdminRequest(raw);
  if (!parsed.ok) return jsonError(parsed.code, parsed.message);
  const req = parsed.value;

  // ---- 2. GERBANG (sebagai pemanggil) ---------------------------------------
  const checks: { action: string; unit: string | null; role: string | null }[] = [];
  let target: string | null = null;
  if (req.action === 'create') {
    checks.push({ action: 'create', unit: req.unitId, role: req.role });
  } else {
    target = req.userId;
    if (req.action === 'reset-password') checks.push({ action: 'reset_password', unit: null, role: null });
    else {
      if (req.fullName !== undefined || req.role !== undefined || req.unitId !== undefined) {
        checks.push({ action: 'update', unit: req.unitId ?? null, role: req.role ?? null });
      }
      if (req.active === false) checks.push({ action: 'deactivate', unit: null, role: null });
      if (req.active === true) checks.push({ action: 'reactivate', unit: null, role: null });
    }
  }
  let actorId: string | null = null;
  for (const c of checks) {
    let out: RpcOutcome<{ ok?: boolean; actor_id?: string }>;
    try {
      out = await callRpc(env, jwt, 'user_admin_authorize', {
        p_action: c.action, p_target_user_id: target, p_target_unit_id: c.unit, p_target_role: c.role,
      }, fetchFn);
    } catch {
      return jsonError('UPSTREAM');
    }
    if (out.error || out.data?.ok !== true || typeof out.data.actor_id !== 'string' || !UUID_RE.test(out.data.actor_id)) {
      // gagal tertutup: apa pun selain {ok:true, actor_id} berarti ditolak
      return out.error ? rpcError(out) : jsonError('FORBIDDEN');
    }
    actorId = out.data.actor_id;
  }
  if (!actorId) return jsonError('FORBIDDEN');

  // ---- 3. baru sekarang kunci service-role -------------------------------------
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || key.length < 20) return jsonError('SERVICE_KEY_MISSING');
  const svc = makeService(env, key, fetchFn);

  if (req.action === 'create') return createUser(svc, req, actorId);
  if (req.action === 'update') return updateUser(svc, req, actorId);
  return resetPassword(svc, env, jwt, fetchFn, req, actorId);
}

async function createUser(svc: Service, req: Extract<Parsed, { action: 'create' }>, actorId: string): Promise<Response> {
  const created = await svc.authAdmin('POST', '', { email: req.email, password: req.tempPassword, email_confirm: true });
  if (!created.userId) return authFailure(created);
  const userId = created.userId;

  const out = await svc.profile({
    p_actor: actorId, p_user_id: userId, p_email: req.email, p_full_name: req.fullName, p_role: req.role,
    p_unit_id: req.unitId, p_active: null, p_must_change: true, p_request_id: req.requestId,
  });
  if (!out.error && out.data?.ok === true) return success(out.data);

  // KOMPENSASI: jangan tinggalkan akun login tanpa profil.
  const undone = await svc.authAdmin('DELETE', `/${userId}`);
  if (undone.status < 200 || undone.status >= 300) {
    logFailure('create-compensation-failed', { userId, status: undone.status });
    return jsonError('PARTIAL_FAILURE', 'Profil gagal disimpan dan akun login yang baru dibuat belum bisa dihapus otomatis. Hubungi Admin Pusat agar akun login dengan email ini dihapus sebelum mengulang.');
  }
  return out.error ? rpcError(out) : jsonError('UPSTREAM');
}

async function updateUser(svc: Service, req: Extract<Parsed, { action: 'update' }>, actorId: string): Promise<Response> {
  const banChange = req.active === undefined ? null : { ban_duration: req.active ? 'none' : BAN_FOREVER };
  const revert = req.active === undefined ? null : { ban_duration: req.active ? BAN_FOREVER : 'none' };
  if (banChange) {
    const r = await svc.authAdmin('PUT', `/${req.userId}`, banChange);
    if (r.status < 200 || r.status >= 300) return authFailure(r);
  }
  const out = await svc.profile({
    p_actor: actorId, p_user_id: req.userId, p_email: null, p_full_name: req.fullName ?? null, p_role: req.role ?? null,
    p_unit_id: req.unitId ?? null, p_active: req.active ?? null, p_must_change: null, p_request_id: req.requestId,
  });
  if (!out.error && out.data?.ok === true) return success(out.data);
  if (revert) {
    const undone = await svc.authAdmin('PUT', `/${req.userId}`, revert);
    if (undone.status < 200 || undone.status >= 300) {
      logFailure('update-compensation-failed', { userId: req.userId, status: undone.status });
      return jsonError('PARTIAL_FAILURE', 'Status login pengguna sempat diubah tetapi perubahan profil gagal dan belum bisa dipulihkan otomatis. Periksa status akun di daftar, lalu ulangi.');
    }
  }
  return out.error ? rpcError(out) : jsonError('UPSTREAM');
}

async function resetPassword(svc: Service, env: FileEnv, jwt: string, fetchFn: FetchFn, req: Extract<Parsed, { action: 'reset-password' }>, actorId: string): Promise<Response> {
  // Email pengguna dibutuhkan kebijakan kata sandi: baca sebagai pemanggil (RLS), cadangan: Auth Admin.
  const fromList = await callRpc<{ user_id: string; email: string | null }[]>(env, jwt, 'user_list', {}, fetchFn).then(
    (list) => list.data?.find((u) => u.user_id === req.userId)?.email ?? null,
    () => null,
  );
  const email = fromList ?? (await svc.authAdmin('GET', `/${req.userId}`)).email ?? null;
  const reason = checkTempPassword(req.tempPassword, email);
  if (reason) return jsonError('WEAK_PASSWORD', reason);

  const set = await svc.authAdmin('PUT', `/${req.userId}`, { password: req.tempPassword });
  if (set.status < 200 || set.status >= 300) return authFailure(set);
  const out = await svc.profile({
    p_actor: actorId, p_user_id: req.userId, p_email: null, p_full_name: null, p_role: null, p_unit_id: null,
    p_active: null, p_must_change: true, p_request_id: req.requestId,
  });
  if (!out.error && out.data?.ok === true) return success(out.data);
  // Kata sandi sudah terganti dan tidak bisa dikembalikan; sampaikan terus terang.
  logFailure('reset-profile-failed', { userId: req.userId, status: out.status });
  return jsonError('PARTIAL_FAILURE', 'Kata sandi pengguna sudah diganti, tetapi penanda wajib-ganti belum tersimpan. Ulangi "Atur ulang kata sandi" dengan kata sandi sementara baru.');
}
