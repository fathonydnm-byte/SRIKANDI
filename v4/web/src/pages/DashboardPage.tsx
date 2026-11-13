import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth, useProfile } from '../auth/AuthContext';
import { can, ROLE_LABELS } from '../auth/permissions';
import type { DeniedState } from '../auth/guards';
import { Alert } from '../components/Alert';
import { HealthIndicator } from '../components/HealthIndicator';
import { PageHeader } from '../components/PageHeader';
import { useActiveUnitLabel } from '../components/UnitSwitcher';
import { APP_VERSION } from '../config';
import { getDashboardCounts, type DashboardCounts } from '../lib/api';
import { formatNumber } from '../lib/format';
import { formatJakartaDate, greetingFor } from '../lib/greeting';
import { useLoad } from '../lib/useLoad';

interface StatDef {
  key: keyof DashboardCounts;
  label: string;
  icon: string;
  to?: string;
  hint?: string;
  tone?: 'warn';
}

function QuickSearch() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  function submit(e: FormEvent) {
    e.preventDefault();
    navigate(q.trim() ? `/cari?q=${encodeURIComponent(q.trim())}` : '/cari');
  }
  return (
    <form className="search-bar quick-search" role="search" onSubmit={submit}>
      <label htmlFor="quick-q" className="sr-only">
        Cari arsip
      </label>
      <input id="quick-q" type="search" enterKeyHint="search" placeholder="Cari nomor surat, uraian, lokasi…" value={q} onChange={(e) => setQ(e.target.value)} />
      <button type="submit" className="btn btn-primary">
        Cari
      </button>
    </form>
  );
}

export function DashboardPage() {
  const { profile } = useProfile();
  const { state, client, activeUnitId } = useAuth();
  const location = useLocation();
  const denied = (location.state as DeniedState | null)?.denied;
  const unitLabel = useActiveUnitLabel();
  const email = state.status === 'signedIn' ? state.session.user.email : '';
  const unitId = can(profile.role, 'unit.pilih') ? activeUnitId : null;
  const [counts, retry] = useLoad(`counts:${unitId ?? 'all'}`, () => getDashboardCounts(client, unitId));

  const stats: StatDef[] = [
    { key: 'berkas_aktif', label: 'Berkas aktif', icon: '🗂️' },
    { key: 'item_aktif', label: 'Item arsip aktif', icon: '📄' },
    { key: 'item_tanpa_pdf', label: 'Item belum ada PDF', icon: '🖨️', to: '/cari?file=BELUM_DIUNGGAH', hint: 'Lihat daftarnya', tone: 'warn' },
    {
      key: 'penerimaan_menunggu',
      label: 'Penerimaan menunggu pemberkasan',
      icon: '📥',
      tone: 'warn',
      ...(can(profile.role, 'arsip.kelola') ? { to: '/penerimaan', hint: 'Buka Penerimaan' } : {}),
    },
  ];

  return (
    <>
      {denied ? (
        <Alert tone="warning">
          <strong>Anda tidak memiliki akses ke {denied}.</strong>{' '}
          <span>Menu itu tidak tersedia untuk peran {ROLE_LABELS[profile.role]}. Bila Anda memerlukannya, hubungi admin unit.</span>
        </Alert>
      ) : null}
      <PageHeader title={`${greetingFor()}, ${profile.full_name || email}`} subtitle={formatJakartaDate()} />

      <QuickSearch />

      <section aria-labelledby="stats-title" className="stats-section">
        <h2 id="stats-title" className="sr-only">
          Ringkasan arsip {unitLabel}
        </h2>
        {counts.kind === 'error' ? (
          <div className="stack">
            <Alert tone="error" message={counts.message} />
            <button type="button" className="btn btn-secondary" onClick={retry}>
              Muat ulang ringkasan
            </button>
          </div>
        ) : (
          <div className="stat-grid" aria-busy={counts.kind === 'loading' ? true : undefined}>
            {stats.map((s) => {
              const value = counts.kind === 'ok' ? counts.data[s.key] : null;
              const inner = (
                <>
                  <span className="stat-icon" aria-hidden="true">{s.icon}</span>
                  <span className="stat-text">
                    <span className="stat-label">{s.label}</span>
                    <strong className={value === null ? 'stat-value loading' : 'stat-value'}>{value === null ? '…' : formatNumber(value)}</strong>
                    {s.to && s.hint ? <span className="stat-hint">{s.hint} ›</span> : null}
                  </span>
                </>
              );
              const cls = `stat-card${s.tone === 'warn' && value ? ' warn' : ''}`;
              return s.to ? (
                <Link key={s.key} to={s.to} className={`${cls} stat-link`}>
                  {inner}
                </Link>
              ) : (
                <div key={s.key} className={cls}>
                  {inner}
                </div>
              );
            })}
          </div>
        )}
      </section>

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
    </>
  );
}
