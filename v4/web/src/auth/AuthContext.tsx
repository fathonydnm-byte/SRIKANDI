import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { ApiError, fetchAccountStatus, fetchProfile, fetchUnit, fetchUnits, type Profile, type Unit } from '../lib/api';
import { toUserMessage, type UserMessage } from '../lib/errors';
import { can, isRole } from './permissions';

export type BlockedReason = 'missing' | 'inactive' | 'no_unit' | 'unit_inactive' | 'invalid_role';

export type ProfileState =
  | { kind: 'loading' }
  | { kind: 'ready'; profile: Profile; unit: Unit | null }
  | { kind: 'blocked'; reason: BlockedReason }
  | { kind: 'error'; message: UserMessage };

export type AuthState =
  | { status: 'loading' }
  | { status: 'signedOut' }
  | { status: 'signedIn'; session: Session; profile: ProfileState };

export interface AuthContextValue {
  client: SupabaseClient;
  state: AuthState;
  /** true setelah pengguna membuka tautan pemulihan kata sandi. */
  recovery: boolean;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  requestPasswordReset(email: string): Promise<void>;
  updatePassword(newPassword: string): Promise<void>;
  /** Memastikan kata sandi saat ini benar sebelum mengganti. */
  verifyCurrentPassword(password: string): Promise<void>;
  reloadProfile(): void;
  /** Khusus Admin Pusat: unit yang sedang dilihat (null = semua unit). */
  units: Unit[];
  activeUnitId: string | null;
  setActiveUnitId(id: string | null): void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function throwAuth(error: unknown): never {
  const code = (error as { code?: unknown })?.code;
  throw new ApiError(typeof code === 'string' ? code : 'AUTH_ERROR', toUserMessage(error), error);
}

async function resolveProfile(client: SupabaseClient, userId: string): Promise<ProfileState> {
  try {
    // Server menjelaskan alasan akun tertahan; RLS menyembunyikan profil nonaktif.
    const status = await fetchAccountStatus(client);
    if (status === 'NO_PROFILE') return { kind: 'blocked', reason: 'missing' };
    if (status === 'INACTIVE') return { kind: 'blocked', reason: 'inactive' };
    if (status === 'UNIT_INACTIVE') return { kind: 'blocked', reason: 'unit_inactive' };
    const profile = await fetchProfile(client, userId);
    if (!profile) return { kind: 'blocked', reason: 'missing' };
    if (!isRole(profile.role)) return { kind: 'blocked', reason: 'invalid_role' };
    if (!profile.active) return { kind: 'blocked', reason: 'inactive' };
    if (profile.role === 'ADMIN_PUSAT') {
      const unit = profile.unit_id ? await fetchUnit(client, profile.unit_id) : null;
      return { kind: 'ready', profile, unit };
    }
    if (!profile.unit_id) return { kind: 'blocked', reason: 'no_unit' };
    const unit = await fetchUnit(client, profile.unit_id);
    if (!unit) return { kind: 'blocked', reason: 'no_unit' };
    if (!unit.active) return { kind: 'blocked', reason: 'unit_inactive' };
    return { kind: 'ready', profile, unit };
  } catch (error) {
    return { kind: 'error', message: error instanceof ApiError ? error.userMessage : toUserMessage(error) };
  }
}

export function AuthProvider({
  client,
  initialRecovery = false,
  children,
}: {
  client: SupabaseClient;
  /** true bila halaman dibuka dari tautan pemulihan (lihat detectRecoveryLink). */
  initialRecovery?: boolean;
  children: ReactNode;
}) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [profile, setProfile] = useState<{ userId: string; state: ProfileState } | null>(null);
  const [recovery, setRecovery] = useState(initialRecovery);
  const [reloadKey, setReloadKey] = useState(0);
  const [units, setUnits] = useState<Unit[]>([]);
  const [activeUnitId, setActiveUnitId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client.auth
      .getSession()
      .then(({ data }) => {
        if (!cancelled) setSession(data.session);
      })
      .catch(() => {
        if (!cancelled) setSession(null);
      });
    const { data } = client.auth.onAuthStateChange((event, next) => {
      // Jangan memanggil Supabase secara sinkron di dalam callback ini.
      if (event === 'PASSWORD_RECOVERY') setRecovery(true);
      if (event === 'SIGNED_OUT') setRecovery(false);
      setSession(next);
    });
    return () => {
      cancelled = true;
      data.subscription.unsubscribe();
    };
  }, [client]);

  const userId = session?.user.id ?? null;

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void resolveProfile(client, userId).then((state) => {
      if (!cancelled) setProfile({ userId, state });
    });
    return () => {
      cancelled = true;
    };
  }, [client, userId, reloadKey]);

  const profileState: ProfileState =
    profile && profile.userId === userId ? profile.state : { kind: 'loading' };
  const role = profileState.kind === 'ready' ? profileState.profile.role : null;

  useEffect(() => {
    if (!can(role, 'unit.pilih')) return;
    let cancelled = false;
    fetchUnits(client)
      .then((list) => {
        if (!cancelled) setUnits(list);
      })
      .catch(() => {
        if (!cancelled) setUnits([]);
      });
    return () => {
      cancelled = true;
    };
  }, [client, role]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) throwAuth(error);
    },
    [client],
  );

  const signOut = useCallback(async () => {
    try {
      await client.auth.signOut();
    } finally {
      // Sesi lokal tetap dibuang walau server tidak terjangkau.
      setSession(null);
      setRecovery(false);
      setActiveUnitId(null);
    }
  }, [client]);

  const requestPasswordReset = useCallback(
    async (email: string) => {
      const redirectTo = `${window.location.origin}/atur-sandi`;
      const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo });
      if (error) throwAuth(error);
    },
    [client],
  );

  const updatePassword = useCallback(
    async (newPassword: string) => {
      const { error } = await client.auth.updateUser({ password: newPassword });
      if (error) throwAuth(error);
      setRecovery(false);
    },
    [client],
  );

  const verifyCurrentPassword = useCallback(
    async (password: string) => {
      const email = session?.user.email;
      if (!email) throwAuth({ code: 'session_not_found' });
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) {
        if ((error as { code?: string }).code === 'invalid_credentials') {
          throw new ApiError('invalid_current_password', {
            title: 'Kata sandi saat ini salah.',
            action: 'Ketik ulang kata sandi yang Anda pakai untuk masuk.',
          });
        }
        throwAuth(error);
      }
    },
    [client, session],
  );

  const reloadProfile = useCallback(() => setReloadKey((k) => k + 1), []);

  const state: AuthState =
    session === undefined
      ? { status: 'loading' }
      : session === null
        ? { status: 'signedOut' }
        : { status: 'signedIn', session, profile: profileState };

  const value: AuthContextValue = {
    client,
    state,
    recovery,
    signIn,
    signOut,
    requestPasswordReset,
    updatePassword,
    verifyCurrentPassword,
    reloadProfile,
    units,
    activeUnitId,
    setActiveUnitId,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth harus dipakai di dalam AuthProvider');
  return ctx;
}

/** Profil yang sudah siap; hanya dipakai di bawah RequireProfile. */
export function useProfile(): { profile: Profile; unit: Unit | null } {
  const { state } = useAuth();
  if (state.status !== 'signedIn' || state.profile.kind !== 'ready') {
    throw new Error('useProfile dipakai sebelum profil siap');
  }
  return { profile: state.profile.profile, unit: state.profile.unit };
}
