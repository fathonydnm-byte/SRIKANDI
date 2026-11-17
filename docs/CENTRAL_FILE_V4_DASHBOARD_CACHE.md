# Central File v4: dashboard lama setelah deploy

## Temuan (17 November 2026 WIB)

- URL staging `/dashboard` melayani bundle yang berisi **Daftar Isi Berkas** dan
  tidak memuat **Koneksi server**. Kotak **Koneksi server** berasal dari
  dashboard sebelum commit `361d85e`. Kedua desain bukan varian responsive
  dari satu halaman.
- Workbox sebelumnya merespons navigasi menggunakan `index.html` dari
  precache, bahkan saat online. Worker yang sudah mengontrol perangkat bisa
  menyajikan HTML dan bundle versi lama. Walau Vite PWA diberi `autoUpdate`,
  kombinasi konfigurasi `injectRegister: 'script-defer'` menghasilkan
  worker yang menunggu tab lama ditutup atau menunggu pesan `SKIP_WAITING`
  yang tidak dikirim oleh skrip registrasi. `Cache-Control: no-cache`
  hanya mengatur cache HTTP; itu tidak mengganti hasil yang dikembalikan
  route precache.

## Perbaikan

Pertahankan URL service worker `/sw.js` dan cakupan `/` supaya browser lama
dapat memperbaruinya. Saat online, ambil HTML dari jaringan untuk navigasi
situs (termasuk `/`, `/index.html`, dan `/dashboard`); gunakan shell
precache hanya saat jaringan gagal. Jangan simpan respons API atau HTML
per rute di cache. Worker baru aktif tanpa menutup tab dan tanpa memuat
ulang formulir yang sedang dibuka. Navigasi atau muat ulang berikutnya
membuka rilis yang sedang dilayani.

## Langkah untuk pengguna yang sudah melihat versi lama

Simpan pekerjaan yang masih terbuka, lalu tekan **Ctrl+Shift+R** pada
Central File di Edge/Chrome desktop. Bila tampilan kembali lama
pada pembukaan normal, tutup semua tab Central File (termasuk jendela
aplikasi PWA bila terbuka), lalu buka kembali URL staging. Tidak perlu
menghapus seluruh riwayat/cache browser. Bila tab lama masih terkunci,
DevTools → Application → Service Workers → **Unregister** khusus origin
Central File, lalu muat ulang sekali. Jangan pilih **Clear site data**
untuk prosedur ini; tindakan itu juga menghapus sesi lokal.
