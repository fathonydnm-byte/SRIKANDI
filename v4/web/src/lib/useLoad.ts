import { useEffect, useState } from 'react';
import { ApiError } from './api';
import { toUserMessage, type UserMessage } from './errors';

export type Load<T> = { kind: 'loading' } | { kind: 'ok'; data: T } | { kind: 'error'; message: UserMessage };

/**
 * Memuat data untuk `key`. Hasil untuk kunci lama diabaikan, jadi berpindah
 * halaman di tengah permintaan tidak pernah menampilkan data yang salah.
 * Saat memuat ulang (retry) KUNCI YANG SAMA, data lama tetap ditampilkan
 * sampai data baru tiba — formulir di halaman tidak hilang.
 */
export function useLoad<T>(key: string, load: () => Promise<T>): [Load<T>, () => void] {
  const [nonce, setNonce] = useState(0);
  const fullKey = `${key}#${nonce}`;
  const [result, setResult] = useState<{ base: string; key: string; value: Load<T> } | null>(null);

  useEffect(() => {
    let cancelled = false;
    load().then(
      (data) => {
        if (!cancelled) setResult({ base: key, key: fullKey, value: { kind: 'ok', data } });
      },
      (error: unknown) => {
        if (!cancelled) {
          setResult({ base: key, key: fullKey, value: { kind: 'error', message: error instanceof ApiError ? error.userMessage : toUserMessage(error) } });
        }
      },
    );
    return () => {
      cancelled = true;
    };
    // `load` boleh berupa fungsi baru tiap render; kunci yang menentukan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullKey]);

  const value: Load<T> =
    result && (result.key === fullKey || (result.base === key && result.value.kind === 'ok')) ? result.value : { kind: 'loading' };
  return [value, () => setNonce((n) => n + 1)];
}
