export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0-dev';

export type AppConfig =
  | { ok: true; supabaseUrl: string; supabaseAnonKey: string }
  | { ok: false; missing: string[]; invalid: string[] };

export interface RawEnv {
  VITE_SUPABASE_URL?: string | undefined;
  VITE_SUPABASE_ANON_KEY?: string | undefined;
}

function isValidSupabaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    // http hanya untuk Supabase lokal (supabase start).
    return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

/** Membaca dan memvalidasi variabel lingkungan build. Tidak pernah melempar error. */
export function readConfig(env: RawEnv = import.meta.env): AppConfig {
  const url = (env.VITE_SUPABASE_URL ?? '').trim();
  const key = (env.VITE_SUPABASE_ANON_KEY ?? '').trim();
  const missing: string[] = [];
  const invalid: string[] = [];
  if (!url) missing.push('VITE_SUPABASE_URL');
  else if (!isValidSupabaseUrl(url)) invalid.push('VITE_SUPABASE_URL');
  if (!key) missing.push('VITE_SUPABASE_ANON_KEY');
  if (missing.length || invalid.length) return { ok: false, missing, invalid };
  return { ok: true, supabaseUrl: url.replace(/\/+$/, ''), supabaseAnonKey: key };
}
