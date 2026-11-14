/*
 * Cadangan & Cermin (migrasi 0022): satu RPC baca, backup_status (SECURITY INVOKER; RLS backup_runs + units).
 * Halaman ini hanya-baca; pekerjaan malam ditulis oleh proyek Apps Script lewat /api/jobs/export, bukan dari browser.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRead } from './api';

export type BackupWarning = 'FAILED' | 'NEVER' | 'STALE' | null;

export interface BackupKindStatus {
  last_success_at: string | null;
  age_hours: number | null;
  last_done: { id: string; status: 'SUCCESS' | 'FAILED'; started_at: string; finished_at: string | null; error: string | null } | null;
  running: { id: string; started_at: string } | null;
  url: string | null;
  backup_file_id: string | null;
  stats: { total_rows?: number; drive_files?: number; tables?: Record<string, number> } | null;
  warning: BackupWarning;
}

export interface BackupUnitStatus {
  unit_id: string | null;
  unit_code: string;
  unit_name: string;
  active: boolean;
  /** null untuk baris "lintas unit" (hanya backup). */
  mirror: BackupKindStatus | null;
  backup: BackupKindStatus;
}

export interface BackupHistoryRow {
  id: string;
  kind: 'MIRROR' | 'BACKUP';
  unit_id: string | null;
  started_at: string;
  finished_at: string | null;
  status: 'RUNNING' | 'SUCCESS' | 'FAILED';
  error: string | null;
  total_rows: string | null;
}

export interface BackupStatus {
  now: string;
  stale_after_hours: number;
  units: BackupUnitStatus[];
  history: BackupHistoryRow[];
}

export const getBackupStatus = (client: SupabaseClient): Promise<BackupStatus> => callRead<BackupStatus>(client, 'backup_status', {});

const SHEET_URL = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]{10,100}([/?#][^\s]{0,250})?$/;
const DRIVE_ID = /^[A-Za-z0-9_-]{10,100}$/;

/** Tautan hanya dibuat dari nilai yang cocok dengan bentuk yang dikenal (data berasal dari kolom teks di database). */
export function sheetLink(url: string | null | undefined): string | null {
  return url && SHEET_URL.test(url) ? url : null;
}
export function driveFolderLink(id: string | null | undefined): string | null {
  return id && DRIVE_ID.test(id) ? `https://drive.google.com/drive/folders/${id}` : null;
}

export function formatAge(hours: number | null | undefined): string {
  if (hours === null || hours === undefined) return '–';
  if (hours < 1) return 'kurang dari 1 jam lalu';
  if (hours < 48) return `${Math.round(hours)} jam lalu`;
  return `${Math.floor(hours / 24)} hari lalu`;
}

export const WARNING_LABEL: Record<Exclude<BackupWarning, null>, string> = { FAILED: 'Gagal', NEVER: 'Belum pernah', STALE: 'Terlambat' };

export interface BackupSummary {
  failed: string[];
  stale: string[];
  never: string[];
  ok: number;
}

/** Ringkasan untuk spanduk peringatan: unit mana yang bermasalah (mirror atau backup). */
export function summarize(units: BackupUnitStatus[]): BackupSummary {
  const out: BackupSummary = { failed: [], stale: [], never: [], ok: 0 };
  for (const u of units) {
    const ws = [u.mirror?.warning ?? null, u.backup.warning];
    const label = u.unit_code;
    if (ws.includes('FAILED')) out.failed.push(label);
    else if (ws.includes('STALE')) out.stale.push(label);
    else if (ws.includes('NEVER')) out.never.push(label);
    else out.ok += 1;
  }
  return out;
}
