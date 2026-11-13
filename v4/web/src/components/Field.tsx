import { useId, type InputHTMLAttributes, type ReactNode } from 'react';

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  label: string;
  error?: string | undefined;
  hint?: ReactNode;
  trailing?: ReactNode;
}

/** Input berlabel dengan pesan error yang terhubung lewat aria-describedby. */
export function Field({ label, error, hint, trailing, ...input }: FieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`field${error ? ' field-invalid' : ''}`}>
      <label htmlFor={id}>{label}</label>
      <div className="field-control">
        <input id={id} aria-invalid={error ? true : undefined} aria-describedby={describedBy} {...input} />
        {trailing}
      </div>
      {hint ? (
        <small id={hintId} className="field-hint">
          {hint}
        </small>
      ) : null}
      {error ? (
        <small id={errorId} className="field-error">
          {error}
        </small>
      ) : null}
    </div>
  );
}

export function PasswordField(props: Omit<FieldProps, 'type' | 'trailing'> & { visible: boolean; onToggle(): void }) {
  const { visible, onToggle, ...rest } = props;
  return (
    <Field
      {...rest}
      type={visible ? 'text' : 'password'}
      trailing={
        <button type="button" className="field-toggle" onClick={onToggle} aria-pressed={visible} aria-label={visible ? 'Sembunyikan kata sandi' : 'Tampilkan kata sandi'}>
          {visible ? 'Sembunyikan' : 'Tampilkan'}
        </button>
      }
    />
  );
}
