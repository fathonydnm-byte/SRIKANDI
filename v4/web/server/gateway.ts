import { hmacSha256, randomToken, toHex } from './crypto';
import type { FetchFn } from './env';

/**
 * Klien gerbang Apps Script: meminta access token Drive akun instansi dengan
 * permintaan bertanda tangan HMAC, lalu menyimpannya di memori isolate sampai
 * menjelang kedaluwarsa. Token tidak pernah keluar dari Function.
 */

export class GatewayError extends Error {
  constructor(readonly kind: 'rejected' | 'http' | 'redirect' | 'malformed' | 'network') {
    super(`drive gateway: ${kind}`);
    this.name = 'GatewayError';
  }
}

export const TOKEN_SAFETY_MARGIN_SECONDS = 300;
const DEFAULT_TTL_SECONDS = 1800;
const ALLOWED_REDIRECT_HOSTS = new Set(['script.googleusercontent.com']);

export function gatewayCanonical(action: string, ts: number, nonce: string): string {
  return `CFGW1\n${action}\n${ts}\n${nonce}`;
}

export async function signGatewayRequest(secret: string, action: string, nowSec: number, nonce = randomToken(18)) {
  const sig = toHex(await hmacSha256(secret, gatewayCanonical(action, nowSec, nonce)));
  return { action, ts: nowSec, nonce, sig };
}

interface CacheEntry {
  token: string;
  /** detik Unix saat token tidak lagi dipakai */
  useUntil: number;
}

/** Cache per URL gerbang + per secret (ganti secret = cache baru). */
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<string>>();

export function clearGatewayCache(): void {
  cache.clear();
  inflight.clear();
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new GatewayError('malformed');
  }
}

async function callGateway(url: string, secret: string, fetchFn: FetchFn, nowSec: number): Promise<{ token: string; ttl: number }> {
  const body = JSON.stringify(await signGatewayRequest(secret, 'MINT_DRIVE_TOKEN', nowSec));
  let res: Response;
  try {
    res = await fetchFn(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, redirect: 'manual' });
    // Apps Script menjawab 302 ke script.googleusercontent.com; ikuti dengan GET.
    if (res.status === 301 || res.status === 302 || res.status === 303 || res.status === 307 || res.status === 308) {
      const location = res.headers.get('Location');
      let next: URL;
      try {
        next = new URL(location ?? '', url);
      } catch {
        throw new GatewayError('redirect');
      }
      if (next.protocol !== 'https:' || !ALLOWED_REDIRECT_HOSTS.has(next.hostname)) throw new GatewayError('redirect');
      res = await fetchFn(next.toString(), { method: 'GET', redirect: 'manual' });
    }
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    throw new GatewayError('network');
  }
  if (res.status !== 200) throw new GatewayError('http');
  const data = (await readJson(res)) as { ok?: unknown; accessToken?: unknown; expiresInHint?: unknown } | null;
  if (!data || data.ok !== true) throw new GatewayError('rejected');
  if (typeof data.accessToken !== 'string' || !data.accessToken) throw new GatewayError('malformed');
  const ttl = typeof data.expiresInHint === 'number' && data.expiresInHint > 0 ? Math.min(data.expiresInHint, 3300) : DEFAULT_TTL_SECONDS;
  return { token: data.accessToken, ttl };
}

export interface GatewayOptions {
  url: string;
  secret: string;
  fetchFn: FetchFn;
  now?: () => number; // detik
  /** Abaikan cache (mis. setelah Drive menjawab 401). */
  forceRefresh?: boolean;
}

export async function getDriveToken(opts: GatewayOptions): Promise<string> {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const key = `${opts.url}\n${opts.secret}`;
  const hit = cache.get(key);
  if (!opts.forceRefresh && hit && now() < hit.useUntil) return hit.token;
  const pending = inflight.get(key);
  if (!opts.forceRefresh && pending) return pending;
  const p = (async () => {
    const t0 = now();
    const { token, ttl } = await callGateway(opts.url, opts.secret, opts.fetchFn, t0);
    cache.set(key, { token, useUntil: t0 + Math.max(ttl - TOKEN_SAFETY_MARGIN_SECONDS, 30) });
    return token;
  })();
  inflight.set(key, p);
  try {
    return await p;
  } catch (error) {
    cache.delete(key);
    throw error;
  } finally {
    inflight.delete(key);
  }
}

export function invalidateDriveToken(url: string, secret: string): void {
  cache.delete(`${url}\n${secret}`);
}
