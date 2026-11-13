import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../../test/renderApp';
import { createFakeClient, makeProfile, makeSession, type RpcHandler } from '../../test/fakeSupabase';
import { makeBerkasDetail, makeItemDetail } from '../../test/fixtures';

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
    expect(screen.queryByText(/akses ke folder arsip|Google Drive/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Buka folder Drive' })).not.toBeInTheDocument();
    expect(screen.getByText('10 Januari 2025')).toBeInTheDocument();
  });

  it('Lihat PDF: tiket dari /api/files/ticket dengan JWT, tab baru ke URL unduhan', async () => {
    const win = { opener: {}, location: { replace: vi.fn() }, close: vi.fn() };
    vi.stubGlobal('open', vi.fn(() => win));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, url: '/api/files/download?t=T1', fileName: 'a.pdf', mime: 'application/pdf', size: 1 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const fake = client({ get_item_detail: () => ({ data: makeItemDetail(), error: null }) });
    renderApp('/cari/item/ITM-1', fake.client);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Lihat PDF' }));
    await waitFor(() => expect(win.location.replace).toHaveBeenCalledWith(`${window.location.origin}/api/files/download?t=T1`));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/files/ticket');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer access');
    expect(JSON.parse(String(init.body))).toEqual({ driveFileId: 'FILE1', disposition: 'inline' });
  });

  it('jembatan belum dipasang: pesan jelas untuk pengguna', async () => {
    vi.stubGlobal('open', vi.fn(() => ({ opener: {}, location: { replace: vi.fn() }, close: vi.fn() })));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, code: 'GATEWAY_NOT_CONFIGURED' }), { status: 503 })));
    const fake = client({ get_item_detail: () => ({ data: makeItemDetail(), error: null }) });
    renderApp('/cari/item/ITM-1', fake.client);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Unduh' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Jembatan Drive belum dipasang. File belum bisa dibuka dari aplikasi. Hubungi Admin Pusat.');
  });

  it('Bagikan berkas tampil hanya bila perangkat mendukung berbagi file', async () => {
    const fake = client({ get_item_detail: () => ({ data: makeItemDetail({ drive_file_size_bytes: 5000 }), error: null }) });
    const { unmount } = renderApp('/cari/item/ITM-1', fake.client);
    await screen.findByRole('button', { name: 'Lihat PDF' });
    expect(screen.queryByRole('button', { name: 'Bagikan berkas' })).not.toBeInTheDocument();
    unmount();
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true, writable: true });
    Object.defineProperty(navigator, 'share', { value: vi.fn(async () => {}), configurable: true, writable: true });
    const { unmount: u2 } = renderApp('/cari/item/ITM-1', fake.client);
    expect(await screen.findByRole('button', { name: 'Bagikan berkas' })).toBeInTheDocument();
    u2();
    const huge = client({ get_item_detail: () => ({ data: makeItemDetail({ drive_file_size_bytes: 30 * 1024 * 1024 }), error: null }) });
    renderApp('/cari/item/ITM-1', huge.client);
    await screen.findByRole('button', { name: 'Lihat PDF' });
    expect(screen.queryByRole('button', { name: 'Bagikan berkas' })).not.toBeInTheDocument();
    delete (navigator as { canShare?: unknown }).canShare;
    delete (navigator as { share?: unknown }).share;
  });

  it('Bagikan berkas: ambil PDF lalu navigator.share dengan file', async () => {
    Object.defineProperty(navigator, 'canShare', { value: () => true, configurable: true, writable: true });
    const share = vi.fn(async () => {});
    Object.defineProperty(navigator, 'share', { value: share, configurable: true, writable: true });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/files/ticket'
      ? new Response(JSON.stringify({ ok: true, url: '/api/files/download?t=T2', fileName: 'Laporan.pdf', mime: 'application/pdf', size: 8 }))
      : new Response('%PDF-1.7')));
    const fake = client({ get_item_detail: () => ({ data: makeItemDetail(), error: null }) });
    renderApp('/cari/item/ITM-1', fake.client);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Bagikan berkas' }));
    await waitFor(() => expect(share).toHaveBeenCalled());
    const arg = (share.mock.calls[0] as unknown as [{ files: File[]; title: string }])[0];
    expect(arg.files[0]!.name).toBe('Laporan.pdf');
    expect(arg.title).toContain('B-014/UN.07/2025');
    expect(await screen.findByText('Berkas dibagikan.')).toBeInTheDocument();
    delete (navigator as { canShare?: unknown }).canShare;
    delete (navigator as { share?: unknown }).share;
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
    expect(screen.queryByRole('button', { name: 'Buka folder Drive' })).not.toBeInTheDocument();
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
