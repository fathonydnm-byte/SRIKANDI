import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { Alert } from '../../components/Alert';
import { BrandMark } from '../../components/BrandMark';
import { Sheet } from '../../components/Sheet';
import { s2, type ReceiptPrint } from '../../lib/s2api';
import { useLoad } from '../../lib/useLoad';
import { CONDITION_LABEL, DEV_LABEL, errorMessage, formatTimestamp } from './common';

/**
 * Tanda Terima Penyerahan Arsip (port 3.x ReceiptPrint.html) — dicetak lewat
 * dialog cetak browser (A4; "Simpan sebagai PDF" juga bisa), dari HP pun bisa.
 *  - ≤ 3 item dan teks pendek: kedua salinan dalam SATU halaman A4, dengan
 *    garis "GUNTING DI GARIS INI" (3.x receiptCanUseHalfPage_);
 *  - selain itu: dua salinan (UNTUK PENYERAH / UNTUK PENERIMA), masing-masing
 *    mulai di halaman baru; tabel berlanjut otomatis dengan judul kolom berulang.
 */
export function canUseHalfPage(p: Pick<ReceiptPrint, 'items' | 'notes'>): boolean {
  if (p.items.length > 3) return false;
  const lines = p.items.reduce((sum, it) => sum + Math.max(1, Math.ceil((it.description ?? '').length / 60)), 0);
  const noteLines = p.notes ? Math.ceil(p.notes.length / 100) : 0;
  return lines <= 7 && noteLines <= 2;
}

function Copy({ p, label, compact }: { p: ReceiptPrint; label: string; compact: boolean }) {
  const totalPages = p.items.reduce((s, it) => s + Number(it.page_count || 0), 0);
  return (
    <section className={`rp-copy${compact ? ' compact' : ''}${p.status === 'DIBATALKAN' ? ' is-cancelled' : ''}`} aria-label={`Salinan ${label}`}>
      {p.status === 'DIBATALKAN' ? <div className="rp-watermark" aria-hidden="true">DIBATALKAN</div> : null}
      <header className="rp-head">
        <span className="rp-logo"><BrandMark size={compact ? 34 : 44} /></span>
        <div className="rp-title">
          <strong>TANDA TERIMA PENYERAHAN ARSIP</strong>
          <span>{compact ? 'UIN SUNAN AMPEL SURABAYA' : 'UNIVERSITAS ISLAM NEGERI SUNAN AMPEL SURABAYA'}</span>
          <span className="rp-number">Nomor: {p.number}</span>
        </div>
        <div className="rp-copy-label">
          <strong>{label}</strong>
          {p.is_reprint ? <span className="rp-reprint">CETAK ULANG{compact ? '' : ` - KE-${p.print_number}`}</span> : null}
        </div>
      </header>
      <dl className="rp-meta">
        <div><dt>{compact ? 'Tanggal/Jam' : 'Tanggal dan jam penerimaan'}</dt><dd>: {formatTimestamp(p.received_at)}</dd></div>
        <div><dt>{compact ? 'Penyerah' : 'Pegawai penyerah'}</dt><dd>: {p.sender_name} - {p.sender_unit}</dd></div>
        <div><dt>{compact ? 'Penerima' : 'Penerima arsip'}</dt><dd>: {p.receiver_name} - {p.receiver_unit}</dd></div>
        {!compact ? <div><dt>Lokasi</dt><dd>: {p.location || 'Surabaya'}</dd></div> : null}
      </dl>
      <table className="rp-table">
        <thead>
          <tr><th>No.</th><th>Uraian Informasi Arsip</th><th>Hal.</th><th>Tingkat</th><th>Kondisi</th></tr>
        </thead>
        <tbody>
          {p.items.map((it, i) => (
            <tr key={i}>
              <td className="c">{it.number || i + 1}</td>
              <td>{it.description}</td>
              <td className="c">{it.page_count}</td>
              <td className="c">{DEV_LABEL[it.development_level] ?? it.development_level}</td>
              <td className="c">{CONDITION_LABEL[it.condition] ?? it.condition}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="rp-total">{p.items.length} item{compact ? '' : ' arsip'} | {totalPages} lembar</p>
      {p.notes ? <p className="rp-notes"><strong>Catatan:</strong> {p.notes}</p> : null}
      <p className="rp-statement">
        {compact
          ? 'Arsip fisik tersebut telah diserahkan dan diterima sesuai daftar di atas.'
          : 'Dengan ini kedua pihak menyatakan bahwa arsip fisik tersebut telah diserahkan dan diterima sesuai daftar di atas.'}
      </p>
      {p.status === 'DIBATALKAN' && p.cancellation_reason ? <p className="rp-cancel">Dibatalkan: {p.cancellation_reason}</p> : null}
      <div className="rp-sign">
        <div><span>Yang Menyerahkan,</span><span className="rp-line" /><strong>({p.sender_name})</strong></div>
        <div><span>Yang Menerima,</span><span className="rp-line" /><strong>({p.receiver_name})</strong></div>
      </div>
    </section>
  );
}

export function ReceiptPrintPage() {
  const { receiptId = '' } = useParams();
  const { client } = useAuth();
  const [load, retry] = useLoad(`print:${receiptId}`, () => s2.receiptPrintPrepare(client, receiptId));
  const [asking, setAsking] = useState(false);
  const [confirmed, setConfirmed] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const after = () => setAsking(true);
    window.addEventListener('afterprint', after);
    return () => window.removeEventListener('afterprint', after);
  }, []);

  if (load.kind === 'loading') return <p className="muted detail-loading" role="status">Menyiapkan tanda terima…</p>;
  if (load.kind === 'error') {
    return (
      <div className="stack">
        <Alert tone="error" message={load.message} />
        <button type="button" className="btn btn-secondary" onClick={retry}>Coba lagi</button>
      </div>
    );
  }
  const p = load.data;
  const half = canUseHalfPage(p);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const r = await s2.receiptPrintConfirm(client, p.receipt_id, p.print_token, p.file_name);
      setConfirmed(r.print_count);
      setAsking(false);
    } catch (e) {
      const m = errorMessage(e);
      setError(`${m.title} ${m.action}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="no-print print-toolbar">
        <Link className="back-link" to="/penerimaan">‹ Penerimaan Naskah</Link>
        <h1 tabIndex={-1} id="page-title" className="print-title">Tanda Terima {p.number}</h1>
        <p className="muted small">
          {half ? 'Dua salinan dalam satu lembar A4 — gunting di garis tengah.' : 'Dua salinan (untuk penyerah dan penerima), masing-masing mulai di lembar baru.'}
          {' '}Di HP, pilih “Simpan sebagai PDF” atau printer pada dialog cetak.
        </p>
        {confirmed !== null ? <Alert tone="success"><span>Cetakan ke-{confirmed} tercatat.</span></Alert> : null}
        {p.status === 'DIBATALKAN' ? <Alert tone="warning"><span>Tanda terima ini sudah dibatalkan; cetakan diberi tanda DIBATALKAN.</span></Alert> : null}
        <div className="action-row">
          <button type="button" className="btn btn-primary" onClick={() => window.print()}>
            {p.is_reprint ? 'Cetak Ulang' : 'Cetak Tanda Terima'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setAsking(true)}>Tandai sudah dicetak</button>
        </div>
      </div>
      <div className={`rp-root${half ? ' half' : ''}`}>
        {half ? (
          <div className="rp-page">
            <Copy p={p} label="UNTUK PENYERAH" compact />
            <div className="rp-cut" aria-hidden="true"><span>GUNTING DI GARIS INI</span></div>
            <Copy p={p} label="UNTUK PENERIMA" compact />
          </div>
        ) : (
          <>
            <div className="rp-page"><Copy p={p} label="UNTUK PENYERAH" compact={false} /></div>
            <div className="rp-page rp-break"><Copy p={p} label="UNTUK PENERIMA" compact={false} /></div>
          </>
        )}
      </div>
      {asking ? (
        <Sheet title="Konfirmasi cetak" onClose={() => setAsking(false)} variant="dialog">
          <div className="stack">
            <p>Apakah tanda terima <strong>{p.number}</strong> sudah tercetak dengan baik?</p>
            {error ? <Alert tone="error"><span>{error}</span></Alert> : null}
            <div className="action-row">
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void confirm()}>{busy ? 'Mencatat…' : 'Ya, sudah tercetak'}</button>
              <button type="button" className="btn btn-secondary" onClick={() => setAsking(false)}>Belum</button>
            </div>
          </div>
        </Sheet>
      ) : null}
    </>
  );
}
