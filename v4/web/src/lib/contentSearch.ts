import type { SupabaseClient } from '@supabase/supabase-js';
import { callRead } from './api';

export const CONTENT_PAGE_SIZE = 12;
export interface ScanContent {
  pages: (string | null)[];
  truncated: boolean;
}

/** Keep the payload small; preserve page ordinals and clip on code points. */
export function limitScanContent(pages: readonly (string | null)[]): ScanContent {
  let budget = 48_000;
  let truncated = false;
  const limited = pages.map((page) => {
    const text = (page ?? '').replace(/[\p{Cc}\p{Cs}\s]+/gu, ' ').trim();
    const chars = Array.from(text);
    const size = Math.min(chars.length, 8000, budget);
    truncated ||= size < chars.length;
    budget -= size;
    return size ? chars.slice(0, size).join('') : null;
  });
  return { pages: limited, truncated };
}

export interface ContentHit {
  item_id: string;
  berkas_id: string;
  page_no: number;
  no_item: number | null;
  no_berkas: number | null;
  title: string;
  description: string;
  unit_code: string;
  snippet: string;
}
export interface ContentSearchResult { results: ContentHit[]; has_more: boolean }

export function searchScanContent(client: SupabaseClient, query: string, unitId: string | null, phrase: boolean, offset: number) {
  return callRead<ContentSearchResult>(client, 'search_scan_content', {
    p_query: query, p_unit_id: unitId, p_phrase: phrase, p_limit: CONTENT_PAGE_SIZE, p_offset: offset,
  });
}

export function indexScanContent(client: SupabaseClient, sessionId: string, content: ScanContent) {
  return callRead<{ indexed_pages: number }>(client, 'index_scan_content', { p_session_id: sessionId, p_pages: content.pages });
}
