import { useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { Alert } from '../../components/Alert';
import { PageHeader } from '../../components/PageHeader';
import { isBusinessError } from '../../lib/api';
import type { UserMessage } from '../../lib/errors';
import { formatDate } from '../../lib/format';
import { runDriveTasks, type Condition, type DevelopmentLevel, type Security } from '../../lib/s2api';
import { cancelUploadSession, s3, type ChangedField, type EditBerkas, type EditItem, type EditOptions, type ItemEditPayload, type ItemUpdateResult, type TitleUpdateResult } from '../../lib/s3api';
import { percent, STAGE_LABELS, uploads, useUploads } from '../../lib/uploadStore';
import { useLoad } from '../../lib/useLoad';
import { CONDITION_LABEL, DEV_LABEL, errorMessage, NeedsUnit, SECURITY_LABEL, useGetToken, useWriteUnit } from '../s2/common';
import { FilePicker, loanLabel, MIN_REASON, Picker, ReasonField, useRequestKey, type PickOption } from './editShared';

export const FIELD_LABEL: Record<ChangedField, string> = {
  description: 'Uraian',
  page_count: 'Jumlah halaman',
  document_date: 'Tanggal naskah',
  development_level: 'Tingkat perkembangan',
  condition: 'Kondisi fisik',
  security_classification: 'Klasifikasi keamanan',
  pdf: 'File PDF',
};

interface Before { berkasNumber: number | null; itemNumber: number | null; berkasSecurity: Security | null }

function changedFields(item: EditItem, p: ItemEditPayload): ChangedField[] {
  const out: ChangedField[] = [];
  if (p.description !== item.description.trim()) out.push('description');
  if (p.page_count !== item.page_count) out.push('page_count');
  if (p.document_date !== (item.document_date ?? '')) out.push('document_date');
  if (p.development_level !== (item.development_level ?? 'ASLI')) out.push('development_level');
  if (p.condition !== (item.condition ?? '')) out.push('condition');
  if (p.security_classification !== item.security_classification) out.push('security_classification');
  return out;
}

function ItemResult({ result, before, onClose }: { result: ItemUpdateResult; before: Before; onClose(): void }) {
  const itemMoved = before.itemNumber !== null && result.item_number !== null && before.itemNumber !== result.item_number;
  const berkasMoved = before.berkasNumber !== null && result.berkas_number !== null && before.berkasNumber !== result.berkas_number;
  return (
    <section className="result-box" aria-label="Hasil perubahan">
      <h2>{result.message || 'Perubahan tersimpan.'}</h2>
      {result.replayed ? <p className="muted small">Permintaan ini sudah pernah diproses; hasil sebelumnya ditampilkan tanpa mengubah data lagi.</p> : null}
      <ul className="result-list">
        <li>Yang berubah: {result.changed_fields.length ? result.changed_fields.map((f) => FIELD_LABEL[f] ?? f).join(', ') : '–'}.</li>
        <li>Posisi sekarang: Berkas {result.berkas_number ?? '–'} / Item {result.item_number ?? '–'}.</li>
        {itemMoved ? <li>Nomor item berubah: {before.itemNumber} → {result.item_number}.</li> : null}
        {berkasMoved ? <li>Nomor berkas berubah: {before.berkasNumber} → {result.berkas_number}.</li> : null}
        {result.renumbered_item_count > 0 || result.renumbered_berkas_count > 0 ? (
          <li>Penomoran ulang kronologis: {result.renumbered_item_count} item dan {result.renumbered_berkas_count} berkas.</li>
        ) : null}
        {result.berkas_security_classification && before.berkasSecurity && result.berkas_security_classification !== before.berkasSecurity ? (
          <li>Klasifikasi keamanan berkas kini {SECURITY_LABEL[result.berkas_security_classification] ?? result.berkas_security_classification} (mengikuti item paling ketat).</li>
        ) : null}
        {result.file_replaced ? <li>PDF diganti. Versi lama dipindahkan ke karantina (hanya Admin yang dapat melihatnya).</li> : null}
        {result.warnings.map((w, i) => <li key={i}>Peringatan: {w}</li>)}
      </ul>
      <div className="action-row">
        <Link className="btn btn-secondary" to={`/cari/item/${encodeURIComponent(result.item_id)}`}>Lihat detail arsip</Link>
        <button type="button" className="btn btn-secondary" onClick={onClose}>Tutup</button>
      </div>
    </section>
  );
}

type Stage = 'idle' | 'validating' | 'uploading' | 'saving';

function ItemForm({ berkas, item, options, unitId, onSaved }: { berkas: EditBerkas; item: EditItem; options: EditOptions; unitId: string | null; onSaved(r: ItemUpdateResult, b: Before): void }) {
  const { client } = useAuth();
  const getToken = useGetToken();
  const jobs = useUploads();
  const ids = { d: useId(), p: useId(), t: useId(), dev: useId(), c: useId(), s: useId() };
  const [description, setDescription] = useState(item.description);
  const [pageCount, setPageCount] = useState(String(item.page_count ?? ''));
  const [date, setDate] = useState(item.document_date ?? '');
  const [dev, setDev] = useState<DevelopmentLevel>(item.development_level ?? 'ASLI');
  const [cond, setCond] = useState<'' | Condition>(item.condition ?? '');
  const [sec, setSec] = useState<'' | Security>(item.security_classification ?? '');
  const [reason, setReason] = useState('');
  const [file, setFileState] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [stage, setStage] = useState<Stage>('idle');
  const [error, setError] = useState<UserMessage | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const inFlight = useRef(false);
  const committed = useRef<{ file: File; sessionId: string } | null>(null);
  const rid = useRequestKey();
  const job = jobs.find((j) => j.id === jobId);
  const busy = stage !== 'idle';

  function setFile(f: File | null) {
    if (committed.current) {
      cancelUploadSession(getToken, committed.current.sessionId);
      committed.current = null;
    }
    setFileState(f);
    setError(null);
  }

  function buildPayload(): ItemEditPayload | null {
    const n = Number(pageCount);
    if (!description.trim() || !Number.isInteger(n) || n < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !sec) return null;
    return { berkas_id: berkas.id, description: description.trim(), page_count: n, document_date: date, development_level: dev, condition: cond, security_classification: sec };
  }

  function validate(): UserMessage | null {
    if (!description.trim()) return { title: 'Uraian wajib diisi.', action: 'Tuliskan uraian informasi arsip.' };
    const n = Number(pageCount);
    if (!Number.isInteger(n) || n < 1) return { title: 'Jumlah halaman harus bilangan bulat minimal 1.', action: 'Perbaiki jumlah halaman.' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { title: 'Tanggal naskah wajib diisi.', action: 'Pilih tanggal naskah yang valid.' };
    if (!sec) return { title: 'Klasifikasi keamanan wajib dipilih.', action: 'Pilih salah satu klasifikasi keamanan dan akses.' };
    if (reason.trim().length < MIN_REASON) return { title: `Alasan minimal ${MIN_REASON} karakter.`, action: 'Tuliskan alasan perubahan dengan jelas.' };
    if (file) {
      if (!/\.pdf$/i.test(file.name)) return { title: 'File pengganti harus PDF.', action: 'Pilih file berekstensi .pdf.' };
      if (file.size < 1 || file.size > options.replacement_max_bytes) return { title: 'PDF pengganti harus kurang dari 100 MB.', action: 'Kompres PDF atau pilih file lain.' };
    }
    return null;
  }

  async function finish(sessionId: string | null, payload: ItemEditPayload) {
    setStage('saving');
    try {
      const sig = JSON.stringify([item.id, payload, reason.trim(), sessionId]);
      const { data } = await s3.itemUpdate(client, rid.idFor(sig), item.id, payload, reason.trim(), sessionId);
      rid.clear();
      committed.current = null;
      if (data.drive_tasks?.length) runDriveTasks(getToken, unitId);
      onSaved(data, { berkasNumber: berkas.number, itemNumber: item.number, berkasSecurity: berkas.security_classification });
      setStage('idle');
      inFlight.current = false;
    } catch (e) {
      if (isBusinessError(e)) rid.clear();
      setError(errorMessage(e));
      setStage('idle');
      inFlight.current = false;
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    const problem = validate();
    if (problem) return setError(problem);
    const payload = buildPayload()!;
    if (!file && changedFields(item, payload).length === 0) {
      return setError({ title: 'Tidak ada perubahan yang perlu disimpan.', action: 'Ubah minimal satu isian atau pilih PDF pengganti.' });
    }
    setError(null);
    inFlight.current = true;
    if (!file) return void finish(null, payload);
    if (committed.current?.file === file) return void finish(committed.current.sessionId, payload);
    setStage('validating');
    try {
      await s3.itemValidate(client, item.id, payload, reason.trim());
    } catch (err) {
      setError(errorMessage(err));
      setStage('idle');
      inFlight.current = false;
      return;
    }
    setStage('uploading');
    const label = `PDF pengganti Berkas ${berkas.number ?? '–'} / Item ${item.number ?? '–'}`;
    const id = uploads.start(
      { purpose: 'ITEM_PDF_REPLACE', objectId: item.id, file, fileName: file.name, mime: 'application/pdf', unitId },
      label,
      (r) => {
        committed.current = { file, sessionId: r.sessionId };
        void finish(r.sessionId, payload);
      },
    );
    setJobId(id);
  }

  function cancelUpload() {
    if (jobId) uploads.abort(jobId);
    setStage('idle');
    inFlight.current = false;
    setJobId(null);
  }

  const uploadFailed = stage === 'uploading' && Boolean(job?.error);
  const statusText =
    stage === 'validating' ? 'Memeriksa isian di server…'
    : stage === 'uploading' && job ? `${STAGE_LABELS[job.progress.stage]}${job.progress.stage === 'mengunggah' ? ` ${percent(job.progress)}%` : ''} (metadata disimpan setelah PDF terunggah)`
    : stage === 'saving' ? 'Menyimpan perubahan…' : '';

  return (
    <form className="card stack" onSubmit={(e) => void submit(e)} noValidate>
      <div className="readonly-box">
        <strong>Berkas {berkas.number ?? '–'}: {berkas.title}</strong>
        <div>Klasifikasi: {berkas.classification_code ?? '–'}{berkas.classification_description ? ` – ${berkas.classification_description}` : ''}</div>
        <div>No. surat: {item.primary_letter_number || item.alternate_letter_number || '–'}</div>
        <small className="muted">Nomor surat, berkas, klasifikasi arsip, dan retensi tidak dapat diubah di sini.</small>
      </div>
      <div className="field">
        <label htmlFor={ids.d}>Uraian informasi arsip *</label>
        <textarea id={ids.d} rows={4} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} disabled={busy} />
      </div>
      <div className="form-grid-2">
        <div className="field">
          <label htmlFor={ids.t}>Tanggal naskah *</label>
          <input id={ids.t} type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={busy} />
        </div>
        <div className="field">
          <label htmlFor={ids.p}>Jumlah halaman *</label>
          <input id={ids.p} type="number" inputMode="numeric" min={1} step={1} value={pageCount} onChange={(e) => setPageCount(e.target.value)} disabled={busy} />
        </div>
        <div className="field">
          <label htmlFor={ids.dev}>Tingkat perkembangan *</label>
          <select id={ids.dev} value={dev} onChange={(e) => setDev(e.target.value as DevelopmentLevel)} disabled={busy}>
            {options.development_levels.map((v) => <option key={v} value={v}>{DEV_LABEL[v] ?? v}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={ids.c}>Kondisi fisik</label>
          <select id={ids.c} value={cond} onChange={(e) => setCond(e.target.value as '' | Condition)} disabled={busy}>
            <option value="">Tidak dicatat</option>
            {options.conditions.map((v) => <option key={v} value={v}>{CONDITION_LABEL[v] ?? v}</option>)}
          </select>
        </div>
        <div className="field span-all">
          <label htmlFor={ids.s}>Klasifikasi keamanan dan akses *</label>
          <select id={ids.s} value={sec} onChange={(e) => setSec(e.target.value as '' | Security)} disabled={busy} aria-invalid={!sec ? true : undefined}>
            {!sec ? <option value="">Pilih klasifikasi keamanan</option> : null}
            {options.security_classifications.map((v) => <option key={v} value={v}>{SECURITY_LABEL[v] ?? v}</option>)}
          </select>
          <small className="field-hint">Tidak pernah diisi otomatis. Klasifikasi keamanan berkas mengikuti item paling ketat.</small>
        </div>
      </div>
      <p className="muted small">File saat ini: {item.has_file ? (item.file_name ?? 'ada') : 'belum ada PDF'}.</p>
      <FilePicker key={fileKey} label="Ganti PDF alih media (opsional)" accept="application/pdf,.pdf" file={file} onChange={setFile} disabled={busy}
        hint="Kosongkan bila file tidak berubah. Harus PDF kurang dari 100 MB. Bila diisi, isian lain tidak perlu diubah; PDF lama dipindahkan ke karantina." />
      {file ? <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => { setFile(null); setFileKey((k) => k + 1); }}>Hapus pilihan PDF</button> : null}
      <ReasonField label="Alasan perubahan *" value={reason} onChange={setReason} placeholder="Contoh: Jumlah halaman disesuaikan setelah satu lembar diserahkan kepada vendor…" hint="Dicatat permanen di Master Log." />
      {error ? <Alert tone="error" message={error} /> : null}
      {uploadFailed && job?.error ? <Alert tone="error" message={job.error} /> : null}
      <div className="form-actions-bar">
        <span className="save-stage" role="status" aria-live="polite">{statusText}</span>
        {stage === 'uploading' ? <button type="button" className="btn btn-secondary" onClick={cancelUpload}>Batalkan unggahan</button> : null}
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Memproses…' : 'Simpan Perubahan'}</button>
      </div>
    </form>
  );
}

function itemOptions(berkas: EditBerkas[]): PickOption[] {
  return berkas.flatMap((b) =>
    b.items.map((i): PickOption => ({
      id: i.id,
      title: `Item ${i.number ?? '–'} — ${i.description}`,
      sub: `${formatDate(i.document_date)} · ${i.page_count ?? '–'} lembar${i.has_file ? ' · ada PDF' : ' · belum ada PDF'}`,
      group: `Berkas ${b.number ?? 'draf'} — ${b.title}`,
      disabledReason: i.can_edit ? undefined : loanLabel(i.loan_status) || 'Tidak dapat diubah saat ini',
    })),
  );
}

function ItemEditor({ options, unitId, reload }: { options: EditOptions; unitId: string | null; reload(): void }) {
  const [itemId, setItemId] = useState('');
  const [result, setResult] = useState<{ r: ItemUpdateResult; before: Before } | null>(null);
  const opts = useMemo(() => itemOptions(options.berkas), [options.berkas]);
  const berkas = options.berkas.find((b) => b.items.some((i) => i.id === itemId));
  const item = berkas?.items.find((i) => i.id === itemId);
  return (
    <div className="stack">
      {result ? <ItemResult result={result.r} before={result.before} onClose={() => setResult(null)} /> : null}
      <div className="card">
        <Picker label="Cari berkas atau item" options={opts} value={itemId} onChange={(id) => { setItemId(id); setResult(null); }} emptyText="Belum ada item yang dapat diubah." />
      </div>
      {berkas && item ? (
        <ItemForm key={`${item.id}:${item.version}`} berkas={berkas} item={item} options={options} unitId={unitId}
          onSaved={(r, before) => { setResult({ r, before }); reload(); }} />
      ) : null}
    </div>
  );
}

function TitleForm({ berkas, onSaved }: { berkas: EditBerkas; onSaved(r: TitleUpdateResult): void }) {
  const { client } = useAuth();
  const getToken = useGetToken();
  const ids = { t: useId() };
  const [title, setTitle] = useState(berkas.title);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UserMessage | null>(null);
  const inFlight = useRef(false);
  const rid = useRequestKey();
  const clean = title.replace(/\s+/g, ' ').trim();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    if (!clean) return setError({ title: 'Judul berkas wajib diisi.', action: 'Tuliskan judul berkas yang baru.' });
    if (clean === berkas.title.replace(/\s+/g, ' ').trim()) return setError({ title: 'Tidak ada perubahan yang perlu disimpan.', action: 'Ubah judul terlebih dahulu.' });
    if (reason.trim().length < MIN_REASON) return setError({ title: `Alasan minimal ${MIN_REASON} karakter.`, action: 'Tuliskan alasan perubahan dengan jelas.' });
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const { data } = await s3.berkasUpdateTitle(client, rid.idFor(JSON.stringify([berkas.id, clean, reason.trim()])), berkas.id, clean, reason.trim());
      rid.clear();
      if (data.drive_tasks?.length) runDriveTasks(getToken, null);
      onSaved(data);
      setBusy(false);
      inFlight.current = false;
    } catch (err) {
      if (isBusinessError(err)) rid.clear();
      setError(errorMessage(err));
      setBusy(false);
      inFlight.current = false;
    }
  }

  return (
    <form className="card stack" onSubmit={(e) => void submit(e)} noValidate>
      <div className="readonly-box">Judul saat ini: <strong>{berkas.title}</strong></div>
      <div className="field">
        <label htmlFor={ids.t}>Judul berkas baru *</label>
        <textarea id={ids.t} rows={3} maxLength={500} value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} />
        <small className="field-hint">{clean.length} / 500 karakter. Nomor berkas, klasifikasi, dan item tidak berubah.</small>
      </div>
      <ReasonField label="Alasan perubahan *" value={reason} onChange={setReason} />
      {error ? <Alert tone="error" message={error} /> : null}
      <div className="form-actions-bar">
        <span className="save-stage" role="status" aria-live="polite">{busy ? 'Menyimpan judul…' : ''}</span>
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Menyimpan…' : 'Simpan Judul Berkas'}</button>
      </div>
    </form>
  );
}

function TitleEditor({ options, reload }: { options: EditOptions; reload(): void }) {
  const [berkasId, setBerkasId] = useState('');
  const [result, setResult] = useState<TitleUpdateResult | null>(null);
  const opts: PickOption[] = options.berkas.map((b) => ({
    id: b.id, title: `Berkas ${b.number ?? 'draf'} — ${b.title}`, sub: `${b.items.length} item`,
    disabledReason: loanLabel(b.loan_status) || undefined,
  }));
  const berkas = options.berkas.find((b) => b.id === berkasId);
  return (
    <div className="stack">
      {result ? (
        <section className="result-box" aria-label="Hasil perubahan judul">
          <h2>{result.message || 'Judul berkas tersimpan.'}</h2>
          {result.replayed ? <p className="muted small">Permintaan ini sudah pernah diproses.</p> : null}
          <ul className="result-list">
            <li>Judul lama: {result.old_title}</li>
            <li>Judul baru: {result.title}</li>
            {result.warnings.map((w, i) => <li key={i}>Peringatan: {w}</li>)}
          </ul>
          <button type="button" className="btn btn-secondary" onClick={() => setResult(null)}>Tutup</button>
        </section>
      ) : null}
      <div className="card"><Picker label="Cari berkas" options={opts} value={berkasId} onChange={(id) => { setBerkasId(id); setResult(null); }} emptyText="Belum ada berkas." /></div>
      {berkas ? <TitleForm key={`${berkas.id}:${berkas.title}`} berkas={berkas} onSaved={(r) => { setResult(r); reload(); }} /> : null}
    </div>
  );
}

/** Perubahan Arsip (3.x Edit Arsip): metadata/PDF satu item, atau judul berkas. */
export function EditPage() {
  const { client } = useAuth();
  const { unitId, needsUnit } = useWriteUnit();
  const [mode, setMode] = useState<'item' | 'judul'>('item');
  const [load, retry] = useLoad(`edit:${unitId ?? 'own'}`, () => s3.editOptions(client, unitId));
  if (needsUnit) return (<><PageHeader title="Perubahan Arsip" subtitle="Ubah metadata item, ganti PDF, atau ubah judul berkas." /><NeedsUnit /></>);
  return (
    <>
      <PageHeader title="Perubahan Arsip" subtitle="Ubah metadata atau PDF satu item, atau judul berkas, tanpa menghapus dan menginput ulang." />
      <Alert tone="info"><strong>Perubahan terkontrol.</strong>{' '}<span>Perubahan tanggal dapat mengubah nomor kronologis. Alasan dicatat di Master Log. PDF lama tidak dihapus, hanya dipindahkan ke karantina.</span></Alert>
      <div className="mode-switch" role="group" aria-label="Yang diubah">
        <button type="button" className={`mode-button${mode === 'item' ? ' active' : ''}`} aria-pressed={mode === 'item'} onClick={() => setMode('item')}>Detail item</button>
        <button type="button" className={`mode-button${mode === 'judul' ? ' active' : ''}`} aria-pressed={mode === 'judul'} onClick={() => setMode('judul')}>Ubah judul berkas</button>
      </div>
      {load.kind === 'loading' ? <p className="muted" role="status">Memuat daftar berkas…</p> : null}
      {load.kind === 'error' ? <div className="stack"><Alert tone="error" message={load.message} /><button type="button" className="btn btn-secondary" onClick={retry}>Coba lagi</button></div> : null}
      {load.kind === 'ok' ? (mode === 'item' ? <ItemEditor options={load.data} unitId={unitId} reload={retry} /> : <TitleEditor options={load.data} reload={retry} />) : null}
    </>
  );
}
