import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { renderApp } from '../test/renderApp';
import { createFakeClient, makeProfile, makeSession } from '../test/fakeSupabase';
import type { Role } from './permissions';

function signedIn(role: Role) {
  return createFakeClient({ session: makeSession(), profile: makeProfile(role) });
}

describe('penjaga rute', () => {
  it('pengguna belum masuk diarahkan ke halaman Masuk', async () => {
    renderApp('/penerimaan', createFakeClient().client);
    expect(await screen.findByRole('heading', { name: 'Masuk' })).toBeInTheDocument();
  });

  it('akar "/" membuka Dashboard setelah masuk', async () => {
    renderApp('/', signedIn('PETUGAS').client);
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();
  });

  it('PIMPINAN yang membuka Penerimaan dialihkan ke Dashboard dengan pemberitahuan', async () => {
    renderApp('/penerimaan', signedIn('PIMPINAN').client);
    expect(await screen.findByText('Anda tidak memiliki akses ke Penerimaan Naskah.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Penerimaan Naskah' })).not.toBeInTheDocument();
  });

  it('PETUGAS yang membuka Master Log dialihkan ke Dashboard', async () => {
    renderApp('/master-log', signedIn('PETUGAS').client);
    expect(await screen.findByText('Anda tidak memiliki akses ke Master Log Perubahan.')).toBeInTheDocument();
  });

  it('PETUGAS yang membuka Pengaturan dialihkan ke Dashboard', async () => {
    renderApp('/pengaturan', signedIn('PETUGAS').client);
    expect(await screen.findByText('Anda tidak memiliki akses ke Pengaturan.')).toBeInTheDocument();
  });

  it('PETUGAS dapat membuka placeholder Peminjaman dengan info sprint', async () => {
    renderApp('/peminjaman', signedIn('PETUGAS').client);
    expect(await screen.findByRole('heading', { name: 'Peminjaman Arsip' })).toBeInTheDocument();
    expect(screen.getByText(/Sprint 4 — Peminjaman/)).toBeInTheDocument();
  });

  it('PIMPINAN tidak dapat membuka layar registrasi (Penerimaan, Registrasi, Alih Media, Cetak)', async () => {
    for (const path of ['/penerimaan', '/pemberkasan', '/alih-media', '/penerimaan/RCV-1/cetak']) {
      const { unmount } = renderApp(path, signedIn('PIMPINAN').client);
      expect(await screen.findByText(/Anda tidak memiliki akses ke/)).toBeInTheDocument();
      unmount();
    }
  });

  it('ADMIN_UNIT dapat membuka Master Log', async () => {
    renderApp('/master-log', signedIn('ADMIN_UNIT').client);
    expect(await screen.findByRole('heading', { name: 'Master Log Perubahan' })).toBeInTheDocument();
  });

  it('pengguna yang sudah masuk dan membuka /masuk diarahkan ke Dashboard', async () => {
    renderApp('/masuk', signedIn('PETUGAS').client);
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();
  });

  it('navigasi PIMPINAN tidak menampilkan modul operasional', async () => {
    renderApp('/dashboard', signedIn('PIMPINAN').client);
    await screen.findByRole('heading', { name: 'Dashboard', level: 1 });
    expect(screen.queryByRole('link', { name: /Penerimaan Naskah/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Peminjaman Arsip/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Pencarian Arsip|Cari/ }).length).toBeGreaterThan(0);
  });

  it('ADMIN_PUSAT melihat pemilih unit', async () => {
    renderApp('/dashboard', signedIn('ADMIN_PUSAT').client);
    expect(await screen.findByRole('combobox', { name: 'Unit aktif' })).toBeInTheDocument();
    expect(screen.getAllByText('Semua unit').length).toBeGreaterThan(0);
  });

  it('PETUGAS tidak melihat pemilih unit', async () => {
    renderApp('/dashboard', signedIn('PETUGAS').client);
    await screen.findByRole('heading', { name: 'Dashboard', level: 1 });
    expect(screen.queryByRole('combobox', { name: 'Unit aktif' })).not.toBeInTheDocument();
  });

  it('rute tak dikenal menampilkan halaman tidak ditemukan', async () => {
    renderApp('/tidak-ada', signedIn('PETUGAS').client);
    expect(await screen.findByRole('heading', { name: 'Halaman tidak ditemukan' })).toBeInTheDocument();
  });
});
