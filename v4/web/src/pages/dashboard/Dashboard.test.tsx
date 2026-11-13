import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../../test/renderApp';
import { createFakeClient, makeProfile, makeSession, type RpcHandler } from '../../test/fakeSupabase';
import type { DashboardGroup, OverviewItem } from '../../lib/api';
import type { Role } from '../../auth/permissions';

function group(no: number, over: Partial<DashboardGroup> = {}): DashboardGroup {
  return {
    berkas_id: `BRK-${no}`, no_berkas: no, judul_berkas: `Judul berkas ${no}`, kode_klasifikasi: 'KS.01.1', kurun_waktu: '2023',
    kabinet: 'A1', laci: '1', folder: String(no), lokasi: `Kabinet A1 · Laci 1 · Folder ${no}`, item_count: 2, total_lembar: 18,
    status_code: 'ACTIVE', status_label: 'AKTIF', batas_aktif: '2027-01-01', days_to_active_limit: 400, dipinjam: false, ...over,
  };
}
const ITEM = (berkas: number, no: number, uraian: string): OverviewItem => ({
  item_id: `ITM-${berkas}-${no}`, no_item: no, no_surat: `B-${no}/2023`, uraian, jumlah_halaman: 9, tanggal_naskah: '2023-02-01',
  tingkat_perkembangan: 'ASLI', has_file: no === 1, status_peminjaman: 'TERSEDIA',
});
const COUNTS = { total_berkas: 82, total_item: 2045, sedang_dipinjam: 3, retensi_h7: 0, habis_aktif: 1 };
const GROUPS = [
  group(1, { judul_berkas: 'Pemeliharaan Gondola', status_code: 'EXPIRED', status_label: 'HABIS AKTIF – KANDIDAT USUL PINDAH' }),
  group(2, { judul_berkas: 'Rapat pimpinan', kode_klasifikasi: 'OT.02' }),
  group(3, { judul_berkas: 'Kontrak kebersihan', status_code: 'PROPOSED', status_label: 'DALAM USUL PEMINDAHAN' }),
];

function setup(role: Role = 'PETUGAS', rpc: Record<string, RpcHandler> = {}) {
  const overview = vi.fn<RpcHandler>(() => ({ data: { today: '2026-11-13', counts: COUNTS, groups: GROUPS }, error: null }));
  const items = vi.fn<RpcHandler>((args) => {
    const ids = args.p_berkas_ids as string[];
    return { data: Object.fromEntries(ids.map((id) => [id, [ITEM(Number(id.split('-')[1]), 1, 'Notulen rapat'), ITEM(Number(id.split('-')[1]), 2, 'Daftar hadir')]])), error: null };
  });
  const match = vi.fn<RpcHandler>((args) => ({ data: String(args.p_query).includes('hadir') ? ['BRK-2'] : [], error: null }));
  const fake = createFakeClient({
    session: makeSession(), profile: makeProfile(role),
    rpc: { dashboard_overview: overview, dashboard_berkas_items: items, dashboard_match_berkas: match, ...rpc },
  });
  return { fake, overview, items, match };
}
const loc = () => screen.getByTestId('location').textContent;

describe('Dashboard (paritas 3.x)', () => {
  it('judul, lima kartu, kartu pintas, ajakan input; tanpa kartu Koneksi server', async () => {
    renderApp('/dashboard', setup().fake.client);
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Ringkasan kondisi arsip Anda.')).toBeInTheDocument();
    await screen.findByText('2.045');
    for (const [label, value] of [['Total Berkas', '82'], ['Total Item', '2.045']]) {
      expect(screen.getByText(label!).closest('.stat-card')).toHaveTextContent(value!);
    }
    expect(screen.getByRole('link', { name: /Sedang Dipinjam\s*3\s*Lihat rincian/ })).toHaveAttribute('href', '/dashboard/dipinjam');
    expect(screen.getByRole('link', { name: /Retensi H-7\s*0\s*Lihat rincian/ })).toHaveAttribute('href', '/dashboard/retensi-h7');
    expect(screen.getByRole('link', { name: /Habis Aktif\s*1\s*Lihat rincian/ })).toHaveAttribute('href', '/dashboard/habis-aktif');
    expect(screen.getByRole('heading', { name: 'Input berkas dan item dalam satu layar' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Mulai Input Arsip' })).toHaveAttribute('href', '/pemberkasan');
    expect(screen.queryByText('Koneksi server')).not.toBeInTheDocument();
  });

  it('PIMPINAN tidak melihat ajakan input', async () => {
    renderApp('/dashboard', setup('PIMPINAN').fake.client);
    await screen.findByText('2.045');
    expect(screen.queryByRole('link', { name: 'Mulai Input Arsip' })).not.toBeInTheDocument();
  });

  it('Daftar Isi Berkas: baris, sub-baris lokasi, ringkasan, lencana; judul menuju detail berkas', async () => {
    renderApp('/dashboard', setup().fake.client);
    const title = await screen.findByRole('link', { name: '1 — Pemeliharaan Gondola' });
    expect(title).toHaveAttribute('href', '/cari/berkas/BRK-1');
    const row = title.closest('li')!;
    expect(row).toHaveTextContent('KS.01.1 · 2023 · Kabinet A1 · Laci 1 · Folder 1');
    expect(row).toHaveTextContent('2 item · 18 lembar');
    expect(within(row).getByText('HABIS AKTIF – KANDIDAT USUL PINDAH')).toHaveClass('badge-danger');
    expect(screen.getByText('DALAM USUL PEMINDAHAN')).toHaveClass('badge-info');
    expect(screen.getByText('3 berkas aktif')).toBeInTheDocument();
  });

  it('membuka baris memuat item (sekali) dengan tautan ke detail item', async () => {
    const { fake, items } = setup();
    renderApp('/dashboard', fake.client);
    const user = userEvent.setup();
    const toggle = await screen.findByRole('button', { name: 'Buka isi berkas 2' });
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const link = await screen.findByRole('link', { name: /Notulen rapat/ });
    expect(link).toHaveAttribute('href', '/cari/item/ITM-2-1');
    expect(items).toHaveBeenCalledWith({ p_berkas_ids: ['BRK-2'] }, undefined);
    await user.click(screen.getByRole('button', { name: 'Tutup isi berkas 2' }));
    expect(screen.queryByRole('link', { name: /Notulen rapat/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Buka isi berkas 2' }));
    expect(await screen.findByRole('link', { name: /Notulen rapat/ })).toBeInTheDocument();
    expect(items).toHaveBeenCalledTimes(1);
  });

  it('Buka Semua memuat item semua baris terlihat dalam satu permintaan; Tutup Semua menutup', async () => {
    const { fake, items } = setup();
    renderApp('/dashboard', fake.client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Buka Semua' }));
    await waitFor(() => expect(screen.getAllByRole('link', { name: /Notulen rapat/ })).toHaveLength(3));
    expect(items).toHaveBeenCalledTimes(1);
    expect(items.mock.calls[0]![0]).toEqual({ p_berkas_ids: ['BRK-1', 'BRK-2', 'BRK-3'] });
    await user.click(screen.getByRole('button', { name: 'Tutup Semua' }));
    expect(screen.queryByRole('link', { name: /Notulen rapat/ })).not.toBeInTheDocument();
  });

  it('filter: kolom berkas di browser, uraian item lewat server', async () => {
    const { fake, match } = setup();
    renderApp('/dashboard', fake.client);
    const box = await screen.findByPlaceholderText('Cari nomor berkas, judul, kode klasifikasi, atau uraian item');
    const user = userEvent.setup();
    await user.type(box, 'ot.02');
    expect(screen.getByRole('link', { name: '2 — Rapat pimpinan' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '1 — Pemeliharaan Gondola' })).not.toBeInTheDocument();
    await user.clear(box);
    await user.type(box, 'hadir');
    expect(await screen.findByRole('link', { name: '2 — Rapat pimpinan' })).toBeInTheDocument();
    await waitFor(() => expect(match).toHaveBeenLastCalledWith({ p_query: 'hadir', p_unit_id: null }, expect.anything()));
    expect(screen.getByText(/1 dari 3 berkas cocok/)).toBeInTheDocument();
    await user.clear(box);
    await user.type(box, 'zzz');
    expect(await screen.findByText('Tidak ada berkas atau item yang cocok dengan pencarian.')).toBeInTheDocument();
  });

  it('Segarkan Data memuat ulang ringkasan', async () => {
    const { fake, overview } = setup();
    renderApp('/dashboard', fake.client);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Segarkan Data' }));
    await waitFor(() => expect(overview).toHaveBeenCalledTimes(2));
  });

  it('Admin Pusat: ringkasan mengikuti unit aktif', async () => {
    const { fake, overview } = setup('ADMIN_PUSAT');
    renderApp('/dashboard', fake.client);
    await screen.findByText('2.045');
    expect(overview).toHaveBeenCalledWith({ p_unit_id: null }, undefined);
    await userEvent.setup().selectOptions(screen.getAllByRole('combobox', { name: 'Unit aktif' })[0]!, 'unit-1');
    await waitFor(() => expect(overview).toHaveBeenLastCalledWith({ p_unit_id: 'unit-1' }, undefined));
    expect(screen.getByRole('link', { name: /Habis Aktif/ })).toHaveAttribute('href', '/dashboard/habis-aktif?unit=unit-1');
  });
});

describe('daftar kartu pintas', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    ...group(5, { status_code: 'DUE', status_label: 'H-3', batas_aktif: '2026-11-16', days_to_active_limit: 3 }),
    item_dipinjam: 0, status_peminjaman: 'TERSEDIA', batas_inaktif: null, usul_pindah_no: null, ...over,
  });

  it('Retensi H-7: daftar dengan lokasi dan batas aktif', async () => {
    const shortcut = vi.fn<RpcHandler>(() => ({ data: [row()], error: null }));
    renderApp('/dashboard/retensi-h7', setup('PETUGAS', { dashboard_shortcut: shortcut }).fake.client);
    expect(await screen.findByRole('heading', { name: 'Retensi H-7', level: 1 })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: '5 — Judul berkas 5' })).toHaveAttribute('href', '/cari/berkas/BRK-5');
    expect(screen.getByRole('group', { name: 'Lokasi: Kabinet A1 · Laci 1 · Folder 5' })).toBeInTheDocument();
    expect(screen.getByText(/Batas aktif/)).toHaveTextContent('Batas aktif 16 November 2026 (3 hari lagi)');
    expect(shortcut).toHaveBeenCalledWith({ p_kind: 'H7', p_unit_id: null }, undefined);
  });

  it('angka nol tetap membuka daftar kosong dengan pesan', async () => {
    renderApp('/dashboard/retensi-h7', setup('PETUGAS', { dashboard_shortcut: () => ({ data: [], error: null }) }).fake.client);
    expect(await screen.findByText('Tidak ada berkas yang masa aktifnya akan habis dalam 0–7 hari.')).toBeInTheDocument();
  });

  it('Sedang Dipinjam: menjelaskan dasar hitungan sampai Sprint 4', async () => {
    const data = [row({ status_peminjaman: 'DIPINJAM', item_dipinjam: 2, status_code: 'ACTIVE', status_label: 'AKTIF' })];
    renderApp('/dashboard/dipinjam', setup('PIMPINAN', { dashboard_shortcut: () => ({ data, error: null }) }).fake.client);
    expect(await screen.findByText(/Dihitung per berkas dari status pinjam berkas dan item/)).toBeInTheDocument();
    expect(await screen.findByText('Berkas dipinjam · 2 item dipinjam')).toBeInTheDocument();
  });

  it('Habis Aktif menampilkan berapa hari lewat dan nomor usul', async () => {
    const data = [row({ status_code: 'PROPOSED', status_label: 'DALAM USUL PEMINDAHAN', days_to_active_limit: -12, batas_aktif: '2026-11-01', usul_pindah_no: 'UP-2026-003' })];
    renderApp('/dashboard/habis-aktif', setup('PETUGAS', { dashboard_shortcut: () => ({ data, error: null }) }).fake.client);
    expect(await screen.findByText(/Batas aktif/)).toHaveTextContent('Batas aktif 1 November 2026 (lewat 12 hari) · dalam usul UP-2026-003');
  });

  it('jenis tak dikenal kembali ke Dashboard', async () => {
    renderApp('/dashboard/entah', setup().fake.client);
    await waitFor(() => expect(loc()).toBe('/dashboard'));
  });
});

describe('navigasi 3.x', () => {
  it('kelompok dan label sidebar mengikuti 3.x; Kelola Informasi Arsip bisa dilipat', async () => {
    renderApp('/dashboard', setup('ADMIN_UNIT').fake.client);
    await screen.findByText('2.045');
    const side = screen.getByRole('complementary', { name: 'Menu samping' });
    for (const g of ['Pencarian & Registrasi', 'Penciptaan Arsip', 'Pemeliharaan Arsip', 'Sirkulasi & Retensi', 'Keamanan & Audit']) {
      expect(within(side).getByText(g)).toBeInTheDocument();
    }
    for (const l of ['Pencarian Arsip', 'Penerimaan Naskah', 'Registrasi Berkas Baru', 'Cetak Lidah Folder', 'Peminjaman Arsip', 'Penyusutan Arsip', 'Master Log Perubahan']) {
      expect(within(side).getByRole('link', { name: l })).toBeInTheDocument();
    }
    const toggle = within(side).getByRole('button', { name: 'Kelola Informasi Arsip' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(side).queryByRole('link', { name: 'Perubahan Arsip' })).not.toBeInTheDocument();
    await userEvent.setup().click(toggle);
    for (const l of ['Perubahan Arsip', 'Penghapusan Arsip', 'Alih Media Arsip']) expect(within(side).getByRole('link', { name: l })).toBeInTheDocument();
  });

  it('sub-menu terbuka otomatis pada halaman anggotanya', async () => {
    renderApp('/edit', setup('ADMIN_UNIT').fake.client);
    const side = await screen.findByRole('complementary', { name: 'Menu samping' });
    expect(within(side).getByRole('button', { name: 'Kelola Informasi Arsip' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('pencarian cepat di top bar dan Ctrl+K menuju Pencarian Arsip', async () => {
    renderApp('/dashboard', setup('PIMPINAN', { search_archive: () => ({ data: { total: 0, limit: 20, offset: 0, results: [] }, error: null }) }).fake.client);
    const user = userEvent.setup();
    await user.type(await screen.findByPlaceholderText('Cari cepat nomor berkas, uraian, peminjam…'), 'gondola{Enter}');
    await waitFor(() => expect(loc()).toBe('/cari?q=gondola'));
    await user.click(screen.getAllByRole('link', { name: /Dashboard/ })[0]!);
    await waitFor(() => expect(loc()).toBe('/dashboard'));
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    await waitFor(() => expect(loc()).toBe('/cari')); // jsdom: input tidak tampil → pindah halaman
  });
});

describe('Buka Semua pada unit besar', () => {
  it('membuka paling banyak 100 berkas sekali tekan, dengan keterangan', async () => {
    const many = Array.from({ length: 150 }, (_, i) => group(i + 1));
    const items = vi.fn<RpcHandler>((args) => ({ data: Object.fromEntries((args.p_berkas_ids as string[]).map((id) => [id, []])), error: null }));
    const fake = createFakeClient({
      session: makeSession(), profile: makeProfile('PETUGAS'),
      rpc: {
        dashboard_overview: () => ({ data: { today: '2026-11-13', counts: COUNTS, groups: many }, error: null }),
        dashboard_berkas_items: items,
      },
    });
    renderApp('/dashboard', fake.client);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Buka Semua' }));
    expect(await screen.findByText(/dibuka 100 berkas pertama/)).toBeInTheDocument();
    expect(items).toHaveBeenCalledTimes(1);
    expect((items.mock.calls[0]![0].p_berkas_ids as string[]).length).toBe(100);
    expect(screen.getAllByRole('button', { name: /^Tutup isi berkas/ })).toHaveLength(100);
  });
});
