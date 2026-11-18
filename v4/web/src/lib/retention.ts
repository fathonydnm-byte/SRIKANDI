import type { SupabaseClient } from '@supabase/supabase-js';
import { callRead, callWrite } from './api';

export const RETENTION_UNITS = ['TAHUN', 'BULAN'] as const;
export const RETENTION_DISPOSITIONS = ['MUSNAH', 'PERMANEN', 'DINILAI KEMBALI'] as const;
export type RetentionUnit = (typeof RETENTION_UNITS)[number];
type RetentionMode = 'LEGACY' | 'MANUAL' | 'PENDING';

export interface RetentionDraft {
  retention_reference_date: string;
  retention_pending: boolean;
  active_retention_value: string;
  active_retention_unit: RetentionUnit;
  inactive_retention_value: string;
  inactive_retention_unit: RetentionUnit;
  final_disposition: string;
}
export interface RetentionPayload {
  retention_reference_date: string | null;
  active_retention_value: number;
  active_retention_unit: RetentionUnit;
  inactive_retention_value: number;
  inactive_retention_unit: RetentionUnit;
  final_disposition: string;
}
export interface RetentionDetails {
  reference_mode: RetentionMode;
  retention_reference_date: string | null;
  active_retention_value: number | null;
  active_retention_unit: RetentionUnit | null;
  inactive_retention_value: number | null;
  inactive_retention_unit: RetentionUnit | null;
  final_disposition: string | null;
  active_limit: string | null;
  inactive_limit: string | null;
  version: number;
  blocked_reason: string | null;
}

export function retentionDraft(d?: RetentionDetails): RetentionDraft {
  return {
    retention_reference_date: d?.reference_mode === 'MANUAL' ? (d.retention_reference_date ?? '') : '',
    retention_pending: d?.reference_mode === 'PENDING',
    active_retention_value: d?.active_retention_value?.toString() ?? '',
    active_retention_unit: d?.active_retention_unit ?? 'TAHUN',
    inactive_retention_value: d?.inactive_retention_value?.toString() ?? '',
    inactive_retention_unit: d?.inactive_retention_unit ?? 'TAHUN',
    final_disposition: d?.final_disposition ?? '',
  };
}

export function retentionErrors(d: RetentionDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!d.retention_pending && !/^\d{4}-\d{2}-\d{2}$/.test(d.retention_reference_date)) {
    errors.retention_reference_date = 'Pilih tanggal acuan atau tandai bahwa tanggal belum diketahui.';
  }
  if (!/^\d+$/.test(d.active_retention_value) || Number(d.active_retention_value) > 12000) errors.active_retention = 'Isi durasi aktif antara 0 dan 12.000.';
  if (!/^\d+$/.test(d.inactive_retention_value) || Number(d.inactive_retention_value) > 12000) errors.inactive_retention = 'Isi durasi inaktif antara 0 dan 12.000.';
  if (!RETENTION_DISPOSITIONS.some((option) => option === d.final_disposition)) errors.final_disposition = 'Pilih nasib akhir arsip.';
  return errors;
}

export function retentionPayload(d: RetentionDraft): RetentionPayload {
  return {
    retention_reference_date: d.retention_pending ? null : d.retention_reference_date,
    active_retention_value: Number(d.active_retention_value), active_retention_unit: d.active_retention_unit,
    inactive_retention_value: Number(d.inactive_retention_value), inactive_retention_unit: d.inactive_retention_unit,
    final_disposition: d.final_disposition,
  };
}

export const retentionApi = {
  get: (client: SupabaseClient, id: string) => callRead<RetentionDetails>(client, 'berkas_retention_get', { p_berkas_id: id }),
  update: (client: SupabaseClient, request: string, id: string, version: number, schedule: RetentionPayload, reason: string) =>
    callWrite<RetentionDetails>(client, 'berkas_retention_update', {
      p_berkas_id: id, p_expected_version: version, p_schedule: schedule, p_reason: reason,
    }, request),
};
