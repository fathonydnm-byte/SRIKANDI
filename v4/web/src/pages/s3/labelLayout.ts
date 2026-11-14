/*
 * Tata letak lidah folder — port dari central-file/LabelPrint.html (3.x):
 * A4, 2 kolom × 7 baris, label 70 × 30 mm, margin kiri/atas 72 pt (25,4 mm),
 * posisi awal 1–14. Satu sumber untuk pratinjau DAN cetak (komponen yang sama).
 */
export const COLUMNS = 2;
export const ROWS = 7;
export const PER_PAGE = COLUMNS * ROWS;
export const LABEL_W_MM = 70;
export const LABEL_H_MM = 30;
export const PAPER_W_MM = 210;
export const PAPER_H_MM = 297;
/** Margin kiri dan atas lembar (3.x: 72 pt). */
export const ORIGIN_MM = 25.4;

const PT_PER_MM = 72 / 25.4;
const PT_MM = 25.4 / 72;

export interface LabelData {
  berkas_id: string;
  number: string;
  classification_code: string;
  title: string;
}

export interface LabelLayout {
  header: string;
  /** Ukuran dalam pt; posisi dalam mm dari tepi atas-kiri label. */
  headerSize: number;
  headerTopMm: number;
  titleLines: string[];
  titleSize: number;
  titleTopMm: number;
  titleLineHeightPt: number;
}

export const slotName = (slot: number) => `baris ${Math.ceil(slot / 2)} ${slot % 2 ? 'kiri' : 'kanan'}`;

/** ceil((slot - 1 + n) / 14), 0 bila tidak ada label (3.x pageCount). */
export function pageCount(startSlot: number, labelCount: number): number {
  return labelCount > 0 ? Math.ceil((startSlot - 1 + labelCount) / PER_PAGE) : 0;
}

/** Halaman → 14 slot; null = kosong (sebelum posisi awal / setelah label terakhir). */
export function placeLabels<T>(labels: readonly T[], startSlot: number): (T | null)[][] {
  const pages = Math.max(1, pageCount(startSlot, labels.length));
  return Array.from({ length: pages }, (_, p) =>
    Array.from({ length: PER_PAGE }, (_, s) => labels[p * PER_PAGE + s - (startSlot - 1)] ?? null),
  );
}

type Measure = (text: string, sizePt: number, bold: boolean) => number;

let canvasCtx: CanvasRenderingContext2D | null | undefined;
/** Lebar teks (pt) seperti 3.x: kanvas bila ada, jika tidak perkiraan per karakter. */
export const measureText: Measure = (text, sizePt, bold) => {
  if (canvasCtx === undefined) {
    try {
      canvasCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
    } catch {
      canvasCtx = null;
    }
  }
  if (canvasCtx) {
    canvasCtx.font = `${bold ? 'bold ' : ''}${sizePt}pt "Times New Roman", "Liberation Serif", Times, serif`;
    return canvasCtx.measureText(text).width * 0.75;
  }
  let sum = 0;
  for (const ch of Array.from(text)) {
    if (ch === ' ') sum += sizePt * 0.24;
    else if (/[MW@#%]/.test(ch)) sum += sizePt * 0.82;
    else if (/[ilI1.,;:|]/.test(ch)) sum += sizePt * 0.27;
    else if (/[A-Z0-9]/.test(ch)) sum += sizePt * 0.58;
    else sum += sizePt * 0.48;
  }
  return sum * (bold ? 1.04 : 1);
};

export function wrapText(text: string, maxWidthPt: number, sizePt: number, measure: Measure = measureText): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (measure(candidate, sizePt, false) <= maxWidthPt) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    if (measure(word, sizePt, false) <= maxWidthPt) {
      current = word;
      continue;
    }
    // kata tunggal lebih lebar dari label: pecah per karakter
    let part = '';
    for (const ch of Array.from(word)) {
      if (part && measure(part + ch, sizePt, false) > maxWidthPt) {
        lines.push(part);
        part = ch;
      } else part += ch;
    }
    current = part;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

const clean = (v: string) => v.replace(/\s+/g, ' ').trim();

/**
 * drawFolderLabelPdf_: logo 12,5 mm di kanan-atas (2 mm dari tepi); judul
 * "KODE | NOMOR" tebal 12 pt (menyusut sampai 9 pt agar muat di kiri logo);
 * uraian mulai 17 mm dari atas, 11,5 pt menyusut sampai 7,5 pt (lalu 7 pt),
 * baris 1,08, dipotong dengan "..." bila tetap tidak muat.
 */
export function layoutLabel(label: LabelData, measure: Measure = measureText): LabelLayout {
  const width = LABEL_W_MM * PT_PER_MM;
  const left = 4 * PT_PER_MM;
  const logoX = width - 2 * PT_PER_MM - 12.5 * PT_PER_MM;
  const header = clean(`${label.classification_code || 'TANPA KODE'} | ${label.number || '–'}`);
  const headerMax = logoX - left - 2 * PT_PER_MM;
  let headerSize = 12;
  while (headerSize > 9 && measure(header, headerSize, true) > headerMax) headerSize -= 0.5;

  const title = clean(label.title || 'Tanpa Judul');
  const titleWidth = width - 8 * PT_PER_MM;
  const titleTop = 17 * PT_PER_MM; // baseline baris pertama, dari tepi atas
  const available = (LABEL_H_MM - 2.2) * PT_PER_MM - titleTop;
  let titleSize = 11.5;
  let lines: string[] = [];
  while (titleSize >= 7) {
    lines = wrapText(title, titleWidth, titleSize, measure);
    if (lines.length * titleSize * 1.08 <= available + 0.1) break;
    if (titleSize === 7) break;
    titleSize = Math.max(7, titleSize - 0.5);
  }
  const maxLines = Math.max(1, Math.floor(available / (titleSize * 1.08)));
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    let last = lines[maxLines - 1] ?? '';
    while (last.length && measure(`${last}...`, titleSize, false) > titleWidth) last = last.slice(0, -1).trim();
    lines[maxLines - 1] = `${last.replace(/[.,;:]+$/, '')}...`;
  }
  // Times: ascent 0,891 / descent 0,216 → baseline = (L − 1,107·S)/2 + 0,891·S dari atas kotak baris.
  const baselineOffset = (lineHeight: number, size: number) => (lineHeight - 1.107 * size) / 2 + 0.891 * size;
  return {
    header,
    headerSize,
    headerTopMm: 6.2 - baselineOffset(headerSize, headerSize) * PT_MM,
    titleLines: lines,
    titleSize,
    titleTopMm: 17 - baselineOffset(titleSize * 1.08, titleSize) * PT_MM,
    titleLineHeightPt: titleSize * 1.08,
  };
}
