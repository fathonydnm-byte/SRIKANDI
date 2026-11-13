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
    expect(await screen.findByRole('heading', { name: /Selamat (pagi|siang|sore|malam), Siti Aminah/ })).toBeInTheDocument();
  });

  it('PIMPINAN yang membuka Penerimaan dialihkan ke Dashboard dengan pemberitahuan', async () => {
    renderApp('/penerimaan', signedIn('PIMPINAN').client);
    expect(await screen.findByText('Anda tidak memiliki akses ke Penerimaan.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Selamat .*Siti Aminah/ })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Penerimaan' })).not.toBeInTheDocument();
  });

  it('PETUGAS yang membuka Master Log dialihkan ke Dashboard', async () => {
    renderApp('/master-log', signedIn('PETUGAS').client);
    expect(await screen.findByText('Anda tidak memiliki akses ke Master Log.')).toBeInTheDocument();
  });

  it('PETUGAS yang membuka Pengaturan dialihkan ke Dashboard', async () => {
    renderApp('/pengaturan', signedIn('PETUGAS').client);
    expect(await screen.findByText('Anda tidak memiliki akses ke Pengaturan.')).toBeInTheDocument();
  });

  it('PETUGAS dapat membuka placeholder Penerimaan dengan info sprint', async () => {
    renderApp('/penerimaan', signedIn('PETUGAS').client);
    expect(await screen.findByRole('heading', { name: 'Penerimaan' })).toBeInTheDocument();
    expect(screen.getByText(/Sprint 2 — Registrasi/)).toBeInTheDocument();
  });

  it('ADMIN_UNIT dapat membuka Master Log', async () => {
    renderApp('/master-log', signedIn('ADMIN_UNIT').client);
    expect(await screen.findByRole('heading', { name: 'Master Log' })).toBeInTheDocument();
  });

  it('pengguna yang sudah masuk dan membuka /masuk diarahkan ke Dashboard', async () => {
    renderApp('/masuk', signedIn('PETUGAS').client);
    expect(await screen.findByRole('heading', { name: /Selamat .*Siti Aminah/ })).toBeInTheDocument();
  });

  it('navigasi PIMPINAN tidak menampilkan modul operasional', async () => {
    renderApp('/dashboard', signedIn('PIMPINAN').client);
    await screen.findByRole('heading', { name: /Selamat/ });
    expect(screen.queryByRole('link', { name: /Penerimaan/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Peminjaman/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Cari Arsip|Cari/ }).length).toBeGreaterThan(0);
  });

  it('ADMIN_PUSAT melihat pemilih unit', async () => {
    renderApp('/dashboard', signedIn('ADMIN_PUSAT').client);
    expect(await screen.findByRole('combobox', { name: 'Unit aktif' })).toBeInTheDocument();
    expect(screen.getAllByText('Semua unit').length).toBeGreaterThan(0);
  });

  it('PETUGAS tidak melihat pemilih unit', async () => {
    renderApp('/dashboard', signedIn('PETUGAS').client);
    await screen.findByRole('heading', { name: /Selamat/ });
    expect(screen.queryByRole('combobox', { name: 'Unit aktif' })).not.toBeInTheDocument();
  });

  it('rute tak dikenal menampilkan halaman tidak ditemukan', async () => {
    renderApp('/tidak-ada', signedIn('PETUGAS').client);
    expect(await screen.findByRole('heading', { name: 'Halaman tidak ditemukan' })).toBeInTheDocument();
  });
});
