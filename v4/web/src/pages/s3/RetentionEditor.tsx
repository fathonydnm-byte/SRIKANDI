import { useRef, useState, type FormEvent } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { Alert } from '../../components/Alert';
import { RetentionScheduleFields } from '../../components/retention/RetentionScheduleFields';
import { isBusinessError } from '../../lib/api';
import type { UserMessage } from '../../lib/errors';
import { formatDate } from '../../lib/format';
import { retentionApi, retentionDraft, retentionErrors, retentionPayload, type RetentionDetails } from '../../lib/retention';
import type { EditOptions } from '../../lib/s3api';
import { useLoad } from '../../lib/useLoad';
import { errorMessage } from '../s2/common';
import { MIN_REASON, Picker, ReasonField, useRequestKey } from './editShared';

function RetentionForm({
  id, schedule, reload, onSaved,
}: {
  id: string;
  schedule: RetentionDetails;
  reload(): void;
  onSaved(schedule: RetentionDetails): void;
}) {
  const { client } = useAuth();
  const [draft, setDraft] = useState(() => retentionDraft(schedule));
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<UserMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const request = useRequestKey();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (inFlight.current || schedule.blocked_reason) return;
    const issues = retentionErrors(draft);
    setErrors(issues);
    setError(null);
    if (Object.keys(issues).length) return;
    if (reason.trim().length < MIN_REASON) {
      setError({ title: `Alasan perubahan minimal ${MIN_REASON} karakter.`, action: 'Tuliskan dasar perubahan jadwal.' });
      return;
    }
    const payload = retentionPayload(draft);
    const signature = JSON.stringify([id, schedule.version, payload, reason.trim()]);
    inFlight.current = true;
    setBusy(true);
    try {
      const { data } = await retentionApi.update(client, request.idFor(signature), id, schedule.version, payload, reason.trim());
      request.clear();
      onSaved(data);
    } catch (err) {
      if (isBusinessError(err)) request.clear();
      setError(errorMessage(err));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return <form className="card stack" onSubmit={(e) => void submit(e)} noValidate>
    <div className="readonly-box">
      <strong>{schedule.reference_mode === 'LEGACY' ? 'Jadwal lama · Perlu Konfirmasi' : 'Jadwal saat ini'}</strong>
      <p>Tanggal acuan: {formatDate(schedule.retention_reference_date)} · Batas aktif: {formatDate(schedule.active_limit)} · Batas inaktif: {formatDate(schedule.inactive_limit)}</p>
      {schedule.reference_mode === 'LEGACY' && <p className="muted small">Berkas dapat diusulkan setelah tanggal acuannya dikonfirmasi.</p>}
      {schedule.reference_mode === 'LEGACY' && schedule.retention_reference_date && !schedule.blocked_reason && (
        <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
          onClick={() => setDraft({ ...draft, retention_pending: false, retention_reference_date: schedule.retention_reference_date! })}>
          Pakai tanggal lama sebagai acuan
        </button>
      )}
    </div>
    {schedule.blocked_reason ? <Alert tone="warning">{schedule.blocked_reason}</Alert> : <>
      <RetentionScheduleFields value={draft} onChange={setDraft} errors={errors} disabled={busy} />
      <ReasonField label="Alasan perubahan *" value={reason} onChange={setReason} />
      {error && <Alert tone="error" message={error} />}
      <div className="form-actions-bar">
        <button type="button" className="btn btn-secondary" onClick={reload} disabled={busy}>Muat ulang jadwal</button>
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Menyimpan…' : 'Simpan Jadwal Retensi'}</button>
      </div>
    </>}
  </form>;
}

export function RetentionEditor({ options, unitId }: { options: EditOptions; unitId: string | null }) {
  const { client } = useAuth();
  const [id, setId] = useState('');
  const [saved, setSaved] = useState<RetentionDetails | null>(null);
  const validId = options.berkas.some((b) => b.id === id) ? id : '';
  const [load, retry] = useLoad(`retention:${unitId ?? 'own'}:${validId}`,
    () => validId ? retentionApi.get(client, validId) : Promise.resolve(null));
  const current = load.kind === 'ok' && load.data && (!saved || load.data.version >= saved.version) ? load.data : saved;
  return <div className="stack">
    <div className="card"><Picker label="Cari berkas" options={options.berkas.map((b) => ({
      id: b.id, title: `Berkas ${b.number ?? 'draf'} — ${b.title}`, sub: `${b.items.length} item`,
    }))} value={validId} onChange={(next) => { setId(next); setSaved(null); }} emptyText="Belum ada berkas." /></div>
    {validId && saved && <Alert tone="success">
      Jadwal retensi tersimpan. {saved.reference_mode === 'PENDING'
        ? 'Menunggu penetapan tanggal acuan.'
        : `Batas aktif: ${formatDate(saved.active_limit)} · Batas inaktif: ${formatDate(saved.inactive_limit)}.`}
    </Alert>}
    {validId && load.kind === 'loading' && !current && <p role="status">Memuat jadwal retensi…</p>}
    {validId && load.kind === 'error' && <div className="stack"><Alert tone="error" message={load.message} />
      <button type="button" className="btn btn-secondary" onClick={retry}>Coba lagi</button>
    </div>}
    {validId && current && <RetentionForm key={`${validId}:${current.version}`} id={validId} schedule={current}
      reload={retry} onSaved={(data) => { setSaved(data); retry(); }} />}
  </div>;
}
