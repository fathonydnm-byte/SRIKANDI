import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Alert } from '../../components/Alert';
import type { UserMessage } from '../../lib/errors';
import type { FromSearchState } from '../search/SearchResultCard';

/** Kembali ke hasil pencarian terakhir (dengan query di URL) bila datang dari sana. */
export function BackToResults() {
  const location = useLocation();
  const from = (location.state as FromSearchState | null)?.fromSearch;
  return (
    <Link className="back-link" to={from !== undefined ? `/cari${from}` : '/cari'}>
      ‹ {from !== undefined ? 'Kembali ke hasil pencarian' : 'Ke Pencarian Arsip'}
    </Link>
  );
}

export function DetailLoading({ label }: { label: string }) {
  return (
    <div className="detail-loading" aria-busy="true">
      <span className="spinner" aria-hidden="true" />
      <p role="status">{label}</p>
    </div>
  );
}

export function DetailError({ message, onRetry }: { message: UserMessage; onRetry(): void }) {
  return (
    <div className="stack">
      <Alert tone="error" message={message} />
      <button type="button" className="btn btn-secondary" onClick={onRetry}>
        Coba lagi
      </button>
    </div>
  );
}

export function NotVisible({ what }: { what: string }) {
  return (
    <div className="empty-state card">
      <h2 className="section-title">{what} tidak ditemukan</h2>
      <p className="muted">Data ini tidak ada atau berada di unit lain yang tidak bisa Anda lihat. Periksa tautannya, atau cari ulang dari Pencarian Arsip.</p>
      <Link className="btn btn-secondary" to="/cari">
        Ke Pencarian Arsip
      </Link>
    </div>
  );
}

export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="facts">
      {rows.map(([k, v]) => (
        <div key={k} className="fact">
          <dt>{k}</dt>
          <dd>{v === null || v === undefined || v === '' ? '–' : v}</dd>
        </div>
      ))}
    </dl>
  );
}
