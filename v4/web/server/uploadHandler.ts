import { hmacSha256, toHex } from './crypto';
import { driveApiBase, type FetchFn, type FileEnv } from './env';
import { DriveError, ensurePath, getFileMeta, isAppFolder, readHead, ROOT_FOLDER_NAME, trashFile, driveFetch, type DriveCtx } from './drive';
import { GatewayError } from './gateway';
import { json, jsonError, type ErrorCode } from './http';
import { signPayload, verifyPayload } from './signed';
import { bearer, callRpc, type RpcOutcome } from './supabaseRpc';
import { MIN_SECRET_LENGTH } from './ticket';

/**
 * Jembatan unggah (resumable, langsung browser → Google).
 *
 *   POST /api/files/upload-session   upload_begin (sebagai pengguna) → folder → sesi resumable Drive
 *   POST /api/files/upload-complete  verifikasi file di Drive → atestasi HMAC → upload_commit
 *   POST /api/files/upload-cancel    upload_cancel + hapus sesi resumable
 *   PUT  /api/files/upload-chunk     CADANGAN bila Google menolak PUT langsung dari
 *                                    browser (CORS): potongan dialirkan ke URL sesi
 *                                    yang terikat di konteks bertanda tangan.
 *
 * Token Google tidak pernah dikirim ke browser. Browser hanya menerima URL
 * sesi resumable (kapabilitas untuk SATU unggahan itu saja).
 */

export const CHUNK_SIZE = 8 * 1024 * 1024; // kelipatan 256 KiB
const CONTEXT_PURPOSE = 'cf-upload-context-v1';
const CONTEXT_TTL_SECONDS = 7 * 24 * 3600; // umur sesi resumable Google ±1 minggu
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;
const DRIVE_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

export interface UploadBegin {
  session_id: string;
  unit_id: string;
  unit_code: string;
  folder_path: string[];
  drive_name: string;
  known_folder_id: string | null;
  root_folder_id?: string | null;
  max_bytes: number;
}

interface UploadContext {
  v: 1;
  sid: string;
  folder: string;
  size: number;
  mime: string;
  /** URL sesi resumable (bertanda tangan) untuk jalur cadangan upload-chunk. */
  url?: string;
  exp: number;
}

const CODE_TO_ERROR: Record<string, ErrorCode> = {
  AUTH_REQUIRED: 'UNAUTHENTICATED',
  ACCOUNT_INACTIVE: 'FORBIDDEN',
  FORBIDDEN_ROLE: 'FORBIDDEN',
  FORBIDDEN_UNIT: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  FILE_TOO_LARGE: 'TOO_LARGE',
  FILE_TYPE: 'INVALID_FILE',
  UPLOAD_SESSION_ACTIVE: 'CONFLICT',
  UPLOAD_SESSION_STATE: 'CONFLICT',
  UPLOAD_SESSION_EXPIRED: 'CONFLICT',
  UPLOAD_FILE_IN_USE: 'CONFLICT',
  IDEMPOTENCY_CONFLICT: 'CONFLICT',
  ITEM_HAS_FILE: 'CONFLICT',
  EVIDENCE_EXISTS: 'CONFLICT',
  OBJECT_BORROWED: 'CONFLICT',
  LAST_ITEM_IN_BERKAS: 'CONFLICT',
  ALREADY_CANCELLED: 'CONFLICT',
  RECEIPT_CANCELLED: 'CONFLICT',
};

/** Error RPC → jawaban JSON dengan kode API_S2 dan pesan Indonesia dari server. */
function rpcError(out: RpcOutcome<unknown>): Response {
  if (out.status === 401) return jsonError('UNAUTHENTICATED');
  const e = out.error;
  if (!e?.business) {
    // Bukan error bisnis: pesan umum saja (teks Postgres/PostgREST tidak pernah diteruskan).
    if (out.status === 403) return jsonError('FORBIDDEN');
    return jsonError('UPSTREAM');
  }
  const mapped = CODE_TO_ERROR[e.code] ?? 'BAD_REQUEST';
  const res = jsonError(mapped, e.message || undefined);
  res.headers.set('X-Api-Code', e.code);
  return res;
}

function configured(env: FileEnv): Response | null {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.UPLOAD_ATTEST_SECRET || env.UPLOAD_ATTEST_SECRET.length < MIN_SECRET_LENGTH) {
    return jsonError('NOT_CONFIGURED');
  }
  if (!env.DRIVE_GATEWAY_URL || !env.DRIVE_GATEWAY_SECRET) return jsonError('GATEWAY_NOT_CONFIGURED');
  return null;
}

function driveError(error: unknown): Response {
  if (error instanceof GatewayError || error instanceof DriveError) return jsonError('UPSTREAM');
  throw error;
}

/** URL sesi resumable yang sah: hanya host upload Google (atau basis uji lokal). */
export function validSessionUrl(url: string | null, env: FileEnv): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const local = driveApiBase(env);
    const okGoogle = u.protocol === 'https:' && u.hostname === 'www.googleapis.com';
    const okLocal = local !== 'https://www.googleapis.com' && u.origin === local;
    if ((okGoogle || okLocal) && u.pathname.startsWith('/upload/drive/v3/files') && u.searchParams.get('upload_id')) return u.toString();
  } catch {
    // tidak sah
  }
  return null;
}

/** Tanda tangan byte awal untuk tipe yang dikenal. */
export function magicMatches(mime: string, head: Uint8Array): boolean {
  const ascii = new TextDecoder('latin1').decode(head);
  if (mime === 'application/pdf') return ascii.includes('%PDF-');
  if (mime === 'image/jpeg') return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (mime === 'image/png') return head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  return true;
}

/** API_S2 §4: attested_at = detik Unix, size = jumlah byte desimal. */
export function attestationCanonical(sessionId: string, driveFileId: string, size: number, md5: string, mime: string, attestedAt: number): string {
  return `CFUP1\n${sessionId}\n${driveFileId}\n${size}\n${md5}\n${mime}\n${attestedAt}`;
}

export type FolderKind = 'TARGET' | 'ROOT';

export function folderAttestationCanonical(sessionId: string, folderId: string, attestedAt: number, kind: FolderKind = 'TARGET'): string {
  return `CFFD1\n${sessionId}\n${folderId}\n${attestedAt}${kind === 'ROOT' ? '\nROOT' : ''}`;
}

export function taskAttestationCanonical(taskId: string, ok: boolean, attestedAt: number): string {
  return `CFDT1\n${taskId}\n${ok ? 'ok' : 'fail'}\n${attestedAt}`;
}

export async function attest(secret: string, canonical: string): Promise<string> {
  return toHex(await hmacSha256(secret, canonical));
}

// ---------------------------------------------------------------------------
export async function handleUploadSession(request: Request, env: FileEnv, fetchFn: FetchFn, nowSec = Math.floor(Date.now() / 1000)): Promise<Response> {
  if (request.method !== 'POST') return jsonError('METHOD');
  const notReady = configured(env);
  if (notReady) return notReady;
  const jwt = bearer(request);
  if (!jwt) return jsonError('UNAUTHENTICATED');

  let b: Record<string, unknown>;
  try {
    b = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError('BAD_REQUEST');
  }
  const requestId = typeof b.requestId === 'string' ? b.requestId : '';
  const purpose = typeof b.purpose === 'string' ? b.purpose : '';
  const objectId = typeof b.objectId === 'string' ? b.objectId : null;
  const fileName = typeof b.fileName === 'string' ? b.fileName.slice(0, 255) : '';
  const mime = typeof b.mime === 'string' ? b.mime.toLowerCase() : '';
  const size = typeof b.size === 'number' ? b.size : NaN;
  const unitId = typeof b.unitId === 'string' && UUID_RE.test(b.unitId) ? b.unitId : null;
  if (!UUID_RE.test(requestId) || !/^[A-Z][A-Z0-9_]{0,39}$/.test(purpose) || (objectId !== null && objectId.length > 200) || !fileName
      || !MIME_RE.test(mime) || !Number.isSafeInteger(size) || size <= 0) {
    return jsonError('BAD_REQUEST');
  }

  let begin: UploadBegin;
  try {
    const out = await callRpc<UploadBegin>(env, jwt, 'upload_begin', {
      p_request_id: requestId, p_purpose: purpose, p_object_id: objectId, p_file_name: fileName, p_mime: mime, p_size: size, p_unit_id: unitId,
    }, fetchFn);
    if (out.error || !out.data) return rpcError(out);
    begin = out.data;
  } catch {
    return jsonError('UPSTREAM');
  }
  if (!begin.session_id || !begin.unit_code || !Array.isArray(begin.folder_path) || !begin.drive_name) return jsonError('UPSTREAM');
  if (begin.max_bytes && size > begin.max_bytes) {
    await callRpc(env, jwt, 'upload_cancel', { p_session_id: begin.session_id }, fetchFn).catch(() => null);
    return jsonError('TOO_LARGE', `Ukuran file melebihi batas ${Math.floor(begin.max_bytes / (1024 * 1024))} MB.`);
  }

  const ctx: DriveCtx = { env, fetchFn, now: () => nowSec };
  const appOrigin = new URL(request.url).origin;
  let folderId: string;
  let uploadUrl: string | null;
  const toRegister: { id: string; kind: FolderKind }[] = [];
  try {
    // Hanya folder buatan aplikasi ini yang bisa ditulis dengan izin drive.file.
    // ID dari DB (v4) tetap dicek kepemilikannya sebelum dipakai.
    const appOwned = async (id: string | null | undefined): Promise<string | null> =>
      id && DRIVE_ID_RE.test(id) && (await isAppFolder(ctx, id)) ? id : null;
    const known = await appOwned(begin.known_folder_id);
    if (known) {
      folderId = known;
    } else {
      let root = await appOwned(begin.root_folder_id);
      if (!root) {
        root = await ensurePath(ctx, [ROOT_FOLDER_NAME, begin.unit_code]);
        if (root !== begin.root_folder_id) toRegister.push({ id: root, kind: 'ROOT' });
      }
      folderId = await ensurePath(ctx, begin.folder_path, root);
      toRegister.push({ id: folderId, kind: 'TARGET' });
    }
    const res = await driveFetch(ctx, (base) => [
      `${base}/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': mime,
          'X-Upload-Content-Length': String(size),
          // Sesi resumable hanya menerima PUT CORS dari origin ini.
          Origin: appOrigin,
        },
        body: JSON.stringify({ name: begin.drive_name, parents: [folderId], mimeType: mime, appProperties: { cfV4: '1', cfSession: begin.session_id } }),
      },
    ]);
    await res.body?.cancel();
    if (!res.ok) throw new DriveError('resumable', res.status);
    uploadUrl = validSessionUrl(res.headers.get('Location'), env);
  } catch (error) {
    return driveError(error);
  }
  if (!uploadUrl) return jsonError('UPSTREAM');

  // Catat folder (bertanda tangan) agar unggahan berikutnya tanpa pencarian Drive.
  for (const f of toRegister) {
    const at = nowSec;
    const attestation = await attest(env.UPLOAD_ATTEST_SECRET!, folderAttestationCanonical(begin.session_id, f.id, at, f.kind));
    await callRpc(env, jwt, 'upload_register_folder', {
      p_session_id: begin.session_id, p_folder_id: f.id, p_kind: f.kind, p_attested_at: at, p_attestation: attestation,
    }, fetchFn).catch(() => null);
  }

  const context = await signPayload(CONTEXT_PURPOSE, { v: 1, sid: begin.session_id, folder: folderId, size, mime, url: uploadUrl, exp: nowSec + CONTEXT_TTL_SECONDS } satisfies UploadContext, env.UPLOAD_ATTEST_SECRET!);
  return json({ ok: true, sessionId: begin.session_id, uploadUrl, chunkSize: CHUNK_SIZE, context, maxBytes: begin.max_bytes ?? null });
}

// ---------------------------------------------------------------------------
export async function handleUploadComplete(request: Request, env: FileEnv, fetchFn: FetchFn, nowSec = Math.floor(Date.now() / 1000)): Promise<Response> {
  if (request.method !== 'POST') return jsonError('METHOD');
  const notReady = configured(env);
  if (notReady) return notReady;
  const jwt = bearer(request);
  if (!jwt) return jsonError('UNAUTHENTICATED');
  let b: Record<string, unknown>;
  try {
    b = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError('BAD_REQUEST');
  }
  const sessionId = typeof b.sessionId === 'string' ? b.sessionId : '';
  const driveFileId = typeof b.driveFileId === 'string' ? b.driveFileId : '';
  const c = await verifyPayload<UploadContext>(CONTEXT_PURPOSE, b.context, env.UPLOAD_ATTEST_SECRET!, nowSec);
  if (!c || c.sid !== sessionId || !DRIVE_ID_RE.test(driveFileId)) return jsonError('BAD_REQUEST');

  const ctx: DriveCtx = { env, fetchFn, now: () => nowSec };
  let meta;
  try {
    meta = await getFileMeta(ctx, driveFileId);
  } catch (error) {
    return driveError(error);
  }
  // File harus dibuat oleh sesi ini (appProperties hanya terlihat oleh aplikasi ini).
  if (!meta || meta.trashed || meta.appProperties?.cfSession !== sessionId) return jsonError('UPLOAD_MISMATCH');
  const size = Number(meta.size ?? NaN);
  const md5 = meta.md5Checksum ?? '';
  const mime = (meta.mimeType ?? '').toLowerCase();
  const okShape = (meta.parents ?? []).includes(c.folder) && size === c.size && mime === c.mime && /^[0-9a-f]{32}$/.test(md5);
  if (!okShape) {
    await trashFile(ctx, driveFileId).catch(() => null);
    return jsonError('UPLOAD_MISMATCH');
  }
  try {
    const head = await readHead(ctx, driveFileId);
    if (!magicMatches(mime, head)) {
      await trashFile(ctx, driveFileId).catch(() => null);
      await callRpc(env, jwt, 'upload_cancel', { p_session_id: sessionId }, fetchFn).catch(() => null);
      return jsonError('INVALID_FILE');
    }
  } catch (error) {
    return driveError(error);
  }

  const attestedAt = nowSec;
  const attestation = await attest(env.UPLOAD_ATTEST_SECRET!, attestationCanonical(sessionId, driveFileId, size, md5, mime, attestedAt));
  const driveUrl = meta.webViewLink && /^https:\/\/(drive|docs)\.google\.com\//.test(meta.webViewLink)
    ? meta.webViewLink
    : `https://drive.google.com/file/d/${driveFileId}/view`;
  let out: RpcOutcome<unknown>;
  try {
    out = await callRpc(env, jwt, 'upload_commit', {
      p_session_id: sessionId, p_drive_file_id: driveFileId, p_drive_url: driveUrl, p_size: size, p_md5: md5, p_mime: mime,
      p_attested_at: attestedAt, p_attestation: attestation,
    }, fetchFn);
  } catch {
    return jsonError('UPSTREAM');
  }
  if (out.error) return rpcError(out);
  return json({ ok: true, result: out.data });
}

// ---------------------------------------------------------------------------
export async function handleUploadCancel(request: Request, env: FileEnv, fetchFn: FetchFn): Promise<Response> {
  if (request.method !== 'POST') return jsonError('METHOD');
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return jsonError('NOT_CONFIGURED');
  const jwt = bearer(request);
  if (!jwt) return jsonError('UNAUTHENTICATED');
  let b: Record<string, unknown>;
  try {
    b = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonError('BAD_REQUEST');
  }
  const sessionId = typeof b.sessionId === 'string' ? b.sessionId : '';
  if (!sessionId || sessionId.length > 200) return jsonError('BAD_REQUEST');
  const out = await callRpc<{ drive_file_id?: string | null }>(env, jwt, 'upload_cancel', { p_session_id: sessionId }, fetchFn).catch(() => null);
  if (!out) return jsonError('UPSTREAM');
  if (out.error) return rpcError(out);
  // Bukti batal yang sudah terunggah tapi tidak dipakai: buang filenya (milik aplikasi).
  const orphan = out.data?.drive_file_id;
  if (orphan && DRIVE_ID_RE.test(orphan) && env.DRIVE_GATEWAY_URL && env.DRIVE_GATEWAY_SECRET) {
    await trashFile({ env, fetchFn, now: () => Math.floor(Date.now() / 1000) }, orphan).catch(() => null);
  }
  // Hentikan sesi resumable di Google (tanpa token; URL sesi adalah kapabilitasnya).
  const url = validSessionUrl(typeof b.uploadUrl === 'string' ? b.uploadUrl : null, env);
  if (url) {
    const local = driveApiBase(env);
    const target = local !== 'https://www.googleapis.com' ? url.replace('https://www.googleapis.com', local) : url;
    await fetchFn(target, { method: 'DELETE' }).then((r) => r.body?.cancel()).catch(() => null);
  }
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
const RANGE_RE = /^bytes (\d{1,15})-(\d{1,15})\/(\d{1,15})$/;
const QUERY_RE = /^bytes \*\/(\d{1,15})$/;

/**
 * PUT /api/files/upload-chunk?sid=<session>  (header X-Upload-Context, Content-Range, Content-Length)
 *
 * Jalur cadangan: potongan dialirkan (tanpa ditampung) ke URL sesi resumable
 * yang ada di konteks bertanda tangan — browser tidak bisa mengarahkan ke URL
 * lain. Ukuran dibatasi satu potongan (CHUNK_SIZE) dan harus cocok dengan
 * Content-Range serta ukuran sesi. Jawaban Google diteruskan sebagai JSON
 * { ok, upstreamStatus, range, id } (tanpa 308 yang membingungkan XHR).
 */
export async function handleUploadChunk(request: Request, env: FileEnv, fetchFn: FetchFn, nowSec = Math.floor(Date.now() / 1000)): Promise<Response> {
  if (request.method !== 'PUT') return jsonError('METHOD');
  if (!env.UPLOAD_ATTEST_SECRET || env.UPLOAD_ATTEST_SECRET.length < MIN_SECRET_LENGTH) return jsonError('NOT_CONFIGURED');
  if (!bearer(request)) return jsonError('UNAUTHENTICATED');
  const sid = new URL(request.url).searchParams.get('sid') ?? '';
  const c = await verifyPayload<UploadContext>(CONTEXT_PURPOSE, request.headers.get('X-Upload-Context'), env.UPLOAD_ATTEST_SECRET, nowSec);
  const sessionUrl = c?.url ? validSessionUrl(c.url, env) : null;
  if (!c || !sid || c.sid !== sid || !sessionUrl) return jsonError('BAD_REQUEST');

  const range = request.headers.get('Content-Range') ?? '';
  const lengthHeader = request.headers.get('Content-Length');
  const length = lengthHeader !== null && /^\d{1,15}$/.test(lengthHeader) ? Number(lengthHeader) : NaN;
  let upstreamHeaders: Record<string, string>;
  let body: ReadableStream<Uint8Array> | null = null;
  const r = RANGE_RE.exec(range);
  const q = QUERY_RE.exec(range);
  if (r) {
    const start = Number(r[1]);
    const end = Number(r[2]);
    const total = Number(r[3]);
    const len = end - start + 1;
    if (total !== c.size || end < start || end >= total) return jsonError('BAD_REQUEST');
    if (len > CHUNK_SIZE || (Number.isFinite(length) && length > CHUNK_SIZE)) return jsonError('TOO_LARGE');
    // Content-Length wajib & sama dengan rentang: badan tidak bisa melebihi batas.
    if (length !== len || !request.body) return jsonError('BAD_REQUEST');
    upstreamHeaders = { 'Content-Range': range, 'Content-Length': String(len) };
    body = request.body;
  } else if (q) {
    if (Number(q[1]) !== c.size || (Number.isFinite(length) && length !== 0)) return jsonError('BAD_REQUEST');
    upstreamHeaders = { 'Content-Range': range, 'Content-Length': '0' };
  } else {
    return jsonError('BAD_REQUEST');
  }

  const local = driveApiBase(env);
  const target = local !== 'https://www.googleapis.com' ? sessionUrl.replace('https://www.googleapis.com', local) : sessionUrl;
  let res: Response;
  try {
    res = await fetchFn(target, { method: 'PUT', headers: upstreamHeaders, body, ...(body ? { duplex: 'half' } : {}) } as RequestInit);
  } catch {
    return jsonError('UPSTREAM');
  }
  const upstreamStatus = res.status;
  let id: string | null = null;
  if (upstreamStatus === 200 || upstreamStatus === 201) {
    const data = (await res.json().catch(() => null)) as { id?: unknown } | null;
    id = typeof data?.id === 'string' && DRIVE_ID_RE.test(data.id) ? data.id : null;
  } else {
    await res.body?.cancel();
  }
  const upstreamRange = upstreamStatus === 308 ? res.headers.get('Range') : null;
  return json({ ok: true, upstreamStatus, range: upstreamRange && /^bytes=0-\d{1,15}$/.test(upstreamRange) ? upstreamRange : null, id });
}
