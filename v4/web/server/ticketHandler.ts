import type { FetchFn, FileEnv } from './env';
import { json, jsonError } from './http';
import { randomToken } from './crypto';
import { MIN_SECRET_LENGTH, signTicket, type Disposition } from './ticket';

/**
 * POST /api/files/ticket  {driveFileId, disposition}
 * Authorization: Bearer <JWT Supabase pengguna>
 *
 * Otorisasi dilakukan oleh Postgres (RLS + get_file_access) memakai JWT
 * pengguna dan anon key — tanpa service-role key. Akses dicatat di audit
 * (log_file_access) SEBELUM tiket diberikan; gagal mencatat = tidak ada tiket.
 */

const FILE_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

interface FileAccess {
  file_name: string;
  mime: string;
  size: number | null;
  object_type: string;
  object_id: string;
  unit_id: string;
}

async function rpc(env: Required<Pick<FileEnv, 'SUPABASE_URL' | 'SUPABASE_ANON_KEY'>>, jwt: string, fn: string, args: Record<string, unknown>, fetchFn: FetchFn): Promise<Response> {
  return fetchFn(`${env.SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(args),
  });
}

export async function handleTicket(request: Request, env: FileEnv, fetchFn: FetchFn, nowSec = Math.floor(Date.now() / 1000)): Promise<Response> {
  if (request.method !== 'POST') return jsonError('METHOD');
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.FILE_TICKET_SECRET || env.FILE_TICKET_SECRET.length < MIN_SECRET_LENGTH) {
    return jsonError('NOT_CONFIGURED');
  }
  const auth = request.headers.get('Authorization') ?? '';
  const jwt = /^Bearer\s+([A-Za-z0-9._-]{20,4096})$/.exec(auth)?.[1];
  if (!jwt) return jsonError('UNAUTHENTICATED');

  let body: { driveFileId?: unknown; disposition?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonError('BAD_REQUEST');
  }
  const fid = typeof body?.driveFileId === 'string' ? body.driveFileId.trim() : '';
  const disp = body?.disposition;
  if (!FILE_ID_RE.test(fid) || (disp !== 'inline' && disp !== 'attachment')) return jsonError('BAD_REQUEST');
  const disposition: Disposition = disp;
  const supa = { SUPABASE_URL: env.SUPABASE_URL, SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY };

  let access: FileAccess | null;
  try {
    const res = await rpc(supa, jwt, 'get_file_access', { p_drive_file_id: fid }, fetchFn);
    if (res.status === 401 || res.status === 403) return jsonError('UNAUTHENTICATED');
    if (!res.ok) return jsonError('UPSTREAM');
    access = (await res.json()) as FileAccess | null;
  } catch {
    return jsonError('UPSTREAM');
  }
  if (!access || typeof access !== 'object' || !access.file_name) return jsonError('NOT_FOUND');

  const requestId = randomToken(12);
  let sub: string;
  try {
    const res = await rpc(supa, jwt, 'log_file_access', { p_drive_file_id: fid, p_disposition: disposition, p_request_id: requestId }, fetchFn);
    if (res.status === 401) return jsonError('UNAUTHENTICATED');
    // 403/42501 di sini = akses dicabut di antara dua panggilan: perlakukan sebagai tidak ada.
    if (res.status === 403) return jsonError('NOT_FOUND');
    if (!res.ok) return jsonError('UPSTREAM');
    const logged = (await res.json()) as { user_id?: unknown } | null;
    if (!logged || typeof logged.user_id !== 'string') return jsonError('UPSTREAM');
    sub = logged.user_id;
  } catch {
    return jsonError('UPSTREAM');
  }

  const { token, exp } = await signTicket(
    { fid, name: access.file_name, mime: access.mime || 'application/octet-stream', disp: disposition, sub },
    env.FILE_TICKET_SECRET,
    nowSec,
  );
  return json({
    ok: true,
    url: `/api/files/download?t=${encodeURIComponent(token)}`,
    expiresAt: exp,
    fileName: access.file_name,
    mime: access.mime,
    size: access.size,
  });
}
