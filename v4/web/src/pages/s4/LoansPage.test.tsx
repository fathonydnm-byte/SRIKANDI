import { it, expect, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../../test/renderApp';
import { createFakeClient, makeProfile, makeSession, type RpcHandler } from '../../test/fakeSupabase';
import type { Loan, LoanBerkas } from '../../lib/loanApi';

const first: LoanBerkas = { id: 'A', number: 1, title: 'Surat rapat', pages: 4, status: 'TERSEDIA', items: [
  { id: 'I-A', number: 1, title: 'Notulen', pages: 4, status: 'TERSEDIA' },
] };
const second: LoanBerkas = { id: 'B', number: 2, title: 'Arsip kegiatan', pages: 2, status: 'TERSEDIA', items: [
  { id: 'I-B', number: 1, title: 'Undangan', pages: 2, status: 'TERSEDIA' },
] };
const fixture = {
  id: 'PIN-A', borrower_name: 'Peminjam Contoh', borrower_unit: 'Unit Uji', borrower_position: 'Staf',
  officer_name: 'Petugas Uji', purpose: 'Uji', borrowed_on: '2026-01-01', due_on: '2026-01-02',
  returned_on: null, borrow_condition: 'BAIK', return_condition: null, notes: null, page_count: 6, objects: [],
} satisfies Loan;

it('mencatat satu transaksi berisi berkas lengkap dan item dari berkas lain', async () => {
  const user = userEvent.setup();
  const save = vi.fn<RpcHandler>(() => ({ data: { id: 'PIN-A' }, error: null }));
  const fake = createFakeClient({ session: makeSession(), profile: makeProfile('PETUGAS'), rpc: {
    loan_list: () => ({ data: [], error: null }),
    loan_options: (a) => ({ data: a.p_berkas_id ? [first, second].filter((x) => x.id === a.p_berkas_id) : [first, second], error: null }),
    loan_create: save,
  } });
  renderApp('/peminjaman', fake.client);
  await user.click(await screen.findByRole('button', { name: 'Catat Peminjaman' }));
  await user.selectOptions(await screen.findByLabelText(/Pilih berkas/), 'A');
  await user.click(await screen.findByRole('button', { name: 'Tambah Berkas Lengkap' }));
  expect(screen.getByRole('button', { name: /Tambah item 1 — Notulen/ })).toBeDisabled();
  await user.selectOptions(screen.getByLabelText(/Pilih berkas/), 'B');
  await user.click(await screen.findByRole('button', { name: /Tambah item 1 — Undangan/ }));
  expect(screen.getByLabelText('Jumlah lembar')).toHaveValue(6);
  const form = within(screen.getByRole('region', { name: 'Formulir peminjaman' }));
  for (const [label, value] of [['Nama peminjam', 'Peminjam Contoh'], ['Jabatan peminjam', 'Staf'], ['Unit kerja peminjam', 'Unit Uji'],
    ['Jabatan petugas', 'Arsiparis'], ['Tanggal wajib kembali', '2027-12-31'], ['Keperluan', 'Rapat']] as const) {
    await user.type(form.getByLabelText(label), value);
  }
  await user.click(form.getByRole('button', { name: 'Simpan Peminjaman' }));
  expect(await screen.findByText('Peminjaman tersimpan.')).toBeInTheDocument();
  expect(save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    p_choices: [{ berkas_id: 'A', item_ids: [] }, { berkas_id: 'B', item_ids: ['I-B'] }],
    p_page_count: 6, p_request_id: expect.any(String),
  }), undefined);
});

it('mengembalikan seluruh transaksi melalui satu permintaan', async () => {
  const user = userEvent.setup();
  const returned = vi.fn<RpcHandler>(() => ({ data: { id: fixture.id }, error: null }));
  const fake = createFakeClient({ session: makeSession(), profile: makeProfile('PETUGAS'), rpc: {
    loan_list: () => ({ data: [fixture], error: null }), loan_return: returned,
  } });
  renderApp('/peminjaman', fake.client);
  await user.click(await screen.findByRole('button', { name: 'Catat Pengembalian' }));
  const form = within(screen.getByRole('region', { name: 'Formulir pengembalian' }));
  await user.type(form.getByLabelText('Jabatan petugas'), 'Arsiparis');
  await user.click(form.getByRole('button', { name: 'Simpan Pengembalian' }));
  expect(await screen.findByText('Seluruh arsip dalam transaksi sudah dikembalikan.')).toBeInTheDocument();
  expect(returned).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ p_loan_id: fixture.id }), undefined);
});
