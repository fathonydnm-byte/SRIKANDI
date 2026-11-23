import type { SupabaseClient } from '@supabase/supabase-js';
import { callRead, callWrite, type RetentionStatusCode } from './api';

export type RetentionFilter = 'H7' | 'HABIS';
export interface RetentionCandidate {
  berkas_id: string;
  no_berkas: number;
  judul_berkas: string;
  lokasi: string | null;
  kode_klasifikasi: string | null;
  kurun_waktu: string | null;
  item_count: number;
  batas_aktif: string;
  batas_inaktif: string | null;
  days_to_active_limit: number;
  usul_pindah_no: string | null;
  status_code: RetentionStatusCode;
  status_label: string;
  nasib_akhir: string | null;
  blocked_reason: string | null;
}
export interface TransferDraft {
  id: string;
  draft_number: string;
  title: string;
  notes: string | null;
  created_at: string;
  cancelled_at: string | null;
  cancel_reason: string | null;
  berkas_count: number;
  item_count: number;
}
export interface TransferDraftFolder {
  berkas_id: string;
  number: number;
  title: string;
  batas_aktif: string;
  location: string | null;
  item_count: number;
}
export interface TransferDraftCheck {
  eligible: boolean;
  issues: { berkas_id: string; number: number; reason: string }[];
}
export const transferApi = {
  candidates: (c: SupabaseClient, unit: string | null, filter: RetentionFilter, offset: number) =>
    callRead<RetentionCandidate[]>(c, 'retention_candidates', { p_unit_id: unit, p_filter: filter, p_offset: offset }),
  drafts: (c: SupabaseClient, unit: string | null, offset: number) =>
    callRead<TransferDraft[]>(c, 'transfer_drafts_list', { p_unit_id: unit, p_offset: offset }),
  get: (c: SupabaseClient, unit: string | null, id: string) =>
    callRead<TransferDraftFolder[]>(c, 'transfer_draft_get', { p_unit_id: unit, p_draft_id: id }),
  check: (c: SupabaseClient, unit: string | null, id: string) =>
    callRead<TransferDraftCheck>(c, 'transfer_draft_check', { p_unit_id: unit, p_draft_id: id }),
  create: (c: SupabaseClient, unit: string | null, ids: string[], title: string, notes: string, request: string) =>
    callWrite<{ id: string; draft_number: string }>(c, 'transfer_draft_create',
      { p_unit_id: unit, p_berkas_ids: ids, p_title: title, p_notes: notes }, request),
  cancel: (c: SupabaseClient, unit: string | null, id: string, reason: string, request: string) =>
    callWrite<{ id: string }>(c, 'transfer_draft_cancel',
      { p_unit_id: unit, p_draft_id: id, p_reason: reason }, request),
};
