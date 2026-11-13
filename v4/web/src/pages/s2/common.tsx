import { useCallback } from 'react';
import { useAuth, useProfile } from '../../auth/AuthContext';
import { can } from '../../auth/permissions';
import { Alert } from '../../components/Alert';
import { ApiError } from '../../lib/api';
import { toUserMessage, type UserMessage } from '../../lib/errors';

/** Unit untuk operasi tulis: ADMIN_PUSAT wajib memilih unit (API_S2 UNIT_REQUIRED). */
export function useWriteUnit(): { unitId: string | null; needsUnit: boolean } {
  const { profile } = useProfile();
  const { activeUnitId } = useAuth();
  if (can(profile.role, 'unit.pilih')) return { unitId: activeUnitId, needsUnit: !activeUnitId };
  return { unitId: null, needsUnit: false };
}

export function useGetToken(): () => Promise<string | null> {
  const { client } = useAuth();
  return useCallback(async () => (await client.auth.getSession()).data.session?.access_token ?? null, [client]);
}

export function errorMessage(error: unknown): UserMessage {
  return error instanceof ApiError ? error.userMessage : toUserMessage(error);
}

export function NeedsUnit() {
  return (
    <Alert tone="warning">
      <strong>Pilih unit terlebih dahulu.</strong> <span>Sebagai Admin Pusat, pilih unit kerja di bagian atas layar sebelum mencatat data.</span>
    </Alert>
  );
}

/** Indikator tahap simpan yang jelas (prioritas pemilik: kecepatan + kepastian). */
export function SaveStage({ stage, message }: { stage: 'idle' | 'saving' | 'saved' | 'error'; message?: string | undefined }) {
  if (stage === 'idle') return <span className="save-stage" aria-live="polite" />;
  return (
    <span className={`save-stage is-${stage}`} role="status" aria-live="polite">
      {stage === 'saving' ? <span className="spinner small" aria-hidden="true" /> : null}
      {message ?? (stage === 'saving' ? 'Menyimpan…' : stage === 'saved' ? 'Tersimpan.' : '')}
    </span>
  );
}

export const DEV_LABEL: Record<string, string> = { ASLI: 'Asli', COPY: 'Copy' };
export const SECURITY_LABEL: Record<string, string> = {
  'BIASA/TERBUKA': 'Biasa/Terbuka',
  TERBATAS: 'Terbatas',
  RAHASIA: 'Rahasia',
  'SANGAT RAHASIA': 'Sangat Rahasia',
};
export const CONDITION_LABEL: Record<string, string> = {
  BAIK: 'Baik',
  'RUSAK RINGAN': 'Rusak ringan',
  'RUSAK SEDANG': 'Rusak sedang',
  'RUSAK BERAT': 'Rusak berat',
};

export function todayJakarta(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const months = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return `${Number(parts.day)} ${months[Number(parts.month) - 1]} ${parts.year}, ${parts.hour}.${parts.minute} WIB`;
}

/** Pemilih file PDF + titik sambung pemindai kamera (Sprint 6). */
export function PdfPicker({ id, label, hint, file, onChange, disabled }: { id: string; label: string; hint: string; file: File | null; onChange(f: File | null): void; disabled?: boolean }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="file-input"
        type="file"
        accept="application/pdf,.pdf"
        disabled={disabled}
        onChange={(e) => onChange(e.target.files?.[0] ?? null)}
        aria-describedby={`${id}-hint`}
      />
      <small id={`${id}-hint`} className="field-hint">
        {file ? `${file.name} · ${(file.size / (1024 * 1024)).toFixed(1)} MB. ` : ''}
        {hint}
      </small>
    </div>
  );
}
