import { useState } from 'react';
import { FILE_ACCESS_NOTE, fileUrl, openFile, openFolder, safeDriveUrl, type FileRef } from '../lib/files';

/** Tombol buka PDF/folder. Semua lewat src/lib/files.ts. */
export function FileActions({ file, folderUrl, compact = false }: { file?: FileRef; folderUrl?: string | null; compact?: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const canOpenFile = file ? fileUrl(file) !== null : false;
  const canOpenFolder = safeDriveUrl(folderUrl) !== null;
  return (
    <div className="file-actions">
      <div className="action-row">
        {file ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canOpenFile}
            onClick={() => {
              const r = openFile(file);
              setError(r.ok ? null : r.message);
            }}
          >
            {canOpenFile ? 'Buka PDF' : 'Belum ada PDF'}
          </button>
        ) : null}
        {folderUrl !== undefined ? (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!canOpenFolder}
            onClick={() => {
              const r = openFolder(folderUrl);
              setError(r.ok ? null : r.message);
            }}
          >
            {canOpenFolder ? 'Buka folder Drive' : 'Folder belum tercatat'}
          </button>
        ) : null}
      </div>
      {error ? <p className="action-msg is-error" role="alert">{error}</p> : null}
      {!compact && (canOpenFile || canOpenFolder) ? <p className="file-note">ⓘ {FILE_ACCESS_NOTE}</p> : null}
    </div>
  );
}
