import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { validateEmail } from '../auth/validation';
import { CenteredCard } from '../components/CenteredCard';
import { Field } from '../components/Field';
import { Alert } from '../components/Alert';
import { ApiError } from '../lib/api';
import { toUserMessage, type UserMessage } from '../lib/errors';

export function ForgotPasswordPage() {
  const { requestPasswordReset } = useAuth();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<UserMessage | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const v = validateEmail(email);
    setError(v);
    setFormError(null);
    if (v) return;
    setBusy(true);
    try {
      await requestPasswordReset(email.trim());
      setSent(true);
    } catch (err) {
      setFormError(err instanceof ApiError ? err.userMessage : toUserMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <CenteredCard title="Periksa email Anda">
        <Alert tone="success">
          <span>
            Bila <strong>{email.trim()}</strong> terdaftar, kami telah mengirim tautan untuk membuat kata sandi baru. Buka tautan itu
            dalam 1 jam. Tidak ada di kotak masuk? Periksa folder spam, atau hubungi admin unit.
          </span>
        </Alert>
        <div className="form-links">
          <Link to="/masuk">Kembali ke halaman masuk</Link>
        </div>
      </CenteredCard>
    );
  }

  return (
    <CenteredCard title="Lupa kata sandi" subtitle="Masukkan email akun Anda. Kami akan mengirim tautan untuk membuat kata sandi baru.">
      <form onSubmit={onSubmit} noValidate className="stack">
        {formError ? <Alert tone="error" message={formError} /> : null}
        <Field
          label="Email"
          type="email"
          name="email"
          autoComplete="username"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={error}
        />
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Mengirim…' : 'Kirim tautan'}
        </button>
        <div className="form-links">
          <Link to="/masuk">Kembali ke halaman masuk</Link>
        </div>
      </form>
    </CenteredCard>
  );
}
