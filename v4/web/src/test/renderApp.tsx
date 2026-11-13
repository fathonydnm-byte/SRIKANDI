import { render } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AuthProvider } from '../auth/AuthContext';
import { AppRoutes } from '../App';

/** Menampilkan URL saat ini agar tes bisa memeriksa query string. */
function LocationProbe() {
  const l = useLocation();
  return <output data-testid="location">{l.pathname + l.search}</output>;
}

export function renderApp(path: string, client: SupabaseClient, opts: { initialRecovery?: boolean } = {}) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider client={client} initialRecovery={opts.initialRecovery ?? false}>
        <AppRoutes />
        <LocationProbe />
      </AuthProvider>
    </MemoryRouter>,
  );
}
