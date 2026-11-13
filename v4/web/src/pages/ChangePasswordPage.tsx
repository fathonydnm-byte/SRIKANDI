import { useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { Alert } from '../components/Alert';
import { NewPasswordForm } from '../components/NewPasswordForm';
import { PageHeader } from '../components/PageHeader';

export function ChangePasswordPage() {
  const { verifyCurrentPassword, updatePassword } = useAuth();
  const [done, setDone] = useState(false);
  const [formKey, setFormKey] = useState(0);
  return (
    <>
      <PageHeader title="Ubah kata sandi" subtitle="Ganti kata sandi akun Anda sendiri." />
      <section className="card narrow">
        {done ? (
          <Alert tone="success">
            <span>Kata sandi berhasil diubah. Gunakan kata sandi baru saat masuk berikutnya.</span>
          </Alert>
        ) : null}
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
      </section>
    </>
  );
}
