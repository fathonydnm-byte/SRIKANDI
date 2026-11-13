/// <reference types="vite/client" />

declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** 'drive-url' = mode darurat lama (buka URL Drive). Bawaan: jembatan aman. */
  readonly VITE_FILE_ACCESS_MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
