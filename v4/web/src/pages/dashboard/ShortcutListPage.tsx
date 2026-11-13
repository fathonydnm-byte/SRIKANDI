import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth, useProfile } from '../../auth/AuthContext';
import { can } from '../../auth/permissions';
import { Alert } from '../../components/Alert';
import { LocationBlock } from '../../components/LocationBlock';
import { PageHeader } from '../../components/PageHeader';
import { getDashboardShortcut, type ShortcutRow } from '../../lib/api';
import { formatDate, formatNumber } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import { RetentionBadge } from './RetentionBadge';
import { shortcutBySlug, type ShortcutDef } from './shortcuts';

function dayText(row: ShortcutRow): string | null {
  const d = row.days_to_active_limit;
  if (d === null) return null;
  if (d < 0) return `lewat ${formatNumber(-d)} hari`;
  if (d === 0) return 'berakhir hari ini';
  return `${formatNumber(d)} hari lagi`;
}

function Row({ row, def }: { row: ShortcutRow; def: ShortcutDef }) {
  const days = dayText(row);
  return (
    <li className="result-card shortcut-row">
      <div className="result-top">
        <Link to={`/cari/berkas/${encodeURIComponent(row.berkas_id)}`} className="arc-title">
          {row.no_berkas ?? '–'} — {row.judul_berkas}
        </Link>
        <RetentionBadge code={row.status_code} label={row.status_label} />
      </div>
      <LocationBlock kabinet={row.kabinet} laci={row.laci} folder={row.folder} lokasi={row.lokasi} />
      <p className="muted small shortcut-facts">
        {row.kode_klasifikasi || '–'} · {row.kurun_waktu || '–'} · {formatNumber(row.item_count)} item · {formatNumber(row.total_lembar)} lembar
      </p>
      {def.kind === 'DIPINJAM' ? (
        <p className="shortcut-key">
          {row.status_peminjaman !== 'TERSEDIA' ? 'Berkas dipinjam' : null}
          {row.status_peminjaman !== 'TERSEDIA' && row.item_dipinjam ? ' · ' : null}
          {row.item_dipinjam ? `${formatNumber(row.item_dipinjam)} item dipinjam` : null}
        </p>
      ) : (
        <p className="shortcut-key">
          Batas aktif <strong>{formatDate(row.batas_aktif, '–')}</strong>
          {days ? ` (${days})` : null}
          {row.usul_pindah_no ? ` · dalam usul ${row.usul_pindah_no}` : null}
        </p>
      )}
    </li>
  );
}

/** Daftar di balik kartu pintas (angka nol tetap membuka daftar kosong, seperti 3.x). */
export function ShortcutListPage() {
  const { slug } = useParams();
  const [sp] = useSearchParams();
  const def = shortcutBySlug(slug);
  const { client, activeUnitId } = useAuth();
  const { profile } = useProfile();
  const unitId = can(profile.role, 'unit.pilih') ? (sp.get('unit') ?? activeUnitId) : null;
  const [load, retry] = useLoad(`shortcut:${def?.kind ?? 'x'}:${unitId ?? 'all'}`, () =>
    def ? getDashboardShortcut(client, def.kind, unitId) : Promise.resolve([]),
  );
  if (!def) return <Navigate to="/dashboard" replace />;

  return (
    <>
      <Link className="back-link" to="/dashboard">
        ‹ Dashboard
      </Link>
      <PageHeader title={def.title} subtitle={def.description} />
      {def.kind === 'DIPINJAM' ? (
        <Alert tone="info">
          <span>
            Dihitung per berkas dari status pinjam berkas dan item. Rincian peminjam, tanggal kembali, dan Out Indicator tersedia setelah modul
            Peminjaman Arsip hadir (Sprint 4).
          </span>
        </Alert>
      ) : null}
      {load.kind === 'loading' ? (
        <p className="muted detail-loading" role="status">
          Memuat daftar…
        </p>
      ) : load.kind === 'error' ? (
        <div className="stack">
          <Alert tone="error" message={load.message} />
          <button type="button" className="btn btn-secondary" onClick={retry}>
            Coba lagi
          </button>
        </div>
      ) : load.data.length === 0 ? (
        <div className="empty-state card">
          <h2 className="section-title">Daftar kosong</h2>
          <p className="muted">{def.empty}</p>
        </div>
      ) : (
        <>
          <p className="result-summary" role="status">
            {formatNumber(load.data.length)} berkas
          </p>
          <ul className="result-list">
            {load.data.map((row) => (
              <Row key={row.berkas_id} row={row} def={def} />
            ))}
          </ul>
        </>
      )}
    </>
  );
}
