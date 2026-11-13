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
  | 'METHOD';

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
};

const BASE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

export function jsonError(code: ErrorCode): Response {
  return new Response(JSON.stringify({ ok: false, code, message: MESSAGES[code] }), {
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
