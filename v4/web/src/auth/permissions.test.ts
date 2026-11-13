import { describe, expect, it } from 'vitest';
import { CAPABILITIES, MAX_BOTTOM_NAV, MODULES, ROLES, can, canOpenModule, mobileNav, visibleModules, type Capability, type Role } from './permissions';

// Matriks yang diharapkan, ditulis ulang secara eksplisit dari PRD §4.
const EXPECTED: Record<Role, Capability[]> = {
  PIMPINAN: ['dashboard.lihat', 'arsip.cari', 'akun.ubahSandi'],
  PETUGAS: ['dashboard.lihat', 'arsip.cari', 'akun.ubahSandi', 'arsip.kelola', 'peminjaman.kelola', 'retensi.kelola'],
  ADMIN_UNIT: [
    'dashboard.lihat', 'arsip.cari', 'akun.ubahSandi', 'arsip.kelola', 'peminjaman.kelola', 'retensi.kelola',
    'pengguna.kelola', 'unit.pengaturan', 'masterlog.lihat',
  ],
  ADMIN_PUSAT: [...CAPABILITIES],
};

describe('matriks kemampuan peran', () => {
  for (const role of ROLES) {
    for (const cap of CAPABILITIES) {
      const expected = EXPECTED[role].includes(cap);
      it(`${role} ${expected ? 'boleh' : 'tidak boleh'} ${cap}`, () => {
        expect(can(role, cap)).toBe(expected);
      });
    }
  }

  it('tanpa peran tidak punya kemampuan apa pun', () => {
    for (const cap of CAPABILITIES) expect(can(null, cap)).toBe(false);
  });

  it('peran lebih tinggi mencakup semua kemampuan peran di bawahnya', () => {
    const chain: Role[] = ['PIMPINAN', 'PETUGAS', 'ADMIN_UNIT', 'ADMIN_PUSAT'];
    for (let i = 1; i < chain.length; i++) {
      for (const cap of EXPECTED[chain[i - 1]!]) expect(can(chain[i]!, cap)).toBe(true);
    }
  });
});

describe('modul per peran', () => {
  const ids = (role: Role) => visibleModules(role).map((m) => m.id);

  it('PIMPINAN hanya cari/lihat', () => {
    expect(ids('PIMPINAN')).toEqual(['cari', 'dashboard', 'cari-isi']);
  });
  it('PETUGAS mendapat semua modul operasional, tanpa Master Log/Pengaturan', () => {
    expect(ids('PETUGAS')).toEqual(expect.arrayContaining(['penerimaan', 'pemberkasan', 'alih-media', 'edit', 'koreksi', 'peminjaman', 'retensi', 'lidah-folder']));
    expect(ids('PETUGAS')).not.toContain('master-log');
    expect(ids('PETUGAS')).not.toContain('pengaturan');
  });
  it('ADMIN_UNIT dan ADMIN_PUSAT melihat semua modul', () => {
    expect(ids('ADMIN_UNIT')).toHaveLength(MODULES.length);
    expect(ids('ADMIN_PUSAT')).toHaveLength(MODULES.length);
  });
  it('navigasi dan penjaga rute memakai aturan yang sama', () => {
    for (const role of ROLES) for (const m of MODULES) expect(visibleModules(role).includes(m)).toBe(canOpenModule(role, m));
  });
  it('setiap modul punya path unik dan sprint', () => {
    expect(new Set(MODULES.map((m) => m.path)).size).toBe(MODULES.length);
    for (const m of MODULES) expect(m.sprint).toMatch(/^S[0-6]$/);
  });
});

describe('navigasi HP', () => {
  for (const role of ROLES) {
    it(`${role}: maksimal ${MAX_BOTTOM_NAV} entri (termasuk "Lainnya"), "Cari" pertama`, () => {
      const { primary, more } = mobileNav(role);
      expect(primary.length + 1).toBeLessThanOrEqual(MAX_BOTTOM_NAV);
      expect(primary[0]?.id).toBe('cari');
      expect([...primary, ...more].map((m) => m.id).sort()).toEqual(visibleModules(role).map((m) => m.id).sort());
    });
  }
});
