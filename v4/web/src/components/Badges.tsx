import { isRestricted, titleCase } from '../lib/format';

export function SecurityBadge({ level }: { level: string | null }) {
  if (!isRestricted(level)) return null;
  return <span className="badge-pill badge-danger">{titleCase(level)}</span>;
}

export function FileBadge({ hasFile }: { hasFile: boolean }) {
  return hasFile ? <span className="badge-pill badge-ok">PDF tersedia</span> : <span className="badge-pill badge-warn">Belum ada PDF</span>;
}

export function LoanBadge({ status }: { status: string | null }) {
  if (!status || status.toUpperCase() === 'TERSEDIA') return null;
  return <span className="badge-pill badge-info">{titleCase(status)}</span>;
}

export function CancelledBadge({ cancelled }: { cancelled: boolean }) {
  return cancelled ? <span className="badge-pill badge-danger">Dibatalkan</span> : null;
}
