import { Link, useLocation } from 'react-router-dom';
import { useAuth, useProfile } from '../../auth/AuthContext';
import { can, ROLE_LABELS } from '../../auth/permissions';
import type { DeniedState } from '../../auth/guards';
import { Alert } from '../../components/Alert';
import { PageHeader } from '../../components/PageHeader';
import { getDashboardOverview, type DashboardCounts } from '../../lib/api';
import { formatNumber } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import { ArchiveOverview } from './ArchiveOverview';
import { SHORTCUTS } from './shortcuts';

function StatValue({ value }: { value: number | null }) {
  return <strong className={value === null ? 'stat-value loading' : 'stat-value'}>{value === null ? '…' : formatNumber(value)}</strong>;
}

/** Dashboard 3.x: lima kartu, ajakan input, lalu Daftar Isi Berkas. */
export function DashboardPage() {
  const { profile } = useProfile();
  const { client, activeUnitId } = useAuth();
  const location = useLocation();
  const denied = (location.state as DeniedState | null)?.denied;
  const unitId = can(profile.role, 'unit.pilih') ? activeUnitId : null;
  const [overview, reload] = useLoad(`overview:${unitId ?? 'all'}`, () => getDashboardOverview(client, unitId));
  const counts: DashboardCounts | null = overview.kind === 'ok' ? overview.data.counts : null;
  const unitQuery = unitId ? `?unit=${encodeURIComponent(unitId)}` : '';

  return (
    <>
      {denied ? (
        <Alert tone="warning">
          <strong>Anda tidak memiliki akses ke {denied}.</strong>{' '}
          <span>Menu itu tidak tersedia untuk peran {ROLE_LABELS[profile.role]}. Bila Anda memerlukannya, hubungi admin unit.</span>
        </Alert>
      ) : null}
      <PageHeader title="Dashboard" subtitle="Ringkasan kondisi arsip Anda." />

      {overview.kind === 'error' ? (
        <div className="stack stats-section">
          <Alert tone="error" message={overview.message} />
          <button type="button" className="btn btn-secondary" onClick={reload}>
            Muat ulang
          </button>
        </div>
      ) : null}

      <section aria-label="Ringkasan arsip" className="stats-section">
        <div className="stat-grid" aria-busy={overview.kind === 'loading' ? true : undefined}>
          <div className="stat-card">
            <span className="stat-icon" aria-hidden="true">📁</span>
            <span className="stat-text">
              <span className="stat-label">Total Berkas</span>
              <StatValue value={counts?.total_berkas ?? null} />
            </span>
          </div>
          <div className="stat-card">
            <span className="stat-icon" aria-hidden="true">📄</span>
            <span className="stat-text">
              <span className="stat-label">Total Item</span>
              <StatValue value={counts?.total_item ?? null} />
            </span>
          </div>
          {SHORTCUTS.map((s) => (
            <Link key={s.kind} to={`/dashboard/${s.slug}${unitQuery}`} className={`stat-card stat-link tone-${s.tone}`}>
              <span className="stat-icon" aria-hidden="true">{s.icon}</span>
              <span className="stat-text">
                <span className="stat-label">{s.title}</span>
                <StatValue value={counts ? counts[s.countKey] : null} />
                <span className="stat-hint">Lihat rincian →</span>
              </span>
            </Link>
          ))}
        </div>
      </section>

      {can(profile.role, 'arsip.kelola') ? (
        <section className="card cta-card" aria-labelledby="cta-title">
          <h2 id="cta-title" className="section-title">Input berkas dan item dalam satu layar</h2>
          <p className="muted">Buat berkas baru atau lanjutkan input item pada berkas yang sudah ada.</p>
          <Link to="/pemberkasan" className="btn btn-primary">
            Mulai Input Arsip
          </Link>
        </section>
      ) : null}

      {overview.kind === 'ok' ? (
        <ArchiveOverview groups={overview.data.groups} unitId={unitId} onRefresh={reload} refreshing={false} />
      ) : overview.kind === 'loading' ? (
        <section className="card archive-card" aria-busy="true">
          <h2 className="section-title">Daftar Isi Berkas</h2>
          <p className="muted" role="status">
            Memuat daftar berkas dan item…
          </p>
        </section>
      ) : null}
    </>
  );
}
