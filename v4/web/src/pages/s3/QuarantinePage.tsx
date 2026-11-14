import { useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { Alert } from '../../components/Alert';
import { PageHeader } from '../../components/PageHeader';
import type { UserMessage } from '../../lib/errors';
import { FileAccessError, fileError, openFile } from '../../lib/files';
import { formatNumber } from '../../lib/format';
import { s3, type QuarantineRow } from '../../lib/s3api';
import { useLoad } from '../../lib/useLoad';
import { formatTimestamp, NeedsUnit, useGetToken, useWriteUnit } from '../s2/common';
import './editCancel.css';

function OpenOld({ row }: { row: QuarantineRow }) {
  const getToken = useGetToken();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UserMessage | null>(null);
  if (row.object_type !== 'FILE' || !row.object_id || !row.downloadable) return <p className="muted small">File lama tidak dapat dibuka dari aplikasi.</p>;
  return (
    <div>
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={async () => {
        setBusy(true);
        setError(null);
        try {
          await openFile({ driveFileId: row.object_id, driveFileUrl: row.original_url, fileName: row.original_name }, getToken);
        } catch (e) {
          setError((e instanceof FileAccessError ? e : fileError('UNKNOWN')).userMessage);
        } finally {
          setBusy(false);
        }
      }}>{busy ? 'Membuka…' : 'Buka file lama'}</button>
      {error ? <p className="action-msg is-error" role="alert"><strong>{error.title}</strong> {error.action}</p> : null}
    </div>
  );
}

/** Karantina: file/folder yang diganti atau dibatalkan. Hanya Admin; hanya-baca. */
export function QuarantinePage() {
  const { client } = useAuth();
  const { unitId, needsUnit } = useWriteUnit();
  const [load, retry] = useLoad(`karantina:${unitId ?? 'own'}`, () => s3.quarantineList(client, unitId));
  if (needsUnit) return (<><PageHeader title="Karantina" subtitle="File lama yang diganti atau dibatalkan." /><NeedsUnit /></>);
  return (
    <>
      <PageHeader title="Karantina" subtitle="File dan folder yang diganti atau dibatalkan. Tidak ada yang dihapus; hanya Admin yang dapat membukanya." />
      {load.kind === 'loading' ? <p className="muted" role="status">Memuat karantina…</p> : null}
      {load.kind === 'error' ? <div className="stack"><Alert tone="error" message={load.message} /><button type="button" className="btn btn-secondary" onClick={retry}>Coba lagi</button></div> : null}
      {load.kind === 'ok' ? (
        <>
          <p className="muted small">{formatNumber(load.data.total)} catatan{load.data.items.length < load.data.total ? `, menampilkan ${formatNumber(load.data.items.length)} terbaru` : ''}.</p>
          {load.data.items.length === 0 ? <p className="muted">Karantina masih kosong.</p> : null}
          <ul className="q-list">
            {load.data.items.map((r) => (
              <li key={r.id} className="q-card">
                <h3>{r.original_name || r.object_id || r.id}</h3>
                <div className="badge-row">
                  <span className="badge-pill badge-info">{r.object_type === 'FOLDER' ? 'Folder' : 'File'}</span>
                  <span className={`badge-pill ${r.status === 'FAILED' ? 'badge-danger' : 'badge-ok'}`}>{r.status ?? '–'}</span>
                  {r.module ? <span className="badge-pill badge-neutral">{r.module}</span> : null}
                </div>
                <dl className="q-meta">
                  <dt>Alasan</dt><dd>{r.reason || '–'}</dd>
                  <dt>Waktu</dt><dd>{formatTimestamp(r.occurred_at)}</dd>
                  <dt>Pelaku</dt><dd>{r.user_email || '–'}</dd>
                  <dt>Terkait</dt><dd>{[r.related_object_type, r.related_object_id].filter(Boolean).join(' ') || r.berkas_id || '–'}{r.pembatalan_id ? ` · ${r.pembatalan_id}` : ''}</dd>
                  {r.notes ? (<><dt>Catatan</dt><dd>{r.notes}</dd></>) : null}
                </dl>
                <OpenOld row={r} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}
