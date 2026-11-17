import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth, useProfile } from '../../auth/AuthContext';
import { Alert } from '../../components/Alert';
import { PageHeader } from '../../components/PageHeader';
import { newRequestId } from '../../lib/api';
import { loanApi, type Loan, type LoanAsset, type LoanBerkas } from '../../lib/loanApi';
import { useLoad } from '../../lib/useLoad';
import { errorMessage, NeedsUnit, useWriteUnit } from '../s2/common';
import './loan.css';

const CONDITIONS = ['BAIK', 'RUSAK RINGAN', 'RUSAK SEDANG', 'RUSAK BERAT'];
const jakartaToday = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Jakarta' }).format(new Date());
const text = (data: FormData, name: string) => String(data.get(name) ?? '').trim();
type Picked = { berkas: LoanBerkas; items: LoanAsset[] }; // No items means the whole berkas.
type Message = ReturnType<typeof errorMessage>;

function useAttempt() {
  const attempt = useRef<{ body: string; id: string } | null>(null);
  return (payload: unknown) => {
    const body = JSON.stringify(payload);
    if (attempt.current?.body !== body) attempt.current = { body, id: newRequestId() };
    return attempt.current.id;
  };
}
function Labeled({ children, title }: { children: ReactNode; title: string }) {
  return <label className="loan-field"><span>{title}</span>{children}</label>;
}
function Condition({ title }: { title: string }) {
  return <Labeled title={title}><select name="condition" required defaultValue="BAIK">
    {CONDITIONS.map((k) => <option key={k}>{k}</option>)}
  </select></Labeled>;
}
function Officer({ defaultName }: { defaultName: string }) {
  return <>
    <Labeled title="Nama petugas Central File"><input name="officer_name" required maxLength={250} defaultValue={defaultName} /></Labeled>
    <Labeled title="Jabatan petugas"><input name="officer_position" required maxLength={250} /></Labeled>
    <Labeled title="NIP petugas (opsional)"><input name="officer_identity" maxLength={100} /></Labeled>
  </>;
}

export function LoansPage() {
  const { unitId, needsUnit } = useWriteUnit();
  return <>
    <PageHeader title="Peminjaman Arsip" subtitle="Catat peminjaman dan pengembalian beberapa berkas atau item dalam satu transaksi." />
    {needsUnit ? <NeedsUnit /> : <LoansScreen key={unitId ?? 'own'} unitId={unitId} />}
  </>;
}

function LoansScreen({ unitId }: { unitId: string | null }) {
  const { client } = useAuth();
  const [status, setStatus] = useState<'ACTIVE' | 'RETURNED'>('ACTIVE');
  const [offset, setOffset] = useState(0);
  const [list, reload] = useLoad(`loans:${status}:${offset}`, () => loanApi.list(client, unitId, status, offset));
  const [result, setResult] = useState('');
  const [adding, setAdding] = useState(false);
  const [returning, setReturning] = useState<Loan | null>(null);
  const [printing, setPrinting] = useState<Loan | null>(null);
  const [printBusy, setPrintBusy] = useState<string | null>(null);
  const [printError, setPrintError] = useState<Message | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [printRevision, setPrintRevision] = useState(0);
  const printLock = useRef(false);
  const printAttempt = useAttempt();

  async function openOutIndicator(loan: Loan) {
    if (printLock.current || printing) return;
    printLock.current = true;
    setPrintError(null);
    setPrintBusy(loan.id);
    try {
      // Keep the same key when the request times out; a deliberate later print is a new event.
      await loanApi.openOutIndicator(client, unitId, loan.id, printAttempt(loan.id));
      printAttempt(null);
      setPrintRevision((r) => r + 1);
      setPrinting(loan);
    } catch (err) {
      setPrintError(errorMessage(err));
    } finally {
      printLock.current = false;
      setPrintBusy(null);
    }
  }

  function saved(msg: string) {
    setResult(msg);
    setAdding(false);
    setReturning(null);
    setStatus('ACTIVE');
    setHistoryId(null);
    setPrinting(null);
    setOffset(0);
    reload();
  }

  return <>
    <div className="no-print stack loan-screen">
      {result && <Alert tone="success">{result}</Alert>}
      <div className="loan-actions">
        <button type="button" className="btn btn-primary" onClick={() => { setAdding((v) => !v); setReturning(null); setResult(''); }}>
          {adding ? 'Tutup formulir' : 'Catat Peminjaman'}
        </button>
        <Link className="btn btn-secondary" to={`/dashboard/dipinjam${unitId ? `?unit=${encodeURIComponent(unitId)}` : ''}`}>Lihat berkas berstatus dipinjam</Link>
      </div>
      <Alert tone="info">Daftar ini mencakup pinjaman yang dicatat di v4 dan pinjaman lama yang sudah dipindahkan. Jika berkas berstatus dipinjam tetapi transaksinya belum terlihat, laporkan ke admin agar riwayatnya dicocokkan.</Alert>
      {adding && <BorrowForm unitId={unitId} onSaved={() => saved('Peminjaman tersimpan.')} />}
      {returning && <ReturnForm key={returning.id} unitId={unitId} loan={returning} onCancel={() => setReturning(null)}
        onSaved={() => saved('Seluruh arsip dalam transaksi sudah dikembalikan.')} />}
      <section className="card stack loan-section" aria-label="Pelacakan peminjaman">
        <h2 className="section-title">Pelacakan Peminjaman</h2>
        <div className="loan-actions">
          {(['ACTIVE', 'RETURNED'] as const).map((s) => <button type="button" className="btn btn-secondary" aria-pressed={status === s}
            key={s} disabled={!!printBusy} onClick={() => { setStatus(s); setOffset(0); setHistoryId(null); setPrinting(null); }}>{s === 'ACTIVE' ? 'Sedang dipinjam' : 'Sudah kembali'}</button>)}
        </div>
        {printError && <Alert tone="error" message={printError} />}
        {list.kind === 'loading' && <p role="status">Memuat transaksi…</p>}
        {list.kind === 'error' && <><Alert tone="error" message={list.message} /><button type="button" className="btn btn-secondary" onClick={reload}>Muat ulang</button></>}
        {list.kind === 'ok' && <>
          {!list.data.length && <p className="muted">Belum ada transaksi pada halaman ini.</p>}
          {list.data.map((loan) => <article key={loan.id} className="loan-record">
            <h3>{loan.borrower_name} · {loan.borrower_unit}</h3>
            <p>{loan.purpose} · {loan.page_count} lembar</p>
            <p className="muted">Pinjam {loan.borrowed_on} · {loan.returned_on ? `Kembali ${loan.returned_on}` : `Wajib kembali ${loan.due_on}`}</p>
            <details>
              <summary>Rincian {loan.objects.length} objek</summary>
              <ul>{loan.objects.map((o) => <li key={o.item_id ?? o.berkas_id}>Berkas {o.berkas_no} — {o.berkas_title}
                {o.item_id ? ` / Item ${o.item_no ?? '—'}: ${o.item_description ?? '—'}` : ' (lengkap)'} · {o.location}</li>)}</ul>
            </details>
            <div className="loan-actions">
              {!loan.returned_on && <button type="button" className="btn btn-primary" onClick={() => { setReturning(loan); setAdding(false); setResult(''); }}>Catat Pengembalian</button>}
              <button type="button" className="btn btn-secondary" disabled={!!printBusy || !!printing} onClick={() => void openOutIndicator(loan)}>
                {printBusy === loan.id ? 'Menyiapkan cetak…' : 'Cetak Out Indicator A5'}
              </button>
              <button type="button" className="btn btn-secondary" aria-expanded={historyId === loan.id}
                onClick={() => setHistoryId(historyId === loan.id ? null : loan.id)}>
                {historyId === loan.id ? 'Tutup Riwayat Dokumen' : 'Riwayat Dokumen'}
              </button>
            </div>
            {printing?.id === loan.id && <section className="stack" aria-label="Out Indicator siap dicetak">
              <p role="status">Out Indicator A5 siap. Cetak atau simpan PDF dari dialog browser.</p>
              <div className="loan-actions">
                <button type="button" className="btn btn-primary" onClick={() => window.print()}>Buka Dialog Cetak</button>
                <button type="button" className="btn btn-secondary" onClick={() => setPrinting(null)}>Tutup Cetak</button>
              </div>
            </section>}
            {historyId === loan.id && <DocumentHistory unitId={unitId} loanId={loan.id} revision={printRevision} />}
          </article>)}
          <div className="loan-actions">
            {offset > 0 && <button type="button" className="btn btn-secondary" disabled={!!printBusy} onClick={() => { setOffset((o) => o - 25); setPrinting(null); }}>Sebelumnya</button>}
            {list.data.length === 25 && <button type="button" className="btn btn-secondary" disabled={!!printBusy} onClick={() => { setOffset((o) => o + 25); setPrinting(null); }}>Berikutnya</button>}
          </div>
        </>}
      </section>
    </div>
    {printing && <OutIndicator loan={printing} />}
  </>;
}

const documentTime = new Intl.DateTimeFormat('id-ID', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta',
});

function DocumentHistory({ unitId, loanId, revision }: { unitId: string | null; loanId: string; revision: number }) {
  const { client } = useAuth();
  const [offset, setOffset] = useState(0);
  const [history, reload] = useLoad(`loan-history:${loanId}:${offset}:${revision}`,
    () => loanApi.documentHistory(client, unitId, loanId, offset));
  return <section className="stack" aria-label="Riwayat dokumen peminjaman">
    {history.kind === 'loading' && <p role="status">Memuat riwayat dokumen…</p>}
    {history.kind === 'error' && <><Alert tone="error" message={history.message} />
      <button className="btn btn-secondary" type="button" onClick={reload}>Muat ulang riwayat</button></>}
    {history.kind === 'ok' && <>
      {history.data.length === 0 && <p className="muted">Belum ada riwayat dokumen pada halaman ini.</p>}
      <ul>{history.data.map((event) => {
        const title = event.action === 'OUT_INDICATOR_OPEN' ? 'Out Indicator disiapkan untuk cetak'
          : event.action === 'LEGACY_OUT_INDICATOR' ? 'Out Indicator (aplikasi lama)' : 'Berita Acara (aplikasi lama)';
        const source = event.source_status === 'PDF_DIBUAT' ? 'PDF dibuat'
          : event.source_status === 'DOCS_DIBUAT' ? 'Google Docs dibuat' : event.source_status === 'DICETAK' ? 'Tercatat dicetak' : '';
        return <li key={event.id}>{title}{source && ` · ${source}`}
          {' · '}<time dateTime={event.occurred_at}>{documentTime.format(new Date(event.occurred_at))} WIB</time>
          {event.actor_name && ` · ${event.actor_name}`}</li>;
      })}</ul>
      <div className="loan-actions">
        {offset > 0 && <button className="btn btn-secondary" type="button" onClick={() => setOffset((n) => n - 25)}>Riwayat sebelumnya</button>}
        {history.data.length === 25 && <button className="btn btn-secondary" type="button" onClick={() => setOffset((n) => n + 25)}>Riwayat berikutnya</button>}
      </div>
    </>}
  </section>;
}

function BorrowForm({ unitId, onSaved }: { unitId: string | null; onSaved: () => void }) {
  const { client } = useAuth();
  const { profile } = useProfile();
  const [query, setQuery] = useState('');
  const [applied, setApplied] = useState('');
  const [parent, setParent] = useState('');
  const [picks, setPicks] = useState<Picked[]>([]);
  const [all, repeatAll] = useLoad(`loan-options:${applied}`, () => loanApi.options(client, unitId, applied, null));
  const [detail, repeatDetail] = useLoad(`loan-items:${parent}`, () => parent ? loanApi.options(client, unitId, '', parent) : Promise.resolve([]));
  const request = useAttempt();
  const [error, setError] = useState<Message | null>(null);
  const [selectionError, setSelectionError] = useState('');
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [customPages, setCustomPages] = useState('');
  const total = picks.reduce((sum, p) => sum + (p.items.length || 1), 0);
  const pages = picks.reduce((sum, p) => sum + (p.items.length ? p.items.reduce((n, i) => n + i.pages, 0) : p.berkas.pages), 0);
  const berkas = detail.kind === 'ok' ? detail.data[0] : undefined;
  const existing = picks.find((p) => p.berkas.id === berkas?.id);
  const allAvailable = !!berkas && berkas.items.every((i) => i.status === 'TERSEDIA');

  function add(b: LoanBerkas, item?: LoanAsset) {
    const match = picks.find((p) => p.berkas.id === b.id);
    if (total >= 100 || (match && (!item || !match.items.length || match.items.some((i) => i.id === item.id)))) {
      setSelectionError('Pilihan sudah ada, bertumpang tindih, atau melebihi batas 100 objek.');
      return;
    }
    setPicks(match ? picks.map((p) => p === match ? { ...p, items: [...p.items, item!] } : p)
      : [...picks, { berkas: b, items: item ? [item] : [] }]);
    setSelectionError('');
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (lock.current) return;
    if (!total) { setSelectionError('Tambahkan minimal satu berkas atau item.'); return; }
    const f = new FormData(e.currentTarget);
    const choices = picks.map((p) => ({ berkas_id: p.berkas.id, item_ids: p.items.map((i) => i.id) }));
    const borrower = Object.fromEntries(['name', 'position', 'unit', 'identity', 'whatsapp', 'officer_name', 'officer_position', 'officer_identity'].map((k) => [k, text(f, k)]));
    const body = { p_purpose: text(f, 'purpose'), p_notes: text(f, 'notes'), p_borrowed_on: text(f, 'borrowed_on'),
      p_due_on: text(f, 'due_on'), p_condition: text(f, 'condition'), p_page_count: Number(text(f, 'pages')) };
    lock.current = true;
    setBusy(true);
    setError(null);
    try { await loanApi.create(client, unitId, borrower, choices, body, request([borrower, choices, body])); onSaved(); }
    catch (err) { setError(errorMessage(err)); repeatAll(); repeatDetail(); }
    finally { lock.current = false; setBusy(false); }
  }

  return <section className="card stack loan-section" aria-label="Formulir peminjaman">
    <h2 className="section-title">Catat Peminjaman Baru</h2>
    <form className="loan-actions" onSubmit={(e) => { e.preventDefault(); setParent(''); setApplied(query.trim()); }}>
      <Labeled title="Cari nomor atau judul berkas"><input value={query} onChange={(e) => setQuery(e.target.value)} maxLength={200} /></Labeled>
      <button type="submit" className="btn btn-secondary">Cari Berkas</button>
    </form>
    {all.kind === 'loading' && <p role="status">Memuat berkas…</p>}
    {all.kind === 'error' && <><Alert tone="error" message={all.message} /><button type="button" className="btn btn-secondary" onClick={repeatAll}>Muat ulang berkas</button></>}
    {all.kind === 'ok' && <Labeled title="Pilih berkas (maksimal 30 hasil per pencarian)">
      <select value={parent} onChange={(e) => setParent(e.target.value)}>
        <option value="">{all.data.length ? '— Pilih berkas —' : 'Tidak ada berkas yang cocok'}</option>
        {all.data.map((b) => <option key={b.id} value={b.id}>{b.number} — {b.title}</option>)}
      </select>
    </Labeled>}
    {parent && detail.kind === 'loading' && <p role="status">Memuat item…</p>}
    {detail.kind === 'error' && <><Alert tone="error" message={detail.message} /><button type="button" className="btn btn-secondary" onClick={repeatDetail}>Muat ulang item</button></>}
    {berkas && <div className="stack">
      <button type="button" className="btn btn-secondary" disabled={!!existing || !allAvailable || berkas.status !== 'TERSEDIA' || busy} onClick={() => add(berkas)}>Tambah Berkas Lengkap</button>
      {berkas.items.map((i) => <button type="button" className="btn btn-secondary loan-item" key={i.id}
        disabled={i.status !== 'TERSEDIA' || (berkas.status !== 'TERSEDIA' && berkas.status !== 'SEBAGIAN DIPINJAM') || !!(existing && (!existing.items.length || existing.items.some((x) => x.id === i.id))) || busy}
        onClick={() => add(berkas, i)}>Tambah item {i.number ?? '—'} — {i.title || 'Tanpa uraian'}{i.status !== 'TERSEDIA' ? ` (${i.status})` : ''}</button>)}
    </div>}
    <div className="stack" aria-label="Daftar arsip yang akan dipinjam">
      <strong>Daftar Pinjam · {total} objek</strong>
      {picks.map((p) => <div className="loan-record" key={p.berkas.id}>
        <strong>Berkas {p.berkas.number} — {p.berkas.title}</strong>
        {!p.items.length && <p>Berkas lengkap</p>}
        {p.items.map((i) => <div className="loan-actions" key={i.id}>
          <span>Item {i.number ?? '—'} — {i.title}</span>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setPicks((prev) => p.items.length === 1
            ? prev.filter((x) => x !== p)
            : prev.map((x) => x === p ? { ...x, items: x.items.filter((item) => item.id !== i.id) } : x))}>Hapus item {i.number ?? '—'}</button>
        </div>)}
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setPicks((prev) => prev.filter((x) => x !== p))}>Hapus berkas {p.berkas.number}</button>
      </div>)}
    </div>
    {selectionError && <Alert tone="error">{selectionError}</Alert>}
    <form className="stack" onSubmit={submit}>
      <fieldset className="loan-fields" disabled={busy} aria-label="Data peminjaman">
        <Labeled title="Nama peminjam"><input name="name" maxLength={250} required /></Labeled>
        <Labeled title="Jabatan peminjam"><input name="position" maxLength={250} required /></Labeled>
        <Labeled title="Unit kerja peminjam"><input name="unit" maxLength={250} required /></Labeled>
        <Labeled title="NIP/NIK peminjam (opsional)"><input name="identity" maxLength={100} /></Labeled>
        <Labeled title="WhatsApp (opsional)"><input name="whatsapp" type="tel" maxLength={50} /></Labeled>
        <Officer defaultName={profile.full_name} />
        <Labeled title="Tanggal pinjam"><input name="borrowed_on" type="date" required max={jakartaToday()} defaultValue={jakartaToday()} /></Labeled>
        <Labeled title="Tanggal wajib kembali"><input name="due_on" type="date" required /></Labeled>
        <Condition title="Kondisi saat dipinjam" />
        <Labeled title="Jumlah lembar"><input name="pages" type="number" required min={1} value={customPages || pages || ''} onChange={(e) => setCustomPages(e.target.value)} /></Labeled>
        <Labeled title="Keperluan"><textarea name="purpose" maxLength={1000} required /></Labeled>
        <Labeled title="Catatan (opsional)"><textarea name="notes" maxLength={2000} /></Labeled>
      </fieldset>
      {error && <Alert tone="error" message={error} />}
      <button className="btn btn-primary" type="submit" disabled={!total || busy}>{busy ? 'Menyimpan…' : 'Simpan Peminjaman'}</button>
    </form>
  </section>;
}

function ReturnForm({ unitId, loan, onSaved, onCancel }: { unitId: string | null; loan: Loan; onSaved: () => void; onCancel: () => void }) {
  const { client } = useAuth();
  const { profile } = useProfile();
  const request = useAttempt();
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Message | null>(null);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (lock.current) return;
    const f = new FormData(e.currentTarget);
    const officer = { name: text(f, 'officer_name'), position: text(f, 'officer_position'), identity: text(f, 'officer_identity') };
    const body = { p_returned_on: text(f, 'returned_on'), p_condition: text(f, 'condition'), p_notes: text(f, 'notes') };
    lock.current = true;
    setBusy(true);
    setError(null);
    try { await loanApi.return(client, unitId, loan.id, officer, body, request([officer, body])); onSaved(); }
    catch (err) { setError(errorMessage(err)); }
    finally { lock.current = false; setBusy(false); }
  }
  return <section className="card stack loan-section" aria-label="Formulir pengembalian">
    <h2 className="section-title">Catat Pengembalian</h2>
    <p>Seluruh {loan.objects.length} objek yang dipinjam <strong>{loan.borrower_name}</strong> akan dikembalikan.</p>
    <form className="stack" onSubmit={submit}>
      <fieldset className="loan-fields" disabled={busy} aria-label="Data pengembalian">
        <Labeled title="Tanggal kembali"><input name="returned_on" type="date" required min={loan.borrowed_on} max={jakartaToday()} defaultValue={jakartaToday()} /></Labeled>
        <Condition title="Kondisi saat kembali" />
        <Officer defaultName={profile.full_name} />
        <Labeled title="Catatan pengembalian (opsional)"><textarea name="notes" maxLength={2000} /></Labeled>
      </fieldset>
      {error && <Alert tone="error" message={error} />}
      <div className="loan-actions"><button className="btn btn-primary" disabled={busy} type="submit">{busy ? 'Menyimpan…' : 'Simpan Pengembalian'}</button>
        <button className="btn btn-secondary" disabled={busy} type="button" onClick={onCancel}>Tutup</button></div>
    </form>
  </section>;
}

function OutIndicator({ loan }: { loan: Loan }) {
  const groups = new Map<string, Loan['objects']>();
  for (const object of loan.objects) groups.set(object.berkas_id, [...(groups.get(object.berkas_id) ?? []), object]);
  return <div className="loan-print" aria-hidden="true">{[...groups.values()].map((objects, index) => {
    const b = objects[0]!;
    const compact = objects.length > 12;
    return <section className="loan-print-page" key={b.berkas_id}>
      <h1>OUT INDICATOR</h1>
      <p>Central File · UIN Sunan Ampel Surabaya</p>
      <p>Lembar berkas {index + 1} dari {groups.size}</p>
      <h2>Berkas {b.berkas_no} — {b.berkas_title}</h2>
      <p><strong>Lokasi asal:</strong> {b.location}</p>
      <p><strong>Peminjam:</strong> {loan.borrower_name} · {loan.borrower_unit}</p>
      <p><strong>Pinjam:</strong> {loan.borrowed_on} · <strong>Wajib kembali:</strong> {loan.due_on}</p>
      <p><strong>Keperluan:</strong> {loan.purpose}</p>
      <ul className={compact ? 'loan-print-compact' : undefined}>{objects.map((o) => <li key={o.item_id ?? o.berkas_id}>{o.item_id ? `Item ${o.item_no ?? '—'}${compact ? '' : ` — ${(o.item_description ?? '—').slice(0, 90)}`}` : 'Berkas lengkap'}{!compact && ` (${o.page_count} lembar)`}</li>)}</ul>
      <p>Petugas: {loan.officer_name}</p>
    </section>;
  })}</div>;
}
