import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../../test/renderApp';
import { createFakeClient, makeProfile, makeSession, type RpcHandler } from '../../test/fakeSupabase';
import type { Role } from '../../auth/permissions';
import type { LabelBerkas, LabelOptions, LabelPrintResult } from '../../lib/lidahApi';
import { layoutLabel, pageCount, placeLabels, wrapText } from './labelLayout';

function berkas(over: Partial<LabelBerkas> & { id: string; number: string }): LabelBerkas {
  return {
    classification_code: 'PR.01.01', title: `Judul ${over.number}`, location: `Kabinet 1 · Laci 2 · Folder ${over.number}`, folder_url: '',
    print_status: 'BELUM_DICETAK', print_status_label: 'Belum dicetak', needs_reprint: false, last_printed_at: null, last_print: null, ...over,
  };
}

const OPTIONS: LabelOptions = {
  unit_id: 'unit-1',
  berkas: [
    berkas({ id: 'BRK-1', number: '1', title: 'Renstra 2025', print_status: 'SUDAH_DICETAK', print_status_label: 'Sudah dicetak', last_printed_at: '2026-11-10T09:00:00+07:00' }),
    berkas({ id: 'BRK-2', number: '2', classification_code: 'KU.02', title: 'Pelaksanaan anggaran', print_status: 'PERLU_CETAK_ULANG', print_status_label: 'Perlu cetak ulang', needs_reprint: true, last_printed_at: '2026-11-09T10:00:00+07:00' }),
    berkas({ id: 'BRK-3', number: '3' }),
    berkas({ id: 'BRK-10', number: '10', title: 'Laporan kinerja tahunan' }),
  ],
  total: 4,
  status_counts: { BELUM_DICETAK: 2, SUDAH_DICETAK: 1, PERLU_CETAK_ULANG: 1 },
  layout: { paper: 'A4', columns: 2, rows: 7, labels_per_page: 14, label_width_mm: 70, label_height_mm: 30 },
};

function printResult(over: Partial<LabelPrintResult> = {}): LabelPrintResult {
  return {
    ok: true, batch_id: 'LBL-X', printed_at: '2026-11-14T10:00:00+07:00', file_name: 'Lidah_Folder_20261114_100000.pdf', start_slot: 1, label_count: 2, page_count: 1,
    labels: [
      { berkas_id: 'BRK-2', number: '2', classification_code: 'KU.02', title: 'Pelaksanaan anggaran', location: '' },
      { berkas_id: 'BRK-3', number: '3', classification_code: 'PR.01.01', title: 'Judul 3', location: '' },
    ],
    message: 'Pencetakan 2 lidah folder tercatat.', replayed: false, ...over,
  };
}

function setup(role: Role, rpc: Record<string, RpcHandler> = {}) {
  const options = vi.fn<RpcHandler>(() => ({ data: OPTIONS, error: null }));
  const fake = createFakeClient({ session: makeSession(), profile: makeProfile(role), rpc: { folder_label_options: options, ...rpc } });
  return { fake, options };
}

/** Menunggu daftar berkas termuat (hindari balapan dengan pemuatan asinkron). */
async function ready() {
  await screen.findByRole('checkbox', { name: 'Pilih berkas 1' });
}
const filled = () => Array.from(document.querySelectorAll<HTMLElement>('.lf-cell.is-filled')).map((c) => `${c.closest('.lf-page')!.getAttribute('aria-label')}#${c.dataset.slot}`);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tata letak lidah folder', () => {
  it('jumlah halaman mengikuti posisi awal: ceil((slot - 1 + n) / 14)', () => {
    expect([pageCount(1, 0), pageCount(1, 1), pageCount(1, 14), pageCount(2, 14), pageCount(14, 1), pageCount(14, 2), pageCount(13, 3)]).toEqual([0, 1, 1, 2, 1, 2, 2]);
  });
  it('placeLabels: slot sebelum posisi awal kosong, label berlanjut ke halaman berikut', () => {
    const pages = placeLabels(['a', 'b', 'c'], 13);
    expect(pages).toHaveLength(2);
    expect(pages[0]!.slice(10)).toEqual([null, null, 'a', 'b']);
    expect(pages[1]!.slice(0, 2)).toEqual(['c', null]);
    expect(placeLabels([], 5)).toHaveLength(1);
  });
  it('layoutLabel: judul menyusut dari 12/11,5 pt dan dipotong dengan "..." bila tidak muat', () => {
    const narrow = (text: string, size: number, bold: boolean) => text.length * size * (bold ? 0.55 : 0.45);
    const short = layoutLabel({ berkas_id: 'x', number: '7', classification_code: 'PR', title: 'Singkat' }, narrow);
    expect([short.headerSize, short.titleSize, short.titleLines]).toEqual([12, 11.5, ['Singkat']]);
    const long = layoutLabel({ berkas_id: 'x', number: '7', classification_code: 'PR', title: 'kata '.repeat(120) }, narrow);
    expect(long.titleSize).toBe(7);
    expect(long.titleLines.length).toBeLessThanOrEqual(4);
    expect(long.titleLines.at(-1)).toMatch(/\.\.\.$/);
    const wide = layoutLabel({ berkas_id: 'x', number: '1234567', classification_code: 'KODE.PANJANG.SEKALI.01.02.03', title: '' }, narrow);
    expect(wide.headerSize).toBeLessThan(12);
    expect(wide.headerSize).toBeGreaterThanOrEqual(9);
    expect(wide.titleLines).toEqual(['Tanpa Judul']);
    expect(wrapText('', 100, 10)).toEqual(['']);
  });
});

describe('Cetak Lidah Folder', () => {
  it('menampilkan berkas berurutan dengan status cetak, dan memfilter menurut pencarian dan status', async () => {
    const { fake, options } = setup('PETUGAS');
    renderApp('/lidah-folder', fake.client);
    await ready();
    expect(options).toHaveBeenCalledTimes(1);
    expect(options.mock.calls[0]![0]).toEqual({ p_unit_id: null });
    const rows = within(screen.getByRole('list', { name: 'Daftar berkas aktif' })).getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => within(r).getByRole('checkbox').getAttribute('aria-label'))).toEqual(['Pilih berkas 1', 'Pilih berkas 2', 'Pilih berkas 3', 'Pilih berkas 10']);
    expect(within(rows[1]!).getByText('Perlu cetak ulang')).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/nomor, kode, atau judul berubah/)).toBeInTheDocument();
    expect(screen.getByText('4 dari 4 berkas aktif bernomor definitif.')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Cari berkas'), 'kinerja');
    expect(screen.getAllByRole('checkbox').filter((c) => c.getAttribute('aria-label')?.startsWith('Pilih berkas'))).toHaveLength(1);
    await user.clear(screen.getByLabelText('Cari berkas'));
    await user.selectOptions(screen.getByLabelText('Status cetak'), 'PERLU_CETAK_ULANG');
    expect(screen.getByRole('checkbox', { name: 'Pilih berkas 2' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Pilih berkas 1' })).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('Cari berkas'), 'tidak ada');
    expect(screen.getByText('Tidak ada berkas yang sesuai dengan pencarian atau status cetak.')).toBeInTheDocument();
  });

  it('pilih banyak berkas, posisi awal pada grid 2 × 7, dan pratinjau memakai komponen yang sama dengan cetak', async () => {
    const { fake } = setup('ADMIN_UNIT');
    renderApp('/lidah-folder', fake.client);
    await ready();
    const user = userEvent.setup();
    expect(screen.getByText('Belum ada berkas dipilih.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cetak Lidah Folder' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /Pilih semua yang tampil \(4\)/ }));
    expect(screen.getByText('4 berkas dipilih · 1 halaman A4')).toBeInTheDocument();
    expect(filled()).toEqual(['Lembar 1 dari 1#1', 'Lembar 1 dari 1#2', 'Lembar 1 dari 1#3', 'Lembar 1 dari 1#4']);
    expect(document.querySelectorAll('.lf-cell')).toHaveLength(14);

    const slots = within(screen.getByRole('radiogroup', { name: 'Posisi awal label' })).getAllByRole('radio');
    expect(slots).toHaveLength(14);
    expect(slots[0]).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('radio', { name: /^Posisi 13,/ }));
    expect(screen.getByRole('radio', { name: /^Posisi 13,/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /^Posisi 1,/ })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('4 berkas dipilih · 2 halaman A4')).toBeInTheDocument();
    expect(filled()).toEqual(['Lembar 1 dari 2#13', 'Lembar 1 dari 2#14', 'Lembar 2 dari 2#1', 'Lembar 2 dari 2#2']);
    const first = document.querySelector('.lf-cell[data-slot="13"]')!;
    expect(first).toHaveTextContent('PR.01.01 | 1');
    expect(first).toHaveTextContent('Renstra 2025');

    await user.click(screen.getByRole('button', { name: 'Kosongkan pilihan' }));
    expect(screen.getByText('Belum ada berkas dipilih.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Pilih yang perlu cetak ulang \(1\)/ }));
    expect(screen.getByText('1 berkas dipilih · 1 halaman A4')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Pilih berkas 2' })).toBeChecked();
  });

  it('cetak: dialog cetak browser, lalu catat lewat RPC dengan id permintaan, posisi awal dan nama berkas; daftar dimuat ulang', async () => {
    const print = vi.fn<RpcHandler>(() => ({ data: printResult({ start_slot: 3 }), error: null }));
    const { fake, options } = setup('PETUGAS', { folder_label_print: print });
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {});
    const titleBefore = document.title;
    renderApp('/lidah-folder', fake.client);
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: 'Pilih berkas 3' }));
    await user.click(screen.getByRole('checkbox', { name: 'Pilih berkas 2' }));
    await user.click(screen.getByRole('radio', { name: /^Posisi 3,/ }));
    await user.click(screen.getByRole('button', { name: 'Cetak Lidah Folder' }));
    expect(printSpy).toHaveBeenCalledTimes(1);
    expect(document.title).toMatch(/^Lidah_Folder_\d{8}_\d{6}$/);
    expect(print).not.toHaveBeenCalled(); // dicatat hanya setelah pengguna mengonfirmasi

    act(() => { window.dispatchEvent(new Event('afterprint')); });
    expect(document.title).toBe(titleBefore);
    const dialog = await screen.findByRole('dialog', { name: 'Konfirmasi cetak' });
    expect(dialog).toHaveTextContent('2 lidah folder');
    await user.click(within(dialog).getByRole('button', { name: 'Ya, catat cetakan' }));

    expect(await screen.findByText('Pencetakan 2 lidah folder tercatat.')).toBeInTheDocument();
    expect(print).toHaveBeenCalledTimes(1);
    const args = print.mock.calls[0]![0] as Record<string, unknown>;
    expect(args).toMatchObject({ p_berkas_ids: ['BRK-2', 'BRK-3'], p_start_slot: 3, p_unit_id: null });
    expect(args.p_request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(args.p_file_name).toMatch(/^Lidah_Folder_\d{8}_\d{6}$/);
    await waitFor(() => expect(options).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Belum ada berkas dipilih.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('gagal mencatat: pesan server tanpa kode; ulang dengan id permintaan yang SAMA dan pilihan tetap', async () => {
    let n = 0;
    const print = vi.fn<RpcHandler>(() => (++n === 1
      ? { data: null, error: { code: 'P0001', message: 'NOT_FOUND: Sebagian berkas tidak lagi aktif atau belum mempunyai nomor definitif.', hint: 'NOT_FOUND' } as never }
      : { data: printResult(), error: null }));
    const { fake } = setup('ADMIN_UNIT', { folder_label_print: print });
    renderApp('/lidah-folder', fake.client);
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: 'Pilih berkas 3' }));
    await user.click(screen.getByRole('checkbox', { name: 'Pilih berkas 2' }));
    await user.click(screen.getByRole('button', { name: 'Catat sudah dicetak' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Konfirmasi cetak' })).getByRole('button', { name: 'Ya, catat cetakan' }));
    await waitFor(() => expect(print).toHaveBeenCalledTimes(1));
    expect((await screen.findAllByText(/Sebagian berkas tidak lagi aktif/)).length).toBeGreaterThan(0);
    expect(screen.getByRole('checkbox', { name: 'Pilih berkas 3' })).toBeChecked();
    await user.click(within(screen.getByRole('dialog', { name: 'Konfirmasi cetak' })).getByRole('button', { name: 'Ya, catat cetakan' }));
    expect(await screen.findByText('Pencetakan 2 lidah folder tercatat.')).toBeInTheDocument();
    const ids = print.mock.calls.map((c) => (c[0] as { p_request_id: string }).p_request_id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it('memperingatkan bila data berkas berubah antara pratinjau dan pencatatan', async () => {
    const print = vi.fn<RpcHandler>(() => ({
      data: printResult({ labels: [{ berkas_id: 'BRK-3', number: '3', classification_code: 'PR.01.01', title: 'Judul diubah orang lain', location: '' }], label_count: 1 }), error: null,
    }));
    const { fake } = setup('PETUGAS', { folder_label_print: print });
    renderApp('/lidah-folder', fake.client);
    await ready();
    const user = userEvent.setup();
    await user.click(screen.getByRole('checkbox', { name: 'Pilih berkas 3' }));
    await user.click(screen.getByRole('button', { name: 'Catat sudah dicetak' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Konfirmasi cetak' })).getByRole('button', { name: 'Ya, catat cetakan' }));
    expect(await screen.findByText(/Data berkas berubah sejak pratinjau/)).toBeInTheDocument();
  });

  it('Admin Pusat harus memilih unit; PIMPINAN tidak dapat membuka modul', async () => {
    const pusat = setup('ADMIN_PUSAT');
    const view = renderApp('/lidah-folder', pusat.fake.client);
    expect(await screen.findByText('Pilih unit terlebih dahulu.')).toBeInTheDocument();
    expect(pusat.options).not.toHaveBeenCalled();
    view.unmount();

    const pimpinan = setup('PIMPINAN');
    renderApp('/lidah-folder', pimpinan.fake.client);
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/dashboard'));
    expect(pimpinan.options).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: 'Cetak Lidah Folder' })).not.toBeInTheDocument();
  });

  it('galat memuat: pesan dan tombol coba lagi', async () => {
    let n = 0;
    const options = vi.fn<RpcHandler>(() => (++n === 1 ? { data: null, error: { code: 'P0001', message: 'ACCOUNT_INACTIVE: Akun Anda belum aktif.', hint: 'ACCOUNT_INACTIVE' } as never } : { data: OPTIONS, error: null }));
    const fake = createFakeClient({ session: makeSession(), profile: makeProfile('PETUGAS'), rpc: { folder_label_options: options } });
    renderApp('/lidah-folder', fake.client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Coba lagi' }));
    await ready();
    expect(options).toHaveBeenCalledTimes(2);
  });
});
