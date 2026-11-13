import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { Alert } from '../../components/Alert';
import { PageHeader } from '../../components/PageHeader';
import { Sheet } from '../../components/Sheet';
import { newRequestId } from '../../lib/api';
import type { UserMessage } from '../../lib/errors';
import { formatNumber } from '../../lib/format';
import { s2, type Receipt, type ReceiptSaveResult } from '../../lib/s2api';
import { percent, STAGE_LABELS, uploads, useUploads } from '../../lib/uploadStore';
import { useLoad } from '../../lib/useLoad';
import { clearPendingReceipt, pendingReceiptRequest, ReceiptForm } from './ReceiptForm';
import { errorMessage, formatTimestamp, NeedsUnit, PdfPicker, useWriteUnit } from './common';

const EVIDENCE_MAX = 10 * 1024 * 1024;

function EvidenceSheet({ receipt, onClose }: { receipt: Receipt; onClose(): void }) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!file) return setError('Pilih PDF tanda terima yang sudah ditandatangani.');
    if (file.size > EVIDENCE_MAX) return setError('PDF maksimal 10 MB.');
    uploads.start({ purpose: 'RECEIPT_EVIDENCE', objectId: receipt.id, file, fileName: file.name, mime: 'application/pdf' }, `Bukti ${receipt.number}`);
    onClose();
  }
  return (
    <Sheet title="Upload Tanda Terima Tertandatangani" onClose={onClose} variant="dialog">
      <form className="stack" onSubmit={submit} noValidate>
        <p className="muted">{receipt.number} · {receipt.sender_name}</p>
        <PdfPicker id={id} label="PDF tanda terima tertandatangani *" hint="PDF maksimal 10 MB. File disimpan di folder BUKTI PENERIMAAN ARSIP." file={file} onChange={(f) => { setFile(f); setError(null); }} />
        {error ? <Alert tone="error"><span>{error}</span></Alert> : null}
        <Alert tone="info"><span>Setelah bukti tersimpan, tanda terima dikunci. Koreksi selanjutnya dilakukan dengan membatalkan dan membuat tanda terima baru.</span></Alert>
        <button type="submit" className="btn btn-primary">Upload Bukti</button>
      </form>
    </Sheet>
  );
}

function CancelSheet({ receipt, onClose, onCancelled }: { receipt: Receipt; onClose(): void; onCancelled(msg: string): void }) {
  const { client } = useAuth();
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [requestId] = useState(newRequestId);
  const [stage, setStage] = useState<'idle' | 'upload' | 'saving'>('idle');
  const [error, setError] = useState<UserMessage | null>(null);
  const jobsAll = useUploads();
  const [jobId, setJobId] = useState<string | null>(null);
  const job = jobsAll.find((j) => j.id === jobId);
  const ids = { r: useId(), c: useId(), f: useId() };

  async function finish(sessionId: string | null) {
    setStage('saving');
    try {
      const { data } = await s2.receiptCancel(client, requestId, receipt.id, reason.trim(), confirmation.trim(), sessionId);
      onCancelled(data.message || `Tanda terima ${receipt.number} dibatalkan.`);
    } catch (err) {
      setError(errorMessage(err));
      setStage('idle');
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (reason.trim().length < 10) return setError({ title: 'Alasan minimal 10 karakter.', action: 'Tuliskan alasan pembatalan dengan jelas.' });
    if (confirmation.trim().toUpperCase() !== 'BATALKAN') return setError({ title: 'Konfirmasi belum sesuai.', action: 'Ketik BATALKAN pada kolom konfirmasi.' });
    if (file && file.size > EVIDENCE_MAX) return setError({ title: 'PDF bukti maksimal 10 MB.', action: 'Pilih file yang lebih kecil.' });
    setError(null);
    if (!file) return void finish(null);
    setStage('upload');
    const id = uploads.start(
      { purpose: 'RECEIPT_CANCEL_EVIDENCE', objectId: receipt.id, file, fileName: file.name, mime: 'application/pdf' },
      `Bukti batal ${receipt.number}`,
      (r) => void finish(r.sessionId),
    );
    setJobId(id);
  }
  const uploadFailed = stage === 'upload' && Boolean(job?.error);
  const busy = stage === 'saving' || (stage === 'upload' && !uploadFailed);
  const shownError = error ?? (uploadFailed ? job!.error : null);

  return (
    <Sheet title="Batalkan Tanda Terima" onClose={onClose} variant="dialog">
      <form className="stack" onSubmit={submit} noValidate>
        <p className="muted">{receipt.number} · {receipt.sender_name}</p>
        <Alert tone="warning">
          <strong>Jejak bukti dipertahankan.</strong>{' '}
          <span>Tanda terima tidak dihapus. Status menjadi DIBATALKAN, alasan dicatat, dan bukti tertandatangani yang sudah ada tetap disimpan.</span>
        </Alert>
        <div className="field">
          <label htmlFor={ids.r}>Alasan pembatalan *</label>
          <textarea id={ids.r} rows={3} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} aria-describedby={`${ids.r}-h`} />
          <small id={`${ids.r}-h`} className="field-hint">Minimal 10 karakter.</small>
        </div>
        <PdfPicker id={ids.f} label="Bukti pembatalan (opsional)" hint="PDF maksimal 10 MB." file={file} onChange={setFile} />
        <div className="field">
          <label htmlFor={ids.c}>Konfirmasi *</label>
          <div className="field-control">
            <input id={ids.c} value={confirmation} onChange={(e) => setConfirmation(e.target.value)} placeholder="Ketik BATALKAN" autoComplete="off" autoCapitalize="characters" />
          </div>
        </div>
        {shownError ? <Alert tone="error" message={shownError} /> : null}
        {stage === 'upload' && job && !uploadFailed ? (
          <p className="muted small" role="status">{STAGE_LABELS[job.progress.stage]} {job.progress.stage === 'mengunggah' ? `${percent(job.progress)}%` : ''}</p>
        ) : null}
        <button type="submit" className="btn btn-danger" disabled={busy}>
          {busy && stage === 'upload' ? 'Mengunggah bukti…' : stage === 'saving' ? 'Membatalkan…' : 'Batalkan Tanda Terima'}
        </button>
      </form>
    </Sheet>
  );
}

type Filter = 'ALL' | 'AKTIF' | 'WITH_EVIDENCE' | 'WITHOUT_EVIDENCE' | 'DIBATALKAN';

function ReceiptHistory({ receipts, onEdit, onEvidence, onCancel, onRefresh }: {
  receipts: Receipt[]; onEdit(r: Receipt): void; onEvidence(r: Receipt): void; onCancel(r: Receipt): void; onRefresh(): void;
}) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('ALL');
  const jobs = useUploads();
  const ids = { q: useId(), f: useId() };
  const visible = useMemo(() => {
    const tokens = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return receipts.filter((r) => {
      if (filter === 'AKTIF' && r.status !== 'AKTIF') return false;
      if (filter === 'DIBATALKAN' && r.status !== 'DIBATALKAN') return false;
      if (filter === 'WITH_EVIDENCE' && !r.evidence_file_id) return false;
      if (filter === 'WITHOUT_EVIDENCE' && (r.evidence_file_id || r.status !== 'AKTIF')) return false;
      if (!tokens.length) return true;
      const corpus = [r.number, r.sender_name, r.sender_unit, r.receiver_name, r.receiver_unit, ...r.items.map((i) => i.description)].join(' ').toLowerCase();
      return tokens.every((t) => corpus.includes(t));
    });
  }, [receipts, q, filter]);
  return (
    <section className="card" aria-labelledby="rh-title">
      <div className="section-heading">
        <div>
          <h2 id="rh-title" className="section-title">Riwayat Tanda Terima</h2>
          <p className="muted small">Cari, cetak ulang, unggah bukti tertandatangani, edit, atau batalkan secara terkendali.</p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRefresh}>Segarkan Data</button>
      </div>
      <div className="toolbar-2">
        <div className="field">
          <label htmlFor={ids.q}>Cari tanda terima</label>
          <div className="field-control">
            <input id={ids.q} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nomor, nama, unit, uraian, atau penerima" />
          </div>
        </div>
        <div className="field">
          <label htmlFor={ids.f}>Status</label>
          <select id={ids.f} value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
            <option value="ALL">Semua status</option>
            <option value="AKTIF">Aktif</option>
            <option value="WITH_EVIDENCE">Sudah ada bukti</option>
            <option value="WITHOUT_EVIDENCE">Belum ada bukti</option>
            <option value="DIBATALKAN">Dibatalkan</option>
          </select>
        </div>
      </div>
      {visible.length === 0 ? (
        <p className="arc-empty">{receipts.length ? 'Tidak ada tanda terima yang cocok.' : 'Belum ada tanda terima.'}</p>
      ) : (
        <ul className="result-list receipt-list">
          {visible.map((r) => {
            const job = [...jobs].reverse().find((j) => j.request.objectId === r.id && j.request.purpose === 'RECEIPT_EVIDENCE');
            const uploading = job && !job.error && job.progress.stage !== 'selesai' && job.progress.stage !== 'dibatalkan';
            return (
              <li key={r.id} className={`result-card receipt-card${r.status === 'DIBATALKAN' ? ' is-cancelled' : ''}`}>
                <div className="result-top">
                  <strong className="result-number">{r.number}</strong>
                  <span className="result-badges">
                    {r.status === 'DIBATALKAN' ? <span className="badge-pill badge-danger">Dibatalkan</span> : <span className="badge-pill badge-ok">Aktif</span>}
                    {r.evidence_file_id ? <span className="badge-pill badge-info">Bukti tertandatangani</span> : r.status === 'AKTIF' ? <span className="badge-pill badge-warn">Belum ada bukti</span> : null}
                    {r.print_count ? <span className="badge-pill badge-neutral">Dicetak {r.print_count}×</span> : null}
                  </span>
                </div>
                <p className="muted small receipt-meta">{formatTimestamp(r.received_at)}</p>
                <p className="receipt-parties">
                  <span><span className="muted">Penyerah:</span> {r.sender_name} <span className="muted">— {r.sender_unit}</span></span>
                  <span><span className="muted">Penerima:</span> {r.receiver_name} <span className="muted">— {r.receiver_unit}</span></span>
                </p>
                <p className="small">
                  {formatNumber(r.item_count)} item · {formatNumber(r.total_pages)} halaman
                  {r.status === 'AKTIF' ? ` · ${r.filed_count} diberkaskan, ${r.pending_count} menunggu` : ''}
                </p>
                {r.status === 'DIBATALKAN' && r.cancellation_reason ? <p className="small receipt-cancel-reason">Dibatalkan: {r.cancellation_reason}</p> : null}
                {uploading && job ? <p className="small muted" role="status">Bukti: {STAGE_LABELS[job.progress.stage]} {job.progress.stage === 'mengunggah' ? `${percent(job.progress)}%` : ''}</p> : null}
                <div className="action-row receipt-actions">
                  <Link className="btn btn-secondary btn-sm" to={`/penerimaan/${encodeURIComponent(r.id)}/cetak`}>{r.print_count ? 'Cetak Ulang' : 'Cetak'}</Link>
                  {r.status === 'AKTIF' && !r.evidence_file_id && !uploading ? (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => onEvidence(r)}>Upload Bukti</button>
                  ) : null}
                  {r.can_edit ? <button type="button" className="btn btn-secondary btn-sm" onClick={() => onEdit(r)}>Edit</button> : null}
                  {r.status === 'AKTIF' ? <button type="button" className="btn btn-secondary btn-sm btn-danger-text" onClick={() => onCancel(r)}>Batalkan</button> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Penerimaan Naskah (3.x receiptsPage). */
export function ReceiptsPage() {
  const { client } = useAuth();
  const { unitId, needsUnit } = useWriteUnit();
  const [load, reload] = useLoad(`receipts:${unitId ?? 'own'}`, () => s2.receiptOptions(client, unitId));
  const [editing, setEditing] = useState<Receipt | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [saved, setSaved] = useState<ReceiptSaveResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [evidenceFor, setEvidenceFor] = useState<Receipt | null>(null);
  const [cancelFor, setCancelFor] = useState<Receipt | null>(null);
  const [recovered, setRecovered] = useState<{ number: string; receipt_id: string } | null>(null);
  const jobs = useUploads();
  const doneEvidence = jobs.filter((j) => j.request.purpose === 'RECEIPT_EVIDENCE' && j.progress.stage === 'selesai').length;

  // Bukti selesai diunggah → muat ulang daftar.
  useEffect(() => {
    if (doneEvidence) reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doneEvidence]);

  // Penyimpanan yang terputus (tab tertutup / jaringan) → tanyakan hasilnya ke server.
  useEffect(() => {
    const pending = pendingReceiptRequest();
    if (!pending || needsUnit) return;
    let cancelled = false;
    s2.receiptRecover(client, pending, unitId).then(
      (r) => {
        if (cancelled) return;
        clearPendingReceipt();
        if (r.found && r.number && r.receipt_id) setRecovered({ number: r.number, receipt_id: r.receipt_id });
      },
      () => null,
    );
    return () => {
      cancelled = true;
    };
  }, [client, unitId, needsUnit]);

  if (needsUnit) {
    return (
      <>
        <PageHeader title="Penerimaan Naskah" subtitle="Catat penerimaan arsip fisik dan cetak tanda terima." />
        <NeedsUnit />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Penerimaan Naskah" subtitle="Catat penerimaan arsip fisik dan cetak tanda terima." />
      {load.kind === 'error' ? (
        <div className="stack">
          <Alert tone="error" message={load.message} />
          <button type="button" className="btn btn-secondary" onClick={reload}>Coba lagi</button>
        </div>
      ) : load.kind === 'loading' ? (
        <p className="muted detail-loading" role="status">Memuat data penerimaan…</p>
      ) : (
        <>
          <div className="stat-grid receipt-stats">
            {[
              ['Total Tanda Terima', load.data.summary.total, ''],
              ['Aktif', load.data.summary.active, 'tone-info'],
              ['Bukti Tertandatangani', load.data.summary.with_evidence, ''],
              ['Dibatalkan', load.data.summary.cancelled, 'tone-danger'],
            ].map(([label, value, tone]) => (
              <div key={String(label)} className={`stat-card ${tone}`}>
                <span className="stat-text">
                  <span className="stat-label">{label}</span>
                  <strong className="stat-value">{formatNumber(Number(value))}</strong>
                </span>
              </div>
            ))}
          </div>
          {recovered ? (
            <Alert tone="success">
              <strong>Penyimpanan sebelumnya berhasil: {recovered.number}.</strong>{' '}
              <Link to={`/penerimaan/${encodeURIComponent(recovered.receipt_id)}/cetak`}>Cetak tanda terima</Link>
            </Alert>
          ) : null}
          {saved ? (
            <div className="saved-banner" role="status">
              <div>
                <strong>{saved.is_update ? 'Perubahan tersimpan' : 'Tanda terima tersimpan'}: {saved.number}</strong>
                <span className="muted small"> · {saved.item_count} item · {saved.total_pages} halaman</span>
              </div>
              <Link className="btn btn-primary" to={`/penerimaan/${encodeURIComponent(saved.receipt_id)}/cetak`}>Cetak Tanda Terima</Link>
            </div>
          ) : null}
          {message ? <Alert tone="success"><span>{message}</span></Alert> : null}
          <ReceiptForm
            key={editing ? `edit-${editing.id}` : `new-${formKey}`}
            options={load.data}
            editing={editing}
            unitId={unitId}
            onSaved={(r) => {
              setSaved(r);
              setMessage(null);
              setRecovered(null);
              if (editing) {
                setEditing(null);
                setFormKey((k) => k + 1);
              }
              reload(); // di latar; formulir sudah siap untuk input berikutnya
            }}
            onCancelEdit={() => {
              setEditing(null);
              setFormKey((k) => k + 1);
            }}
          />
          <ReceiptHistory
            receipts={load.data.receipts}
            onRefresh={reload}
            onEdit={(r) => {
              setEditing(r);
              setSaved(null);
              window.scrollTo({ top: 0 });
            }}
            onEvidence={setEvidenceFor}
            onCancel={setCancelFor}
          />
        </>
      )}
      {evidenceFor ? <EvidenceSheet receipt={evidenceFor} onClose={() => setEvidenceFor(null)} /> : null}
      {cancelFor ? (
        <CancelSheet
          receipt={cancelFor}
          onClose={() => setCancelFor(null)}
          onCancelled={(msg) => {
            setCancelFor(null);
            setMessage(msg);
            reload();
          }}
        />
      ) : null}
    </>
  );
}
