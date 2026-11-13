import { useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { Alert } from '../../components/Alert';
import { Sheet } from '../../components/Sheet';
import { isBusinessError, newRequestId } from '../../lib/api';
import type { UserMessage } from '../../lib/errors';
import { s2, type Employee, type Receipt, type ReceiptItemInput, type ReceiptOptions, type ReceiptSaveResult } from '../../lib/s2api';
import { CONDITION_LABEL, DEV_LABEL, errorMessage, SaveStage, SECURITY_LABEL, todayJakarta } from './common';

interface ItemDraft extends Omit<ReceiptItemInput, 'page_count'> {
  key: string;
  page_count: string;
  locked: boolean;
  printedLocked: boolean;
}

const PENDING_KEY = 'cf.receipt.pending';

function blankItem(): ItemDraft {
  return {
    key: newRequestId(), receipt_item_id: null, archive_id: null, description: '', page_count: '1', development_level: 'ASLI', condition: 'BAIK',
    security_classification: 'BIASA/TERBUKA', primary_letter_number: '', alternate_letter_number: '', document_date: todayJakarta(), notes: '',
    locked: false, printedLocked: false,
  };
}

function fromReceipt(r: Receipt): ItemDraft[] {
  const evidence = Boolean(r.evidence_file_id);
  return r.items.map((it) => ({
    key: it.id, receipt_item_id: it.id, archive_id: it.archive_id, description: it.description, page_count: String(it.page_count),
    development_level: it.development_level, condition: it.condition, security_classification: it.security_classification,
    primary_letter_number: it.primary_letter_number ?? '', alternate_letter_number: it.alternate_letter_number ?? '',
    document_date: it.document_date ?? '', notes: it.notes ?? '', locked: !it.can_edit, printedLocked: evidence,
  }));
}

type Errors = Record<string, string>;

function validate(sender: string, receiverName: string, receiverUnit: string, items: ItemDraft[]): Errors {
  const e: Errors = {};
  if (!sender) e.sender = 'Pilih pegawai penyerah.';
  if (!receiverName.trim()) e.receiverName = 'Nama penerima wajib diisi.';
  if (!receiverUnit.trim()) e.receiverUnit = 'Unit kerja penerima wajib diisi.';
  if (!items.length) e.items = 'Tambahkan minimal satu item.';
  if (items.length > 100) e.items = 'Maksimal 100 item per tanda terima.';
  items.forEach((it, i) => {
    if (!it.description.trim()) e[`${i}.description`] = 'Uraian wajib diisi.';
    if (!/^\d+$/.test(it.page_count) || Number(it.page_count) < 1) e[`${i}.page_count`] = 'Jumlah halaman minimal 1.';
    if (!it.document_date) e[`${i}.document_date`] = 'Tanggal naskah wajib diisi.';
  });
  return e;
}

function AddEmployeeSheet({ unitId, onAdded, onClose }: { unitId: string | null; onAdded(e: Employee, msg: string): void; onClose(): void }) {
  const { client } = useAuth();
  const [name, setName] = useState('');
  const [unitKerja, setUnitKerja] = useState('');
  const [requestId] = useState(newRequestId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UserMessage | null>(null);
  const ids = { n: useId(), u: useId() };
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !unitKerja.trim()) {
      setError({ title: 'Nama dan unit kerja wajib diisi.', action: 'Lengkapi kedua kolom.' });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { data } = await s2.pegawaiAdd(client, requestId, name.trim(), unitKerja.trim(), unitId);
      onAdded(data.employee, data.message);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }
  return (
    <Sheet title="Tambah Pegawai" onClose={onClose} variant="dialog">
      <form className="stack" onSubmit={submit} noValidate>
        {error ? <Alert tone="error" message={error} /> : null}
        <div className="field">
          <label htmlFor={ids.n}>Nama pegawai *</label>
          <div className="field-control">
            <input id={ids.n} value={name} maxLength={250} onChange={(e) => setName(e.target.value)} autoComplete="off" />
          </div>
        </div>
        <div className="field">
          <label htmlFor={ids.u}>Unit kerja *</label>
          <div className="field-control">
            <input id={ids.u} value={unitKerja} maxLength={250} onChange={(e) => setUnitKerja(e.target.value)} autoComplete="off" />
          </div>
        </div>
        <p className="muted small">Pegawai dengan nama dan unit yang sama tidak dibuat ganda; yang nonaktif diaktifkan kembali.</p>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Menyimpan…' : 'Simpan Pegawai'}
        </button>
      </form>
    </Sheet>
  );
}

export function ReceiptForm({
  options,
  editing,
  unitId,
  onSaved,
  onCancelEdit,
}: {
  options: ReceiptOptions;
  editing: Receipt | null;
  unitId: string | null;
  onSaved(r: ReceiptSaveResult): void;
  onCancelEdit(): void;
}) {
  const { client } = useAuth();
  const [added, setAdded] = useState<Employee[]>([]);
  const employees = useMemo(() => {
    const map = new Map(options.employees.map((e) => [e.id, e]));
    for (const e of added) if (!map.has(e.id)) map.set(e.id, e);
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label, 'id'));
  }, [options.employees, added]);
  const [sender, setSender] = useState(editing?.sender_employee_id ?? '');
  const [receiverName, setReceiverName] = useState(editing?.receiver_name ?? options.defaults.receiver_name ?? '');
  const [receiverUnit, setReceiverUnit] = useState(editing?.receiver_unit ?? options.defaults.receiver_unit ?? '');
  const [notes, setNotes] = useState(editing?.notes ?? '');
  const [items, setItems] = useState<ItemDraft[]>(() => (editing ? fromReceipt(editing) : [blankItem()]));
  const [requestId, setRequestId] = useState(newRequestId);
  const [stage, setStage] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<UserMessage | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [addingEmployee, setAddingEmployee] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const senderRef = useRef<HTMLSelectElement>(null);
  const formId = useId();


  const headerLocked = Boolean(editing && !editing.can_edit_header);
  const structureLocked = Boolean(editing?.evidence_file_id);
  const totalPages = items.reduce((s, it) => s + (Number(it.page_count) || 0), 0);
  const senderInfo = employees.find((e) => e.id === sender);

  function setItem(i: number, patch: Partial<ItemDraft>) {
    setItems((prev) => prev.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (stage === 'saving') return; // ketuk ganda
    const v = validate(sender, receiverName, receiverUnit, items);
    setErrors(v);
    if (Object.keys(v).length) {
      setError({ title: 'Data belum lengkap.', action: 'Periksa kolom yang ditandai merah.' });
      setStage('error');
      return;
    }
    setStage('saving');
    setError(null);
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify({ requestId, at: Date.now() }));
    } catch {
      // penyimpanan lokal tidak tersedia: lanjut tanpa pemulihan
    }
    try {
      const { data } = await s2.receiptSave(client, requestId, {
        receipt_id: editing?.id ?? null,
        sender_employee_id: sender,
        receiver_name: receiverName.trim(),
        receiver_unit: receiverUnit.trim(),
        notes: notes.trim(),
        items: items.map((it) => ({
          receipt_item_id: it.receipt_item_id, archive_id: it.archive_id, description: it.description.trim(), page_count: Number(it.page_count),
          development_level: it.development_level, condition: it.condition, security_classification: it.security_classification,
          primary_letter_number: it.primary_letter_number.trim(), alternate_letter_number: it.alternate_letter_number.trim(),
          document_date: it.document_date, notes: it.notes.trim(),
        })),
      }, unitId);
      try {
        localStorage.removeItem(PENDING_KEY);
      } catch {
        // abaikan
      }
      setStage('saved');
      onSaved(data);
      // Input berikutnya langsung siap (tanpa menunggu muat ulang daftar).
      if (!editing) {
        setItems([blankItem()]);
        setNotes('');
        setSender('');
        setRequestId(newRequestId());
        setErrors({});
        senderRef.current?.focus();
      }
    } catch (err) {
      const m = errorMessage(err);
      setError(m);
      setStage('error');
      // Error bisnis: payload harus diubah, jadi request id baru. Gangguan jaringan: id tetap (retry aman).
      if (isBusinessError(err)) {
        setRequestId(newRequestId());
        try {
          localStorage.removeItem(PENDING_KEY);
        } catch {
          // abaikan
        }
      }
    }
  }

  const fieldId = (i: number, f: string) => `${formId}-${i}-${f}`;
  const err = (k: string) => errors[k];

  return (
    <form className="card receipt-form" onSubmit={submit} noValidate aria-labelledby={`${formId}-title`}>
      <div className="section-heading">
        <div>
          <h2 id={`${formId}-title`} className="section-title">
            {editing ? `Edit Tanda Terima ${editing.number}` : 'Catat Penerimaan Arsip'}
          </h2>
          <p className="muted small">Satu tanda terima dapat memuat beberapa item arsip fisik. Tanggal dan jam dicatat otomatis oleh server.</p>
        </div>
        {editing ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={onCancelEdit}>
            Batal Edit
          </button>
        ) : null}
      </div>
      {editing && (headerLocked || structureLocked) ? (
        <Alert tone="info">
          <span>
            {structureLocked
              ? 'Bukti tertandatangani sudah ada: kepala tanda terima, daftar item, dan kolom yang tercetak dikunci. Hanya metadata item yang masih perlu dilengkapi yang dapat diubah.'
              : 'Sebagian item sudah diberkaskan: data penyerah dan penerima dikunci.'}
          </span>
        </Alert>
      ) : null}

      <h3 className="subsection-title">Penyerah dan Penerima</h3>
      <div className="form-grid-2">
        <div className={`field${err('sender') ? ' field-invalid' : ''}`}>
          <label htmlFor={`${formId}-sender`}>Pegawai penyerah *</label>
          <div className="inline-control">
            <select id={`${formId}-sender`} ref={senderRef} value={sender} disabled={headerLocked} onChange={(e) => setSender(e.target.value)} aria-invalid={err('sender') ? true : undefined}>
              <option value="">Pilih pegawai penyerah</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </select>
            <button type="button" className="btn btn-secondary" disabled={headerLocked} onClick={() => setAddingEmployee(true)}>
              + Pegawai
            </button>
          </div>
          <small className="field-hint">{senderInfo ? `${senderInfo.name} — ${senderInfo.unit}` : 'Khusus pegawai internal UINSA. Pegawai baru dapat ditambahkan langsung dari sini.'}</small>
          {err('sender') ? <small className="field-error">{err('sender')}</small> : null}
        </div>
        <div className={`field${err('receiverName') ? ' field-invalid' : ''}`}>
          <label htmlFor={`${formId}-rn`}>Nama penerima arsip *</label>
          <div className="field-control">
            <input id={`${formId}-rn`} value={receiverName} maxLength={250} disabled={headerLocked} onChange={(e) => setReceiverName(e.target.value)} autoComplete="off" />
          </div>
          {err('receiverName') ? <small className="field-error">{err('receiverName')}</small> : null}
        </div>
        <div className={`field${err('receiverUnit') ? ' field-invalid' : ''}`}>
          <label htmlFor={`${formId}-ru`}>Unit kerja penerima *</label>
          <div className="field-control">
            <input id={`${formId}-ru`} value={receiverUnit} maxLength={250} disabled={headerLocked} onChange={(e) => setReceiverUnit(e.target.value)} autoComplete="off" />
          </div>
          {err('receiverUnit') ? <small className="field-error">{err('receiverUnit')}</small> : null}
        </div>
        <div className="field span-all">
          <label htmlFor={`${formId}-notes`}>Catatan umum penerimaan (opsional)</label>
          <textarea id={`${formId}-notes`} rows={2} maxLength={2000} value={notes} disabled={headerLocked} onChange={(e) => setNotes(e.target.value)}
            placeholder="Catatan yang berlaku untuk seluruh item pada tanda terima ini…" />
        </div>
      </div>

      <div className="items-heading">
        <h3 className="subsection-title">Daftar Item Arsip</h3>
        <span className="muted small">Satu baris mewakili satu item arsip.</span>
      </div>
      {err('items') ? <Alert tone="error"><span>{err('items')}</span></Alert> : null}
      <ol className="receipt-items">
        {items.map((it, i) => {
          const lockAll = it.locked;
          const lockPrinted = lockAll || it.printedLocked;
          return (
            <li key={it.key} className="receipt-item">
              <div className="receipt-item-head">
                <strong>Item {i + 1}</strong>
                {!structureLocked && !lockAll && items.length > 1 ? (
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setItems((p) => p.filter((_, j) => j !== i))} aria-label={`Hapus item ${i + 1}`}>
                    Hapus
                  </button>
                ) : null}
              </div>
              <div className="form-grid-2">
                <div className={`field span-all${err(`${i}.description`) ? ' field-invalid' : ''}`}>
                  <label htmlFor={fieldId(i, 'd')}>Uraian informasi arsip *</label>
                  <textarea id={fieldId(i, 'd')} rows={2} maxLength={2000} value={it.description} disabled={lockPrinted} onChange={(e) => setItem(i, { description: e.target.value })}
                    aria-invalid={err(`${i}.description`) ? true : undefined} />
                  {err(`${i}.description`) ? <small className="field-error">{err(`${i}.description`)}</small> : null}
                </div>
                <div className={`field${err(`${i}.page_count`) ? ' field-invalid' : ''}`}>
                  <label htmlFor={fieldId(i, 'p')}>Jumlah halaman *</label>
                  <div className="field-control">
                    <input id={fieldId(i, 'p')} type="number" inputMode="numeric" min={1} step={1} value={it.page_count} disabled={lockPrinted} onChange={(e) => setItem(i, { page_count: e.target.value })} />
                  </div>
                  {err(`${i}.page_count`) ? <small className="field-error">{err(`${i}.page_count`)}</small> : null}
                </div>
                <div className={`field${err(`${i}.document_date`) ? ' field-invalid' : ''}`}>
                  <label htmlFor={fieldId(i, 't')}>Tanggal naskah *</label>
                  <div className="field-control">
                    <input id={fieldId(i, 't')} type="date" value={it.document_date} disabled={lockAll} onChange={(e) => setItem(i, { document_date: e.target.value })} />
                  </div>
                  {err(`${i}.document_date`) ? <small className="field-error">{err(`${i}.document_date`)}</small> : null}
                </div>
                <div className="field">
                  <label htmlFor={fieldId(i, 'dev')}>Tingkat perkembangan *</label>
                  <select id={fieldId(i, 'dev')} value={it.development_level} disabled={lockPrinted} onChange={(e) => setItem(i, { development_level: e.target.value as ItemDraft['development_level'] })}>
                    {options.development_levels.map((d) => (
                      <option key={d} value={d}>{DEV_LABEL[d] ?? d}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={fieldId(i, 'c')}>Kondisi fisik *</label>
                  <select id={fieldId(i, 'c')} value={it.condition} disabled={lockPrinted} onChange={(e) => setItem(i, { condition: e.target.value as ItemDraft['condition'] })}>
                    {options.conditions.map((c) => (
                      <option key={c} value={c}>{CONDITION_LABEL[c] ?? c}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={fieldId(i, 's')}>Klasifikasi keamanan dan akses *</label>
                  <select id={fieldId(i, 's')} value={it.security_classification} disabled={lockAll} onChange={(e) => setItem(i, { security_classification: e.target.value as ItemDraft['security_classification'] })}>
                    {options.security_classifications.map((s) => (
                      <option key={s} value={s}>{SECURITY_LABEL[s] ?? s}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={fieldId(i, 'n1')}>Nomor surat utama</label>
                  <div className="field-control">
                    <input id={fieldId(i, 'n1')} value={it.primary_letter_number} disabled={lockAll} onChange={(e) => setItem(i, { primary_letter_number: e.target.value })} placeholder="Nomor UINSA" autoComplete="off" />
                  </div>
                </div>
                <div className="field">
                  <label htmlFor={fieldId(i, 'n2')}>Nomor alternatif/vendor</label>
                  <div className="field-control">
                    <input id={fieldId(i, 'n2')} value={it.alternate_letter_number} disabled={lockAll} onChange={(e) => setItem(i, { alternate_letter_number: e.target.value })} autoComplete="off" />
                  </div>
                </div>
                <div className="field span-all">
                  <label htmlFor={fieldId(i, 'notes')}>Catatan item</label>
                  <div className="field-control">
                    <input id={fieldId(i, 'notes')} value={it.notes} maxLength={1000} disabled={lockAll} onChange={(e) => setItem(i, { notes: e.target.value })} autoComplete="off" />
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="items-footer">
        {!structureLocked ? (
          <button type="button" className="btn btn-secondary" disabled={items.length >= 100} onClick={() => setItems((p) => [...p, blankItem()])}>
            + Tambah Item
          </button>
        ) : <span />}
        <span className="receipt-totals">
          {items.length} item · {totalPages} halaman
        </span>
      </div>
      {error ? <Alert tone="error" message={error} /> : null}
      {notice ? <Alert tone="success"><span>{notice}</span></Alert> : null}
      <div className="form-actions-bar">
        <SaveStage stage={stage} message={stage === 'saving' ? 'Menyimpan tanda terima…' : undefined} />
        <button type="submit" className="btn btn-primary" disabled={stage === 'saving'}>
          {stage === 'saving' ? 'Menyimpan…' : editing ? 'Simpan Perubahan' : 'Simpan & Cetak'}
        </button>
      </div>
      {addingEmployee ? (
        <AddEmployeeSheet
          unitId={unitId}
          onClose={() => setAddingEmployee(false)}
          onAdded={(e, msg) => {
            setAdded((prev) => [...prev, e]);
            setSender(e.id);
            setNotice(msg);
            setAddingEmployee(false);
          }}
        />
      ) : null}
    </form>
  );
}

/** Pemulihan bila aplikasi tertutup tepat saat menyimpan (receipt_recover). */
export function pendingReceiptRequest(): string | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as { requestId?: string; at?: number };
    if (!v.requestId || !v.at || Date.now() - v.at > 24 * 3600 * 1000) return null;
    return v.requestId;
  } catch {
    return null;
  }
}

export function clearPendingReceipt(): void {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {
    // abaikan
  }
}
