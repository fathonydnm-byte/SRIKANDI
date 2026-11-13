import { useId, useMemo } from 'react';
import type { Classification } from '../../lib/s2api';

/**
 * Kode klasifikasi Primer → Sekunder → Tersier (3.x). Sekunder selalu boleh
 * dipilih tanpa tersier; primer hanya boleh bila tidak punya anak aktif.
 * Nilai = id terdalam yang dipilih; valid bila `selectable`.
 */
export function classificationPath(all: Classification[], id: string | null): string[] {
  const byId = new Map(all.map((c) => [c.id, c]));
  const path: string[] = [];
  let cur = id ? byId.get(id) : undefined;
  while (cur && path.length < 5) {
    path.unshift(cur.id);
    cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
  }
  return path;
}

export function ClassificationPicker({ all, value, onChange, error }: { all: Classification[]; value: string | null; onChange(id: string | null): void; error?: string | undefined }) {
  const base = useId();
  const children = useMemo(() => {
    const m = new Map<string | null, Classification[]>();
    for (const c of all) {
      const k = c.parent_id ?? null;
      m.set(k, [...(m.get(k) ?? []), c]);
    }
    for (const list of m.values()) list.sort((a, b) => a.code.localeCompare(b.code, 'id', { numeric: true }));
    return m;
  }, [all]);
  const [p1, p2, p3] = classificationPath(all, value);
  const lvl1 = children.get(null) ?? [];
  const lvl2 = p1 ? children.get(p1) ?? [] : [];
  const lvl3 = p2 ? children.get(p2) ?? [] : [];
  const selected = all.find((c) => c.id === value);
  const needsMore = selected && !selected.selectable;

  const select = (id: string, label: string, list: Classification[], cur: string | undefined, parent: string | undefined, disabled: boolean, placeholder: string) => (
    <div className="field">
      <label htmlFor={`${base}-${id}`}>{label}</label>
      <select id={`${base}-${id}`} value={cur ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || parent || null)} aria-invalid={error ? true : undefined}>
        <option value="">{placeholder}</option>
        {list.map((c) => (
          <option key={c.id} value={c.id}>{c.label || `${c.code} – ${c.description ?? ''}`}</option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="stack-tight">
      <div className="form-grid-3">
        {select('1', 'Primer *', lvl1, p1, undefined, false, 'Pilih primer')}
        {select('2', 'Sekunder', lvl2, p2, p1, !lvl2.length, lvl2.length ? 'Pilih sekunder' : '—')}
        {select('3', 'Tersier (opsional)', lvl3, p3, p2, !lvl3.length, lvl3.length ? 'Pilih tersier' : '—')}
      </div>
      <small className={needsMore || error ? 'field-error' : 'field-hint'}>
        {error ?? (needsMore ? 'Primer ini memiliki turunan: pilih sekunder.' : selected ? `Dipilih: ${selected.code} – ${selected.description ?? ''}` : 'Klasifikasi boleh sampai sekunder. Pilih tersier jika masalah arsip lebih spesifik.')}
      </small>
    </div>
  );
}
