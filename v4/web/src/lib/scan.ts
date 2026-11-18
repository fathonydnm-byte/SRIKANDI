import { correctedSize, createRectifier, validCorners, type Corners } from './perspective';

/** Scan files are created locally and enter the existing PDF upload flow. */
export interface ScanResult {
  pdf: Blob;
  fileName: string;
  pageCount: number;
}
export interface ScanPage {
  jpeg: Blob;
  turns: number;
}

export const MAX_SCAN_PAGES = 30;
const MAX_PHOTO_BYTES = 24 * 1024 * 1024;
const MAX_SCAN_BYTES = 104857599; // Same limit as the existing Alih Media flow.
const MAX_EDGE = 2400;
const MARGIN = 18;
const A4: [number, number] = [595.28, 841.89];

type Decoded = { image: CanvasImageSource; width: number; height: number; release(): void };

async function decode(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { image: bmp, width: bmp.width, height: bmp.height, release: () => bmp.close() };
    } catch {
      // Some browsers can display a phone image even when bitmap decoding fails.
    }
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Foto tidak dapat dibaca. Coba gunakan JPG atau PNG.'));
      image.src = url;
    });
    return { image, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

export async function prepareScanPhoto(file: File): Promise<Blob> {
  if (!(file.type ? /^image\/(jpeg|png|webp|heic|heif|heic-sequence|heif-sequence)$/i.test(file.type)
    : /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name))) {
    throw new Error('Pilih foto JPG, PNG, WebP, atau HEIC/HEIF yang didukung perangkat.');
  }
  if (!file.size || file.size > MAX_PHOTO_BYTES) throw new Error('Setiap foto harus berukuran di atas 0 dan maksimal 24 MB.');
  const { image, width, height, release } = await decode(file);
  const canvas = document.createElement('canvas');
  try {
    if (!width || !height) throw new Error('Ukuran foto tidak dapat dibaca.');
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Perangkat ini tidak dapat menyiapkan foto.');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob && blob.type === 'image/jpeg') resolve(blob);
        else reject(new Error('Foto gagal disiapkan. Coba foto lain atau unggah PDF yang sudah ada.'));
      }, 'image/jpeg', 0.87);
    });
  } finally {
    release();
    canvas.width = canvas.height = 1;
  }
}

export async function correctScanPhoto(
  jpeg: Blob, corners: Corners, signal: AbortSignal, onProgress: (percent: number) => void,
): Promise<Blob> {
  if (!validCorners(corners)) throw new Error('Atur empat sudut dokumen agar tidak bersilangan atau terlalu dekat.');
  const { image, width, height, release } = await decode(jpeg);
  const canvas = document.createElement('canvas');
  try {
    signal.throwIfAborted();
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    if (!context) throw new Error('Perangkat ini tidak dapat merapikan foto.');
    context.drawImage(image, 0, 0);
    const source = context.getImageData(0, 0, width, height);
    const size = correctedSize(corners, width, height);
    canvas.width = size.width;
    canvas.height = size.height;
    const result = context.createImageData(size.width, size.height);
    const draw = createRectifier(source, result, corners);
    for (let row = 0; row < size.height; row += 64) {
      signal.throwIfAborted();
      const end = Math.min(row + 64, size.height);
      draw(row, end);
      onProgress(Math.floor(end * 95 / size.height));
      // Give the browser a chance to paint progress and handle cancel.
      await new Promise<void>((resume) => setTimeout(resume, 0));
    }
    signal.throwIfAborted();
    context.putImageData(result, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob?.type === 'image/jpeg') resolve(blob);
        else reject(new Error('Foto yang dirapikan gagal disimpan. Foto sebelumnya masih tersedia.'));
      }, 'image/jpeg', 0.9);
    });
  } finally {
    release();
    canvas.width = canvas.height = 1;
  }
}

export async function scanToPdf(pages: readonly ScanPage[], onProgress?: (done: number) => void): Promise<ScanResult> {
  if (!pages.length || pages.length > MAX_SCAN_PAGES) throw new Error(`Pilih 1 sampai ${MAX_SCAN_PAGES} halaman.`);
  if (pages.reduce((size, page) => size + page.jpeg.size, 0) > MAX_SCAN_BYTES) {
    throw new Error('Foto terlalu besar untuk satu PDF. Kurangi jumlah halaman.');
  }
  const { PDFDocument, degrees } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  pdf.setTitle('Pindaian Alih Media Arsip');
  for (const { jpeg, turns } of pages) {
    const image = await pdf.embedJpg(await jpeg.arrayBuffer());
    const angle = (((turns % 4) + 4) % 4) * 90;
    const swapped = angle === 90 || angle === 270;
    const width = swapped ? image.height : image.width;
    const height = swapped ? image.width : image.height;
    const sheet: [number, number] = width > height ? [A4[1], A4[0]] : A4;
    const page = pdf.addPage(sheet);
    const scale = Math.min((sheet[0] - 2 * MARGIN) / width, (sheet[1] - 2 * MARGIN) / height);
    const left = (sheet[0] - width * scale) / 2;
    const bottom = (sheet[1] - height * scale) / 2;
    page.drawImage(image, {
      x: left + (angle >= 180 ? width * scale : 0),
      y: bottom + (angle === 90 || angle === 180 ? height * scale : 0),
      width: image.width * scale,
      height: image.height * scale,
      rotate: degrees(-angle),
    });
    onProgress?.(pdf.getPageCount());
  }
  const bytes = Uint8Array.from(await pdf.save());
  if (bytes.byteLength > MAX_SCAN_BYTES) throw new Error('PDF harus kurang dari 100 MB. Kurangi jumlah halaman.');
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jakarta' }).format(new Date());
  return { pdf: new Blob([bytes], { type: 'application/pdf' }), fileName: `Pindaian Arsip ${date}.pdf`, pageCount: pages.length };
}
