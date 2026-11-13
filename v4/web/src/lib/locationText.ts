import { formatDate } from './format';

/** Teks yang disalin/dibagikan: cukup untuk menemukan arsip tanpa membuka aplikasi. */
export function itemLocationText(d: {
  lokasi: string;
  no_berkas: number | null;
  judul_berkas: string;
  no_item: number | null;
  no_surat: string;
  tanggal_naskah: string | null;
  uraian: string | null;
}, unitName?: string | null): string {
  return [
    `Lokasi: ${d.lokasi}${unitName ? ` (${unitName})` : ''}`,
    `Berkas ${d.no_berkas ?? '–'}: ${d.judul_berkas}`,
    `Item ${d.no_item ?? '–'}: ${d.no_surat || 'Tanpa nomor surat'}, ${formatDate(d.tanggal_naskah)}`,
    d.uraian ? `Uraian: ${d.uraian}` : null,
  ].filter(Boolean).join('\n');
}

export function berkasLocationText(d: { lokasi: string; no_berkas: number | null; judul_berkas: string; jumlah_item: number; total_lembar: number }, unitName?: string | null): string {
  return [
    `Lokasi: ${d.lokasi}${unitName ? ` (${unitName})` : ''}`,
    `Berkas ${d.no_berkas ?? '–'}: ${d.judul_berkas}`,
    `${d.jumlah_item} item, ${d.total_lembar} lembar`,
  ].join('\n');
}
