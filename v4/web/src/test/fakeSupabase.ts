import { vi } from 'vitest';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import type { Profile, Unit } from '../lib/api';
import type { Role } from '../auth/permissions';

type Listener = (event: string, session: Session | null) => void;
type Err = { message: string; code?: string; status?: number; name?: string };

export interface FakeOptions {
  session?: Session | null;
  profile?: Profile | null;
  unit?: Unit | null;
  units?: Unit[];
  profileError?: Err;
  signInError?: Err | ((email: string, password: string) => Err | null);
  healthError?: Err;
  functionResponse?: unknown;
  /** Bila tidak diisi, diturunkan dari profile/unit seperti public.my_account_status(). */
  accountStatus?: string;
  rpc?: Record<string, RpcHandler>;
}

export type RpcResult = { data: unknown; error: Err | null };
export type RpcHandler = (args: Record<string, unknown>, signal: AbortSignal | undefined) => RpcResult | Promise<RpcResult>;

export const UNIT: Unit = { id: 'unit-1', code: 'BAU', name: 'Biro Administrasi Umum', active: true };

export function makeSession(userId = 'user-1', email = 'petugas@uinsa.ac.id'): Session {
  return {
    access_token: 'access',
    refresh_token: 'refresh',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { id: userId, email, app_metadata: {}, user_metadata: {}, aud: 'authenticated', created_at: '2026-11-13T00:00:00Z' },
  } as Session;
}

export function makeProfile(role: Role, overrides: Partial<Profile> = {}): Profile {
  return {
    user_id: 'user-1',
    unit_id: role === 'ADMIN_PUSAT' ? null : UNIT.id,
    role,
    full_name: 'Siti Aminah',
    active: true,
    must_change_password: false,
    ...overrides,
  };
}

/** Klien Supabase tiruan secukupnya untuk Auth + PostgREST + Functions. */
export function createFakeClient(opts: FakeOptions = {}) {
  let session: Session | null = opts.session ?? null;
  const listeners = new Set<Listener>();
  const emit = (event: string) => listeners.forEach((l) => l(event, session));

  const auth = {
    getSession: vi.fn(async () => ({ data: { session }, error: null })),
    onAuthStateChange: vi.fn((cb: Listener) => {
      listeners.add(cb);
      return { data: { subscription: { unsubscribe: () => listeners.delete(cb) } } };
    }),
    signInWithPassword: vi.fn(async ({ email, password }: { email: string; password: string }) => {
      const err = typeof opts.signInError === 'function' ? opts.signInError(email, password) : (opts.signInError ?? null);
      if (err) return { data: { session: null, user: null }, error: err };
      session = makeSession('user-1', email);
      emit('SIGNED_IN');
      return { data: { session, user: session.user }, error: null };
    }),
    signOut: vi.fn(async () => {
      session = null;
      emit('SIGNED_OUT');
      return { error: null };
    }),
    resetPasswordForEmail: vi.fn(async () => ({ data: {}, error: null })),
    updateUser: vi.fn(async () => ({ data: { user: session?.user ?? null }, error: null })),
  };

  function query(table: string) {
    let head = false;
    let single = false;
    const result = () => {
      if (table === 'units' && head) {
        return opts.healthError ? { data: null, error: opts.healthError, count: null } : { data: null, error: null, count: 1 };
      }
      if (table === 'profiles') {
        if (opts.profileError) return { data: null, error: opts.profileError };
        return { data: opts.profile ?? null, error: null };
      }
      if (table === 'units' && single) return { data: opts.unit === undefined ? UNIT : opts.unit, error: null };
      if (table === 'units') return { data: opts.units ?? [UNIT], error: null };
      return { data: null, error: { message: `tabel tidak dikenal ${table}` } };
    };
    const builder = {
      select: (_cols?: string, o?: { head?: boolean }) => {
        head = Boolean(o?.head);
        return builder;
      },
      eq: () => builder,
      order: () => builder,
      maybeSingle: () => {
        single = true;
        return Promise.resolve(result());
      },
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
    };
    return builder;
  }

  const functions = {
    invoke: vi.fn(async (_name: string, _o: { body: unknown }) => ({ data: opts.functionResponse ?? { ok: true, data: null }, error: null })),
  };

  function deriveStatus(): string {
    if (opts.accountStatus) return opts.accountStatus;
    if (!opts.profile) return 'NO_PROFILE';
    if (!opts.profile.active) return 'INACTIVE';
    if (opts.unit && !opts.unit.active) return 'UNIT_INACTIVE';
    return 'ACTIVE';
  }

  const rpc = vi.fn((name: string, args: Record<string, unknown> = {}) => {
    let signal: AbortSignal | undefined;
    const run = async (): Promise<RpcResult> => {
      if (name === 'my_account_status') {
        return opts.profileError ? { data: null, error: opts.profileError } : { data: deriveStatus(), error: null };
      }
      const defaults: Record<string, RpcHandler> = {
        dashboard_overview: () => ({
          data: { today: '2026-11-13', counts: { total_berkas: 0, total_item: 0, sedang_dipinjam: 0, retensi_h7: 0, habis_aktif: 0 }, groups: [] },
          error: null,
        }),
      };
      const handler = opts.rpc?.[name] ?? defaults[name];
      if (!handler) return { data: null, error: { message: `rpc tidak dikenal ${name}`, code: '42883' } };
      return handler(args, signal);
    };
    const builder = {
      abortSignal: (s: AbortSignal) => {
        signal = s;
        return builder;
      },
      then: (resolve: (v: RpcResult) => unknown, reject?: (e: unknown) => unknown) => run().then(resolve, reject),
    };
    return builder;
  });

  const client = { auth, from: vi.fn(query), functions, rpc };
  return { client: client as unknown as SupabaseClient, auth, functions, rpc, emit };
}
