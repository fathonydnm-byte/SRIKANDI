import { useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { Alert } from '../../components/Alert';
import { PageHeader } from '../../components/PageHeader';
import { newRequestId } from '../../lib/api';
import { formatDate, formatNumber } from '../../lib/format';
import { transferApi, type RetentionCandidate, type RetentionFilter, type TransferDraft } from '../../lib/transferApi';
import { useLoad } from '../../lib/useLoad';
import { RetentionBadge } from '../dashboard/RetentionBadge';
import { errorMessage, NeedsUnit, useWriteUnit } from '../s2/common';
import './retention.css';

const PAGE = 25;
const MAX = 200;
type Message = ReturnType<typeof errorMessage>;
type View = 'h7' | 'habis' | 'draf';

function useRequest() {
  const state = useRef<{ key: string; id: string } | null>(null);
  return (values: unknown) => {
    const key = JSON.stringify(values);
    if (state.current?.key !== key) state.current = { key, id: newRequestId() };
    return state.current.id;
  };
}

function Pager({ offset, size, move }: { offset: number; size: number; move: (o: number) => void }) {
  return <div className="retention-actions">
    {offset > 0 && <button className="btn btn-secondary" type="button" onClick={() => move(offset - PAGE)}>Sebelumnya</button>}
    {size === PAGE && <button className="btn btn-secondary" type="button" onClick={() => move(offset + PAGE)}>Berikutnya</button>}
  </div>;
}

export function RetentionPage() {
  const { unitId, needsUnit } = useWriteUnit();
  return <>
    <PageHeader title="Penyusutan Arsip" subtitle="Pantau masa retensi aktif dan siapkan draf usul pemindahan." />
    {needsUnit ? <NeedsUnit /> : <RetentionScreen key={unitId ?? 'own'} unitId={unitId} />}
  </>;
}

function RetentionScreen({ unitId }: { unitId: string | null }) {
  const [sp, setSp] = useSearchParams();
  const view: View = sp.get('filter') === 'h7' ? 'h7' : sp.get('filter') === 'draf' ? 'draf' : 'habis';
  const [picked, setPicked] = useState<RetentionCandidate[]>([]);
  const [notice, setNotice] = useState('');
  function toggle(row: RetentionCandidate) {
    setPicked((current) => current.some((c) => c.berkas_id === row.berkas_id)
      ? current.filter((c) => c.berkas_id !== row.berkas_id)
      : current.length < MAX && !row.blocked_reason ? [...current, row] : current);
  }
  return <div className="stack retention-screen">
    <div className="retention-actions">
      {([['h7', 'Retensi H-7'], ['habis', 'Habis Aktif'], ['draf', 'Draf Usul']] as const).map(([value, label]) =>
        <button type="button" className={view === value ? 'btn btn-primary' : 'btn btn-secondary'} aria-pressed={view === value}
          key={value} onClick={() => { setNotice(''); setSp({ filter: value }); }}>{label}</button>)}
    </div>
    {notice && <Alert tone="success">{notice}</Alert>}
    {view === 'draf'
      ? <Drafts unitId={unitId} onCancel={() => setNotice('Draf dibatalkan. Berkas yang masih memenuhi syarat dapat dipilih kembali.')} />
      : <CandidateList key={view} unitId={unitId} filter={view === 'h7' ? 'H7' : 'HABIS'} picked={picked} onToggle={toggle}
        onClear={() => setPicked([])} onSaved={(number) => { setPicked([]); setNotice(`Draf ${number} tersimpan.`); setSp({ filter: 'draf' }); }} />}
  </div>;
}

function CandidateList({ unitId, filter, picked, onToggle, onClear, onSaved }: {
  unitId: string | null; filter: RetentionFilter; picked: RetentionCandidate[];
  onToggle: (r: RetentionCandidate) => void; onClear: () => void; onSaved: (number: string) => void;
}) {
  const { client } = useAuth();
  const [offset, setOffset] = useState(0);
  const [data, retry] = useLoad(`retention:${filter}:${offset}`, () => transferApi.candidates(client, unitId, filter, offset));
  const [err, setErr] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  const request = useRequest();
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!picked.length || guard.current) return;
    const form = new FormData(e.currentTarget);
    const title = String(form.get('title') ?? '').trim();
    const notes = String(form.get('notes') ?? '').trim();
    const ids = picked.map((p) => p.berkas_id).sort();
    guard.current = true;
    setBusy(true);
    setErr(null);
    try {
      const res = await transferApi.create(client, unitId, ids, title, notes, request([ids, title, notes]));
      onSaved(res.data.draft_number);
    } catch (error) {
      setErr(errorMessage(error));
      retry();
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  return <>
    <section className="card stack" aria-label={filter === 'H7' ? 'Daftar Retensi H-7' : 'Daftar Habis Aktif'}>
      <h2 className="section-title">{filter === 'H7' ? 'Retensi H-7' : 'Habis Aktif'}</h2>
      <p className="muted">{filter === 'H7' ? 'Retensi aktif berakhir hari ini atau dalam tujuh hari ke depan.' : 'Pilih berkas yang memenuhi syarat untuk membuat draf usul.'}</p>
      {data.kind === 'loading' && <p role="status">Memuat daftar retensi…</p>}
      {data.kind === 'error' && <><Alert tone="error" message={data.message} /><button type="button" className="btn btn-secondary" onClick={retry}>Coba lagi</button></>}
      {data.kind === 'ok' && <>
        {!data.data.length && <p className="muted">Tidak ada berkas pada halaman ini.</p>}
        {data.data.map((r) => {
          const selected = picked.some((p) => p.berkas_id === r.berkas_id);
          const label = `${r.no_berkas} — ${r.judul_berkas}`;
          return <article className="retention-record" key={r.berkas_id}>
            <div className="retention-actions">
              <Link to={`/cari/berkas/${encodeURIComponent(r.berkas_id)}`}>{label}</Link>
              <RetentionBadge code={r.status_code} label={r.status_label} />
            </div>
            <p className="muted small">{r.kode_klasifikasi || '—'} · {r.kurun_waktu || '—'} · {formatNumber(r.item_count)} item{r.lokasi ? ` · ${r.lokasi}` : ''}</p>
            <p>Batas aktif <strong>{formatDate(r.batas_aktif, '—')}</strong> · Batas inaktif {formatDate(r.batas_inaktif, '—')} · {r.nasib_akhir || 'Nasib akhir belum diisi'}</p>
            {r.usul_pindah_no && <p>Usul: {r.usul_pindah_no}</p>}
            {filter === 'HABIS' && <>
              {r.blocked_reason && <p className="muted">{r.blocked_reason}</p>}
              {(!r.blocked_reason || selected) && <label className="retention-choice">
                <input aria-label={`Pilih berkas ${label}`} type="checkbox" checked={selected}
                  disabled={busy || (!selected && picked.length >= MAX)} onChange={() => onToggle(r)} />
                Pilih untuk draf
              </label>}
            </>}
          </article>;
        })}
        <Pager offset={offset} size={data.data.length} move={setOffset} />
      </>}
    </section>
    {filter === 'HABIS' && picked.length > 0 && <form className="card stack" onSubmit={save} aria-label="Draf Usul Pemindahan">
      <h2 className="section-title">Draf Usul Pemindahan · {picked.length}/{MAX} berkas</h2>
      <ul className="retention-picks">
        {picked.map((r) => <li key={r.berkas_id}><button type="button" className="btn btn-secondary" disabled={busy} onClick={() => onToggle(r)}>Hapus {r.no_berkas} — {r.judul_berkas}</button></li>)}
      </ul>
      <label className="retention-field">Judul usul<input name="title" maxLength={300} defaultValue="Usul Pemindahan Arsip Inaktif" disabled={busy} /></label>
      <label className="retention-field">Catatan (opsional)<textarea name="notes" maxLength={2000} disabled={busy} /></label>
      {err && <Alert tone="error" message={err} />}
      <div className="retention-actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Menyimpan draf…' : 'Simpan Draf'}</button>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={onClear}>Hapus semua pilihan</button>
      </div>
    </form>}
  </>;
}

function Drafts({ unitId, onCancel }: { unitId: string | null; onCancel: () => void }) {
  const { client } = useAuth();
  const [offset, setOffset] = useState(0);
  const [data, reload] = useLoad(`transfer-drafts:${offset}`, () => transferApi.drafts(client, unitId, offset));
  const [detail, setDetail] = useState<string | null>(null);
  const [check, setCheck] = useState<string | null>(null);
  const [cancel, setCancel] = useState<string | null>(null);
  return <section className="card stack" aria-label="Daftar Draf Usul">
    <h2 className="section-title">Draf Usul</h2>
    <p className="muted">Berkas tetap berada di Central File. Draf di sini belum dikirim ke Record Center.</p>
    {data.kind === 'loading' && <p role="status">Memuat draf…</p>}
    {data.kind === 'error' && <><Alert tone="error" message={data.message} /><button type="button" className="btn btn-secondary" onClick={reload}>Coba lagi</button></>}
    {data.kind === 'ok' && <>
      {!data.data.length && <p className="muted">Belum ada draf pada halaman ini.</p>}
      {data.data.map((d) => <article className="retention-record" key={d.id}>
        <h3>{d.draft_number} — {d.title}</h3>
        <p>{d.cancelled_at ? 'Dibatalkan' : 'Draf'} · {formatNumber(d.berkas_count)} berkas · {formatNumber(d.item_count)} item</p>
        {d.notes && <p>{d.notes}</p>}
        {d.cancel_reason && <p className="muted">Alasan pembatalan: {d.cancel_reason}</p>}
        <div className="retention-actions">
          <button type="button" className="btn btn-secondary" aria-expanded={detail === d.id} onClick={() => setDetail(detail === d.id ? null : d.id)}>{detail === d.id ? 'Tutup Rincian' : 'Lihat Rincian'}</button>
          {!d.cancelled_at && <button type="button" className="btn btn-secondary" aria-expanded={check === d.id}
            onClick={() => setCheck(check === d.id ? null : d.id)}>{check === d.id ? 'Tutup Pemeriksaan' : 'Periksa Kelayakan'}</button>}
          {!d.cancelled_at && <button type="button" className="btn btn-secondary" aria-expanded={cancel === d.id} onClick={() => setCancel(cancel === d.id ? null : d.id)}>{cancel === d.id ? 'Tutup Pembatalan' : 'Batalkan Draf'}</button>}
        </div>
        {detail === d.id && <DraftDetail unitId={unitId} id={d.id} />}
        {check === d.id && !d.cancelled_at && <DraftCheck unitId={unitId} id={d.id} />}
        {cancel === d.id && !d.cancelled_at && <CancelDraft unitId={unitId} draft={d} done={() => {
          setCancel(null); if (check === d.id) setCheck(null); reload(); onCancel();
        }} />}
      </article>)}
      <Pager offset={offset} size={data.data.length} move={(o) => { setOffset(o); setDetail(null); setCheck(null); setCancel(null); }} />
    </>}
  </section>;
}

function DraftDetail({ unitId, id }: { unitId: string | null; id: string }) {
  const { client } = useAuth();
  const [data, retry] = useLoad(`draft:${id}`, () => transferApi.get(client, unitId, id));
  if (data.kind === 'loading') return <p role="status">Memuat rincian draf…</p>;
  if (data.kind === 'error') return <><Alert tone="error" message={data.message} /><button type="button" className="btn btn-secondary" onClick={retry}>Coba lagi</button></>;
  return <div><p className="muted">Data berkas saat draf dibuat:</p><ul>
    {data.data.map((r) => <li key={r.berkas_id}>{r.number} — {r.title} · {formatNumber(r.item_count)} item · batas aktif {formatDate(r.batas_aktif, '—')}{r.location ? ` · ${r.location}` : ''}</li>)}
  </ul></div>;
}

function DraftCheck({ unitId, id }: { unitId: string | null; id: string }) {
  const { client } = useAuth();
  const [attempt, setAttempt] = useState(0);
  const [data] = useLoad(`draft-check:${id}:${attempt}`, () => transferApi.check(client, unitId, id));
  if (data.kind === 'loading') return <p role="status">Memeriksa kelayakan berkas…</p>;
  return <div className="stack">
    {data.kind === 'error' ? <Alert tone="error" message={data.message} />
      : data.data.eligible ? <Alert tone="success">Berkas lolos pemeriksaan. Dokumen dan pengiriman belum disiapkan.</Alert>
      : <>
        <Alert tone="warning">Draf belum siap diajukan. Tinjau berkas berikut.</Alert>
        <ul>{data.data.issues.map((issue) =>
          <li key={issue.berkas_id}>Berkas {issue.number}: {issue.reason}</li>)}</ul>
      </>}
    <div><button type="button" className="btn btn-secondary" onClick={() => setAttempt((n) => n + 1)}>Periksa Ulang</button></div>
  </div>;
}

function CancelDraft({ unitId, draft, done }: { unitId: string | null; draft: TransferDraft; done: () => void }) {
  const { client } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  const lock = useRef(false);
  const request = useRequest();
  async function cancel(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (lock.current) return;
    const reason = String(new FormData(e.currentTarget).get('reason') ?? '').trim();
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await transferApi.cancel(client, unitId, draft.id, reason, request(reason));
      done();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return <form className="stack retention-cancel" onSubmit={cancel}>
    <label className="retention-field">Alasan pembatalan {draft.draft_number}<textarea required minLength={3} maxLength={1000} name="reason" disabled={busy} /></label>
    {error && <Alert tone="error" message={error} />}
    <button className="btn btn-secondary" type="submit" disabled={busy}>{busy ? 'Membatalkan…' : 'Ya, Batalkan Draf'}</button>
  </form>;
}
