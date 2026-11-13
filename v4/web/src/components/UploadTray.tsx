import { useEffect } from 'react';
import { useAuth } from '../auth/AuthContext';
import { percent, STAGE_LABELS, uploads, useUploads, type UploadJob } from '../lib/uploadStore';

function JobRow({ job }: { job: UploadJob }) {
  const p = job.progress;
  const pct = percent(p);
  const done = p.stage === 'selesai';
  const failed = Boolean(job.error) && p.stage !== 'dibatalkan';
  const active = !done && !failed && p.stage !== 'dibatalkan';
  return (
    <li className={`upload-job${done ? ' is-done' : ''}${failed ? ' is-failed' : ''}`}>
      <div className="upload-job-top">
        <span className="upload-job-label">{job.label}</span>
        <span className="upload-job-stage">
          {STAGE_LABELS[p.stage]}
          {p.stage === 'mengunggah' ? ` ${pct}%` : ''}
        </span>
      </div>
      <progress className="upload-bar" max={100} value={done ? 100 : pct} aria-label={`Unggah ${job.label}`} />
      {failed && job.error ? (
        <p className="upload-job-error" role="alert">
          <strong>{job.error.title}</strong> {job.error.action}
        </p>
      ) : null}
      <div className="upload-job-actions">
        {active && !job.paused ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => uploads.pause(job.id)}>
            Jeda
          </button>
        ) : null}
        {active && job.paused ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => uploads.resume(job.id)}>
            Lanjutkan
          </button>
        ) : null}
        {active ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => uploads.abort(job.id)}>
            Batalkan
          </button>
        ) : null}
        {failed ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => uploads.retry(job.id)}>
            Coba lagi
          </button>
        ) : null}
        {!active ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => uploads.dismiss(job.id)}>
            Tutup
          </button>
        ) : null}
      </div>
    </li>
  );
}

/** Status unggahan yang sedang berjalan, tampil di semua halaman. */
export function UploadTray() {
  const { client } = useAuth();
  const jobs = useUploads();
  useEffect(() => {
    uploads.configure(async () => (await client.auth.getSession()).data.session?.access_token ?? null);
  }, [client]);
  // Peringatan bila menutup tab saat masih mengunggah.
  const busy = jobs.some((j) => !j.error && j.progress.stage !== 'selesai' && j.progress.stage !== 'dibatalkan');
  useEffect(() => {
    if (!busy) return;
    const onUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [busy]);
  if (!jobs.length) return null;
  return (
    <section className="upload-tray" aria-label="Unggahan">
      <ul>
        {jobs.map((j) => (
          <JobRow key={j.id} job={j} />
        ))}
      </ul>
    </section>
  );
}
