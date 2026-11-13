import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../test/renderApp';
import { createFakeClient, makeProfile, makeSession, UNIT } from '../test/fakeSupabase';

describe('akun belum diaktifkan', () => {
  it('tanpa profil: tampil layar "akun belum diaktifkan" dan bisa keluar', async () => {
    const fake = createFakeClient({ session: makeSession(), profile: null });
    renderApp('/dashboard', fake.client);
    expect(await screen.findByRole('heading', { name: 'Akun belum diaktifkan' })).toBeInTheDocument();
    expect(screen.getByText(/Hubungi admin unit/)).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Keluar' }));
    expect(fake.auth.signOut).toHaveBeenCalled();
    expect(await screen.findByRole('heading', { name: 'Masuk' })).toBeInTheDocument();
  });

  it('profil active=false: layar yang sama', async () => {
    const fake = createFakeClient({ session: makeSession(), profile: makeProfile('PETUGAS', { active: false }) });
    renderApp('/cari', fake.client);
    expect(await screen.findByRole('heading', { name: 'Akun belum diaktifkan' })).toBeInTheDocument();
    expect(screen.getByText(/sedang nonaktif/)).toBeInTheDocument();
  });

  it('peran unit tanpa unit_id: layar yang sama', async () => {
    const fake = createFakeClient({ session: makeSession(), profile: makeProfile('PETUGAS', { unit_id: null }) });
    renderApp('/dashboard', fake.client);
    expect(await screen.findByRole('heading', { name: 'Akun belum diaktifkan' })).toBeInTheDocument();
  });

  it('unit nonaktif: diarahkan ke Admin Pusat', async () => {
    const fake = createFakeClient({ session: makeSession(), profile: makeProfile('PETUGAS'), unit: { ...UNIT, active: false } });
    renderApp('/dashboard', fake.client);
    expect(await screen.findByRole('heading', { name: 'Unit sedang nonaktif' })).toBeInTheDocument();
  });

  it('gagal memuat profil: pesan dapat ditindaklanjuti + coba lagi', async () => {
    const fake = createFakeClient({ session: makeSession(), profileError: { message: 'Failed to fetch' } });
    renderApp('/dashboard', fake.client);
    expect(await screen.findByRole('heading', { name: 'Profil tidak dapat dimuat' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Periksa koneksi internet Anda');
    expect(screen.getByRole('button', { name: 'Coba lagi' })).toBeInTheDocument();
  });
});
