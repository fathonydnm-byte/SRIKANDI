import { Link, useLocation } from 'react-router-dom';
import { useAuth, useProfile } from '../auth/AuthContext';
import { ROLE_LABELS, visibleModules } from '../auth/permissions';
import { Alert } from '../components/Alert';
import { HealthIndicator } from '../components/HealthIndicator';
import { PageHeader } from '../components/PageHeader';
import { APP_VERSION } from '../config';
import { formatJakartaDate, greetingFor } from '../lib/greeting';
import type { DeniedState } from '../auth/guards';
import { useActiveUnitLabel } from '../components/UnitSwitcher';

export function DashboardPage() {
  const { profile } = useProfile();
  const { state } = useAuth();
  const location = useLocation();
  const denied = (location.state as DeniedState | null)?.denied;
  const unitLabel = useActiveUnitLabel();
  const upcoming = visibleModules(profile.role).filter((m) => m.sprint !== 'S0');
  const email = state.status === 'signedIn' ? state.session.user.email : '';

  return (
    <>
      {denied ? (
        <Alert tone="warning">
          <strong>Anda tidak memiliki akses ke {denied}.</strong>{' '}
          <span>Menu itu tidak tersedia untuk peran {ROLE_LABELS[profile.role]}. Bila Anda memerlukannya, hubungi admin unit.</span>
        </Alert>
      ) : null}
      <PageHeader title={`${greetingFor()}, ${profile.full_name || email}`} subtitle={formatJakartaDate()} />

      <div className="info-grid">
        <div className="info-card">
          <span className="info-icon" aria-hidden="true">🏢</span>
          <div>
            <span className="info-label">Unit</span>
            <strong>{unitLabel}</strong>
          </div>
        </div>
        <div className="info-card">
          <span className="info-icon" aria-hidden="true">👤</span>
          <div>
            <span className="info-label">Peran</span>
            <strong>{ROLE_LABELS[profile.role]}</strong>
          </div>
        </div>
        <div className="info-card">
          <span className="info-icon" aria-hidden="true">🏷️</span>
          <div>
            <span className="info-label">Versi aplikasi</span>
            <strong>{APP_VERSION}</strong>
          </div>
        </div>
      </div>

      <section className="card" aria-labelledby="health-title">
        <h2 id="health-title" className="section-title">Koneksi server</h2>
        <HealthIndicator />
      </section>

      {upcoming.length ? (
        <section className="card" aria-labelledby="roadmap-title">
          <h2 id="roadmap-title" className="section-title">Modul untuk peran Anda</h2>
          <p className="muted small">Central File v4 sedang dibangun bertahap. Modul berikut akan aktif sesuai jadwal sprint.</p>
          <ul className="module-list">
            {upcoming.map((m) => (
              <li key={m.id}>
                <Link to={m.path}>
                  <span aria-hidden="true">{m.icon}</span>
                  <span className="module-name">{m.label}</span>
                  <span className="chip">Sprint {m.sprint.slice(1)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}
