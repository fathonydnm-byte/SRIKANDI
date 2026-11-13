import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { canOpenModule, type ModuleDef } from './permissions';
import { FullScreenLoading } from '../components/FullScreenLoading';
import { AccountBlockedPage, ProfileErrorPage } from '../pages/AccountBlockedPage';
import type { ReactNode } from 'react';

export interface DeniedState {
  denied?: string;
}

/** Wajib masuk + profil aktif. Selain itu: layar login / akun belum aktif. */
export function RequireAuth() {
  const { state } = useAuth();
  const location = useLocation();
  if (state.status === 'loading') return <FullScreenLoading label="Memeriksa sesi…" />;
  if (state.status === 'signedOut') {
    return <Navigate to="/masuk" replace state={{ from: location.pathname + location.search }} />;
  }
  const p = state.profile;
  if (p.kind === 'loading') return <FullScreenLoading label="Memuat profil pengguna…" />;
  if (p.kind === 'blocked') return <AccountBlockedPage reason={p.reason} />;
  if (p.kind === 'error') return <ProfileErrorPage message={p.message} />;
  return <Outlet />;
}

/** Peran yang tidak berhak tidak pernah sampai ke layar modul. */
export function RequireModule({ module, children }: { module: ModuleDef; children: ReactNode }) {
  const { state } = useAuth();
  const role = state.status === 'signedIn' && state.profile.kind === 'ready' ? state.profile.profile.role : null;
  if (!canOpenModule(role, module)) {
    const denied: DeniedState = { denied: module.label };
    return <Navigate to="/dashboard" replace state={denied} />;
  }
  return <>{children}</>;
}

/** Halaman publik (login, lupa sandi): bila sudah masuk, langsung ke aplikasi. */
export function PublicOnly({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const location = useLocation();
  if (state.status === 'loading') return <FullScreenLoading label="Memeriksa sesi…" />;
  if (state.status === 'signedIn') {
    const from = (location.state as { from?: string } | null)?.from;
    const target = from && from.startsWith('/') && !from.startsWith('//') && from !== '/masuk' ? from : '/dashboard';
    return <Navigate to={target} replace />;
  }
  return <>{children}</>;
}
