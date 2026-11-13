/** Variabel lingkungan Pages Functions (Cloudflare Pages → Settings → Variables and Secrets). */
export interface FileEnv {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  FILE_TICKET_SECRET?: string;
  DRIVE_GATEWAY_URL?: string;
  DRIVE_GATEWAY_SECRET?: string;
  /** HMAC untuk atestasi unggahan (upload_commit) dan konteks sesi unggah. */
  UPLOAD_ATTEST_SECRET?: string;
  /** HANYA untuk uji lokal: basis Drive API palsu di http://127.0.0.1/localhost. */
  DRIVE_API_BASE?: string;
}

const DRIVE_DEFAULT = 'https://www.googleapis.com';

/** Basis Drive API. Override hanya diterima untuk host lokal (uji), selain itu diabaikan. */
export function driveApiBase(env: FileEnv): string {
  const raw = env.DRIVE_API_BASE;
  if (!raw) return DRIVE_DEFAULT;
  try {
    const u = new URL(raw);
    if ((u.hostname === '127.0.0.1' || u.hostname === 'localhost') && (u.protocol === 'http:' || u.protocol === 'https:')) return u.origin;
  } catch {
    // diabaikan
  }
  return DRIVE_DEFAULT;
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
