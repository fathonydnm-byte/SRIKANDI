import { useEffect, useId, useRef, useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { Alert } from '../Alert';
import { JRA_SOURCE_URL, type JraResult } from '../../lib/jra';
import './jra.css';

export function JraLookup() {
  const { client } = useAuth();
  const id = useId();
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<JraResult | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const current = useRef<AbortController | null>(null);
  const [offset, setOffset] = useState(0);
  useEffect(() => () => { current.current?.abort(); }, []);
  useEffect(() => {
    if (!busy) return;
    const start = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  function stop() {
    current.current?.abort();
    current.current = null;
    setBusy(false);
  }
  async function search(next = 0) {
    stop();
    const text = query.trim();
    if (text.length < 2 || !/[\p{L}\p{N}]/u.test(text)) {
      setError('Masukkan minimal 2 karakter untuk mencari JRA.'); setResult(null); return;
    }
    const ctrl = new AbortController();
    current.current = ctrl;
    setBusy(true); setSeconds(0); setError('');
    const timeout = window.setTimeout(() => ctrl.abort(), 25000);
    try {
      const { data } = await client.auth.getSession();
      if (!data.session) throw new Error('Sesi sudah berakhir. Masuk kembali sebelum mencari.');
      const response = await fetch('/api/jra/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session.access_token}` },
        body: JSON.stringify({ query: text, offset: next, snapshot: next ? result?.snapshot : '' }),
        signal: ctrl.signal,
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const message = body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
          ? body.message : 'Pencarian JRA belum berhasil. Coba lagi.';
        throw new Error(message);
      }
      if (!body || typeof body !== 'object' || !('results' in body) || !Array.isArray(body.results)) {
        throw new Error('Jawaban sumber JRA belum dapat dibaca. Coba lagi.');
      }
      if (current.current !== ctrl) return;
      setOffset(next);
      setResult(body as JraResult);
    } catch (err) {
      if (current.current !== ctrl) return;
      setResult(null);
      setError(ctrl.signal.aborted ? 'Sumber belum merespons. Tekan Cari JRA untuk mencoba lagi.'
        : err instanceof Error ? err.message : 'Pencarian belum berhasil. Coba lagi.');
    } finally {
      window.clearTimeout(timeout);
      if (current.current === ctrl) { current.current = null; setBusy(false); }
    }
  }

  const time = result ? new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' })
    .format(new Date(result.checkedAt)) : '';
  return <section className="jra-lookup stack-tight" aria-labelledby={`${id}-title`}>
    <h4 id={`${id}-title`} className="mini-title">Cek Jadwal Retensi Arsip (JRA)</h4>
    <p className="muted small">Cari kata kunci pada spreadsheet rujukan. Tinjau hasil, lalu isi retensi berkas sesuai jenis arsipnya.</p>
    <div className="jra-search">
      <label className="field" htmlFor={id}>Kata kunci JRA
        <input id={id} type="search" value={query} maxLength={120} placeholder="Contoh: rektor, kepegawaian, atau pengadaan"
          onChange={(e) => { stop(); setQuery(e.target.value); setResult(null); setError(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void search(); } }}
          aria-describedby={`${id}-status`} />
      </label>
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void search()}>Cari JRA</button>
      {busy && <button type="button" className="btn btn-secondary" onClick={stop}>Batalkan pencarian</button>}
    </div>
    <div id={`${id}-status`} role="status" className="muted small">
      {busy ? `Mencari pada sumber JRA… · ${seconds} detik`
        : result ? `${result.total} hasil · diperiksa ${time} WIB` : 'Masukkan minimal 2 karakter, lalu tekan Cari JRA atau Enter.'}
    </div>
    {error && <Alert tone="warning">{error}</Alert>}
    {result && !busy && <div className="jra-results">
      {result.results.length === 0 && <p>Tidak ada hasil untuk “{result.query}”. Coba kata kunci lain.</p>}
      {result.results.map((row) => <article className="jra-result" key={row.row}>
        <h5>{[row.section, row.number].filter(Boolean).join(' · ')}</h5>
        <p className="jra-description">{row.description}</p>
        <dl>
          <dt>Retensi aktif</dt><dd>{row.active || 'Tidak tercantum pada baris ini'}</dd>
          <dt>Retensi inaktif</dt><dd>{row.inactive || 'Tidak tercantum pada baris ini'}</dd>
          <dt>Nasib akhir / keterangan</dt><dd>{row.disposition || 'Tidak tercantum pada baris ini'}</dd>
          {row.mergedRetention && <><dt>Retensi pada sel gabungan sumber</dt><dd>{row.mergedRetention}</dd></>}
        </dl>
        <a href={`${JRA_SOURCE_URL}&range=A${row.row}:I${row.row}`} target="_blank" rel="noopener noreferrer">Lihat baris sumber {row.row}</a>
      </article>)}
      <div className="jra-actions">
        {offset > 0 && <button type="button" className="btn btn-secondary" onClick={() => void search(offset - 10)}>JRA sebelumnya</button>}
        {result.nextOffset !== null && <button type="button" className="btn btn-secondary" onClick={() => void search(result.nextOffset!)}>JRA berikutnya</button>}
      </div>
    </div>}
    <a href={JRA_SOURCE_URL} target="_blank" rel="noopener noreferrer" className="small">Buka spreadsheet rujukan JRA</a>
  </section>;
}
