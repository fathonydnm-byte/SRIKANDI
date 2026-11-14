/*
 * Master Log Perubahan — RPC `master_log` dan `master_log_filter_values`
 * (migrasi 0017_s3_master_log.sql; SECURITY INVOKER, RLS audit_log berlaku).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError } from './api';
import { toUserMessage } from './errors';

export type LogResult = 'SUCCESS' | 'FAILED' | 'WARNING';

export interface MasterLogRow {
  id: string;
  occurred_at: string;
  unit_id: string | null;
  unit_code: string | null;
  unit_name: string | null;
  actor_user_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  action: string;
  module: string | null;
  object_type: string | null;
  object_id: string | null;
  summary: string | null;
  reason: string | null;
  request_id: string | null;
  result: LogResult | string;
  before_data: unknown;
  after_data: unknown;
}

export interface MasterLogPage {
  total: number;
  limit: number;
  offset: number;
  rows: MasterLogRow[];
}

export interface MasterLogFilters {
  date_from?: string;
  date_to?: string;
  action?: string;
  object_type?: string;
  module?: string;
  result?: string;
  object_id?: string;
  actor?: string;
  q?: string;
}

export interface MasterLogFilterValues {
  actions: string[];
  object_types: string[];
  modules: string[];
}

const CODE_ACTIONS: Record<string, string> = {
  AUTH_REQUIRED: 'Silakan masuk kembali.',
  ACCOUNT_INACTIVE: 'Hubungi admin unit.',
  FORBIDDEN_ROLE: 'Hubungi Admin Unit bila Anda perlu melihat riwayat perubahan.',
  FORBIDDEN_UNIT: 'Pilih unit Anda sendiri.',
  INVALID_INPUT: 'Perbaiki filter, lalu coba lagi.',
};

/** Error RPC (kode di `hint`, format "KODE: pesan") -> ApiError; sisanya lewat penerjemah umum. */
function toApiError(error: { code?: string; message?: string; hint?: string | null }): ApiError {
  const raw = error.message ?? '';
  const m = /^([A-Z][A-Z0-9_]+):\s*([\s\S]*)$/.exec(raw);
  const code = error.hint && /^[A-Z][A-Z0-9_]+$/.test(error.hint) ? error.hint : m?.[1];
  if (error.code === 'P0001' && code) {
    if (code === 'AUTH_REQUIRED') return new ApiError(code, toUserMessage({ status: 401 }), error);
    const title = m && m[1] === code ? m[2]! : raw;
    return new ApiError(code, { title, action: CODE_ACTIONS[code] ?? 'Coba lagi.' }, error);
  }
  return new ApiError(typeof error.code === 'string' ? error.code : 'INTERNAL', toUserMessage(error), error);
}

export async function fetchMasterLog(
  client: SupabaseClient,
  args: { filters: MasterLogFilters; limit: number; offset: number; unitId: string | null },
  signal?: AbortSignal,
): Promise<MasterLogPage> {
  let builder = client.rpc('master_log', { p_filters: args.filters, p_limit: args.limit, p_offset: args.offset, p_unit_id: args.unitId });
  if (signal) builder = builder.abortSignal(signal);
  const { data, error } = await builder;
  if (error) throw toApiError(error);
  const page = data as MasterLogPage | null;
  return page ?? { total: 0, limit: args.limit, offset: args.offset, rows: [] };
}

export async function fetchMasterLogFilterValues(client: SupabaseClient, unitId: string | null, signal?: AbortSignal): Promise<MasterLogFilterValues> {
  let builder = client.rpc('master_log_filter_values', { p_unit_id: unitId });
  if (signal) builder = builder.abortSignal(signal);
  const { data, error } = await builder;
  if (error) throw toApiError(error);
  const v = data as Partial<MasterLogFilterValues> | null;
  return { actions: v?.actions ?? [], object_types: v?.object_types ?? [], modules: v?.modules ?? [] };
}

// ---------------------------------------------------------------------------
// Tampilan
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

/** '2026-03-10T01:02:03Z' -> '10 Mar 2026, 08.02.03 WIB' (selalu Asia/Jakarta). */
export function formatLogTime(iso: string | null | undefined, withSeconds = false): string {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  const hh = p.hour === '24' ? '00' : p.hour;
  return `${Number(p.day)} ${MONTHS[Number(p.month) - 1]} ${p.year}, ${hh}.${p.minute}${withSeconds ? `.${p.second}` : ''} WIB`;
}

export function resultLabel(result: string): string {
  return result === 'SUCCESS' ? 'Berhasil' : result === 'FAILED' ? 'Gagal' : result === 'WARNING' ? 'Peringatan' : result;
}

export function resultTone(result: string): 'ok' | 'danger' | 'warn' {
  return result === 'SUCCESS' ? 'ok' : result === 'FAILED' ? 'danger' : 'warn';
}

export type FieldChange =
  | { key: string; kind: 'changed'; before: unknown; after: unknown }
  | { key: string; kind: 'added'; after: unknown }
  | { key: string; kind: 'removed'; before: unknown };

export interface DataDiff {
  /** Tidak ada data sebelum maupun sesudah yang tercatat. */
  empty: boolean;
  changes: FieldChange[];
  unchanged: string[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => k in b && sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Perbedaan kolom antara data sebelum dan sesudah (data bukan objek dibungkus sebagai satu kolom "nilai"). */
export function diffData(before: unknown, after: unknown): DataDiff {
  const norm = (v: unknown): Record<string, unknown> | null => (v === null || v === undefined ? null : isPlainObject(v) ? v : { nilai: v });
  const b = norm(before);
  const a = norm(after);
  if (!b && !a) return { empty: true, changes: [], unchanged: [] };
  const keys = [...Object.keys(b ?? {}), ...Object.keys(a ?? {}).filter((k) => !b || !(k in b))];
  const changes: FieldChange[] = [];
  const unchanged: string[] = [];
  for (const key of keys) {
    const inB = !!b && key in b;
    const inA = !!a && key in a;
    if (inB && inA) {
      if (sameValue(b![key], a![key])) unchanged.push(key);
      else changes.push({ key, kind: 'changed', before: b![key], after: a![key] });
    } else if (inA) {
      changes.push({ key, kind: 'added', after: a![key] });
    } else {
      changes.push({ key, kind: 'removed', before: b![key] });
    }
  }
  return { empty: false, changes, unchanged };
}

/** 'judul_berkas' -> 'Judul berkas'. */
export function fieldLabel(key: string): string {
  const t = key.replace(/[_\s]+/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : key;
}

/** Nilai kolom sebagai TEKS polos (tidak pernah HTML). null -> null (ditampilkan sebagai "kosong"). */
export function formatFieldValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v === '' ? '(teks kosong)' : v;
  if (typeof v === 'boolean') return v ? 'Ya' : 'Tidak';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function prettyJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? 'null';
  } catch {
    return String(v);
  }
}
