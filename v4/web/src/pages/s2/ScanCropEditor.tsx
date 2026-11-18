import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Alert } from '../../components/Alert';
import { FULL_PHOTO, validCorners, type Corners, type Point } from '../../lib/perspective';
import { correctScanPhoto } from '../../lib/scan';

const LABELS = ['kiri atas', 'kanan atas', 'kanan bawah', 'kiri bawah'];
const clamp = (value: number) => Math.max(0, Math.min(1, value));

export function ScanCropEditor({
  original, saved, number, onBack, onApply,
}: {
  original: Blob;
  saved?: Corners;
  number: number;
  onBack(): void;
  onApply(jpeg: Blob, corners?: Corners): void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const preview = useRef<HTMLImageElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const task = useRef<AbortController | null>(null);
  const drag = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);
  const instructions = useId();
  const [corners, setCorners] = useState(saved ?? FULL_PHOTO);
  const [ratio, setRatio] = useState(0);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(original);
    if (preview.current) preview.current.src = url;
    heading.current?.focus();
    return () => URL.revokeObjectURL(url);
  }, [original]);

  useEffect(() => () => task.current?.abort(), []);

  function adjust(index: number, { x, y }: Point) {
    setCorners((current) => {
      const next: [Point, Point, Point, Point] = [...current];
      next[index] = { x: clamp(x), y: clamp(y) };
      return next;
    });
  }

  function activateDrag(e: PointerEvent<HTMLButtonElement>, point: Point) {
    if (e.button !== 0 || drag.current || !surface.current) return;
    const box = surface.current.getBoundingClientRect();
    drag.current = { pointerId: e.pointerId, offsetX: e.clientX - box.left - point.x * box.width,
      offsetY: e.clientY - box.top - point.y * box.height };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function moveDrag(e: PointerEvent<HTMLButtonElement>, index: number) {
    const active = drag.current;
    if (active?.pointerId !== e.pointerId || !surface.current) return;
    const box = surface.current.getBoundingClientRect();
    if (box.width && box.height) adjust(index, { x: (e.clientX - box.left - active.offsetX) / box.width,
      y: (e.clientY - box.top - active.offsetY) / box.height });
  }

  function releaseDrag(e: PointerEvent<HTMLButtonElement>) {
    if (drag.current?.pointerId === e.pointerId) drag.current = null;
  }

  function handleKey(e: KeyboardEvent<HTMLButtonElement>, index: number, point: Point) {
    const step = e.shiftKey ? 0.05 : 0.01;
    const delta = { ArrowUp: [0, -step], ArrowDown: [0, step], ArrowLeft: [-step, 0], ArrowRight: [step, 0] }[e.key];
    if (!delta) return;
    e.preventDefault();
    adjust(index, { x: point.x + delta[0]!, y: point.y + delta[1]! });
  }

  async function apply() {
    if (task.current || !ratio || !validCorners(corners)) return;
    const unchanged = corners.every((p, i) => p.x === FULL_PHOTO[i]!.x && p.y === FULL_PHOTO[i]!.y);
    if (unchanged) { onApply(original); return; }

    const controller = new AbortController();
    task.current = controller;
    setError('');
    setProgress(0);
    try {
      const jpeg = await correctScanPhoto(original, corners, controller.signal, setProgress);
      if (!controller.signal.aborted) onApply(jpeg, corners);
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Foto gagal dirapikan.');
    } finally {
      task.current = null;
      if (!controller.signal.aborted) setProgress(null);
    }
  }

  const ready = ratio > 0;
  const valid = validCorners(corners);
  const busy = progress !== null;
  return <section className="stack">
    <h3 ref={heading} tabIndex={-1}>Rapikan perspektif · Halaman {number}</h3>
    <p id={instructions} className="muted">Geser empat penanda ke sudut kertas pada foto asli. Dengan papan ketik, gunakan tombol panah.</p>
    <div className="scan-crop-frame">
      <div ref={surface} className="scan-crop-surface" style={ratio ? { width: `min(100%, ${52 * ratio}dvh)` } : undefined}>
        <img ref={preview} alt="Foto asli untuk penyesuaian sudut" draggable={false}
          onLoad={(e) => {
            const { naturalWidth, naturalHeight } = e.currentTarget;
            if (naturalWidth && naturalHeight) setRatio(naturalWidth / naturalHeight);
          }} onError={() => { setRatio(0); setError('Foto asli tidak dapat ditampilkan.'); }} />
        {ready && <>
          <svg aria-hidden="true" className="scan-crop-outline" viewBox="0 0 100 100" preserveAspectRatio="none">
            <polygon className={valid ? undefined : 'scan-crop-invalid'} vectorEffect="non-scaling-stroke"
              points={corners.map(({ x, y }) => x * 100 + ',' + y * 100).join(' ')} />
          </svg>
          {corners.map((point, i) => <button type="button" className="scan-crop-handle" key={i}
            aria-label={'Sudut ' + LABELS[i]} aria-describedby={instructions}
            style={{ left: point.x * 100 + '%', top: point.y * 100 + '%' }} disabled={busy}
            onPointerDown={(e) => activateDrag(e, point)} onPointerMove={(e) => moveDrag(e, i)}
            onPointerUp={releaseDrag} onPointerCancel={releaseDrag} onLostPointerCapture={releaseDrag}
            onKeyDown={(e) => handleKey(e, i, point)} />)}
        </>}
      </div>
    </div>
    {!valid && <p role="status">Atur sudut agar tidak bersilangan atau terlalu dekat.</p>}
    {busy && <p role="status">Merapikan foto: {progress}%…</p>}
    {error && <Alert tone="warning">{error}</Alert>}
    <div className="scan-actions">
      <button type="button" className="btn btn-secondary" onClick={onBack}>Kembali</button>
      <button type="button" className="btn btn-secondary" disabled={busy || !ready}
        onClick={() => { setCorners(FULL_PHOTO); setError(''); }}>Pakai batas foto asli</button>
      <button type="button" className="btn btn-primary" disabled={busy || !valid || !ready}
        onClick={() => void apply()}>Terapkan</button>
    </div>
  </section>;
}
