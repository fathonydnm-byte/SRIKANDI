export const MIN_PASSWORD_LENGTH = 8;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateEmail(value: string): string | undefined {
  const v = value.trim();
  if (!v) return 'Email wajib diisi.';
  if (!EMAIL_RE.test(v)) return 'Format email tidak valid. Contoh: nama@uinsa.ac.id';
  return undefined;
}

export function validatePasswordPresent(value: string): string | undefined {
  return value ? undefined : 'Kata sandi wajib diisi.';
}

export function validateNewPassword(value: string): string | undefined {
  if (!value) return 'Kata sandi baru wajib diisi.';
  if (value.length < MIN_PASSWORD_LENGTH) return `Kata sandi minimal ${MIN_PASSWORD_LENGTH} karakter.`;
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) return 'Gunakan campuran huruf dan angka.';
  return undefined;
}

export function validateConfirm(value: string, original: string): string | undefined {
  if (!value) return 'Ulangi kata sandi baru.';
  if (value !== original) return 'Kedua kata sandi tidak sama. Ketik ulang dengan teliti.';
  return undefined;
}
