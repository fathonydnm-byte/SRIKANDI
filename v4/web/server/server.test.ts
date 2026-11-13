// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import nodeCrypto from 'node:crypto';
import { signTicket, verifyTicket, TICKET_TTL_SECONDS } from './ticket';
import { contentDisposition, safeContentType, sanitizeRange, cleanFileName } from './headers';
import { clearGatewayCache, getDriveToken, GatewayError, signGatewayRequest } from './gateway';
import { handleDownload } from './downloadHandler';
import { handleTicket } from './ticketHandler';
import type { FetchFn, FileEnv } from './env';

const SECRET = 'k'.repeat(40);
const NOW = 1_800_000_000;
const PAYLOAD = { fid: 'FILEabc_123', name: 'Laporan.pdf', mime: 'application/pdf', disp: 'inline' as const, sub: 'user-1' };

describe('tiket unduh', () => {
  it('ditandatangani dan diverifikasi; umur 10 menit', async () => {
    const { token, exp } = await signTicket(PAYLOAD, SECRET, NOW);
    expect(exp).toBe(NOW + TICKET_TTL_SECONDS);
    expect(TICKET_TTL_SECONDS).toBe(600);
    const r = await verifyTicket(token, SECRET, NOW + 59);
    expect(r).toEqual({ ok: true, payload: { v: 1, ...PAYLOAD, exp } });
  });
  it('kedaluwarsa tepat saat exp', async () => {
    const { token } = await signTicket(PAYLOAD, SECRET, NOW);
    expect(await verifyTicket(token, SECRET, NOW + TICKET_TTL_SECONDS)).toEqual({ ok: false, reason: 'expired' });
  });
  it('menolak perubahan isi, tanda tangan, dan secret lain', async () => {
    const { token } = await signTicket(PAYLOAD, SECRET, NOW);
    const [body, sig] = token.split('.') as [string, string];
    const forged = Buffer.from(JSON.stringify({ v: 1, ...PAYLOAD, fid: 'OTHER', exp: NOW + 60 })).toString('base64url');
    expect((await verifyTicket(`${forged}.${sig}`, SECRET, NOW)).ok).toBe(false);
    const flipped = sig.slice(0, -2) + (sig.endsWith('AA') ? 'AB' : 'AA');
    expect(await verifyTicket(`${body}.${flipped}`, SECRET, NOW)).toEqual({ ok: false, reason: 'signature' });
    expect(await verifyTicket(token, 'z'.repeat(40), NOW)).toEqual({ ok: false, reason: 'signature' });
  });
  it('menolak bentuk yang rusak', async () => {
    for (const t of [null, '', 'abc', 'a.b.c', '!!!.###', `${'a'.repeat(5000)}.x`]) {
      expect((await verifyTicket(t, SECRET, NOW)).ok).toBe(false);
    }
  });
});

describe('header unduhan', () => {
  it('Content-Disposition RFC 5987 dengan fallback ASCII', () => {
    expect(contentDisposition('attachment', 'Laporan Keuangan 2025.pdf')).toBe(
      `attachment; filename="Laporan Keuangan 2025.pdf"; filename*=UTF-8''Laporan%20Keuangan%202025.pdf`);
    const h = contentDisposition('inline', 'Surat “Rektor” é (1).pdf');
    expect(h).toMatch(/^inline; filename="Surat _Rektor_ e \(1\)\.pdf"|^inline; filename="Surat Rektor e \(1\)\.pdf"/);
    expect(h).toContain(`filename*=UTF-8''Surat%20%E2%80%9CRektor%E2%80%9D%20%C3%A9%20%281%29.pdf`);
  });
  it('nama berbahaya dibersihkan (CRLF, kutip, path)', () => {
    const h = contentDisposition('attachment', '../../a"b\r\nSet-Cookie: x=1\\c.pdf');
    expect(h).not.toMatch(/[\r\n]/);
    expect(h.split('filename="')[1]!.split('"')[0]).not.toMatch(/["\\/]/);
    expect(cleanFileName('')).toBe('berkas');
    expect(cleanFileName('...hidden')).toBe('hidden');
    expect(cleanFileName('x'.repeat(300) + '.pdf')).toHaveLength(150);
    expect(cleanFileName('x'.repeat(300) + '.pdf').endsWith('.pdf')).toBe(true);
  });
  it('hanya tipe aman yang boleh inline', () => {
    expect(safeContentType('application/pdf', 'inline')).toEqual({ contentType: 'application/pdf', disposition: 'inline' });
    expect(safeContentType('APPLICATION/PDF', 'attachment')).toEqual({ contentType: 'application/pdf', disposition: 'attachment' });
    for (const m of ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/html; charset=utf-8', '', 'x']) {
      expect(safeContentType(m, 'inline')).toEqual({ contentType: 'application/octet-stream', disposition: 'attachment' });
    }
  });
  it('Range: satu rentang sah saja', () => {
    expect(sanitizeRange('bytes=0-1023')).toBe('bytes=0-1023');
    expect(sanitizeRange('bytes=500-')).toBe('bytes=500-');
    expect(sanitizeRange('bytes=-500')).toBe('bytes=-500');
    for (const r of [null, '', 'bytes=-', 'bytes=5-1', 'bytes=0-1,5-9', 'items=0-1', 'bytes=0-1\r\nX: y']) expect(sanitizeRange(r)).toBeNull();
  });
});

/** Muat Code.gs di vm dengan stub Apps Script (untuk uji kecocokan tanda tangan). */
function loadAppsScript(secret: string) {
  const src = fs.readFileSync(path.resolve(__dirname, '../../gateway-apps-script/Code.gs'), 'utf8');
  const toSigned = (b: Buffer) => Array.from(b, (x) => (x > 127 ? x - 256 : x));
  const ctx = vm.createContext({
    Math, JSON, String, isFinite, Date,
    console: { log() {}, warn() {}, error() {} },
    Utilities: {
      newBlob: (s: string) => ({ getBytes: () => toSigned(Buffer.from(s, 'utf8')) }),
      computeHmacSha256Signature: (v: number[], k: number[]) =>
        toSigned(nodeCrypto.createHmac('sha256', Buffer.from(k.map((x) => x & 255))).update(Buffer.from(v.map((x) => x & 255))).digest()),
    },
  });
  vm.runInContext(src, ctx);
  return (body: unknown) => (ctx as unknown as { verifyGatewayRequest_(b: unknown, s: string, n: number): { ok: boolean } }).verifyGatewayRequest_(body, secret, Date.now());
}

function gatewayResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
}

describe('klien gerbang Drive', () => {
  const GW = 'https://script.google.com/macros/s/ABC/exec';
  beforeEach(() => clearGatewayCache());

  it('tanda tangan diterima oleh Code.gs (lintas implementasi)', async () => {
    const verify = loadAppsScript(SECRET);
    const req = await signGatewayRequest(SECRET, 'MINT_DRIVE_TOKEN', Math.floor(Date.now() / 1000));
    expect(verify(req).ok).toBe(true);
    expect(verify({ ...req, nonce: req.nonce + 'x' }).ok).toBe(false);
  });

  it('mengikuti 302 ke script.googleusercontent.com dengan GET dan menyimpan token di cache', async () => {
    const fetchFn = vi.fn<FetchFn>(async (url, init) => {
      if (url === GW) {
        expect(init?.method).toBe('POST');
        expect(init?.redirect).toBe('manual');
        return gatewayResponse('', 302, { Location: 'https://script.googleusercontent.com/macros/echo?user_content_key=x' });
      }
      expect(init?.method).toBe('GET');
      return gatewayResponse({ ok: true, accessToken: 'ya29.A', expiresInHint: 1800 });
    });
    let now = NOW;
    const opts = { url: GW, secret: SECRET, fetchFn, now: () => now };
    expect(await getDriveToken(opts)).toBe('ya29.A');
    expect(await getDriveToken(opts)).toBe('ya29.A');
    expect(fetchFn).toHaveBeenCalledTimes(2); // POST + GET sekali saja
    now = NOW + 1800 - 300; // batas aman
    await getDriveToken(opts);
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it('permintaan serentak hanya memanggil gerbang sekali', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => gatewayResponse({ ok: true, accessToken: 'ya29.B', expiresInHint: 1800 }));
    const opts = { url: GW, secret: SECRET, fetchFn, now: () => NOW };
    const all = await Promise.all([getDriveToken(opts), getDriveToken(opts), getDriveToken(opts)]);
    expect(all).toEqual(['ya29.B', 'ya29.B', 'ya29.B']);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('jalur gagal: ditolak, HTTP error, JSON rusak, redirect ke host lain, jaringan; kegagalan tidak di-cache', async () => {
    const cases: [Response | Error, GatewayError['kind']][] = [
      [gatewayResponse({ ok: false, error: 'DITOLAK' }), 'rejected'],
      [gatewayResponse('err', 500), 'http'],
      [gatewayResponse('<html>'), 'malformed'],
      [gatewayResponse({ ok: true }), 'malformed'],
      [gatewayResponse('', 302, { Location: 'https://evil.example/steal' }), 'redirect'],
      [new Error('offline'), 'network'],
    ];
    for (const [res, kind] of cases) {
      clearGatewayCache();
      const fetchFn = vi.fn<FetchFn>(async () => { if (res instanceof Error) throw res; return res; });
      await expect(getDriveToken({ url: GW, secret: SECRET, fetchFn, now: () => NOW })).rejects.toMatchObject({ kind });
      const ok = vi.fn<FetchFn>(async () => gatewayResponse({ ok: true, accessToken: 'ya29.C' }));
      expect(await getDriveToken({ url: GW, secret: SECRET, fetchFn: ok, now: () => NOW })).toBe('ya29.C');
    }
  });
});

const ENV: FileEnv = {
  SUPABASE_URL: 'https://proj.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
  FILE_TICKET_SECRET: SECRET,
  DRIVE_GATEWAY_URL: 'https://script.google.com/macros/s/ABC/exec',
  DRIVE_GATEWAY_SECRET: 'g'.repeat(64),
};

async function ticketFor(over: Partial<typeof PAYLOAD> = {}, now = NOW) {
  return (await signTicket({ ...PAYLOAD, ...over }, SECRET, now)).token;
}

function driveFake(handler: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = vi.fn<FetchFn>(async (url, init) => {
    calls.push({ url, ...(init ? { init } : {}) });
    if (url.startsWith('https://script.google.com/')) return gatewayResponse({ ok: true, accessToken: `ya29.T${calls.length}`, expiresInHint: 1800 });
    return handler(url, init);
  });
  return { fetchFn, calls };
}

const dl = (token: string, headers: Record<string, string> = {}) =>
  new Request(`https://app.example/api/files/download?t=${encodeURIComponent(token)}`, { headers });

describe('GET /api/files/download', () => {
  beforeEach(() => clearGatewayCache());

  it('mengalirkan PDF dengan header aman; token Google tidak bocor', async () => {
    const { fetchFn, calls } = driveFake(() => new Response('%PDF-1.7 data', { status: 200, headers: { 'Content-Length': '13', 'Content-Type': 'text/html', 'X-Goog-Secret': 'x' } }));
    const res = await handleDownload(dl(await ticketFor()), ENV, fetchFn, NOW);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('%PDF-1.7 data');
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Content-Disposition')).toBe(`inline; filename="Laporan.pdf"; filename*=UTF-8''Laporan.pdf`);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Length')).toBe('13');
    expect(res.headers.get('X-Goog-Secret')).toBeNull();
    expect([...res.headers.values()].join(' ')).not.toContain('ya29');
    const drive = calls.find((c) => c.url.startsWith('https://www.googleapis.com/'))!;
    expect(drive.url).toBe('https://www.googleapis.com/drive/v3/files/FILEabc_123?alt=media&supportsAllDrives=true');
    expect((drive.init?.headers as Record<string, string>).Authorization).toMatch(/^Bearer ya29\./);
  });

  it('meneruskan Range dan 206/Content-Range', async () => {
    const { fetchFn, calls } = driveFake((_u, init) => {
      expect((init?.headers as Record<string, string>).Range).toBe('bytes=100-199');
      return new Response('x'.repeat(100), { status: 206, headers: { 'Content-Range': 'bytes 100-199/104857600', 'Content-Length': '100' } });
    });
    const res = await handleDownload(dl(await ticketFor(), { Range: 'bytes=100-199' }), ENV, fetchFn, NOW);
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 100-199/104857600');
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(calls.length).toBe(2);
  });

  it('Range tidak sah tidak diteruskan; 416 diteruskan tanpa isi', async () => {
    const { fetchFn } = driveFake((_u, init) => {
      expect((init?.headers as Record<string, string>).Range).toBeUndefined();
      return new Response('', { status: 416, headers: { 'Content-Range': 'bytes */10' } });
    });
    const res = await handleDownload(dl(await ticketFor(), { Range: 'bytes=0-1,4-5' }), ENV, fetchFn, NOW);
    expect(res.status).toBe(416);
    expect(res.headers.get('Content-Range')).toBe('bytes */10');
  });

  it('tipe berbahaya dipaksa diunduh sebagai octet-stream', async () => {
    const { fetchFn } = driveFake(() => new Response('<script>alert(1)</script>'));
    const res = await handleDownload(dl(await ticketFor({ mime: 'text/html', name: 'x.html' })), ENV, fetchFn, NOW);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment;/);
  });

  it('401 dari Drive: token diperbarui sekali lalu dicoba ulang', async () => {
    let n = 0;
    const { fetchFn, calls } = driveFake(() => (++n === 1 ? new Response('expired', { status: 401 }) : new Response('ok')));
    const res = await handleDownload(dl(await ticketFor()), ENV, fetchFn, NOW);
    expect(res.status).toBe(200);
    expect(calls.filter((c) => c.url.startsWith('https://script.google.com/')).length).toBe(2);
  });

  it('error upstream tidak diteruskan isinya', async () => {
    for (const [status, expected] of [[404, 404], [403, 502], [500, 502]] as const) {
      clearGatewayCache();
      const { fetchFn } = driveFake(() => new Response('{"error":{"message":"internal secret detail ya29"}}', { status }));
      const res = await handleDownload(dl(await ticketFor()), ENV, fetchFn, NOW);
      expect(res.status).toBe(expected);
      const text = await res.text();
      expect(text).not.toContain('secret detail');
      expect(text).not.toContain('ya29');
      expect(res.headers.get('Content-Type')).toBe('text/plain; charset=utf-8');
    }
  });

  it('tiket kedaluwarsa → 410; rusak → 400; gerbang belum dipasang → 503', async () => {
    const fetchFn = vi.fn<FetchFn>();
    const expired = await handleDownload(dl(await ticketFor({}, NOW - TICKET_TTL_SECONDS - 1)), ENV, fetchFn, NOW);
    expect(expired.status).toBe(410);
    expect(expired.headers.get('X-Error-Code')).toBe('TICKET_EXPIRED');
    expect(await expired.text()).toContain('kedaluwarsa');
    expect((await handleDownload(dl('rusak'), ENV, fetchFn, NOW)).status).toBe(400);
    const noGw = await handleDownload(dl(await ticketFor()), { ...ENV, DRIVE_GATEWAY_URL: '' }, fetchFn, NOW);
    expect(noGw.status).toBe(503);
    expect(noGw.headers.get('X-Error-Code')).toBe('GATEWAY_NOT_CONFIGURED');
    expect(await noGw.text()).toContain('Jembatan Drive belum dipasang');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('gerbang menolak → 502 tanpa detail', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => gatewayResponse({ ok: false, error: 'DITOLAK' }));
    const res = await handleDownload(dl(await ticketFor()), ENV, fetchFn, NOW);
    expect(res.status).toBe(502);
    expect(res.headers.get('X-Error-Code')).toBe('UPSTREAM');
  });
});

describe('DRIVE_API_BASE (uji lokal saja)', () => {
  it('override hanya untuk localhost', async () => {
    const { driveApiBase } = await import('./env');
    expect(driveApiBase({})).toBe('https://www.googleapis.com');
    expect(driveApiBase({ DRIVE_API_BASE: 'http://127.0.0.1:8790/x' })).toBe('http://127.0.0.1:8790');
    expect(driveApiBase({ DRIVE_API_BASE: 'https://evil.example' })).toBe('https://www.googleapis.com');
    expect(driveApiBase({ DRIVE_API_BASE: 'http://localhost.evil.example' })).toBe('https://www.googleapis.com');
    expect(driveApiBase({ DRIVE_API_BASE: 'nonsense' })).toBe('https://www.googleapis.com');
  });
});

describe('POST /api/files/ticket', () => {
  const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJl';
  const req = (body: unknown, auth: string | null = `Bearer ${JWT}`) =>
    new Request('https://app.example/api/files/ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const ACCESS = { file_name: 'Laporan.pdf', mime: 'application/pdf', size: 1000, object_type: 'ITEM', object_id: 'ITM-1', unit_id: 'u1' };

  function supa(access: unknown, logStatus = 200, accessStatus = 200) {
    return vi.fn<FetchFn>(async (url, init) => {
      const h = init?.headers as Record<string, string>;
      expect(h.apikey).toBe('anon-key');
      expect(h.Authorization).toBe(`Bearer ${JWT}`);
      if (url.endsWith('/rpc/get_file_access')) return new Response(JSON.stringify(access), { status: accessStatus });
      if (url.endsWith('/rpc/log_file_access')) {
        const b = JSON.parse(String(init?.body));
        expect(b.p_disposition).toBe('attachment');
        expect(b.p_request_id).toMatch(/^[A-Za-z0-9_-]{16}$/);
        return new Response(logStatus === 200 ? JSON.stringify({ log_id: 'LOG-1', user_id: 'user-1' }) : '{"message":"x"}', { status: logStatus });
      }
      throw new Error(url);
    });
  }

  it('memberi tiket 10 menit setelah otorisasi dan audit', async () => {
    const fetchFn = supa(ACCESS);
    const res = await handleTicket(req({ driveFileId: 'FILEabc_123', disposition: 'attachment' }), ENV, fetchFn, NOW);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; expiresAt: number; size: number };
    expect(body.expiresAt).toBe(NOW + TICKET_TTL_SECONDS);
    expect(body.size).toBe(1000);
    const t = new URL(body.url, 'https://x').searchParams.get('t');
    const v = await verifyTicket(t, SECRET, NOW);
    expect(v.ok && v.payload).toMatchObject({ fid: 'FILEabc_123', disp: 'attachment', sub: 'user-1', name: 'Laporan.pdf' });
    expect(fetchFn.mock.calls.map((c) => c[0])).toEqual([
      'https://proj.supabase.co/rest/v1/rpc/get_file_access',
      'https://proj.supabase.co/rest/v1/rpc/log_file_access',
    ]);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('tidak terlihat → 404 dan tidak dicatat', async () => {
    const fetchFn = supa(null);
    const res = await handleTicket(req({ driveFileId: 'X', disposition: 'attachment' }), ENV, fetchFn, NOW);
    expect(res.status).toBe(404);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('gagal mencatat audit → tidak ada tiket', async () => {
    expect((await handleTicket(req({ driveFileId: 'X', disposition: 'attachment' }), ENV, supa(ACCESS, 500), NOW)).status).toBe(502);
    expect((await handleTicket(req({ driveFileId: 'X', disposition: 'attachment' }), ENV, supa(ACCESS, 403), NOW)).status).toBe(404);
  });

  it('tanpa/salah sesi, input buruk, konfigurasi kurang', async () => {
    const never = vi.fn<FetchFn>();
    expect((await handleTicket(req({ driveFileId: 'X', disposition: 'inline' }, null), ENV, never, NOW)).status).toBe(401);
    expect((await handleTicket(req({ driveFileId: 'X', disposition: 'inline' }, 'Basic abc'), ENV, never, NOW)).status).toBe(401);
    expect((await handleTicket(req({ driveFileId: '../x', disposition: 'inline' }), ENV, never, NOW)).status).toBe(400);
    expect((await handleTicket(req({ driveFileId: 'X', disposition: 'preview' }), ENV, never, NOW)).status).toBe(400);
    expect((await handleTicket(req('not json'), ENV, never, NOW)).status).toBe(400);
    expect((await handleTicket(req({ driveFileId: 'X', disposition: 'inline' }), { ...ENV, FILE_TICKET_SECRET: 'short' }, never, NOW)).status).toBe(503);
    expect(never).not.toHaveBeenCalled();
    expect((await handleTicket(req({ driveFileId: 'X', disposition: 'attachment' }), ENV, supa(ACCESS, 200, 401), NOW)).status).toBe(401);
  });
});
