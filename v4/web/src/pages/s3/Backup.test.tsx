import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../../test/renderApp';
import { createFakeClient, makeProfile, makeSession, type RpcHandler } from '../../test/fakeSupabase';
import { MODULES, canOpenModule, visibleModules, type Role } from '../../auth/permissions';
import { driveFolderLink, formatAge, sheetLink, summarize, type BackupKindStatus, type BackupStatus, type BackupUnitStatus } from '../../lib/backupApi';

const SHEET = 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit';
const FOLDER_ID = 'backupFolderAbCdEfGh0123456789';

function kind(over: Partial<BackupKindStatus> = {}): BackupKindStatus {
  return {
    last_success_at: '2026-11-14T18:30:00Z', age_hours: 5.2, last_done: { id: 'r1', status: 'SUCCESS', started_at: '2026-11-14T18:00:00Z', finished_at: '2026-11-14T18:30:00Z', error: null },
    running: null, url: null, backup_file_id: null, stats: { total_rows: 12345, drive_files: 678 }, warning: null, ...over,
  };
}
function unit(code: string, over: Partial<BackupUnitStatus> = {}): BackupUnitStatus {
  return { unit_id: `id-${code}`, unit_code: code, unit_name: `Unit ${code}`, active: true, mirror: kind({ url: SHEET }), backup: kind({ backup_file_id: FOLDER_ID }), ...over };
}
function status(units: BackupUnitStatus[], history: BackupStatus['history'] = []): BackupStatus {
  return { now: '2026-11-15T00:00:00Z', stale_after_hours: 36, units, history };
}
const ok = (data: unknown) => ({ data, error: null });
function setup(role: Role, rpc: Record<string, RpcHandler>) {
  return createFakeClient({ session: makeSession(), profile: makeProfile(role), rpc });
}

afterEach(() => { vi.restoreAllMocks(); });

describe('Cadangan & Cermin: tampilan', () => {
  it('semua sehat: spanduk hijau, kartu per unit, tautan spreadsheet dan folder, hanya-baca', async () => {
    const h = vi.fn<RpcHandler>(() => ok(status([unit('BAU'), unit('LPM', { active: false })])));
    renderApp('/cadangan', setup('ADMIN_PUSAT', { backup_status: h }).client);
    expect(await screen.findByRole('heading', { level: 1, name: 'Cadangan & Cermin' })).toBeInTheDocument();
    expect(await screen.findByText(/Semua cadangan dan cermin terbaru/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'BAU' })).toBeInTheDocument();
    expect(screen.getByText('Nonaktif')).toBeInTheDocument();
    const bau = screen.getAllByRole('listitem').find((li) => within(li).queryByRole('heading', { name: 'BAU' }))!;
    expect(within(bau).getAllByText('Sehat')).toHaveLength(2);
    expect(within(bau).getAllByText(/\(5 jam lalu\)/)).toHaveLength(2);
    expect(within(bau).getAllByText(/12\.345 baris, 678 rujukan file Drive/)).toHaveLength(2);
    const sheet = within(bau).getByRole('link', { name: 'Buka spreadsheet cermin' });
    expect(sheet).toHaveAttribute('href', SHEET);
    expect(sheet).toHaveAttribute('target', '_blank');
    expect(sheet).toHaveAttribute('rel', 'noopener noreferrer');
    expect(within(bau).getByRole('link', { name: 'Buka folder paket di Drive' })).toHaveAttribute('href', `https://drive.google.com/drive/folders/${FOLDER_ID}`);
    // read-only: the only button is "Muat ulang"; nothing that writes
    expect(screen.getByRole('main').querySelector('input, textarea, select, form')).toBeNull();
    expect(within(screen.getByRole('main')).getAllByRole('button').map((b) => b.textContent)).toEqual(['Muat ulang']);
    expect(h).toHaveBeenCalledTimes(1);
    expect(h).toHaveBeenCalledWith({}, undefined);
  });

  it('gagal: spanduk merah menyebut unit, galat tampil sebagai teks (bukan HTML), percobaan terakhir gagal terlihat', async () => {
    const failed = kind({ last_done: { id: 'r2', status: 'FAILED', started_at: '2026-11-14T18:00:00Z', finished_at: '2026-11-14T18:01:00Z', error: 'Jumlah baris tidak cocok untuk item <img src=x onerror=alert(1)>' }, warning: 'FAILED' });
    renderApp('/cadangan', setup('ADMIN_PUSAT', { backup_status: () => ok(status([unit('BAU', { mirror: failed }), unit('LPM')])) }).client);
    expect(await screen.findByText(/Cadangan atau cermin terakhir gagal untuk: BAU\./)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/Jumlah baris tidak cocok untuk item <img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
    expect(screen.getByRole('main').querySelector('img')).toBeNull();
    expect(screen.getByText('Gagal')).toBeInTheDocument();
    expect(screen.getByText(/Percobaan terakhir gagal/)).toBeInTheDocument();
  });

  it('terlambat (> 36 jam) dan belum pernah: spanduk kuning', async () => {
    const stale = kind({ age_hours: 40, warning: 'STALE' });
    const never = kind({ last_success_at: null, age_hours: null, last_done: null, stats: null, url: null, warning: 'NEVER' });
    renderApp('/cadangan', setup('ADMIN_PUSAT', { backup_status: () => ok(status([unit('BAU', { backup: stale }), unit('LPM', { mirror: never, backup: never })])) }).client);
    const banner = await screen.findByText(/Perlu perhatian\./);
    expect(banner.parentElement).toHaveTextContent('dalam 36 jam terakhir untuk: BAU');
    expect(banner.parentElement).toHaveTextContent('Belum pernah berjalan untuk: LPM');
    expect(screen.getByText('Terlambat')).toBeInTheDocument();
    expect(screen.getAllByText('Belum pernah').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/Belum ada yang berhasil dalam 36 jam terakhir/)).toBeInTheDocument();
  });

  it('tautan hanya dari bentuk yang dikenal: javascript:, domain lain, dan ID aneh tidak menjadi tautan', async () => {
    const evil = unit('BAU', { mirror: kind({ url: 'javascript:alert(1)' }), backup: kind({ backup_file_id: '"><script>x</script>' }) });
    const evil2 = unit('LPM', { mirror: kind({ url: 'https://evil.example/spreadsheets/d/1AbCdEfGhIjKlMnOpQrSt' }), backup: kind({ backup_file_id: null }) });
    renderApp('/cadangan', setup('ADMIN_PUSAT', { backup_status: () => ok(status([evil, evil2])) }).client);
    await screen.findByRole('heading', { name: 'BAU' });
    expect(within(screen.getByRole('main')).queryByRole('link')).toBeNull();
  });

  it('cermin tidak ada untuk baris lintas unit (hanya cadangan); riwayat memuat unit, status, jumlah baris dan galat', async () => {
    const platform = unit('_PLATFORM', { unit_id: null, unit_name: 'Lintas unit (audit tanpa unit)', mirror: null });
    const hist: BackupStatus['history'] = [
      { id: 'h1', kind: 'BACKUP', unit_id: null, started_at: '2026-11-14T18:00:00Z', finished_at: '2026-11-14T18:02:00Z', status: 'SUCCESS', error: null, total_rows: '42' },
      { id: 'h2', kind: 'MIRROR', unit_id: 'id-BAU', started_at: '2026-11-14T18:00:00Z', finished_at: null, status: 'RUNNING', error: null, total_rows: null },
      { id: 'h3', kind: 'MIRROR', unit_id: 'id-BAU', started_at: '2026-11-13T18:00:00Z', finished_at: '2026-11-13T18:01:00Z', status: 'FAILED', error: 'API TABLE_PAGE ditolak (HTTP 401 JOB_DENIED)', total_rows: null },
    ];
    renderApp('/cadangan', setup('ADMIN_PUSAT', { backup_status: () => ok(status([unit('BAU'), platform], hist)) }).client);
    await screen.findByRole('heading', { name: '_PLATFORM' });
    const card = screen.getAllByRole('listitem').find((li) => within(li).queryByRole('heading', { name: '_PLATFORM' }))!;
    expect(within(card).queryByText('Cermin spreadsheet')).toBeNull();
    expect(within(card).getByText('Cadangan harian')).toBeInTheDocument();
    const history = screen.getByRole('region', { name: 'Riwayat' });
    expect(within(history).getByText('Cadangan · _PLATFORM')).toBeInTheDocument();
    expect(within(history).getByText('42 baris')).toBeInTheDocument();
    expect(within(history).getByText('Berjalan')).toBeInTheDocument();
    expect(within(history).getByText(/HTTP 401 JOB_DENIED/)).toBeInTheDocument();
  });

  it('galat memuat: pesan dan tombol coba lagi; muat ulang memanggil RPC lagi', async () => {
    let n = 0;
    const h = vi.fn<RpcHandler>(() => (++n === 1 ? { data: null, error: { message: 'FORBIDDEN_ROLE: x', code: 'P0001' } } : ok(status([unit('BAU')]))));
    renderApp('/cadangan', setup('ADMIN_UNIT', { backup_status: h }).client);
    await userEvent.click(await screen.findByRole('button', { name: 'Coba lagi' }));
    expect(await screen.findByRole('heading', { name: 'BAU' })).toBeInTheDocument();
    expect(h).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByRole('button', { name: 'Muat ulang' }));
    expect(h).toHaveBeenCalledTimes(3);
  });
});

describe('Cadangan & Cermin: akses', () => {
  it.each<Role>(['ADMIN_PUSAT', 'ADMIN_UNIT'])('%s dapat membuka halaman', async (role) => {
    renderApp('/cadangan', setup(role, { backup_status: () => ok(status([unit('BAU')])) }).client);
    expect(await screen.findByRole('heading', { name: 'BAU' })).toBeInTheDocument();
  });

  it.each<Role>(['PETUGAS', 'PIMPINAN'])('%s ditolak dan RPC tidak dipanggil', async (role) => {
    const h = vi.fn<RpcHandler>();
    renderApp('/cadangan', setup(role, { backup_status: h }).client);
    expect(await screen.findByText(/Anda tidak memiliki akses ke/)).toBeInTheDocument();
    expect(h).not.toHaveBeenCalled();
  });

  it('modul ada di grup Keamanan & Audit, hanya untuk admin, dan satu-satunya RPC yang dipakai adalah backup_status', () => {
    const m = MODULES.find((x) => x.id === 'cadangan')!;
    expect(m.group).toBe('Keamanan & Audit');
    expect(m.path).toBe('/cadangan');
    expect((['ADMIN_PUSAT', 'ADMIN_UNIT', 'PETUGAS', 'PIMPINAN'] as Role[]).filter((r) => canOpenModule(r, m))).toEqual(['ADMIN_PUSAT', 'ADMIN_UNIT']);
    expect(visibleModules('PETUGAS').map((x) => x.id)).not.toContain('cadangan');
  });
});

describe('Cadangan & Cermin: pembantu', () => {
  it('formatAge', () => {
    expect(formatAge(null)).toBe('–');
    expect(formatAge(0.4)).toBe('kurang dari 1 jam lalu');
    expect(formatAge(5.2)).toBe('5 jam lalu');
    expect(formatAge(47.6)).toBe('48 jam lalu');
    expect(formatAge(96)).toBe('4 hari lalu');
  });
  it('sheetLink / driveFolderLink menerima hanya bentuk yang dikenal', () => {
    expect(sheetLink(SHEET)).toBe(SHEET);
    for (const bad of [null, '', 'http://docs.google.com/spreadsheets/d/1AbCdEfGhIjKl', 'https://docs.google.com.evil.example/spreadsheets/d/1AbCdEfGhIjKl', 'https://docs.google.com/spreadsheets/d/short', 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKl/edit with space']) expect(sheetLink(bad as string | null)).toBeNull();
    expect(driveFolderLink('abcdefghij1234')).toBe('https://drive.google.com/drive/folders/abcdefghij1234');
    for (const bad of [null, '', 'x', '../../etc', 'a b c d e f g h i j']) expect(driveFolderLink(bad as string | null)).toBeNull();
  });
  it('summarize: gagal > terlambat > belum pernah > sehat, per unit', () => {
    const s = summarize([
      unit('A', { backup: kind({ warning: 'FAILED' }) }), unit('B', { mirror: kind({ warning: 'STALE' }) }), unit('C', { backup: kind({ warning: 'NEVER' }) }),
      unit('D'), unit('E', { mirror: null, backup: kind({ warning: 'STALE' }) }),
    ]);
    expect(s).toEqual({ failed: ['A'], stale: ['B', 'E'], never: ['C'], ok: 1 });
  });
});
