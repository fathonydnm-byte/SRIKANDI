import type { SupabaseClient } from '@supabase/supabase-js';
import { toUserMessage, type UserMessage } from './errors';
import type { Role } from '../auth/permissions';

/*
 * Lapisan akses data. Semua pemanggilan Edge Function di sprint berikutnya
 * melewati modul ini agar:
 *  - setiap operasi tulis membawa kunci idempotensi `requestId` (UUID);
 *  - error selalu berbentuk ApiError dengan pesan yang dapat ditindaklanjuti.
 *
 * Kontrak respons Edge Function (diusulkan, menunggu konfirmasi backend):
 *   sukses : { ok: true,  data: T }
 *   gagal  : { ok: false, error: { code: string, message: string } }
 */

export interface Profile {
  user_id: string;
  unit_id: string | null;
  role: Role;
  full_name: string;
  active: boolean;
}

export interface Unit {
  id: string;
  code: string;
  name: string;
  active: boolean;
}

export class ApiError extends Error {
  readonly code: string;
  readonly userMessage: UserMessage;
  constructor(code: string, userMessage: UserMessage, cause?: unknown) {
    super(`${userMessage.title} ${userMessage.action}`, { cause });
    this.name = 'ApiError';
    this.code = code;
    this.userMessage = userMessage;
  }
}

function fail(error: unknown, code = 'UNKNOWN'): never {
  const e = error as { code?: unknown } | null;
  throw new ApiError(typeof e?.code === 'string' ? e.code : code, toUserMessage(error), error);
}

export function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Cadangan untuk browser lama: UUID v4 dari getRandomValues.
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

type Envelope<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

async function invoke<T>(client: SupabaseClient, fn: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.functions.invoke<Envelope<T>>(fn, { body });
  if (error) fail(error, 'FUNCTION_ERROR');
  if (!data || typeof data !== 'object' || !('ok' in data)) {
    fail({ message: 'invalid response', status: 500 }, 'INVALID_RESPONSE');
  }
  if (!data.ok) {
    // Pesan dari server sudah berbahasa Indonesia; tetap dibungkus sebagai UserMessage.
    throw new ApiError(data.error.code, { title: data.error.message, action: 'Periksa data lalu coba lagi.' });
  }
  return data.data;
}

/** Operasi baca lewat Edge Function. */
export function callRead<T>(client: SupabaseClient, fn: string, payload: Record<string, unknown> = {}): Promise<T> {
  return invoke<T>(client, fn, payload);
}

/**
 * Operasi tulis lewat Edge Function. Simpan `requestId` yang dikembalikan dan
 * kirim ulang nilai yang SAMA bila pengguna mengulang setelah gagal jaringan,
 * supaya server tidak membuat data ganda.
 */
export async function callWrite<T>(
  client: SupabaseClient,
  fn: string,
  payload: Record<string, unknown>,
  requestId: string = newRequestId(),
): Promise<{ requestId: string; data: T }> {
  const data = await invoke<T>(client, fn, { ...payload, requestId });
  return { requestId, data };
}

export async function fetchProfile(client: SupabaseClient, userId: string): Promise<Profile | null> {
  const { data, error } = await client
    .from('profiles')
    .select('user_id, unit_id, role, full_name, active')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) fail(error);
  return (data as Profile | null) ?? null;
}

export async function fetchUnit(client: SupabaseClient, unitId: string): Promise<Unit | null> {
  const { data, error } = await client.from('units').select('id, code, name, active').eq('id', unitId).maybeSingle();
  if (error) fail(error);
  return (data as Unit | null) ?? null;
}

export async function fetchUnits(client: SupabaseClient): Promise<Unit[]> {
  const { data, error } = await client.from('units').select('id, code, name, active').order('code');
  if (error) fail(error);
  return (data as Unit[] | null) ?? [];
}

export interface HealthResult {
  ok: boolean;
  latencyMs: number;
  message?: UserMessage;
}

/** Pemeriksaan ringan: satu permintaan HEAD ke tabel units (dibatasi RLS). */
export async function checkHealth(client: SupabaseClient, now: () => number = () => performance.now()): Promise<HealthResult> {
  const start = now();
  try {
    const { error } = await client.from('units').select('id', { count: 'exact', head: true });
    const latencyMs = Math.round(now() - start);
    if (error) return { ok: false, latencyMs, message: toUserMessage(error) };
    return { ok: true, latencyMs };
  } catch (error) {
    return { ok: false, latencyMs: Math.round(now() - start), message: toUserMessage(error) };
  }
}
