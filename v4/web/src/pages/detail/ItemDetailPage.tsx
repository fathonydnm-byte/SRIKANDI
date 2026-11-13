import { Link, useLocation, useParams } from 'react-router-dom';
import { useAuth, useProfile } from '../../auth/AuthContext';
import { can } from '../../auth/permissions';
import { CancelledBadge, FileBadge, LoanBadge, SecurityBadge } from '../../components/Badges';
import { FileActions } from '../../components/FileActions';
import { LocationActions } from '../../components/LocationActions';
import { LocationBlock } from '../../components/LocationBlock';
import { PageHeader } from '../../components/PageHeader';
import { getItemDetail } from '../../lib/api';
import { developmentLabel, formatDate, formatNumber, titleCase } from '../../lib/format';
import { itemLocationText } from '../../lib/locationText';
import { useLoad } from '../../lib/useLoad';
import { BackToResults, DetailError, DetailLoading, Facts, NotVisible } from './DetailParts';

export function ItemDetailPage() {
  const { itemId = '' } = useParams();
  const location = useLocation();
  const { client } = useAuth();
  const { unit, profile } = useProfile();
  const [load, retry] = useLoad(`item:${itemId}`, () => getItemDetail(client, itemId));

  if (load.kind === 'loading') {
    return (
      <>
        <BackToResults />
        <PageHeader title="Detail arsip" />
        <DetailLoading label="Memuat detail arsip…" />
      </>
    );
  }
  if (load.kind === 'error') {
    return (
      <>
        <BackToResults />
        <PageHeader title="Detail arsip" />
        <DetailError message={load.message} onRetry={retry} />
      </>
    );
  }
  const d = load.data;
  if (!d) {
    return (
      <>
        <BackToResults />
        <PageHeader title="Detail arsip" />
        <NotVisible what="Arsip" />
      </>
    );
  }

  return (
    <>
      <BackToResults />
      <PageHeader title={d.no_surat || 'Tanpa nomor surat'} subtitle={`Berkas ${d.no_berkas ?? '–'} / Item ${d.no_item ?? '–'} · ${formatDate(d.tanggal_naskah)}`} />
      <div className="badge-row">
        <CancelledBadge cancelled={d.dibatalkan} />
        <SecurityBadge level={d.klasifikasi_keamanan} />
        <LoanBadge status={d.status_peminjaman} />
        <FileBadge hasFile={d.has_file} />
      </div>

      <section className="card location-card" aria-labelledby="loc-title">
        <h2 id="loc-title" className="section-title">Lokasi fisik</h2>
        <LocationBlock kabinet={d.kabinet} laci={d.laci} folder={d.folder} lokasi={d.lokasi} size="lg" />
        <Link className="berkas-link" to={`/cari/berkas/${encodeURIComponent(d.berkas_id)}`} state={location.state as unknown}>
          <span className="muted small">Di dalam berkas</span>
          <span>
            {d.no_berkas ?? '–'} — {d.judul_berkas} ›
          </span>
        </Link>
        <LocationActions text={itemLocationText(d, unit?.name)} shareTitle={`Lokasi arsip ${d.no_surat || d.item_id}`} />
      </section>

      <section className="card" aria-labelledby="file-title">
        <h2 id="file-title" className="section-title">Softcopy</h2>
        <FileActions
          file={{ driveFileId: d.drive_file_id, driveFileUrl: d.drive_file_url, fileName: d.nama_file, mime: d.mime_type ?? null, sizeBytes: d.drive_file_size_bytes ?? null }}
          folderUrl={d.drive_folder_url}
          shareTitle={`${d.no_surat || 'Arsip'} — ${d.uraian ?? ''}`.trim()}
        />
        {!d.has_file && !d.dibatalkan && can(profile.role, 'arsip.kelola') ? (
          <Link className="btn btn-secondary" to={`/alih-media?item=${encodeURIComponent(d.item_id)}`}>Unggah PDF (Alih Media)</Link>
        ) : null}
      </section>

      <section className="card" aria-labelledby="meta-title">
        <h2 id="meta-title" className="section-title">Keterangan</h2>
        <Facts
          rows={[
            ['Uraian', d.uraian],
            ['Nomor surat', d.no_surat],
            ['Tanggal naskah', formatDate(d.tanggal_naskah)],
            ['Jumlah lembar', d.jumlah_halaman !== null ? formatNumber(d.jumlah_halaman) : null],
            ['Tingkat perkembangan', developmentLabel(d.tingkat_perkembangan)],
            ['Kondisi fisik', titleCase(d.kondisi_fisik)],
            ['Klasifikasi', [d.kode_klasifikasi, d.uraian_klasifikasi].filter(Boolean).join(' — ')],
            ['Keamanan akses', titleCase(d.klasifikasi_keamanan)],
            ['Media', [titleCase(d.media_sumber), titleCase(d.status_bentuk_digital)].filter(Boolean).join(' · ')],
            ['Status peminjaman', titleCase(d.status_peminjaman)],
            ['Tanda terima', d.nomor_tanda_terima],
            ['Catatan', d.catatan],
          ]}
        />
      </section>
    </>
  );
}
