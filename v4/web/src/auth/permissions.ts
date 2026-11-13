/*
 * Satu-satunya sumber kebenaran kemampuan peran di sisi tampilan (PRD §4).
 * Dipakai oleh navigasi DAN penjaga rute. Menyembunyikan menu hanyalah
 * kenyamanan: server (RLS + Edge Functions) tetap yang menegakkan hak akses.
 */

export const ROLES = ['ADMIN_PUSAT', 'ADMIN_UNIT', 'PETUGAS', 'PIMPINAN'] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export const ROLE_LABELS: Record<Role, string> = {
  ADMIN_PUSAT: 'Admin Pusat',
  ADMIN_UNIT: 'Admin Unit',
  PETUGAS: 'Petugas Arsip',
  PIMPINAN: 'Pimpinan',
};

export const CAPABILITIES = [
  /** Dashboard ringkas. */
  'dashboard.lihat',
  /** Cari arsip, lihat lokasi, buka/unduh softcopy (termasuk terbatas/rahasia). */
  'arsip.cari',
  /** Penerimaan, pemberkasan, alih media, edit, koreksi & pembatalan, cetak label. */
  'arsip.kelola',
  /** Peminjaman, pengembalian, BA, Out Indicator. */
  'peminjaman.kelola',
  /** Monitoring retensi dan usul pemindahan. */
  'retensi.kelola',
  /** Kelola pengguna unit dan master pegawai. */
  'pengguna.kelola',
  /** Pengaturan unit. */
  'unit.pengaturan',
  /** Master Log perubahan (audit). */
  'masterlog.lihat',
  /** Kelola daftar unit, rilis (lintas unit). */
  'unit.kelolaSemua',
  /** Backup dan restore. */
  'backup.kelola',
  /** Koneksi Record Center. */
  'rc.kelola',
  /** Berpindah unit aktif (lintas unit). */
  'unit.pilih',
  /** Ubah kata sandi sendiri. */
  'akun.ubahSandi',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const PIMPINAN_CAPS: readonly Capability[] = ['dashboard.lihat', 'arsip.cari', 'akun.ubahSandi'];
const PETUGAS_CAPS: readonly Capability[] = [...PIMPINAN_CAPS, 'arsip.kelola', 'peminjaman.kelola', 'retensi.kelola'];
const ADMIN_UNIT_CAPS: readonly Capability[] = [...PETUGAS_CAPS, 'pengguna.kelola', 'unit.pengaturan', 'masterlog.lihat'];
const ADMIN_PUSAT_CAPS: readonly Capability[] = [...CAPABILITIES];

export const ROLE_CAPABILITIES: Readonly<Record<Role, ReadonlySet<Capability>>> = {
  PIMPINAN: new Set(PIMPINAN_CAPS),
  PETUGAS: new Set(PETUGAS_CAPS),
  ADMIN_UNIT: new Set(ADMIN_UNIT_CAPS),
  ADMIN_PUSAT: new Set(ADMIN_PUSAT_CAPS),
};

export function can(role: Role | null | undefined, capability: Capability): boolean {
  if (!role) return false;
  return ROLE_CAPABILITIES[role].has(capability);
}

/** Pengaturan dapat dibuka bila peran memegang salah satu kemampuan admin. */
const SETTINGS_CAPS: readonly Capability[] = ['pengguna.kelola', 'unit.pengaturan', 'unit.kelolaSemua', 'backup.kelola', 'rc.kelola'];

export type Sprint = 'S0' | 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6';
export type NavGroup = 'Utama' | 'Pencarian' | 'Penciptaan Arsip' | 'Pemeliharaan Arsip' | 'Sirkulasi & Retensi' | 'Keamanan & Audit';

export interface ModuleDef {
  id: string;
  path: string;
  label: string;
  /** Label pendek untuk navigasi bawah di HP. */
  shortLabel: string;
  icon: string;
  group: NavGroup;
  /** Salah satu kemampuan ini cukup untuk membuka modul. */
  anyOf: readonly Capability[];
  /** Sprint PRD §8 saat modul tersedia. 'S0' = sudah ada. */
  sprint: Sprint;
  summary: string;
  /** Urutan prioritas di navigasi bawah HP (kecil = lebih kiri). */
  mobilePriority?: number;
}

export const MODULES: readonly ModuleDef[] = [
  { id: 'cari', path: '/cari', label: 'Cari Arsip', shortLabel: 'Cari', icon: '🔍', group: 'Pencarian', anyOf: ['arsip.cari'], sprint: 'S1', mobilePriority: 1,
    summary: 'Cari berkas dan item, lihat lokasi kabinet/laci/folder, buka atau bagikan softcopy.' },
  { id: 'dashboard', path: '/dashboard', label: 'Dashboard', shortLabel: 'Beranda', icon: '🏠', group: 'Utama', anyOf: ['dashboard.lihat'], sprint: 'S0', mobilePriority: 2,
    summary: 'Ringkasan kondisi arsip unit.' },
  { id: 'cari-isi', path: '/cari-isi', label: 'Cari Isi Berkas', shortLabel: 'Cari Isi', icon: '📄', group: 'Pencarian', anyOf: ['arsip.cari'], sprint: 'S6', mobilePriority: 5,
    summary: 'Pencarian teks di dalam isi softcopy hasil OCR.' },
  { id: 'penerimaan', path: '/penerimaan', label: 'Penerimaan', shortLabel: 'Terima', icon: '📥', group: 'Penciptaan Arsip', anyOf: ['arsip.kelola'], sprint: 'S2', mobilePriority: 3,
    summary: 'Penerimaan naskah dan tanda terima.' },
  { id: 'pemberkasan', path: '/pemberkasan', label: 'Input/Pemberkasan', shortLabel: 'Berkas', icon: '🗂️', group: 'Penciptaan Arsip', anyOf: ['arsip.kelola'], sprint: 'S2',
    summary: 'Antrean, pemberkasan, dan penomoran definitif berkas baru.' },
  { id: 'lidah-folder', path: '/lidah-folder', label: 'Cetak Lidah Folder', shortLabel: 'Label', icon: '🏷️', group: 'Penciptaan Arsip', anyOf: ['arsip.kelola'], sprint: 'S3',
    summary: 'Cetak label lidah folder.' },
  { id: 'alih-media', path: '/alih-media', label: 'Alih Media', shortLabel: 'Alih Media', icon: '🖨️', group: 'Pemeliharaan Arsip', anyOf: ['arsip.kelola'], sprint: 'S2',
    summary: 'Unggah softcopy PDF hasil alih media.' },
  { id: 'edit', path: '/edit', label: 'Edit', shortLabel: 'Edit', icon: '✏️', group: 'Pemeliharaan Arsip', anyOf: ['arsip.kelola'], sprint: 'S3',
    summary: 'Perubahan metadata berkas dan item.' },
  { id: 'koreksi', path: '/koreksi', label: 'Koreksi & Pembatalan', shortLabel: 'Koreksi', icon: '♻️', group: 'Pemeliharaan Arsip', anyOf: ['arsip.kelola'], sprint: 'S3',
    summary: 'Koreksi dan pembatalan arsip dengan karantina.' },
  { id: 'peminjaman', path: '/peminjaman', label: 'Peminjaman', shortLabel: 'Pinjam', icon: '📋', group: 'Sirkulasi & Retensi', anyOf: ['peminjaman.kelola'], sprint: 'S4', mobilePriority: 4,
    summary: 'Pinjam/kembali multi-berkas, Out Indicator, dan Berita Acara.' },
  { id: 'retensi', path: '/retensi', label: 'Retensi & Usul Pindah', shortLabel: 'Retensi', icon: '📦', group: 'Sirkulasi & Retensi', anyOf: ['retensi.kelola'], sprint: 'S5',
    summary: 'Monitoring retensi dan usul pemindahan ke Record Center.' },
  { id: 'master-log', path: '/master-log', label: 'Master Log', shortLabel: 'Log', icon: '🔒', group: 'Keamanan & Audit', anyOf: ['masterlog.lihat'], sprint: 'S3',
    summary: 'Riwayat perubahan (audit) per orang.' },
  { id: 'pengaturan', path: '/pengaturan', label: 'Pengaturan', shortLabel: 'Pengaturan', icon: '⚙️', group: 'Keamanan & Audit', anyOf: SETTINGS_CAPS, sprint: 'S3',
    summary: 'Pengguna unit, master pegawai, pengaturan unit; untuk Admin Pusat juga unit, backup, dan koneksi Record Center.' },
];

export const NAV_GROUP_ORDER: readonly NavGroup[] = ['Utama', 'Pencarian', 'Penciptaan Arsip', 'Pemeliharaan Arsip', 'Sirkulasi & Retensi', 'Keamanan & Audit'];

export function canOpenModule(role: Role | null | undefined, mod: ModuleDef): boolean {
  return mod.anyOf.some((c) => can(role, c));
}

export function visibleModules(role: Role | null | undefined): ModuleDef[] {
  return MODULES.filter((m) => canOpenModule(role, m));
}

export const MAX_BOTTOM_NAV = 5;

/**
 * Pembagian navigasi HP: maksimal 5 entri di bawah, "Cari" pertama. Bila ada
 * sisa modul, slot terakhir dipakai tombol "Lainnya".
 */
export function mobileNav(role: Role | null | undefined): { primary: ModuleDef[]; more: ModuleDef[] } {
  const mods = visibleModules(role);
  const ranked = mods
    .filter((m) => m.mobilePriority !== undefined)
    .sort((a, b) => (a.mobilePriority ?? 99) - (b.mobilePriority ?? 99));
  // Selalu sisakan satu slot untuk "Lainnya" (akun, ubah kata sandi, keluar).
  const primary = ranked.slice(0, MAX_BOTTOM_NAV - 1);
  const more = mods.filter((m) => !primary.includes(m));
  return { primary, more };
}

export function findModuleByPath(path: string): ModuleDef | undefined {
  return MODULES.find((m) => m.path === path);
}
