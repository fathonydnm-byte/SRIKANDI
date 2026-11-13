import type { Development, FileStatusFilter } from '../../lib/api';

/** Kriteria pencarian yang disimpan di URL (bisa dibagikan, tombol Kembali bekerja). */
export interface SearchCriteria {
  q: string;
  kls: string;
  dev: Development;
  file: FileStatusFilter;
  dari: string;
  sampai: string;
  batal: boolean;
  hal: number;
}

export const PAGE_SIZE = 20;

const DEVS: readonly Development[] = ['ALL', 'ASLI', 'COPY'];
const FILES: readonly FileStatusFilter[] = ['ALL', 'TERSEDIA', 'BELUM_DIUNGGAH'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function readCriteria(sp: URLSearchParams): SearchCriteria {
  const dev = (sp.get('dev') ?? 'ALL').toUpperCase() as Development;
  const file = (sp.get('file') ?? 'ALL').toUpperCase() as FileStatusFilter;
  const dari = sp.get('dari') ?? '';
  const sampai = sp.get('sampai') ?? '';
  const hal = Number.parseInt(sp.get('hal') ?? '1', 10);
  return {
    q: (sp.get('q') ?? '').slice(0, 250),
    kls: (sp.get('kls') ?? '').slice(0, 80),
    dev: DEVS.includes(dev) ? dev : 'ALL',
    file: FILES.includes(file) ? file : 'ALL',
    dari: DATE_RE.test(dari) ? dari : '',
    sampai: DATE_RE.test(sampai) ? sampai : '',
    batal: sp.get('batal') === '1',
    hal: Number.isFinite(hal) && hal > 0 ? hal : 1,
  };
}

export function writeCriteria(c: SearchCriteria): URLSearchParams {
  const sp = new URLSearchParams();
  if (c.q.trim()) sp.set('q', c.q.trim());
  if (c.kls.trim()) sp.set('kls', c.kls.trim());
  if (c.dev !== 'ALL') sp.set('dev', c.dev);
  if (c.file !== 'ALL') sp.set('file', c.file);
  if (c.dari) sp.set('dari', c.dari);
  if (c.sampai) sp.set('sampai', c.sampai);
  if (c.batal) sp.set('batal', '1');
  if (c.hal > 1) sp.set('hal', String(c.hal));
  return sp;
}

/** Jumlah filter aktif (selain teks). */
export function activeFilterCount(c: SearchCriteria): number {
  return [c.kls.trim() !== '', c.dev !== 'ALL', c.file !== 'ALL', c.dari !== '', c.sampai !== '', c.batal].filter(Boolean).length;
}

export function hasAnyCriteria(c: SearchCriteria): boolean {
  return c.q.trim() !== '' || activeFilterCount(c) > 0;
}
