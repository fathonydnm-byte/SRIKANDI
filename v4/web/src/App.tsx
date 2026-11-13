import type { SupabaseClient } from '@supabase/supabase-js';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { PublicOnly, RequireAuth, RequireModule } from './auth/guards';
import { MODULES } from './auth/permissions';
import { AppShell } from './components/AppShell';
import type { AppConfig } from './config';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { ConfigMissingPage } from './pages/ConfigMissingPage';
import { DashboardPage } from './pages/DashboardPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { PlaceholderPage } from './pages/PlaceholderPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/masuk" element={<PublicOnly><LoginPage /></PublicOnly>} />
      <Route path="/lupa-sandi" element={<PublicOnly><ForgotPasswordPage /></PublicOnly>} />
      <Route path="/atur-sandi" element={<ResetPasswordPage />} />
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/dashboard" replace />} />
          {MODULES.map((m) => (
            <Route
              key={m.id}
              path={m.path}
              element={<RequireModule module={m}>{m.id === 'dashboard' ? <DashboardPage /> : <PlaceholderPage module={m} />}</RequireModule>}
            />
          ))}
          <Route path="/akun/kata-sandi" element={<ChangePasswordPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  );
}

/**
 * `createClient` disuntikkan agar tes dapat memakai klien tiruan dan agar
 * konfigurasi yang hilang tidak pernah memanggil Supabase.
 */
export function App({
  config,
  createClient,
  initialRecovery = false,
}: {
  config: AppConfig;
  createClient(config: Extract<AppConfig, { ok: true }>): SupabaseClient;
  initialRecovery?: boolean;
}) {
  if (!config.ok) return <ConfigMissingPage missing={config.missing} invalid={config.invalid} />;
  return (
    <AuthProvider client={createClient(config)} initialRecovery={initialRecovery}>
      <AppRoutes />
    </AuthProvider>
  );
}
