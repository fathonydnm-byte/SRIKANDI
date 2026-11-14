/*
 * Sprint 3 (Cetak Lidah Folder) — RPC dari 0016_s3_lidah_folder.sql.
 * folder_label_options: baca (RLS); folder_label_print: tulis idempoten (callWrite).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRead, callWrite } from './api';

export type PrintStatus = 'BELUM_DICETAK' | 'SUDAH_DICETAK' | 'PERLU_CETAK_ULANG';

export interface LastPrint {
  id: string;
  printed_at: string;
  printed_by: string;
  batch_id: string;
  start_slot: number | null;
  file_name: string;
  number: string;
  classification_code: string;
  title: string;
}

export interface LabelBerkas {
  id: string;
  number: string;
  classification_code: string;
  title: string;
  location: string;
  folder_url: string;
  print_status: PrintStatus;
  print_status_label: string;
  needs_reprint: boolean;
  last_printed_at: string | null;
  last_print: LastPrint | null;
}

export interface LabelOptions {
  unit_id: string;
  berkas: LabelBerkas[];
  total: number;
  status_counts: Record<PrintStatus, number>;
  layout: { paper: string; columns: number; rows: number; labels_per_page: number; label_width_mm: number; label_height_mm: number };
}

export interface PrintedLabel {
  berkas_id: string;
  number: string;
  classification_code: string;
  title: string;
  location: string;
}

export interface LabelPrintResult {
  ok: boolean;
  batch_id: string;
  printed_at: string;
  file_name: string;
  start_slot: number;
  label_count: number;
  page_count: number;
  labels: PrintedLabel[];
  message: string;
  replayed?: boolean;
}

export const lidah = {
  options: (c: SupabaseClient, unitId: string | null) => callRead<LabelOptions>(c, 'folder_label_options', { p_unit_id: unitId }),
  print: (c: SupabaseClient, requestId: string, berkasIds: string[], startSlot: number, fileName: string | null, unitId: string | null) =>
    callWrite<LabelPrintResult>(c, 'folder_label_print',
      { p_berkas_ids: berkasIds, p_start_slot: startSlot, p_file_name: fileName, p_unit_id: unitId }, requestId),
};
