import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../../test/renderApp';
import { createFakeClient, makeProfile, makeSession, type RpcHandler } from '../../test/fakeSupabase';
import { makeBerkasDetail, makeItemDetail } from '../../test/fixtures';
import { FILE_ACCESS_NOTE } from '../../lib/files';

function client(rpc: Record<string, RpcHandler>) {
  return createFakeClient({ session: makeSession(), profile: makeProfile('PIMPINAN'), rpc });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('detail item', () => {
  it('menampilkan lokasi besar, softcopy, dan keterangan', async () => {
    const fake = client({ get_item_detail: (args) => ({ data: args.p_item_id === 'ITM-1' ? makeItemDetail() : null, error: null }) });
    renderApp('/cari/item/ITM-1', fake.client);
    expect(await screen.findByRole('heading', { name: 'B-014/UN.07/2025', level: 1 })).toBeInTheDocument();
    const loc = screen.getByRole('group', { name: 'Lokasi: Kabinet 7 · Laci 3 · Folder 12' });
    expect(within(loc).getByText('Kabinet')).toBeInTheDocument();
    expect(within(loc).getByText('12')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /50 — Laporan Keuangan 2025/ })).toHaveAttribute('href', '/cari/berkas/BRK-1');
    expect(screen.getByText(new RegExp(FILE_ACCESS_NOTE.slice(0, 40)))).toBeInTheDocument();
    expect(screen.getByText('10 Januari 2025')).toBeInTheDocument();
  });

  it('Buka PDF lewat modul files (tab baru, noopener)', async () => {
    const open = vi.fn(() => null);
    vi.stubGlobal('open', open);
    const fake = client({ get_item_detail: () => ({ data: makeItemDetail(), error: null }) });
    renderApp('/cari/item/ITM-1', fake.client);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Buka PDF' }));
    expect(open).toHaveBeenCalledWith('https://drive.google.com/file/d/FILE1/view', '_blank', 'noopener,noreferrer');
  });

  it('tanpa PDF: tombol nonaktif dengan label jelas', async () => {
    const fake = client({ get_item_detail: () => ({ data: makeItemDetail({ has_file: false, drive_file_id: null, drive_file_url: null }), error: null }) });
    renderApp('/cari/item/ITM-1', fake.client);
    expect(await screen.findByRole('button', { name: 'Belum ada PDF' })).toBeDisabled();
  });

  it('Salin lokasi menyalin teks lokasi lengkap', async () => {
    const fake = client({ get_item_detail: () => ({ data: makeItemDetail(), error: null }) });
    renderApp('/cari/item/ITM-1', fake.client);
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    await user.click(await screen.findByRole('button', { name: /Salin lokasi/ }));
    expect(writeText).toHaveBeenCalledTimes(1);
    const text = writeText.mock.calls[0]![0];
    expect(text).toContain('Lokasi: Kabinet 7 · Laci 3 · Folder 12 (Biro Administrasi Umum)');
    expect(text).toContain('Berkas 50: Laporan Keuangan 2025');
    expect(text).toContain('Item 1: B-014/UN.07/2025, 10 Januari 2025');
    expect(await screen.findByText('Lokasi disalin. Tempel di pesan Anda.')).toBeInTheDocument();
  });

  it('Bagikan memakai Web Share API bila tersedia', async () => {
    const share = vi.fn(async () => {});
    Object.defineProperty(navigator, 'share', { value: share, configurable: true, writable: true });
    const fake = client({ get_item_detail: () => ({ data: makeItemDetail(), error: null }) });
    renderApp('/cari/item/ITM-1', fake.client);
    await userEvent.setup().click(await screen.findByRole('button', { name: /Bagikan/ }));
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ title: 'Lokasi arsip B-014/UN.07/2025', text: expect.stringContaining('Kabinet 7') }));
    delete (navigator as { share?: unknown }).share;
  });

  it('item di unit lain / tidak ada: pesan tidak ditemukan', async () => {
    const fake = client({ get_item_detail: () => ({ data: null, error: null }) });
    renderApp('/cari/item/ITM-X', fake.client);
    expect(await screen.findByRole('heading', { name: 'Arsip tidak ditemukan' })).toBeInTheDocument();
  });

  it('kembali ke hasil pencarian mempertahankan query', async () => {
    const fake = createFakeClient({
      session: makeSession(),
      profile: makeProfile('PETUGAS'),
      rpc: {
        search_archive: () => ({ data: { total: 1, limit: 20, offset: 0, results: [{ ...makeItemDetail(), score: 1 }] }, error: null }),
        get_item_detail: () => ({ data: makeItemDetail(), error: null }),
      },
    });
    renderApp('/cari?q=laporan', fake.client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('link', { name: /Berkas 50 \/ Item 1/ }));
    await user.click(await screen.findByRole('link', { name: /Kembali ke hasil pencarian/ }));
    expect(screen.getByTestId('location').textContent).toBe('/cari?q=laporan');
  });
});

describe('Daftar Isi Berkas', () => {
  it('item berurutan, total lembar, rentang tanggal, folder', async () => {
    const fake = client({ get_berkas_detail: () => ({ data: makeBerkasDetail(), error: null }) });
    renderApp('/cari/berkas/BRK-1', fake.client);
    expect(await screen.findByRole('heading', { name: 'Berkas 50', level: 1 })).toBeInTheDocument();
    const rows = screen.getAllByRole('link', { name: /Item \d/ });
    expect(rows.map((r) => r.getAttribute('href'))).toEqual(['/cari/item/ITM-1', '/cari/item/ITM-2']);
    expect(screen.getByText('Total lembar').nextSibling).toHaveTextContent('6');
    expect(screen.getByText('10 Januari 2025 – 1 Juni 2025')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Buka folder Drive' })).toBeEnabled();
    expect(screen.getByText('Rahasia')).toBeInTheDocument();
  });

  it('error memuat: pesan + coba lagi', async () => {
    let n = 0;
    const fake = client({ get_berkas_detail: () => (n++ === 0 ? { data: null, error: { message: 'x', status: 503 } } : { data: makeBerkasDetail(), error: null }) });
    renderApp('/cari/berkas/BRK-1', fake.client);
    expect(await screen.findByRole('alert')).toHaveTextContent('Server sedang bermasalah.');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Coba lagi' }));
    expect(await screen.findByRole('heading', { name: 'Berkas 50', level: 1 })).toBeInTheDocument();
  });
});
