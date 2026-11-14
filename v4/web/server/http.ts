/** Jawaban error ringkas. Tidak pernah membawa isi error dari Google/Supabase. */
export type ErrorCode =
  | 'NOT_CONFIGURED'
  | 'GATEWAY_NOT_CONFIGURED'
  | 'UNAUTHENTICATED'
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'TICKET_EXPIRED'
  | 'TICKET_INVALID'
  | 'UPSTREAM'
  | 'METHOD'
  | 'FORBIDDEN'
  | 'TOO_LARGE'
  | 'INVALID_FILE'
  | 'UPLOAD_MISMATCH'
  | 'CONFLICT'
  | 'SERVICE_KEY_MISSING'
  | 'EMAIL_EXISTS'
  | 'WEAK_PASSWORD'
  | 'PARTIAL_FAILURE';

const MESSAGES: Record<ErrorCode, string> = {
  NOT_CONFIGURED: 'Layanan file belum dikonfigurasi. Hubungi Admin Pusat.',
  GATEWAY_NOT_CONFIGURED: 'Jembatan Drive belum dipasang. Hubungi Admin Pusat.',
  UNAUTHENTICATED: 'Sesi Anda sudah berakhir. Silakan masuk kembali.',
  BAD_REQUEST: 'Permintaan tidak valid.',
  NOT_FOUND: 'File tidak ditemukan atau Anda tidak berhak membukanya.',
  TICKET_EXPIRED: 'Tautan file sudah kedaluwarsa. Kembali ke aplikasi dan buka file lagi.',
  TICKET_INVALID: 'Tautan file tidak valid. Kembali ke aplikasi dan buka file lagi.',
  UPSTREAM: 'Google Drive sedang tidak dapat dihubungi. Coba lagi beberapa saat lagi.',
  METHOD: 'Metode tidak didukung.',
  FORBIDDEN: 'Anda tidak berhak melakukan tindakan ini.',
  TOO_LARGE: 'Ukuran file melebihi batas yang diizinkan.',
  INVALID_FILE: 'Isi file tidak sesuai tipenya (bukan PDF/gambar yang sah). Pilih file lain.',
  UPLOAD_MISMATCH: 'File yang terunggah tidak sesuai dengan sesi unggah. Ulangi unggahan.',
  CONFLICT: 'Data sudah berubah. Muat ulang lalu coba lagi.',
  SERVICE_KEY_MISSING: 'Pengelolaan akun belum dikonfigurasi di server (kunci layanan belum dipasang). Hubungi Admin Pusat.',
  EMAIL_EXISTS: 'Email ini sudah terdaftar. Cari pengguna di daftar lalu atur ulang kata sandi sementaranya.',
  WEAK_PASSWORD: 'Kata sandi sementara tidak memenuhi syarat.',
  PARTIAL_FAILURE: 'Perubahan akun tidak tuntas. Muat ulang daftar pengguna, periksa status akun, lalu ulangi.',
};

const STATUS: Record<ErrorCode, number> = {
  NOT_CONFIGURED: 503,
  GATEWAY_NOT_CONFIGURED: 503,
  UNAUTHENTICATED: 401,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  TICKET_EXPIRED: 410,
  TICKET_INVALID: 400,
  UPSTREAM: 502,
  METHOD: 405,
  FORBIDDEN: 403,
  TOO_LARGE: 413,
  INVALID_FILE: 422,
  UPLOAD_MISMATCH: 409,
  CONFLICT: 409,
  SERVICE_KEY_MISSING: 503,
  EMAIL_EXISTS: 409,
  WEAK_PASSWORD: 422,
  PARTIAL_FAILURE: 502,
};

const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export function jsonError(code: ErrorCode, message?: string): Response {
  return new Response(JSON.stringify({ ok: false, code, message: message ?? MESSAGES[code] }), {
    status: STATUS[code],
    headers: { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/** Untuk navigasi browser (tab baru): teks biasa yang bisa dibaca manusia. */
export function textError(code: ErrorCode): Response {
  return new Response(`${MESSAGES[code]}\n`, {
    status: STATUS[code],
    headers: { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'X-Error-Code': code, 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" },
  });
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, 'Content-Type': 'application/json; charset=utf-8' } });
}
