import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { Alert } from '../../components/Alert';
import { Field } from '../../components/Field';
import { PageHeader } from '../../components/PageHeader';
import { Sheet } from '../../components/Sheet';
import { newRequestId } from '../../lib/api';
import { lidah, type LabelBerkas, type LabelPrintResult, type PrintStatus } from '../../lib/lidahApi';
import { useLoad } from '../../lib/useLoad';
import { errorMessage, formatTimestamp, NeedsUnit, SaveStage, useWriteUnit } from '../s2/common';
import { LabelSheets } from './LabelSheets';
import { pageCount, PER_PAGE, slotName } from './labelLayout';

const MAX_LABELS = 500; // folder_label_print: maksimal 500 berkas per cetakan

type StatusFilter = 'ALL' | PrintStatus;
const FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'ALL', label: 'Semua status cetak' },
  { value: 'BELUM_DICETAK', label: 'Belum dicetak' },
  { value: 'PERLU_CETAK_ULANG', label: 'Perlu cetak ulang' },
  { value: 'SUDAH_DICETAK', label: 'Sudah dicetak' },
];

const normalize = (v: string) =>
  v.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

function statusBadge(status: PrintStatus): string {
  return status === 'SUDAH_DICETAK' ? 'badge-ok' : status === 'PERLU_CETAK_ULANG' ? 'badge-warn' : 'badge-neutral';
}

/** Nama berkas PDF/cetak seperti 3.x: Lidah_Folder_yyyyMMdd_HHmmss (waktu Jakarta). */
function defaultFileName(now = new Date()): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
      .formatToParts(now).map((x) => [x.type, x.value]),
  );
  return `Lidah_Folder_${p.year}${p.month}${p.day}_${p.hour === '24' ? '00' : p.hour}${p.minute}${p.second}`;
}

/**
 * Cetak Lidah Folder (port 3.x "Cetak Lidah Folder"): pilih berkas, pilih
 * posisi awal pada lembar 2 × 7, lihat pratinjau, cetak lewat dialog cetak
 * browser (A4; "Simpan sebagai PDF" juga bisa), lalu catat cetakan agar
 * penanda "Perlu cetak ulang" bekerja.
 */
export function LabelsPage() {
  const { unitId, needsUnit } = useWriteUnit();
  if (needsUnit) return (<><PageHeader title="Cetak Lidah Folder" subtitle="Cetak label lidah folder untuk berkas aktif." /><NeedsUnit /></>);
  return <LabelsScreen unitId={unitId} />;
}

function LabelsScreen({ unitId }: { unitId: string | null }) {
  const { client } = useAuth();
  const [load, retry] = useLoad(`lidah:${unitId ?? 'own'}`, () => lidah.options(client, unitId));
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<StatusFilter>('ALL');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [startSlot, setStartSlot] = useState(1);
  const [asking, setAsking] = useState(false);
  const [stage, setStage] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ data: LabelPrintResult; changed: boolean } | null>(null);
  const printing = useRef(false);
  const attempt = useRef<{ sig: string; requestId: string } | null>(null);
  const fileName = useRef<string | null>(null);
  const savedTitle = useRef<string | null>(null);
  const searchId = useId();
  const filterId = useId();

  const all = useMemo(() => (load.kind === 'ok' ? load.data.berkas : []), [load]);
  const visible = useMemo(() => {
    const tokens = normalize(query).split(' ').filter(Boolean);
    return all.filter((b) => {
      if (filter !== 'ALL' && b.print_status !== filter) return false;
      if (!tokens.length) return true;
      const corpus = normalize([b.number, b.classification_code, b.title, b.location].join(' '));
      return tokens.every((t) => corpus.includes(t));
    });
  }, [all, query, filter]);
  // Pilihan hanya sah bila berkas masih ada di daftar TERKINI.
  const chosen = useMemo(() => all.filter((b) => selected.has(b.id)), [all, selected]);
  const pages = pageCount(startSlot, chosen.length);
  const tooMany = chosen.length > MAX_LABELS;
  const reprintCount = all.filter((b) => b.needs_reprint).length;
  const sheetLabels = useMemo(
    () => chosen.map((b) => ({ berkas_id: b.id, number: b.number, classification_code: b.classification_code, title: b.title })),
    [chosen],
  );

  useEffect(() => {
    function after() {
      if (savedTitle.current !== null) {
        document.title = savedTitle.current;
        savedTitle.current = null;
      }
      if (printing.current) {
        printing.current = false;
        setAsking(true);
      }
    }
    window.addEventListener('afterprint', after);
    return () => window.removeEventListener('afterprint', after);
  }, []);

  const toggle = (id: string, on: boolean) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const addMany = (rows: LabelBerkas[]) => setSelected((cur) => new Set([...cur, ...rows.map((r) => r.id)]));

  function print() {
    if (!chosen.length || tooMany) return;
    fileName.current = defaultFileName();
    savedTitle.current = document.title;
    document.title = fileName.current;
    printing.current = true;
    setResult(null);
    window.print();
  }

  async function record() {
    if (!chosen.length || tooMany) return;
    const ids = chosen.map((b) => b.id);
    const sig = `${ids.join(',')}|${startSlot}`;
    // Ulangi manual dengan id yang SAMA bila pencatatan sebelumnya gagal (idempoten di server).
    const requestId = attempt.current?.sig === sig ? attempt.current.requestId : newRequestId();
    attempt.current = { sig, requestId };
    fileName.current ??= defaultFileName();
    setStage('saving');
    setError(null);
    try {
      const r = await lidah.print(client, requestId, ids, startSlot, fileName.current, unitId);
      const byId = new Map(r.data.labels.map((l) => [l.berkas_id, l]));
      const changed = chosen.some((b) => {
        const l = byId.get(b.id);
        return !l || l.number !== b.number || l.classification_code !== b.classification_code || l.title !== b.title;
      });
      attempt.current = null;
      fileName.current = null;
      setResult({ data: r.data, changed });
      setSelected(new Set());
      setAsking(false);
      setStage('saved');
      retry();
    } catch (e) {
      const m = errorMessage(e);
      setError(`${m.title} ${m.action}`);
      setStage('error');
    }
  }

  return (
    <div className="lf-page-root">
      <div className="no-print">
        <PageHeader title="Cetak Lidah Folder" subtitle="A4, 2 kolom × 7 baris, label 70 × 30 mm. Pilih berkas dan posisi awal, periksa pratinjau, lalu cetak." />
      </div>
      <div className="lf-layout">
        <div className="no-print stack">
          {load.kind === 'error' ? (
            <>
              <Alert tone="error" message={load.message} />
              <button type="button" className="btn btn-secondary" onClick={retry}>Coba lagi</button>
            </>
          ) : null}
          {result ? (
            <Alert tone={result.changed ? 'warning' : 'success'}>
              <strong>{result.data.message}</strong>{' '}
              <span>
                {result.data.label_count} label · {result.data.page_count} halaman · posisi awal {result.data.start_slot}.
                {result.changed ? ' Data berkas berubah sejak pratinjau; cetak ulang label yang berubah.' : ''}
              </span>
            </Alert>
          ) : null}

          <section className="card lf-section" aria-labelledby="lf-pilih">
            <h2 className="section-title" id="lf-pilih">1. Pilih berkas</h2>
            <div className="lf-toolbar">
              <Field label="Cari berkas" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Nomor, kode klasifikasi, judul, atau lokasi" autoComplete="off" />
              <div className="field">
                <label htmlFor={filterId}>Status cetak</label>
                <select id={filterId} value={filter} onChange={(e) => setFilter(e.target.value as StatusFilter)}>
                  {FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
              </div>
              <div className="lf-toolbar-row">
                <button type="button" className="btn btn-secondary" disabled={!visible.length} onClick={() => addMany(visible)}>Pilih semua yang tampil ({visible.length})</button>
                <button type="button" className="btn btn-secondary" disabled={!reprintCount} onClick={() => addMany(all.filter((b) => b.needs_reprint))}>Pilih yang perlu cetak ulang ({reprintCount})</button>
                <button type="button" className="btn btn-secondary" disabled={!chosen.length} onClick={() => setSelected(new Set())}>Kosongkan pilihan</button>
                <button type="button" className="btn btn-secondary" disabled={load.kind === 'loading'} onClick={retry}>Muat ulang</button>
              </div>
            </div>
            <p className="muted small" id={searchId} role="status">
              {load.kind === 'loading'
                ? 'Memuat daftar berkas aktif…'
                : `${visible.length} dari ${all.length} berkas aktif bernomor definitif.`}
            </p>
            {load.kind === 'ok' && !visible.length ? (
              <p className="empty-state">
                {all.length ? 'Tidak ada berkas yang sesuai dengan pencarian atau status cetak.' : 'Belum ada berkas aktif yang memiliki nomor definitif.'}
              </p>
            ) : null}
            <ul className="lf-list" aria-label="Daftar berkas aktif">
              {visible.map((b) => (
                <li key={b.id}>
                  <label className="lf-row">
                    <input type="checkbox" checked={selected.has(b.id)} onChange={(e) => toggle(b.id, e.target.checked)} aria-label={`Pilih berkas ${b.number}`} />
                    <span className="lf-row-main">
                      <span className="lf-row-title">{b.classification_code} | {b.number}</span>
                      <span>{b.title}</span>
                      <span className="lf-row-sub">{b.location}</span>
                      <span className={`badge-pill ${statusBadge(b.print_status)}`}>{b.print_status_label}</span>
                      {b.last_printed_at ? (
                        <span className="lf-row-sub">
                          Terakhir dicetak {formatTimestamp(b.last_printed_at)}
                          {b.needs_reprint ? ' · nomor, kode, atau judul berubah sejak itu' : ''}
                        </span>
                      ) : null}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </section>

          <section className="card lf-section" aria-labelledby="lf-posisi">
            <h2 className="section-title" id="lf-posisi">2. Posisi awal pada lembar</h2>
            <p className="muted small">Pakai lagi kertas yang sebagian terpakai: label pertama dicetak mulai posisi yang dipilih.</p>
            <div className="lf-slots" role="radiogroup" aria-label="Posisi awal label">
              {Array.from({ length: PER_PAGE }, (_, i) => i + 1).map((slot) => (
                <button
                  key={slot}
                  type="button"
                  role="radio"
                  aria-checked={startSlot === slot}
                  aria-label={`Posisi ${slot}, ${slotName(slot)}`}
                  className={`lf-slot${slot < startSlot ? ' is-before' : ''}`}
                  onClick={() => setStartSlot(slot)}
                >
                  Posisi {slot}
                  <small>{slotName(slot)}</small>
                </button>
              ))}
            </div>
          </section>
        </div>

        <aside className="lf-aside stack" aria-label="Pratinjau dan cetak">
          <div className="no-print stack">
            <h2 className="section-title">3. Pratinjau dan cetak</h2>
            <p className="lf-summary" role="status">
              {chosen.length ? `${chosen.length} berkas dipilih · ${pages} halaman A4` : 'Belum ada berkas dipilih.'}
            </p>
            {tooMany ? <Alert tone="error"><span>Maksimal {MAX_LABELS} lidah folder dalam satu cetakan. Kurangi pilihan atau pecah menjadi beberapa batch.</span></Alert> : null}
            {error ? <Alert tone="error"><span>{error}</span></Alert> : null}
          </div>
          <div className="lf-preview" aria-label="Pratinjau lembar A4">
            <LabelSheets labels={sheetLabels} startSlot={startSlot} />
          </div>
          <div className="no-print stack">
            <div className="action-row">
              <button type="button" className="btn btn-primary" disabled={!chosen.length || tooMany || stage === 'saving'} onClick={print}>Cetak Lidah Folder</button>
              <button type="button" className="btn btn-secondary" disabled={!chosen.length || tooMany || stage === 'saving'} onClick={() => setAsking(true)}>Catat sudah dicetak</button>
            </div>
            <SaveStage stage={stage} message={stage === 'saving' ? 'Mencatat cetakan…' : stage === 'saved' ? 'Cetakan tercatat.' : undefined} />
            <p className="muted small">Di dialog cetak pilih ukuran A4, skala 100%, dan margin bawaan. Di HP, pilih “Simpan sebagai PDF” atau printer.</p>
          </div>
        </aside>
      </div>
      {asking ? (
        <Sheet title="Konfirmasi cetak" onClose={() => setAsking(false)} variant="dialog">
          <div className="stack">
            <p>Apakah <strong>{chosen.length} lidah folder</strong> (mulai posisi {startSlot}) sudah tercetak dengan baik? Cetakan dicatat agar perubahan berkas berikutnya ditandai “Perlu cetak ulang”.</p>
            {error ? <Alert tone="error"><span>{error}</span></Alert> : null}
            <div className="action-row">
              <button type="button" className="btn btn-primary" disabled={stage === 'saving'} onClick={() => void record()}>{stage === 'saving' ? 'Mencatat…' : 'Ya, catat cetakan'}</button>
              <button type="button" className="btn btn-secondary" onClick={() => setAsking(false)}>Belum</button>
            </div>
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}
