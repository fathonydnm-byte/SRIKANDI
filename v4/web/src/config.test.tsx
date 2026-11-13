import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { readConfig } from './config';
import { App } from './App';

describe('readConfig', () => {
  it('melaporkan variabel yang hilang', () => {
    expect(readConfig({})).toEqual({ ok: false, missing: ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'], invalid: [] });
  });
  it('menolak URL non-https selain localhost', () => {
    const c = readConfig({ VITE_SUPABASE_URL: 'http://contoh.supabase.co', VITE_SUPABASE_ANON_KEY: 'x' });
    expect(c).toEqual({ ok: false, missing: [], invalid: ['VITE_SUPABASE_URL'] });
  });
  it('menerima konfigurasi valid dan membuang garis miring akhir', () => {
    expect(readConfig({ VITE_SUPABASE_URL: 'https://abc.supabase.co/', VITE_SUPABASE_ANON_KEY: ' key ' })).toEqual({
      ok: true,
      supabaseUrl: 'https://abc.supabase.co',
      supabaseAnonKey: 'key',
    });
  });
  it('mengizinkan http://localhost untuk Supabase lokal', () => {
    expect(readConfig({ VITE_SUPABASE_URL: 'http://127.0.0.1:54321', VITE_SUPABASE_ANON_KEY: 'k' }).ok).toBe(true);
  });
});

describe('layar konfigurasi hilang', () => {
  it('tampil tanpa crash dan tanpa membuat klien Supabase', () => {
    const createClient = vi.fn();
    render(
      <MemoryRouter>
        <App config={readConfig({ VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: undefined })} createClient={createClient} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Konfigurasi aplikasi belum lengkap' })).toBeInTheDocument();
    expect(screen.getByText('VITE_SUPABASE_URL')).toBeInTheDocument();
    expect(screen.getByText('VITE_SUPABASE_ANON_KEY')).toBeInTheDocument();
    expect(screen.getByText(/laporkan pesan ini ke Admin Pusat/)).toBeInTheDocument();
    expect(createClient).not.toHaveBeenCalled();
  });
});
