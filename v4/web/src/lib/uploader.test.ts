import { describe, expect, it, vi } from 'vitest';
import { guessMime, nextOffsetFromRange, startUpload, type Transport, type TransportResponse, type UploadProgress } from './uploader';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const token = async () => 'jwt';
const noSleep = async () => {};

function res(status: number, headers: Record<string, string> = {}, text = ''): TransportResponse {
  return { status, header: (n) => headers[n] ?? headers[n.toLowerCase()] ?? null, text };
}

/** Sesi resumable Google palsu: menerima potongan berurutan, 308 + Range, 200 + {id} di akhir. */
function fakeGoogle(total: number, opts: { failPutNo?: number; acceptPartial?: number } = {}) {
  let received = 0;
  let puts = 0;
  const log: string[] = [];
  const transport: Transport = async (_url, init) => {
    const cr = init.headers['Content-Range']!;
    log.push(cr);
    if (cr.startsWith('bytes */')) {
      return received >= total ? res(200, {}, JSON.stringify({ id: 'DRIVE1' })) : res(308, received ? { Range: `bytes=0-${received - 1}` } : {});
    }
    puts++;
    const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(cr)!;
    const start = Number(m[1]);
    const end = Number(m[2]);
    expect(start).toBe(received); // tidak ada byte ganda/terlewat
    expect(init.body!.size).toBe(end - start + 1);
    if (opts.failPutNo === puts) {
      received += opts.acceptPartial ?? 0; // sebagian sempat diterima sebelum putus
      throw new TypeError('network');
    }
    init.onProgress?.(end - start + 1);
    received = end + 1;
    return received >= total ? res(200, {}, JSON.stringify({ id: 'DRIVE1' })) : res(308, { Range: `bytes=0-${received - 1}` });
  };
  return { transport, log, get received() { return received; } };
}

function apiFetch(over: Partial<Record<string, (body: Record<string, unknown>) => Response>> = {}) {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fn = vi.fn(async (path: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ path, body });
    const h = over[path];
    if (h) return h(body);
    if (path === '/api/files/upload-session') {
      return Response.json({ ok: true, sessionId: 'SES1', uploadUrl: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=U1', chunkSize: 4, context: 'CTX' });
    }
    if (path === '/api/files/upload-complete') return Response.json({ ok: true, result: { item_id: 'ITM-1' } });
    if (path === '/api/files/upload-cancel') return Response.json({ ok: true });
    return new Response('', { status: 404 });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const file = (n = 10) => new Blob([new Uint8Array(n).fill(65)], { type: '' });

describe('pengunggah resumable', () => {
  it('memotong file, melapor progres, lalu mengesahkan', async () => {
    const g = fakeGoogle(10);
    const api = apiFetch();
    const stages: UploadProgress[] = [];
    const h = startUpload({ purpose: 'ITEM_PDF', objectId: 'ITM-1', file: file(), fileName: 'scan.pdf' }, {
      getToken: token, fetchFn: api.fn, transport: g.transport, sleep: noSleep, onProgress: (p) => stages.push(p),
    });
    const r = await h.promise;
    expect(r).toEqual({ sessionId: 'SES1', driveFileId: 'DRIVE1', result: { item_id: 'ITM-1' } });
    expect(g.log).toEqual(['bytes 0-3/10', 'bytes 4-7/10', 'bytes 8-9/10']);
    const s = api.calls[0]!.body;
    expect(s).toMatchObject({ purpose: 'ITEM_PDF', objectId: 'ITM-1', fileName: 'scan.pdf', mime: 'application/pdf', size: 10 });
    expect(s.requestId).toMatch(UUID_RE);
    expect(api.calls[1]).toEqual({ path: '/api/files/upload-complete', body: { sessionId: 'SES1', driveFileId: 'DRIVE1', context: 'CTX' } });
    const names = stages.map((x) => x.stage);
    expect(names[0]).toBe('menyiapkan');
    expect(names).toContain('mengunggah');
    expect(names.slice(-2)).toEqual(['memverifikasi', 'selesai']);
    expect(stages.at(-1)!.sent).toBe(10);
  });

  it('putus di tengah potongan: tanya posisi ke Google lalu lanjut tanpa byte ganda', async () => {
    const g = fakeGoogle(10, { failPutNo: 2, acceptPartial: 2 });
    const h = startUpload({ purpose: 'ITEM_PDF', objectId: 'X', file: file(), fileName: 'a.pdf' }, {
      getToken: token, fetchFn: apiFetch().fn, transport: g.transport, sleep: noSleep,
    });
    await h.promise;
    expect(g.log).toEqual(['bytes 0-3/10', 'bytes 4-7/10', 'bytes */10', 'bytes 6-9/10']);
  });

  it('sesi kedaluwarsa (404) → pesan jelas', async () => {
    const transport: Transport = async () => res(404);
    const stages: UploadProgress[] = [];
    const h = startUpload({ purpose: 'ITEM_PDF', objectId: 'X', file: file(), fileName: 'a.pdf' }, {
      getToken: token, fetchFn: apiFetch().fn, transport, sleep: noSleep, onProgress: (p) => stages.push(p),
    });
    await expect(h.promise).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect(stages.at(-1)).toMatchObject({ stage: 'gagal', message: { title: 'Sesi unggah kedaluwarsa.' } });
  });

  it('jeda lalu lanjut: posisi ditanyakan ulang', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const g = fakeGoogle(10);
    let first = true;
    const transport: Transport = async (url, init) => {
      if (first && init.headers['Content-Range'] === 'bytes 4-7/10') {
        first = false;
        await new Promise<void>((resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('a', 'AbortError')));
          void gate.then(resolve);
        });
      }
      return g.transport(url, init);
    };
    const stages: string[] = [];
    const h = startUpload({ purpose: 'ITEM_PDF', objectId: 'X', file: file(), fileName: 'a.pdf' }, {
      getToken: token, fetchFn: apiFetch().fn, transport, sleep: noSleep, onProgress: (p) => stages.push(p.stage),
    });
    await vi.waitFor(() => expect(g.log).toEqual(['bytes 0-3/10']));
    h.pause();
    expect(stages.at(-1)).toBe('jeda');
    h.resume();
    release();
    await h.promise;
    expect(g.log).toEqual(['bytes 0-3/10', 'bytes */10', 'bytes 4-7/10', 'bytes 8-9/10']);
  });

  it('offline → jeda otomatis; online → lanjut', async () => {
    const g = fakeGoogle(10);
    let n = 0;
    const transport: Transport = async (url, init) => {
      if (++n === 2) {
        window.dispatchEvent(new Event('offline'));
        throw new TypeError('network');
      }
      return g.transport(url, init);
    };
    const stages: string[] = [];
    const h = startUpload({ purpose: 'ITEM_PDF', objectId: 'X', file: file(), fileName: 'a.pdf' }, {
      getToken: token, fetchFn: apiFetch().fn, transport, sleep: noSleep, onProgress: (p) => stages.push(p.stage),
    });
    await vi.waitFor(() => expect(stages).toContain('jeda'));
    window.dispatchEvent(new Event('online'));
    await h.promise;
    expect(g.received).toBe(10);
  });

  it('batal: sesi dihentikan di server dan Google', async () => {
    const api = apiFetch();
    let abortSeen = false;
    const transport: Transport = (_u, init) => new Promise((_r, reject) => {
      init.signal.addEventListener('abort', () => { abortSeen = true; reject(new DOMException('a', 'AbortError')); });
    });
    const stages: string[] = [];
    const h = startUpload({ purpose: 'ITEM_PDF', objectId: 'X', file: file(), fileName: 'a.pdf' }, {
      getToken: token, fetchFn: api.fn, transport, sleep: noSleep, onProgress: (p) => stages.push(p.stage),
    });
    await vi.waitFor(() => expect(stages).toContain('mengunggah'));
    h.abort();
    await expect(h.promise).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(abortSeen).toBe(true);
    await vi.waitFor(() => expect(api.calls.map((c) => c.path)).toContain('/api/files/upload-cancel'));
    expect(api.calls.find((c) => c.path === '/api/files/upload-cancel')!.body).toEqual({
      sessionId: 'SES1', uploadUrl: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=U1',
    });
    expect(stages.at(-1)).toBe('dibatalkan');
  });

  it('gangguan saat membuka sesi diulang dengan requestId yang sama', async () => {
    let n = 0;
    const api = apiFetch({
      '/api/files/upload-session': () => {
        if (++n === 1) return Response.json({ ok: false, code: 'UPSTREAM' }, { status: 502 });
        return Response.json({ ok: true, sessionId: 'SES1', uploadUrl: 'https://www.googleapis.com/upload/x?upload_id=1', chunkSize: 100, context: 'CTX' });
      },
    });
    const h = startUpload({ purpose: 'ITEM_PDF', objectId: 'X', file: file(), fileName: 'a.pdf' }, {
      getToken: token, fetchFn: api.fn, transport: fakeGoogle(10).transport, sleep: noSleep,
    });
    await h.promise;
    const ids = api.calls.filter((c) => c.path === '/api/files/upload-session').map((c) => c.body.requestId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it('pesan penolakan dari server diteruskan (mis. batas ukuran)', async () => {
    const api = apiFetch({ '/api/files/upload-session': () => Response.json({ ok: false, code: 'TOO_LARGE', message: 'Ukuran file melebihi batas 100 MB.' }, { status: 413 }) });
    const h = startUpload({ purpose: 'ITEM_PDF', objectId: 'X', file: file(), fileName: 'a.pdf' }, { getToken: token, fetchFn: api.fn, transport: fakeGoogle(10).transport, sleep: noSleep });
    await expect(h.promise).rejects.toMatchObject({ code: 'TOO_LARGE', userMessage: { title: 'Ukuran file melebihi batas 100 MB.' } });
  });

  it('bantuan kecil', () => {
    expect(nextOffsetFromRange('bytes=0-1048575')).toBe(1048576);
    expect(nextOffsetFromRange(null)).toBe(0);
    expect(guessMime(new Blob([], { type: 'application/octet-stream' }), 'SCAN.PDF')).toBe('application/pdf');
    expect(guessMime(new Blob([], { type: 'image/png' }), 'x')).toBe('image/png');
  });
});
