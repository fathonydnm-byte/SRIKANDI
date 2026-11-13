import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../test/renderApp';
import { createFakeClient, makeProfile } from '../test/fakeSupabase';

async function fill(email: string, password: string) {
  const user = userEvent.setup();
  if (email) await user.type(screen.getByLabelText('Email'), email);
  if (password) await user.type(screen.getByLabelText('Kata sandi'), password);
  await user.click(screen.getByRole('button', { name: 'Masuk' }));
  return user;
}

describe('halaman Masuk', () => {
  it('tidak menampilkan pendaftaran mandiri', async () => {
    renderApp('/masuk', createFakeClient().client);
    await screen.findByRole('heading', { name: 'Masuk' });
    expect(screen.queryByText(/daftar/i)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Lupa kata sandi?' })).toHaveAttribute('href', '/lupa-sandi');
  });

  it('memvalidasi isian kosong tanpa memanggil server', async () => {
    const fake = createFakeClient();
    renderApp('/masuk', fake.client);
    await screen.findByRole('heading', { name: 'Masuk' });
    await fill('', '');
    expect(screen.getByText('Email wajib diisi.')).toBeInTheDocument();
    expect(screen.getByText('Kata sandi wajib diisi.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Email')).toHaveFocus();
    expect(fake.auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it('memvalidasi format email', async () => {
    const fake = createFakeClient();
    renderApp('/masuk', fake.client);
    await screen.findByRole('heading', { name: 'Masuk' });
    await fill('bukan-email', 'rahasia123');
    expect(screen.getByText(/Format email tidak valid/)).toBeInTheDocument();
    expect(fake.auth.signInWithPassword).not.toHaveBeenCalled();
  });

  it('menampilkan pesan yang dapat ditindaklanjuti untuk kredensial salah', async () => {
    const fake = createFakeClient({ signInError: { message: 'Invalid login credentials', code: 'invalid_credentials', status: 400 } });
    renderApp('/masuk', fake.client);
    await screen.findByRole('heading', { name: 'Masuk' });
    await fill('petugas@uinsa.ac.id', 'salah123');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Email atau kata sandi salah.');
    expect(alert).toHaveTextContent('Lupa kata sandi?');
    expect(alert).not.toHaveTextContent('Invalid login credentials');
    expect(screen.getByRole('button', { name: 'Masuk' })).toBeEnabled();
  });

  it('menampilkan pesan jaringan saat server tidak terjangkau', async () => {
    const fake = createFakeClient({ signInError: { message: 'Failed to fetch', name: 'AuthRetryableFetchError', status: 0 } });
    renderApp('/masuk', fake.client);
    await screen.findByRole('heading', { name: 'Masuk' });
    await fill('petugas@uinsa.ac.id', 'rahasia123');
    expect(await screen.findByRole('alert')).toHaveTextContent('Tidak dapat terhubung ke server. Periksa koneksi internet Anda');
  });

  it('masuk berhasil membuka Dashboard', async () => {
    const fake = createFakeClient({ profile: makeProfile('PETUGAS') });
    renderApp('/masuk', fake.client);
    await screen.findByRole('heading', { name: 'Masuk' });
    await fill(' petugas@uinsa.ac.id ', 'rahasia123');
    expect(fake.auth.signInWithPassword).toHaveBeenCalledWith({ email: 'petugas@uinsa.ac.id', password: 'rahasia123' });
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();
    expect(screen.getAllByText('Petugas Arsip').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Biro Administrasi Umum').length).toBeGreaterThan(0);
  });

  it('tombol tampilkan kata sandi mengubah jenis input', async () => {
    renderApp('/masuk', createFakeClient().client);
    await screen.findByRole('heading', { name: 'Masuk' });
    const user = userEvent.setup();
    const input = screen.getByLabelText('Kata sandi');
    expect(input).toHaveAttribute('type', 'password');
    await user.click(screen.getByRole('button', { name: 'Tampilkan kata sandi' }));
    expect(input).toHaveAttribute('type', 'text');
  });
});
