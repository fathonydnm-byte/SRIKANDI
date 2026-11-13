import type { RetentionStatusCode } from '../../lib/api';

const TONE: Record<RetentionStatusCode, string> = {
  ACTIVE: 'badge-ok',
  DUE: 'badge-warn',
  EXPIRED: 'badge-danger',
  PROPOSED: 'badge-info',
  PENDING: 'badge-neutral',
};

/** Lencana status retensi seperti kolom STATUS_RETENSI di 3.x. */
export function RetentionBadge({ code, label }: { code: RetentionStatusCode; label: string }) {
  return <span className={`badge-pill ${TONE[code] ?? 'badge-neutral'}`}>{label}</span>;
}
