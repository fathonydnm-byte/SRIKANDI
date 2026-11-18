import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { correctScanPhoto, prepareScanPhoto, scanToPdf } from '../../lib/scan';
import { recognizeScan } from '../../lib/scanOcr';
import { ScanDialog } from './ScanDialog';

vi.mock('../../lib/scanOcr', () => ({ recognizeScan: vi.fn() }));

vi.mock('../../lib/scan', async (getActual) => ({
  ...await getActual<typeof import('../../lib/scan')>(),
  correctScanPhoto: vi.fn(),
  prepareScanPhoto: vi.fn(),
  scanToPdf: vi.fn(),
}));

it('captures camera input, adds gallery pages, and passes reordered and rotated photos only on confirmation', async () => {
  const first = new Blob(['foto pertama'], { type: 'image/jpeg' });
  const second = new Blob(['foto kedua'], { type: 'image/jpeg' });
  const result = { pdf: new Blob(['PDF'], { type: 'application/pdf' }), fileName: 'Pindaian Arsip.pdf', pageCount: 2 };
  vi.mocked(prepareScanPhoto).mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  vi.mocked(scanToPdf).mockResolvedValueOnce(result);
  const onUse = vi.fn();
  const onCancel = vi.fn();
  const user = userEvent.setup();
  try {
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => 'blob:preview-test');
      static revokeObjectURL = vi.fn();
    });
    render(<ScanDialog onUse={onUse} onCancel={onCancel} />);
    const dialog = within(screen.getByRole('dialog', { name: 'Pindai arsip' }));
    const camera = dialog.getByLabelText('Ambil foto');
    expect(camera).toHaveAttribute('capture', 'environment');
    await user.upload(camera, new File(['jpeg-1'], 'photo.jpg', { type: 'image/jpeg' }));
    await dialog.findByText('Halaman 1');
    await user.upload(dialog.getByLabelText('Pilih dari galeri'), new File(['jpeg-2'], 'gallery.jpg', { type: 'image/jpeg' }));
    await dialog.findByText('Halaman 2');
    await user.click(dialog.getByRole('button', { name: 'Putar halaman 2' }));
    await user.click(dialog.getByRole('button', { name: 'Geser halaman 2 ke atas' }));
    expect(onUse).not.toHaveBeenCalled();
    await user.click(dialog.getByRole('button', { name: 'Gunakan PDF' }));
    expect(scanToPdf).toHaveBeenCalledWith([{ id: 2, jpeg: second, turns: 1 }, { id: 1, jpeg: first, turns: 0 }], expect.any(Function));
    expect(onUse).toHaveBeenCalledExactlyOnceWith(result);
    expect(onCancel).not.toHaveBeenCalled();
  } finally {
    cleanup();
    vi.unstubAllGlobals();
  }
});

it.each([false, true])('generates the PDF from the chosen page image (restored=%s)', async (restore) => {
  const original = new Blob(['original'], { type: 'image/jpeg' });
  const cropped = new Blob(['perspective corrected'], { type: 'image/jpeg' });
  const result = { pdf: new Blob(['PDF'], { type: 'application/pdf' }), fileName: 'Pindaian Arsip.pdf', pageCount: 1 };
  vi.mocked(prepareScanPhoto).mockResolvedValueOnce(original);
  vi.mocked(correctScanPhoto).mockClear().mockResolvedValueOnce(cropped);
  vi.mocked(scanToPdf).mockClear().mockResolvedValueOnce(result);
  const onUse = vi.fn();
  const user = userEvent.setup();
  try {
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => 'blob:preview-test');
      static revokeObjectURL = vi.fn();
    });
    render(<ScanDialog onUse={onUse} onCancel={vi.fn()} />);
    await user.upload(screen.getByLabelText('Ambil foto'), new File(['jpeg'], 'photo.jpg', { type: 'image/jpeg' }));
    await user.click(await screen.findByRole('button', { name: 'Putar halaman 1' }));
    const openEditor = async () => {
      await user.click(screen.getByRole('button', { name: 'Rapikan sudut halaman 1' }));
      const preview = screen.getByRole('img', { name: 'Foto asli untuk penyesuaian sudut' });
      Object.defineProperties(preview, { naturalWidth: { value: 800 }, naturalHeight: { value: 1200 } });
      fireEvent.load(preview);
    };
    await openEditor();
    screen.getByRole('button', { name: 'Sudut kiri atas' }).focus();
    await user.keyboard('{ArrowRight}');
    await user.click(screen.getByRole('button', { name: 'Terapkan' }));
    await screen.findByText('Perspektif dirapikan');
    expect(correctScanPhoto).toHaveBeenCalledWith(original, [
      { x: 0.01, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 },
    ], expect.any(AbortSignal), expect.any(Function));

    await openEditor();
    await user.click(screen.getByRole('button', { name: 'Pakai batas foto asli' }));
    await user.click(screen.getByRole('button', { name: restore ? 'Terapkan' : 'Kembali' }));
    expect(correctScanPhoto).toHaveBeenCalledTimes(1);
    expect(onUse).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Gunakan PDF' }));
    expect(scanToPdf).toHaveBeenCalledWith([
      expect.objectContaining({ jpeg: restore ? original : cropped, turns: 1 }),
    ], expect.any(Function));
    expect(onUse).toHaveBeenCalledExactlyOnceWith(result);
  } finally {
    cleanup();
    vi.unstubAllGlobals();
  }
});

it.each(['success', 'skip', 'failure'] as const)('keeps the PDF usable when OCR results in %s', async (kind) => {
  const jpeg = new Blob(['original'], { type: 'image/jpeg' });
  const layer = new Uint8Array([1, 2, 3]);
  const result = { pdf: new Blob(['PDF'], { type: 'application/pdf' }), fileName: 'Pindaian Arsip.pdf', pageCount: 1 };
  vi.mocked(prepareScanPhoto).mockResolvedValueOnce(jpeg);
  vi.mocked(scanToPdf).mockClear().mockResolvedValueOnce(result);
  vi.mocked(recognizeScan).mockClear().mockImplementationOnce(async (_, signal, progress) => {
    progress({ page: 1, total: 1, percent: 20 });
    if (kind === 'success') return { layers: [layer], pages: ['Surat Keputusan'] };
    if (kind === 'failure') throw new Error('Missing worker model');
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    signal.throwIfAborted();
    return { layers: [], pages: [] };
  });
  const onUse = vi.fn();
  const user = userEvent.setup();
  try {
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => 'blob:preview-test');
      static revokeObjectURL = vi.fn();
    });
    render(<ScanDialog onUse={onUse} onCancel={vi.fn()} />);
    await user.upload(screen.getByLabelText('Ambil foto'), new File(['jpeg'], 'photo.jpg', { type: 'image/jpeg' }));
    await screen.findByText('Halaman 1');
    const ocr = screen.getByRole('checkbox', { name: /Kenali teks/ });
    expect(ocr).not.toBeChecked();
    expect(recognizeScan).not.toHaveBeenCalled();
    await user.click(ocr);
    await user.click(screen.getByRole('button', { name: 'Gunakan PDF' }));
    if (kind === 'skip') {
      await screen.findByText(/Membaca teks halaman 1 dari 1 · 20%/);
      expect(onUse).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: 'Lewati OCR' }));
    }
    const expected = kind === 'success' ? 1 : kind === 'skip' ? 'lewati' : 'gagal';
    expect(onUse).toHaveBeenCalledExactlyOnceWith({
      ...result, ocr: expected,
      ...(kind === 'success' ? { indexContent: { pages: ['Surat Keputusan'], truncated: false } } : {}),
    });
    const scanArgs = [[{ id: 1, jpeg, turns: 0 }], expect.any(Function)];
    if (kind === 'success') scanArgs.push([layer]);
    expect(scanToPdf).toHaveBeenCalledExactlyOnceWith(...scanArgs);
  } finally {
    cleanup();
    vi.unstubAllGlobals();
  }
});
