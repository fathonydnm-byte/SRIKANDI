import { useState } from 'react';
import { useAuth, type BlockedReason } from '../auth/AuthContext';
import { CenteredCard } from '../components/CenteredCard';
import { Alert } from '../components/Alert';
import type { UserMessage } from '../lib/errors';

const REASONS: Record<BlockedReason, { title: string; body: string }> = {
  missing: {
    title: 'Akun belum diaktifkan',
    body: 'Anda berhasil masuk, tetapi akun ini belum didaftarkan ke unit mana pun. Hubungi admin unit Anda agar akun diaktifkan, lalu masuk kembali.',
  },
  inactive: {
    title: 'Akun belum diaktifkan',
    body: 'Akun Anda sedang nonaktif. Hubungi admin unit Anda untuk mengaktifkannya, lalu masuk kembali.',
  },
  no_unit: {
    title: 'Akun belum diaktifkan',
    body: 'Akun Anda belum terhubung ke unit kerja. Hubungi admin unit untuk menetapkan unit Anda, lalu masuk kembali.',
  },
  unit_inactive: {
    title: 'Unit sedang nonaktif',
    body: 'Unit kerja akun Anda sedang dinonaktifkan. Hubungi Admin Pusat untuk informasi lebih lanjut.',
  },
  invalid_role: {
    title: 'Akun belum diaktifkan',
    body: 'Peran akun Anda belum diatur dengan benar. Hubungi admin unit untuk memperbaikinya, lalu masuk kembali.',
  },
};

function SignOutButton() {
  const { signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn btn-secondary btn-block"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void signOut();
      }}
    >
      {busy ? 'Keluar…' : 'Keluar'}
    </button>
  );
}

export function AccountBlockedPage({ reason }: { reason: BlockedReason }) {
  const { state } = useAuth();
  const email = state.status === 'signedIn' ? state.session.user.email : undefined;
  const r = REASONS[reason];
  return (
    <CenteredCard title={r.title}>
      <Alert tone="warning">
        <span>{r.body}</span>
      </Alert>
      {email ? (
        <p className="muted small">
          Masuk sebagai <strong>{email}</strong>
        </p>
      ) : null}
      <div className="stack">
        <SignOutButton />
      </div>
    </CenteredCard>
  );
}

export function ProfileErrorPage({ message }: { message: UserMessage }) {
  const { reloadProfile } = useAuth();
  return (
    <CenteredCard title="Profil tidak dapat dimuat">
      <Alert tone="error" message={message} />
      <div className="stack">
        <button type="button" className="btn btn-primary btn-block" onClick={reloadProfile}>
          Coba lagi
        </button>
        <SignOutButton />
      </div>
    </CenteredCard>
  );
}
