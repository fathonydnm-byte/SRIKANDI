import type { FetchFn, FileEnv } from './env';

/** Panggilan RPC PostgREST sebagai PENGGUNA (anon key + JWT pengguna). Tanpa service-role. */
export interface RpcOutcome<T> {
  status: number;
  data: T | null;
  /** Pesan dari Postgres (sudah berbahasa Indonesia untuk error bisnis), tanpa detail teknis lain. */
  /** business = error bisnis API_S2 (P0001 + kode); hanya pesannya yang boleh ditampilkan ke pengguna. */
  error: { code: string; message: string; business: boolean } | null;
}

/**
 * Error bisnis API_S2: SQLSTATE P0001, hint = KODE, message = "KODE: pesan".
 * Mengembalikan kode stabil dan pesan Indonesia tanpa awalan kode.
 */
export function businessError(body: { code?: unknown; message?: unknown; hint?: unknown } | null): { code: string; message: string; business: boolean } {
  const raw = typeof body?.message === 'string' ? body.message : '';
  const hint = typeof body?.hint === 'string' && /^[A-Z][A-Z0-9_]+$/.test(body.hint) ? body.hint : null;
  const m = /^([A-Z][A-Z0-9_]+):\s*([\s\S]*)$/.exec(raw);
  const business = body?.code === 'P0001' && Boolean(hint ?? m);
  if (!business) {
    // Error sistem/PostgREST: jangan teruskan teks teknisnya.
    return { code: typeof body?.code === 'string' ? body.code : 'INTERNAL', message: '', business: false };
  }
  const code = hint ?? m![1]!;
  const message = (m && (!hint || m[1] === hint) ? m[2]! : raw).slice(0, 300);
  return { code, message, business: true };
}

export async function callRpc<T>(env: FileEnv, jwt: string, fn: string, args: Record<string, unknown>, fetchFn: FetchFn): Promise<RpcOutcome<T>> {
  const res = await fetchFn(`${(env.SUPABASE_URL ?? '').replace(/\/+$/, '')}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_ANON_KEY ?? '',
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(args),
  });
  const body: unknown = await res.json().catch(() => null);
  if (res.ok) return { status: res.status, data: body as T, error: null };
  return { status: res.status, data: null, error: businessError(body as Record<string, unknown> | null) };
}

/** JWT pengguna dari header Authorization (format saja; validasi oleh PostgREST). */
export function bearer(request: Request): string | null {
  const auth = request.headers.get('Authorization') ?? '';
  return /^Bearer\s+([A-Za-z0-9._-]{20,4096})$/.exec(auth)?.[1] ?? null;
}
