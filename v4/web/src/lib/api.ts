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

// ---------------------------------------------------------------------------
// Sprint 1: RPC baca (migrasi 0006_search.sql). Semua SECURITY INVOKER, jadi
// RLS menentukan unit yang terlihat.
// ---------------------------------------------------------------------------

export type AccountStatus = 'ACTIVE' | 'INACTIVE' | 'UNIT_INACTIVE' | 'NO_PROFILE';

export async function fetchAccountStatus(client: SupabaseClient): Promise<AccountStatus> {
  const { data, error } = await client.rpc('my_account_status');
  if (error) fail(error);
  return (typeof data === 'string' ? data : 'NO_PROFILE') as AccountStatus;
}

export type Development = 'ALL' | 'ASLI' | 'COPY';
export type FileStatusFilter = 'ALL' | 'TERSEDIA' | 'BELUM_DIUNGGAH';

export interface SearchParams {
  query: string;
  classification: string;
  development: Development;
  fileStatus: FileStatusFilter;
  dateFrom: string; // YYYY-MM-DD atau ''
  dateTo: string;
  includeDeleted: boolean;
  unitId: string | null;
  page: number; // mulai 1
  pageSize: number;
}

export interface SearchHit {
  item_id: string;
  berkas_id: string;
  unit_id: string;
  no_berkas: number | null;
  no_item: number | null;
  judul_berkas: string;
  no_surat: string;
  no_surat_utama: string | null;
  no_surat_alternatif: string | null;
  tanggal_naskah: string | null;
  uraian: string | null;
  jumlah_halaman: number | null;
  tingkat_perkembangan: string | null;
  kondisi_fisik: string | null;
  kode_klasifikasi: string | null;
  uraian_klasifikasi: string | null;
  kabinet: string | null;
  laci: string | null;
  folder: string | null;
  lokasi: string;
  klasifikasi_keamanan: string | null;
  has_file: boolean;
  drive_file_id: string | null;
  drive_file_url: string | null;
  drive_folder_url: string | null;
  status_peminjaman: string;
  status_berkas: string;
  dibatalkan: boolean;
  score: number;
}

export interface SearchResponse {
  total: number;
  limit: number;
  offset: number;
  results: SearchHit[];
}

export interface ItemDetail extends Omit<SearchHit, 'score'> {
  media_sumber: string | null;
  status_bentuk_digital: string | null;
  nama_file: string | null;
  nomor_tanda_terima: string | null;
  catatan: string | null;
}

export interface BerkasItemRow {
  item_id: string;
  no_item: number | null;
  no_surat: string;
  tanggal_naskah: string | null;
  uraian: string | null;
  jumlah_halaman: number | null;
  tingkat_perkembangan: string | null;
  klasifikasi_keamanan: string | null;
  has_file: boolean;
  drive_file_id: string | null;
  drive_file_url: string | null;
  dibatalkan: boolean;
}

export interface BerkasDetail {
  berkas_id: string;
  unit_id: string;
  no_berkas: number | null;
  judul_berkas: string;
  kode_klasifikasi: string | null;
  uraian_klasifikasi: string | null;
  kurun_waktu: string | null;
  kabinet: string | null;
  laci: string | null;
  folder: string | null;
  lokasi: string;
  klasifikasi_keamanan: string | null;
  drive_folder_url: string | null;
  status_berkas: string;
  status_peminjaman: string;
  status_retensi: string | null;
  nasib_akhir: string | null;
  dibatalkan: boolean;
  jumlah_item: number;
  total_lembar: number;
  tanggal_awal: string | null;
  tanggal_akhir: string | null;
  items: BerkasItemRow[];
}

export interface DashboardCounts {
  berkas_aktif: number;
  item_aktif: number;
  item_tanpa_pdf: number;
  penerimaan_menunggu: number;
}

/** Error validasi dari server (SQLSTATE 22023) membawa pesan berbahasa Indonesia. */
function failRpc(error: { code?: string; message?: string }): never {
  if (error.code === '22023' && error.message) {
    throw new ApiError('INVALID_FILTER', { title: error.message, action: 'Perbaiki filter, lalu cari lagi.' }, error);
  }
  fail(error);
}

export function isAbortError(error: unknown): boolean {
  const e = error as { name?: unknown; message?: unknown; code?: unknown } | null;
  return Boolean(e && (e.name === 'AbortError' || (typeof e.message === 'string' && e.message.includes('AbortError')) || e.code === '20'));
}

export async function searchArchive(client: SupabaseClient, p: SearchParams, signal?: AbortSignal): Promise<SearchResponse> {
  const args = {
    p_query: p.query || null,
    p_classification: p.classification || null,
    p_development: p.development,
    p_file_status: p.fileStatus,
    p_date_from: p.dateFrom || null,
    p_date_to: p.dateTo || null,
    p_unit_id: p.unitId,
    p_include_deleted: p.includeDeleted,
    p_limit: p.pageSize,
    p_offset: (Math.max(p.page, 1) - 1) * p.pageSize,
  };
  let builder = client.rpc('search_archive', args);
  if (signal) builder = builder.abortSignal(signal);
  const { data, error } = await builder;
  if (error) failRpc(error);
  const res = data as SearchResponse | null;
  return res ?? { total: 0, limit: p.pageSize, offset: 0, results: [] };
}

export async function getItemDetail(client: SupabaseClient, itemId: string): Promise<ItemDetail | null> {
  const { data, error } = await client.rpc('get_item_detail', { p_item_id: itemId });
  if (error) failRpc(error);
  return (data as ItemDetail | null) ?? null;
}

export async function getBerkasDetail(client: SupabaseClient, berkasId: string, includeDeleted = false): Promise<BerkasDetail | null> {
  const { data, error } = await client.rpc('get_berkas_detail', { p_berkas_id: berkasId, p_include_deleted: includeDeleted });
  if (error) failRpc(error);
  return (data as BerkasDetail | null) ?? null;
}

export async function getDashboardCounts(client: SupabaseClient, unitId: string | null): Promise<DashboardCounts> {
  const { data, error } = await client.rpc('dashboard_counts', { p_unit_id: unitId });
  if (error) failRpc(error);
  return data as DashboardCounts;
}
