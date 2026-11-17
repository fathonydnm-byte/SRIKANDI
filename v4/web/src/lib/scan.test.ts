// @vitest-environment node
import { expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { MAX_SCAN_PAGES, prepareScanPhoto, scanToPdf } from './scan';

// Synthetic raster, 40 x 60 px; no device data or camera permission needed.
const IMG = new Blob([Uint8Array.from(Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAA8ACgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AL+AAAAAAAAAAAAAAAAAAAAAAAD/2Q==', 'base64'))], { type: 'image/jpeg' });

it('builds a valid PDF in the requested order and fits a rotated page on A4 landscape', async () => {
  const progress: number[] = [];
  const result = await scanToPdf([{ jpeg: IMG, turns: 1 }, { jpeg: IMG, turns: 0 }], (n) => progress.push(n));
  expect(result.pdf.type).toBe('application/pdf');
  expect(result.pageCount).toBe(2);
  expect(result.fileName).toMatch(/^Pindaian Arsip \d{4}-\d{2}-\d{2}\.pdf$/);
  const document = await PDFDocument.load(await result.pdf.arrayBuffer());
  expect(document.getPages().map((p) => p.getSize())).toEqual([
    { width: 841.89, height: 595.28 }, { width: 595.28, height: 841.89 },
  ]);
  expect(progress).toEqual([1, 2]);
});

it('refuses empty, oversized batches and files outside the accepted photo formats', async () => {
  await expect(scanToPdf([])).rejects.toThrow('Pilih 1');
  await expect(scanToPdf(Array(MAX_SCAN_PAGES + 1).fill({ jpeg: IMG, turns: 0 }))).rejects.toThrow('Pilih 1');
  await expect(prepareScanPhoto(new File(['<svg/>'], 'test.svg', { type: 'image/svg+xml' }))).rejects.toThrow('JPG');
  await expect(prepareScanPhoto(new File([], 'empty.jpg', { type: 'image/jpeg' }))).rejects.toThrow('24 MB');
});
