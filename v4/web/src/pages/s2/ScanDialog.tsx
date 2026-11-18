import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react';
import { Alert } from '../../components/Alert';
import { MAX_SCAN_PAGES, prepareScanPhoto, scanToPdf, type ScanPage, type ScanResult } from '../../lib/scan';
import { limitScanContent, type ScanContent } from '../../lib/contentSearch';
import type { Corners } from '../../lib/perspective';
import { ScanCropEditor } from './ScanCropEditor';
import './scan.css';

interface Page extends ScanPage { id: number; original?: Blob; corners?: Corners }
const ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif';

function Photo({ page, number }: { page: Page; number: number }) {
  const preview = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const url = URL.createObjectURL(page.jpeg);
    if (preview.current) preview.current.src = url;
    return () => URL.revokeObjectURL(url);
  }, [page.jpeg]);
  return <span className="scan-photo"><img ref={preview} alt={`Pratinjau halaman ${number}`}
    style={{ transform: `rotate(${90 * page.turns}deg)` }} /></span>;
}

export function ScanDialog({ onCancel, onUse }: { onCancel(): void; onUse(result: ScanResult): void }) {
  const node = useRef<HTMLDialogElement>(null);
  const stopped = useRef(false);
  const lock = useRef(false);
  const sequence = useRef(0);
  const ocrTask = useRef<AbortController | null>(null);
  const heading = useId();
  const ocrHint = useId();
  const [pages, setPages] = useState<Page[]>([]);
  const [editingId, setEditingId] = useState<number>();
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [useOcr, setUseOcr] = useState(false);
  const [reading, setReading] = useState(false);

  useEffect(() => {
    const dialog = node.current!;
    stopped.current = false;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    return () => {
      stopped.current = true;
      ocrTask.current?.abort();
      if (dialog.open && typeof dialog.close === 'function') dialog.close();
    };
  }, []);

  function exit() { stopped.current = true; ocrTask.current?.abort(); onCancel(); }

  function closeEditor() {
    setEditingId(undefined);
    requestAnimationFrame(() => node.current?.querySelector<HTMLButtonElement>(`[data-crop-page="${editingId}"]`)?.focus());
  }

  async function add(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.currentTarget.files ?? []);
    e.currentTarget.value = '';
    if (lock.current || !files.length) return;
    const available = MAX_SCAN_PAGES - pages.length;
    const picked = files.slice(0, available);
    if (!picked.length) return;
    lock.current = true;
    setError('');
    let firstError: string | undefined;
    try {
      for (const [n, file] of picked.entries()) {
        if (stopped.current) return;
        setProgress(`Menyiapkan foto ${n + 1} dari ${picked.length}…`);
        try {
          const jpeg = await prepareScanPhoto(file);
          if (stopped.current) return;
          const page = { id: ++sequence.current, jpeg, turns: 0 };
          setPages((current) => [...current, page]);
        } catch (err) {
          if (stopped.current) return;
          firstError ??= `Foto ${n + 1}: ${err instanceof Error ? err.message : 'Gagal membaca foto.'}`;
        }
      }
      if (firstError || picked.length < files.length) {
        setError([firstError, picked.length < files.length ? `Maksimal ${MAX_SCAN_PAGES} halaman per PDF.` : ''].filter(Boolean).join(' '));
      }
    } finally {
      lock.current = false;
      if (!stopped.current) setProgress('');
    }
  }

  function move(index: number, delta: number) {
    setPages((current) => {
      const dest = index + delta;
      if (dest < 0 || dest >= current.length) return current;
      const next = [...current];
      [next[index], next[dest]] = [next[dest]!, next[index]!];
      return next;
    });
  }

  async function finish() {
    if (lock.current || !pages.length) return;
    lock.current = true;
    setError('');
    const pdfProgress = (n: number) => {
      if (!stopped.current) setProgress(`Menyusun PDF: ${n} dari ${pages.length} halaman…`);
    };
    try {
      let layers: (Uint8Array | null)[] | undefined;
      let indexContent: ScanContent | undefined;
      let outcome: ScanResult['ocr'];
      if (useOcr) {
        const controller = new AbortController();
        ocrTask.current = controller;
        setReading(true);
        setProgress('Menyiapkan OCR dan model bahasa…');
        try {
          const { recognizeScan } = await import('../../lib/scanOcr');
          controller.signal.throwIfAborted();
          const recognized = await recognizeScan(pages, controller.signal, (p) => {
            if (!stopped.current && !controller.signal.aborted && p) {
              setProgress(`Membaca teks halaman ${p.page} dari ${p.total} · ${p.percent}%…`);
            }
          });
          layers = recognized.layers;
          outcome = layers.filter(Boolean).length;
          const content = limitScanContent(recognized.pages);
          if (content.pages.some(Boolean)) indexContent = content;
        } catch {
          outcome = controller.signal.aborted ? 'lewati' : 'gagal';
        } finally {
          ocrTask.current = null;
          if (!stopped.current) setReading(false);
        }
      }
      if (stopped.current) return;
      setProgress('Menyiapkan PDF…');
      let result: ScanResult;
      const layerReady = typeof outcome === 'number' && outcome > 0;
      if (layerReady) {
        try {
          result = await scanToPdf(pages, pdfProgress, layers);
        } catch {
          if (stopped.current) return;
          outcome = 'gagal';
          indexContent = undefined;
          setProgress('Menyiapkan PDF tanpa OCR…');
          result = await scanToPdf(pages, pdfProgress);
        }
      } else {
        result = await scanToPdf(pages, pdfProgress);
      }
      if (!stopped.current) onUse(outcome === undefined ? result : {
        ...result, ocr: outcome, ...(indexContent ? { indexContent } : {}),
      });
    } catch (err) {
      if (!stopped.current) setError(err instanceof Error ? err.message : 'PDF gagal disiapkan.');
    } finally {
      lock.current = false;
      if (!stopped.current) setProgress('');
    }
  }

  const busy = Boolean(progress);
  const editIndex = pages.findIndex((p) => p.id === editingId);
  const editing = pages[editIndex];
  return <dialog ref={node} className="scan-dialog" aria-labelledby={heading} onCancel={(e) => { e.preventDefault(); if (editing) closeEditor(); else exit(); }}>
    <div className="stack">
      <h2 id={heading}>Pindai arsip</h2>
      {editing ? <ScanCropEditor original={editing.original ?? editing.jpeg} saved={editing.corners}
        number={editIndex + 1} onBack={closeEditor} onApply={(jpeg, corners) => {
          setPages((current) => current.map((p) => p.id === editing.id ? {
            id: p.id, jpeg, turns: p.turns, ...(corners && { original: p.original ?? p.jpeg, corners }),
          } : p));
          closeEditor();
        }} /> : <>
      <p className="muted">Ambil foto dengan kamera atau pilih foto dari galeri. Periksa urutannya sebelum membuat PDF. Foto baru dikirim setelah Anda menekan Upload Alih Media.</p>
      <div className="scan-actions">
        <label className="btn btn-secondary scan-picker" aria-disabled={busy || pages.length >= MAX_SCAN_PAGES}>
          Ambil foto
          <input aria-label="Ambil foto" type="file" accept={ACCEPT} capture="environment" disabled={busy || pages.length >= MAX_SCAN_PAGES} onChange={(e) => void add(e)} />
        </label>
        <label className="btn btn-secondary scan-picker" aria-disabled={busy || pages.length >= MAX_SCAN_PAGES}>
          Pilih dari galeri
          <input aria-label="Pilih dari galeri" type="file" accept={ACCEPT} multiple disabled={busy || pages.length >= MAX_SCAN_PAGES} onChange={(e) => void add(e)} />
        </label>
      </div>
      <p role="status">{progress || `${pages.length} dari ${MAX_SCAN_PAGES} halaman`}</p>
      {error && <Alert tone="warning">{error}</Alert>}
      <ol className="scan-pages">
        {pages.map((page, i) => <li key={page.id}>
          <Photo page={page} number={i + 1} />
          <div className="stack scan-page-actions">
            <strong>Halaman {i + 1}</strong>
            {page.corners && <span className="muted">Perspektif dirapikan</span>}
            <div className="scan-actions">
              <button type="button" className="btn btn-secondary" data-crop-page={page.id}
                aria-label={`Rapikan sudut halaman ${i + 1}`} disabled={busy}
                onClick={() => setEditingId(page.id)}>Rapikan sudut</button>
              <button type="button" className="btn btn-secondary" aria-label={`Putar halaman ${i + 1}`} disabled={busy}
                onClick={() => setPages((p) => p.map((x) => x.id === page.id ? { ...x, turns: (x.turns + 1) % 4 } : x))}>Putar</button>
              <button type="button" className="btn btn-secondary" aria-label={`Geser halaman ${i + 1} ke atas`} disabled={busy || i === 0} onClick={() => move(i, -1)}>Naik</button>
              <button type="button" className="btn btn-secondary" aria-label={`Geser halaman ${i + 1} ke bawah`} disabled={busy || i === pages.length - 1} onClick={() => move(i, 1)}>Turun</button>
              <button type="button" className="btn btn-secondary" aria-label={`Hapus halaman ${i + 1}`} disabled={busy} onClick={() => setPages((p) => p.filter((x) => x.id !== page.id))}>Hapus</button>
            </div>
          </div>
        </li>)}
      </ol>
      <div className="stack scan-ocr-choice">
        <label className="scan-ocr-toggle">
          <input type="checkbox" checked={useOcr} disabled={busy || !pages.length} aria-describedby={ocrHint}
            onChange={(e) => setUseOcr(e.target.checked)} />
          Kenali teks agar bisa dicari di PDF (OCR)
        </label>
        <p id={ocrHint} className="muted small">Bahasa Indonesia dan Inggris. Proses berjalan di perangkat dan dapat memakan waktu; model bahasa diunduh saat dibutuhkan.</p>
      </div>
      <div className="scan-actions">
        <button type="button" className="btn btn-secondary" onClick={exit}>Batal</button>
        {reading && <button type="button" className="btn btn-secondary" onClick={() => {
          ocrTask.current?.abort();
          setReading(false);
          setProgress('Menyiapkan PDF tanpa OCR…');
        }}>Lewati OCR</button>}
        <button type="button" className="btn btn-primary" disabled={busy || !pages.length} onClick={() => void finish()}>Gunakan PDF</button>
      </div>
      </>}
    </div>
  </dialog>;
}
