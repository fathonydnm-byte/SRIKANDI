import { expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../../test/renderApp';
import { createFakeClient, makeProfile, makeSession, type RpcHandler } from '../../test/fakeSupabase';
import type { RetentionCandidate, TransferDraft } from '../../lib/transferApi';

const ready: RetentionCandidate = {
  berkas_id: 'B1', no_berkas: 1, judul_berkas: 'Rapat koordinasi', lokasi: 'Rak 2', kode_klasifikasi: 'KU.01',
  kurun_waktu: '2024', item_count: 2, batas_aktif: '2025-08-15', batas_inaktif: '2028-08-15',
  days_to_active_limit: -8, usul_pindah_no: null, status_code: 'EXPIRED', status_label: 'Habis Aktif',
  nasib_akhir: 'PERMANEN', blocked_reason: null,
};
const blocked: RetentionCandidate = { ...ready, berkas_id: 'B2', no_berkas: 2, judul_berkas: 'Berkas dipinjam',
  blocked_reason: 'Berkas atau salah satu item sedang dipinjam.' };
const due: RetentionCandidate = { ...ready, berkas_id: 'B3', no_berkas: 3, judul_berkas: 'Berkas H-7',
  days_to_active_limit: 7, status_code: 'DUE', status_label: 'H-7', blocked_reason: 'Masa retensi aktif belum berakhir.' };

it('opens H-7 and lets an operator create, check and cancel a local draft', async () => {
  let draft: TransferDraft | null = null;
  const create = vi.fn<RpcHandler>((args) => {
    draft = { id: 'USP-X', draft_number: 'DRAF-2026-0001', title: String(args?.p_title), notes: null,
      berkas_count: 1, item_count: 2, created_at: '2026-11-17T02:00:00Z', cancelled_at: null, cancel_reason: null };
    return { data: { id: draft.id, draft_number: draft.draft_number }, error: null };
  });
  const cancel = vi.fn<RpcHandler>((args) => {
    if (!draft) throw new Error('No test draft');
    draft = { ...draft, cancelled_at: '2026-11-17T02:01:00Z', cancel_reason: String(args?.p_reason) };
    return { data: { id: draft.id }, error: null };
  });
  const check = vi.fn<RpcHandler>()
    .mockReturnValueOnce({ data: { eligible: false, issues: [{ berkas_id: 'B1', number: 1, reason: 'Berkas sedang dipinjam.' }] }, error: null })
    .mockReturnValueOnce({ data: { eligible: true, issues: [] }, error: null });
  const fake = createFakeClient({ session: makeSession(), profile: makeProfile('PETUGAS'), rpc: {
    retention_candidates: (args) => ({ data: args?.p_filter === 'H7' ? [due] : [ready, blocked], error: null }),
    transfer_draft_create: create,
    transfer_drafts_list: () => ({ data: draft ? [draft] : [], error: null }),
    transfer_draft_get: () => ({ data: [{ berkas_id: ready.berkas_id, number: 1, title: ready.judul_berkas, item_count: 2,
      batas_aktif: ready.batas_aktif, location: ready.lokasi }], error: null }),
    transfer_draft_cancel: cancel,
    transfer_draft_check: check,
  } });
  renderApp('/retensi?filter=h7', fake.client);
  const user = userEvent.setup();
  expect(await screen.findByRole('link', { name: /3 — Berkas H-7/ })).toBeVisible();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Habis Aktif' }));
  expect(await screen.findByText(blocked.blocked_reason!)).toBeVisible();
  expect(screen.queryByRole('checkbox', { name: /Berkas dipinjam/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole('checkbox', { name: /Rapat koordinasi/ }));
  const form = screen.getByRole('form', { name: 'Draf Usul Pemindahan' });
  await user.clear(within(form).getByLabelText('Judul usul'));
  await user.type(within(form).getByLabelText('Judul usul'), 'Draf Februari');
  await user.click(within(form).getByRole('button', { name: 'Simpan Draf' }));
  expect(await screen.findByText('Draf DRAF-2026-0001 tersimpan.')).toBeVisible();
  expect(create.mock.calls[0]?.[0]).toMatchObject({ p_berkas_ids: ['B1'], p_title: 'Draf Februari' });
  await user.click(await screen.findByRole('button', { name: 'Lihat Rincian' }));
  expect(await screen.findByText(/Data berkas saat draf dibuat/)).toBeVisible();
  expect(await screen.findByText(/1 — Rapat koordinasi · 2 item/)).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Periksa Kelayakan' }));
  expect(await screen.findByText('Berkas 1: Berkas sedang dipinjam.')).toBeVisible();
  expect(check.mock.calls[0]?.[0]).toMatchObject({ p_draft_id: 'USP-X', p_unit_id: null });
  await user.click(screen.getByRole('button', { name: 'Periksa Ulang' }));
  expect(await screen.findByText(/Berkas lolos pemeriksaan/)).toBeVisible();
  expect(screen.queryByText('Berkas 1: Berkas sedang dipinjam.')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Batalkan Draf' }));
  await user.type(screen.getByLabelText(/Alasan pembatalan/), 'Perlu ditinjau ulang');
  await user.click(screen.getByRole('button', { name: 'Ya, Batalkan Draf' }));
  expect(await screen.findByText('Alasan pembatalan: Perlu ditinjau ulang')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Periksa Kelayakan' })).not.toBeInTheDocument();
  expect(cancel.mock.calls[0]?.[0]).toMatchObject({ p_draft_id: 'USP-X' });
});
