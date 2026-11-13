import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../../test/renderApp';
import { createFakeClient, makeProfile, makeSession, type RpcResult } from '../../test/fakeSupabase';
import { makeHit } from '../../test/fixtures';
import type { Role } from '../../auth/permissions';

function setup(role: Role, search: (args: Record<string, unknown>, signal?: AbortSignal) => RpcResult | Promise<RpcResult>) {
  const handler = vi.fn(search);
  const fake = createFakeClient({ session: makeSession(), profile: makeProfile(role), rpc: { search_archive: handler } });
  return { fake, handler };
}
const ok = (results = [makeHit()], total = results.length): RpcResult => ({ data: { total, limit: 20, offset: 0, results }, error: null });
const loc = () => screen.getByTestId('location').textContent;

describe('Cari Arsip', () => {
  it('tanpa kata kunci: petunjuk, tidak ada permintaan', async () => {
    const { fake, handler } = setup('PETUGAS', () => ok());
    renderApp('/cari', fake.client);
    expect(await screen.findByRole('heading', { name: 'Cari lokasi arsip' })).toBeInTheDocument();
    expect(handler).not.toHaveBeenCalled();
  });

  it('query dari URL: memanggil RPC dan menampilkan lokasi dengan menonjol', async () => {
    const { fake, handler } = setup('PIMPINAN', () => ok());
    renderApp('/cari?q=laporan', fake.client);
    const card = await screen.findByRole('link', { name: /Berkas 50 \/ Item 1/ });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0]).toMatchObject({ p_query: 'laporan', p_development: 'ALL', p_file_status: 'ALL', p_limit: 20, p_offset: 0, p_include_deleted: false, p_unit_id: null });
    expect(within(card).getByRole('group', { name: 'Lokasi: Kabinet 7 · Laci 3 · Folder 12' })).toBeInTheDocument();
    expect(card).toHaveAttribute('href', '/cari/item/ITM-1');
    expect(screen.getByRole('searchbox', { name: 'Kata kunci pencarian' })).toHaveValue('laporan');
    expect(screen.getByText('1 arsip ditemukan', { selector: '.result-summary' })).toBeInTheDocument();
  });

  it('mengetik di-debounce menjadi satu permintaan dan disimpan di URL', async () => {
    const { fake, handler } = setup('PETUGAS', () => ok());
    renderApp('/cari', fake.client);
    const user = userEvent.setup();
    await user.type(await screen.findByRole('searchbox', { name: 'Kata kunci pencarian' }), 'renstra 2025');
    await waitFor(() => expect(loc()).toBe('/cari?q=renstra+2025'));
    await screen.findByRole('link', { name: /Berkas 50/ });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0]).toMatchObject({ p_query: 'renstra 2025' });
  });

  it('hasil permintaan lama tidak pernah tampil setelah query berganti', async () => {
    let releaseOld: (v: RpcResult) => void = () => {};
    const signals: AbortSignal[] = [];
    const { fake } = setup('PETUGAS', (args, signal) => {
      if (signal) signals.push(signal);
      if (args.p_query === 'lama') return new Promise<RpcResult>((r) => (releaseOld = r));
      return ok([makeHit({ item_id: 'ITM-BARU', no_surat: 'SURAT-BARU' })]);
    });
    renderApp('/cari?q=lama', fake.client);
    const box = await screen.findByRole('searchbox', { name: 'Kata kunci pencarian' });
    const user = userEvent.setup();
    await user.clear(box);
    await user.type(box, 'baru{Enter}');
    expect(await screen.findByText('SURAT-BARU')).toBeInTheDocument();
    expect(signals[0]!.aborted).toBe(true);
    releaseOld(ok([makeHit({ item_id: 'ITM-LAMA', no_surat: 'SURAT-LAMA' })]));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('SURAT-LAMA')).not.toBeInTheDocument();
    expect(screen.getByText('SURAT-BARU')).toBeInTheDocument();
  });

  it('hasil kosong: pesan yang menyarankan langkah berikutnya', async () => {
    const { fake } = setup('PETUGAS', () => ok([], 0));
    renderApp('/cari?q=zzz', fake.client);
    expect(await screen.findByRole('heading', { name: 'Tidak ada arsip yang cocok' })).toBeInTheDocument();
    expect(screen.getByText(/bersihkan sebagian filter/)).toBeInTheDocument();
  });

  it('error validasi server ditampilkan apa adanya dan bisa dicoba lagi', async () => {
    let fail = true;
    const { fake, handler } = setup('PETUGAS', () =>
      fail ? { data: null, error: { code: '22023', message: 'Tanggal awal tidak boleh lebih besar daripada tanggal akhir.' } } : ok());
    renderApp('/cari?q=x', fake.client);
    expect(await screen.findByRole('alert')).toHaveTextContent('Tanggal awal tidak boleh lebih besar daripada tanggal akhir. Perbaiki filter');
    fail = false;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Coba lagi' }));
    await screen.findByRole('link', { name: /Berkas 50/ });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('error jaringan: pesan yang dapat ditindaklanjuti', async () => {
    const { fake } = setup('PETUGAS', () => ({ data: null, error: { message: 'TypeError: Failed to fetch' } }));
    renderApp('/cari?q=x', fake.client);
    expect(await screen.findByRole('alert')).toHaveTextContent('Periksa koneksi internet Anda');
  });

  it('filter di lembar: diterapkan ke URL dan RPC', async () => {
    const { fake, handler } = setup('PETUGAS', () => ok());
    renderApp('/cari?q=nota', fake.client);
    await screen.findByRole('link', { name: /Berkas 50/ });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    const dialog = screen.getByRole('dialog', { name: 'Filter pencarian' });
    await user.selectOptions(within(dialog).getByLabelText('Tingkat perkembangan'), 'COPY');
    await user.selectOptions(within(dialog).getByLabelText('Status alih media'), 'BELUM_DIUNGGAH');
    await user.type(within(dialog).getByLabelText('Kode klasifikasi'), 'KU');
    await user.click(within(dialog).getByRole('button', { name: 'Terapkan' }));
    await waitFor(() => expect(loc()).toBe('/cari?q=nota&kls=KU&dev=COPY&file=BELUM_DIUNGGAH'));
    await waitFor(() => expect(handler).toHaveBeenLastCalledWith(
      expect.objectContaining({ p_query: 'nota', p_classification: 'KU', p_development: 'COPY', p_file_status: 'BELUM_DIUNGGAH' }), expect.anything()));
    expect(screen.getByRole('button', { name: /Filter/ })).toHaveTextContent('3');
    expect(screen.getByRole('button', { name: /Filter/ })).toHaveFocus();
  });

  it('filter tanggal terbalik ditolak di klien', async () => {
    const { fake } = setup('PETUGAS', () => ok());
    renderApp('/cari?q=nota', fake.client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Filter' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Dari'), '2025-05-01');
    await user.type(within(dialog).getByLabelText('Sampai'), '2025-01-01');
    await user.click(within(dialog).getByRole('button', { name: 'Terapkan' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Tanggal awal tidak boleh lebih besar');
  });

  it('opsi arsip dibatalkan hanya untuk peran operasional', async () => {
    const p = setup('PIMPINAN', () => ok());
    renderApp('/cari?q=a', p.fake.client);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Filter' }));
    expect(screen.queryByLabelText(/Sertakan arsip yang dibatalkan/)).not.toBeInTheDocument();
  });

  it('PETUGAS dapat menyertakan arsip dibatalkan', async () => {
    const { fake, handler } = setup('PETUGAS', () => ok([makeHit({ dibatalkan: true })]));
    renderApp('/cari?q=a', fake.client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Filter' }));
    await user.click(screen.getByLabelText(/Sertakan arsip yang dibatalkan/));
    await user.click(screen.getByRole('button', { name: 'Terapkan' }));
    await waitFor(() => expect(handler).toHaveBeenLastCalledWith(expect.objectContaining({ p_include_deleted: true }), expect.anything()));
    expect(await screen.findByText('Dibatalkan')).toBeInTheDocument();
  });

  it('paginasi: halaman berikutnya memakai offset dan tersimpan di URL', async () => {
    const { fake, handler } = setup('PETUGAS', (args) => ok([makeHit({ item_id: `ITM-${String(args.p_offset)}` })], 45));
    renderApp('/cari?q=a', fake.client);
    expect(await screen.findByText('Halaman 1 dari 3')).toBeInTheDocument();
    expect(screen.getByText('Menampilkan 1–1 dari 45 arsip')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('link', { name: /Berikutnya/ }));
    expect(await screen.findByText('Halaman 2 dari 3')).toBeInTheDocument();
    expect(loc()).toBe('/cari?q=a&hal=2');
    expect(handler).toHaveBeenLastCalledWith(expect.objectContaining({ p_offset: 20 }), expect.anything());
  });

  it('Admin Pusat mengirim unit aktif dari pemilih unit', async () => {
    const { fake, handler } = setup('ADMIN_PUSAT', () => ok());
    renderApp('/cari?q=a', fake.client);
    await screen.findByRole('link', { name: /Berkas 50/ });
    expect(handler).toHaveBeenLastCalledWith(expect.objectContaining({ p_unit_id: null }), expect.anything());
    const user = userEvent.setup();
    const switcher = screen.getAllByRole('combobox', { name: 'Unit aktif' })[0]!;
    await user.selectOptions(switcher, 'unit-1');
    await waitFor(() => expect(handler).toHaveBeenLastCalledWith(expect.objectContaining({ p_unit_id: 'unit-1' }), expect.anything()));
  });
});
