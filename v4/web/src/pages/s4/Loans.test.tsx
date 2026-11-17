import { afterEach, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../../test/renderApp';
import { createFakeClient, makeProfile, makeSession, type RpcHandler } from '../../test/fakeSupabase';
import type { Loan } from '../../lib/loanApi';

afterEach(() => vi.unstubAllGlobals());

it('prepares the Out Indicator once, opens printing from a user click, and shows document history', async () => {
  const loan: Loan = {
    id: 'LOAN-UJI', borrower_name: 'Peminjam Uji', borrower_unit: 'Unit Uji', borrower_position: 'Staf',
    officer_name: 'Petugas Uji', purpose: 'Uji', borrowed_on: '2026-01-01', due_on: '2026-01-03', returned_on: null,
    borrow_condition: 'BAIK', return_condition: null, notes: null, page_count: 2,
    objects: [{ berkas_id: 'B1', berkas_no: 1, berkas_title: 'Berkas Uji', item_id: null,
      item_no: null, item_description: null, location: 'Kabinet 1', page_count: 2 }],
  };
  const browserPrint = vi.fn();
  vi.stubGlobal('print', browserPrint);
  const prepare = vi.fn<RpcHandler>(() => ({ data: { id: loan.id }, error: null }));
  const fake = createFakeClient({ session: makeSession(), profile: makeProfile('PETUGAS'), rpc: {
    loan_list: () => ({ data: [loan], error: null }),
    loan_out_indicator_open: prepare,
    loan_document_history: () => ({ data: [
      { id: 'P1', action: 'OUT_INDICATOR_OPEN', occurred_at: '2026-01-01T09:00:00+07:00', actor_name: 'Petugas Uji' },
      { id: 'P2', action: 'LEGACY_BERITA_ACARA', occurred_at: '2026-01-01T09:00:00+07:00', source_status: 'DOCS_DIBUAT' },
    ], error: null }),
  } });
  renderApp('/peminjaman', fake.client);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Cetak Out Indicator A5' }));
  const dialog = await screen.findByRole('button', { name: 'Buka Dialog Cetak' });
  expect(browserPrint).not.toHaveBeenCalled();
  await user.click(dialog);
  expect(browserPrint).toHaveBeenCalledOnce();
  await user.click(screen.getByRole('button', { name: 'Tutup Cetak' }));
  expect(screen.getByRole('button', { name: 'Cetak Out Indicator A5' })).toBeEnabled();
  expect(prepare).toHaveBeenCalledOnce();
  await user.click(screen.getByRole('button', { name: 'Riwayat Dokumen' }));
  expect(await screen.findByText(/Out Indicator disiapkan untuk cetak/)).toBeVisible();
  expect(screen.getByText(/Berita Acara \(aplikasi lama\) · Google Docs dibuat/)).toBeVisible();
});
