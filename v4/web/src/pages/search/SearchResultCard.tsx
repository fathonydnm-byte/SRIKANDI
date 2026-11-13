import { Link } from 'react-router-dom';
import type { SearchHit } from '../../lib/api';
import { formatDate } from '../../lib/format';
import { LocationBlock } from '../../components/LocationBlock';
import { CancelledBadge, FileBadge, LoanBadge, SecurityBadge } from '../../components/Badges';

export interface FromSearchState {
  fromSearch?: string;
}

export function SearchResultCard({ hit, from }: { hit: SearchHit; from: string }) {
  const state: FromSearchState = { fromSearch: from };
  return (
    <Link to={`/cari/item/${encodeURIComponent(hit.item_id)}`} state={state} className={`result-card${hit.dibatalkan ? ' is-cancelled' : ''}`}>
      <div className="result-top">
        <span className="result-number">
          Berkas {hit.no_berkas ?? '–'} / Item {hit.no_item ?? '–'}
        </span>
        <span className="result-badges">
          <CancelledBadge cancelled={hit.dibatalkan} />
          <SecurityBadge level={hit.klasifikasi_keamanan} />
          <LoanBadge status={hit.status_peminjaman} />
          <FileBadge hasFile={hit.has_file} />
        </span>
      </div>
      <LocationBlock kabinet={hit.kabinet} laci={hit.laci} folder={hit.folder} lokasi={hit.lokasi} />
      <p className="result-letter">
        <strong>{hit.no_surat || 'Tanpa nomor surat'}</strong>
        <span className="muted"> · {formatDate(hit.tanggal_naskah)}</span>
      </p>
      {hit.uraian ? <p className="result-desc">{hit.uraian}</p> : null}
      <p className="result-berkas muted">
        {hit.kode_klasifikasi ? <span className="code">{hit.kode_klasifikasi}</span> : null} {hit.judul_berkas}
      </p>
    </Link>
  );
}
