import { useId } from 'react';
import { useAuth, useProfile } from '../auth/AuthContext';
import { can } from '../auth/permissions';

/** Label unit yang sedang dilihat. Admin Pusat: dari pemilih unit. */
export function useActiveUnitLabel(): string {
  const { profile, unit } = useProfile();
  const { units, activeUnitId } = useAuth();
  if (can(profile.role, 'unit.pilih')) {
    const active = units.find((u) => u.id === activeUnitId);
    return active ? active.name : 'Semua unit';
  }
  return unit?.name ?? '—';
}

/**
 * Placeholder pemilih unit untuk Admin Pusat. Pada Sprint 0 pilihan ini hanya
 * mengubah label; penyaringan data per unit hadir bersama modul data (S1).
 */
export function UnitSwitcher({ compact = false }: { compact?: boolean }) {
  const { profile } = useProfile();
  const { units, activeUnitId, setActiveUnitId } = useAuth();
  const id = useId();
  if (!can(profile.role, 'unit.pilih')) return null;
  return (
    <div className={`unit-switcher${compact ? ' compact' : ''}`}>
      <label htmlFor={id} className={compact ? 'sr-only' : undefined}>
        Unit aktif
      </label>
      <select id={id} value={activeUnitId ?? ''} onChange={(e) => setActiveUnitId(e.target.value || null)}>
        <option value="">Semua unit</option>
        {units.map((u) => (
          <option key={u.id} value={u.id}>
            {u.code} — {u.name}
            {u.active ? '' : ' (nonaktif)'}
          </option>
        ))}
      </select>
    </div>
  );
}
