import { b64urlDecode, b64urlEncode, hmacSha256, hmacVerify } from './crypto';

const enc = new TextEncoder();

/** Token kecil bertanda tangan HMAC dengan awalan tujuan (purpose) agar tidak bisa dipakai lintas fitur. */
export async function signPayload(purpose: string, payload: Record<string, unknown>, secret: string): Promise<string> {
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = await hmacSha256(secret, `${purpose}.${body}`);
  return `${body}.${b64urlEncode(sig)}`;
}

export async function verifyPayload<T extends { exp: number }>(purpose: string, token: unknown, secret: string, nowSec: number): Promise<T | null> {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0]) return null;
  const sig = b64urlDecode(parts[1]!);
  if (!sig || sig.length !== 32) return null;
  if (!(await hmacVerify(secret, enc.encode(`${purpose}.${parts[0]}`), sig))) return null;
  try {
    const p = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0]) ?? new Uint8Array())) as T;
    if (typeof p.exp !== 'number' || nowSec >= p.exp) return null;
    return p;
  } catch {
    return null;
  }
}
