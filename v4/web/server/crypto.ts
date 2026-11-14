// Primitif kripto untuk Pages Functions (Web Crypto; juga jalan di Node >= 20).
const enc = new TextEncoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacKey(secret: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usage);
}

export async function hmacSha256(secret: string, message: string | Uint8Array): Promise<Uint8Array> {
  const key = await hmacKey(secret, ['sign']);
  const data = typeof message === 'string' ? enc.encode(message) : message;
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, data as BufferSource));
}

/** Verifikasi HMAC waktu-konstan (crypto.subtle.verify). */
export async function hmacVerify(secret: string, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  const key = await hmacKey(secret, ['verify']);
  return crypto.subtle.verify('HMAC', key, signature as BufferSource, message as BufferSource);
}

export function randomToken(bytes = 16): string {
  return b64urlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(message: string | Uint8Array): Promise<string> {
  const data = typeof message === 'string' ? enc.encode(message) : message;
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource)));
}

export function fromHex(text: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2})*$/i.test(text)) return null;
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}
