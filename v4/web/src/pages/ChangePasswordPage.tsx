import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth, useProfile } from '../auth/AuthContext';
import { Alert } from '../components/Alert';
import { NewPasswordForm } from '../components/NewPasswordForm';
import { PageHeader } from '../components/PageHeader';

export function ChangePasswordPage() {
  const { verifyCurrentPassword, updatePassword } = useAuth();
  const { profile } = useProfile();
  // Diingat dari render pertama: setelah berhasil, penanda di profil hilang tetapi pesan sukses harus tetap benar.
  const [wasForced] = useState(profile.must_change_password);
  const [done, setDone] = useState(false);
  const [formKey, setFormKey] = useState(0);
  return (
    <>
      <PageHeader
        title={wasForced ? 'Ganti kata sandi sementara' : 'Ubah kata sandi'}
        subtitle={wasForced ? undefined : 'Ganti kata sandi akun Anda sendiri.'}
      />
      <section className="card narrow">
        {wasForced && !done ? (
          <Alert tone="warning">
            <strong>Anda masuk dengan kata sandi sementara dari admin.</strong>{' '}
            <span>Buat kata sandi baru yang hanya Anda ketahui sebelum memakai aplikasi. Kata sandi saat ini adalah kata sandi sementara tersebut.</span>
          </Alert>
        ) : null}
        {done ? (
          <Alert tone="success">
            <span>Kata sandi berhasil diubah. Gunakan kata sandi baru saat masuk berikutnya.</span>
          </Alert>
        ) : null}
        {done && wasForced ? (
          <Link to="/dashboard" className="btn btn-primary btn-block">
            Lanjut ke aplikasi
          </Link>
        ) : null}
        {done && wasForced ? null : (
          <NewPasswordForm
            key={formKey}
            requireCurrent
            submitLabel="Simpan kata sandi"
            onSubmit={async ({ current, next }) => {
              await verifyCurrentPassword(current);
              await updatePassword(next);
              setDone(true);
              setFormKey((k) => k + 1);
            }}
          />
        )}
      </section>
    </>
  );
}
