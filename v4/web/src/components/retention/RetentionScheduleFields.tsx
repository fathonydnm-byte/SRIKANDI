import { useId } from 'react';
import './retention.css';
import { RETENTION_DISPOSITIONS, RETENTION_UNITS, type RetentionDraft, type RetentionUnit } from '../../lib/retention';

export function RetentionScheduleFields({
  value, onChange, errors, units = RETENTION_UNITS, dispositions = RETENTION_DISPOSITIONS, disabled = false,
}: {
  value: RetentionDraft;
  onChange(value: RetentionDraft): void;
  errors?: Record<string, string | undefined>;
  units?: readonly RetentionUnit[];
  dispositions?: readonly string[];
  disabled?: boolean;
}) {
  const id = useId();
  const fieldError = (key: string) => errors?.[key] && <small className="field-error">{errors[key]}</small>;
  return <fieldset className="stack-tight retention-fields" disabled={disabled}>
    <legend className="mini-title">Jadwal Retensi</legend>
    <div className="field">
      <label htmlFor={id + '-date'}>Tanggal mulai perhitungan retensi aktif dan inaktif</label>
      <div className="field-control">
        <input id={id + '-date'} type="date" value={value.retention_reference_date} disabled={value.retention_pending}
          aria-invalid={errors?.retention_reference_date ? true : undefined} aria-describedby={id + '-hint'}
          onChange={(e) => onChange({ ...value, retention_reference_date: e.target.value })} />
      </div>
      <small id={id + '-hint'} className="field-hint">Isi tanggal sesuai acuan JRA, misalnya tanggal pekerjaan selesai. Masa inaktif mulai setelah masa aktif berakhir.</small>
      {fieldError('retention_reference_date')}
    </div>
    <label className="check">
      <input type="checkbox" checked={value.retention_pending}
        onChange={(e) => onChange({ ...value, retention_pending: e.target.checked })} />
      <span>Tanggal acuan belum diketahui</span>
    </label>
    {value.retention_pending && <p className="muted small">Batas retensi dihitung setelah tanggal acuan ditetapkan di Perubahan Arsip.</p>}
    <div className="form-grid-3">
      {(['active', 'inactive'] as const).map((k) => {
        const label = k === 'active' ? 'aktif' : 'inaktif';
        return <div className="field" key={k}>
          <label htmlFor={id + '-' + k}>Retensi {label} *</label>
          <div className="input-pair">
            <input id={id + '-' + k} type="number" inputMode="numeric" min={0} max={12000} step={1} value={value[`${k}_retention_value`]}
              onChange={(e) => onChange({ ...value, [`${k}_retention_value`]: e.target.value })} />
            <select aria-label={`Satuan retensi ${label}`} value={value[`${k}_retention_unit`]}
              onChange={(e) => onChange({ ...value, [`${k}_retention_unit`]: e.target.value as RetentionUnit })}>
              {units.map((u) => <option key={u} value={u}>{u === 'TAHUN' ? 'Tahun' : 'Bulan'}</option>)}
            </select>
          </div>
          {fieldError(`${k}_retention`)}
        </div>;
      })}
      <div className="field">
        <label htmlFor={id + '-fd'}>Nasib akhir *</label>
        <select id={id + '-fd'} value={value.final_disposition} onChange={(e) => onChange({ ...value, final_disposition: e.target.value })}>
          <option value="">Pilih nasib akhir</option>
          {dispositions.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        {fieldError('final_disposition')}
      </div>
    </div>
  </fieldset>;
}
