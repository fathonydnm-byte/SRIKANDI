import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import {
  downloadFile,
  FILE_ACCESS_MODE,
  FileAccessError,
  fileError,
  hasFile,
  openFile,
  prepareShareFile,
  safeDriveUrl,
  shareEligible,
  shareFile,
  type FileRef,
} from '../lib/files';
import type { UserMessage } from '../lib/errors';

type Busy = null | 'open' | 'download' | 'share';

/** Tombol Lihat / Unduh / Bagikan berkas. Semua lewat src/lib/files.ts. */
export function FileActions({ file, folderUrl, shareTitle }: { file?: FileRef; folderUrl?: string | null; shareTitle?: string }) {
  const { client } = useAuth();
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<UserMessage | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ready, setReady] = useState<File | null>(null);

  const getToken = async () => (await client.auth.getSession()).data.session?.access_token ?? null;
  const available = file ? hasFile(file) : false;
  const canShare = file ? shareEligible(file) : false;
  const legacyFolder = FILE_ACCESS_MODE === 'drive-url' ? safeDriveUrl(folderUrl) : null;

  async function run(kind: Exclude<Busy, null>, action: () => Promise<void>) {
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof FileAccessError ? e.userMessage : fileError('UNKNOWN').userMessage);
    } finally {
      setBusy(null);
    }
  }

  async function sendShare(f: File) {
    const outcome = await shareFile(f, shareTitle ?? f.name);
    if (outcome === 'needs-gesture') {
      setReady(f);
      setNotice('Berkas siap. Tekan "Kirim sekarang" untuk membagikan.');
    } else {
      setReady(null);
      if (outcome === 'shared') setNotice('Berkas dibagikan.');
    }
  }

  if (!file && !legacyFolder) return null;

  return (
    <div className="file-actions">
      {file ? (
        available ? (
          <div className="action-row">
            <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => void run('open', () => openFile(file, getToken))}>
              {busy === 'open' ? 'Membuka…' : 'Lihat PDF'}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy !== null}
              onClick={() =>
                void run('download', async () => {
                  await downloadFile(file, getToken);
                  setNotice('Unduhan dimulai.');
                })
              }
            >
              {busy === 'download' ? 'Menyiapkan…' : 'Unduh'}
            </button>
            {canShare ? (
              ready ? (
                <button type="button" className="btn btn-secondary" onClick={() => void run('share', () => sendShare(ready))}>
                  Kirim sekarang
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy !== null}
                  onClick={() =>
                    void run('share', async () => {
                      const f = await prepareShareFile(file, getToken);
                      await sendShare(f);
                    })
                  }
                >
                  {busy === 'share' ? 'Menyiapkan…' : 'Bagikan berkas'}
                </button>
              )
            ) : null}
          </div>
        ) : (
          <p className="muted">PDF belum diunggah untuk arsip ini.</p>
        )
      ) : null}
      {legacyFolder ? (
        <div className="action-row">
          <button type="button" className="btn btn-secondary" onClick={() => window.open(legacyFolder, '_blank', 'noopener,noreferrer')}>
            Buka folder Drive
          </button>
        </div>
      ) : null}
      <p className={`action-msg${error ? ' is-error' : ''}`} role={error ? 'alert' : 'status'} aria-live="polite">
        {error ? (
          <>
            <strong>{error.title}</strong> {error.action}
          </>
        ) : (
          (notice ?? '')
        )}
      </p>
    </div>
  );
}
