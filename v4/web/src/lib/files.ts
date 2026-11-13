/*
 * SATU-SATUNYA jalur membuka file arsip.
 *
 * Mode 'bridge' (bawaan): minta tiket ke /api/files/ticket (Pages Function,
 * memeriksa hak akses lewat Supabase + mencatat audit), lalu buka
 * /api/files/download?t=… yang mengalirkan file dari Drive akun instansi.
 * Pengguna tidak perlu (dan tidak punya) akses Google Drive.
 *
 * Mode 'drive-url' (hanya bila build diberi VITE_FILE_ACCESS_MODE=drive-url):
 * perilaku lama, membuka URL Drive yang tersimpan. Untuk keadaan darurat saja.
 */
import type { UserMessage } from './errors';

export type FileAccessMode = 'bridge' | 'drive-url';
export const FILE_ACCESS_MODE: FileAccessMode = import.meta.env.VITE_FILE_ACCESS_MODE === 'drive-url' ? 'drive-url' : 'bridge';

export const SHARE_MAX_BYTES = 20 * 1024 * 1024;

export interface FileRef {
  driveFileId: string | null;
  driveFileUrl: string | null;
  fileName?: string | null;
  mime?: string | null;
  sizeBytes?: number | null;
}

export type Disposition = 'inline' | 'attachment';
export type GetAccessToken = () => Promise<string | null>;

export class FileAccessError extends Error {
  constructor(
    readonly code: string,
    readonly userMessage: UserMessage,
  ) {
    super(`${userMessage.title} ${userMessage.action}`);
    this.name = 'FileAccessError';
  }
}

const MESSAGES: Record<string, UserMessage> = {
  NO_FILE: { title: 'PDF belum diunggah untuk arsip ini.', action: 'Minta petugas melakukan alih media terlebih dahulu.' },
  UNAUTHENTICATED: { title: 'Sesi Anda sudah berakhir.', action: 'Muat ulang halaman lalu masuk kembali.' },
  NOT_FOUND: { title: 'File tidak ditemukan atau Anda tidak berhak membukanya.', action: 'Bila menurut Anda ini keliru, hubungi admin unit.' },
  GATEWAY_NOT_CONFIGURED: { title: 'Jembatan Drive belum dipasang.', action: 'File belum bisa dibuka dari aplikasi. Hubungi Admin Pusat.' },
  NOT_CONFIGURED: { title: 'Layanan file belum dikonfigurasi.', action: 'Hubungi Admin Pusat.' },
  TICKET_EXPIRED: { title: 'Tautan file sudah kedaluwarsa.', action: 'Tekan tombolnya sekali lagi.' },
  UPSTREAM: { title: 'Google Drive sedang tidak dapat dihubungi.', action: 'Coba lagi beberapa saat lagi.' },
  NETWORK: { title: 'Tidak dapat terhubung ke server.', action: 'Periksa koneksi internet Anda, lalu coba lagi.' },
  POPUP_BLOCKED: { title: 'Browser memblokir tab baru.', action: 'Izinkan pop-up untuk situs ini, atau gunakan tombol Unduh.' },
  TOO_LARGE: { title: 'File lebih dari 20 MB, terlalu besar untuk dibagikan langsung.', action: 'Gunakan tombol Unduh, lalu kirim dari aplikasi file di HP Anda.' },
  SHARE_UNSUPPORTED: { title: 'Perangkat ini tidak mendukung berbagi file.', action: 'Gunakan tombol Unduh.' },
  UNKNOWN: { title: 'File tidak dapat dibuka.', action: 'Coba lagi. Bila berlanjut, laporkan ke admin unit.' },
};

export function fileError(code: string): FileAccessError {
  return new FileAccessError(code, MESSAGES[code] ?? MESSAGES.UNKNOWN!);
}

function codeForStatus(status: number, serverCode: string | undefined): string {
  if (serverCode && MESSAGES[serverCode]) return serverCode;
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 404 || status === 403) return 'NOT_FOUND';
  if (status === 410) return 'TICKET_EXPIRED';
  if (status === 503) return 'NOT_CONFIGURED';
  if (status === 502 || status === 504) return 'UPSTREAM';
  return 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// Mode lama (drive-url)
// ---------------------------------------------------------------------------
const ALLOWED_HOSTS = new Set(['drive.google.com', 'docs.google.com']);

/** Hanya URL https Google Drive/Docs (cegah javascript: dsb.). */
export function safeDriveUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ALLOWED_HOSTS.has(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
}

export function legacyDriveUrl(ref: FileRef): string | null {
  const stored = safeDriveUrl(ref.driveFileUrl);
  if (stored) return stored;
  if (ref.driveFileId && /^[A-Za-z0-9_-]+$/.test(ref.driveFileId)) return `https://drive.google.com/file/d/${ref.driveFileId}/view`;
  return null;
}

// ---------------------------------------------------------------------------
// Jembatan
// ---------------------------------------------------------------------------
export function hasFile(ref: FileRef): boolean {
  return FILE_ACCESS_MODE === 'drive-url' ? legacyDriveUrl(ref) !== null : Boolean(ref.driveFileId && /^[A-Za-z0-9_-]{1,200}$/.test(ref.driveFileId));
}

export interface Ticket {
  url: string;
  expiresAt: number;
  fileName: string;
  mime: string;
  size: number | null;
}

export async function requestTicket(ref: FileRef, disposition: Disposition, getToken: GetAccessToken, fetchFn: typeof fetch = fetch): Promise<Ticket> {
  if (!ref.driveFileId) throw fileError('NO_FILE');
  const token = await getToken();
  if (!token) throw fileError('UNAUTHENTICATED');
  let res: Response;
  try {
    res = await fetchFn('/api/files/ticket', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ driveFileId: ref.driveFileId, disposition }),
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch {
    throw fileError('NETWORK');
  }
  let data: { ok?: boolean; code?: string; url?: string; expiresAt?: number; fileName?: string; mime?: string; size?: number | null } | null = null;
  try {
    data = (await res.json()) as typeof data;
  } catch {
    data = null;
  }
  if (!res.ok || !data?.ok || typeof data.url !== 'string' || !data.url.startsWith('/api/files/download?')) {
    throw fileError(codeForStatus(res.status, data?.code));
  }
  return { url: data.url, expiresAt: data.expiresAt ?? 0, fileName: data.fileName ?? 'berkas.pdf', mime: data.mime ?? 'application/pdf', size: data.size ?? null };
}

/**
 * Buka file di tab baru. Tab dibuka SEBELUM menunggu tiket (aturan pemblokir
 * pop-up di HP), lalu diarahkan ke URL unduhan.
 */
export async function openFile(ref: FileRef, getToken: GetAccessToken, fetchFn: typeof fetch = fetch): Promise<void> {
  if (FILE_ACCESS_MODE === 'drive-url') {
    const url = legacyDriveUrl(ref);
    if (!url) throw fileError('NO_FILE');
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  if (!ref.driveFileId) throw fileError('NO_FILE');
  const win = window.open('', '_blank');
  if (!win) throw fileError('POPUP_BLOCKED');
  try {
    win.opener = null;
  } catch {
    // diabaikan
  }
  try {
    const ticket = await requestTicket(ref, 'inline', getToken, fetchFn);
    win.location.replace(new URL(ticket.url, window.location.origin).toString());
  } catch (error) {
    win.close();
    throw error;
  }
}

/** Unduh sebagai lampiran (tetap di halaman ini). */
export async function downloadFile(ref: FileRef, getToken: GetAccessToken, fetchFn: typeof fetch = fetch): Promise<void> {
  if (FILE_ACCESS_MODE === 'drive-url') {
    const url = legacyDriveUrl(ref);
    if (!url) throw fileError('NO_FILE');
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  const ticket = await requestTicket(ref, 'attachment', getToken, fetchFn);
  const a = document.createElement('a');
  a.href = ticket.url;
  a.download = ticket.fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Web Share API dengan file (Android Chrome, iOS Safari). */
export function canShareFiles(): boolean {
  if (FILE_ACCESS_MODE !== 'bridge') return false;
  try {
    if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function' || typeof File === 'undefined') return false;
    return navigator.canShare({ files: [new File([''], 'cek.pdf', { type: 'application/pdf' })] });
  } catch {
    return false;
  }
}

/**
 * Tombol "Bagikan berkas" tampil bila perangkat mendukung dan ukuran
 * diketahui ≤ 20 MB. Ukuran yang belum tercatat (data impor lama) tetap
 * diizinkan; batas 20 MB lalu ditegakkan saat mengambil file.
 */
export function shareEligible(ref: FileRef): boolean {
  if (!hasFile(ref) || !canShareFiles()) return false;
  return ref.sizeBytes === null || ref.sizeBytes === undefined || ref.sizeBytes <= SHARE_MAX_BYTES;
}

/** Ambil file (≤ 20 MB) sebagai File untuk dibagikan. */
export async function prepareShareFile(ref: FileRef, getToken: GetAccessToken, fetchFn: typeof fetch = fetch): Promise<File> {
  if (ref.sizeBytes && ref.sizeBytes > SHARE_MAX_BYTES) throw fileError('TOO_LARGE');
  const ticket = await requestTicket(ref, 'attachment', getToken, fetchFn);
  if (ticket.size && ticket.size > SHARE_MAX_BYTES) throw fileError('TOO_LARGE');
  const ctrl = new AbortController();
  let res: Response;
  try {
    res = await fetchFn(ticket.url, { signal: ctrl.signal, credentials: 'omit', cache: 'no-store' });
  } catch {
    throw fileError('NETWORK');
  }
  if (!res.ok) {
    throw fileError(codeForStatus(res.status, res.headers.get('X-Error-Code') ?? undefined));
  }
  const declared = Number(res.headers.get('Content-Length') ?? 'NaN');
  if (Number.isFinite(declared) && declared > SHARE_MAX_BYTES) {
    ctrl.abort();
    throw fileError('TOO_LARGE');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > SHARE_MAX_BYTES) {
        await reader.cancel();
        throw fileError('TOO_LARGE');
      }
      chunks.push(value);
    }
  }
  const type = ticket.mime || 'application/pdf';
  return new File(chunks as BlobPart[], ticket.fileName, { type });
}

export type ShareFileOutcome = 'shared' | 'cancelled' | 'needs-gesture';

/** navigator.share dengan file. 'needs-gesture' = minta pengguna menekan sekali lagi. */
export async function shareFile(file: File, title: string): Promise<ShareFileOutcome> {
  if (typeof navigator.share !== 'function') throw fileError('SHARE_UNSUPPORTED');
  try {
    await navigator.share({ files: [file], title });
    return 'shared';
  } catch (error) {
    const name = (error as { name?: string })?.name;
    if (name === 'AbortError') return 'cancelled';
    if (name === 'NotAllowedError') return 'needs-gesture';
    throw fileError('SHARE_UNSUPPORTED');
  }
}
