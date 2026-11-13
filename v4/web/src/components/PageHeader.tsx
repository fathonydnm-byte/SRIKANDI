import type { ReactNode } from 'react';

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <div className="page-header">
      <div>
        <h1 tabIndex={-1} id="page-title">{title}</h1>
        {subtitle ? <p className="muted">{subtitle}</p> : null}
      </div>
      {children}
    </div>
  );
}
