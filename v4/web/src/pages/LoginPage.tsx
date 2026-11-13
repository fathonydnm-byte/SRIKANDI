import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { validateEmail, validatePasswordPresent } from '../auth/validation';
import { CenteredCard } from '../components/CenteredCard';
import { Field, PasswordField } from '../components/Field';
import { Alert } from '../components/Alert';
import { ApiError } from '../lib/api';
import { toUserMessage, type UserMessage } from '../lib/errors';

export function LoginPage() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<{ email?: string | undefined; password?: string | undefined }>({});
  const [formError, setFormError] = useState<UserMessage | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const next = { email: validateEmail(email), password: validatePasswordPresent(password) };
    setErrors(next);
    setFormError(null);
    if (next.email || next.password) {
      const form = e.currentTarget;
      const firstInvalid = form.querySelector<HTMLInputElement>(next.email ? 'input[type="email"]' : 'input[autocomplete="current-password"]');
      firstInvalid?.focus();
      return;
    }
    setBusy(true);
    try {
      await signIn(email.trim(), password);
      // Navigasi ditangani PublicOnly saat sesi berubah.
    } catch (err) {
      setFormError(err instanceof ApiError ? err.userMessage : toUserMessage(err));
      setBusy(false);
    }
  }

  return (
    <CenteredCard title="Masuk" subtitle="Gunakan email dan kata sandi akun Central File Anda.">
      <form onSubmit={onSubmit} noValidate className="stack" aria-describedby={formError ? 'login-error' : undefined}>
        {formError ? <Alert tone="error" message={formError} id="login-error" /> : null}
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
          error={errors.email}
        />
        <PasswordField
          label="Kata sandi"
          name="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
          visible={showPassword}
          onToggle={() => setShowPassword((v) => !v)}
        />
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Memproses…' : 'Masuk'}
        </button>
        <div className="form-links">
          <Link to="/lupa-sandi">Lupa kata sandi?</Link>
        </div>
      </form>
      <p className="muted small footnote">Akun dibuat oleh admin unit. Belum punya akun? Hubungi admin unit Anda.</p>
    </CenteredCard>
  );
}
