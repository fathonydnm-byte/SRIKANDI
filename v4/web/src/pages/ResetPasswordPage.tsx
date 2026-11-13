import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { CenteredCard } from '../components/CenteredCard';
import { Alert } from '../components/Alert';
import { FullScreenLoading } from '../components/FullScreenLoading';
import { NewPasswordForm } from '../components/NewPasswordForm';

function readLinkError(): string | null {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, '') || window.location.search);
  return params.get('error_code') ?? params.get('error');
}

/** Halaman tujuan tautan pemulihan dari email "lupa kata sandi". */
export function ResetPasswordPage() {
  const { state, recovery, updatePassword } = useAuth();
  const [linkError] = useState(readLinkError);
  const [done, setDone] = useState(false);

  if (done) {
    return (
      <CenteredCard title="Kata sandi diperbarui">
        <Alert tone="success">
          <span>Kata sandi baru sudah tersimpan. Gunakan kata sandi ini saat masuk berikutnya.</span>
        </Alert>
        <Link to="/dashboard" className="btn btn-primary btn-block">
          Lanjut ke aplikasi
        </Link>
      </CenteredCard>
    );
  }

  if (state.status === 'loading') return <FullScreenLoading label="Memeriksa tautan…" />;

  if (state.status === 'signedIn' && !recovery) return <Navigate to="/akun/kata-sandi" replace />;

  if (state.status === 'signedOut' || linkError) {
    return (
      <CenteredCard title="Tautan tidak dapat dipakai">
        <Alert tone="error">
          <strong>Tautan pembuatan kata sandi tidak valid atau sudah kedaluwarsa.</strong>{' '}
          <span>Minta tautan baru, lalu buka tautan terbaru dari email Anda.</span>
        </Alert>
        <Link to="/lupa-sandi" className="btn btn-primary btn-block">
          Minta tautan baru
        </Link>
        <div className="form-links">
          <Link to="/masuk">Kembali ke halaman masuk</Link>
        </div>
      </CenteredCard>
    );
  }

  return (
    <CenteredCard title="Buat kata sandi baru" subtitle={state.session.user.email ? `Untuk akun ${state.session.user.email}` : undefined}>
      <NewPasswordForm
        requireCurrent={false}
        submitLabel="Simpan kata sandi"
        onSubmit={async ({ next }) => {
          await updatePassword(next);
          setDone(true);
        }}
      />
    </CenteredCard>
  );
}
