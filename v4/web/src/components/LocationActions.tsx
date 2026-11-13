import { useState } from 'react';
import { copyText, shareText } from '../lib/share';

/** "Salin lokasi" + "Bagikan" dengan umpan balik yang diumumkan pembaca layar. */
export function LocationActions({ text, shareTitle }: { text: string; shareTitle: string }) {
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [fallback, setFallback] = useState<string | null>(null);

  async function copy() {
    const ok = await copyText(text);
    setFallback(ok ? null : text);
    setMsg(ok ? { tone: 'ok', text: 'Lokasi disalin. Tempel di pesan Anda.' } : { tone: 'error', text: 'Tidak bisa menyalin otomatis. Pilih dan salin teks di bawah.' });
  }

  async function share() {
    const outcome = await shareText(shareTitle, text, window.location.href);
    if (outcome === 'copied') setMsg({ tone: 'ok', text: 'Berbagi tidak tersedia di perangkat ini; lokasi dan tautan disalin.' });
    else if (outcome === 'failed') {
      setFallback(`${text}\n${window.location.href}`);
      setMsg({ tone: 'error', text: 'Tidak bisa membagikan atau menyalin otomatis. Pilih dan salin teks di bawah.' });
    } else setMsg(null);
  }

  return (
    <div className="location-actions">
      <div className="action-row">
        <button type="button" className="btn btn-primary" onClick={() => void copy()}>
          <span aria-hidden="true">📋</span> Salin lokasi
        </button>
        <button type="button" className="btn btn-secondary" onClick={() => void share()}>
          <span aria-hidden="true">↗</span> Bagikan
        </button>
      </div>
      <p className={`action-msg${msg?.tone === 'error' ? ' is-error' : ''}`} role="status" aria-live="polite">
        {msg?.text ?? ''}
      </p>
      {fallback ? (
        <textarea className="copy-fallback" readOnly value={fallback} aria-label="Teks lokasi untuk disalin" rows={4} onFocus={(e) => e.currentTarget.select()} />
      ) : null}
    </div>
  );
}
