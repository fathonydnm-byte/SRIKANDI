const MONTHS = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];

/** '2025-03-10' -> '10 Maret 2025' (tanggal lokal, tanpa konversi zona waktu). */
export function formatDate(value: string | null | undefined, empty = 'Tanpa tanggal'): string {
  if (!value) return empty;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return value;
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month} ${m[1]}` : value;
}

export function formatDateRange(from: string | null, to: string | null): string {
  if (!from && !to) return 'Tanpa tanggal';
  if (!from || !to || from === to) return formatDate(from ?? to);
  return `${formatDate(from)} – ${formatDate(to)}`;
}

export function formatNumber(n: number | null | undefined): string {
  return new Intl.NumberFormat('id-ID').format(n ?? 0);
}

export function developmentLabel(v: string | null | undefined): string {
  if (!v) return '–';
  return v === 'ASLI' ? 'Asli' : v === 'COPY' ? 'Copy' : v;
}

export function titleCase(v: string | null | undefined): string {
  if (!v) return '';
  return v.toLowerCase().replace(/(^|\s|\/)(\S)/g, (_m, a: string, b: string) => a + b.toUpperCase());
}

/** Tingkat keamanan selain BIASA/TERBUKA ditandai. */
export function isRestricted(level: string | null | undefined): boolean {
  return Boolean(level && level !== 'BIASA/TERBUKA');
}

export function berkasItemLabel(noBerkas: number | null, noItem?: number | null): string {
  const b = noBerkas ?? '–';
  return noItem === undefined ? `Berkas ${b}` : `Berkas ${b} / Item ${noItem ?? '–'}`;
}
