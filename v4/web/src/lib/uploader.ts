/*
 * Pengunggah resumable: browser → Google Drive langsung (URL sesi dari
 * /api/files/upload-session), lalu /api/files/upload-complete mengesahkan
 * file dan mencatat metadata (upload_commit). Metadata hanya dicatat setelah
 * file utuh (aturan 3.x).
 *
 *  - potongan 8 MiB (kelipatan 256 KiB), progres per byte (XHR);
 *  - jeda/lanjut, otomatis jeda saat offline dan lanjut saat online;
 *  - setelah gangguan jaringan, posisi ditanyakan ke Google (bytes * / total);
 *  - ulang dengan backoff; batal menghentikan sesi di server dan Google;
 *  - requestId sama dipakai ulang bila sesi diminta ulang (tanpa duplikat).
 */
import { newRequestId } from './api';
import type { UserMessage } from './errors';
import { fileError, FileAccessError, type GetAccessToken } from './files';

export type UploadStage = 'menyiapkan' | 'mengunggah' | 'jeda' | 'menyambung' | 'memverifikasi' | 'selesai' | 'gagal' | 'dibatalkan';

export interface UploadProgress {
  stage: UploadStage;
  sent: number;
  total: number;
  message?: UserMessage;
}

export interface UploadRequest {
  purpose: string;
  objectId: string | null;
  file: Blob;
  fileName: string;
  mime?: string;
  unitId?: string | null;
  requestId?: string;
}

export interface UploadResult {
  sessionId: string;
  driveFileId: string;
  result: unknown;
}

export interface TransportResponse {
  status: number;
  header(name: string): string | null;
  text: string;
}

export type Transport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: Blob | null; onProgress?: (loaded: number) => void; signal: AbortSignal },
) => Promise<TransportResponse>;

export interface UploadDeps {
  getToken: GetAccessToken;
  onProgress?: (p: UploadProgress) => void;
  fetchFn?: typeof fetch;
  transport?: Transport;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

export interface UploadHandle {
  promise: Promise<UploadResult>;
  pause(): void;
  resume(): void;
  abort(): void;
}

const UPLOAD_MESSAGES: Record<string, UserMessage> = {
  SESSION_EXPIRED: { title: 'Sesi unggah kedaluwarsa.', action: 'Pilih file lagi untuk mengulang unggahan.' },
  UPLOAD_REJECTED: { title: 'Google Drive menolak unggahan.', action: 'Coba lagi beberapa saat lagi. Bila berlanjut, hubungi Admin Pusat.' },
  TOO_LARGE: { title: 'Ukuran file melebihi batas.', action: 'Kompres PDF atau pisahkan menjadi beberapa file.' },
  INVALID_FILE: { title: 'File bukan PDF yang sah.', action: 'Pilih file PDF lain.' },
  UPLOAD_MISMATCH: { title: 'File yang terunggah tidak sesuai.', action: 'Ulangi unggahan.' },
  NETWORK_LOST: { title: 'Koneksi terputus terlalu lama.', action: 'Periksa internet, lalu tekan Lanjutkan.' },
  CANCELLED: { title: 'Unggahan dibatalkan.', action: 'Pilih file lagi bila ingin mengunggah.' },
};

function uploadError(code: string, message?: string): FileAccessError {
  const base = UPLOAD_MESSAGES[code];
  if (base) return new FileAccessError(code, message ? { title: message, action: base.action } : base);
  const e = fileError(code);
  return message ? new FileAccessError(code, { title: message, action: e.userMessage.action }) : e;
}

/** Tipe file; beberapa pemilih file di HP mengirim octet-stream untuk PDF. */
export function guessMime(file: Blob, name: string): string {
  if (file.type && file.type !== 'application/octet-stream') return file.type.toLowerCase();
  const ext = name.toLowerCase().split('.').pop();
  return ext === 'pdf' ? 'application/pdf' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'png' ? 'image/png' : 'application/octet-stream';
}

/** Header Range "bytes=0-1234" → byte berikutnya (1235); tanpa header → 0. */
export function nextOffsetFromRange(range: string | null): number {
  const m = range ? /bytes=0-(\d+)/.exec(range) : null;
  return m ? Number(m[1]) + 1 : 0;
}

export const xhrTransport: Transport = (url, init) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(init.method, url);
    for (const [k, v] of Object.entries(init.headers)) xhr.setRequestHeader(k, v);
    if (init.onProgress) xhr.upload.onprogress = (e) => init.onProgress!(e.loaded);
    xhr.onload = () => resolve({ status: xhr.status, header: (n) => xhr.getResponseHeader(n), text: xhr.responseText });
    xhr.onerror = () => reject(new TypeError('network'));
    xhr.ontimeout = () => reject(new TypeError('timeout'));
    xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'));
    init.signal.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(init.body ?? null);
  });

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function startUpload(req: UploadRequest, deps: UploadDeps): UploadHandle {
  const fetchFn = deps.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const transport = deps.transport ?? xhrTransport;
  const sleep = deps.sleep ?? defaultSleep;
  const maxRetries = deps.maxRetries ?? 8;
  const total = req.file.size;
  const mime = req.mime ?? guessMime(req.file, req.fileName);
  const requestId = req.requestId ?? newRequestId();

  let paused = false;
  let aborted = false;
  let wake: (() => void) | null = null;
  let current: AbortController | null = null;
  let session: { sessionId: string; uploadUrl: string; chunkSize: number; context: string } | null = null;
  let sent = 0;

  const emit = (stage: UploadStage, message?: UserMessage) => deps.onProgress?.({ stage, sent, total, ...(message ? { message } : {}) });

  const onOffline = () => {
    paused = true;
    current?.abort();
    emit('jeda', { title: 'Koneksi terputus.', action: 'Unggahan akan dilanjutkan otomatis saat tersambung.' });
  };
  const onOnline = () => handle.resume();
  window.addEventListener('offline', onOffline);
  window.addEventListener('online', onOnline);

  async function waitIfPaused() {
    while (paused && !aborted) await new Promise<void>((r) => (wake = r));
    if (aborted) throw uploadError('CANCELLED');
  }

  async function api(path: string, body: unknown): Promise<Record<string, unknown>> {
    const token = await deps.getToken();
    if (!token) throw fileError('UNAUTHENTICATED');
    let res: Response;
    try {
      res = await fetchFn(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch {
      throw fileError('NETWORK');
    }
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !data || data.ok !== true) {
      const code = typeof data?.code === 'string' ? data.code : res.status === 401 ? 'UNAUTHENTICATED' : res.status >= 500 ? 'UPSTREAM' : 'UNKNOWN';
      const message = typeof data?.message === 'string' ? data.message : undefined;
      throw uploadError(code, ['BAD_REQUEST', 'FORBIDDEN', 'CONFLICT', 'TOO_LARGE', 'NOT_FOUND', 'INVALID_FILE'].includes(code) ? message : undefined);
    }
    return data;
  }

  /** Ulang dengan backoff untuk gangguan sementara (jaringan/5xx). */
  async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        await waitIfPaused();
        return await fn();
      } catch (error) {
        const code = error instanceof FileAccessError ? error.code : 'NETWORK';
        const transient = code === 'NETWORK' || code === 'UPSTREAM';
        if (!transient || attempt >= maxRetries || aborted) throw error;
        emit('menyambung');
        await sleep(Math.min(1000 * 2 ** attempt, 30000));
      }
    }
  }

  async function put(headers: Record<string, string>, body: Blob | null, base: number): Promise<TransportResponse> {
    current = new AbortController();
    try {
      return await transport(session!.uploadUrl, {
        method: 'PUT',
        headers,
        body,
        signal: current.signal,
        ...(body ? { onProgress: (loaded: number) => { sent = Math.min(base + loaded, total); emit('mengunggah'); } } : {}),
      });
    } catch (error) {
      if (aborted) throw uploadError('CANCELLED');
      if (paused) throw new PauseSignal();
      void error;
      throw fileError('NETWORK');
    } finally {
      current = null;
    }
  }

  /** Tanya Google sudah sampai byte ke berapa. */
  async function queryOffset(): Promise<{ done: TransportResponse | null; offset: number }> {
    const res = await put({ 'Content-Range': `bytes */${total}` }, null, sent);
    if (res.status === 308) return { done: null, offset: nextOffsetFromRange(res.header('Range')) };
    if (res.status === 200 || res.status === 201) return { done: res, offset: total };
    if (res.status === 404 || res.status === 410) throw uploadError('SESSION_EXPIRED');
    if (res.status >= 500) throw fileError('UPSTREAM');
    throw uploadError('UPLOAD_REJECTED');
  }

  async function sendChunks(): Promise<string> {
    let offset = 0;
    let needQuery = false;
    let failures = 0;
    for (;;) {
      try {
        await waitIfPaused();
        let res: TransportResponse | null = null;
        if (needQuery) {
          emit('menyambung');
          const q = await queryOffset();
          needQuery = false;
          if (q.done) res = q.done;
          else offset = q.offset;
        }
        if (!res) {
          const end = Math.min(offset + session!.chunkSize, total);
          sent = offset;
          emit('mengunggah');
          res = await put({ 'Content-Range': total === 0 ? 'bytes */0' : `bytes ${offset}-${end - 1}/${total}` }, req.file.slice(offset, end), offset);
        }
        if (res.status === 308) {
          offset = nextOffsetFromRange(res.header('Range'));
          sent = offset;
          failures = 0;
          continue;
        }
        if (res.status === 200 || res.status === 201) {
          sent = total;
          const id = (JSON.parse(res.text || '{}') as { id?: string }).id;
          if (!id) throw uploadError('UPLOAD_REJECTED');
          return id;
        }
        if (res.status === 404 || res.status === 410) throw uploadError('SESSION_EXPIRED');
        if (res.status >= 500 || res.status === 408 || res.status === 429) throw fileError('UPSTREAM');
        throw uploadError('UPLOAD_REJECTED');
      } catch (error) {
        if (error instanceof PauseSignal) {
          needQuery = true;
          continue;
        }
        const code = error instanceof FileAccessError ? error.code : 'NETWORK';
        if ((code === 'NETWORK' || code === 'UPSTREAM') && failures < maxRetries && !aborted) {
          failures++;
          needQuery = true;
          emit('menyambung');
          await sleep(Math.min(1000 * 2 ** (failures - 1), 30000));
          continue;
        }
        throw error;
      }
    }
  }

  const promise = (async (): Promise<UploadResult> => {
    try {
      emit('menyiapkan');
      const s = await withRetry(() =>
        api('/api/files/upload-session', {
          requestId, purpose: req.purpose, objectId: req.objectId, fileName: req.fileName, mime, size: total, ...(req.unitId ? { unitId: req.unitId } : {}),
        }),
      );
      session = { sessionId: String(s.sessionId), uploadUrl: String(s.uploadUrl), chunkSize: Number(s.chunkSize) || 8 * 1024 * 1024, context: String(s.context) };
      const driveFileId = await sendChunks();
      emit('memverifikasi');
      const done = await withRetry(() => api('/api/files/upload-complete', { sessionId: session!.sessionId, driveFileId, context: session!.context }));
      emit('selesai');
      return { sessionId: session.sessionId, driveFileId, result: done.result };
    } catch (error) {
      if (aborted) {
        emit('dibatalkan');
      } else {
        emit('gagal', error instanceof FileAccessError ? error.userMessage : fileError('UNKNOWN').userMessage);
      }
      throw error;
    } finally {
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    }
  })();

  const handle: UploadHandle = {
    promise,
    pause() {
      if (paused || aborted) return;
      paused = true;
      current?.abort();
      emit('jeda');
    },
    resume() {
      if (!paused || aborted) return;
      paused = false;
      wake?.();
      wake = null;
    },
    abort() {
      if (aborted) return;
      aborted = true;
      current?.abort();
      wake?.();
      if (session) {
        const s = session;
        void deps.getToken().then((token) =>
          token
            ? fetchFn('/api/files/upload-cancel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ sessionId: s.sessionId, uploadUrl: s.uploadUrl }),
              }).catch(() => null)
            : null,
        );
      }
    },
  };
  return handle;
}

class PauseSignal extends Error {
  constructor() {
    super('paused');
  }
}
