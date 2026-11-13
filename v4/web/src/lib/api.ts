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

/** Aksi lanjutan per kode error API_S2 (§1.1); pesan utamanya dari server. */
const CODE_ACTIONS: Record<string, string> = {
  AUTH_REQUIRED: 'Silakan masuk kembali.',
  ACCOUNT_INACTIVE: 'Hubungi admin unit.',
  FORBIDDEN_ROLE: 'Bila menurut Anda ini keliru, hubungi admin unit.',
  FORBIDDEN_UNIT: 'Pastikan Anda bekerja pada unit yang benar.',
  UNIT_REQUIRED: 'Pilih unit di bagian atas layar terlebih dahulu.',
  IDEMPOTENCY_CONFLICT: 'Muat ulang halaman lalu ulangi tindakan.',
  NOT_FOUND: 'Muat ulang data; mungkin sudah diubah orang lain.',
  RECEIPT_LOCKED: 'Untuk koreksi, batalkan tanda terima lalu buat yang baru.',
  ITEM_ALREADY_FILED: 'Muat ulang daftar antrean.',
  SOURCE_ALREADY_ACTIVE: 'Muat ulang daftar antrean.',
  UPLOAD_SESSION_ACTIVE: 'Tunggu unggahan lain selesai, lalu coba lagi.',
  RECEIPT_HAS_FILED_ITEMS: 'Setelah item dikeluarkan dari berkas, ulangi pembatalan.',
  RECEIPT_CANCELLED: 'Muat ulang daftar tanda terima.',
  ITEM_NOT_READY: 'Lengkapi metadata item di Penerimaan Naskah terlebih dahulu.',
  BATCH_LIMIT: 'Pilih paling banyak 100 item per penyimpanan.',
  CLASSIFICATION_INVALID: 'Pilih kode klasifikasi lain.',
  BERKAS_TRANSFERRED: 'Pilih berkas lain yang belum dipindahkan.',
};

/** Error RPC → ApiError. P0001: hint = KODE, message = "KODE: pesan". */
function rpcFailure(error: { code?: string; message?: string; hint?: string | null; status?: number }): ApiError {
  const raw = error.message ?? '';
  const m = /^([A-Z][A-Z0-9_]+):\s*([\s\S]*)$/.exec(raw);
  const apiCode = error.hint && /^[A-Z][A-Z0-9_]+$/.test(error.hint) ? error.hint : m?.[1];
  if (error.code === 'P0001' && apiCode) {
    if (apiCode === 'AUTH_REQUIRED') return new ApiError(apiCode, toUserMessage({ status: 401 }), error);
    const title = m && m[1] === apiCode ? m[2]! : raw;
    return new ApiError(apiCode, { title, action: CODE_ACTIONS[apiCode] ?? 'Periksa isian lalu coba lagi.' }, error);
  }
  if (error.code === '22023' && raw) return new ApiError('INVALID_INPUT', { title: raw, action: 'Periksa isian lalu coba lagi.' }, error);
  return new ApiError(error.code === '57014' ? 'INTERNAL' : (error.code ?? 'INTERNAL'), toUserMessage(error), error);
}

function transient(error: { code?: string; message?: string; status?: number; name?: string }): boolean {
  const msg = (error.message ?? '').toLowerCase();
  return msg.includes('failed to fetch') || msg.includes('networkerror') || msg.includes('fetch failed') || (error.status ?? 0) >= 502 || error.code === '57014';
}

/** Operasi baca lewat RPC Postgres (SECURITY INVOKER; RLS berlaku). */
export async function callRead<T>(client: SupabaseClient, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw rpcFailure(error);
  return data as T;
}

/**
 * Operasi tulis lewat RPC Postgres (SECURITY DEFINER, otorisasi sendiri,
 * idempoten per request_id). Selalu mengirim `p_request_id`. Gangguan jaringan
 * diulang otomatis dengan id yang SAMA; simpan `requestId` yang dikembalikan
 * bila pengguna mengulang manual, supaya server tidak membuat data ganda.
 */
export async function callWrite<T>(
  client: SupabaseClient,
  fn: string,
  args: Record<string, unknown>,
  requestId: string = newRequestId(),
  opts: { retries?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ requestId: string; data: T }> {
  const retries = opts.retries ?? 2;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    const { data, error } = await client.rpc(fn, { ...args, p_request_id: requestId });
    if (!error) return { requestId, data: data as T };
    if (attempt < retries && transient(error)) {
      await sleep(500 * 2 ** attempt);
      continue;
    }
    throw rpcFailure(error);
  }
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
  mime_type?: string | null;
  drive_file_size_bytes?: number | null;
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


// ---------------------------------------------------------------------------
// Dashboard (migrasi 0009_dashboard_overview.sql)
// ---------------------------------------------------------------------------

export type RetentionStatusCode = 'ACTIVE' | 'DUE' | 'EXPIRED' | 'PROPOSED' | 'PENDING';

export interface DashboardCounts {
  total_berkas: number;
  total_item: number;
  sedang_dipinjam: number;
  retensi_h7: number;
  habis_aktif: number;
}

export interface DashboardGroup {
  berkas_id: string;
  no_berkas: number | null;
  judul_berkas: string;
  kode_klasifikasi: string | null;
  kurun_waktu: string | null;
  kabinet: string | null;
  laci: string | null;
  folder: string | null;
  lokasi: string;
  item_count: number;
  total_lembar: number;
  status_code: RetentionStatusCode;
  status_label: string;
  batas_aktif: string | null;
  days_to_active_limit: number | null;
  dipinjam: boolean;
}

export interface DashboardOverview {
  today: string;
  counts: DashboardCounts;
  groups: DashboardGroup[];
}

export interface ShortcutRow extends DashboardGroup {
  item_dipinjam: number;
  status_peminjaman: string;
  batas_inaktif: string | null;
  usul_pindah_no: string | null;
}

export interface OverviewItem {
  item_id: string;
  no_item: number | null;
  no_surat: string;
  uraian: string | null;
  jumlah_halaman: number | null;
  tanggal_naskah: string | null;
  tingkat_perkembangan: string | null;
  has_file: boolean;
  status_peminjaman: string;
}

export async function getDashboardOverview(client: SupabaseClient, unitId: string | null): Promise<DashboardOverview> {
  const { data, error } = await client.rpc('dashboard_overview', { p_unit_id: unitId });
  if (error) failRpc(error);
  return data as DashboardOverview;
}

export async function getDashboardShortcut(client: SupabaseClient, kind: 'DIPINJAM' | 'H7' | 'HABIS', unitId: string | null): Promise<ShortcutRow[]> {
  const { data, error } = await client.rpc('dashboard_shortcut', { p_kind: kind, p_unit_id: unitId });
  if (error) failRpc(error);
  return (data as ShortcutRow[] | null) ?? [];
}

export const BERKAS_ITEMS_BATCH = 100;

/** Item untuk banyak berkas sekaligus (dipecah per 100 berkas). */
export async function getBerkasItems(client: SupabaseClient, berkasIds: string[]): Promise<Record<string, OverviewItem[]>> {
  const out: Record<string, OverviewItem[]> = {};
  for (let i = 0; i < berkasIds.length; i += BERKAS_ITEMS_BATCH) {
    const chunk = berkasIds.slice(i, i + BERKAS_ITEMS_BATCH);
    const { data, error } = await client.rpc('dashboard_berkas_items', { p_berkas_ids: chunk });
    if (error) failRpc(error);
    const map = (data as Record<string, OverviewItem[]> | null) ?? {};
    for (const id of chunk) out[id] = map[id] ?? [];
  }
  return out;
}

/** Berkas yang itemnya cocok dengan teks filter (bagian item dari filter Daftar Isi). */
export async function matchBerkasByItems(client: SupabaseClient, query: string, unitId: string | null, signal?: AbortSignal): Promise<string[]> {
  let builder = client.rpc('dashboard_match_berkas', { p_query: query, p_unit_id: unitId });
  if (signal) builder = builder.abortSignal(signal);
  const { data, error } = await builder;
  if (error) failRpc(error);
  return (data as string[] | null) ?? [];
}

/** Error bisnis dari RPC (P0001): isian harus diubah, jadi request id berikutnya harus baru. */
export function isBusinessError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  const cause = error.cause as { code?: unknown } | undefined;
  return cause?.code === 'P0001' || cause?.code === '22023';
}
