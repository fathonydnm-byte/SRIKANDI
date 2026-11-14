import { useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth/AuthContext';
import { Alert } from '../../components/Alert';
import { PageHeader } from '../../components/PageHeader';
import { isBusinessError, newRequestId } from '../../lib/api';
import type { UserMessage } from '../../lib/errors';
import { formatDate, formatNumber } from '../../lib/format';
import { runDriveTasks, s2, type ArchiveCategory, type BerkasOption, type BerkasTarget, type FilingOptions, type QueueItem, type RegistrationOptions } from '../../lib/s2api';
import { uploads } from '../../lib/uploadStore';
import { useLoad } from '../../lib/useLoad';
import { ClassificationPicker } from './ClassificationPicker';
import { DEV_LABEL, errorMessage, NeedsUnit, PdfPicker, SaveStage, SECURITY_LABEL, todayJakarta, useGetToken, useWriteUnit } from './common';

const ITEM_PDF_MAX = 104857599; // < 100 MB (API_S2 §4)

interface NewBerkas {
  title: string;
  classification_id: string | null;
  active_retention_value: string;
  active_retention_unit: 'TAHUN' | 'BULAN';
  inactive_retention_value: string;
  inactive_retention_unit: 'TAHUN' | 'BULAN';
  final_disposition: string;
  filing_cabinet: string;
  drawer: string;
  notes: string;
  categories: Partial<Record<ArchiveCategory['key'], boolean>>;
}
const blankBerkas = (): NewBerkas => ({
  title: '', classification_id: null, active_retention_value: '', active_retention_unit: 'TAHUN', inactive_retention_value: '', inactive_retention_unit: 'TAHUN',
  final_disposition: '', filing_cabinet: '', drawer: '', notes: '', categories: {},
});

/** Kategori CF-01 → arsip_vital/arsip_terjaga (hanya yang ditawarkan server). */
function categoryFlags(cats: ArchiveCategory[] | undefined, chosen: NewBerkas['categories']): { arsip_vital?: boolean; arsip_terjaga?: boolean } {
  const out: { arsip_vital?: boolean; arsip_terjaga?: boolean } = {};
  for (const c of cats ?? []) out[c.key] = chosen[c.key] ?? c.default;
  return out;
}

interface ManualItem {
  primary_letter_number: string;
  alternate_letter_number: string;
  document_date: string;
  page_count: string;
  development_level: 'ASLI' | 'COPY';
  security_classification: 'BIASA/TERBUKA' | 'TERBATAS' | 'RAHASIA' | 'SANGAT RAHASIA';
  description: string;
  notes: string;
}
const blankItem = (): ManualItem => ({
  primary_letter_number: '', alternate_letter_number: '', document_date: todayJakarta(), page_count: '1', development_level: 'ASLI',
  security_classification: 'BIASA/TERBUKA', description: '', notes: '',
});

interface SavedLine {
  berkasId: string;
  text: string;
}

function QueueList({ data, selected, setSelected, filed }: { data: FilingOptions; selected: Set<string>; setSelected(s: Set<string>): void; filed: Set<string> }) {
  const [q, setQ] = useState('');
  const id = useId();
  const items = useMemo(() => {
    const t = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return data.items.filter((it) => !filed.has(it.id)).filter((it) => {
      if (!t.length) return true;
      const c = [it.receipt_number, it.sender_name, it.sender_unit, it.primary_letter_number, it.alternate_letter_number, it.description].join(' ').toLowerCase();
      return t.every((x) => c.includes(x));
    });
  }, [data.items, q, filed]);
  const max = data.max_batch_size || 100;
  const pages = data.items.filter((i) => selected.has(i.id)).reduce((s, i) => s + i.page_count, 0);
  function toggle(it: QueueItem) {
    const next = new Set(selected);
    if (next.has(it.id)) next.delete(it.id);
    else if (next.size < max) next.add(it.id);
    setSelected(next);
  }
  return (
    <div className="stack-tight">
      <div className="field">
        <label htmlFor={id}>Cari item penerimaan</label>
        <div className="field-control">
          <input id={id} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nomor tanda terima, penyerah, nomor surat, atau uraian" />
        </div>
      </div>
      <p className="muted small">
        {formatNumber(data.summary.pending)} menunggu · {formatNumber(data.summary.incomplete)} perlu dilengkapi · {formatNumber(data.summary.filed)} sudah diberkaskan
        {data.truncated ? ` · menampilkan ${data.items.length} dari ${data.total_queue}` : ''}
      </p>
      {items.length === 0 ? (
        <p className="arc-empty">{data.items.length ? 'Tidak ada item yang cocok.' : 'Tidak ada item penerimaan yang menunggu pemberkasan.'}</p>
      ) : (
        <ul className="queue-list">
          {items.map((it) => {
            const checked = selected.has(it.id);
            const disabled = !it.selectable || (!checked && selected.size >= max);
            return (
              <li key={it.id} className={`queue-item${checked ? ' is-selected' : ''}${!it.selectable ? ' is-blocked' : ''}`}>
                <label className="queue-check">
                  <input type="checkbox" checked={checked} disabled={disabled} onChange={() => toggle(it)} />
                  <span className="queue-main">
                    <span className="queue-top">
                      <strong>{it.receipt_number} / {it.receipt_item_number}</strong>
                      <span className="muted small">{formatDate(it.document_date)}</span>
                      {!it.selectable ? <span className="badge-pill badge-warn">Perlu dilengkapi</span> : null}
                    </span>
                    <span className="queue-desc">{it.description}</span>
                    <span className="muted small">
                      {it.primary_letter_number || it.alternate_letter_number || 'Tanpa nomor surat'} · {it.page_count} hlm · {DEV_LABEL[it.development_level] ?? it.development_level} · {SECURITY_LABEL[it.security_classification] ?? it.security_classification} · {it.sender_name}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <p className="queue-selected" role="status" aria-live="polite">
        {selected.size ? `${selected.size} item dipilih · ${pages} halaman (maks. ${max} per penyimpanan)` : 'Belum ada item dipilih.'}
      </p>
    </div>
  );
}

function BerkasSection({ opts, mode, setMode, berkasId, setBerkasId, nb, setNb, errors, extraBerkas }: {
  opts: RegistrationOptions; mode: 'EXISTING' | 'NEW'; setMode(m: 'EXISTING' | 'NEW'): void; berkasId: string; setBerkasId(id: string): void;
  nb: NewBerkas; setNb(n: NewBerkas): void; errors: Record<string, string>; extraBerkas: BerkasOption[];
}) {
  const id = useId();
  const [filter, setFilter] = useState('');
  const berkas = useMemo(() => {
    const all = [...extraBerkas.filter((x) => !opts.berkas.some((b) => b.id === x.id)), ...opts.berkas];
    const t = filter.trim().toLowerCase();
    return t ? all.filter((b) => `${b.number ?? ''} ${b.title} ${b.classification_code ?? ''}`.toLowerCase().includes(t) || b.id === berkasId) : all;
  }, [opts.berkas, extraBerkas, filter, berkasId]);
  const set = <K extends keyof NewBerkas>(k: K, v: NewBerkas[K]) => setNb({ ...nb, [k]: v });
  const fe = (k: string) => (errors[k] ? <small className="field-error">{errors[k]}</small> : null);
  return (
    <section aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`} className="subsection-title">Pilih Berkas Induk</h3>
      <p className="muted small">Metadata berkas cukup diisi sekali. Setelah menyimpan, Anda dapat langsung memasukkan item berikutnya.</p>
      <div className="mode-switch" role="group" aria-label="Mode berkas">
        <button type="button" className={`mode-button${mode === 'EXISTING' ? ' active' : ''}`} aria-pressed={mode === 'EXISTING'} onClick={() => setMode('EXISTING')}>Pilih Berkas yang Ada</button>
        <button type="button" className={`mode-button${mode === 'NEW' ? ' active' : ''}`} aria-pressed={mode === 'NEW'} onClick={() => setMode('NEW')}>Buat Berkas Baru</button>
      </div>
      {mode === 'EXISTING' ? (
        <div className="form-grid-2">
          <div className="field">
            <label htmlFor={`${id}-f`}>Saring berkas</label>
            <div className="field-control">
              <input id={`${id}-f`} type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Nomor, judul, atau kode klasifikasi" />
            </div>
          </div>
          <div className={`field${errors.berkas ? ' field-invalid' : ''}`}>
            <label htmlFor={`${id}-b`}>Berkas induk *</label>
            <select id={`${id}-b`} value={berkasId} onChange={(e) => setBerkasId(e.target.value)}>
              <option value="">Pilih berkas induk</option>
              {berkas.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
            </select>
            {fe('berkas')}
          </div>
        </div>
      ) : (
        <div className="stack-tight">
          <div className={`field${errors.title ? ' field-invalid' : ''}`}>
            <label htmlFor={`${id}-t`}>Judul berkas *</label>
            <div className="field-control"><input id={`${id}-t`} value={nb.title} maxLength={500} onChange={(e) => set('title', e.target.value)} autoComplete="off" /></div>
            {fe('title')}
          </div>
          <h4 className="mini-title">Kode Klasifikasi</h4>
          <ClassificationPicker all={opts.classifications} value={nb.classification_id} onChange={(v) => set('classification_id', v)} error={errors.classification} />
          <h4 className="mini-title">Retensi</h4>
          <div className="form-grid-3">
            {(['active', 'inactive'] as const).map((k) => (
              <div key={k} className={`field${errors[`${k}_retention`] ? ' field-invalid' : ''}`}>
                <label htmlFor={`${id}-${k}`}>{k === 'active' ? 'Retensi aktif *' : 'Retensi inaktif *'}</label>
                <div className="input-pair">
                  <input id={`${id}-${k}`} type="number" inputMode="numeric" min={0} step={1} value={nb[`${k}_retention_value`]} onChange={(e) => set(`${k}_retention_value`, e.target.value)} />
                  <select aria-label={k === 'active' ? 'Satuan retensi aktif' : 'Satuan retensi inaktif'} value={nb[`${k}_retention_unit`]} onChange={(e) => set(`${k}_retention_unit`, e.target.value as 'TAHUN' | 'BULAN')}>
                    {opts.retention_units.map((u) => <option key={u} value={u}>{u === 'TAHUN' ? 'Tahun' : 'Bulan'}</option>)}
                  </select>
                </div>
                {fe(`${k}_retention`)}
              </div>
            ))}
            <div className={`field${errors.final_disposition ? ' field-invalid' : ''}`}>
              <label htmlFor={`${id}-fd`}>Nasib akhir *</label>
              <select id={`${id}-fd`} value={nb.final_disposition} onChange={(e) => set('final_disposition', e.target.value)}>
                <option value="">Pilih nasib akhir</option>
                {opts.final_dispositions.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
              {fe('final_disposition')}
            </div>
          </div>
          <h4 className="mini-title">Lokasi Fisik</h4>
          <div className="form-grid-3">
            <div className="field"><label htmlFor={`${id}-cab`}>No. Filling Cabinet</label><div className="field-control"><input id={`${id}-cab`} value={nb.filing_cabinet} onChange={(e) => set('filing_cabinet', e.target.value)} autoComplete="off" /></div></div>
            <div className="field"><label htmlFor={`${id}-dr`}>No. Laci</label><div className="field-control"><input id={`${id}-dr`} value={nb.drawer} onChange={(e) => set('drawer', e.target.value)} autoComplete="off" /></div></div>
            <div className="field"><label htmlFor={`${id}-fo`}>No. Folder</label><div className="field-control"><input id={`${id}-fo`} value="Otomatis mengikuti No. Berkas" disabled /></div></div>
          </div>
          {(opts.archive_categories?.length ?? 0) > 0 && (
            <fieldset className="check-group">
              <legend className="mini-title">Kategori Arsip</legend>
              {opts.archive_categories!.map((cat) => (
                <label key={cat.key} className="check-row">
                  <input type="checkbox" checked={nb.categories[cat.key] ?? cat.default}
                    onChange={(e) => set('categories', { ...nb.categories, [cat.key]: e.target.checked })} />
                  <span>{cat.label}</span>
                </label>
              ))}
            </fieldset>
          )}
          <div className="field">
            <label htmlFor={`${id}-mb`}>Media berkas</label>
            <div className="field-control"><input id={`${id}-mb`} value="Otomatis dari media item (mis. TEKSTUAL)" disabled /></div>
          </div>
          <div className="field">
            <label htmlFor={`${id}-bn`}>Catatan berkas</label>
            <textarea id={`${id}-bn`} rows={2} maxLength={1000} value={nb.notes} onChange={(e) => set('notes', e.target.value)} />
          </div>
        </div>
      )}
    </section>
  );
}

/** Registrasi Berkas Baru / Input Arsip (3.x inputPage). */
export function RegistrationPage() {
  const { client } = useAuth();
  const getToken = useGetToken();
  const { unitId, needsUnit } = useWriteUnit();
  const [regLoad, regRetry] = useLoad(`reg:${unitId ?? 'own'}`, () => s2.registrationOptions(client, unitId));
  const [queueNonce, setQueueNonce] = useState(0);
  const [queueLoad, queueRetry] = useLoad(`queue:${unitId ?? 'own'}:${queueNonce}`, () => s2.filingOptions(client, unitId));
  const [source, setSource] = useState<'RECEIPT' | 'MANUAL'>('RECEIPT');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [filed, setFiled] = useState<Set<string>>(() => new Set());
  const [mode, setMode] = useState<'EXISTING' | 'NEW'>('EXISTING');
  const [berkasId, setBerkasId] = useState('');
  const [nb, setNb] = useState<NewBerkas>(blankBerkas);
  const [extraBerkas, setExtraBerkas] = useState<BerkasOption[]>([]);
  const [item, setItem] = useState<ManualItem>(blankItem);
  const [pdf, setPdf] = useState<File | null>(null);
  const [pdfKey, setPdfKey] = useState(0);
  const [requestId, setRequestId] = useState(newRequestId);
  const [stage, setStage] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [stageMsg, setStageMsg] = useState<string | undefined>();
  const [error, setError] = useState<UserMessage | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<SavedLine[]>([]);
  const firstItemField = useRef<HTMLInputElement>(null);
  const ids = { a: useId() };

  if (needsUnit) {
    return (<><PageHeader title="Registrasi Berkas Baru" subtitle="Input berkas dan item dalam satu layar." /><NeedsUnit /></>);
  }

  function target(): BerkasTarget | null {
    const e: Record<string, string> = {};
    if (mode === 'EXISTING') {
      if (!berkasId) e.berkas = 'Pilih berkas induk.';
    } else {
      if (!nb.title.trim()) e.title = 'Judul berkas wajib diisi.';
      const cls = regLoad.kind === 'ok' ? regLoad.data.classifications.find((c) => c.id === nb.classification_id) : undefined;
      if (!cls || !cls.selectable) e.classification = 'Pilih kode klasifikasi sampai tingkat yang boleh dipilih.';
      if (!/^\d+$/.test(nb.active_retention_value)) e.active_retention = 'Isi angka retensi aktif.';
      if (!/^\d+$/.test(nb.inactive_retention_value)) e.inactive_retention = 'Isi angka retensi inaktif.';
      if (!nb.final_disposition) e.final_disposition = 'Pilih nasib akhir.';
    }
    if (source === 'RECEIPT' && !selected.size) e.queue = 'Pilih minimal satu item dari antrean penerimaan.';
    if (source === 'MANUAL') {
      if (!item.description.trim()) e.description = 'Uraian wajib diisi.';
      if (!item.document_date) e.document_date = 'Tanggal naskah wajib diisi.';
      if (!/^\d+$/.test(item.page_count) || Number(item.page_count) < 1) e.page_count = 'Jumlah halaman minimal 1.';
      if (pdf && pdf.size > ITEM_PDF_MAX) e.pdf = 'PDF harus kurang dari 100 MB.';
    }
    setErrors(e);
    if (Object.keys(e).length) return null;
    if (mode === 'EXISTING') return { mode: 'EXISTING', berkas_id: berkasId };
    return {
      mode: 'NEW', title: nb.title.trim(), classification_id: nb.classification_id!, active_retention_value: Number(nb.active_retention_value),
      active_retention_unit: nb.active_retention_unit, inactive_retention_value: Number(nb.inactive_retention_value), inactive_retention_unit: nb.inactive_retention_unit,
      final_disposition: nb.final_disposition,
      ...(nb.filing_cabinet.trim() ? { filing_cabinet: nb.filing_cabinet.trim() } : {}),
      ...(nb.drawer.trim() ? { drawer: nb.drawer.trim() } : {}),
      ...(nb.notes.trim() ? { notes: nb.notes.trim() } : {}),
      ...categoryFlags(regLoad.kind === 'ok' ? regLoad.data.archive_categories : undefined, nb.categories),
    };
  }

  /** Setelah item pertama, berkas baru dikunci sebagai "berkas yang ada" (3.x). */
  function lockBerkas(id: string, number: number, title: string) {
    setExtraBerkas((prev) => (prev.some((b) => b.id === id) ? prev : [{ id, number, title, classification_code: null, security_classification: null, label: `${number} — ${title}` }, ...prev]));
    setMode('EXISTING');
    setBerkasId(id);
    setNb(blankBerkas());
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (stage === 'saving') return;
    const t = target();
    if (!t) {
      setStage('error');
      setError({ title: 'Data belum lengkap.', action: 'Periksa kolom yang ditandai merah.' });
      return;
    }
    setStage('saving');
    setError(null);
    try {
      if (source === 'RECEIPT') {
        const idsToFile = [...selected];
        setStageMsg(`Memberkaskan ${idsToFile.length} item…`);
        const { data } = await s2.filingCommit(client, requestId, idsToFile, t, unitId);
        setFiled((prev) => new Set([...prev, ...idsToFile]));
        setSelected(new Set());
        lockBerkas(data.berkas_id, data.berkas_number, data.berkas_title);
        setSaved((prev) => [
          ...data.items.map((it) => ({ berkasId: data.berkas_id, text: `Berkas ${it.berkas_number} / Item ${it.item_number} — ${it.description}` })),
          ...prev,
        ].slice(0, 30));
        setStageMsg(`${data.item_count} item diberkaskan ke Berkas ${data.berkas_number}.${data.renumbered_item_count ? ` ${data.renumbered_item_count} item lain dinomori ulang.` : ''}`);
        if (data.drive_tasks?.length) runDriveTasks(getToken, unitId);
        setQueueNonce((n) => n + 1); // muat ulang antrean di latar
      } else {
        setStageMsg('Menyimpan item…');
        const { data } = await s2.itemCreateManual(client, requestId, t, {
          ...(item.primary_letter_number.trim() ? { primary_letter_number: item.primary_letter_number.trim() } : {}),
          ...(item.alternate_letter_number.trim() ? { alternate_letter_number: item.alternate_letter_number.trim() } : {}),
          document_date: item.document_date, description: item.description.trim(), page_count: Number(item.page_count),
          development_level: item.development_level, security_classification: item.security_classification,
          ...(item.notes.trim() ? { notes: item.notes.trim() } : {}),
        }, unitId);
        const title = t.mode === 'NEW' ? t.title : (regLoad.kind === 'ok' ? regLoad.data.berkas.find((b) => b.id === data.berkas_id)?.title : undefined) ?? extraBerkas.find((b) => b.id === data.berkas_id)?.title ?? '';
        lockBerkas(data.berkas_id, data.berkas_number, title);
        setSaved((prev) => [{ berkasId: data.berkas_id, text: `Berkas ${data.berkas_number} / Item ${data.item_number} — ${item.description.trim()}` }, ...prev].slice(0, 30));
        // PDF diunggah SETELAH metadata tersimpan, di latar; input berikutnya langsung siap.
        if (pdf) {
          uploads.start({ purpose: 'ITEM_PDF', objectId: data.item_id, file: pdf, fileName: pdf.name, mime: 'application/pdf', unitId }, `PDF Berkas ${data.berkas_number} / Item ${data.item_number}`, (r) => {
            const tasks = (r.result as { drive_tasks?: unknown[] } | null)?.drive_tasks;
            if (tasks?.length) runDriveTasks(getToken, unitId);
          });
        }
        if (data.drive_tasks?.length) runDriveTasks(getToken, unitId);
        setStageMsg(`Tersimpan: Berkas ${data.berkas_number} / Item ${data.item_number}.${pdf ? ' PDF sedang diunggah.' : ''}${data.renumbered_item_count ? ` ${data.renumbered_item_count} item lain dinomori ulang.` : ''}`);
        setItem(blankItem());
        setPdf(null);
        setPdfKey((k) => k + 1);
        firstItemField.current?.focus();
      }
      setRequestId(newRequestId());
      setStage('saved');
    } catch (err) {
      setError(errorMessage(err));
      setStage('error');
      setStageMsg(undefined);
      if (isBusinessError(err)) setRequestId(newRequestId());
    }
  }

  const setI = <K extends keyof ManualItem>(k: K, v: ManualItem[K]) => setItem((p) => ({ ...p, [k]: v }));
  const fe = (k: string) => (errors[k] ? <small className="field-error">{errors[k]}</small> : null);

  return (
    <>
      <PageHeader title="Registrasi Berkas Baru" subtitle="Input berkas dan item dalam satu layar." />
      {regLoad.kind === 'error' ? (
        <div className="stack"><Alert tone="error" message={regLoad.message} /><button type="button" className="btn btn-secondary" onClick={regRetry}>Coba lagi</button></div>
      ) : regLoad.kind === 'loading' ? (
        <p className="muted detail-loading" role="status">Memuat data registrasi…</p>
      ) : (
        <form className="card registration-form" onSubmit={submit} noValidate>
          <section>
            <div className="section-heading">
              <div>
                <h2 className="section-title">Sumber Registrasi Item</h2>
                <p className="muted small">Pilih item yang sudah diregistrasi saat penerimaan, atau gunakan input manual untuk arsip lama.</p>
              </div>
              {source === 'RECEIPT' ? <button type="button" className="btn btn-secondary btn-sm" onClick={queueRetry}>Segarkan Antrean</button> : null}
            </div>
            <div className="mode-switch" role="group" aria-label="Sumber registrasi item">
              <button type="button" className={`mode-button${source === 'RECEIPT' ? ' active' : ''}`} aria-pressed={source === 'RECEIPT'} onClick={() => setSource('RECEIPT')}>Dari Penerimaan Arsip</button>
              <button type="button" className={`mode-button${source === 'MANUAL' ? ' active' : ''}`} aria-pressed={source === 'MANUAL'} onClick={() => setSource('MANUAL')}>Input Manual</button>
            </div>
            {source === 'RECEIPT' ? (
              queueLoad.kind === 'ok' ? (
                <QueueList data={queueLoad.data} selected={selected} setSelected={setSelected} filed={filed} />
              ) : queueLoad.kind === 'error' ? (
                <Alert tone="error" message={queueLoad.message} />
              ) : (
                <p className="muted" role="status">Memuat item penerimaan yang belum diberkaskan…</p>
              )
            ) : null}
            {fe('queue')}
          </section>

          <BerkasSection opts={regLoad.data} mode={mode} setMode={setMode} berkasId={berkasId} setBerkasId={setBerkasId} nb={nb} setNb={setNb} errors={errors} extraBerkas={extraBerkas} />

          {source === 'MANUAL' ? (
            <section aria-labelledby={`${ids.a}-h`}>
              <div className="section-heading">
                <div>
                  <h3 id={`${ids.a}-h`} className="subsection-title">Daftar Isi Berkas / Item Arsip</h3>
                  <p className="muted small">Isi metadata item. PDF alih media dapat diunggah sekarang atau dilengkapi kemudian.</p>
                </div>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setItem(blankItem()); setPdf(null); setPdfKey((k) => k + 1); }}>Bersihkan Item</button>
              </div>
              <div className="form-grid-2">
                <div className="field"><label htmlFor={`${ids.a}-n1`}>Nomor surat utama</label><div className="field-control"><input ref={firstItemField} id={`${ids.a}-n1`} value={item.primary_letter_number} onChange={(e) => setI('primary_letter_number', e.target.value)} placeholder="Nomor UINSA" autoComplete="off" /></div></div>
                <div className="field"><label htmlFor={`${ids.a}-n2`}>Nomor alternatif/vendor</label><div className="field-control"><input id={`${ids.a}-n2`} value={item.alternate_letter_number} onChange={(e) => setI('alternate_letter_number', e.target.value)} autoComplete="off" /></div></div>
                <div className={`field${errors.document_date ? ' field-invalid' : ''}`}><label htmlFor={`${ids.a}-d`}>Tanggal naskah *</label><div className="field-control"><input id={`${ids.a}-d`} type="date" value={item.document_date} onChange={(e) => setI('document_date', e.target.value)} /></div>{fe('document_date')}</div>
                <div className={`field${errors.page_count ? ' field-invalid' : ''}`}><label htmlFor={`${ids.a}-p`}>Jumlah halaman *</label><div className="field-control"><input id={`${ids.a}-p`} type="number" inputMode="numeric" min={1} step={1} value={item.page_count} onChange={(e) => setI('page_count', e.target.value)} /></div>{fe('page_count')}</div>
                <div className="field"><label htmlFor={`${ids.a}-dev`}>Tingkat perkembangan *</label><select id={`${ids.a}-dev`} value={item.development_level} onChange={(e) => setI('development_level', e.target.value as ManualItem['development_level'])}>{regLoad.data.development_levels.map((d) => <option key={d} value={d}>{DEV_LABEL[d] ?? d}</option>)}</select></div>
                <div className="field"><label htmlFor={`${ids.a}-s`}>Klasifikasi keamanan dan akses *</label><select id={`${ids.a}-s`} value={item.security_classification} onChange={(e) => setI('security_classification', e.target.value as ManualItem['security_classification'])}>{regLoad.data.security_classifications.map((s) => <option key={s} value={s}>{SECURITY_LABEL[s] ?? s}</option>)}</select><small className="field-hint">Tingkat keamanan berkas mengikuti item yang paling ketat.</small></div>
                <div className={`field span-all${errors.description ? ' field-invalid' : ''}`}><label htmlFor={`${ids.a}-u`}>Uraian informasi arsip *</label><textarea id={`${ids.a}-u`} rows={3} maxLength={2000} value={item.description} onChange={(e) => setI('description', e.target.value)} />{fe('description')}</div>
                <div className="span-all">
                  <PdfPicker key={pdfKey} id={`${ids.a}-pdf`} label="PDF alih media (opsional)" file={pdf} onChange={setPdf}
                    hint="Ukuran harus kurang dari 100 MB. Kosongkan agar metadata langsung tersimpan; PDF dapat dilengkapi melalui menu Alih Media Arsip." />
                  {fe('pdf')}
                </div>
                <div className="field span-all"><label htmlFor={`${ids.a}-c`}>Catatan item</label><div className="field-control"><input id={`${ids.a}-c`} value={item.notes} maxLength={1000} onChange={(e) => setI('notes', e.target.value)} autoComplete="off" /></div></div>
              </div>
            </section>
          ) : null}

          {error ? <Alert tone="error" message={error} /> : null}
          <div className="form-actions-bar">
            <SaveStage stage={stage} message={stageMsg} />
            <button type="submit" className="btn btn-primary" disabled={stage === 'saving'}>
              {stage === 'saving' ? 'Menyimpan…' : source === 'RECEIPT' ? 'Berkaskan Item Terpilih' : 'Simpan Item'}
            </button>
          </div>
          {saved.length ? (
            <section className="saved-list" aria-label="Hasil penyimpanan terakhir">
              <h3 className="subsection-title">Nomor definitif</h3>
              <ul>
                {saved.map((s, i) => (
                  <li key={i}><Link to={`/cari/berkas/${encodeURIComponent(s.berkasId)}`}>{s.text}</Link></li>
                ))}
              </ul>
              <p className="muted small">Nomor berkas dan item mengikuti urutan kronologis unit dan dapat bergeser saat arsip yang lebih lama ditambahkan.</p>
            </section>
          ) : null}
        </form>
      )}
    </>
  );
}
