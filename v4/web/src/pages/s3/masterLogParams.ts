import type { MasterLogFilters } from '../../lib/masterLog';

/** Kriteria Master Log di URL (bisa dibagikan; tombol Kembali bekerja). */
export interface LogCriteria {
  q: string;
  dari: string;
  sampai: string;
  aksi: string;
  jenis: string;
  modul: string;
  hasil: '' | 'SUCCESS' | 'FAILED' | 'WARNING';
  obj: string;
  pelaku: string;
  hal: number;
}

export const LOG_PAGE_SIZE = 25;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HASIL = ['SUCCESS', 'FAILED', 'WARNING'] as const;

export function readLogCriteria(sp: URLSearchParams): LogCriteria {
  const hasil = (sp.get('hasil') ?? '').toUpperCase();
  const dari = sp.get('dari') ?? '';
  const sampai = sp.get('sampai') ?? '';
  const hal = Number.parseInt(sp.get('hal') ?? '1', 10);
  return {
    q: (sp.get('q') ?? '').slice(0, 200),
    dari: DATE_RE.test(dari) ? dari : '',
    sampai: DATE_RE.test(sampai) ? sampai : '',
    aksi: (sp.get('aksi') ?? '').slice(0, 100),
    jenis: (sp.get('jenis') ?? '').slice(0, 100),
    modul: (sp.get('modul') ?? '').slice(0, 100),
    hasil: (HASIL as readonly string[]).includes(hasil) ? (hasil as LogCriteria['hasil']) : '',
    obj: (sp.get('obj') ?? '').slice(0, 200),
    pelaku: (sp.get('pelaku') ?? '').slice(0, 200),
    hal: Number.isFinite(hal) && hal > 0 ? hal : 1,
  };
}

export function writeLogCriteria(c: LogCriteria): URLSearchParams {
  const sp = new URLSearchParams();
  const set = (k: string, v: string) => {
    if (v.trim()) sp.set(k, v.trim());
  };
  set('q', c.q);
  set('dari', c.dari);
  set('sampai', c.sampai);
  set('aksi', c.aksi);
  set('jenis', c.jenis);
  set('modul', c.modul);
  set('hasil', c.hasil);
  set('obj', c.obj);
  set('pelaku', c.pelaku);
  if (c.hal > 1) sp.set('hal', String(c.hal));
  return sp;
}

/** Jumlah filter aktif selain kotak cari. */
export function activeLogFilterCount(c: LogCriteria): number {
  return [c.dari, c.sampai, c.aksi, c.jenis, c.modul, c.hasil, c.obj, c.pelaku].filter((v) => v.trim() !== '').length;
}

export function toRpcFilters(c: LogCriteria): MasterLogFilters {
  const f: MasterLogFilters = {};
  if (c.q.trim()) f.q = c.q.trim();
  if (c.dari) f.date_from = c.dari;
  if (c.sampai) f.date_to = c.sampai;
  if (c.aksi) f.action = c.aksi;
  if (c.jenis) f.object_type = c.jenis;
  if (c.modul) f.module = c.modul;
  if (c.hasil) f.result = c.hasil;
  if (c.obj.trim()) f.object_id = c.obj.trim();
  if (c.pelaku.trim()) f.actor = c.pelaku.trim();
  return f;
}
