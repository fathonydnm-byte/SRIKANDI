import { useMemo, type CSSProperties } from 'react';
import logoUrl from '../../assets/uinsa-logo.jpg';
import { layoutLabel, LABEL_H_MM, LABEL_W_MM, placeLabels, slotName, type LabelData, type LabelLayout } from './labelLayout';
import './labels.css';

const PT_MM = 25.4 / 72;
/** Ukuran dalam satuan --u (1 mm saat cetak; menyusut sesuai lebar layar saat pratinjau). */
const mm = (n: number) => `calc(${n} * var(--u))`;
const pt = (n: number) => mm(n * PT_MM);

function Label({ layout }: { layout: LabelLayout }) {
  const head: CSSProperties = { top: mm(layout.headerTopMm), fontSize: pt(layout.headerSize), lineHeight: 1 };
  const title: CSSProperties = { top: mm(layout.titleTopMm), fontSize: pt(layout.titleSize), lineHeight: pt(layout.titleLineHeightPt) };
  return (
    <>
      <img className="lf-logo" src={logoUrl} alt="" />
      <div className="lf-head" style={head}>{layout.header}</div>
      <div className="lf-title" style={title}>
        {layout.titleLines.map((line, i) => <div key={i} className="lf-line">{line}</div>)}
      </div>
    </>
  );
}

/**
 * Lembar A4 lidah folder: satu komponen untuk pratinjau dan cetak, sehingga
 * pratinjau PERSIS hasil cetak (ukuran label 70 × 30 mm dalam satuan --u).
 */
export function LabelSheets({ labels, startSlot }: { labels: readonly LabelData[]; startSlot: number }) {
  const layouts = useMemo(() => new Map(labels.map((l) => [l.berkas_id, layoutLabel(l)])), [labels]);
  const pages = useMemo(() => placeLabels(labels, startSlot), [labels, startSlot]);
  return (
    <div className="lf-sheets" data-testid="label-sheets">
      {pages.map((slots, p) => (
        <section key={p} className="lf-page" aria-label={`Lembar ${p + 1} dari ${pages.length}`}>
          <div className="lf-grid" style={{ gridTemplateColumns: `repeat(2, ${mm(LABEL_W_MM)})`, gridAutoRows: mm(LABEL_H_MM) }}>
            {slots.map((label, s) => {
              const slot = s + 1;
              const skipped = !label && p * 14 + s < startSlot - 1;
              return (
                <div
                  key={s}
                  className={`lf-cell${label ? ' is-filled' : skipped ? ' is-skipped' : ''}`}
                  data-slot={slot}
                  data-label={label ? label.berkas_id : undefined}
                >
                  {label ? <Label layout={layouts.get(label.berkas_id) ?? layoutLabel(label)} /> : null}
                  {!label ? <span className="lf-slot-hint" aria-hidden="true">{skipped ? `${slot} · terpakai` : slot}</span> : null}
                  {!label ? <span className="sr-only">Posisi {slot} ({slotName(slot)}) kosong</span> : null}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
