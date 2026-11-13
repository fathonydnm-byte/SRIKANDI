import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { checkHealth, type HealthResult } from '../lib/api';

type State = { kind: 'checking' } | { kind: 'done'; result: HealthResult };

export function HealthIndicator() {
  const { client } = useAuth();
  const [state, setState] = useState<State>({ kind: 'checking' });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void checkHealth(client).then((result) => {
      if (!cancelled) setState({ kind: 'done', result });
    });
    return () => {
      cancelled = true;
    };
  }, [client, nonce]);

  const recheck = useCallback(() => {
    setState({ kind: 'checking' });
    setNonce((n) => n + 1);
  }, []);

  let tone = 'neutral';
  let label = 'Memeriksa koneksi…';
  let detail: string | null = null;
  if (state.kind === 'done') {
    if (state.result.ok) {
      tone = 'ok';
      label = 'Terhubung ke server';
      detail = `Waktu respons ${state.result.latencyMs} ms`;
    } else {
      tone = 'bad';
      label = state.result.message?.title ?? 'Server tidak terjangkau.';
      detail = state.result.message?.action ?? null;
    }
  }

  return (
    <div className="health" data-tone={tone}>
      <span className="health-dot" aria-hidden="true" />
      <div className="health-text" role="status" aria-live="polite">
        <strong>{label}</strong>
        {detail ? <span>{detail}</span> : null}
      </div>
      <button type="button" className="btn btn-secondary btn-sm" onClick={recheck} disabled={state.kind === 'checking'}>
        Periksa ulang
      </button>
    </div>
  );
}
