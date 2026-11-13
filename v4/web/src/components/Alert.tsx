import type { ReactNode } from 'react';
import type { UserMessage } from '../lib/errors';

type Tone = 'error' | 'success' | 'info' | 'warning';

export function Alert({ tone = 'info', message, children, id }: { tone?: Tone; message?: UserMessage; children?: ReactNode; id?: string }) {
  const role = tone === 'error' ? 'alert' : 'status';
  return (
    <div className={`alert alert-${tone}`} role={role} id={id}>
      {message ? (
        <>
          <strong>{message.title}</strong> <span>{message.action}</span>
        </>
      ) : (
        children
      )}
    </div>
  );
}
