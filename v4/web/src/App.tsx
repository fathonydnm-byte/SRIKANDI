import type { SupabaseClient } from '@supabase/supabase-js';
import { lazy, Suspense, type ReactElement } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import { PublicOnly, RequireAuth, RequireModule } from './auth/guards';
import { MODULES } from './auth/permissions';
import { AppShell } from './components/AppShell';
import type { AppConfig } from './config';
import { ChangePasswordPage } from './pages/ChangePasswordPage';
import { ConfigMissingPage } from './pages/ConfigMissingPage';
import { DashboardPage } from './pages/dashboard/DashboardPage';
import { ShortcutListPage } from './pages/dashboard/ShortcutListPage';
import { BerkasDetailPage } from './pages/detail/BerkasDetailPage';
import { ItemDetailPage } from './pages/detail/ItemDetailPage';
import { SearchPage } from './pages/search/SearchPage';
// Layar registrasi dimuat terpisah (PIMPINAN dan pencarian dari HP tidak perlu mengunduhnya).
const ReceiptsPage = lazy(() => import('./pages/s2/ReceiptsPage').then((m) => ({ default: m.ReceiptsPage })));
const RegistrationPage = lazy(() => import('./pages/s2/RegistrationPage').then((m) => ({ default: m.RegistrationPage })));
const MasterLogPage = lazy(() => import('./pages/s3/MasterLogPage').then((m) => ({ default: m.MasterLogPage })));
const LabelsPage = lazy(() => import('./pages/s3/LabelsPage').then((m) => ({ default: m.LabelsPage })));
const EditPage = lazy(() => import('./pages/s3/EditPage').then((m) => ({ default: m.EditPage })));
const CancelPage = lazy(() => import('./pages/s3/CancelPage').then((m) => ({ default: m.CancelPage })));
const QuarantinePage = lazy(() => import('./pages/s3/QuarantinePage').then((m) => ({ default: m.QuarantinePage })));
const MediaPage = lazy(() => import('./pages/s2/MediaPage').then((m) => ({ default: m.MediaPage })));
const ReceiptPrintPage = lazy(() => import('./pages/s2/ReceiptPrintPage').then((m) => ({ default: m.ReceiptPrintPage })));

function Lazy({ children }: { children: ReactElement }) {
  return <Suspense fallback={<p className="muted detail-loading" role="status">Memuat halaman…</p>}>{children}</Suspense>;
}
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { LoginPage } from './pages/LoginPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { PlaceholderPage } from './pages/PlaceholderPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';

/** Modul yang sudah dibangun; sisanya memakai PlaceholderPage. */
const BUILT: Record<string, () => ReactElement> = {
  dashboard: () => <DashboardPage />,
  cari: () => <SearchPage />,
  penerimaan: () => <Lazy><ReceiptsPage /></Lazy>,
  pemberkasan: () => <Lazy><RegistrationPage /></Lazy>,
  'alih-media': () => <Lazy><MediaPage /></Lazy>,
  'lidah-folder': () => <Lazy><LabelsPage /></Lazy>,
  'master-log': () => <Lazy><MasterLogPage /></Lazy>,
  edit: () => <Lazy><EditPage /></Lazy>,
  koreksi: () => <Lazy><CancelPage /></Lazy>,
  karantina: () => <Lazy><QuarantinePage /></Lazy>,
};
const CARI = MODULES.find((m) => m.id === 'cari')!;
const DASHBOARD = MODULES.find((m) => m.id === 'dashboard')!;
const PENERIMAAN = MODULES.find((m) => m.id === 'penerimaan')!;

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
              element={<RequireModule module={m}>{BUILT[m.id]?.() ?? <PlaceholderPage module={m} />}</RequireModule>}
            />
          ))}
          <Route path="/penerimaan/:receiptId/cetak" element={<RequireModule module={PENERIMAAN}><Lazy><ReceiptPrintPage /></Lazy></RequireModule>} />
          <Route path="/dashboard/:slug" element={<RequireModule module={DASHBOARD}><ShortcutListPage /></RequireModule>} />
          <Route path="/cari/item/:itemId" element={<RequireModule module={CARI}><ItemDetailPage /></RequireModule>} />
          <Route path="/cari/berkas/:berkasId" element={<RequireModule module={CARI}><BerkasDetailPage /></RequireModule>} />
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
