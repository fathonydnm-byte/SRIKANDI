import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth, useProfile } from '../../auth/AuthContext';
import { can } from '../../auth/permissions';
import { Alert } from '../../components/Alert';
import { PageHeader } from '../../components/PageHeader';
import { CONTENT_PAGE_SIZE, searchScanContent, type ContentSearchResult } from '../../lib/contentSearch';
import { useLoad } from '../../lib/useLoad';
import './content-search.css';

const EMPTY: ContentSearchResult = { results: [], has_more: false };
interface Query { text: string; phrase: boolean; offset: number; revision: number }

export function ContentSearchPage() {
  const { client, activeUnitId } = useAuth();
  const { profile } = useProfile();
  const unit = can(profile.role, 'unit.pilih') ? activeUnitId : null;
  const field = useId();
  const [text, setText] = useState('');
  const [phrase, setPhrase] = useState(false);
  const [query, setQuery] = useState<Query | null>(null);
  const [validation, setValidation] = useState('');
  const [load, retry] = useLoad(
    JSON.stringify([profile.user_id, unit, query]),
    () => query ? searchScanContent(client, query.text, unit, query.phrase, query.offset) : Promise.resolve(EMPTY),
  );

  function submit(e: FormEvent) {
    e.preventDefault();
    const term = text.trim();
    if (term.length < 2) {
      setValidation('Masukkan sedikitnya 2 karakter untuk mencari.');
      return;
    }
    setValidation('');
    setQuery((old) => ({ text: term, phrase, offset: 0, revision: (old?.revision ?? 0) + 1 }));
  }

  function go(step: number) {
    setQuery((current) => current && { ...current, offset: Math.max(0, current.offset + step * CONTENT_PAGE_SIZE) });
  }

  return <>
    <PageHeader title="Cari Isi Berkas" subtitle="Cari kata atau frasa di dalam PDF hasil pindai yang sudah diproses dengan OCR." />
    <form className="card stack" onSubmit={submit} noValidate>
      <div className="content-search-row">
        <div className="field">
          <label htmlFor={field}>Kata atau frasa</label>
          <input type="search" id={field} value={text} maxLength={150}
            onChange={(e) => { setText(e.target.value); setValidation(''); }}
            placeholder="Contoh: keputusan rektor" aria-invalid={validation ? true : undefined} />
        </div>
        <button type="submit" className="btn btn-primary" disabled={Boolean(query) && load.kind === 'loading'}>
          {query && load.kind === 'loading' ? 'Mencari…' : 'Cari'}
        </button>
      </div>
      <label className="check">
        <input type="checkbox" checked={phrase} onChange={(e) => setPhrase(e.target.checked)} />
        <span>Cari frasa berurutan</span>
      </label>
      {validation && <p className="field-error" role="alert">{validation}</p>}
    </form>
    <section className="stack" aria-label="Hasil pencarian isi berkas" aria-busy={Boolean(query) && load.kind === 'loading'}>
      {!query && <p className="muted">Hanya PDF yang sudah masuk indeks OCR yang dapat ditemukan di sini.</p>}
      {query && load.kind === 'loading' && <p role="status">Sedang mencari isi PDF…</p>}
      {query && load.kind === 'error' && <>
        <Alert tone="error" message={load.message} />
        <div><button type="button" className="btn btn-secondary" onClick={retry}>Coba lagi</button></div>
      </>}
      {query && load.kind === 'ok' && <>
        <p className="muted" role="status">
          {load.data.results.length
            ? `${load.data.results.length} hasil untuk “${query.text}” · Halaman hasil ${query.offset / CONTENT_PAGE_SIZE + 1}`
            : `Tidak ada kecocokan untuk “${query.text}”. Coba kata lain atau periksa apakah PDF sudah masuk indeks OCR.`}
        </p>
        <ul className="result-list">
          {load.data.results.map((hit) => (
            <li className="result-card content-search-hit" key={`${hit.item_id}:${hit.page_no}`}>
              <Link to={`/cari/item/${encodeURIComponent(hit.item_id)}`} className="content-search-title">{hit.description || hit.title}</Link>
              <span className="muted small">{hit.unit_code} · Berkas {hit.no_berkas ?? '—'} · Item {hit.no_item ?? '—'} · Halaman PDF {hit.page_no}</span>
              <p>{hit.snippet}</p>
            </li>
          ))}
        </ul>
        {(query.offset > 0 || load.data.has_more) && <nav className="content-search-paging" aria-label="Halaman hasil pencarian">
          <button type="button" className="btn btn-secondary" disabled={!query.offset} onClick={() => go(-1)}>Sebelumnya</button>
          <button type="button" className="btn btn-secondary" disabled={!load.data.has_more} onClick={() => go(1)}>Berikutnya</button>
        </nav>}
      </>}
    </section>
  </>;
}
