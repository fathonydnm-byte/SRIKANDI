/** Kartu pintas dashboard (3.x: Sedang Dipinjam, Retensi H-7, Habis Aktif). */
export type ShortcutKind = 'DIPINJAM' | 'H7' | 'HABIS';

export interface ShortcutDef {
  kind: ShortcutKind;
  slug: string;
  title: string;
  icon: string;
  tone: 'info' | 'warning' | 'danger';
  countKey: 'sedang_dipinjam' | 'retensi_h7' | 'habis_aktif';
  description: string;
  empty: string;
}

export const SHORTCUTS: readonly ShortcutDef[] = [
  {
    kind: 'DIPINJAM', slug: 'dipinjam', title: 'Sedang Dipinjam', icon: '📋', tone: 'info', countKey: 'sedang_dipinjam',
    description: 'Berkas yang berstatus dipinjam, atau memiliki item yang sedang dipinjam.',
    empty: 'Tidak ada berkas yang sedang dipinjam.',
  },
  {
    kind: 'H7', slug: 'retensi-h7', title: 'Retensi H-7', icon: '⏱️', tone: 'warning', countKey: 'retensi_h7',
    description: 'Berkas yang masa aktifnya habis dalam 0–7 hari (tanggal WIB), termasuk yang sedang diusulkan pindah.',
    empty: 'Tidak ada berkas yang masa aktifnya akan habis dalam 0–7 hari.',
  },
  {
    kind: 'HABIS', slug: 'habis-aktif', title: 'Habis Aktif', icon: '⚠️', tone: 'danger', countKey: 'habis_aktif',
    description: 'Berkas yang masa aktifnya sudah lewat — kandidat usul pemindahan ke Record Center.',
    empty: 'Tidak ada berkas yang masa aktifnya sudah habis.',
  },
];

export function shortcutBySlug(slug: string | undefined): ShortcutDef | undefined {
  return SHORTCUTS.find((s) => s.slug === slug);
}
