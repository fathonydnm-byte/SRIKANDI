import type { SupabaseClient } from '@supabase/supabase-js';
import { callRead, callWrite } from './api';

export interface LoanAsset {
  id: string;
  number: number | null;
  title: string | null;
  status: string;
  pages: number;
}
export interface LoanBerkas extends LoanAsset { items: LoanAsset[] }
export interface LoanObject {
  berkas_id: string;
  item_id: string | null;
  berkas_no: number;
  berkas_title: string;
  item_no: number | null;
  item_description: string | null;
  location: string;
  page_count: number;
}
export interface Loan {
  id: string;
  borrower_name: string;
  borrower_position: string;
  borrower_unit: string;
  officer_name: string;
  purpose: string;
  borrowed_on: string;
  due_on: string;
  returned_on: string | null;
  borrow_condition: string | null;
  return_condition: string | null;
  notes: string | null;
  page_count: number;
  objects: LoanObject[];
}
export interface LoanDocumentEvent {
  id: string;
  action: 'OUT_INDICATOR_OPEN' | 'LEGACY_OUT_INDICATOR' | 'LEGACY_BERITA_ACARA';
  occurred_at: string;
  actor_name: string | null;
  source_status: 'PDF_DIBUAT' | 'DOCS_DIBUAT' | 'DICETAK' | null;
}
export interface LoanChoice { berkas_id: string; item_ids: string[] }
export const loanApi = {
  openOutIndicator: (c: SupabaseClient, unit: string | null, loan: string, request: string) =>
    callWrite<{ id: string }>(c, 'loan_out_indicator_open', { p_unit_id: unit, p_loan_id: loan }, request),
  documentHistory: (c: SupabaseClient, unit: string | null, loan: string, offset: number) =>
    callRead<LoanDocumentEvent[]>(c, 'loan_document_history', { p_unit_id: unit, p_loan_id: loan, p_offset: offset }),
  options: (c: SupabaseClient, unit: string | null, query: string, parent: string | null) =>
    callRead<LoanBerkas[]>(c, 'loan_options', { p_unit_id: unit, p_query: query, p_berkas_id: parent }),
  list: (c: SupabaseClient, unit: string | null, status: 'ACTIVE' | 'RETURNED', offset: number) =>
    callRead<Loan[]>(c, 'loan_list', { p_unit_id: unit, p_status: status, p_offset: offset }),
  create: (c: SupabaseClient, unit: string | null, borrower: Record<string, string>, choices: LoanChoice[], body: Record<string, string | number>, request: string) =>
    callWrite<{ id: string }>(c, 'loan_create', { ...body, p_unit_id: unit, p_borrower: borrower, p_choices: choices }, request),
  return: (c: SupabaseClient, unit: string | null, loan: string, officer: Record<string, string>, body: Record<string, string>, request: string) =>
    callWrite<{ id: string }>(c, 'loan_return', { ...body, p_unit_id: unit, p_loan_id: loan, p_officer: officer }, request),
};
