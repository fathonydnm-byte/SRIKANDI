import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { Sheet } from './Sheet';

describe('Sheet', () => {
  it('Escape menutup walau fokus lepas ke body (tombol dinonaktifkan saat menyimpan)', () => {
    const onClose = vi.fn();
    render(<Sheet title="Uji" onClose={onClose} variant="dialog"><button type="button">x</button></Sheet>);
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('Escape di dalam dialog ditangani sekali', () => {
    const onClose = vi.fn();
    const { getByRole } = render(<Sheet title="Uji" onClose={onClose} variant="dialog"><button type="button">x</button></Sheet>);
    fireEvent.keyDown(getByRole('button', { name: 'x' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
