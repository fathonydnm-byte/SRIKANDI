// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { handleJraLookup } from './jraLookup';
import { JRA_HEADERS, JRA_SOURCE_ID, parseJraCsv, searchJraRows } from '../src/lib/jra';
import type { FetchFn } from './env';

const env = { SUPABASE_URL: 'https://unit.supabase.co', SUPABASE_ANON_KEY: 'anon-key-test' };
const jwt = 'test-user-jwt-00000000000000';
const header = JRA_HEADERS.join(',');
const csv = header + '\nFasilitatif,2,"Keputusan Rektor\nBidang akademik","1 tahun setelah tidak berlaku",3 tahun,Permanen,,,\n';
const request = (body: unknown, auth = true) => new Request('https://example.test/api/jra/search', {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${jwt}` } : {}) },
  body: JSON.stringify(body),
});
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function source(text = csv, status = 'ACTIVE') {
  return vi.fn<FetchFn>(async (url) => url.includes('/rpc/my_account_status') ? ok(status)
    : new Response(text, { headers: { 'Content-Type': 'text/csv' } }));
}

it('parses quoted newlines, escaped quotes and BOM, and keeps original source row links', () => {
  const input = '\uFEFF' + header + '\r\nFasilitatif,1,"Keputusan ""Rektor""\nA",,,"Permanen, ditinjau",,,\r\n';
  const rows = parseJraCsv(input);
  const results = searchJraRows(rows, 'RÉKTOR permanen', 0);
  expect(results.total).toBe(1);
  expect(results.results[0]).toMatchObject({ active: '', description: 'Keputusan "Rektor"\nA', disposition: 'Permanen, ditinjau', row: 2 });
  expect(results.results[0]?.sourceUrl).toContain('range=A2:I2');
  expect(() => parseJraCsv(header + '\n"x')).toThrow();
  expect(() => parseJraCsv('Bad headers')).toThrow('SOURCE_HEADERS');
  expect(() => parseJraCsv(header + ',EXTRA\n,,,,,,,,,new data')).toThrow('SOURCE_HEADERS');
  expect(() => parseJraCsv('x'.repeat(2_000_001))).toThrow();
});

it('verifies active account first, never sends JWT or keyword to Google, and marks replies non-cacheable', async () => {
  const fetch = source();
  const response = await handleJraLookup(request({ query: 'rektor', offset: 0 }), env, fetch);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = await response.json();
  expect(body).toMatchObject({ total: 1, nextOffset: null, results: [{ active: '1 tahun setelah tidak berlaku', inactive: '3 tahun' }] });
  expect(body.snapshot).toMatch(/^[a-f0-9]{64}$/);
  expect(fetch.mock.calls[0]?.[0]).toContain('/rpc/my_account_status');
  const [url, init] = fetch.mock.calls[1]!;
  expect(url).toBe(`https://docs.google.com/spreadsheets/d/${JRA_SOURCE_ID}/export?format=csv&gid=917043056`);
  expect(init?.headers).toEqual({ Accept: 'text/csv' });
  expect(init?.body).toBeUndefined();
  expect(url).not.toMatch(/rektor|test-user/);
});

it('rejects invalid requests and blocked users before reading Google', async () => {
  for (const body of [[], null, { query: 'r' }, { query: '..' }, { query: 'x'.repeat(121) }, { query: 'rektor', offset: -1 },
    { query: 'rektor', offset: 10 }, { query: 'rektor', sourceUrl: 'https://evil.test' }]) {
    const fetch = source();
    expect((await handleJraLookup(request(body), env, fetch)).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  }
  const missing = source();
  expect((await handleJraLookup(request({ query: 'rektor' }, false), env, missing)).status).toBe(401);
  expect(missing).not.toHaveBeenCalled();
  for (const status of ['INACTIVE', 'NO_PROFILE', 'UNIT_INACTIVE']) {
    const fetch = source(csv, status);
    expect((await handleJraLookup(request({ query: 'rektor' }), env, fetch)).status).toBe(403);
    expect(fetch).toHaveBeenCalledTimes(1);
  }
});

it('detects source changes between pages rather than repeating or silently skipping records', async () => {
  const many = header + '\n' + Array.from({ length: 13 }, (_, i) => `Fasilitatif,${i},Keputusan Rektor,1 tahun,3 tahun,Permanen,,,`).join('\n');
  const first = await (await handleJraLookup(request({ query: 'rektor' }), env, source(many))).json();
  expect(first.results).toHaveLength(10);
  const next = await handleJraLookup(request({ query: 'rektor', offset: 10, snapshot: first.snapshot }), env, source(many));
  const data = await next.json();
  expect(data.results).toHaveLength(3);
  expect(data.results[0].row).toBe(12);
  expect(data.nextOffset).toBeNull();
  const changed = await handleJraLookup(request({ query: 'rektor', offset: 10, snapshot: first.snapshot }), env, source(many + '\nFasilitatif,14,Rektor,2,2,Permanen,,,'));
  expect(changed.status).toBe(409);
});

it('source HTML, oversized stream or malformed data produces a safe, actionable response', async () => {
  for (const raw of ['<html>sign in with confidential data</html>', header + '\n' + 'x'.repeat(2_000_001), 'wrong header']) {
    const response = await handleJraLookup(request({ query: 'rektor' }), env, source(raw));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toMatch(/confidential|wrong header|sign in/);
  }
});
