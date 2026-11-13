import { driveApiBase, type FetchFn, type FileEnv } from './env';
import { getDriveToken, invalidateDriveToken } from './gateway';

/**
 * Akses Drive API dengan token gerbang (drive.readonly + drive.file).
 * Token diperbarui sekali bila Drive menjawab 401.
 */
export interface DriveCtx {
  env: FileEnv;
  fetchFn: FetchFn;
  now: () => number;
}

export async function driveFetch(ctx: DriveCtx, build: (base: string) => [string, RequestInit]): Promise<Response> {
  const gw = { url: ctx.env.DRIVE_GATEWAY_URL ?? '', secret: ctx.env.DRIVE_GATEWAY_SECRET ?? '', fetchFn: ctx.fetchFn, now: ctx.now };
  const base = driveApiBase(ctx.env);
  let res: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getDriveToken({ ...gw, forceRefresh: attempt > 0 });
    const [url, init] = build(base);
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    res = await ctx.fetchFn(url, { ...init, headers });
    if (res.status !== 401) return res;
    await res.body?.cancel();
    invalidateDriveToken(gw.url, gw.secret);
  }
  return res!;
}

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const ROOT_FOLDER_NAME = 'CENTRAL FILE V4';
/** Penanda folder milik aplikasi ini (appProperties hanya terlihat oleh aplikasi pembuatnya). */
const APP_MARK = { cfV4: '1' };

function q(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function cleanSegment(name: string): string {
  // eslint-disable-next-line no-control-regex
  const s = String(name ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  return s || '_';
}

/** Cache isolate: (parent, nama) -> id folder. */
const folderCache = new Map<string, string>();
export function clearFolderCache(): void {
  folderCache.clear();
}

async function listFolders(ctx: DriveCtx, parent: string, name: string): Promise<{ id: string; createdTime: string }[]> {
  const query = `name = '${q(name)}' and '${q(parent)}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false and appProperties has { key='cfV4' and value='1' }`;
  const res = await driveFetch(ctx, (base) => [
    `${base}/drive/v3/files?${new URLSearchParams({
      q: query, fields: 'files(id,createdTime)', orderBy: 'createdTime', pageSize: '10', spaces: 'drive',
      supportsAllDrives: 'true', includeItemsFromAllDrives: 'true',
    })}`,
    { method: 'GET' },
  ]);
  if (!res.ok) throw new DriveError('list', res.status);
  const body = (await res.json()) as { files?: { id: string; createdTime: string }[] };
  return body.files ?? [];
}

export class DriveError extends Error {
  constructor(readonly op: string, readonly status: number) {
    super(`drive ${op}: ${status}`);
    this.name = 'DriveError';
  }
}

async function createFolder(ctx: DriveCtx, parent: string, name: string): Promise<string> {
  const res = await driveFetch(ctx, (base) => [
    `${base}/drive/v3/files?supportsAllDrives=true&fields=id`,
    { method: 'POST', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parent], appProperties: APP_MARK }) },
  ]);
  if (!res.ok) throw new DriveError('create-folder', res.status);
  return ((await res.json()) as { id: string }).id;
}

async function trash(ctx: DriveCtx, id: string): Promise<void> {
  const res = await driveFetch(ctx, (base) => [
    `${base}/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) },
  ]);
  await res.body?.cancel();
}

/**
 * Cari-atau-buat satu folder. Bila dua permintaan membuat folder yang sama
 * bersamaan, keduanya lalu memilih folder TERTUA dan yang lebih baru dibuang.
 */
export async function ensureFolder(ctx: DriveCtx, parent: string, rawName: string): Promise<string> {
  const name = cleanSegment(rawName);
  const key = `${parent}\n${name}`;
  const cached = folderCache.get(key);
  if (cached) return cached;
  const existing = await listFolders(ctx, parent, name);
  let id: string;
  if (existing.length) {
    id = existing[0]!.id;
  } else {
    const created = await createFolder(ctx, parent, name);
    const after = await listFolders(ctx, parent, name);
    id = after[0]?.id ?? created;
    if (id !== created) await trash(ctx, created);
  }
  folderCache.set(key, id);
  return id;
}

export async function ensurePath(ctx: DriveCtx, segments: string[]): Promise<string> {
  let parent = 'root';
  for (const seg of segments) parent = await ensureFolder(ctx, parent, seg);
  return parent;
}

export interface DriveFileMeta {
  id: string;
  name?: string;
  size?: string;
  md5Checksum?: string;
  mimeType?: string;
  parents?: string[];
  trashed?: boolean;
  appProperties?: Record<string, string>;
  webViewLink?: string;
}

export async function getFileMeta(ctx: DriveCtx, id: string): Promise<DriveFileMeta | null> {
  const res = await driveFetch(ctx, (base) => [
    `${base}/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=${encodeURIComponent('id,name,size,md5Checksum,mimeType,parents,trashed,appProperties,webViewLink')}`,
    { method: 'GET' },
  ]);
  if (res.status === 404) {
    await res.body?.cancel();
    return null;
  }
  if (!res.ok) throw new DriveError('get', res.status);
  return (await res.json()) as DriveFileMeta;
}

export async function readHead(ctx: DriveCtx, id: string, bytes = 1024): Promise<Uint8Array> {
  const res = await driveFetch(ctx, (base) => [
    `${base}/drive/v3/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`,
    { method: 'GET', headers: { Range: `bytes=0-${bytes - 1}` } },
  ]);
  if (!res.ok) throw new DriveError('read-head', res.status);
  const buf = new Uint8Array(await res.arrayBuffer());
  return buf.subarray(0, bytes);
}

export async function trashFile(ctx: DriveCtx, id: string): Promise<void> {
  await trash(ctx, id);
}

/** Folder buatan aplikasi ini? (appProperties hanya terlihat oleh aplikasi pembuatnya.) */
export async function isAppFolder(ctx: DriveCtx, id: string): Promise<boolean> {
  try {
    const res = await driveFetch(ctx, (base) => [
      `${base}/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=${encodeURIComponent('id,mimeType,trashed,appProperties')}`,
      { method: 'GET' },
    ]);
    if (!res.ok) {
      await res.body?.cancel();
      return false;
    }
    const m = (await res.json()) as DriveFileMeta;
    return m.mimeType === FOLDER_MIME && !m.trashed && m.appProperties?.cfV4 === '1';
  } catch {
    return false;
  }
}

/** Ganti nama file/folder (hanya berhasil untuk milik aplikasi; izin drive.file). */
export async function renameFile(ctx: DriveCtx, id: string, name: string): Promise<number> {
  const res = await driveFetch(ctx, (base) => [
    `${base}/drive/v3/files/${encodeURIComponent(id)}?supportsAllDrives=true&fields=id`,
    { method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=UTF-8' }, body: JSON.stringify({ name: cleanSegment(name) }) },
  ]);
  await res.body?.cancel();
  return res.status;
}
