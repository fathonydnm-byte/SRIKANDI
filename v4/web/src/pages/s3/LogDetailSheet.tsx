import { useMemo } from 'react';
import { Sheet } from '../../components/Sheet';
import { diffData, fieldLabel, formatFieldValue, formatLogTime, prettyJson, resultLabel, resultTone, type FieldChange, type MasterLogRow } from '../../lib/masterLog';

function Value({ value }: { value: unknown }) {
  const text = formatFieldValue(value);
  return text === null ? <span className="ml-empty">kosong</span> : <span className="ml-val">{text}</span>;
}

function ChangeItem({ change }: { change: FieldChange }) {
  const label = fieldLabel(change.key);
  return (
    <li className={`ml-change ml-${change.kind}`}>
      <p className="ml-change-key">
        {label}
        <span className="ml-change-kind">{change.kind === 'added' ? 'Ditambahkan' : change.kind === 'removed' ? 'Dihapus' : 'Diubah'}</span>
      </p>
      {change.kind !== 'added' ? (
        <p className="ml-line ml-before">
          <span className="ml-line-tag">Sebelum</span>
          <Value value={change.before} />
        </p>
      ) : null}
      {change.kind !== 'removed' ? (
        <p className="ml-line ml-after">
          <span className="ml-line-tag">Sesudah</span>
          <Value value={change.after} />
        </p>
      ) : null}
    </li>
  );
}

/** Rincian satu entri log; isi log selalu dirender sebagai teks (React meloloskan HTML). */
export function LogDetailSheet({ row, showUnit, onClose }: { row: MasterLogRow; showUnit: boolean; onClose(): void }) {
  const diff = useMemo(() => diffData(row.before_data, row.after_data), [row.before_data, row.after_data]);
  const actor = [row.actor_name, row.actor_email].filter(Boolean);
  const facts: [string, string | null][] = [
    ['Waktu', formatLogTime(row.occurred_at, true)],
    ['Pelaku', actor.length ? actor.join(' · ') : 'Sistem / tidak tercatat'],
    ...(showUnit ? ([['Unit', row.unit_name ? `${row.unit_name}${row.unit_code ? ` (${row.unit_code})` : ''}` : 'Lintas unit']] as [string, string][]) : []),
    ['Modul', row.module],
    ['Objek', [row.object_type, row.object_id].filter(Boolean).join(' · ') || null],
    ['Ringkasan', row.summary],
    ['Alasan', row.reason],
    ['ID permintaan', row.request_id],
    ['ID log', row.id],
  ];
  return (
    <Sheet title="Rincian perubahan" onClose={onClose} variant="dialog">
      <div className="ml-detail stack">
        <p className="ml-detail-head">
          <span className="code">{row.action}</span>
          <span className={`badge-pill badge-${resultTone(row.result)}`}>{resultLabel(row.result)}</span>
        </p>
        <dl className="ml-facts">
          {facts
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
        </dl>

        <section aria-labelledby="ml-diff-title">
          <h3 id="ml-diff-title" className="ml-subtitle">
            Perubahan data
          </h3>
          {diff.empty ? (
            <p className="muted">Entri ini tidak menyimpan data sebelum/sesudah.</p>
          ) : diff.changes.length === 0 ? (
            <p className="muted">Tidak ada kolom yang berbeda antara data sebelum dan sesudah.</p>
          ) : (
            <ul className="ml-changes">
              {diff.changes.map((c) => (
                <ChangeItem key={c.key} change={c} />
              ))}
            </ul>
          )}
          {diff.unchanged.length > 0 ? <p className="muted ml-unchanged">{diff.unchanged.length} kolom lain tidak berubah.</p> : null}
        </section>

        {!diff.empty ? (
          <details className="ml-raw">
            <summary>Tampilkan data mentah (JSON)</summary>
            <h4>Sebelum</h4>
            <pre>{prettyJson(row.before_data)}</pre>
            <h4>Sesudah</h4>
            <pre>{prettyJson(row.after_data)}</pre>
          </details>
        ) : null}
      </div>
    </Sheet>
  );
}
