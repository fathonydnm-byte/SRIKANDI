import type { FetchFn, FileEnv } from './env';
import { json, jsonError } from './http';
import { bearer, callRpc } from './supabaseRpc';
import { JRA_GID, JRA_SOURCE_ID, JRA_SOURCE_URL, parseJraCsv, searchJraRows } from '../src/lib/jra';

const EXPORT = `https://docs.google.com/spreadsheets/d/${JRA_SOURCE_ID}/export?format=csv&gid=${JRA_GID}`;
const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 15000;

async function boundedText(response: Response, maxBytes = MAX_BYTES): Promise<string> {
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > maxBytes
    || /text\/html/i.test(response.headers.get('content-type') ?? '')) throw new Error('SOURCE');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '', size = 0, done = false;
  try {
    while (!done) {
      const read = await reader.read();
      done = read.done;
      if (read.value) {
        size += read.value.byteLength;
        if (size > maxBytes) throw new Error('SOURCE_SIZE');
        text += decoder.decode(read.value, { stream: true });
      }
    }
    return text + decoder.decode();
  } finally {
    if (!done) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Fixed, public JRA source only. JWT never goes to Google; no key or access change is needed. */
export async function handleJraLookup(request: Request, env: FileEnv, fetchFn: FetchFn): Promise<Response> {
  if (request.method !== 'POST') return jsonError('METHOD');
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return jsonError('NOT_CONFIGURED');
  const jwt = bearer(request);
  if (!jwt) return jsonError('UNAUTHENTICATED');
  if (Number(request.headers.get('content-length')) > 2048) return jsonError('BAD_REQUEST');
  let body: Record<string, unknown>;
  try {
    // Also cap streams without Content-Length.
    const input = await boundedText(new Response(request.body, { headers: { 'content-type': 'application/json' } }), 2048);
    if (input.length > 2048) return jsonError('BAD_REQUEST');
    const parsed: unknown = JSON.parse(input);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return jsonError('BAD_REQUEST');
    body = parsed as Record<string, unknown>;
  } catch { return jsonError('BAD_REQUEST'); }
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  const offset = body.offset ?? 0;
  const prior = body.snapshot ?? '';
  if (query.length < 2 || query.length > 120 || !/[\p{L}\p{N}]/u.test(query)
    || typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset > 10000 || offset % 10
    || typeof prior !== 'string' || (prior !== '' && !/^[a-f0-9]{64}$/.test(prior))
    || (offset > 0 && !prior) || Object.keys(body).some((k) => !['query', 'offset', 'snapshot'].includes(k))) {
    return jsonError('BAD_REQUEST', 'Masukkan kata kunci JRA 2–120 karakter, lalu tekan Cari JRA.');
  }
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const timedFetch: FetchFn = (url, init) => fetchFn(url, { ...init, signal: ctrl.signal });
  try {
    const auth = await callRpc<string>(env, jwt, 'my_account_status', {}, timedFetch);
    if (auth.error) return jsonError(auth.status === 401 || auth.status === 403 ? 'UNAUTHENTICATED' : 'UPSTREAM');
    if (auth.data !== 'ACTIVE') return jsonError('FORBIDDEN');
    const source = await timedFetch(EXPORT, {
      method: 'GET', headers: { Accept: 'text/csv' }, redirect: 'follow',
    });
    const rows = parseJraCsv(await boundedText(source));
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(rows)));
    const snapshot = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
    if (offset > 0 && prior !== snapshot) return jsonError('CONFLICT', 'Data JRA berubah. Tekan Cari JRA untuk memuat hasil terbaru.');
    const result = searchJraRows(rows, query, offset);
    return json({ query, ...result, snapshot, sourceUrl: JRA_SOURCE_URL, checkedAt: new Date().toISOString() });
  } catch {
    return jsonError('UPSTREAM', 'Sumber JRA belum dapat dibaca. Coba lagi atau buka spreadsheet rujukan.');
  } finally { clearTimeout(timeout); }
}
