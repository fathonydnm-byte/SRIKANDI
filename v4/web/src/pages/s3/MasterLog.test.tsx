import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../../test/renderApp';
import { createFakeClient, makeProfile, makeSession, type RpcResult } from '../../test/fakeSupabase';
import type { Role } from '../../auth/permissions';
import { diffData, formatLogTime, type MasterLogRow } from '../../lib/masterLog';

function row(over: Partial<MasterLogRow> = {}): MasterLogRow {
  return {
    id: 'LOG-1', occurred_at: '2026-03-09T17:30:00Z', unit_id: 'unit-1', unit_code: 'BAU', unit_name: 'Biro Administrasi Umum',
    actor_user_id: 'user-1', actor_name: 'Siti Aminah', actor_email: 'siti@uinsa.ac.id', action: 'UPDATE', module: 'BERKAS',
    object_type: 'BERKAS', object_id: 'BRK-12', summary: 'Judul berkas diubah', reason: 'Koreksi salah ketik', request_id: 'REQ-1',
    result: 'SUCCESS', before_data: { judul: 'Lapran', halaman: 3, catatan: 'tetap' }, after_data: { judul: 'Laporan', halaman: 3, catatan: 'tetap', baru: true }, ...over,
  };
}
const page = (rows: MasterLogRow[], total = rows.length, offset = 0): RpcResult => ({ data: { total, limit: 25, offset, rows }, error: null });
const VALUES: RpcResult = { data: { actions: ['CREATE', 'UPDATE'], object_types: ['BERKAS', 'ITEM'], modules: ['BERKAS'] }, error: null };
const SEARCH = { name: /Cari di log/ };
const box = () => screen.getByRole('searchbox', SEARCH);
const loc = () => screen.getByTestId('location').textContent;

function setup(role: Role, log: (args: Record<string, unknown>, signal?: AbortSignal) => RpcResult | Promise<RpcResult>, values: RpcResult = VALUES) {
  const handler = vi.fn(log);
  const fake = createFakeClient({
    session: makeSession(), profile: makeProfile(role),
    rpc: { master_log: handler, master_log_filter_values: () => values },
  });
  return { fake, handler };
}

describe('Master Log: format dan selisih', () => {
  it('waktu selalu Asia/Jakarta', () => {
    expect(formatLogTime('2026-03-09T17:00:00Z')).toBe('10 Mar 2026, 00.00 WIB');
    expect(formatLogTime('2026-03-09T16:59:59Z', true)).toBe('9 Mar 2026, 23.59.59 WIB');
    expect(formatLogTime(null)).toBe('–');
  });
  it('diffData: diubah, ditambah, dihapus, tak berubah', () => {
    const d = diffData({ a: 1, b: { x: 1 }, c: 'x', gone: 1 }, { a: 2, b: { x: 1 }, c: 'x', added: null });
    expect(d.changes.map((c) => [c.key, c.kind])).toEqual([['a', 'changed'], ['gone', 'removed'], ['added', 'added']]);
    expect(d.unchanged).toEqual(['b', 'c']);
    expect(diffData(null, null).empty).toBe(true);
    expect(diffData(null, { a: 1 }).changes).toEqual([{ key: 'a', kind: 'added', after: 1 }]);
    expect(diffData({ a: 1 }, null).changes).toEqual([{ key: 'a', kind: 'removed', before: 1 }]);
    expect(diffData([1], [1, 2]).changes[0]).toMatchObject({ key: 'nilai', kind: 'changed' });
  });
});

describe('Master Log Perubahan', () => {
  it('menampilkan daftar dengan waktu WIB dan memanggil RPC dengan filter kosong', async () => {
    const { fake, handler } = setup('ADMIN_UNIT', () => page([row()]));
    renderApp('/master-log', fake.client);
    expect(await screen.findByText('10 Mar 2026, 00.30 WIB')).toBeInTheDocument();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0]).toEqual({ p_filters: {}, p_limit: 25, p_offset: 0, p_unit_id: null });
    expect(screen.getByText('Judul berkas diubah')).toBeInTheDocument();
    expect(screen.getByText('Alasan: Koreksi salah ketik')).toBeInTheDocument();
    expect(screen.getByText('1 entri · terbaru lebih dulu')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Unit' })).not.toBeInTheDocument();
  });

  it('tahap memuat lalu kosong: pesan sesuai ada/tidaknya filter', async () => {
    const { fake } = setup('ADMIN_UNIT', () => page([], 0));
    renderApp('/master-log', fake.client);
    expect(await screen.findByRole('heading', { name: 'Belum ada aktivitas tercatat' })).toBeInTheDocument();
  });

  it('kosong dengan filter: bisa membersihkan semua filter', async () => {
    const { fake, handler } = setup('ADMIN_UNIT', (a) => ((a.p_filters as { action?: string }).action ? page([], 0) : page([row()])));
    renderApp('/master-log?aksi=DELETE', fake.client);
    expect(await screen.findByRole('heading', { name: 'Tidak ada entri yang cocok' })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Bersihkan semua filter' }));
    expect(await screen.findByText('Judul berkas diubah')).toBeInTheDocument();
    expect(loc()).toBe('/master-log');
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('filter dari URL diteruskan ke RPC sebagai kunci server', async () => {
    const { fake, handler } = setup('ADMIN_UNIT', () => page([row()]));
    renderApp('/master-log?q=salah&dari=2026-03-01&sampai=2026-03-10&aksi=UPDATE&jenis=BERKAS&modul=BERKAS&hasil=FAILED&obj=BRK-12&pelaku=siti&hal=2', fake.client);
    await screen.findByText('Judul berkas diubah');
    expect(handler.mock.calls[0]![0]).toEqual({
      p_filters: { q: 'salah', date_from: '2026-03-01', date_to: '2026-03-10', action: 'UPDATE', object_type: 'BERKAS', module: 'BERKAS', result: 'FAILED', object_id: 'BRK-12', actor: 'siti' },
      p_limit: 25, p_offset: 25, p_unit_id: null,
    });
    expect(box()).toHaveValue('salah');
    expect(screen.getByRole('button', { name: /Filter/ })).toHaveTextContent('8');
  });

  it('lembar filter: pilihan dari server, diterapkan ke URL dan RPC', async () => {
    const { fake, handler } = setup('ADMIN_UNIT', () => page([row()]));
    renderApp('/master-log', fake.client);
    await screen.findByText('Judul berkas diubah');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    const dialog = screen.getByRole('dialog', { name: 'Filter log' });
    await waitFor(() => expect(within(dialog).getByRole('option', { name: 'CREATE' })).toBeInTheDocument());
    await user.selectOptions(within(dialog).getByLabelText('Aksi'), 'CREATE');
    await user.selectOptions(within(dialog).getByLabelText('Hasil'), 'FAILED');
    await user.type(within(dialog).getByLabelText('Dari'), '2026-03-01');
    await user.type(within(dialog).getByLabelText('Pelaku (nama atau email)'), 'budi');
    await user.click(within(dialog).getByRole('button', { name: 'Terapkan' }));
    await waitFor(() => expect(loc()).toBe('/master-log?dari=2026-03-01&aksi=CREATE&hasil=FAILED&pelaku=budi'));
    await waitFor(() => expect(handler).toHaveBeenLastCalledWith(
      { p_filters: { date_from: '2026-03-01', action: 'CREATE', result: 'FAILED', actor: 'budi' }, p_limit: 25, p_offset: 0, p_unit_id: null }, expect.anything()));
    expect(screen.getByRole('button', { name: /Filter/ })).toHaveFocus();
  });

  it('pilihan filter tetap bisa dipakai bila daftar nilai gagal dimuat', async () => {
    const { fake } = setup('ADMIN_UNIT', () => page([row()]), { data: null, error: { message: 'boom', code: 'XX000' } });
    renderApp('/master-log?aksi=PURGE', fake.client);
    await screen.findByText('Judul berkas diubah');
    await userEvent.setup().click(screen.getByRole('button', { name: /Filter/ }));
    expect(within(screen.getByRole('dialog')).getByLabelText('Aksi')).toHaveValue('PURGE');
  });

  it('tanggal terbalik ditolak di klien', async () => {
    const { fake } = setup('ADMIN_UNIT', () => page([row()]));
    renderApp('/master-log', fake.client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Filter' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Dari'), '2026-05-01');
    await user.type(within(dialog).getByLabelText('Sampai'), '2026-01-01');
    await user.click(within(dialog).getByRole('button', { name: 'Terapkan' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Tanggal awal tidak boleh lebih besar');
  });

  it('mengetik di-debounce menjadi satu permintaan dan disimpan di URL', async () => {
    const { fake, handler } = setup('ADMIN_UNIT', () => page([row()]));
    renderApp('/master-log', fake.client);
    await screen.findByText('Judul berkas diubah');
    await userEvent.setup().type(box(), 'koreksi');
    await waitFor(() => expect(loc()).toBe('/master-log?q=koreksi'));
    await waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
    expect(handler.mock.calls[1]![0]).toMatchObject({ p_filters: { q: 'koreksi' } });
  });

  it('hasil permintaan lama tidak pernah tampil setelah filter berganti; permintaan lama dibatalkan', async () => {
    let releaseOld: (v: RpcResult) => void = () => {};
    const signals: AbortSignal[] = [];
    const { fake } = setup('ADMIN_UNIT', (args, signal) => {
      if (signal) signals.push(signal);
      if ((args.p_filters as { q?: string }).q === 'lama') return new Promise<RpcResult>((r) => (releaseOld = r));
      return page([row({ id: 'LOG-BARU', summary: 'RINGKASAN-BARU' })]);
    });
    renderApp('/master-log?q=lama', fake.client);
    const box = await screen.findByRole('searchbox', SEARCH);
    const user = userEvent.setup();
    await user.clear(box);
    await user.type(box, 'baru{Enter}');
    expect(await screen.findByText('RINGKASAN-BARU')).toBeInTheDocument();
    expect(signals[0]!.aborted).toBe(true);
    releaseOld(page([row({ id: 'LOG-LAMA', summary: 'RINGKASAN-LAMA' })]));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('RINGKASAN-LAMA')).not.toBeInTheDocument();
    expect(screen.getByText('RINGKASAN-BARU')).toBeInTheDocument();
  });

  it('error jaringan: pesan yang dapat ditindaklanjuti dan Coba lagi', async () => {
    let fail = true;
    const { fake, handler } = setup('ADMIN_UNIT', () => (fail ? { data: null, error: { message: 'TypeError: Failed to fetch' } } : page([row()])));
    renderApp('/master-log', fake.client);
    expect(await screen.findByRole('alert')).toHaveTextContent('Periksa koneksi internet Anda');
    fail = false;
    await userEvent.setup().click(screen.getByRole('button', { name: 'Coba lagi' }));
    expect(await screen.findByText('Judul berkas diubah')).toBeInTheDocument();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('error validasi server ditampilkan dengan pesan dari server', async () => {
    const { fake } = setup('ADMIN_UNIT', () => ({
      data: null, error: { code: 'P0001', hint: 'INVALID_INPUT', message: 'INVALID_INPUT: Tanggal harus berformat TTTT-BB-HH yang valid.' },
    }));
    renderApp('/master-log', fake.client);
    expect(await screen.findByRole('alert')).toHaveTextContent('Tanggal harus berformat TTTT-BB-HH yang valid. Perbaiki filter');
  });

  it('FORBIDDEN_ROLE dari server: layar akses ditolak, bukan daftar kosong', async () => {
    const { fake } = setup('ADMIN_UNIT', () => ({
      data: null, error: { code: 'P0001', hint: 'FORBIDDEN_ROLE', message: 'FORBIDDEN_ROLE: Master Log Perubahan hanya dapat dibuka oleh Admin Unit atau Admin Pusat.' },
    }));
    renderApp('/master-log', fake.client);
    expect(await screen.findByRole('heading', { name: 'Akses ditolak' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Coba lagi' })).not.toBeInTheDocument();
  });

  it('PETUGAS dan PIMPINAN tidak dapat membuka rute (penjaga modul), tanpa memanggil RPC', async () => {
    for (const role of ['PETUGAS', 'PIMPINAN'] as Role[]) {
      const { fake, handler } = setup(role, () => page([row()]));
      const { unmount } = renderApp('/master-log', fake.client);
      await waitFor(() => expect(screen.queryByRole('heading', { name: 'Master Log Perubahan' })).not.toBeInTheDocument());
      await new Promise((r) => setTimeout(r, 10));
      expect(handler).not.toHaveBeenCalled();
      unmount();
    }
  });

  it('halaman berikutnya memakai offset dan menyimpan hal di URL', async () => {
    const { fake, handler } = setup('ADMIN_UNIT', (a) => page([row({ id: `LOG-${a.p_offset}` })], 60, a.p_offset as number));
    renderApp('/master-log', fake.client);
    await screen.findByText('Halaman 1 dari 3');
    expect(screen.getByText('Menampilkan 1–1 dari 60 entri · terbaru lebih dulu')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: /Berikutnya/ }));
    await screen.findByText('Halaman 2 dari 3');
    expect(loc()).toBe('/master-log?hal=2');
    expect(handler).toHaveBeenLastCalledWith(expect.objectContaining({ p_offset: 25 }), expect.anything());
  });

  it('Admin Pusat melihat kolom unit dan mengirim unit aktif', async () => {
    const { fake, handler } = setup('ADMIN_PUSAT', () => page([row({ unit_code: 'FEB' })]));
    renderApp('/master-log', fake.client);
    await screen.findByText('Judul berkas diubah');
    expect(screen.getByRole('columnheader', { name: 'Unit' })).toBeInTheDocument();
    expect(screen.getByText('FEB')).toBeInTheDocument();
    expect(handler).toHaveBeenCalled();
  });

  it('entri gagal diberi teks, bukan hanya warna', async () => {
    const { fake } = setup('ADMIN_UNIT', () => page([row({ result: 'FAILED' }), row({ id: 'LOG-2', result: 'WARNING' })]));
    renderApp('/master-log', fake.client);
    await screen.findAllByText('Judul berkas diubah');
    expect(screen.getByText('Gagal')).toBeInTheDocument();
    expect(screen.getByText('Peringatan')).toBeInTheDocument();
  });

  it('rincian: selisih kolom terbaca, kolom tak berubah diringkas, JSON mentah tersembunyi', async () => {
    const { fake } = setup('ADMIN_UNIT', () => page([row()]));
    renderApp('/master-log', fake.client);
    await screen.findByText('Judul berkas diubah');
    const user = userEvent.setup();
    const open = screen.getByRole('button', { name: /Rincian UPDATE/ });
    await user.click(open);
    const dialog = screen.getByRole('dialog', { name: 'Rincian perubahan' });
    expect(within(dialog).getByText('10 Mar 2026, 00.30.00 WIB')).toBeInTheDocument();
    expect(within(dialog).getByText('Siti Aminah · siti@uinsa.ac.id')).toBeInTheDocument();
    const items = within(dialog).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText('Judul')).toBeInTheDocument();
    expect(within(items[0]!).getByText('Lapran')).toBeInTheDocument();
    expect(within(items[0]!).getByText('Laporan')).toBeInTheDocument();
    expect(within(items[1]!).getByText('Baru')).toBeInTheDocument();
    expect(within(items[1]!).getByText('Ya')).toBeInTheDocument();
    expect(within(dialog).getByText('2 kolom lain tidak berubah.')).toBeInTheDocument();
    expect(within(dialog).getByText('Tampilkan data mentah (JSON)').closest('details')).not.toHaveAttribute('open');
    await user.click(within(dialog).getByRole('button', { name: 'Tutup Rincian perubahan' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(open).toHaveFocus();
  });

  it('rincian: data hanya sesudah (CREATE) dan tanpa data', async () => {
    const { fake } = setup('ADMIN_UNIT', () => page([
      row({ id: 'A', action: 'CREATE', before_data: null, after_data: { nomor: 'TRM-1' } }),
      row({ id: 'B', action: 'LOGIN', before_data: null, after_data: null }),
    ]));
    renderApp('/master-log', fake.client);
    await screen.findAllByText('Judul berkas diubah');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Rincian CREATE/ }));
    let dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Ditambahkan')).toBeInTheDocument();
    expect(dialog.querySelector('.ml-before')).toBeNull();
    expect(dialog.querySelector('.ml-after')).not.toBeNull();
    await user.click(within(dialog).getByRole('button', { name: /Tutup/ }));
    await user.click(screen.getByRole('button', { name: /Rincian LOGIN/ }));
    dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Entri ini tidak menyimpan data sebelum/sesudah.')).toBeInTheDocument();
    expect(within(dialog).queryByText('Tampilkan data mentah (JSON)')).not.toBeInTheDocument();
  });

  it('isi log tidak pernah dirender sebagai HTML', async () => {
    const evil = '<img src=x onerror="alert(1)"><b>tebal</b>';
    const { fake } = setup('ADMIN_UNIT', () => page([row({ summary: evil, reason: evil, actor_name: evil, object_id: evil, before_data: { k: evil }, after_data: { k: `${evil}2` } })]));
    const { container } = renderApp('/master-log', fake.client);
    await screen.findByText(evil, { selector: '.ml-summary' });
    await userEvent.setup().click(screen.getByRole('button', { name: /Rincian UPDATE/ }));
    expect(container.querySelector('img')).toBeNull();
    expect(document.body.querySelector('img, b')).toBeNull();
    expect(within(screen.getByRole('dialog')).getAllByText(evil, { exact: false }).length).toBeGreaterThan(0);
  });
});
