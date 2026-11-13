import type { FetchFn, FileEnv } from './env';
import { getDriveToken, GatewayError, invalidateDriveToken } from './gateway';
import { contentDisposition, NO_STORE, safeContentType, sanitizeRange } from './headers';
import { textError } from './http';
import { MIN_SECRET_LENGTH, verifyTicket } from './ticket';

/**
 * GET /api/files/download?t=<tiket>
 * Mengalirkan file dari Drive API ke browser (Range/206 diteruskan).
 * Token Google dan isi error upstream tidak pernah diteruskan.
 */

const PASS_HEADERS = ['Content-Length', 'Content-Range', 'Last-Modified', 'ETag'];

export async function handleDownload(request: Request, env: FileEnv, fetchFn: FetchFn, nowSec = Math.floor(Date.now() / 1000)): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return textError('METHOD');
  if (!env.FILE_TICKET_SECRET || env.FILE_TICKET_SECRET.length < MIN_SECRET_LENGTH) return textError('NOT_CONFIGURED');

  const ticket = new URL(request.url).searchParams.get('t');
  const check = await verifyTicket(ticket, env.FILE_TICKET_SECRET, nowSec);
  if (!check.ok) return textError(check.reason === 'expired' ? 'TICKET_EXPIRED' : 'TICKET_INVALID');
  const t = check.payload;

  if (!env.DRIVE_GATEWAY_URL || !env.DRIVE_GATEWAY_SECRET) return textError('GATEWAY_NOT_CONFIGURED');
  const gw = { url: env.DRIVE_GATEWAY_URL, secret: env.DRIVE_GATEWAY_SECRET, fetchFn, now: () => nowSec };

  const range = sanitizeRange(request.headers.get('Range'));
  const driveUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(t.fid)}?alt=media&supportsAllDrives=true`;

  let upstream: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    let token: string;
    try {
      token = await getDriveToken({ ...gw, forceRefresh: attempt > 0 });
    } catch (error) {
      if (error instanceof GatewayError) return textError('UPSTREAM');
      throw error;
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (range) headers.Range = range;
    try {
      upstream = await fetchFn(driveUrl, { method: request.method, headers });
    } catch {
      return textError('UPSTREAM');
    }
    if (upstream.status !== 401) break;
    // Token kedaluwarsa/dicabut: buang cache, coba sekali lagi dengan token baru.
    await upstream.body?.cancel();
    invalidateDriveToken(gw.url, gw.secret);
  }
  if (!upstream) return textError('UPSTREAM');

  if (upstream.status === 404) {
    await upstream.body?.cancel();
    return textError('NOT_FOUND');
  }
  if (upstream.status !== 200 && upstream.status !== 206 && upstream.status !== 416) {
    await upstream.body?.cancel();
    return textError('UPSTREAM');
  }

  const { contentType, disposition } = safeContentType(t.mime, t.disp);
  const headers = new Headers({
    'Content-Type': contentType,
    'Content-Disposition': contentDisposition(disposition, t.name),
    'Cache-Control': NO_STORE,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Accept-Ranges': 'bytes',
  });
  for (const h of PASS_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (upstream.status === 416) {
    await upstream.body?.cancel();
    return new Response(null, { status: 416, headers });
  }
  return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers });
}
