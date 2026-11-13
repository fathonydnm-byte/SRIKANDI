import { useEffect, useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { ApiError, getBerkasItems, isAbortError, matchBerkasByItems, type DashboardGroup, type OverviewItem } from '../../lib/api';
import { toUserMessage, type UserMessage } from '../../lib/errors';
import { developmentLabel, formatDate, formatNumber } from '../../lib/format';
import { Alert } from '../../components/Alert';
import { FileBadge, LoanBadge } from '../../components/Badges';
import { RetentionBadge } from './RetentionBadge';

export const FILTER_DEBOUNCE_MS = 300;
/** Batas "Buka Semua" sekali tekan: 400 berkas × 50 item = 20.000 baris membekukan HP. */
export const EXPAND_ALL_LIMIT = 100;

type ItemsState = OverviewItem[] | 'loading' | { error: UserMessage };

/** 3.x normalizeFolderLabelFilter_: trim + huruf kecil; token dipisah spasi. */
function tokensOf(term: string): string[] {
  return term.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function berkasMatches(g: DashboardGroup, tokens: string[]): boolean {
  const corpus = [g.no_berkas ?? '', g.judul_berkas, g.kode_klasifikasi ?? '', g.lokasi].join(' ').toLowerCase();
  return tokens.every((t) => corpus.includes(t));
}

function ItemRows({ state, onRetry }: { state: ItemsState | undefined; onRetry(): void }) {
  if (state === undefined || state === 'loading') {
    return (
      <p className="muted small arc-items-status" role="status">
        Memuat item…
      </p>
    );
  }
  if (!Array.isArray(state)) {
    return (
      <div className="stack">
        <Alert tone="error" message={state.error} />
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
          Coba lagi
        </button>
      </div>
    );
  }
  if (!state.length) return <p className="muted small arc-items-status">Belum ada item pada berkas ini.</p>;
  return (
    <ol className="arc-item-list">
      {state.map((it) => (
        <li key={it.item_id}>
          <Link to={`/cari/item/${encodeURIComponent(it.item_id)}`} className="arc-item">
            <span className="arc-item-no" aria-label={`Item ${it.no_item ?? '–'}`}>{it.no_item ?? '–'}</span>
            <span className="arc-item-main">
              <strong>{it.no_surat || 'Tanpa nomor surat'}</strong>
              {it.uraian ? <span className="arc-item-desc">{it.uraian}</span> : null}
              <span className="arc-item-meta">
                {formatNumber(it.jumlah_halaman ?? 0)} lembar · {formatDate(it.tanggal_naskah)} · {developmentLabel(it.tingkat_perkembangan)}
                <FileBadge hasFile={it.has_file} />
                <LoanBadge status={it.status_peminjaman} />
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ol>
  );
}

/**
 * "Daftar Isi Berkas" (3.x renderDashboardArchiveList_): akordeon berkas aktif.
 * Filter berkas (nomor, judul, kode, lokasi) berjalan di browser atas data yang
 * sudah dimuat; bagian "uraian item" ditanyakan ke server (debounce) agar
 * dashboard tidak perlu memuat ±20.000 item per unit sekaligus.
 */
export function ArchiveOverview({ groups, unitId, onRefresh, refreshing }: { groups: DashboardGroup[]; unitId: string | null; onRefresh(): void; refreshing: boolean }) {
  const { client } = useAuth();
  const filterId = useId();
  const [term, setTerm] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [items, setItems] = useState<Record<string, ItemsState>>({});
  const [itemMatch, setItemMatch] = useState<{ term: string; ids: Set<string> } | null>(null);
  const [capped, setCapped] = useState(false);

  const tokens = tokensOf(term);
  const trimmed = tokens.join(' ');

  // Bagian item dari filter: satu permintaan per teks, yang lama dibatalkan.
  useEffect(() => {
    if (!trimmed) return;
    const ctrl = new AbortController();
    const t = window.setTimeout(() => {
      matchBerkasByItems(client, trimmed, unitId, ctrl.signal)
        .then((ids) => {
          if (!ctrl.signal.aborted) setItemMatch({ term: trimmed, ids: new Set(ids) });
        })
        .catch((error: unknown) => {
          if (!ctrl.signal.aborted && !isAbortError(error)) setItemMatch({ term: trimmed, ids: new Set() });
        });
    }, FILTER_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(t);
      ctrl.abort();
    };
  }, [client, trimmed, unitId]);

  const itemIds = itemMatch && itemMatch.term === trimmed ? itemMatch.ids : null;
  const visible = useMemo(
    () => (tokens.length ? groups.filter((g) => berkasMatches(g, tokens) || Boolean(itemIds?.has(g.berkas_id))) : groups),
    // tokens berasal dari trimmed
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, trimmed, itemIds],
  );
  const itemSearchPending = tokens.length > 0 && itemIds === null;

  async function load(ids: string[]) {
    const need = ids.filter((id) => {
      const s = items[id];
      return s === undefined || (typeof s === 'object' && !Array.isArray(s));
    });
    if (!need.length) return;
    setItems((prev) => {
      const next = { ...prev };
      for (const id of need) next[id] = 'loading';
      return next;
    });
    try {
      const map = await getBerkasItems(client, need);
      setItems((prev) => ({ ...prev, ...map }));
    } catch (error) {
      const message = error instanceof ApiError ? error.userMessage : toUserMessage(error);
      setItems((prev) => {
        const next = { ...prev };
        for (const id of need) next[id] = { error: message };
        return next;
      });
    }
  }

  function toggle(id: string) {
    const open = !expanded.has(id);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
    if (open) void load([id]);
  }

  function expandAll() {
    const ids = visible.slice(0, EXPAND_ALL_LIMIT).map((g) => g.berkas_id);
    setCapped(visible.length > EXPAND_ALL_LIMIT);
    setExpanded(new Set(ids));
    void load(ids);
  }

  return (
    <section className="card archive-card" aria-labelledby="arc-title">
      <div className="section-heading">
        <div>
          <h2 id="arc-title" className="section-title">Daftar Isi Berkas</h2>
          <p className="muted small">Ringkasan seluruh berkas beserta item arsip aktif — tidak perlu membuka spreadsheet.</p>
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={refreshing}
          onClick={() => {
            setItems({});
            setExpanded(new Set());
            onRefresh();
          }}
        >
          {refreshing ? 'Memuat…' : 'Segarkan Data'}
        </button>
      </div>
      <div className="arc-toolbar">
        <label htmlFor={filterId} className="sr-only">
          Saring daftar berkas
        </label>
        <input
          id={filterId}
          type="search"
          autoComplete="off"
          maxLength={250}
          placeholder="Cari nomor berkas, judul, kode klasifikasi, atau uraian item"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />
        <div className="arc-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={expandAll} disabled={!visible.length}>
            Buka Semua
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => {
              setExpanded(new Set());
              setCapped(false);
            }}
            disabled={!expanded.size}
          >
            Tutup Semua
          </button>
        </div>
      </div>
      <p className="muted small arc-count" role="status" aria-live="polite">
        {tokens.length
          ? `${formatNumber(visible.length)} dari ${formatNumber(groups.length)} berkas cocok${itemSearchPending ? ' — mencari juga di uraian item…' : ''}`
          : `${formatNumber(groups.length)} berkas aktif`}
        {capped && expanded.size ? ` — dibuka ${formatNumber(EXPAND_ALL_LIMIT)} berkas pertama; persempit dengan kotak pencarian untuk membuka yang lain.` : ''}
      </p>
      {visible.length === 0 ? (
        <p className="arc-empty">{groups.length ? (itemSearchPending ? 'Mencari…' : 'Tidak ada berkas atau item yang cocok dengan pencarian.') : 'Belum ada berkas aktif.'}</p>
      ) : (
        <ul className="arc-list">
          {visible.map((g) => {
            const open = expanded.has(g.berkas_id);
            const panelId = `arc-${g.berkas_id}`;
            return (
              <li key={g.berkas_id} className={`arc-row${open ? ' open' : ''}`}>
                <div className="arc-head">
                  <button
                    type="button"
                    className="arc-toggle"
                    aria-expanded={open}
                    aria-controls={open ? panelId : undefined}
                    aria-label={`${open ? 'Tutup' : 'Buka'} isi berkas ${g.no_berkas ?? ''}`}
                    onClick={() => toggle(g.berkas_id)}
                  >
                    <span aria-hidden="true">▸</span>
                  </button>
                  <div className="arc-main">
                    <Link to={`/cari/berkas/${encodeURIComponent(g.berkas_id)}`} className="arc-title">
                      {g.no_berkas ?? '–'} — {g.judul_berkas}
                    </Link>
                    <span className="arc-sub">
                      {g.kode_klasifikasi || '–'} · {g.kurun_waktu || '–'} · <span className="arc-loc">{g.lokasi}</span>
                    </span>
                  </div>
                  <div className="arc-meta">
                    <span>
                      {formatNumber(g.item_count)} item · {formatNumber(g.total_lembar)} lembar
                    </span>
                    <RetentionBadge code={g.status_code} label={g.status_label} />
                  </div>
                </div>
                {open ? (
                  <div id={panelId} className="arc-items">
                    <ItemRows state={items[g.berkas_id]} onRetry={() => void load([g.berkas_id])} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
