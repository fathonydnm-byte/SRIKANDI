import { b64urlDecode, b64urlEncode, hmacSha256, hmacVerify } from './crypto';

/** Tiket unduh: berumur pendek, satu tujuan, ditandatangani HMAC. */
export const TICKET_TTL_SECONDS = 60;
export const MIN_SECRET_LENGTH = 32;

export type Disposition = 'inline' | 'attachment';

export interface TicketPayload {
  v: 1;
  /** Drive file id */
  fid: string;
  name: string;
  mime: string;
  disp: Disposition;
  /** detik Unix */
  exp: number;
  /** auth user id (dari log_file_access) */
  sub: string;
}

const enc = new TextEncoder();
const PURPOSE = 'cf-file-ticket-v1.';

export async function signTicket(payload: Omit<TicketPayload, 'v' | 'exp'> & { exp?: number }, secret: string, nowSec = Math.floor(Date.now() / 1000)): Promise<{ token: string; exp: number }> {
  const full: TicketPayload = { v: 1, fid: payload.fid, name: payload.name, mime: payload.mime, disp: payload.disp, sub: payload.sub, exp: payload.exp ?? nowSec + TICKET_TTL_SECONDS };
  const body = b64urlEncode(enc.encode(JSON.stringify(full)));
  const sig = await hmacSha256(secret, PURPOSE + body);
  return { token: `${body}.${b64urlEncode(sig)}`, exp: full.exp };
}

export type TicketCheck = { ok: true; payload: TicketPayload } | { ok: false; reason: 'malformed' | 'signature' | 'expired' };

export async function verifyTicket(token: string | null, secret: string, nowSec = Math.floor(Date.now() / 1000)): Promise<TicketCheck> {
  if (!token || token.length > 4096) return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [body, sigText] = parts as [string, string];
  const sig = b64urlDecode(sigText);
  if (!sig || sig.length !== 32 || !body) return { ok: false, reason: 'malformed' };
  if (!(await hmacVerify(secret, enc.encode(PURPOSE + body), sig))) return { ok: false, reason: 'signature' };
  const raw = b64urlDecode(body);
  let p: TicketPayload;
  try {
    p = JSON.parse(new TextDecoder().decode(raw ?? new Uint8Array())) as TicketPayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (p.v !== 1 || typeof p.fid !== 'string' || typeof p.exp !== 'number' || (p.disp !== 'inline' && p.disp !== 'attachment')) {
    return { ok: false, reason: 'malformed' };
  }
  if (nowSec >= p.exp) return { ok: false, reason: 'expired' };
  return { ok: true, payload: p };
}
