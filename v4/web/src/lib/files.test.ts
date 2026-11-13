import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canShareFiles,
  downloadFile,
  FILE_ACCESS_MODE,
  FileAccessError,
  legacyDriveUrl,
  openFile,
  prepareShareFile,
  requestTicket,
  safeDriveUrl,
  SHARE_MAX_BYTES,
  shareEligible,
  shareFile,
  type FileRef,
} from './files';

const REF: FileRef = { driveFileId: 'FILE_abc-1', driveFileUrl: 'https://drive.google.com/file/d/FILE_abc-1/view', fileName: 'a.pdf', sizeBytes: 1000 };
const token = async () => 'jwt-123';
const TICKET: { ok: boolean; url: string; expiresAt: number; fileName: string; mime: string; size: number | null } = { ok: true, url: '/api/files/download?t=TICKET', expiresAt: 1, fileName: 'Laporan.pdf', mime: 'application/pdf', size: 1000 };

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function codeOf(e: unknown) {
  return e instanceof FileAccessError ? e.code : String(e);
}

function setShare(share: unknown, canShare: unknown) {
  Object.defineProperty(navigator, 'share', { value: share, configurable: true, writable: true });
  Object.defineProperty(navigator, 'canShare', { value: canShare, configurable: true, writable: true });
}

beforeEach(() => setShare(undefined, undefined));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete (navigator as { share?: unknown }).share;
  delete (navigator as { canShare?: unknown }).canShare;
});

describe('files: mode jembatan (bawaan)', () => {
  it('mode bawaan adalah bridge', () => {
    expect(FILE_ACCESS_MODE).toBe('bridge');
  });

  it('meminta tiket dengan JWT pengguna', async () => {
    const fetchFn = vi.fn(async () => jsonRes(TICKET));
    const t = await requestTicket(REF, 'inline', token, fetchFn as unknown as typeof fetch);
    expect(t.url).toBe('/api/files/download?t=TICKET');
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/files/ticket');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-123');
    expect(JSON.parse(String(init.body))).toEqual({ driveFileId: 'FILE_abc-1', disposition: 'inline' });
  });

  it('error dipetakan ke pesan yang dapat ditindaklanjuti', async () => {
    const cases: [Response | Error, string, RegExp][] = [
      [jsonRes({ ok: false, code: 'NOT_FOUND' }, 404), 'NOT_FOUND', /tidak berhak/],
      [jsonRes({ ok: false, code: 'UNAUTHENTICATED' }, 401), 'UNAUTHENTICATED', /masuk kembali/],
      [jsonRes({ ok: false, code: 'GATEWAY_NOT_CONFIGURED' }, 503), 'GATEWAY_NOT_CONFIGURED', /Jembatan Drive belum dipasang/],
      [jsonRes({ ok: false, code: 'NOT_CONFIGURED' }, 503), 'NOT_CONFIGURED', /Admin Pusat/],
      [new Response('Bad gateway', { status: 502 }), 'UPSTREAM', /Google Drive/],
      [new TypeError('Failed to fetch'), 'NETWORK', /koneksi internet/],
      [jsonRes({ ok: true, url: 'https://evil.example/x' }), 'UNKNOWN', /tidak dapat dibuka/],
    ];
    for (const [res, code, msg] of cases) {
      const fetchFn = vi.fn(async () => { if (res instanceof Error) throw res; return res; });
      const err = await requestTicket(REF, 'inline', token, fetchFn as unknown as typeof fetch).catch((e: unknown) => e);
      expect(codeOf(err), code).toBe(code);
      expect((err as FileAccessError).message).toMatch(msg);
    }
    await expect(requestTicket(REF, 'inline', async () => null)).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
    await expect(requestTicket({ driveFileId: null, driveFileUrl: null }, 'inline', token)).rejects.toMatchObject({ code: 'NO_FILE' });
  });

  it('Lihat: tab dibuka sebelum tiket ditunggu, lalu diarahkan ke URL unduhan', async () => {
    const win = { opener: {}, location: { replace: vi.fn() }, close: vi.fn() };
    const open = vi.fn(() => win);
    vi.stubGlobal('open', open);
    let resolve: (r: Response) => void = () => {};
    const fetchFn = vi.fn(() => new Promise<Response>((r) => (resolve = r)));
    const p = openFile(REF, token, fetchFn as unknown as typeof fetch);
    expect(open).toHaveBeenCalledWith('', '_blank'); // sinkron, masih dalam gestur pengguna
    expect(win.opener).toBeNull();
    await Promise.resolve();
    await Promise.resolve();
    resolve(jsonRes(TICKET));
    await p;
    expect(win.location.replace).toHaveBeenCalledWith(`${window.location.origin}/api/files/download?t=TICKET`);
    expect(win.close).not.toHaveBeenCalled();
  });

  it('Lihat: tab ditutup bila tiket gagal; pop-up diblokir dilaporkan', async () => {
    const win = { opener: {}, location: { replace: vi.fn() }, close: vi.fn() };
    vi.stubGlobal('open', vi.fn(() => win));
    const fetchFn = vi.fn(async () => jsonRes({ ok: false, code: 'NOT_FOUND' }, 404));
    await expect(openFile(REF, token, fetchFn as unknown as typeof fetch)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(win.close).toHaveBeenCalled();
    vi.stubGlobal('open', vi.fn(() => null));
    const never = vi.fn();
    await expect(openFile(REF, token, never as unknown as typeof fetch)).rejects.toMatchObject({ code: 'POPUP_BLOCKED' });
    expect(never).not.toHaveBeenCalled();
  });

  it('Unduh: klik tautan unduhan same-origin', async () => {
    const clicks: string[] = [];
    const spy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push(`${this.getAttribute('href')}|${this.download}`);
    });
    await downloadFile(REF, token, vi.fn(async () => jsonRes(TICKET)) as unknown as typeof fetch);
    expect(clicks).toEqual(['/api/files/download?t=TICKET|Laporan.pdf']);
    spy.mockRestore();
  });

  it('Bagikan: hanya bila perangkat mendukung file dan ukuran ≤ 20 MB (atau belum diketahui)', () => {
    expect(canShareFiles()).toBe(false);
    expect(shareEligible(REF)).toBe(false);
    setShare(vi.fn(), vi.fn(() => true));
    expect(shareEligible(REF)).toBe(true);
    expect(shareEligible({ ...REF, sizeBytes: SHARE_MAX_BYTES + 1 })).toBe(false);
    expect(shareEligible({ ...REF, sizeBytes: null })).toBe(true);
    expect(shareEligible({ ...REF, driveFileId: null })).toBe(false);
  });

  it('prepareShareFile: menolak > 20 MB dari tiket, Content-Length, atau aliran', async () => {
    const fetchWith = (download: Response, ticket = TICKET) =>
      vi.fn(async (url: string) => (url === '/api/files/ticket' ? jsonRes(ticket) : download)) as unknown as typeof fetch;
    await expect(prepareShareFile({ ...REF, sizeBytes: SHARE_MAX_BYTES + 1 }, token)).rejects.toMatchObject({ code: 'TOO_LARGE' });
    await expect(prepareShareFile({ ...REF, sizeBytes: null }, token, fetchWith(new Response('x'), { ...TICKET, size: SHARE_MAX_BYTES + 1 }))).rejects.toMatchObject({ code: 'TOO_LARGE' });
    await expect(prepareShareFile({ ...REF, sizeBytes: null }, token, fetchWith(new Response('x', { headers: { 'Content-Length': String(SHARE_MAX_BYTES + 1) } }), { ...TICKET, size: null }))).rejects.toMatchObject({ code: 'TOO_LARGE' });
    const big = new ReadableStream<Uint8Array>({
      pull(c) { c.enqueue(new Uint8Array(4 * 1024 * 1024)); },
    });
    await expect(prepareShareFile({ ...REF, sizeBytes: null }, token, fetchWith(new Response(big), { ...TICKET, size: null }))).rejects.toMatchObject({ code: 'TOO_LARGE' });
    const f = await prepareShareFile(REF, token, fetchWith(new Response('%PDF-1.7')));
    expect(f.name).toBe('Laporan.pdf');
    expect(f.type).toBe('application/pdf');
    expect(f.size).toBe(8);
    const expired = new Response('kedaluwarsa', { status: 410, headers: { 'X-Error-Code': 'TICKET_EXPIRED' } });
    await expect(prepareShareFile(REF, token, fetchWith(expired))).rejects.toMatchObject({ code: 'TICKET_EXPIRED' });
  });

  it('shareFile: dibagikan, dibatalkan, perlu ketukan ulang', async () => {
    const file = new File(['x'], 'a.pdf', { type: 'application/pdf' });
    setShare(vi.fn(async () => {}), vi.fn(() => true));
    expect(await shareFile(file, 'judul')).toBe('shared');
    setShare(vi.fn(async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); }), vi.fn(() => true));
    expect(await shareFile(file, 'judul')).toBe('cancelled');
    setShare(vi.fn(async () => { throw Object.assign(new Error('x'), { name: 'NotAllowedError' }); }), vi.fn(() => true));
    expect(await shareFile(file, 'judul')).toBe('needs-gesture');
  });
});

describe('files: mode darurat drive-url', () => {
  it('URL Drive hanya https Google; ID dipakai bila URL tidak aman', () => {
    expect(safeDriveUrl('javascript:alert(1)')).toBeNull();
    expect(safeDriveUrl('http://drive.google.com/x')).toBeNull();
    expect(safeDriveUrl('https://evil.example/drive.google.com')).toBeNull();
    expect(legacyDriveUrl({ driveFileId: 'abc', driveFileUrl: 'javascript:x' })).toBe('https://drive.google.com/file/d/abc/view');
    expect(legacyDriveUrl({ driveFileId: '../x', driveFileUrl: null })).toBeNull();
  });

  it('hanya aktif bila build diberi VITE_FILE_ACCESS_MODE=drive-url', async () => {
    vi.stubEnv('VITE_FILE_ACCESS_MODE', 'drive-url');
    vi.resetModules();
    const mod = await import('./files');
    expect(mod.FILE_ACCESS_MODE).toBe('drive-url');
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const never = vi.fn();
    await mod.openFile(REF, token, never as unknown as typeof fetch);
    expect(open).toHaveBeenCalledWith('https://drive.google.com/file/d/FILE_abc-1/view', '_blank', 'noopener,noreferrer');
    expect(never).not.toHaveBeenCalled();
    expect(mod.canShareFiles()).toBe(false);
  });
});
