import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileUrl, openFile, openFolder, safeDriveUrl } from './files';

afterEach(() => vi.unstubAllGlobals());

describe('files (satu-satunya jalur membuka file)', () => {
  it('hanya URL https Google Drive/Docs', () => {
    expect(safeDriveUrl('https://drive.google.com/file/d/A/view')).toBe('https://drive.google.com/file/d/A/view');
    expect(safeDriveUrl('https://docs.google.com/document/d/A')).not.toBeNull();
    expect(safeDriveUrl('javascript:alert(1)')).toBeNull();
    expect(safeDriveUrl('http://drive.google.com/file/d/A')).toBeNull();
    expect(safeDriveUrl('https://evil.example/drive.google.com')).toBeNull();
    expect(safeDriveUrl('')).toBeNull();
  });
  it('memakai ID Drive bila URL tidak ada atau tidak aman', () => {
    expect(fileUrl({ driveFileId: 'abc_D-1', driveFileUrl: null })).toBe('https://drive.google.com/file/d/abc_D-1/view');
    expect(fileUrl({ driveFileId: 'abc', driveFileUrl: 'javascript:x' })).toBe('https://drive.google.com/file/d/abc/view');
    expect(fileUrl({ driveFileId: '../x', driveFileUrl: null })).toBeNull();
  });
  it('membuka tab baru tanpa opener; menolak bila tidak ada file', () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    expect(openFile({ driveFileId: 'abc', driveFileUrl: null })).toEqual({ ok: true });
    expect(open).toHaveBeenCalledWith('https://drive.google.com/file/d/abc/view', '_blank', 'noopener,noreferrer');
    expect(openFile({ driveFileId: null, driveFileUrl: null })).toEqual({ ok: false, message: 'PDF belum diunggah untuk arsip ini.' });
    expect(openFolder(null).ok).toBe(false);
  });
});
