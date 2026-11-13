import type { FetchFn, FileEnv } from './env';
import { renameFile, type DriveCtx } from './drive';
import { GatewayError } from './gateway';
import { json, jsonError } from './http';
import { bearer, callRpc } from './supabaseRpc';
import { MIN_SECRET_LENGTH } from './ticket';
import { attest, taskAttestationCanonical } from './uploadHandler';

/**
 * POST /api/files/drive-tasks — jalankan tugas ganti nama Drive setelah
 * penomoran ulang (API_S2 §4 "Drive tasks"). Dipanggil browser (tanpa
 * menunggu) setelah pemberkasan/unggah. Kegagalan tidak membatalkan data
 * (aturan 3.x); dicatat di drive_task_complete dan dicoba lagi kemudian.
 *
 * Catatan: dengan izin drive.file, file/folder lama dari 3.x tidak bisa
 * di-rename oleh gerbang (403) — tugas itu tercatat gagal.
 */
const MAX_PER_CALL = 25;
const ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

interface DriveTask {
  id: string;
  kind: 'RENAME_FOLDER' | 'RENAME_FILE';
  drive_id: string;
  new_name: string;
}

export async function handleDriveTasks(request: Request, env: FileEnv, fetchFn: FetchFn, nowSec = Math.floor(Date.now() / 1000)): Promise<Response> {
  if (request.method !== 'POST') return jsonError('METHOD');
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.UPLOAD_ATTEST_SECRET || env.UPLOAD_ATTEST_SECRET.length < MIN_SECRET_LENGTH) return jsonError('NOT_CONFIGURED');
  if (!env.DRIVE_GATEWAY_URL || !env.DRIVE_GATEWAY_SECRET) return jsonError('GATEWAY_NOT_CONFIGURED');
  const jwt = bearer(request);
  if (!jwt) return jsonError('UNAUTHENTICATED');
  const body = (await request.json().catch(() => ({}))) as { unitId?: unknown };
  const unitId = typeof body.unitId === 'string' && /^[0-9a-f-]{36}$/i.test(body.unitId) ? body.unitId : null;

  const list = await callRpc<{ tasks?: DriveTask[] }>(env, jwt, 'drive_task_list', { p_unit_id: unitId }, fetchFn).catch(() => null);
  if (!list) return jsonError('UPSTREAM');
  if (list.error) return list.status === 401 ? jsonError('UNAUTHENTICATED') : jsonError('FORBIDDEN', list.error.message || undefined);
  const tasks = (list.data?.tasks ?? []).slice(0, MAX_PER_CALL);
  const ctx: DriveCtx = { env, fetchFn, now: () => nowSec };
  let done = 0;
  let failed = 0;
  for (const t of tasks) {
    let ok = false;
    let error: string | null = null;
    if (!ID_RE.test(t.drive_id) || !t.new_name) {
      error = 'INVALID_TASK';
    } else {
      try {
        const status = await renameFile(ctx, t.drive_id, t.new_name);
        ok = status === 200;
        if (!ok) error = status === 403 ? 'NOT_APP_FILE' : status === 404 ? 'NOT_FOUND' : `HTTP_${status}`;
      } catch (e) {
        if (!(e instanceof GatewayError)) throw e;
        error = 'GATEWAY';
      }
    }
    const at = nowSec;
    const attestation = await attest(env.UPLOAD_ATTEST_SECRET, taskAttestationCanonical(t.id, ok, at));
    await callRpc(env, jwt, 'drive_task_complete', { p_task_id: t.id, p_ok: ok, p_error: error, p_attested_at: at, p_attestation: attestation }, fetchFn).catch(() => null);
    if (ok) done++;
    else failed++;
  }
  return json({ ok: true, done, failed, remaining: Math.max((list.data?.tasks ?? []).length - tasks.length, 0) });
}
