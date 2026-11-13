/**
 * Menerjemahkan error teknis (Supabase Auth, PostgREST, jaringan) menjadi pesan
 * yang dapat ditindaklanjuti pengguna. Tidak pernah mengembalikan stack trace.
 */
export interface UserMessage {
  title: string;
  action: string;
}

interface ErrorLike {
  message?: unknown;
  code?: unknown;
  status?: unknown;
  name?: unknown;
}

function asErrorLike(error: unknown): ErrorLike {
  return typeof error === 'object' && error !== null ? (error as ErrorLike) : { message: String(error) };
}

export function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

export function toUserMessage(error: unknown): UserMessage {
  const e = asErrorLike(error);
  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof e.message === 'string' ? e.message.toLowerCase() : '';
  const status = typeof e.status === 'number' ? e.status : 0;

  if (isOffline() || message.includes('failed to fetch') || message.includes('networkerror') || e.name === 'AuthRetryableFetchError') {
    return {
      title: 'Tidak dapat terhubung ke server.',
      action: 'Periksa koneksi internet Anda, lalu coba lagi.',
    };
  }
  if (code === 'invalid_credentials' || message.includes('invalid login credentials')) {
    return {
      title: 'Email atau kata sandi salah.',
      action: 'Periksa kembali penulisan, atau gunakan "Lupa kata sandi?" untuk membuat kata sandi baru.',
    };
  }
  if (code === 'email_not_confirmed' || message.includes('email not confirmed')) {
    return {
      title: 'Email akun belum dikonfirmasi.',
      action: 'Buka email undangan dari admin unit dan ikuti tautan konfirmasi, atau hubungi admin unit.',
    };
  }
  if (code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit' || status === 429) {
    return {
      title: 'Terlalu banyak percobaan dalam waktu singkat.',
      action: 'Tunggu beberapa menit, lalu coba lagi.',
    };
  }
  if (code === 'same_password' || message.includes('should be different')) {
    return {
      title: 'Kata sandi baru sama dengan kata sandi lama.',
      action: 'Gunakan kata sandi yang berbeda.',
    };
  }
  if (code === 'weak_password' || message.includes('password should be')) {
    return {
      title: 'Kata sandi terlalu lemah.',
      action: 'Gunakan minimal 8 karakter dengan campuran huruf dan angka.',
    };
  }
  if (code === 'user_banned') {
    return { title: 'Akun Anda dinonaktifkan.', action: 'Hubungi admin unit untuk mengaktifkan kembali.' };
  }
  if (code === 'session_not_found' || code === 'refresh_token_not_found' || status === 401 || code === 'PGRST301') {
    return { title: 'Sesi Anda sudah berakhir.', action: 'Silakan masuk kembali.' };
  }
  if (status === 403 || code === '42501') {
    return {
      title: 'Anda tidak memiliki izin untuk tindakan ini.',
      action: 'Bila menurut Anda ini keliru, hubungi admin unit.',
    };
  }
  if (status >= 500) {
    return {
      title: 'Server sedang bermasalah.',
      action: 'Coba lagi beberapa saat lagi. Bila berlanjut, laporkan ke Admin Pusat.',
    };
  }
  return {
    title: 'Terjadi kesalahan yang tidak terduga.',
    action: 'Coba lagi. Bila berlanjut, laporkan ke admin unit beserta waktu kejadiannya.',
  };
}

export function formatUserMessage(error: unknown): string {
  const m = toUserMessage(error);
  return `${m.title} ${m.action}`;
}
