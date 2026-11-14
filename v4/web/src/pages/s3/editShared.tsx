import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { newRequestId } from '../../lib/api';
import './editCancel.css';

export const MIN_REASON = 10;

export interface PickOption {
  id: string;
  title: string;
  sub?: string;
  group?: string;
  /** Alasan opsi tidak dapat dipilih; bila ada, opsi nonaktif dan alasannya ditampilkan. */
  disabledReason?: string | undefined;
}

const MAX_SHOWN = 30;

/** Pemilih dengan pencarian teks (berkas/item). Semua isi ditampilkan sebagai teks biasa. */
export function Picker({ label, options, value, onChange, emptyText, placeholder }: { label: string; options: PickOption[]; value: string; onChange(id: string): void; emptyText: string; placeholder?: string }) {
  const searchId = useId();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () => (q ? options.filter((o) => `${o.group ?? ''} ${o.title} ${o.sub ?? ''}`.toLowerCase().includes(q)) : options),
    [options, q],
  );
  const shown = filtered.slice(0, MAX_SHOWN);
  const selected = options.find((o) => o.id === value);
  return (
    <div className="field">
      <label htmlFor={searchId}>{label}</label>
      <input id={searchId} type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={placeholder ?? 'Cari nomor, judul, atau uraian…'} autoComplete="off" />
      {selected ? <p className="pick-selected" role="status">Dipilih: <strong>{selected.title}</strong></p> : null}
      {options.length === 0 ? <p className="muted small">{emptyText}</p> : null}
      <ul className="pick-list" aria-label="Daftar hasil pencarian">
        {shown.map((o, i) => (
          <li key={o.id}>
            {o.group && o.group !== shown[i - 1]?.group ? <p className="pick-group">{o.group}</p> : null}
            <button type="button" className={`pick-option${o.id === value ? ' is-selected' : ''}`} aria-pressed={o.id === value} disabled={Boolean(o.disabledReason)} onClick={() => onChange(o.id)}>
              <span className="pick-title">{o.title}</span>
              {o.sub ? <span className="pick-sub">{o.sub}</span> : null}
              {o.disabledReason ? <span className="pick-why">{o.disabledReason}</span> : null}
            </button>
          </li>
        ))}
      </ul>
      {options.length > 0 && filtered.length === 0 ? <p className="muted small">Tidak ada yang cocok dengan pencarian.</p> : null}
      {filtered.length > MAX_SHOWN ? <p className="muted small">Menampilkan {MAX_SHOWN} dari {filtered.length}. Persempit pencarian.</p> : null}
    </div>
  );
}

export function ReasonField({ label, value, onChange, minLength = MIN_REASON, placeholder, hint }: { label: string; value: string; onChange(v: string): void; minLength?: number; placeholder?: string; hint?: ReactNode }) {
  const id = useId();
  const n = value.trim().length;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <textarea id={id} rows={3} maxLength={2000} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} aria-describedby={`${id}-h`} />
      <small id={`${id}-h`} className={`field-hint reason-counter${n >= minLength ? ' is-ok' : ''}`}>
        <span aria-live="polite">{n} / minimal {minLength} karakter</span> {hint}
      </small>
    </div>
  );
}

export function FilePicker({ label, hint, accept, file, onChange, disabled }: { label: string; hint: string; accept: string; file: File | null; onChange(f: File | null): void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} className="file-input" type="file" accept={accept} disabled={disabled} onChange={(e) => onChange(e.target.files?.[0] ?? null)} aria-describedby={`${id}-h`} />
      <small id={`${id}-h`} className="field-hint">
        {file ? `${file.name} · ${(file.size / (1024 * 1024)).toFixed(1)} MB. ` : ''}
        {hint}
      </small>
    </div>
  );
}

/**
 * Request id per tindakan pengguna: dipakai ulang bila isian yang sama dikirim
 * lagi setelah gangguan jaringan, dan diganti bila isiannya berubah atau
 * server sudah memberi jawaban bisnis (API_S2 §1.3).
 */
export function useRequestKey() {
  const ref = useRef<{ id: string; sig: string } | null>(null);
  return {
    idFor(sig: string): string {
      if (!ref.current || ref.current.sig !== sig) ref.current = { id: newRequestId(), sig };
      return ref.current.id;
    },
    clear() {
      ref.current = null;
    },
  };
}

export function isMimeAllowed(file: File, exts: string[]): boolean {
  const ext = file.name.toLowerCase().split('.').pop() ?? '';
  return exts.includes(ext);
}

export function loanLabel(status: string | null | undefined): string {
  return status && status !== 'TERSEDIA' ? 'Sedang dipinjam' : '';
}
