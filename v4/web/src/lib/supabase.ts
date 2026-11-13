import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AppConfig } from '../config';

let client: SupabaseClient | null = null;

/**
 * Satu-satunya tempat klien Supabase dibuat. Komponen menerima klien lewat
 * AuthProvider sehingga tes dapat menyuntikkan klien tiruan.
 */
export function getSupabase(config: Extract<AppConfig, { ok: true }>): SupabaseClient {
  if (!client) {
    client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        // 'implicit' agar tautan reset kata sandi tetap berfungsi bila dibuka di
        // perangkat/browser lain (PKCE menyimpan verifier di browser peminta).
        flowType: 'implicit',
      },
    });
  }
  return client;
}

/**
 * Harus dipanggil SEBELUM getSupabase(): supabase-js membersihkan fragmen URL
 * setelah membaca token, dan event PASSWORD_RECOVERY bisa terpancar sebelum
 * komponen sempat berlangganan.
 */
export function detectRecoveryLink(location: Pick<Location, 'hash' | 'search'>): boolean {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  return params.get('type') === 'recovery' || new URLSearchParams(location.search).get('type') === 'recovery';
}
