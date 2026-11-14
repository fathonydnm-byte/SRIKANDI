/*
 * Kelola Pengguna. Daftar dibaca lewat RPC user_list (SECURITY INVOKER, RLS). Perubahan akun lewat
 * Pages Function POST /api/admin/users (server memeriksa hak akses dua kali; tombol yang disembunyikan
 * hanyalah kenyamanan). Kata sandi sementara dibuat DI SINI (browser admin), dikirim sekali ke server,
 * dan tidak pernah disimpan: tidak di storage, URL, maupun log.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError, callRead } from './api';
import type { Role } from '../auth/permissions';

export interface UserRow {
  user_id: string;
  email: string | null;
  full_name: string;
  role: Role;
  unit_id: string | null;
  unit_code: string | null;
  unit_name: string | null;
  active: boolean;
  must_change_password: boolean;
  created_at: string;
  updated_at: string | null;
}

export function fetchUsers(client: SupabaseClient): Promise<UserRow[]> {
  return callRead<UserRow[] | null>(client, 'user_list', {}).then((rows) => rows ?? []);
}

// ---------------------------------------------------------------------------
// Kata sandi sementara
// ---------------------------------------------------------------------------
// Tanpa karakter yang mudah tertukar (0/O, 1/l/I). Panjang 14 dengan tanda hubung per 4 -> >= 10 (aturan server).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

function randomChars(n: number): string {
  // penolakan sampel: tanpa bias modulo
  const limit = 256 - (256 % ALPHABET.length);
  let out = '';
  while (out.length < n) {
    const buf = crypto.getRandomValues(new Uint8Array(n * 2));
    for (const b of buf) {
      if (b < limit && out.length < n) out += ALPHABET[b % ALPHABET.length];
    }
  }
  return out;
}

/** Sama dengan kebijakan server (>= 10 karakter, tanpa nama pada email). */
export function tempPasswordOk(password: string, email: string | null): boolean {
  if (password.length < 10) return false;
  const local = (email ?? '').split('@')[0]?.trim().toLowerCase() ?? '';
  return !(local.length >= 3 && password.toLowerCase().includes(local));
}

export function generateTempPassword(email: string | null = null): string {
  for (let i = 0; i < 20; i++) {
    const c = randomChars(12);
    const pw = `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;
    if (/[A-Za-z]/.test(pw) && /\d/.test(pw) && tempPasswordOk(pw, email)) return pw;
  }
  return `${randomChars(6)}-9${randomChars(5)}`;
}

// ---------------------------------------------------------------------------
// Permintaan ke server
// ---------------------------------------------------------------------------
export type AdminUsersRequest =
  | { action: 'create'; requestId: string; email: string; fullName: string; role: Role; unitId: string | null; tempPassword: string }
  | { action: 'update'; requestId: string; userId: string; fullName?: string; role?: Role; unitId?: string | null; active?: boolean }
  | { action: 'reset-password'; requestId: string; userId: string; tempPassword: string };

export interface AdminUsersResult {
  userId: string | null;
  created: boolean;
  replayed: boolean;
}

const ACTIONS: Record<string, string> = {
  UNAUTHENTICATED: 'Silakan masuk kembali.',
  FORBIDDEN: 'Bila menurut Anda ini keliru, hubungi Admin Pusat.',
  NOT_FOUND: 'Muat ulang daftar pengguna.',
  CONFLICT: 'Muat ulang daftar pengguna lalu ulangi.',
  EMAIL_EXISTS: 'Periksa daftar pengguna.',
  WEAK_PASSWORD: 'Gunakan "Buat ulang" untuk kata sandi sementara baru.',
  BAD_REQUEST: 'Periksa isian lalu coba lagi.',
  SERVICE_KEY_MISSING: 'Beri tahu Admin Pusat.',
  NOT_CONFIGURED: 'Beri tahu Admin Pusat.',
  PARTIAL_FAILURE: 'Cek status akun di daftar sebelum mengulang.',
  UPSTREAM: 'Coba lagi beberapa saat lagi.',
};

export async function adminUsersRequest(
  getToken: () => Promise<string | null>,
  body: AdminUsersRequest,
  fetchFn: typeof fetch = fetch,
): Promise<AdminUsersResult> {
  const token = await getToken();
  if (!token) throw new ApiError('UNAUTHENTICATED', { title: 'Sesi Anda sudah berakhir.', action: 'Silakan masuk kembali.' });
  let res: Response;
  try {
    res = await fetchFn('/api/admin/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError('NETWORK', { title: 'Tidak dapat terhubung ke server.', action: 'Periksa koneksi internet lalu coba lagi. Tekan tombol yang sama sekali lagi; permintaan yang sama tidak akan diproses dua kali.' });
  }
  type Body = { ok?: boolean; code?: string; message?: string; userId?: string | null; created?: boolean; replayed?: boolean };
  const data: Body | null = await res.json().then(
    (v: unknown) => (v && typeof v === 'object' ? (v as Body) : null),
    () => null,
  );
  if (!res.ok || !data?.ok) {
    const code = data?.code ?? (res.status === 401 ? 'UNAUTHENTICATED' : res.status === 403 ? 'FORBIDDEN' : 'UPSTREAM');
    throw new ApiError(code, {
      title: data?.message || 'Permintaan gagal diproses.',
      action: ACTIONS[code] ?? 'Coba lagi. Bila berlanjut, hubungi Admin Pusat.',
    });
  }
  return { userId: data.userId ?? null, created: data.created === true, replayed: data.replayed === true };
}
