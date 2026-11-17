import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { prepareScanPhoto, scanToPdf } from '../../lib/scan';
import { ScanDialog } from './ScanDialog';

vi.mock('../../lib/scan', async (getActual) => ({
  ...await getActual<typeof import('../../lib/scan')>(),
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
