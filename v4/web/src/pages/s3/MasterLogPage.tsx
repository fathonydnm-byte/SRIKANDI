import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth, useProfile } from '../../auth/AuthContext';
import { can } from '../../auth/permissions';
import { Alert } from '../../components/Alert';
import { PageHeader } from '../../components/PageHeader';
import { Sheet } from '../../components/Sheet';
import { ApiError, isAbortError } from '../../lib/api';
import { toUserMessage, type UserMessage } from '../../lib/errors';
import { formatNumber } from '../../lib/format';
import { fetchMasterLog, fetchMasterLogFilterValues, formatLogTime, resultLabel, resultTone, type MasterLogFilterValues, type MasterLogPage, type MasterLogRow } from '../../lib/masterLog';
import { useLoad } from '../../lib/useLoad';
import { LogDetailSheet } from './LogDetailSheet';
import { activeLogFilterCount, LOG_PAGE_SIZE, readLogCriteria, toRpcFilters, writeLogCriteria, type LogCriteria } from './masterLogParams';
import './masterLog.css';

export const LOG_SEARCH_DEBOUNCE_MS = 350;

type Outcome = { key: string; kind: 'ok'; data: MasterLogPage } | { key: string; kind: 'error'; message: UserMessage; code: string };

function optionsWith(values: string[], current: string): string[] {
  return current && !values.includes(current) ? [current, ...values] : values;
}

function FilterSheet({ initial, values, onApply, onClose }: { initial: LogCriteria; values: MasterLogFilterValues | null; onApply(c: LogCriteria): void; onClose(): void }) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const ids = { dari: useId(), sampai: useId(), aksi: useId(), jenis: useId(), modul: useId(), hasil: useId(), obj: useId(), pelaku: useId() };
  const set = <K extends keyof LogCriteria>(k: K, v: LogCriteria[K]) => setDraft((d) => ({ ...d, [k]: v }));

  function apply(e: FormEvent) {
    e.preventDefault();
    if (draft.dari && draft.sampai && draft.dari > draft.sampai) {
      setError('Tanggal awal tidak boleh lebih besar daripada tanggal akhir.');
      return;
    }
    onApply({ ...draft, hal: 1 });
  }

  const select = (id: string, label: string, key: 'aksi' | 'jenis' | 'modul', list: string[]) => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={draft[key]} onChange={(e) => set(key, e.target.value)}>
        <option value="">Semua</option>
        {optionsWith(list, draft[key]).map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <Sheet title="Filter log" onClose={onClose} variant="dialog">
      <form className="stack filter-form" onSubmit={apply} noValidate>
        <fieldset className="filter-dates">
          <legend>Tanggal (WIB)</legend>
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
        <div className="filter-row">
          {select(ids.aksi, 'Aksi', 'aksi', values?.actions ?? [])}
          {select(ids.jenis, 'Jenis objek', 'jenis', values?.object_types ?? [])}
        </div>
        <div className="filter-row">
          {select(ids.modul, 'Modul', 'modul', values?.modules ?? [])}
          <div className="field">
            <label htmlFor={ids.hasil}>Hasil</label>
            <select id={ids.hasil} value={draft.hasil} onChange={(e) => set('hasil', e.target.value as LogCriteria['hasil'])}>
              <option value="">Semua</option>
              <option value="SUCCESS">Berhasil</option>
              <option value="FAILED">Gagal</option>
              <option value="WARNING">Peringatan</option>
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor={ids.obj}>ID objek (persis)</label>
          <div className="field-control">
            <input id={ids.obj} value={draft.obj} onChange={(e) => set('obj', e.target.value)} placeholder="mis. BRK-0012" autoCapitalize="characters" autoComplete="off" />
          </div>
        </div>
        <div className="field">
          <label htmlFor={ids.pelaku}>Pelaku (nama atau email)</label>
          <div className="field-control">
            <input id={ids.pelaku} value={draft.pelaku} onChange={(e) => set('pelaku', e.target.value)} autoComplete="off" />
          </div>
        </div>
        <div className="filter-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setDraft((d) => ({ ...d, dari: '', sampai: '', aksi: '', jenis: '', modul: '', hasil: '', obj: '', pelaku: '' }))}
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

function LogSkeleton() {
  return (
    <ul className="result-list" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="result-card skeleton">
          <span className="sk sk-line short" />
          <span className="sk sk-line" />
        </li>
      ))}
    </ul>
  );
}

function ResultBadge({ result }: { result: string }) {
  if (result === 'SUCCESS') return null;
  return <span className={`badge-pill badge-${resultTone(result)}`}>{resultLabel(result)}</span>;
}

function LogTable({ rows, showUnit, onOpen }: { rows: MasterLogRow[]; showUnit: boolean; onOpen(row: MasterLogRow, trigger: HTMLElement): void }) {
  return (
    <table className="ml-table">
      <thead>
        <tr>
          <th scope="col">Waktu</th>
          <th scope="col">Pelaku</th>
          {showUnit ? <th scope="col">Unit</th> : null}
          <th scope="col">Aksi</th>
          <th scope="col">Objek</th>
          <th scope="col">Keterangan</th>
          <th scope="col">
            <span className="sr-only">Rincian</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const actor = row.actor_name || row.actor_email || 'Sistem';
          return (
            <tr key={row.id} className={row.result !== 'SUCCESS' ? 'ml-row-issue' : undefined}>
              <td data-label="Waktu" className="ml-time">
                <span>{formatLogTime(row.occurred_at)}</span>
              </td>
              <td data-label="Pelaku">
                <span className="ml-actor">{actor}</span>
                {row.actor_name && row.actor_email ? <span className="ml-sub">{row.actor_email}</span> : null}
              </td>
              {showUnit ? (
                <td data-label="Unit">
                  <span>{row.unit_code ?? 'Lintas unit'}</span>
                </td>
              ) : null}
              <td data-label="Aksi">
                <span className="ml-action">
                  <span className="code">{row.action}</span>
                  <ResultBadge result={row.result} />
                </span>
                {row.module ? <span className="ml-sub">{row.module}</span> : null}
              </td>
              <td data-label="Objek">
                <span>{row.object_type ?? '–'}</span>
                {row.object_id ? <span className="ml-sub ml-oid">{row.object_id}</span> : null}
              </td>
              <td data-label="Keterangan">
                <span className="ml-summary">{row.summary || '–'}</span>
                {row.reason ? <span className="ml-sub">Alasan: {row.reason}</span> : null}
              </td>
              <td className="ml-open">
                <button type="button" className="btn btn-secondary btn-sm" onClick={(e) => onOpen(row, e.currentTarget)} aria-label={`Rincian ${row.action} ${formatLogTime(row.occurred_at)}`}>
                  Rincian
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function MasterLogPage() {
  const { client, activeUnitId } = useAuth();
  const { profile } = useProfile();
  const [sp, setSp] = useSearchParams();
  const criteria = readLogCriteria(sp);
  const isPusat = can(profile.role, 'unit.pilih');
  const unitId = isPusat ? activeUnitId : null;

  const [text, setText] = useState(criteria.q);
  const [urlQ, setUrlQ] = useState(criteria.q);
  if (criteria.q !== urlQ) {
    setUrlQ(criteria.q);
    if (criteria.q !== text.trim()) setText(criteria.q);
  }

  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selected, setSelected] = useState<MasterLogRow | null>(null);
  const filterButton = useRef<HTMLButtonElement>(null);
  const detailTrigger = useRef<HTMLElement | null>(null);
  const [retry, setRetry] = useState(0);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  // Debounce: kotak cari -> URL (replace).
  useEffect(() => {
    if (text.trim() === criteria.q.trim()) return;
    const t = window.setTimeout(() => {
      setSp(writeLogCriteria({ ...criteria, q: text, hal: 1 }), { replace: true });
    }, LOG_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
    // criteria berasal dari sp.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, sp, setSp]);

  const key = JSON.stringify({ c: writeLogCriteria(criteria).toString(), unitId, retry });

  // Satu permintaan per kunci; yang lama dibatalkan dan hasilnya diabaikan.
  useEffect(() => {
    const { c, unitId: u } = JSON.parse(key) as { c: string; unitId: string | null };
    const cr = readLogCriteria(new URLSearchParams(c));
    const ctrl = new AbortController();
    fetchMasterLog(client, { filters: toRpcFilters(cr), limit: LOG_PAGE_SIZE, offset: (cr.hal - 1) * LOG_PAGE_SIZE, unitId: u }, ctrl.signal)
      .then((data) => {
        if (!ctrl.signal.aborted) setOutcome({ key, kind: 'ok', data });
      })
      .catch((error: unknown) => {
        if (ctrl.signal.aborted || isAbortError(error)) return;
        const e = error instanceof ApiError ? error : null;
        setOutcome({ key, kind: 'error', message: e ? e.userMessage : toUserMessage(error), code: e?.code ?? 'UNKNOWN' });
      });
    return () => ctrl.abort();
  }, [client, key]);

  const [filterValues] = useLoad<MasterLogFilterValues | null>(`mlfv:${unitId ?? 'all'}`, () => fetchMasterLogFilterValues(client, unitId).catch(() => null));

  const current = outcome && outcome.key === key ? outcome : null;
  const filterCount = activeLogFilterCount(criteria);
  const anyCriteria = filterCount > 0 || criteria.q.trim() !== '';

  function submit(e: FormEvent) {
    e.preventDefault();
    setSp(writeLogCriteria({ ...criteria, q: text, hal: 1 }));
  }
  function clearAll() {
    setText('');
    setSp(new URLSearchParams());
  }

  let body;
  let status: string;
  if (!current) {
    status = 'Memuat jejak audit…';
    body = <LogSkeleton />;
  } else if (current.kind === 'error') {
    if (current.code === 'FORBIDDEN_ROLE') {
      status = 'Akses ditolak.';
      body = (
        <div className="empty-state card">
          <span className="placeholder-icon" aria-hidden="true">🔒</span>
          <h2 className="section-title">Akses ditolak</h2>
          <p className="muted">Hanya Admin Unit dan Admin Pusat yang dapat membuka Master Log Perubahan.</p>
        </div>
      );
    } else {
      status = 'Gagal memuat log.';
      body = (
        <div className="stack">
          <Alert tone="error" message={current.message} />
          <button type="button" className="btn btn-secondary" onClick={() => setRetry((n) => n + 1)}>
            Coba lagi
          </button>
        </div>
      );
    }
  } else if (current.data.rows.length === 0) {
    const beyond = current.data.total > 0;
    status = beyond ? 'Halaman ini kosong.' : 'Tidak ada entri log.';
    body = (
      <div className="empty-state card">
        <h2 className="section-title">{beyond ? 'Halaman ini kosong' : anyCriteria ? 'Tidak ada entri yang cocok' : 'Belum ada aktivitas tercatat'}</h2>
        <p className="muted">
          {beyond ? 'Jumlah entri lebih sedikit dari nomor halaman ini.' : anyCriteria ? 'Coba perlebar rentang tanggal atau bersihkan sebagian filter.' : 'Perubahan data akan muncul di sini begitu petugas bekerja.'}
        </p>
        {beyond ? (
          <button type="button" className="btn btn-secondary" onClick={() => setSp(writeLogCriteria({ ...criteria, hal: 1 }))}>
            Ke halaman pertama
          </button>
        ) : anyCriteria ? (
          <button type="button" className="btn btn-secondary" onClick={clearAll}>
            Bersihkan semua filter
          </button>
        ) : null}
      </div>
    );
  } else {
    const { total, offset, rows } = current.data;
    const pages = Math.max(1, Math.ceil(total / LOG_PAGE_SIZE));
    status = `${formatNumber(total)} entri log.`;
    body = (
      <>
        <p className="result-summary">
          {total > rows.length ? `Menampilkan ${formatNumber(offset + 1)}–${formatNumber(offset + rows.length)} dari ${formatNumber(total)} entri` : `${formatNumber(total)} entri`}
          {' · terbaru lebih dulu'}
        </p>
        <div className="ml-table-wrap">
          <LogTable
            rows={rows}
            showUnit={isPusat}
            onOpen={(row, trigger) => {
              detailTrigger.current = trigger;
              setSelected(row);
            }}
          />
        </div>
        {pages > 1 ? (
          <nav className="pager" aria-label="Halaman log">
            {criteria.hal > 1 ? (
              <button type="button" className="btn btn-secondary" onClick={() => setSp(writeLogCriteria({ ...criteria, hal: criteria.hal - 1 }))} rel="prev">
                ‹ Sebelumnya
              </button>
            ) : (
              <span />
            )}
            <span className="pager-info">
              Halaman {criteria.hal} dari {pages}
            </span>
            {criteria.hal < pages ? (
              <button type="button" className="btn btn-secondary" onClick={() => setSp(writeLogCriteria({ ...criteria, hal: criteria.hal + 1 }))} rel="next">
                Berikutnya ›
              </button>
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
      <PageHeader title="Master Log Perubahan" subtitle="Jejak audit permanen: siapa mengubah apa, kapan, dan mengapa." />
      <form className="search-bar" role="search" onSubmit={submit}>
        <label htmlFor="log-q" className="sr-only">
          Cari di log (alasan, ID objek, aksi, ringkasan)
        </label>
        <input
          id="log-q"
          type="search"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          placeholder="Alasan, ID objek, aksi, ringkasan…"
          value={text}
          maxLength={200}
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
      <div className="search-results" aria-busy={!current ? true : undefined}>
        {body}
      </div>
      {filtersOpen ? (
        <FilterSheet
          initial={{ ...criteria, q: text }}
          values={filterValues.kind === 'ok' ? filterValues.data : null}
          onApply={(c) => {
            setFiltersOpen(false);
            setSp(writeLogCriteria(c));
            filterButton.current?.focus();
          }}
          onClose={() => {
            setFiltersOpen(false);
            filterButton.current?.focus();
          }}
        />
      ) : null}
      {selected ? (
        <LogDetailSheet
          row={selected}
          showUnit={isPusat}
          onClose={() => {
            setSelected(null);
            detailTrigger.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}
