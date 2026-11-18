import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { JraLookup } from './JraLookup';
import { AuthProvider } from '../../auth/AuthContext';
import { createFakeClient, makeProfile, makeSession } from '../../test/fakeSupabase';
import { JRA_SOURCE_URL } from '../../lib/jra';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function setup() {
  const fake = createFakeClient({ session: makeSession(), profile: makeProfile('PETUGAS') });
  render(<AuthProvider client={fake.client}><form onSubmit={(e) => { e.preventDefault(); throw new Error('JRA must not submit archive'); }}><JraLookup /></form></AuthProvider>);
}
const result = {
  query: 'rektor', results: [{ row: 100, section: 'Fasilitatif', number: '2', description: 'Keputusan Rektor <img src=x>',
    active: '1 tahun setelah tidak berlaku', inactive: '3 tahun', disposition: 'Permanen', mergedRetention: '',
    sourceUrl: JRA_SOURCE_URL + '&range=A100:I100' }],
  total: 1, nextOffset: null, snapshot: 'a'.repeat(64), checkedAt: '2026-11-18T02:00:00Z',
};

it('Enter searches without submitting the registration form; text stays literal and does not change retention fields', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetch);
  setup();
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Kata kunci JRA'), 'rektor{Enter}');
  expect(await screen.findByText('Keputusan Rektor <img src=x>')).toBeVisible();
  const region = screen.getByRole('region', { name: 'Cek Jadwal Retensi Arsip (JRA)' });
  expect(region.querySelector('img')).toBeNull();
  expect(screen.getByText('1 tahun setelah tidak berlaku')).toBeVisible();
  expect(within(region).getByRole('link', { name: 'Lihat baris sumber 100' })).toHaveAttribute('href', JRA_SOURCE_URL + '&range=A100:I100');
  expect(fetch).toHaveBeenCalledTimes(1);
  const args = fetch.mock.calls[0]!;
  expect(args[0]).toBe('/api/jra/search');
  expect(JSON.parse(args[1].body)).toEqual({ query: 'rektor', offset: 0, snapshot: '' });
});

it('shows an ongoing status and can cancel a pending search before changing keywords', async () => {
  const fetch = vi.fn((_input, init) => new Promise<Response>((_, reject) => init.signal.addEventListener('abort',
    () => reject(new DOMException('Abort', 'AbortError')))));
  vi.stubGlobal('fetch', fetch);
  setup();
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Kata kunci JRA'), 'rektor');
  await user.click(screen.getByRole('button', { name: 'Cari JRA' }));
  expect(screen.getByRole('status')).toHaveTextContent('Mencari pada sumber JRA');
  await user.click(screen.getByRole('button', { name: 'Batalkan pencarian' }));
  expect(screen.getByRole('button', { name: 'Cari JRA' })).toBeEnabled();
  expect(screen.getByRole('status')).not.toHaveTextContent('Mencari pada sumber JRA');
});
