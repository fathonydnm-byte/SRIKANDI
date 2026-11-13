/** Variabel lingkungan Pages Functions (Cloudflare Pages → Settings → Variables and Secrets). */
export interface FileEnv {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  FILE_TICKET_SECRET?: string;
  DRIVE_GATEWAY_URL?: string;
  DRIVE_GATEWAY_SECRET?: string;
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
