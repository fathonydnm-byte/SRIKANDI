/*
 * Sprint 3 (perubahan, koreksi & pembatalan, karantina) — RPC sesuai
 * v4/supabase/API_S3.md. Tulis lewat callWrite (selalu p_request_id; idempoten),
 * baca lewat callRead.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { callRead, callWrite } from './api';
import type { Condition, DevelopmentLevel, DriveTask, Security } from './s2api';

export interface EditItem {
  id: string;
  number: number | null;
  description: string;
  document_date: string | null;
  page_count: number | null;
  development_level: DevelopmentLevel | null;
  condition: Condition | null;
  security_classification: Security | null;
  primary_letter_number: string | null;
  alternate_letter_number: string | null;
  file_name: string | null;
  file_url: string | null;
  has_file: boolean;
  file_status: string | null;
  loan_status: string | null;
  can_edit: boolean;
  version: number;
  label: string;
}

export interface EditBerkas {
  id: string;
  number: number | null;
  title: string;
  classification_code: string | null;
  classification_description: string | null;
  security_classification: Security | null;
  loan_status: string | null;
  can_edit: boolean;
  label: string;
  items: EditItem[];
}

export interface EditOptions {
  ok: boolean;
  unit_id: string;
  berkas: EditBerkas[];
  development_levels: DevelopmentLevel[];
  conditions: Condition[];
  security_classifications: Security[];
  min_reason_length: number;
  replacement_max_bytes: number;
}

export interface ItemEditPayload {
  berkas_id: string;
  description: string;
  page_count: number;
  document_date: string;
  development_level: DevelopmentLevel;
  condition: '' | Condition;
  security_classification: Security;
}

export type ChangedField = 'description' | 'page_count' | 'document_date' | 'development_level' | 'condition' | 'security_classification' | 'pdf';

export interface ItemValidateResult {
  ok: boolean;
  valid: boolean;
  item_id: string;
  berkas_id: string;
  changed_fields: ChangedField[];
  has_file: boolean;
}

export interface ItemUpdateResult {
  ok: boolean;
  request_id: string;
  item_id: string;
  berkas_id: string;
  berkas_number: number | null;
  item_number: number | null;
  changed_fields: ChangedField[];
  file_replaced: boolean;
  drive_file_id: string | null;
  old_drive_file_id: string | null;
  quarantine_id: string | null;
  security_classification: Security;
  berkas_security_classification: Security;
  renumbered_item_count: number;
  renumbered_berkas_count: number;
  drive_tasks: DriveTask[];
  warnings: string[];
  message: string;
  replayed: boolean;
}

export interface TitleUpdateResult {
  ok: boolean;
  request_id: string;
  berkas_id: string;
  berkas_number: number | null;
  old_title: string;
  title: string;
  drive_tasks: DriveTask[];
  warnings: string[];
  message: string;
  replayed: boolean;
}

export interface CancelItem {
  id: string;
  number: number | null;
  description: string;
  document_date: string | null;
  page_count: number | null;
  loan_status: string | null;
  has_file: boolean;
  from_receipt: boolean;
  receipt_number: string | null;
  is_last_item: boolean;
  can_cancel: boolean;
  label: string;
}

export interface CancelBerkas {
  id: string;
  number: number | null;
  title: string;
  item_count: number;
  page_count: number;
  loan_status: string | null;
  can_cancel: boolean;
  label: string;
  items: CancelItem[];
}

export type CancelScope = 'ITEM' | 'BERKAS';

export interface CancelOptions {
  ok: boolean;
  unit_id: string;
  berkas: CancelBerkas[];
  scopes: CancelScope[];
  confirmation_word: string;
  min_reason_length: number;
  evidence: { optional: boolean; max_bytes: number; extensions: string[]; mime_types: string[] };
}

export interface CancelValidateResult {
  ok: boolean;
  valid: boolean;
  scope: CancelScope;
  berkas_id: string;
  item_id: string | null;
  item_count: number;
}

export interface CancelResult {
  ok: boolean;
  request_id: string;
  cancellation_id: string;
  scope: CancelScope;
  berkas_id: string;
  item_id: string | null;
  cancelled_item_ids: string[];
  cancelled_item_count: number;
  released_receipt_item_ids: string[];
  quarantine_ids: string[];
  evidence_file_id: string | null;
  renumbered_item_count: number;
  renumbered_berkas_count: number;
  drive_tasks: DriveTask[];
  warnings: string[];
  message: string;
  replayed: boolean;
}

export interface QuarantineRow {
  id: string;
  occurred_at: string | null;
  user_email: string | null;
  object_type: 'FILE' | 'FOLDER' | string;
  object_id: string | null;
  original_name: string | null;
  original_url: string | null;
  module: string | null;
  reason: string | null;
  status: string | null;
  notes: string | null;
  related_object_type: string | null;
  related_object_id: string | null;
  berkas_id: string | null;
  pembatalan_id: string | null;
  request_id: string | null;
  app_owned: boolean;
  moved_in_drive: boolean;
  quarantine_url: string | null;
  downloadable: boolean;
}

export interface QuarantineList {
  ok: boolean;
  unit_id: string;
  total: number;
  items: QuarantineRow[];
}

const unit = (unitId: string | null) => ({ p_unit_id: unitId });

export const s3 = {
  editOptions: (c: SupabaseClient, unitId: string | null) => callRead<EditOptions>(c, 'edit_options', unit(unitId)),
  itemValidate: (c: SupabaseClient, itemId: string, payload: ItemEditPayload, reason: string) =>
    callWrite<ItemValidateResult>(c, 'item_update', { p_item_id: itemId, p_payload: payload, p_reason: reason, p_replacement_session_id: null, p_validate_only: true }),
  itemUpdate: (c: SupabaseClient, requestId: string, itemId: string, payload: ItemEditPayload, reason: string, replacementSessionId: string | null) =>
    callWrite<ItemUpdateResult>(
      c, 'item_update',
      { p_item_id: itemId, p_payload: payload, p_reason: reason, p_replacement_session_id: replacementSessionId, p_validate_only: false },
      requestId,
    ),
  berkasUpdateTitle: (c: SupabaseClient, requestId: string, berkasId: string, title: string, reason: string) =>
    callWrite<TitleUpdateResult>(c, 'berkas_update_title', { p_berkas_id: berkasId, p_title: title, p_reason: reason }, requestId),
  cancelOptions: (c: SupabaseClient, unitId: string | null) => callRead<CancelOptions>(c, 'cancel_options', unit(unitId)),
  cancelValidate: (c: SupabaseClient, scope: CancelScope, berkasId: string, itemId: string | null, reason: string, confirmation: string) =>
    callWrite<CancelValidateResult>(c, 'archive_cancel', {
      p_scope: scope, p_berkas_id: berkasId, p_item_id: itemId, p_reason: reason, p_confirmation: confirmation, p_evidence_session_id: null, p_validate_only: true,
    }),
  archiveCancel: (c: SupabaseClient, requestId: string, scope: CancelScope, berkasId: string, itemId: string | null, reason: string, confirmation: string, evidenceSessionId: string | null) =>
    callWrite<CancelResult>(
      c, 'archive_cancel',
      { p_scope: scope, p_berkas_id: berkasId, p_item_id: itemId, p_reason: reason, p_confirmation: confirmation, p_evidence_session_id: evidenceSessionId, p_validate_only: false },
      requestId,
    ),
  quarantineList: (c: SupabaseClient, unitId: string | null, limit = 200) => callRead<QuarantineList>(c, 'quarantine_list', { ...unit(unitId), p_limit: limit }),
};

/** Buang sesi unggah yang sudah tersimpan tetapi tidak jadi dipakai (gateway menghapus file Drive-nya). */
export function cancelUploadSession(getToken: () => Promise<string | null>, sessionId: string): void {
  void getToken().then((token) => {
    if (!token) return;
    return fetch('/api/files/upload-cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ sessionId }),
    }).catch(() => null);
  });
}
