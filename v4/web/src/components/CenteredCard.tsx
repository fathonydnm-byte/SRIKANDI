import type { ReactNode } from 'react';
import { BrandMark } from './BrandMark';
import { OfflineBanner } from './OfflineBanner';

/** Tata letak layar tunggal (login, konfigurasi, akun belum aktif). */
export function CenteredCard({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="centered-page">
      <OfflineBanner />
      <main className="centered-main" id="main">
        <div className="centered-brand">
          <span className="brand-mark">
            <BrandMark />
          </span>
          <div>
            <strong>Central File</strong>
            <small>UIN Sunan Ampel Surabaya</small>
          </div>
        </div>
        <section className="card centered-card" aria-labelledby="page-title">
          <h1 id="page-title">{title}</h1>
          {subtitle ? <p className="muted">{subtitle}</p> : null}
          {children}
        </section>
      </main>
    </div>
  );
}
