import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../../test/renderApp';
import { createFakeClient, makeProfile, makeSession, UNIT, type RpcHandler } from '../../test/fakeSupabase';
import type { UserRow } from '../../lib/usersApi';
import type { Role } from '../../auth/permissions';

const UNIT_B = { id: 'unit-2', code: 'PTIPD', name: 'Pusat TIPD', active: true };
const UNIT_OFF = { id: 'unit-3', code: 'LAMA', name: 'Unit Lama', active: false };

function row(over: Partial<UserRow> & Pick<UserRow, 'user_id' | 'full_name' | 'role'>): UserRow {
  return {
    email: `${over.user_id}@uinsa.ac.id`, unit_id: over.role === 'ADMIN_PUSAT' ? null : UNIT.id, unit_code: over.role === 'ADMIN_PUSAT' ? null : UNIT.code,
    unit_name: over.role === 'ADMIN_PUSAT' ? null : UNIT.name, active: true, must_change_password: false, created_at: '2026-11-01T00:00:00Z', updated_at: null, ...over,
  };
}

const ME = row({ user_id: 'user-1', full_name: 'Siti Aminah', role: 'ADMIN_UNIT' });
const USERS: UserRow[] = [
  ME,
  row({ user_id: 'u-budi', full_name: 'Budi Santoso', role: 'PETUGAS' }),
  row({ user_id: 'u-citra', full_name: 'Citra Dewi', role: 'PIMPINAN', active: false }),
  row({ user_id: 'u-dedi', full_name: 'Dedi Admin', role: 'ADMIN_UNIT' }),
  row({ user_id: 'u-eka', full_name: 'Eka Baru', role: 'PETUGAS', must_change_password: true }),
];
const PUSAT_USERS: UserRow[] = [
  row({ user_id: 'user-1', full_name: 'Siti Aminah', role: 'ADMIN_PUSAT' }),
  ...USERS.slice(1),
  row({ user_id: 'u-fani', full_name: 'Fani Tipd', role: 'PETUGAS', unit_id: UNIT_B.id, unit_code: UNIT_B.code, unit_name: UNIT_B.name }),
];

function setup(role: Role, users: UserRow[], extra: { rpc?: Record<string, RpcHandler>; profileOver?: Partial<ReturnType<typeof makeProfile>> } = {}) {
  const fake = createFakeClient({
    session: makeSession('user-1', 'siti@uinsa.ac.id'),
    profile: makeProfile(role, extra.profileOver),
    units: [UNIT, UNIT_B, UNIT_OFF],
    rpc: { user_list: () => ({ data: users, error: null }), password_changed: () => ({ data: { ok: true, changed: false }, error: null }), ...extra.rpc },
  });
  return fake;
}

function mockFetch(handler: (body: Record<string, unknown>) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>) {
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: String(url), body, headers: init?.headers as Record<string, string> });
    const r = await handler(body);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fn);
  return { fn, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const optionLabels = (select: HTMLElement) => within(select).getAllByRole('option').map((o) => o.textContent);

describe('daftar pengguna', () => {
  it('Admin Unit melihat daftar unitnya, status, dan hanya tombol kelola yang berhak', async () => {
    renderApp('/pengguna', setup('ADMIN_UNIT', USERS).client);
    expect(await screen.findByRole('heading', { name: 'Kelola Pengguna', level: 1 })).toBeInTheDocument();
    expect(await screen.findByText('Budi Santoso')).toBeInTheDocument();
    expect(screen.getByText('5 pengguna')).toBeInTheDocument();
    expect(screen.getByText('Nonaktif', { selector: 'span.badge-pill' })).toBeInTheDocument();
    expect(screen.getByText('Belum ganti kata sandi')).toBeInTheDocument();
    expect(screen.getByText('Anda')).toBeInTheDocument();
    // peringkat bawah: bisa diubah dan diatur ulang
    expect(screen.getByRole('button', { name: 'Ubah Budi Santoso' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Atur ulang kata sandi Budi Santoso' })).toBeInTheDocument();
    // admin sejawat dan dirinya sendiri: tidak ada tombol kelola
    expect(screen.queryByRole('button', { name: 'Ubah Dedi Admin' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ubah Siti Aminah' })).not.toBeInTheDocument();
    // Admin Unit tidak memilih unit
    expect(screen.queryByLabelText('Unit')).not.toBeInTheDocument();
  });

  it('filter teks, peran, status, dan (Admin Pusat) unit', async () => {
    renderApp('/pengguna', setup('ADMIN_PUSAT', PUSAT_USERS).client);
    await screen.findByText('Budi Santoso');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Cari nama atau email'), 'dewi');
    expect(screen.getByText('1 dari 6 pengguna')).toBeInTheDocument();
    expect(screen.getByText('Citra Dewi')).toBeInTheDocument();
    expect(screen.queryByText('Budi Santoso')).not.toBeInTheDocument();
    await user.clear(screen.getByLabelText('Cari nama atau email'));
    await user.selectOptions(screen.getByLabelText('Status'), 'nonaktif');
    expect(screen.getByText('1 dari 6 pengguna')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Status'), '');
    await user.selectOptions(screen.getByLabelText('Peran'), 'PETUGAS');
    expect(screen.getByText('3 dari 6 pengguna')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Unit'), UNIT_B.id);
    expect(screen.getByText('1 dari 6 pengguna')).toBeInTheDocument();
    expect(screen.getByText('Fani Tipd')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Cari nama atau email'), 'zzz');
    expect(screen.getByText('Tidak ada pengguna yang cocok')).toBeInTheDocument();
  });

  it('PETUGAS dan PIMPINAN tidak dapat membuka halaman (penjaga rute)', async () => {
    for (const role of ['PETUGAS', 'PIMPINAN'] as const) {
      const { unmount } = renderApp('/pengguna', setup(role, []).client);
      expect(await screen.findByText('Anda tidak memiliki akses ke Kelola Pengguna.')).toBeInTheDocument();
      expect(screen.queryByRole('heading', { name: 'Kelola Pengguna' })).not.toBeInTheDocument();
      unmount();
    }
  });

  it('modul ada di grup Keamanan & Audit untuk Admin Unit dan Admin Pusat saja', async () => {
    const { unmount } = renderApp('/dashboard', setup('ADMIN_UNIT', USERS).client);
    expect((await screen.findAllByRole('link', { name: /Kelola Pengguna/ }))[0]).toHaveAttribute('href', '/pengguna');
    unmount();
    renderApp('/dashboard', setup('PETUGAS', []).client);
    await screen.findByRole('heading', { name: 'Dashboard', level: 1 });
    expect(screen.queryByRole('link', { name: /Kelola Pengguna/ })).not.toBeInTheDocument();
  });
});

describe('buat pengguna: pilihan peran dibatasi menurut peran pembuat', () => {
  it('Admin Unit: hanya Petugas Arsip dan Pimpinan; unit tetap unitnya', async () => {
    renderApp('/pengguna', setup('ADMIN_UNIT', USERS).client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '+ Tambah pengguna' }));
    const dialog = await screen.findByRole('dialog', { name: 'Tambah pengguna' });
    expect(optionLabels(within(dialog).getByLabelText('Peran'))).toEqual(['Petugas Arsip', 'Pimpinan']);
    expect(within(dialog).getByTestId('fixed-unit')).toHaveTextContent('BAU');
    expect(within(dialog).queryByLabelText('Unit')).not.toBeInTheDocument();
  });

  it('Admin Pusat: keempat peran, memilih unit (hanya unit aktif); Admin Pusat tanpa unit', async () => {
    renderApp('/pengguna', setup('ADMIN_PUSAT', PUSAT_USERS).client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '+ Tambah pengguna' }));
    const dialog = await screen.findByRole('dialog', { name: 'Tambah pengguna' });
    expect(optionLabels(within(dialog).getByLabelText('Peran'))).toEqual(['Admin Pusat', 'Admin Unit', 'Petugas Arsip', 'Pimpinan']);
    expect(optionLabels(within(dialog).getByLabelText('Unit'))).toEqual(['Pilih unit…', 'BAU · Biro Administrasi Umum', 'PTIPD · Pusat TIPD']);
    await user.selectOptions(within(dialog).getByLabelText('Peran'), 'ADMIN_PUSAT');
    expect(within(dialog).queryByLabelText('Unit')).not.toBeInTheDocument();
    expect(within(dialog).getByText(/tanpa unit tetap/)).toBeInTheDocument();
  });
});

describe('buat pengguna: kirim dan kata sandi sementara', () => {
  it('mengirim isian sah, menampilkan kata sandi sementara SEKALI dengan tombol salin, lalu hilang saat ditutup', async () => {
    const fake = setup('ADMIN_UNIT', USERS);
    const { calls } = mockFetch(() => ({ status: 200, body: { ok: true, userId: 'u-new', created: true, replayed: false } }));
    renderApp('/pengguna', fake.client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '+ Tambah pengguna' }));
    const dialog = await screen.findByRole('dialog', { name: 'Tambah pengguna' });
    await user.type(within(dialog).getByLabelText('Nama lengkap'), '  Gita   Lestari ');
    await user.type(within(dialog).getByLabelText('Email'), 'Gita@UINSA.ac.id');
    await user.click(within(dialog).getByRole('button', { name: 'Buat akun' }));

    const result = await screen.findByRole('dialog', { name: 'Akun berhasil dibuat' });
    expect(calls).toHaveLength(1);
    const sent = calls[0]!;
    expect(sent.url).toBe('/api/admin/users');
    expect(sent.headers.Authorization).toBe('Bearer access');
    expect(sent.body).toMatchObject({ action: 'create', email: 'gita@uinsa.ac.id', fullName: 'Gita Lestari', role: 'PETUGAS', unitId: UNIT.id });
    const password = String(sent.body.tempPassword);
    expect(password.length).toBeGreaterThanOrEqual(10);
    expect(password.toLowerCase()).not.toContain('gita');
    expect(String(sent.body.requestId)).toMatch(/^[0-9a-f-]{36}$/);

    expect(within(result).getByTestId('temp-password')).toHaveTextContent(password);
    expect(within(result).getByText(/secara langsung atau lewat pesan pribadi/)).toBeInTheDocument();
    expect(within(result).getByText(/hanya tampil sekali/)).toBeInTheDocument();
    await user.click(within(result).getByRole('button', { name: 'Salin kata sandi' }));
    expect(await navigator.clipboard.readText()).toBe(password);
    expect(await within(result).findByText('Tersalin.')).toBeInTheDocument();

    await user.click(within(result).getByRole('button', { name: 'Selesai, tutup' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByText(password)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(password);
    // tidak disimpan di storage browser
    for (const store of [window.localStorage, window.sessionStorage]) {
      expect(JSON.stringify({ ...store })).not.toContain(password);
    }
    // dan tidak muncul lagi bila sheet dibuka kembali
    await user.click(screen.getByRole('button', { name: '+ Tambah pengguna' }));
    expect(document.body.textContent).not.toContain(password);
    // daftar dimuat ulang setelah berhasil
    expect(fake.rpc.mock.calls.filter(([name]) => name === 'user_list').length).toBeGreaterThanOrEqual(2);
  });

  it('klik ganda: satu permintaan; setelah gagal, kirim ulang memakai requestId yang sama; ubah isian = id baru', async () => {
    let n = 0;
    const gate: { release?: () => void } = {};
    const { calls, fn } = mockFetch(async () => {
      n++;
      if (n === 1) await new Promise<void>((r) => { gate.release = r; });
      if (n <= 2) return { status: 502, body: { ok: false, code: 'UPSTREAM', message: 'Layanan sedang sibuk.' } };
      return { status: 200, body: { ok: true, userId: 'u-new', created: true, replayed: false } };
    });
    renderApp('/pengguna', setup('ADMIN_UNIT', USERS).client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '+ Tambah pengguna' }));
    const dialog = await screen.findByRole('dialog', { name: 'Tambah pengguna' });
    await user.type(within(dialog).getByLabelText('Nama lengkap'), 'Hana');
    await user.type(within(dialog).getByLabelText('Email'), 'hana@uinsa.ac.id');
    const submit = within(dialog).getByRole('button', { name: 'Buat akun' });
    await user.click(submit);
    await user.click(within(dialog).getByRole('button', { name: 'Membuat akun…' })); // tombol sudah nonaktif
    await user.keyboard('{Enter}');
    expect(fn).toHaveBeenCalledTimes(1);
    gate.release?.();
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Layanan sedang sibuk.');

    await user.click(within(dialog).getByRole('button', { name: 'Buat akun' })); // coba lagi: id sama
    await waitFor(() => expect(fn).toHaveBeenCalledTimes(2));
    expect(calls[1]!.body.requestId).toBe(calls[0]!.body.requestId);
    await within(dialog).findByRole('alert');

    await user.type(within(dialog).getByLabelText('Nama lengkap'), ' Putri'); // isian berubah
    await user.click(within(dialog).getByRole('button', { name: 'Buat akun' }));
    await screen.findByRole('dialog', { name: 'Akun berhasil dibuat' });
    expect(calls[2]!.body.requestId).not.toBe(calls[0]!.body.requestId);
    expect(calls[2]!.body.fullName).toBe('Hana Putri');
  });

  it('validasi sisi layar dan pesan server yang dapat ditindaklanjuti', async () => {
    const { fn } = mockFetch(() => ({ status: 403, body: { ok: false, code: 'FORBIDDEN', message: 'Admin Unit hanya dapat membuat akun Petugas Arsip dan Pimpinan.' } }));
    renderApp('/pengguna', setup('ADMIN_UNIT', USERS).client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '+ Tambah pengguna' }));
    const dialog = await screen.findByRole('dialog', { name: 'Tambah pengguna' });
    await user.click(within(dialog).getByRole('button', { name: 'Buat akun' }));
    expect(within(dialog).getByText('Nama lengkap wajib diisi.')).toBeInTheDocument();
    expect(within(dialog).getByText('Email wajib diisi.')).toBeInTheDocument();
    expect(fn).not.toHaveBeenCalled();
    await user.type(within(dialog).getByLabelText('Nama lengkap'), 'Ina');
    await user.type(within(dialog).getByLabelText('Email'), 'ina@uinsa.ac.id');
    await user.click(within(dialog).getByRole('button', { name: 'Buat akun' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Admin Unit hanya dapat membuat akun Petugas Arsip dan Pimpinan.');
    expect(alert).toHaveTextContent('hubungi Admin Pusat');
    expect(screen.queryByTestId('temp-password')).not.toBeInTheDocument();
  });

  it('Admin Pusat membuat Admin Pusat (tanpa unit) dan Admin Unit (dengan unit)', async () => {
    const { calls } = mockFetch(() => ({ status: 200, body: { ok: true, userId: 'u-new', created: true, replayed: false } }));
    renderApp('/pengguna', setup('ADMIN_PUSAT', PUSAT_USERS).client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '+ Tambah pengguna' }));
    let dialog = await screen.findByRole('dialog', { name: 'Tambah pengguna' });
    await user.type(within(dialog).getByLabelText('Nama lengkap'), 'Joko');
    await user.type(within(dialog).getByLabelText('Email'), 'joko@uinsa.ac.id');
    await user.selectOptions(within(dialog).getByLabelText('Peran'), 'ADMIN_UNIT');
    await user.click(within(dialog).getByRole('button', { name: 'Buat akun' }));
    expect(within(dialog).getByText('Pilih unit.')).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText('Unit'), UNIT_B.id);
    await user.click(within(dialog).getByRole('button', { name: 'Buat akun' }));
    await screen.findByRole('dialog', { name: 'Akun berhasil dibuat' });
    expect(calls[0]!.body).toMatchObject({ role: 'ADMIN_UNIT', unitId: UNIT_B.id });
    await user.click(screen.getByRole('button', { name: 'Selesai, tutup' }));

    await user.click(screen.getByRole('button', { name: '+ Tambah pengguna' }));
    dialog = await screen.findByRole('dialog', { name: 'Tambah pengguna' });
    await user.type(within(dialog).getByLabelText('Nama lengkap'), 'Kiki');
    await user.type(within(dialog).getByLabelText('Email'), 'kiki@uinsa.ac.id');
    await user.selectOptions(within(dialog).getByLabelText('Peran'), 'ADMIN_PUSAT');
    await user.click(within(dialog).getByRole('button', { name: 'Buat akun' }));
    await screen.findByRole('dialog', { name: 'Akun berhasil dibuat' });
    expect(calls[1]!.body).toMatchObject({ role: 'ADMIN_PUSAT', unitId: null });
  });
});

describe('ubah dan atur ulang', () => {
  it('ubah: hanya isian yang berubah yang dikirim; menonaktifkan memberi peringatan', async () => {
    const { calls } = mockFetch(() => ({ status: 200, body: { ok: true, userId: 'u-budi', created: false, replayed: false } }));
    renderApp('/pengguna', setup('ADMIN_UNIT', USERS).client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Ubah Budi Santoso' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ubah pengguna' });
    expect(optionLabels(within(dialog).getByLabelText('Peran'))).toEqual(['Petugas Arsip', 'Pimpinan']);
    await user.click(within(dialog).getByRole('button', { name: 'Simpan perubahan' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Belum ada yang diubah.');
    expect(calls).toHaveLength(0);
    await user.selectOptions(within(dialog).getByLabelText('Peran'), 'PIMPINAN');
    await user.click(within(dialog).getByLabelText('Akun aktif'));
    expect(within(dialog).getByText(/tidak akan dapat masuk/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Simpan perubahan' }));
    await within(dialog).findByText('Perubahan tersimpan.');
    expect(calls[0]!.body).toEqual({ action: 'update', requestId: calls[0]!.body.requestId, userId: 'u-budi', role: 'PIMPINAN', active: false });
  });

  it('Admin Pusat dapat memindah unit; Admin Unit tidak dapat memilih unit lain', async () => {
    const { calls } = mockFetch(() => ({ status: 200, body: { ok: true, userId: 'u-budi', created: false, replayed: false } }));
    const first = renderApp('/pengguna', setup('ADMIN_PUSAT', PUSAT_USERS).client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Ubah Budi Santoso' }));
    let dialog = await screen.findByRole('dialog', { name: 'Ubah pengguna' });
    await user.selectOptions(within(dialog).getByLabelText('Unit'), UNIT_B.id);
    await user.click(within(dialog).getByRole('button', { name: 'Simpan perubahan' }));
    await within(dialog).findByText('Perubahan tersimpan.');
    expect(calls[0]!.body).toMatchObject({ userId: 'u-budi', unitId: UNIT_B.id });
    expect(calls[0]!.body).not.toHaveProperty('role');
    first.unmount();
    renderApp('/pengguna', setup('ADMIN_UNIT', USERS).client);
    await user.click(await screen.findByRole('button', { name: 'Ubah Budi Santoso' }));
    dialog = await screen.findByRole('dialog', { name: 'Ubah pengguna' });
    expect(within(dialog).getByLabelText('Unit')).toBeDisabled();
  });

  it('akun sendiri (Admin Pusat): peran, unit, dan status terkunci', async () => {
    renderApp('/pengguna', setup('ADMIN_PUSAT', PUSAT_USERS).client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Ubah Siti Aminah' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ubah pengguna' });
    expect(within(dialog).getByLabelText('Peran')).toBeDisabled();
    expect(within(dialog).getByLabelText('Akun aktif')).toBeDisabled();
    expect(within(dialog).getByText(/tidak dapat mengubah peran, unit, atau status akun Anda sendiri/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Atur ulang kata sandi Siti Aminah' })).not.toBeInTheDocument();
  });

  it('atur ulang kata sandi: tampil sekali, tidak ada di respons server', async () => {
    const { calls } = mockFetch(() => ({ status: 200, body: { ok: true, userId: 'u-budi', created: false, replayed: false } }));
    renderApp('/pengguna', setup('ADMIN_UNIT', USERS).client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Atur ulang kata sandi Budi Santoso' }));
    const dialog = await screen.findByRole('dialog', { name: 'Atur ulang kata sandi' });
    await user.click(within(dialog).getByRole('button', { name: 'Buat kata sandi sementara' }));
    const result = await screen.findByRole('dialog', { name: 'Kata sandi sementara baru' });
    expect(calls[0]!.body).toMatchObject({ action: 'reset-password', userId: 'u-budi' });
    const password = String(calls[0]!.body.tempPassword);
    expect(within(result).getByTestId('temp-password')).toHaveTextContent(password);
    await user.click(within(result).getByRole('button', { name: 'Selesai, tutup' }));
    expect(document.body.textContent).not.toContain(password);
  });
});

describe('wajib ganti kata sandi', () => {
  const forced = () => {
    const profile = makeProfile('PETUGAS', { must_change_password: true });
    const fake = createFakeClient({
      session: makeSession('user-1', 'siti@uinsa.ac.id'),
      profile,
      rpc: {
        password_changed: () => {
          profile.must_change_password = false;
          return { data: { ok: true, changed: true }, error: null };
        },
      },
    });
    return { fake, profile };
  };

  it.each(['/dashboard', '/cari', '/penerimaan', '/pengguna', '/master-log', '/', '/rute-tak-dikenal'])(
    'rute %s diarahkan ke Ubah kata sandi dan tidak ada menu',
    async (path) => {
      renderApp(path, forced().fake.client);
      expect(await screen.findByRole('heading', { name: 'Ganti kata sandi sementara' })).toBeInTheDocument();
      expect(screen.getByTestId('location')).toHaveTextContent('/akun/kata-sandi');
      expect(screen.getByText(/masuk dengan kata sandi sementara dari admin/)).toBeInTheDocument();
      expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /Dashboard/ })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Keluar/ })).toBeInTheDocument();
    },
  );

  it('setelah kata sandi diganti: password_changed dipanggil, penanda hilang, aplikasi terbuka', async () => {
    const { fake } = forced();
    renderApp('/dashboard', fake.client);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Kata sandi saat ini'), 'Sementara-123');
    await user.type(screen.getByLabelText('Kata sandi baru'), 'BaruSekali1');
    await user.type(screen.getByLabelText('Ulangi kata sandi baru'), 'BaruSekali1');
    await user.click(screen.getByRole('button', { name: 'Simpan kata sandi' }));
    expect(await screen.findByText(/Kata sandi berhasil diubah/)).toBeInTheDocument();
    expect(fake.auth.updateUser).toHaveBeenCalledWith({ password: 'BaruSekali1' });
    expect(fake.rpc).toHaveBeenCalledWith('password_changed');
    const order = [fake.auth.updateUser.mock.invocationCallOrder[0]!, fake.rpc.mock.invocationCallOrder.at(-1)!];
    expect(order[0]).toBeLessThan(order[1]!);
    const go = await screen.findByRole('link', { name: 'Lanjut ke aplikasi' });
    await user.click(go);
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/dashboard');
  });

  it('bila server menolak (kata sandi belum benar-benar berubah), pengguna tetap di layar wajib-ganti dengan pesan jelas', async () => {
    const profile = makeProfile('PETUGAS', { must_change_password: true });
    const fake = createFakeClient({
      session: makeSession('user-1', 'siti@uinsa.ac.id'), profile,
      rpc: { password_changed: () => ({ data: null, error: { message: 'PASSWORD_NOT_CHANGED: x', code: 'P0001' } }) },
    });
    renderApp('/dashboard', fake.client);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Kata sandi saat ini'), 'Sementara-123');
    await user.type(screen.getByLabelText('Kata sandi baru'), 'BaruSekali1');
    await user.type(screen.getByLabelText('Ulangi kata sandi baru'), 'BaruSekali1');
    await user.click(screen.getByRole('button', { name: 'Simpan kata sandi' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('status akun belum diperbarui');
    expect(screen.getByRole('heading', { name: 'Ganti kata sandi sementara' })).toBeInTheDocument();
  });

  it('pemulihan ("lupa kata sandi") juga menghapus penanda', async () => {
    const profile = makeProfile('PETUGAS', { must_change_password: true });
    const fake = createFakeClient({
      session: makeSession('user-1', 'siti@uinsa.ac.id'), profile,
      rpc: { password_changed: () => ({ data: { ok: true, changed: true }, error: null }) },
    });
    renderApp('/atur-sandi', fake.client, { initialRecovery: true });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Kata sandi baru'), 'BaruSekali1');
    await user.type(screen.getByLabelText('Ulangi kata sandi baru'), 'BaruSekali1');
    await user.click(screen.getByRole('button', { name: 'Simpan kata sandi' }));
    expect(await screen.findByRole('heading', { name: 'Kata sandi diperbarui' })).toBeInTheDocument();
    expect(fake.rpc).toHaveBeenCalledWith('password_changed');
  });

  it('pengguna tanpa penanda tidak dialihkan', async () => {
    renderApp('/dashboard', createFakeClient({ session: makeSession(), profile: makeProfile('PETUGAS') }).client);
    expect(await screen.findByRole('heading', { name: 'Dashboard', level: 1 })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/dashboard');
  });
});
