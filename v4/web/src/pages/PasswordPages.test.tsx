import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../test/renderApp';
import { createFakeClient, makeProfile, makeSession } from '../test/fakeSupabase';

describe('lupa kata sandi', () => {
  it('mengirim email pemulihan dengan redirect ke /atur-sandi', async () => {
    const fake = createFakeClient();
    renderApp('/lupa-sandi', fake.client);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Email'), 'petugas@uinsa.ac.id');
    await user.click(screen.getByRole('button', { name: 'Kirim tautan' }));
    expect(await screen.findByRole('heading', { name: 'Periksa email Anda' })).toBeInTheDocument();
    expect(fake.auth.resetPasswordForEmail).toHaveBeenCalledWith('petugas@uinsa.ac.id', { redirectTo: `${window.location.origin}/atur-sandi` });
  });
});

describe('atur kata sandi (tautan pemulihan)', () => {
  it('tanpa sesi pemulihan: tautan dinyatakan tidak valid', async () => {
    renderApp('/atur-sandi', createFakeClient().client);
    expect(await screen.findByRole('heading', { name: 'Tautan tidak dapat dipakai' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Minta tautan baru' })).toHaveAttribute('href', '/lupa-sandi');
  });

  it('dengan sesi pemulihan: menyimpan kata sandi baru', async () => {
    const fake = createFakeClient({ session: makeSession(), profile: makeProfile('PETUGAS') });
    renderApp('/atur-sandi', fake.client, { initialRecovery: true });
    expect(await screen.findByRole('heading', { name: 'Buat kata sandi baru' })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Kata sandi baru'), 'BaruSekali1');
    await user.type(screen.getByLabelText('Ulangi kata sandi baru'), 'BaruSekali1');
    await user.click(screen.getByRole('button', { name: 'Simpan kata sandi' }));
    expect(await screen.findByRole('heading', { name: 'Kata sandi diperbarui' })).toBeInTheDocument();
    expect(fake.auth.updateUser).toHaveBeenCalledWith({ password: 'BaruSekali1' });
  });
});

describe('deteksi tautan pemulihan', () => {
  it('mengenali fragmen type=recovery', async () => {
    const { detectRecoveryLink } = await import('../lib/supabase');
    expect(detectRecoveryLink({ hash: '#access_token=a&type=recovery', search: '' })).toBe(true);
    expect(detectRecoveryLink({ hash: '#access_token=a&type=signup', search: '' })).toBe(false);
    expect(detectRecoveryLink({ hash: '', search: '' })).toBe(false);
  });
});

describe('ubah kata sandi sendiri', () => {
  it('memvalidasi konfirmasi dan panjang minimal', async () => {
    const fake = createFakeClient({ session: makeSession(), profile: makeProfile('PIMPINAN') });
    renderApp('/akun/kata-sandi', fake.client);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Kata sandi saat ini'), 'Lama12345');
    await user.type(screen.getByLabelText('Kata sandi baru'), 'abc');
    await user.type(screen.getByLabelText('Ulangi kata sandi baru'), 'abd');
    await user.click(screen.getByRole('button', { name: 'Simpan kata sandi' }));
    expect(screen.getByText('Kata sandi minimal 8 karakter.')).toBeInTheDocument();
    expect(screen.getByText(/Kedua kata sandi tidak sama/)).toBeInTheDocument();
    expect(fake.auth.updateUser).not.toHaveBeenCalled();
  });

  it('menolak kata sandi saat ini yang salah', async () => {
    const fake = createFakeClient({
      session: makeSession(),
      profile: makeProfile('PETUGAS'),
      signInError: (_e, p) => (p === 'Lama12345' ? null : { message: 'Invalid login credentials', code: 'invalid_credentials' }),
    });
    renderApp('/akun/kata-sandi', fake.client);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Kata sandi saat ini'), 'Keliru999');
    await user.type(screen.getByLabelText('Kata sandi baru'), 'BaruSekali1');
    await user.type(screen.getByLabelText('Ulangi kata sandi baru'), 'BaruSekali1');
    await user.click(screen.getByRole('button', { name: 'Simpan kata sandi' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Kata sandi saat ini salah.');
    expect(fake.auth.updateUser).not.toHaveBeenCalled();
  });
});
