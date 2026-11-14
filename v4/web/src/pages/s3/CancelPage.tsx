import { useId, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { Alert } from '../../components/Alert';
import { PageHeader } from '../../components/PageHeader';
import { Sheet } from '../../components/Sheet';
import { isBusinessError } from '../../lib/api';
import type { UserMessage } from '../../lib/errors';
import { formatDate } from '../../lib/format';
import { runDriveTasks } from '../../lib/s2api';
import { cancelUploadSession, s3, type CancelBerkas, type CancelItem, type CancelOptions, type CancelResult, type CancelScope } from '../../lib/s3api';
import { guessMime } from '../../lib/uploader';
import { percent, STAGE_LABELS, uploads, useUploads } from '../../lib/uploadStore';
import { useLoad } from '../../lib/useLoad';
import { errorMessage, NeedsUnit, useGetToken, useWriteUnit } from '../s2/common';
import { FilePicker, isMimeAllowed, loanLabel, MIN_REASON, Picker, ReasonField, useRequestKey, type PickOption } from './editShared';

type Stage = 'idle' | 'validating' | 'confirm' | 'uploading' | 'saving';

function itemWhy(b: CancelBerkas, i: CancelItem): string | undefined {
  if (i.can_cancel) return undefined;
  if (i.is_last_item) return 'Item terakhir: batalkan seluruh berkas';
  return loanLabel(i.loan_status) || loanLabel(b.loan_status) || 'Tidak dapat dibatalkan saat ini';
}

function impactLines(scope: CancelScope, berkas: CancelBerkas, item: CancelItem | undefined): { items: number; files: number; pages: number; receipts: string[]; receiptLines: number } {
  const list = scope === 'BERKAS' ? berkas.items : item ? [item] : [];
  const receipts = [...new Set(list.filter((i) => i.from_receipt).map((i) => i.receipt_number ?? 'tanda terima'))];
  return {
    items: list.length,
    files: list.filter((i) => i.has_file).length,
    pages: scope === 'BERKAS' ? berkas.page_count : (item?.page_count ?? 0),
    receipts,
    receiptLines: list.filter((i) => i.from_receipt).length,
  };
}

function CancelResultBox({ r, onClose }: { r: CancelResult; onClose(): void }) {
  return (
    <section className="result-box" aria-label="Hasil pembatalan">
      <h2>{r.message}</h2>
      {r.replayed ? <p className="muted small">Permintaan ini sudah pernah diproses; hasil sebelumnya ditampilkan tanpa mengubah data lagi.</p> : null}
      <ul className="result-list">
        <li>Nomor pembatalan: {r.cancellation_id}</li>
        <li>{r.cancelled_item_count} item dibatalkan{r.scope === 'BERKAS' ? ' beserta berkasnya' : ''}.</li>
        <li>{r.quarantine_ids.length} file/folder dikarantina (hanya Admin yang dapat membukanya).</li>
        {r.released_receipt_item_ids.length > 0 ? <li>{r.released_receipt_item_ids.length} baris tanda terima kembali ke antrean pemberkasan.</li> : null}
        {r.renumbered_item_count > 0 || r.renumbered_berkas_count > 0 ? <li>Penomoran ulang: {r.renumbered_item_count} item dan {r.renumbered_berkas_count} berkas.</li> : null}
        {r.evidence_file_id ? <li>Bukti disposisi tersimpan.</li> : null}
        {r.warnings.map((w, i) => <li key={i}>Peringatan: {w}</li>)}
      </ul>
      <button type="button" className="btn btn-secondary" onClick={onClose}>Tutup</button>
    </section>
  );
}

function CancelForm({ options, unitId, reload, onDone }: { options: CancelOptions; unitId: string | null; reload(): void; onDone(r: CancelResult): void }) {
  const { client } = useAuth();
  const getToken = useGetToken();
  const jobs = useUploads();
  const word = options.confirmation_word;
  const [scope, setScope] = useState<CancelScope>('ITEM');
  const [targetId, setTargetId] = useState('');
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [file, setFileState] = useState<File | null>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [error, setError] = useState<UserMessage | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const confirmId = useId();
  const inFlight = useRef(false);
  const committed = useRef<{ file: File; sessionId: string } | null>(null);
  const rid = useRequestKey();
  const job = jobs.find((j) => j.id === jobId);

  const pickOptions = useMemo<PickOption[]>(() => scope === 'BERKAS'
    ? options.berkas.map((b) => ({
        id: b.id, title: `Berkas ${b.number ?? 'draf'} — ${b.title}`, sub: `${b.item_count} item · ${b.page_count} lembar`,
        disabledReason: b.can_cancel ? undefined : loanLabel(b.loan_status) || 'Ada item yang sedang dipinjam',
      }))
    : options.berkas.flatMap((b) => b.items.map((i) => ({
        id: i.id, title: `Item ${i.number ?? '–'} — ${i.description}`, sub: `${formatDate(i.document_date)} · ${i.page_count ?? '–'} lembar`,
        group: `Berkas ${b.number ?? 'draf'} — ${b.title}`, disabledReason: itemWhy(b, i),
      }))), [options.berkas, scope]);

  const berkas = scope === 'BERKAS' ? options.berkas.find((b) => b.id === targetId) : options.berkas.find((b) => b.items.some((i) => i.id === targetId));
  const item = scope === 'ITEM' ? berkas?.items.find((i) => i.id === targetId) : undefined;
  const impact = berkas ? impactLines(scope, berkas, item) : null;
  const wordOk = confirmation.trim().toUpperCase() === word.toUpperCase();
  const reasonOk = reason.trim().length >= (options.min_reason_length || MIN_REASON);
  const busy = stage !== 'idle' && stage !== 'confirm';
  const ready = Boolean(berkas) && (scope === 'BERKAS' || Boolean(item)) && wordOk && reasonOk && stage === 'idle';
  const evidenceMb = Math.floor(options.evidence.max_bytes / (1024 * 1024));

  function setFile(f: File | null) {
    if (committed.current) {
      cancelUploadSession(getToken, committed.current.sessionId);
      committed.current = null;
    }
    setFileState(f);
    setError(null);
  }
  function changeScope(s: CancelScope) {
    if (stage !== 'idle') return;
    setScope(s);
    setTargetId('');
    setError(null);
  }

  /** Tahap 1: semua penjaga server (dipinjam, item terakhir, sudah dibatalkan…) sebelum apa pun diunggah. */
  async function check() {
    if (inFlight.current || !berkas) return;
    if (!reasonOk) return setError({ title: `Alasan minimal ${MIN_REASON} karakter.`, action: 'Tuliskan alasan pembatalan dengan jelas.' });
    if (!wordOk) return setError({ title: 'Konfirmasi belum sesuai.', action: `Ketik ${word} pada kolom konfirmasi.` });
    if (file) {
      if (!isMimeAllowed(file, options.evidence.extensions)) return setError({ title: 'Tipe bukti tidak diizinkan.', action: 'Gunakan PDF, JPG, JPEG, atau PNG.' });
      if (file.size < 1 || file.size > options.evidence.max_bytes) return setError({ title: `Bukti maksimal ${evidenceMb} MB.`, action: 'Pilih file yang lebih kecil.' });
    }
    inFlight.current = true;
    setError(null);
    setStage('validating');
    try {
      await s3.cancelValidate(client, scope, berkas.id, item?.id ?? null, reason.trim(), confirmation.trim());
      setStage('confirm');
    } catch (e) {
      setError(errorMessage(e));
      setStage('idle');
    } finally {
      inFlight.current = false;
    }
  }

  async function finish(sessionId: string | null) {
    if (!berkas) return;
    setStage('saving');
    try {
      const sig = JSON.stringify([scope, berkas.id, item?.id ?? null, reason.trim(), confirmation.trim(), sessionId]);
      const { data } = await s3.archiveCancel(client, rid.idFor(sig), scope, berkas.id, item?.id ?? null, reason.trim(), confirmation.trim(), sessionId);
      rid.clear();
      committed.current = null;
      if (data.drive_tasks?.length) runDriveTasks(getToken, unitId);
      onDone(data);
      reload();
      setReason('');
      setConfirmation('');
      setTargetId('');
      setFileState(null);
      setStage('idle');
    } catch (e) {
      if (isBusinessError(e)) rid.clear();
      setError(errorMessage(e));
      setStage('idle');
    } finally {
      inFlight.current = false;
    }
  }

  /** Tahap 2 (setelah dialog akhir): bukti diunggah dulu, baru pembatalan dikirim. */
  function execute() {
    if (inFlight.current || !berkas) return;
    inFlight.current = true;
    setError(null);
    if (!file) return void finish(null);
    if (committed.current?.file === file) return void finish(committed.current.sessionId);
    setStage('uploading');
    const f = file;
    const id = uploads.start(
      { purpose: 'DELETION_EVIDENCE', objectId: scope === 'ITEM' ? item!.id : berkas.id, file: f, fileName: f.name, mime: guessMime(f, f.name), unitId },
      `Bukti pembatalan ${scope === 'ITEM' ? `Item ${item?.number ?? '–'}` : `Berkas ${berkas.number ?? '–'}`}`,
      (r) => { committed.current = { file: f, sessionId: r.sessionId }; void finish(r.sessionId); },
    );
    setJobId(id);
  }

  function abortUpload() {
    if (jobId) uploads.abort(jobId);
    setJobId(null);
    setStage('idle');
    inFlight.current = false;
  }

  const uploadFailed = stage === 'uploading' && Boolean(job?.error);
  const statusText = stage === 'validating' ? 'Memeriksa ke server…'
    : stage === 'uploading' && job ? `${STAGE_LABELS[job.progress.stage]}${job.progress.stage === 'mengunggah' ? ` ${percent(job.progress)}%` : ''} — pembatalan dikirim setelah bukti terunggah`
    : stage === 'saving' ? 'Membatalkan dari arsip aktif…' : '';

  return (
    <div className="stack">
      <div className="mode-switch" role="group" aria-label="Objek yang dibatalkan">
        <button type="button" className={`mode-button${scope === 'ITEM' ? ' active' : ''}`} aria-pressed={scope === 'ITEM'} onClick={() => changeScope('ITEM')}>Satu item</button>
        <button type="button" className={`mode-button${scope === 'BERKAS' ? ' active' : ''}`} aria-pressed={scope === 'BERKAS'} onClick={() => changeScope('BERKAS')}>Seluruh berkas</button>
      </div>
      <div className="card stack">
        <Picker key={scope} label={scope === 'ITEM' ? 'Cari item yang dibatalkan' : 'Cari berkas yang dibatalkan'} options={pickOptions} value={targetId}
          onChange={(id) => { if (stage === 'idle') setTargetId(id); }} emptyText="Tidak ada arsip aktif." />
        {impact && berkas ? (
          <div className="impact-box" aria-live="polite">
            <strong>Dampak pembatalan</strong>
            <ul>
              <li>{scope === 'BERKAS' ? `Berkas ${berkas.number ?? 'draf'} “${berkas.title}” beserta ${impact.items} item (${impact.pages} lembar)` : `Item ${item?.number ?? '–'} dari Berkas ${berkas.number ?? 'draf'} (${impact.pages} lembar)`} keluar dari arsip aktif.</li>
              <li>{impact.files} file PDF dipindahkan ke karantina; datanya tidak dihapus permanen.</li>
              <li>{impact.receiptLines > 0 ? `${impact.receiptLines} baris tanda terima (${impact.receipts.join(', ')}) kembali ke antrean pemberkasan.` : 'Tidak ada baris tanda terima yang kembali ke antrean.'}</li>
              <li>Nomor {scope === 'BERKAS' ? 'berkas dan item' : 'item'} yang tersisa disusun ulang; nomor yang dibatalkan tidak dipakai lagi.</li>
            </ul>
          </div>
        ) : <p className="muted small">Pilih objek untuk melihat dampak pembatalan.</p>}
        <ReasonField label="Alasan pembatalan *" value={reason} onChange={setReason} minLength={options.min_reason_length || MIN_REASON} placeholder="Contoh: Item dinyatakan hilang berdasarkan berita acara…" hint="Disimpan permanen di Master Log." />
        <FilePicker label="Bukti disposisi (opsional)" accept={options.evidence.extensions.map((e) => `.${e}`).join(',') + ',' + options.evidence.mime_types.join(',')} file={file} onChange={setFile} disabled={busy}
          hint={`PDF, JPG, JPEG, atau PNG; maksimal ${evidenceMb} MB.`} />
        <div className="field">
          <label htmlFor={confirmId}>Konfirmasi *</label>
          <input id={confirmId} className="cancel-confirm-input" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} placeholder={`Ketik ${word}`} autoComplete="off" autoCapitalize="characters" disabled={busy} />
          <small className={`field-hint${wordOk ? ' reason-counter is-ok' : ''}`}>{wordOk ? 'Konfirmasi sesuai.' : `Ketik kata ${word} untuk melanjutkan.`}</small>
        </div>
        {error ? <Alert tone="error" message={error} /> : null}
        {uploadFailed && job?.error ? <Alert tone="error" message={job.error} /> : null}
        <div className="form-actions-bar">
          <span className="save-stage" role="status" aria-live="polite">{statusText}</span>
          {stage === 'uploading' ? <button type="button" className="btn btn-secondary" onClick={abortUpload}>Batalkan unggahan</button> : null}
          <button type="button" className="btn btn-danger" disabled={!ready} onClick={() => void check()}>Periksa dan Lanjutkan</button>
        </div>
      </div>
      {stage === 'confirm' && berkas && impact ? (
        <Sheet title="Konfirmasi akhir pembatalan" onClose={() => { setStage('idle'); inFlight.current = false; }} variant="dialog">
          <div className="stack">
            <Alert tone="warning"><strong>Pemeriksaan server lolos.</strong> <span>Setelah ini {scope === 'BERKAS' ? `berkas dan ${impact.items} item` : 'item'} keluar dari arsip aktif. Tindakan ini tidak dapat dibatalkan dari aplikasi.</span></Alert>
            <p className="small">{scope === 'BERKAS' ? `Berkas ${berkas.number ?? 'draf'}: ${berkas.title}` : `Item ${item?.number ?? '–'}: ${item?.description ?? ''}`}</p>
            <p className="small">Alasan: {reason.trim()}</p>
            <p className="small">{file ? `Bukti: ${file.name} (diunggah lebih dulu).` : 'Tanpa bukti disposisi.'}</p>
            <div className="action-row">
              <button type="button" className="btn btn-secondary" onClick={() => { setStage('idle'); inFlight.current = false; }}>Kembali</button>
              <button type="button" className="btn btn-danger" onClick={execute}>Ya, batalkan dari arsip aktif</button>
            </div>
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}

/** Penghapusan Arsip (3.x Koreksi & Pembatalan): item atau seluruh berkas, dengan karantina. */
export function CancelPage() {
  const { client } = useAuth();
  const { unitId, needsUnit } = useWriteUnit();
  const [load, retry] = useLoad(`cancel:${unitId ?? 'own'}`, () => s3.cancelOptions(client, unitId));
  const [result, setResult] = useState<CancelResult | null>(null);
  if (needsUnit) return (<><PageHeader title="Penghapusan Arsip" subtitle="Koreksi dan pembatalan arsip dengan karantina." /><NeedsUnit /></>);
  return (
    <>
      <PageHeader title="Koreksi & Pembatalan Arsip" subtitle="Batalkan satu item atau seluruh berkas dari arsip aktif dengan jejak audit lengkap." />
      <Alert tone="warning"><strong>Pengamanan aktif.</strong>{' '}<span>Data tidak dihapus permanen. Metadata dinonaktifkan, file dikarantina, alasan dicatat di Master Log, dan nomor disusun ulang.</span></Alert>
      {result ? <CancelResultBox r={result} onClose={() => setResult(null)} /> : null}
      {load.kind === 'loading' ? <p className="muted" role="status">Memuat daftar arsip…</p> : null}
      {load.kind === 'error' ? <div className="stack"><Alert tone="error" message={load.message} /><button type="button" className="btn btn-secondary" onClick={retry}>Coba lagi</button></div> : null}
      {load.kind === 'ok' ? <CancelForm options={load.data} unitId={unitId} reload={retry} onDone={setResult} /> : null}
    </>
  );
}
