import { useOnline } from '../lib/useOnline';

/** Aplikasi online penuh: saat koneksi putus, tampilkan keadaan yang jelas. */
export function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div className="offline-banner" role="status" aria-live="polite">
      <strong>Tidak ada koneksi internet.</strong> Central File memerlukan koneksi untuk membaca dan menyimpan data.
      Periksa Wi-Fi atau data seluler Anda; halaman akan bisa dipakai lagi setelah tersambung.
    </div>
  );
}
