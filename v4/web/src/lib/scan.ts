/*
 * TITIK SAMBUNG pemindai kamera (Sprint 6, PRD §5 butir 3).
 *
 * Kontrak: buka pemindai (kamera → deteksi tepi → koreksi perspektif → banyak
 * halaman → PDF, opsional OCR) dan kembalikan satu PDF sebagai Blob, atau
 * null bila pengguna membatalkan. Hasilnya diunggah persis seperti file PDF
 * yang dipilih manual (src/lib/uploader.ts). Belum diimplementasikan.
 */
export interface ScanResult {
  pdf: Blob;
  fileName: string;
  pageCount: number;
}

export const SCANNER_AVAILABLE = false;

export async function scanToPdf(): Promise<ScanResult | null> {
  throw new Error('Pemindai kamera belum tersedia (Sprint 6).');
}
