import { useId, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { Alert } from '../../components/Alert';
import { PageHeader } from '../../components/PageHeader';
import { formatDate, formatNumber } from '../../lib/format';
import { runDriveTasks, s2 } from '../../lib/s2api';
import { scanToPdf, SCANNER_AVAILABLE } from '../../lib/scan';
import { percent, STAGE_LABELS, uploads, useUploads } from '../../lib/uploadStore';
import { useLoad } from '../../lib/useLoad';
import { NeedsUnit, PdfPicker, useGetToken, useWriteUnit } from './common';

const ITEM_PDF_MAX = 104857599; // < 100 MB (API_S2 §4)

/** Alih Media Arsip (3.x mediaPage): lengkapi PDF untuk item yang belum punya file. */
export function MediaPage() {
  const { client } = useAuth();
  const getToken = useGetToken();
  const { unitId, needsUnit } = useWriteUnit();
  const [sp, setSp] = useSearchParams();
  const [load, retry] = useLoad(`media:${unitId ?? 'own'}`, () => s2.mediaOptions(client, unitId));
  const deepItem = sp.get('item');
  const [chosenBerkas, setChosenBerkas] = useState<string | null>(null);
  const [chosenItem, setChosenItem] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const jobs = useUploads();
  const ids = { b: useId(), i: useId(), f: useId() };

  if (needsUnit) return (<><PageHeader title="Alih Media Arsip" subtitle="Lengkapi PDF untuk item yang belum memiliki file alih media." /><NeedsUnit /></>);

  const berkasList = load.kind === 'ok' ? load.data.berkas : [];
  const deepBerkas = deepItem ? berkasList.find((b) => b.items.some((i) => i.id === deepItem)) : undefined;
  // Pilihan hanya sah bila masih ada di daftar TERKINI (setelah muat ulang,
  // berkas/item yang sudah lengkap hilang dan pilihan lama gugur).
  const berkas = berkasList.find((b) => b.id === (chosenBerkas ?? deepBerkas?.id ?? ''));
  const berkasId = berkas?.id ?? '';
  const wantedItem = chosenItem ?? (deepBerkas ? deepItem! : '');
  // Item yang sedang/selesai diunggah disembunyikan dari pilihan.
  const busyIds = new Set(jobs.filter((j) => j.request.purpose === 'ITEM_PDF' && !j.error && j.progress.stage !== 'dibatalkan').map((j) => j.request.objectId));
  const items = (berkas?.items ?? []).filter((i) => !busyIds.has(i.id) || i.id === wantedItem);
  const selected = items.find((i) => i.id === wantedItem);
  const itemId = selected?.id ?? '';
  const ready = load.kind === 'ok';

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!ready || !selected || !berkas) return setError('Pilih item tanpa PDF terlebih dahulu.');
    if (!file) return setError('Pilih file PDF alih media.');
    if (file.size > ITEM_PDF_MAX) return setError('PDF harus kurang dari 100 MB.');
    const label = `PDF Berkas ${berkas.number ?? '–'} / Item ${selected.number ?? '–'}`;
    uploads.start({ purpose: 'ITEM_PDF', objectId: selected.id, file, fileName: file.name, mime: 'application/pdf', unitId }, label, (r) => {
      retry();
      const tasks = (r.result as { drive_tasks?: unknown[] } | null)?.drive_tasks;
      if (tasks?.length) runDriveTasks(getToken, unitId);
    });
    setNotice(`${label}: unggahan dimulai. Anda dapat memilih item berikutnya sambil menunggu.`);
    setChosenItem('');
    if (deepItem) setSp({}, { replace: true });
    setFile(null);
    setFileKey((k) => k + 1);
  }

  async function scan() {
    try {
      const r = await scanToPdf();
      if (r) setFile(new File([r.pdf], r.fileName, { type: 'application/pdf' }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Pemindai tidak tersedia.');
    }
  }

  return (
    <>
      <PageHeader title="Alih Media Arsip" subtitle="Lengkapi PDF untuk item yang sebelumnya disimpan tanpa file alih media." />
      <Alert tone="info">
        <strong>Nomor dan nama file otomatis.</strong>{' '}
        <span>Sistem memakai nomor berkas, nomor item, dan uraian terbaru. Item yang sudah memiliki PDF dikelola melalui menu Perubahan Arsip.</span>
      </Alert>
      {load.kind === 'error' ? (
        <div className="stack"><Alert tone="error" message={load.message} /><button type="button" className="btn btn-secondary" onClick={retry}>Coba lagi</button></div>
      ) : (
        <form className="card" onSubmit={submit} noValidate>
          {load.kind === 'ok' ? <p className="muted small">{formatNumber(load.data.total_missing)} item belum memiliki PDF.</p> : null}
          <div className="form-grid-2">
            <div className="field">
              <label htmlFor={ids.b}>Berkas induk *</label>
              <select id={ids.b} value={berkasId} disabled={!ready || !berkasList.length} onChange={(e) => { setChosenBerkas(e.target.value); setChosenItem(''); if (deepItem) setSp({}, { replace: true }); }}>
                <option value="">{load.kind === 'loading' ? 'Memuat daftar berkas…' : berkasList.length ? 'Pilih berkas induk' : 'Semua item sudah memiliki PDF'}</option>
                {berkasList.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor={ids.i}>Item tanpa PDF *</label>
              <select id={ids.i} value={itemId} disabled={!berkasId} onChange={(e) => setChosenItem(e.target.value)}>
                <option value="">{berkasId ? 'Pilih item' : 'Pilih berkas terlebih dahulu'}</option>
                {items.map((it) => <option key={it.id} value={it.id}>{it.label}</option>)}
              </select>
            </div>
          </div>
          <div className="media-info" aria-live="polite">
            {selected && berkas ? (
              <>
                <strong>Berkas {berkas.number ?? '–'} / Item {selected.number ?? '–'}</strong>
                <span>{selected.description}</span>
                <span className="muted small">
                  {formatDate(selected.document_date)} · {selected.page_count} lembar{selected.planned_file_name ? ` · nama file: ${selected.planned_file_name}` : ''} ·{' '}
                  <Link to={`/cari/item/${encodeURIComponent(selected.id)}`}>Detail arsip</Link>
                </span>
              </>
            ) : (
              <span className="muted">Pilih item yang akan dilengkapi alih medianya.</span>
            )}
          </div>
          <PdfPicker key={fileKey} id={ids.f} label="PDF alih media *" file={file} onChange={setFile}
            hint="PDF harus kurang dari 100 MB. Upload dikirim bertahap dan dapat dilanjutkan bila koneksi terputus." />
          <div className="action-row">
            <button type="button" className="btn btn-secondary" disabled={!SCANNER_AVAILABLE} onClick={() => void scan()}>
              Pindai dengan kamera{SCANNER_AVAILABLE ? '' : ' (Sprint 6)'}
            </button>
          </div>
          {error ? <Alert tone="error"><span>{error}</span></Alert> : null}
          {notice ? <Alert tone="success"><span>{notice}</span></Alert> : null}
          <div className="form-actions-bar">
            <span className="save-stage" aria-live="polite">
              {jobs.filter((j) => j.request.purpose === 'ITEM_PDF' && j.progress.stage === 'mengunggah').map((j) => `${j.label}: ${STAGE_LABELS[j.progress.stage]} ${percent(j.progress)}%`).join(' · ')}
            </span>
            <button type="submit" className="btn btn-primary" disabled={!ready}>Upload Alih Media</button>
          </div>
        </form>
      )}
    </>
  );
}
