import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../test/renderApp';
import { createFakeClient, makeProfile, makeSession } from '../test/fakeSupabase';

const COUNTS = { berkas_aktif: 82, item_aktif: 2045, item_tanpa_pdf: 17, penerimaan_menunggu: 3 };

describe('Dashboard', () => {
  it('menampilkan hitungan dari RPC dan kartu kesehatan', async () => {
    const counts = vi.fn(() => ({ data: COUNTS, error: null }));
    const fake = createFakeClient({ session: makeSession(), profile: makeProfile('PETUGAS'), rpc: { dashboard_counts: counts } });
    renderApp('/dashboard', fake.client);
    expect(await screen.findByText('2.045')).toBeInTheDocument();
    expect(screen.getByText('82')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Item belum ada PDF\s*17/ })).toHaveAttribute('href', '/cari?file=BELUM_DIUNGGAH');
    expect(screen.getByRole('link', { name: /Penerimaan menunggu pemberkasan\s*3/ })).toHaveAttribute('href', '/penerimaan');
    expect(screen.getByRole('heading', { name: 'Koneksi server' })).toBeInTheDocument();
    expect(counts).toHaveBeenCalledWith({ p_unit_id: null }, undefined);
    expect(screen.queryByText('Modul untuk peran Anda')).not.toBeInTheDocument();
  });

  it('PIMPINAN: kartu penerimaan tidak menjadi tautan ke modul terlarang', async () => {
    const fake = createFakeClient({ session: makeSession(), profile: makeProfile('PIMPINAN'), rpc: { dashboard_counts: () => ({ data: COUNTS, error: null }) } });
    renderApp('/dashboard', fake.client);
    await screen.findByText('2.045');
    expect(screen.queryByRole('link', { name: /Penerimaan menunggu/ })).not.toBeInTheDocument();
  });

  it('pencarian cepat membuka Cari Arsip dengan query', async () => {
    const fake = createFakeClient({
      session: makeSession(), profile: makeProfile('PIMPINAN'),
      rpc: { search_archive: () => ({ data: { total: 0, limit: 20, offset: 0, results: [] }, error: null }) },
    });
    renderApp('/dashboard', fake.client);
    const user = userEvent.setup();
    await user.type(await screen.findByRole('searchbox', { name: 'Cari arsip' }), 'renstra{Enter}');
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/cari?q=renstra'));
  });

  it('gagal memuat hitungan: pesan + muat ulang', async () => {
    const fake = createFakeClient({ session: makeSession(), profile: makeProfile('PETUGAS'), rpc: { dashboard_counts: () => ({ data: null, error: { message: 'Failed to fetch' } }) } });
    renderApp('/dashboard', fake.client);
    expect(await screen.findByText(/Periksa koneksi internet Anda/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Muat ulang ringkasan' })).toBeInTheDocument();
  });

  it('Admin Pusat: hitungan mengikuti unit aktif', async () => {
    const counts = vi.fn((_args: Record<string, unknown>) => ({ data: COUNTS, error: null }));
    const fake = createFakeClient({ session: makeSession(), profile: makeProfile('ADMIN_PUSAT'), rpc: { dashboard_counts: counts } });
    renderApp('/dashboard', fake.client);
    await screen.findByText('2.045');
    await userEvent.setup().selectOptions(screen.getAllByRole('combobox', { name: 'Unit aktif' })[0]!, 'unit-1');
    await waitFor(() => expect(counts).toHaveBeenLastCalledWith({ p_unit_id: 'unit-1' }, undefined));
  });
});
