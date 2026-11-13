import { Link, useLocation, useParams } from 'react-router-dom';
import { useAuth, useProfile } from '../../auth/AuthContext';
import { CancelledBadge, FileBadge, LoanBadge, SecurityBadge } from '../../components/Badges';
import { FileActions } from '../../components/FileActions';
import { LocationActions } from '../../components/LocationActions';
import { LocationBlock } from '../../components/LocationBlock';
import { PageHeader } from '../../components/PageHeader';
import { getBerkasDetail } from '../../lib/api';
import { formatDate, formatDateRange, formatNumber, titleCase } from '../../lib/format';
import { berkasLocationText } from '../../lib/locationText';
import { useLoad } from '../../lib/useLoad';
import { BackToResults, DetailError, DetailLoading, Facts, NotVisible } from './DetailParts';

/** Daftar Isi Berkas. */
export function BerkasDetailPage() {
  const { berkasId = '' } = useParams();
  const location = useLocation();
  const { client } = useAuth();
  const { unit } = useProfile();
  const [load, retry] = useLoad(`berkas:${berkasId}`, () => getBerkasDetail(client, berkasId));

  if (load.kind !== 'ok' || !load.data) {
    return (
      <>
        <BackToResults />
        <PageHeader title="Daftar Isi Berkas" />
        {load.kind === 'loading' ? (
          <DetailLoading label="Memuat daftar isi berkas…" />
        ) : load.kind === 'error' ? (
          <DetailError message={load.message} onRetry={retry} />
        ) : (
          <NotVisible what="Berkas" />
        )}
      </>
    );
  }
  const d = load.data;

  return (
    <>
      <BackToResults />
      <PageHeader title={`Berkas ${d.no_berkas ?? '–'}`} subtitle={d.judul_berkas} />
      <div className="badge-row">
        <CancelledBadge cancelled={d.dibatalkan} />
        <SecurityBadge level={d.klasifikasi_keamanan} />
        <LoanBadge status={d.status_peminjaman} />
      </div>

      <section className="card location-card" aria-labelledby="loc-title">
        <h2 id="loc-title" className="section-title">Lokasi fisik</h2>
        <LocationBlock kabinet={d.kabinet} laci={d.laci} folder={d.folder} lokasi={d.lokasi} size="lg" />
        <LocationActions text={berkasLocationText(d, unit?.name)} shareTitle={`Lokasi berkas ${d.no_berkas ?? d.berkas_id}`} />
      </section>

      <section className="card" aria-labelledby="sum-title">
        <h2 id="sum-title" className="section-title">Ringkasan</h2>
        <div className="mini-stats">
          <div>
            <span>Item</span>
            <strong>{formatNumber(d.jumlah_item)}</strong>
          </div>
          <div>
            <span>Total lembar</span>
            <strong>{formatNumber(d.total_lembar)}</strong>
          </div>
          <div className="wide">
            <span>Rentang tanggal</span>
            <strong>{formatDateRange(d.tanggal_awal, d.tanggal_akhir)}</strong>
          </div>
        </div>
        <Facts
          rows={[
            ['Klasifikasi', [d.kode_klasifikasi, d.uraian_klasifikasi].filter(Boolean).join(' — ')],
            ['Kurun waktu', d.kurun_waktu],
            ['Keamanan akses', titleCase(d.klasifikasi_keamanan)],
            ['Status berkas', titleCase(d.status_berkas)],
            ['Status retensi', d.status_retensi],
            ['Nasib akhir', titleCase(d.nasib_akhir)],
          ]}
        />
        <FileActions folderUrl={d.drive_folder_url} />
      </section>

      <section className="card" aria-labelledby="isi-title">
        <h2 id="isi-title" className="section-title">Daftar isi ({formatNumber(d.items.length)} item)</h2>
        {d.items.length === 0 ? (
          <p className="muted">Berkas ini belum berisi item.</p>
        ) : (
          <ol className="isi-list">
            {d.items.map((it) => (
              <li key={it.item_id}>
                <Link to={`/cari/item/${encodeURIComponent(it.item_id)}`} state={location.state as unknown} className="isi-row">
                  <span className="isi-no" aria-label={`Item ${it.no_item ?? '–'}`}>{it.no_item ?? '–'}</span>
                  <span className="isi-main">
                    <span>
                      <strong>{it.no_surat || 'Tanpa nomor surat'}</strong>
                      <span className="muted"> · {formatDate(it.tanggal_naskah)}</span>
                    </span>
                    {it.uraian ? <span className="isi-desc">{it.uraian}</span> : null}
                    <span className="isi-meta">
                      {it.jumlah_halaman ?? 0} lembar
                      <FileBadge hasFile={it.has_file} />
                      <SecurityBadge level={it.klasifikasi_keamanan} />
                      <CancelledBadge cancelled={it.dibatalkan} />
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}
