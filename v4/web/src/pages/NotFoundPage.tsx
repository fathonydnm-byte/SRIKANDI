import { Link } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';

export function NotFoundPage() {
  return (
    <>
      <PageHeader title="Halaman tidak ditemukan" subtitle="Alamat yang Anda buka tidak ada di Central File." />
      <section className="card placeholder">
        <p>Periksa kembali alamatnya, atau kembali ke Dashboard lewat tombol di bawah.</p>
        <Link to="/dashboard" className="btn btn-primary">
          Ke Dashboard
        </Link>
      </section>
    </>
  );
}
