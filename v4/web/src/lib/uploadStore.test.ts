import { afterEach, expect, it, vi } from 'vitest';
import { startUpload, type UploadResult } from './uploader';
import { uploads } from './uploadStore';

vi.mock('./uploader', () => ({ startUpload: vi.fn() }));
afterEach(() => uploads.reset());

it('indexes only after PDF commit and retries a failed index without uploading again', async () => {
  let commit!: (result: UploadResult) => void;
  vi.mocked(startUpload).mockReturnValueOnce({
    promise: new Promise((resolve) => { commit = resolve; }),
    pause: vi.fn(), resume: vi.fn(), abort: vi.fn(),
  });
  const index = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce({ indexed_pages: 1 });
  const result = { sessionId: 'session-1', driveFileId: 'drive-1', result: {} };
  const id = uploads.start({
    purpose: 'ITEM_PDF', objectId: 'ITM-1', fileName: 'input.pdf', file: new Blob(['test']),
  }, 'PDF', undefined, index);
  expect(index).not.toHaveBeenCalled();
  commit(result);
  await vi.waitFor(() => expect(uploads.snapshot()[0]?.indexState).toBe('failed'));
  expect(uploads.snapshot()[0]?.result).toEqual(result);
  expect(uploads.snapshot()[0]?.error).toBeNull();
  uploads.retryIndex(id);
  await vi.waitFor(() => expect(uploads.snapshot()[0]?.indexState).toBe('ready'));
  expect(startUpload).toHaveBeenCalledTimes(1);
  expect(index.mock.calls).toEqual([[result], [result]]);
});
