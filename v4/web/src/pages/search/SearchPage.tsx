import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useAuth, useProfile } from '../../auth/AuthContext';
import { can } from '../../auth/permissions';
import { Alert } from '../../components/Alert';
import { PageHeader } from '../../components/PageHeader';
import { Sheet } from '../../components/Sheet';
import { ApiError, isAbortError, searchArchive, type SearchResponse } from '../../lib/api';
import { toUserMessage, type UserMessage } from '../../lib/errors';
import { formatNumber } from '../../lib/format';
import { SearchResultCard } from './SearchResultCard';
import { activeFilterCount, hasAnyCriteria, PAGE_SIZE, readCriteria, writeCriteria, type SearchCriteria } from './searchParams';

export const SEARCH_DEBOUNCE_MS = 350;

type Outcome = { key: string; kind: 'ok'; data: SearchResponse } | { key: string; kind: 'error'; message: UserMessage };

function FilterSheet({ initial, allowDeleted, onApply, onClose }: { initial: SearchCriteria; allowDeleted: boolean; onApply(c: SearchCriteria): void; onClose(): void }) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const ids = { kls: useId(), dev: useId(), file: useId(), dari: useId(), sampai: useId(), batal: useId() };
  const set = <K extends keyof SearchCriteria>(k: K, v: SearchCriteria[K]) => setDraft((d) => ({ ...d, [k]: v }));

  function apply(e: FormEvent) {
    e.preventDefault();
    if (draft.dari && draft.sampai && draft.dari > draft.sampai) {
      setError('Tanggal awal tidak boleh lebih besar daripada tanggal akhir.');
      return;
    }
    onApply({ ...draft, hal: 1 });
  }

  return (
    <Sheet title="Filter pencarian" onClose={onClose} variant="dialog">
      <form className="stack filter-form" onSubmit={apply} noValidate>
        <div className="field">
          <label htmlFor={ids.kls}>Kode klasifikasi</label>
          <div className="field-control">
            <input id={ids.kls} value={draft.kls} onChange={(e) => set('kls', e.target.value)} placeholder="mis. PR.01" autoCapitalize="characters" />
          </div>
        </div>
        <div className="filter-row">
          <div className="field">
            <label htmlFor={ids.dev}>Tingkat perkembangan</label>
            <select id={ids.dev} value={draft.dev} onChange={(e) => set('dev', e.target.value as SearchCriteria['dev'])}>
              <option value="ALL">Semua</option>
              <option value="ASLI">Asli</option>
              <option value="COPY">Copy</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor={ids.file}>Status alih media</label>
            <select id={ids.file} value={draft.file} onChange={(e) => set('file', e.target.value as SearchCriteria['file'])}>
              <option value="ALL">Semua</option>
              <option value="TERSEDIA">PDF tersedia</option>
              <option value="BELUM_DIUNGGAH">Belum diunggah</option>
            </select>
          </div>
        </div>
        <fieldset className="filter-dates">
          <legend>Tanggal naskah</legend>
          <div className="filter-row">
            <div className="field">
              <label htmlFor={ids.dari}>Dari</label>
              <div className="field-control">
                <input id={ids.dari} type="date" value={draft.dari} onChange={(e) => set('dari', e.target.value)} aria-invalid={error ? true : undefined} />
              </div>
            </div>
            <div className="field">
              <label htmlFor={ids.sampai}>Sampai</label>
              <div className="field-control">
                <input id={ids.sampai} type="date" value={draft.sampai} onChange={(e) => set('sampai', e.target.value)} aria-invalid={error ? true : undefined} />
              </div>
            </div>
          </div>
          {error ? <small className="field-error" role="alert">{error}</small> : null}
        </fieldset>
        {allowDeleted ? (
          <label className="check" htmlFor={ids.batal}>
            <input id={ids.batal} type="checkbox" checked={draft.batal} onChange={(e) => set('batal', e.target.checked)} />
            <span>Sertakan arsip yang dibatalkan/dihapus</span>
          </label>
        ) : null}
        <div className="filter-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setDraft((d) => ({ ...d, kls: '', dev: 'ALL', file: 'ALL', dari: '', sampai: '', batal: false }))}
          >
            Bersihkan filter
          </button>
          <button type="submit" className="btn btn-primary">
            Terapkan
          </button>
        </div>
      </form>
    </Sheet>
  );
}

function ResultSkeleton() {
  return (
    <ul className="result-list" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <li key={i} className="result-card skeleton">
          <span className="sk sk-line short" />
          <span className="sk sk-line" />
          <span className="sk sk-block" />
        </li>
      ))}
    </ul>
  );
}

export function SearchPage() {
  const { client, activeUnitId } = useAuth();
  const { profile } = useProfile();
  const [sp, setSp] = useSearchParams();
  const location = useLocation();
  const criteria = readCriteria(sp);
  const searchable = hasAnyCriteria(criteria);
  const unitId = can(profile.role, 'unit.pilih') ? activeUnitId : null;

  // Teks di kotak cari; disinkronkan bila URL berubah dari luar (Kembali/Maju).
  const [text, setText] = useState(criteria.q);
  const [urlQ, setUrlQ] = useState(criteria.q);
  if (criteria.q !== urlQ) {
    setUrlQ(criteria.q);
    if (criteria.q !== text.trim()) setText(criteria.q);
  }

  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterButton = useRef<HTMLButtonElement>(null);
  const [retry, setRetry] = useState(0);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  // Debounce: kotak cari -> URL (replace, supaya riwayat tidak penuh ketikan).
  useEffect(() => {
    if (text.trim() === criteria.q.trim()) return;
    const t = window.setTimeout(() => {
      setSp(writeCriteria({ ...criteria, q: text, hal: 1 }), { replace: true });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
    // criteria berasal dari sp; cukup bergantung pada sp.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, sp, setSp]);

  const key = JSON.stringify({ c: writeCriteria(criteria).toString(), unitId, retry });

  // Satu permintaan per kunci; permintaan lama dibatalkan dan hasilnya diabaikan.
  useEffect(() => {
    const { c, unitId: u } = JSON.parse(key) as { c: string; unitId: string | null };
    const cr = readCriteria(new URLSearchParams(c));
    if (!hasAnyCriteria(cr)) return;
    const ctrl = new AbortController();
    searchArchive(
      client,
      {
        query: cr.q,
        classification: cr.kls,
        development: cr.dev,
        fileStatus: cr.file,
        dateFrom: cr.dari,
        dateTo: cr.sampai,
        includeDeleted: cr.batal,
        unitId: u,
        page: cr.hal,
        pageSize: PAGE_SIZE,
      },
      ctrl.signal,
    )
      .then((data) => {
        if (!ctrl.signal.aborted) setOutcome({ key, kind: 'ok', data });
      })
      .catch((error: unknown) => {
        if (ctrl.signal.aborted || isAbortError(error)) return;
        setOutcome({ key, kind: 'error', message: error instanceof ApiError ? error.userMessage : toUserMessage(error) });
      });
    return () => ctrl.abort();
  }, [client, key]);

  const current = outcome && outcome.key === key ? outcome : null;
  const filterCount = activeFilterCount(criteria);

  function submit(e: FormEvent) {
    e.preventDefault();
    // Enter: langsung cari dan buat entri riwayat baru.
    setSp(writeCriteria({ ...criteria, q: text, hal: 1 }));
  }

  function pageHref(hal: number): string {
    const s = writeCriteria({ ...criteria, hal }).toString();
    return s ? `?${s}` : '?';
  }

  let body;
  let status = '';
  if (!searchable) {
    body = (
      <div className="empty-state card">
        <span className="placeholder-icon" aria-hidden="true">🔍</span>
        <h2 className="section-title">Cari lokasi arsip</h2>
        <p className="muted">Ketik nomor surat, uraian, judul berkas, kode klasifikasi, atau lokasi (mis. “kabinet 2 laci 3”). Semua kata harus cocok.</p>
      </div>
    );
  } else if (!current) {
    status = 'Mencari…';
    body = <ResultSkeleton />;
  } else if (current.kind === 'error') {
    status = 'Pencarian gagal.';
    body = (
      <div className="stack">
        <Alert tone="error" message={current.message} />
        <button type="button" className="btn btn-secondary" onClick={() => setRetry((n) => n + 1)}>
          Coba lagi
        </button>
      </div>
    );
  } else if (current.data.results.length === 0) {
    const beyond = current.data.total > 0;
    status = beyond ? 'Halaman ini kosong.' : 'Tidak ada arsip yang cocok.';
    body = (
      <div className="empty-state card">
        <h2 className="section-title">{beyond ? 'Halaman ini kosong' : 'Tidak ada arsip yang cocok'}</h2>
        <p className="muted">
          {beyond
            ? 'Hasil pencarian lebih sedikit dari nomor halaman ini.'
            : 'Coba kata kunci yang lebih singkat, periksa ejaan nomor surat, atau bersihkan sebagian filter.'}
        </p>
        {beyond ? (
          <Link className="btn btn-secondary" to={pageHref(1)}>
            Ke halaman pertama
          </Link>
        ) : null}
      </div>
    );
  } else {
    const { total, offset, results } = current.data;
    const from = offset + 1;
    const to = offset + results.length;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    status = `${formatNumber(total)} arsip ditemukan.`;
    body = (
      <>
        <p className="result-summary">
          {total > results.length ? `Menampilkan ${formatNumber(from)}–${formatNumber(to)} dari ${formatNumber(total)} arsip` : `${formatNumber(total)} arsip ditemukan`}
        </p>
        <ul className="result-list">
          {results.map((hit) => (
            <li key={hit.item_id}>
              <SearchResultCard hit={hit} from={location.search} />
            </li>
          ))}
        </ul>
        {pages > 1 ? (
          <nav className="pager" aria-label="Halaman hasil">
            {criteria.hal > 1 ? (
              <Link className="btn btn-secondary" to={pageHref(criteria.hal - 1)} rel="prev">
                ‹ Sebelumnya
              </Link>
            ) : (
              <span />
            )}
            <span className="pager-info">
              Halaman {criteria.hal} dari {pages}
            </span>
            {criteria.hal < pages ? (
              <Link className="btn btn-secondary" to={pageHref(criteria.hal + 1)} rel="next">
                Berikutnya ›
              </Link>
            ) : (
              <span />
            )}
          </nav>
        ) : null}
      </>
    );
  }

  return (
    <>
      <PageHeader title="Cari Arsip" subtitle="Temukan arsip dan lokasi fisiknya." />
      <form className="search-bar" role="search" onSubmit={submit}>
        <label htmlFor="search-q" className="sr-only">
          Kata kunci pencarian
        </label>
        <input
          id="search-q"
          type="search"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          placeholder="Nomor surat, uraian, judul, lokasi…"
          value={text}
          maxLength={250}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          type="button"
          ref={filterButton}
          className={`btn btn-secondary filter-button${filterCount ? ' has-filters' : ''}`}
          aria-haspopup="dialog"
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen(true)}
        >
          Filter{filterCount ? <span className="badge" aria-label={`${filterCount} filter aktif`}>{filterCount}</span> : null}
        </button>
      </form>
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
      <div className="search-results" aria-busy={searchable && !current ? true : undefined}>
        {body}
      </div>
      {filtersOpen ? (
        <FilterSheet
          initial={{ ...criteria, q: text }}
          allowDeleted={can(profile.role, 'arsip.kelola')}
          onApply={(c) => {
            setFiltersOpen(false);
            setSp(writeCriteria(c));
            filterButton.current?.focus();
          }}
          onClose={() => {
            setFiltersOpen(false);
            filterButton.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}
