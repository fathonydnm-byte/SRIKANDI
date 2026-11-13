import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AuthProvider } from '../auth/AuthContext';
import { AppRoutes } from '../App';

export function renderApp(path: string, client: SupabaseClient, opts: { initialRecovery?: boolean } = {}) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider client={client} initialRecovery={opts.initialRecovery ?? false}>
        <AppRoutes />
      </AuthProvider>
    </MemoryRouter>,
  );
}
