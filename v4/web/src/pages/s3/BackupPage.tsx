import { useAuth } from '../../auth/AuthContext';
import { Alert } from '../../components/Alert';
import { PageHeader } from '../../components/PageHeader';
import {
  driveFolderLink, formatAge, getBackupStatus, sheetLink, summarize, WARNING_LABEL,
  type BackupHistoryRow, type BackupKindStatus, type BackupStatus, type BackupUnitStatus,
} from '../../lib/backupApi';
import { formatNumber } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import { formatTimestamp } from '../s2/common';
import './backupPage.css';

function StatusPill({ kind }: { kind: BackupKindStatus }) {
  if (kind.warning) {
    return <span className={`badge-pill ${kind.warning === 'FAILED' ? 'badge-danger' : 'badge-warn'}`}>{WARNING_LABEL[kind.warning]}</span>;
  }
  return <span className="badge-pill badge-ok">Sehat</span>;
}

function KindBlock({ title, kind, staleHours, link }: { title: string; kind: BackupKindStatus; staleHours: number; link: { href: string; label: string } | null }) {
  const failed = kind.last_done?.status === 'FAILED' ? kind.last_done : null;
  return (
    <section className="bk-kind" aria-label={title}>
      <div className="bk-kind-head">
        <h3>{title}</h3>
        <div className="badge-row">
          <StatusPill kind={kind} />
          {kind.running ? <span className="badge-pill badge-info">Sedang berjalan</span> : null}
        </div>
      </div>
      <dl className="bk-meta">
        <dt>Terakhir sukses</dt>
        <dd>{kind.last_success_at ? <>{formatTimestamp(kind.last_success_at)} <span className="muted">({formatAge(kind.age_hours)})</span></> : 'Belum pernah'}</dd>
        {kind.stats?.total_rows !== undefined ? (<><dt>Isi</dt><dd>{formatNumber(kind.stats.total_rows)} baris{kind.stats.drive_files !== undefined ? `, ${formatNumber(kind.stats.drive_files)} rujukan file Drive` : ''}</dd></>) : null}
      </dl>
      {kind.warning === 'STALE' ? <p className="bk-note">Belum ada yang berhasil dalam {staleHours} jam terakhir.</p> : null}
      {failed ? (
        <p className="bk-note bk-note-error">
          Percobaan terakhir gagal ({formatTimestamp(failed.finished_at ?? failed.started_at)}){failed.error ? <>: <span className="bk-error">{failed.error}</span></> : null}
        </p>
      ) : null}
      {link ? <a className="btn btn-secondary bk-link" href={link.href} target="_blank" rel="noopener noreferrer">{link.label}</a> : null}
    </section>
  );
}

function UnitCard({ unit, staleHours }: { unit: BackupUnitStatus; staleHours: number }) {
  return (
    <li className="bk-card">
      <div className="bk-card-head">
        <h2>{unit.unit_code}</h2>
        <span className="muted">{unit.unit_name}</span>
        {unit.active ? null : <span className="badge-pill badge-neutral">Nonaktif</span>}
      </div>
      {unit.mirror ? (
        <KindBlock title="Cermin spreadsheet" kind={unit.mirror} staleHours={staleHours}
          link={sheetLink(unit.mirror.url) ? { href: sheetLink(unit.mirror.url)!, label: 'Buka spreadsheet cermin' } : null} />
      ) : null}
      <KindBlock title="Cadangan harian" kind={unit.backup} staleHours={staleHours}
        link={driveFolderLink(unit.backup.backup_file_id) ? { href: driveFolderLink(unit.backup.backup_file_id)!, label: 'Buka folder paket di Drive' } : null} />
    </li>
  );
}

function History({ rows, units }: { rows: BackupHistoryRow[]; units: BackupUnitStatus[] }) {
  const code = (id: string | null) => (id === null ? '_PLATFORM' : units.find((u) => u.unit_id === id)?.unit_code ?? '–');
  if (!rows.length) return <p className="muted">Belum ada riwayat.</p>;
  return (
    <ul className="bk-history">
      {rows.map((r) => (
        <li key={r.id} className={r.status === 'FAILED' ? 'is-failed' : undefined}>
          <span className="bk-h-time">{formatTimestamp(r.started_at)}</span>
          <span className="bk-h-what">{r.kind === 'MIRROR' ? 'Cermin' : 'Cadangan'} · {code(r.unit_id)}</span>
          <span className={`badge-pill ${r.status === 'SUCCESS' ? 'badge-ok' : r.status === 'FAILED' ? 'badge-danger' : 'badge-info'}`}>
            {r.status === 'SUCCESS' ? 'Sukses' : r.status === 'FAILED' ? 'Gagal' : 'Berjalan'}
          </span>
          <span className="bk-h-rows muted">{r.total_rows !== null && r.total_rows !== undefined ? `${formatNumber(Number(r.total_rows))} baris` : ''}</span>
          {r.error ? <span className="bk-h-error">{r.error}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function Banner({ data }: { data: BackupStatus }) {
  const s = summarize(data.units);
  const list = (a: string[]) => a.join(', ');
  if (s.failed.length) {
    return <Alert tone="error"><strong>Cadangan atau cermin terakhir gagal untuk: {list(s.failed)}.</strong> Data di aplikasi aman, tetapi salinannya belum diperbarui. Periksa log di proyek Apps Script “Central File – Cermin & Backup”, lalu jalankan ulang (lihat PASANG.md).</Alert>;
  }
  if (s.stale.length || s.never.length) {
    return (
      <Alert tone="warning">
        <strong>Perlu perhatian.</strong>{' '}
        {s.stale.length ? `Tidak ada cadangan/cermin yang berhasil dalam ${data.stale_after_hours} jam terakhir untuk: ${list(s.stale)}. ` : ''}
        {s.never.length ? `Belum pernah berjalan untuk: ${list(s.never)}. ` : ''}
        Pastikan pekerjaan malam di Apps Script masih terpasang.
      </Alert>
    );
  }
  return <Alert tone="success">Semua cadangan dan cermin terbaru (kurang dari {data.stale_after_hours} jam).</Alert>;
}

/** Cadangan & Cermin: hanya-baca. Admin Pusat melihat semua unit; Admin Unit hanya unitnya (diputuskan server). */
export function BackupPage() {
  const { client } = useAuth();
  const [load, retry] = useLoad('cadangan', () => getBackupStatus(client));
  return (
    <>
      <PageHeader title="Cadangan & Cermin" subtitle="Salinan harian data: cermin spreadsheet hanya-baca di Google Sheets dan paket cadangan di Drive. Halaman ini hanya menampilkan status.">
        <button type="button" className="btn btn-secondary" onClick={retry}>Muat ulang</button>
      </PageHeader>
      {load.kind === 'loading' ? <p className="muted" role="status">Memuat status…</p> : null}
      {load.kind === 'error' ? <div className="stack"><Alert tone="error" message={load.message} /><button type="button" className="btn btn-secondary" onClick={retry}>Coba lagi</button></div> : null}
      {load.kind === 'ok' ? (
        <div className="stack">
          <Banner data={load.data} />
          {load.data.units.length === 0 ? <p className="muted">Belum ada unit.</p> : null}
          <ul className="bk-grid">
            {load.data.units.map((u) => <UnitCard key={u.unit_id ?? 'platform'} unit={u} staleHours={load.data.stale_after_hours} />)}
          </ul>
          <section aria-label="Riwayat">
            <h2 className="bk-h2">Riwayat terbaru</h2>
            <History rows={load.data.history} units={load.data.units} />
          </section>
          <p className="muted small">Cermin dan paket cadangan tidak dienkripsi di Drive instansi (kolom data pribadi di dalamnya tetap terenkripsi). Perubahan di spreadsheet cermin tidak masuk ke aplikasi dan akan ditimpa malam berikutnya.</p>
        </div>
      ) : null}
    </>
  );
}
