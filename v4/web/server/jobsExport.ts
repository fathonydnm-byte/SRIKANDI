import { fromHex, hmacSha256, hmacVerify, sha256Hex, toHex } from './crypto';
import type { FetchFn, FileEnv } from './env';
import { json, jsonError, type ErrorCode } from './http';
import { callRpc } from './supabaseRpc';

/**
 * Ekspor untuk pekerjaan malam (Cermin Spreadsheet & Backup): POST /api/jobs/export
 *
 *   {action, ts, nonce, sig, ...parameter}
 *   ts    = detik Unix; selisih dengan jam server maksimal 120 detik
 *   nonce = 16-64 karakter [A-Za-z0-9_-], sekali pakai (dicatat di DB: job_nonces)
 *   sig   = hex(HMAC-SHA256(JOB_SECRET, "CFJOB1\n" + action + "\n" + ts + "\n" + nonce + "\n" + sha256hex(canonicalJson(parameter))))
 *   canonicalJson = JSON dengan kunci objek diurutkan (rekursif), tanpa spasi.
 *   Setiap parameter ikut ditandatangani: mengubah satu parameter membatalkan tanda tangan.
 *
 * Aksi
 *   LIST_UNITS                                           -> {ok, schema_version, tables, units[]}
 *   TABLE_PAGE {unit_id, table, after?, limit?}          -> JSON array baris (dialirkan langsung dari Supabase REST)
 *   RUN_BEGIN  {kind, unit_id}                           -> {ok, run_id}
 *   RUN_FINISH {run_id, status, stats, mirror_url?, mirror_file_id?, backup_file_id?, error?} -> {ok}
 *
 * Aturan
 *   - Pemanggil adalah proyek Apps Script ber-secret, bukan pengguna. Tidak ada JWT pengguna di sini.
 *   - Kunci service-role dipakai HANYA di modul ini dan server/adminUsers.ts, dan hanya SETELAH tanda tangan,
 *     jendela waktu, dan nonce lolos. Kunci tidak pernah dikirim balik atau dicatat.
 *   - Hanya tabel di EXPORT_TABLES yang bisa dibaca, satu unit per permintaan. auth.*, vault, idempotency_keys,
 *     upload_sessions, profiles tidak ada di daftar dan tidak bisa diminta.
 *   - Batas CPU Pages ±10 ms: tubuh jawaban TABLE_PAGE dialirkan apa adanya (tanpa parse/serialisasi ulang).
 *   - Semua penolakan memakai badan jawaban generik; alasan sebenarnya tidak diberitahukan.
 */

export const JOB_VERSION = 'CFJOB1';
export const MAX_SKEW_SECONDS = 120;
export const MAX_BODY_BYTES = 32 * 1024;
export const DEFAULT_PAGE_LIMIT = 1000;
export const MAX_PAGE_LIMIT = 2000;
/** Id unit semu untuk baris audit_log yang tidak terikat unit (unit_id IS NULL). */
export const GLOBAL_UNIT = 'GLOBAL';
export const MAX_STATS_BYTES = 12 * 1024;

export interface ExportTable {
  /** Kolom urutan keyset (stabil, unik dalam satu unit). */
  key: readonly string[];
  /** Kolom yang membatasi ke satu unit. */
  unitColumn: 'unit_id' | 'id';
  /** Hanya audit_log yang boleh punya baris lintas unit (unit_id NULL). */
  allowGlobal?: true;
}

/**
 * Daftar putih tabel. Dipilih SENGAJA (bukan "semua tabel"): tabel baru di migrasi mendatang harus ditambahkan di
 * sini DAN di restore (test DB `every public table is classified` gagal bila ada yang terlupa).
 * Dikecualikan: profiles (terikat auth.users), idempotency_keys, upload_sessions, schema_migrations_log, job_nonces,
 * backup_runs. counters DIEKSPOR: tanpa itu nomor berkas/TRM berikutnya dapat bertabrakan setelah restore.
 */
export const EXPORT_TABLES = {
  units: { key: ['id'], unitColumn: 'id' },
  unit_settings: { key: ['key'], unitColumn: 'unit_id' },
  counters: { key: ['scope', 'year'], unitColumn: 'unit_id' },
  klasifikasi: { key: ['id'], unitColumn: 'unit_id' },
  jenis_naskah: { key: ['subjenis_naskah_id'], unitColumn: 'unit_id' },
  pegawai: { key: ['id'], unitColumn: 'unit_id' },
  berkas: { key: ['id'], unitColumn: 'unit_id' },
  item: { key: ['id'], unitColumn: 'unit_id' },
  penerimaan: { key: ['id'], unitColumn: 'unit_id' },
  penerimaan_item: { key: ['id'], unitColumn: 'unit_id' },
  riwayat_nomor: { key: ['id'], unitColumn: 'unit_id' },
  penerimaan_cetak_log: { key: ['id'], unitColumn: 'unit_id' },
  folder_label_log: { key: ['id'], unitColumn: 'unit_id' },
  karantina: { key: ['id'], unitColumn: 'unit_id' },
  pembatalan_arsip: { key: ['id'], unitColumn: 'unit_id' },
  drive_tasks: { key: ['id'], unitColumn: 'unit_id' },
  audit_log: { key: ['id'], unitColumn: 'unit_id', allowGlobal: true },
} as const satisfies Record<string, ExportTable>;
export type ExportTableName = keyof typeof EXPORT_TABLES;
const TABLE_NAMES = Object.keys(EXPORT_TABLES) as ExportTableName[];
const GLOBAL_TABLES: ExportTableName[] = TABLE_NAMES.filter((t) => 'allowGlobal' in EXPORT_TABLES[t]);

const ACTIONS = ['LIST_UNITS', 'TABLE_PAGE', 'RUN_BEGIN', 'RUN_FINISH'] as const;
type Action = (typeof ACTIONS)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const SIG_RE = /^[0-9a-f]{64}$/;
const DRIVE_ID_RE = /^[A-Za-z0-9_-]{10,100}$/;
const SHEET_URL_RE = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]{10,100}([/?#][^\s]{0,250})?$/;
const COMPOSITE_PART_RE = /^[A-Za-z0-9_.-]{1,100}$/;

// ---------------------------------------------------------------------------
// Kanonikalisasi + tanda tangan (diulang persis di mirror-apps-script/Code.gs; diuji silang)
// ---------------------------------------------------------------------------
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new Error('non-finite number');
      return JSON.stringify(value);
    case 'object': {
      const o = value as Record<string, unknown>;
      return `{${Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
        .join(',')}}`;
    }
    default:
      throw new Error('unsupported value');
  }
}

export async function jobCanonicalString(action: string, ts: number, nonce: string, params: Record<string, unknown>): Promise<string> {
  return `${JOB_VERSION}\n${action}\n${ts}\n${nonce}\n${await sha256Hex(canonicalJson(params))}`;
}

/** Dipakai tes (dan pemanggil Node lain) untuk menyusun permintaan bertanda tangan. */
export async function signJobRequest(secret: string, action: string, ts: number, nonce: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const sig = toHex(await hmacSha256(secret, await jobCanonicalString(action, ts, nonce, params)));
  return { action, ts, nonce, sig, ...params };
}

// ---------------------------------------------------------------------------
// Pembantu
// ---------------------------------------------------------------------------
const denied = () => jsonError('JOB_DENIED');
const upstream = () => jsonError('UPSTREAM', 'Layanan data tidak dapat dihubungi.');
const bad = (message: string) => jsonError('BAD_REQUEST', message);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function exactKeys(o: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(o);
  return required.every((k) => k in o) && keys.every((k) => required.includes(k) || optional.includes(k));
}

function base(env: FileEnv): string {
  return (env.SUPABASE_URL ?? '').replace(/\/+$/, '');
}

function serviceKey(env: FileEnv): string | null {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  return key && key.length >= 20 ? key : null;
}

/** Konfigurasi minimal: dipakai untuk 503 sebelum apa pun yang lain. */
function configured(env: FileEnv): { secret: string; key: string } | null {
  const secret = env.JOB_SECRET;
  const key = serviceKey(env);
  if (!secret || secret.length < 32 || !key || !/^https:\/\/[^/\s]+/.test(base(env)) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(base(env))) return null;
  return { secret, key };
}

function serviceHeaders(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json', ...extra };
}

/** Nilai kursor keyset yang diizinkan untuk satu kolom kunci. */
function cursorValue(v: unknown): string | number | null {
  if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
  // eslint-disable-next-line no-control-regex
  if (typeof v === 'string' && v.length >= 1 && v.length <= 200 && !/[\u0000-\u001f\u007f]/.test(v)) return v;
  return null;
}

type Parsed =
  | { action: 'LIST_UNITS' }
  | { action: 'TABLE_PAGE'; unitId: string; table: ExportTableName; after: (string | number)[] | null; limit: number }
  | { action: 'RUN_BEGIN'; kind: 'MIRROR' | 'BACKUP'; unitId: string | null }
  | { action: 'RUN_FINISH'; runId: string; status: 'SUCCESS' | 'FAILED'; stats: Record<string, unknown>; mirrorUrl: string | null; mirrorFileId: string | null; backupFileId: string | null; error: string | null };

function optionalString(v: unknown, max: number): string | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length > max) return undefined;
  return v;
}

export function parseParams(action: Action, p: Record<string, unknown>): Parsed | string {
  switch (action) {
    case 'LIST_UNITS':
      return Object.keys(p).length === 0 ? { action } : 'Parameter tidak dikenal.';
    case 'TABLE_PAGE': {
      if (!exactKeys(p, ['unit_id', 'table'], ['after', 'limit'])) return 'Parameter tidak valid.';
      const { unit_id: unitId, table } = p;
      if (typeof table !== 'string' || !Object.hasOwn(EXPORT_TABLES, table)) return 'Tabel tidak tersedia.';
      const t = table as ExportTableName;
      if (typeof unitId !== 'string' || !(UUID_RE.test(unitId) || (unitId === GLOBAL_UNIT && GLOBAL_TABLES.includes(t)))) return 'Unit tidak valid.';
      let limit = DEFAULT_PAGE_LIMIT;
      if (p.limit !== undefined) {
        if (typeof p.limit !== 'number' || !Number.isInteger(p.limit) || p.limit < 1) return 'Batas halaman tidak valid.';
        limit = Math.min(p.limit, MAX_PAGE_LIMIT);
      }
      let after: (string | number)[] | null = null;
      if (p.after !== undefined && p.after !== null) {
        const parts = Array.isArray(p.after) ? p.after : [p.after];
        const keys = EXPORT_TABLES[t].key;
        if (parts.length !== keys.length) return 'Kursor tidak valid.';
        after = [];
        for (const [i, part] of parts.entries()) {
          const v = cursorValue(part);
          if (v === null) return 'Kursor tidak valid.';
          // kunci gabungan masuk ke filter or=(...): hanya karakter aman, dan angka untuk "year"
          if (keys.length > 1 && (typeof v === 'string' ? !COMPOSITE_PART_RE.test(v) : false)) return 'Kursor tidak valid.';
          if (keys[i] === 'year' && typeof v !== 'number') return 'Kursor tidak valid.';
          after.push(v);
        }
      }
      return { action, unitId, table: t, after, limit };
    }
    case 'RUN_BEGIN': {
      if (!exactKeys(p, ['kind', 'unit_id'])) return 'Parameter tidak valid.';
      if (p.kind !== 'MIRROR' && p.kind !== 'BACKUP') return 'Jenis tidak valid.';
      const u = p.unit_id;
      if (u !== null && u !== GLOBAL_UNIT && !(typeof u === 'string' && UUID_RE.test(u))) return 'Unit tidak valid.';
      if ((u === null || u === GLOBAL_UNIT) && p.kind === 'MIRROR') return 'Cermin harus untuk satu unit.';
      return { action, kind: p.kind, unitId: u === GLOBAL_UNIT ? null : (u as string | null) };
    }
    case 'RUN_FINISH': {
      if (!exactKeys(p, ['run_id', 'status', 'stats'], ['mirror_url', 'mirror_file_id', 'backup_file_id', 'error'])) return 'Parameter tidak valid.';
      if (typeof p.run_id !== 'string' || !UUID_RE.test(p.run_id)) return 'Run tidak valid.';
      if (p.status !== 'SUCCESS' && p.status !== 'FAILED') return 'Status tidak valid.';
      if (!isPlainObject(p.stats) || new TextEncoder().encode(JSON.stringify(p.stats)).length > MAX_STATS_BYTES) return 'Statistik tidak valid.';
      const mirrorUrl = optionalString(p.mirror_url, 400);
      const mirrorFileId = optionalString(p.mirror_file_id, 100);
      const backupFileId = optionalString(p.backup_file_id, 100);
      const error = optionalString(p.error, 2000);
      if (mirrorUrl === undefined || (mirrorUrl !== null && !SHEET_URL_RE.test(mirrorUrl))) return 'Tautan cermin tidak valid.';
      if (mirrorFileId === undefined || (mirrorFileId !== null && !DRIVE_ID_RE.test(mirrorFileId))) return 'ID file tidak valid.';
      if (backupFileId === undefined || (backupFileId !== null && !DRIVE_ID_RE.test(backupFileId))) return 'ID file tidak valid.';
      if (error === undefined) return 'Pesan galat tidak valid.';
      // eslint-disable-next-line no-control-regex
      const cleaned = error === null ? null : error.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 500) || null;
      return { action, runId: p.run_id.toLowerCase(), status: p.status, stats: p.stats, mirrorUrl, mirrorFileId, backupFileId, error: cleaned };
    }
  }
}

// ---------------------------------------------------------------------------
// Penangan
// ---------------------------------------------------------------------------
export async function handleJobsExport(request: Request, env: FileEnv, fetchFn: FetchFn, nowMs: number = Date.now()): Promise<Response> {
  if (request.method !== 'POST') return jsonError('METHOD');
  const cfg = configured(env);
  if (!cfg) return jsonError('JOB_NOT_CONFIGURED');

  // --- bentuk + tanda tangan -------------------------------------------------
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (declared > MAX_BODY_BYTES) return denied();
  let text: string;
  try {
    text = await request.text();
  } catch {
    return denied();
  }
  if (text.length > MAX_BODY_BYTES) return denied();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return denied();
  }
  if (!isPlainObject(body)) return denied();
  const { action, ts, nonce, sig, ...params } = body;
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) return denied();
  if (typeof ts !== 'number' || !Number.isInteger(ts)) return denied();
  if (typeof nonce !== 'string' || !NONCE_RE.test(nonce)) return denied();
  if (typeof sig !== 'string' || !SIG_RE.test(sig)) return denied();
  if (Math.abs(Math.floor(nowMs / 1000) - ts) > MAX_SKEW_SECONDS) return denied();
  let canonical: string;
  try {
    canonical = await jobCanonicalString(action, ts, nonce, params);
  } catch {
    return denied();
  }
  const sigBytes = fromHex(sig);
  if (!sigBytes || !(await hmacVerify(cfg.secret, new TextEncoder().encode(canonical), sigBytes))) return denied();

  // --- nonce sekali pakai (DB; memori Workers tidak dapat diandalkan) ------------
  const rpcEnv = { SUPABASE_URL: env.SUPABASE_URL, SUPABASE_ANON_KEY: cfg.key };
  let fresh: boolean | null;
  try {
    const r = await callRpc<boolean>(rpcEnv, cfg.key, 'job_nonce_record', { p_nonce: nonce, p_action: action }, fetchFn);
    fresh = r.error ? null : r.data === true;
  } catch {
    fresh = null;
  }
  if (fresh === null) return upstream();
  if (!fresh) return denied();

  // --- parameter ---------------------------------------------------------------
  const parsed = parseParams(action as Action, params);
  if (typeof parsed === 'string') return bad(parsed);

  try {
    switch (parsed.action) {
      case 'LIST_UNITS':
        return await listUnits(env, cfg.key, fetchFn);
      case 'TABLE_PAGE':
        return await tablePage(env, cfg.key, fetchFn, parsed);
      case 'RUN_BEGIN':
        return await runBegin(rpcEnv, cfg.key, fetchFn, parsed);
      case 'RUN_FINISH':
        return await runFinish(rpcEnv, cfg.key, fetchFn, parsed);
    }
  } catch {
    return upstream();
  }
}

async function listUnits(env: FileEnv, key: string, fetchFn: FetchFn): Promise<Response> {
  const [unitsRes, versionRes] = await Promise.all([
    fetchFn(`${base(env)}/rest/v1/units?select=id,code,name,active&order=code.asc`, { headers: serviceHeaders(key) }),
    fetchFn(`${base(env)}/rest/v1/schema_migrations_log?select=version&order=version.desc&limit=1`, { headers: serviceHeaders(key) }),
  ]);
  if (!unitsRes.ok || !versionRes.ok) return upstream();
  const units = (await unitsRes.json()) as { id: string; code: string; name: string; active: boolean }[];
  const versions = (await versionRes.json()) as { version: string }[];
  const schemaVersion = versions[0]?.version;
  if (!Array.isArray(units) || typeof schemaVersion !== 'string') return upstream();
  const tables: Record<string, { key: readonly string[] }> = {};
  for (const t of TABLE_NAMES) tables[t] = { key: EXPORT_TABLES[t].key };
  return json({
    ok: true,
    schema_version: schemaVersion,
    max_page_limit: MAX_PAGE_LIMIT,
    tables,
    units: [
      ...units.map((u) => ({ id: u.id, code: u.code, name: u.name, active: u.active, tables: TABLE_NAMES, backup_only: false })),
      { id: GLOBAL_UNIT, code: '_PLATFORM', name: 'Lintas unit (audit tanpa unit)', active: true, tables: GLOBAL_TABLES, backup_only: true },
    ],
  });
}

/** PostgREST: filter keyset. Tabel dengan kunci gabungan memakai or=(a.gt.x,and(a.eq.x,b.gt.y)). */
function keysetQuery(table: ExportTableName, after: (string | number)[] | null): string[] {
  if (!after) return [];
  const keys = EXPORT_TABLES[table].key;
  if (keys.length === 1) return [`${keys[0]}=gt.${encodeURIComponent(String(after[0]))}`];
  // kunci gabungan: nilai sudah dibatasi ke karakter aman (COMPOSITE_PART_RE / angka)
  const clauses: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    const eq = keys.slice(0, i).map((k, j) => `${k}.eq.${String(after[j])}`);
    clauses.push(eq.length === 0 ? `${keys[i]}.gt.${String(after[i])}` : `and(${[...eq, `${keys[i]}.gt.${String(after[i])}`].join(',')})`);
  }
  return [`or=${encodeURIComponent(`(${clauses.join(',')})`)}`];
}

async function tablePage(env: FileEnv, key: string, fetchFn: FetchFn, p: Extract<Parsed, { action: 'TABLE_PAGE' }>): Promise<Response> {
  const def: ExportTable = EXPORT_TABLES[p.table];
  const scope = p.unitId === GLOBAL_UNIT ? `${def.unitColumn}=is.null` : `${def.unitColumn}=eq.${p.unitId}`;
  const order = def.key.map((k) => `${k}.asc`).join(',');
  const query = ['select=*', scope, `order=${order}`, `limit=${p.limit}`, ...keysetQuery(p.table, p.after)].join('&');
  // jumlah total hanya di halaman pertama (count=exact mahal untuk tabel besar)
  const headers = serviceHeaders(key, p.after === null ? { Prefer: 'count=exact' } : {});
  const res = await fetchFn(`${base(env)}/rest/v1/${p.table}?${query}`, { headers });
  if ((res.status !== 200 && res.status !== 206) || !res.body) return upstream();
  const out: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
  const total = /\/(\d+)$/.exec(res.headers.get('Content-Range') ?? '')?.[1];
  if (total !== undefined && p.after === null) out['X-Total-Count'] = total;
  return new Response(res.body, { status: 200, headers: out });
}

type RpcEnv = { SUPABASE_URL: string | undefined; SUPABASE_ANON_KEY: string };

function rpcFailure(code: string): Response {
  const map: Record<string, ErrorCode> = { RUN_FINISHED: 'CONFLICT', NOT_FOUND: 'NOT_FOUND', UNIT_NOT_FOUND: 'BAD_REQUEST', INVALID_INPUT: 'BAD_REQUEST' };
  return jsonError(map[code] ?? 'UPSTREAM');
}

async function runBegin(rpcEnv: RpcEnv, key: string, fetchFn: FetchFn, p: Extract<Parsed, { action: 'RUN_BEGIN' }>): Promise<Response> {
  const r = await callRpc<string>(rpcEnv, key, 'job_run_begin', { p_kind: p.kind, p_unit_id: p.unitId }, fetchFn);
  if (r.error || typeof r.data !== 'string') return rpcFailure(r.error?.code ?? '');
  return json({ ok: true, run_id: r.data });
}

async function runFinish(rpcEnv: RpcEnv, key: string, fetchFn: FetchFn, p: Extract<Parsed, { action: 'RUN_FINISH' }>): Promise<Response> {
  const r = await callRpc<{ ok: boolean }>(rpcEnv, key, 'job_run_finish', {
    p_run_id: p.runId, p_status: p.status, p_stats: p.stats, p_mirror_url: p.mirrorUrl, p_mirror_file_id: p.mirrorFileId,
    p_backup_file_id: p.backupFileId, p_error: p.error,
  }, fetchFn);
  if (r.error) return rpcFailure(r.error.code);
  return json({ ok: true });
}
