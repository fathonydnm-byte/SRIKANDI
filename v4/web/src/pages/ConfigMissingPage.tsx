import { CenteredCard } from '../components/CenteredCard';
import { Alert } from '../components/Alert';

export function ConfigMissingPage({ missing, invalid }: { missing: string[]; invalid: string[] }) {
  return (
    <CenteredCard title="Konfigurasi aplikasi belum lengkap">
      <Alert tone="error">
        <strong>Aplikasi belum dapat terhubung ke server.</strong>{' '}
        <span>Pengaturan koneksi Supabase tidak ditemukan atau tidak valid pada build ini.</span>
      </Alert>
      <ul className="config-list" aria-label="Variabel bermasalah">
        {missing.map((name) => (
          <li key={name}>
            <code>{name}</code> — belum diisi
          </li>
        ))}
        {invalid.map((name) => (
          <li key={name}>
            <code>{name}</code> — format tidak valid (harus alamat https://…supabase.co)
          </li>
        ))}
      </ul>
      <p className="muted small">
        <strong>Bagi pengguna:</strong> laporkan pesan ini ke Admin Pusat.
        <br />
        <strong>Bagi pengelola:</strong> isi variabel di atas pada pengaturan Environment Variables Cloudflare Pages (atau file{' '}
        <code>.env.local</code> saat pengembangan), lalu build ulang.
      </p>
    </CenteredCard>
  );
}
