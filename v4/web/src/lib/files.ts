/*
 * SATU-SATUNYA jalur membuka file arsip (PDF item, folder berkas).
 *
 * Sprint 1: membuka URL Google Drive yang tersimpan di tab baru. Pengguna
 * butuh akses Drive ke folder instansi. Jembatan unduh aman (cek hak akses +
 * audit di server) akan mengganti ISI modul ini tanpa mengubah pemanggilnya.
 */

export interface FileRef {
  driveFileId: string | null;
  driveFileUrl: string | null;
}

export const FILE_ACCESS_NOTE =
  'Untuk sementara file dibuka langsung di Google Drive, jadi akun Google Anda perlu punya akses ke folder arsip unit. Bila muncul "Minta akses", hubungi admin unit.';

const ALLOWED_HOSTS = new Set(['drive.google.com', 'docs.google.com']);

/** Hanya URL https Google Drive/Docs yang boleh dibuka (cegah javascript: dsb.). */
export function safeDriveUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ALLOWED_HOSTS.has(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
}

export function fileUrl(ref: FileRef): string | null {
  const stored = safeDriveUrl(ref.driveFileUrl);
  if (stored) return stored;
  if (ref.driveFileId && /^[A-Za-z0-9_-]+$/.test(ref.driveFileId)) {
    return `https://drive.google.com/file/d/${ref.driveFileId}/view`;
  }
  return null;
}

export function hasFile(ref: FileRef): boolean {
  return fileUrl(ref) !== null;
}

export type OpenResult = { ok: true } | { ok: false; message: string };

function openInNewTab(url: string): OpenResult {
  const win = window.open(url, '_blank', 'noopener,noreferrer');
  // Dengan noopener sebagian browser mengembalikan null walau tab terbuka;
  // jadi null tidak dianggap gagal.
  void win;
  return { ok: true };
}

export function openFile(ref: FileRef): OpenResult {
  const url = fileUrl(ref);
  if (!url) return { ok: false, message: 'PDF belum diunggah untuk arsip ini.' };
  return openInNewTab(url);
}

export function openFolder(folderUrl: string | null | undefined): OpenResult {
  const url = safeDriveUrl(folderUrl);
  if (!url) return { ok: false, message: 'Folder Drive berkas ini belum tercatat.' };
  return openInNewTab(url);
}
