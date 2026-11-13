import { Link } from 'react-router-dom';
import type { ModuleDef } from '../auth/permissions';
import { PageHeader } from '../components/PageHeader';
import { SPRINTS } from '../lib/sprints';

/** Halaman bersama untuk modul yang belum dibangun. */
export function PlaceholderPage({ module }: { module: ModuleDef }) {
  const sprint = SPRINTS[module.sprint];
  return (
    <>
      <PageHeader title={module.label} subtitle={module.summary} />
      <section className="card placeholder">
        <span className="placeholder-icon" aria-hidden="true">{module.icon}</span>
        <h2 className="section-title">Modul ini belum tersedia</h2>
        <p>
          <strong>{module.label}</strong> dijadwalkan hadir pada <strong>Sprint {module.sprint.slice(1)} — {sprint.name}</strong>.
        </p>
        <p className="muted small">Target sprint tersebut: {sprint.outcome}.</p>
        <p className="muted small">Sementara itu, gunakan Central File versi 3 untuk pekerjaan ini.</p>
        <Link to="/dashboard" className="btn btn-secondary">
          Kembali ke Dashboard
        </Link>
      </section>
    </>
  );
}
