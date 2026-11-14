/*
 * Sprint 2 (registrasi) — RPC sesuai v4/supabase/API_S2.md. Tulis lewat
 * callWrite (selalu p_request_id; idempoten), baca lewat callRead.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRead, callWrite } from './api';

export type DevelopmentLevel = 'ASLI' | 'COPY';
export type Condition = 'BAIK' | 'RUSAK RINGAN' | 'RUSAK SEDANG' | 'RUSAK BERAT';
export type Security = 'BIASA/TERBUKA' | 'TERBATAS' | 'RAHASIA' | 'SANGAT RAHASIA';

export interface Employee {
  id: string;
  name: string;
  unit: string;
  label: string;
}

export interface ReceiptItem {
  id: string;
  archive_id: string;
  number: number;
  description: string;
  page_count: number;
  development_level: DevelopmentLevel;
  condition: Condition;
  security_classification: Security;
  primary_letter_number: string | null;
  alternate_letter_number: string | null;
  document_date: string | null;
  notes: string | null;
  filing_status: string;
  filed_berkas_id: string | null;
  filed_item_id: string | null;
  filed_berkas_number: number | null;
  filed_item_number: number | null;
  metadata_complete: boolean;
  can_edit: boolean;
}

export interface Receipt {
  id: string;
  number: string;
  year: number;
  received_at: string;
  sender_employee_id: string | null;
  sender_name: string;
  sender_unit: string;
  receiver_name: string;
  receiver_unit: string;
  location: string | null;
  notes: string | null;
  item_count: number;
  total_pages: number;
  status: 'AKTIF' | 'DIBATALKAN';
  evidence_file_id: string | null;
  evidence_name: string | null;
  cancellation_reason: string | null;
  cancellation_evidence_file_id: string | null;
  cancelled_at: string | null;
  filed_count: number;
  pending_count: number;
  incomplete_count: number;
  print_count: number;
  can_edit_header: boolean;
  can_edit: boolean;
  can_complete_metadata: boolean;
  items: ReceiptItem[];
}

export interface ReceiptOptions {
  unit_id: string;
  employees: Employee[];
  receipts: Receipt[];
  defaults: { receiver_name: string | null; receiver_unit: string | null; location: string };
  development_levels: DevelopmentLevel[];
  conditions: Condition[];
  security_classifications: Security[];
  summary: { total: number; active: number; with_evidence: number; cancelled: number };
}

export interface ReceiptItemInput {
  receipt_item_id: string | null;
  archive_id: string | null;
  description: string;
  page_count: number;
  development_level: DevelopmentLevel;
  condition: Condition;
  security_classification: Security;
  primary_letter_number: string;
  alternate_letter_number: string;
  document_date: string;
  notes: string;
}

export interface ReceiptPayload {
  receipt_id: string | null;
  sender_employee_id: string;
  receiver_name: string;
  receiver_unit: string;
  notes: string;
  items: ReceiptItemInput[];
}

export interface ReceiptSaveResult {
  ok: boolean;
  receipt_id: string;
  number: string;
  is_update: boolean;
  item_count: number;
  total_pages: number;
  message: string;
  replayed?: boolean;
}

export interface PrintItem {
  number: number;
  description: string;
  page_count: number;
  development_level: string;
  condition: string;
}

export interface ReceiptPrint {
  ok: boolean;
  print_token: string;
  receipt_id: string;
  number: string;
  received_at: string;
  sender_name: string;
  sender_unit: string;
  receiver_name: string;
  receiver_unit: string;
  location: string | null;
  notes: string | null;
  status: 'AKTIF' | 'DIBATALKAN';
  cancellation_reason: string | null;
  cancelled_at: string | null;
  is_reprint: boolean;
  print_number: number;
  generated_at: string;
  file_name: string;
  items: PrintItem[];
}

export interface BerkasOption {
  id: string;
  number: number | null;
  title: string;
  classification_code: string | null;
  security_classification: string | null;
  label: string;
}

export interface Classification {
  id: string;
  parent_id: string | null;
  level: string | null;
  code: string;
  description: string | null;
  label: string;
  selectable: boolean;
}

export interface RegistrationOptions {
  unit_id: string;
  berkas: BerkasOption[];
  classifications: Classification[];
  retention_units: ('TAHUN' | 'BULAN')[];
  final_dispositions: string[];
  security_classifications: Security[];
  development_levels: DevelopmentLevel[];
  /** 0015: kategori CF-01 opsional (arsip vital / terjaga), bawaan false. */
  archive_categories?: ArchiveCategory[];
  /** 0015: nilai media berkas (hanya baca; diturunkan server dari item). */
  media_berkas_values?: string[];
  archive_creator?: { name: string; unit_name: string };
}

export interface ArchiveCategory {
  key: 'arsip_vital' | 'arsip_terjaga';
  label: string;
  default: boolean;
}

export interface QueueItem {
  id: string;
  archive_id: string;
  receipt_id: string;
  receipt_number: string;
  receipt_item_number: number;
  received_at: string;
  sender_name: string;
  sender_unit: string;
  primary_letter_number: string | null;
  alternate_letter_number: string | null;
  document_date: string | null;
  description: string;
  page_count: number;
  development_level: string;
  condition: string;
  security_classification: string;
  notes: string | null;
  status: string;
  selectable: boolean;
}

export interface FilingOptions {
  items: QueueItem[];
  total_queue: number;
  truncated: boolean;
  summary: { pending: number; incomplete: number; filed: number };
  max_batch_size: number;
}

export type BerkasTarget =
  | { mode: 'EXISTING'; berkas_id: string }
  | {
      mode: 'NEW';
      title: string;
      classification_id: string;
      active_retention_value: number;
      active_retention_unit: 'TAHUN' | 'BULAN';
      inactive_retention_value: number;
      inactive_retention_unit: 'TAHUN' | 'BULAN';
      final_disposition: string;
      filing_cabinet?: string;
      drawer?: string;
      notes?: string;
      arsip_vital?: boolean;
      arsip_terjaga?: boolean;
    };

export interface DriveTask {
  id: string;
  kind: string;
  drive_id: string;
  new_name: string;
}

export interface FilingResult {
  ok: boolean;
  berkas_id: string;
  berkas_number: number;
  berkas_title: string;
  item_count: number;
  total_pages: number;
  renumbered_item_count: number;
  renumbered_berkas_count: number;
  items: { receipt_item_id: string; item_id: string; berkas_number: number; item_number: number; description: string }[];
  drive_tasks: DriveTask[];
  message: string;
}

export interface ManualItemInput {
  primary_letter_number?: string;
  alternate_letter_number?: string;
  document_date: string;
  description: string;
  page_count: number;
  development_level: DevelopmentLevel;
  security_classification: Security;
  notes?: string;
}

export interface ManualResult {
  ok: boolean;
  item_id: string;
  berkas_id: string;
  berkas_number: number;
  item_number: number;
  file_status: string;
  renumbered_item_count: number;
  renumbered_berkas_count: number;
  drive_tasks: DriveTask[];
  message: string;
}

export interface MediaItem {
  id: string;
  number: number | null;
  description: string;
  document_date: string | null;
  page_count: number;
  file_status: string;
  planned_file_name: string;
  label: string;
}

export interface MediaOptions {
  ok: boolean;
  unit_id: string;
  berkas: { id: string; number: number | null; title: string; label: string; items: MediaItem[] }[];
  total_missing: number;
}

const unit = (unitId: string | null) => ({ p_unit_id: unitId });

export const s2 = {
  receiptOptions: (c: SupabaseClient, unitId: string | null) => callRead<ReceiptOptions>(c, 'receipt_options', unit(unitId)),
  pegawaiAdd: (c: SupabaseClient, requestId: string, name: string, unitKerja: string, unitId: string | null) =>
    callWrite<{ ok: boolean; employee: Employee; created: boolean; reactivated: boolean; message: string }>(
      c, 'pegawai_add', { p_name: name, p_unit_kerja: unitKerja, ...unit(unitId) }, requestId),
  receiptSave: (c: SupabaseClient, requestId: string, payload: ReceiptPayload, unitId: string | null) =>
    callWrite<ReceiptSaveResult>(c, 'receipt_save', { p_payload: payload, ...unit(unitId) }, requestId),
  receiptRecover: (c: SupabaseClient, requestId: string, unitId: string | null) =>
    callRead<{ ok: boolean; found: boolean; receipt_id: string | null; number: string | null; message: string }>(
      c, 'receipt_recover', { p_request_id: requestId, ...unit(unitId) }),
  receiptPrintPrepare: (c: SupabaseClient, receiptId: string) => callRead<ReceiptPrint>(c, 'receipt_print_prepare', { p_receipt_id: receiptId }),
  receiptPrintConfirm: (c: SupabaseClient, receiptId: string, token: string, fileName: string | null) =>
    callRead<{ ok: boolean; print_count: number }>(c, 'receipt_print_confirm', { p_receipt_id: receiptId, p_print_token: token, p_file_name: fileName }),
  receiptCancel: (c: SupabaseClient, requestId: string, receiptId: string, reason: string, confirmation: string, evidenceSessionId: string | null) =>
    callWrite<{ ok: boolean; receipt_id: string; evidence_file_id: string | null; message: string; already_cancelled?: boolean }>(
      c, 'receipt_cancel', { p_receipt_id: receiptId, p_reason: reason, p_confirmation: confirmation, p_evidence_session_id: evidenceSessionId }, requestId),
  /** Belum tercantum di API_S2.md; tanda tangan dari 0012_s2_pemberkasan.sql (3.x apiGetMediaOptions). */
  mediaOptions: (c: SupabaseClient, unitId: string | null) => callRead<MediaOptions>(c, 'media_options', unit(unitId)),
  registrationOptions: (c: SupabaseClient, unitId: string | null) => callRead<RegistrationOptions>(c, 'registration_options', unit(unitId)),
  filingOptions: (c: SupabaseClient, unitId: string | null) => callRead<FilingOptions>(c, 'filing_options', unit(unitId)),
  filingCommit: (c: SupabaseClient, requestId: string, ids: string[], target: BerkasTarget, unitId: string | null) =>
    callWrite<FilingResult>(c, 'filing_commit', { p_receipt_item_ids: ids, p_target: target, ...unit(unitId) }, requestId),
  itemCreateManual: (c: SupabaseClient, requestId: string, target: BerkasTarget, item: ManualItemInput, unitId: string | null) =>
    callWrite<ManualResult>(c, 'item_create_manual', { p_target: target, p_item: item, ...unit(unitId) }, requestId),
};

/** Jalankan tugas ganti nama Drive tanpa menunggu (kegagalan tidak memengaruhi data). */
export function runDriveTasks(getToken: () => Promise<string | null>, unitId: string | null): void {
  void getToken().then((token) => {
    if (!token) return;
    return fetch('/api/files/drive-tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(unitId ? { unitId } : {}),
    }).catch(() => null);
  });
}
