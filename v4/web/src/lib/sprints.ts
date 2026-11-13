import type { Sprint } from '../auth/permissions';

/** PRD §8 — urutan sprint. */
export const SPRINTS: Record<Sprint, { name: string; outcome: string }> = {
  S0: { name: 'Fondasi', outcome: 'Login di staging dari HP dan desktop' },
  S1: { name: 'Baca + impor', outcome: 'Mencari lokasi arsip dan membuka PDF dari HP dengan data pilot' },
  S2: { name: 'Registrasi', outcome: 'Input arsip ujung ke ujung' },
  S3: { name: 'Perubahan + laporan', outcome: 'Laporan dan backup pertama' },
  S4: { name: 'Peminjaman', outcome: 'Siklus pinjam lengkap' },
  S5: { name: 'Retensi + RC', outcome: 'Usul ke Record Center uji' },
  S6: { name: 'Scan + isi', outcome: 'Scan langsung dari HP' },
};
