import { useState, type FormEvent } from 'react';
import { PasswordField } from './Field';
import { Alert } from './Alert';
import { MIN_PASSWORD_LENGTH, validateConfirm, validateNewPassword, validatePasswordPresent } from '../auth/validation';
import { ApiError } from '../lib/api';
import { toUserMessage, type UserMessage } from '../lib/errors';

interface Props {
  requireCurrent: boolean;
  submitLabel: string;
  onSubmit(values: { current: string; next: string }): Promise<void>;
}

type Errors = { current?: string | undefined; next?: string | undefined; confirm?: string | undefined };

export function NewPasswordForm({ requireCurrent, submitLabel, onSubmit }: Props) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [visible, setVisible] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<UserMessage | null>(null);
  const [busy, setBusy] = useState(false);

  async function handle(e: FormEvent) {
    e.preventDefault();
    const v: Errors = {
      current: requireCurrent ? validatePasswordPresent(current) : undefined,
      next: validateNewPassword(next),
      confirm: validateConfirm(confirm, next),
    };
    if (!v.next && requireCurrent && next === current) v.next = 'Kata sandi baru harus berbeda dari kata sandi saat ini.';
    setErrors(v);
    setFormError(null);
    if (v.current || v.next || v.confirm) return;
    setBusy(true);
    try {
      await onSubmit({ current, next });
    } catch (err) {
      setFormError(err instanceof ApiError ? err.userMessage : toUserMessage(err));
      setBusy(false);
    }
  }

  const toggle = () => setVisible((x) => !x);
  return (
    <form onSubmit={handle} noValidate className="stack">
      {formError ? <Alert tone="error" message={formError} /> : null}
      {requireCurrent ? (
        <PasswordField label="Kata sandi saat ini" name="current-password" autoComplete="current-password" value={current}
          onChange={(e) => setCurrent(e.target.value)} error={errors.current} visible={visible} onToggle={toggle} />
      ) : null}
      <PasswordField label="Kata sandi baru" name="new-password" autoComplete="new-password" value={next}
        onChange={(e) => setNext(e.target.value)} error={errors.next} visible={visible} onToggle={toggle}
        hint={`Minimal ${MIN_PASSWORD_LENGTH} karakter, campuran huruf dan angka.`} />
      <PasswordField label="Ulangi kata sandi baru" name="confirm-password" autoComplete="new-password" value={confirm}
        onChange={(e) => setConfirm(e.target.value)} error={errors.confirm} visible={visible} onToggle={toggle} />
      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
        {busy ? 'Menyimpan…' : submitLabel}
      </button>
    </form>
  );
}
