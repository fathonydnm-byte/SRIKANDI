# Central File UINSA v4

Aplikasi web (PWA) pengganti Central File 3.x (Apps Script). Acuan produk: [`docs/PRD_CENTRAL_FILE_V4_2026-11-13.md`](../docs/PRD_CENTRAL_FILE_V4_2026-11-13.md). Produksi 3.x tetap berjalan sampai cutover (S7).

## Struktur

```
v4/
├── web/        Tampilan: Vite + React + TypeScript, PWA, di-host di Cloudflare Pages
├── supabase/   Skema Postgres, RLS, seed (migrasi Supabase)
├── gateway-apps-script/  Gerbang token Drive (Apps Script, akun instansi) — cara pasang: PASANG.md
└── tests/db/   Tes skema/RLS (jalankan: bash v4/tests/db/run.sh)
```

Isi `web/src/`:

| Folder/berkas | Isi |
| --- | --- |
| `auth/permissions.ts` | Satu-satunya matriks peran → kemampuan (PRD §4) dan daftar modul; dipakai navigasi **dan** penjaga rute |
| `auth/AuthContext.tsx`, `auth/guards.tsx` | Sesi Supabase Auth, profil + unit, penjaga rute |
| `lib/supabase.ts` | Pembuatan klien Supabase (satu tempat) |
| `lib/api.ts` | Akses data; `callWrite()` selalu mengirim `requestId` (UUID) sebagai kunci idempotensi |
| `lib/files.ts` | Satu-satunya jalur membuka file: minta tiket ke `/api/files/ticket`, lalu buka `/api/files/download` (Lihat / Unduh / Bagikan berkas ≤ 20 MB) |
| `../functions/`, `../server/` | Cloudflare Pages Functions jembatan unduh (tiket HMAC 60 detik, audit, streaming Drive dengan Range) |
| `pages/search/`, `pages/detail/` | Cari Arsip (kriteria di URL), detail item, Daftar Isi Berkas |
| `lib/errors.ts` | Penerjemah error teknis → pesan yang bisa ditindaklanjuti |
| `pages/`, `components/` | Layar dan komponen; modul yang belum dibangun memakai `PlaceholderPage` |
| `public/_redirects`, `public/_headers` | SPA fallback dan header keamanan (CSP dsb.) Cloudflare Pages |

## Menjalankan di komputer

Butuh Node.js ≥ 20.

```bash
cd v4/web
cp .env.example .env.local   # isi URL dan anon key proyek Supabase staging
npm ci
npm run dev                  # http://localhost:5173
```

Tanpa `.env.local` aplikasi tetap terbuka dan menampilkan layar "Konfigurasi aplikasi belum lengkap".

Perintah lain: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run preview`.

### Variabel lingkungan

| Nama | Isi |
| --- | --- |
| `VITE_SUPABASE_URL` | `https://<ref>.supabase.co` (http hanya untuk `localhost`) |
| `VITE_SUPABASE_ANON_KEY` | Anon (publishable) key proyek Supabase |

Keduanya tertanam di bundel browser (bukan rahasia), tetapi tetap **jangan di-commit**; repo ini publik. Service role key dan secret lain tidak pernah masuk ke `web/`.

## Akun

Tidak ada pendaftaran mandiri. Admin membuat akun di Supabase Auth, lalu mengisi baris `public.profiles` (`role`, `unit_id`, `active = true`). Akun tanpa profil atau `active = false` hanya melihat layar "Akun belum diaktifkan".

Di Supabase → Authentication → URL Configuration, isi **Site URL** dengan domain Pages dan tambahkan `https://<domain>/atur-sandi` ke **Redirect URLs** agar tautan "Lupa kata sandi" berfungsi.

## Deploy ke Cloudflare Pages

| Pengaturan | Nilai |
| --- | --- |
| Root directory | `v4/web` |
| Build command | `npm ci && npm run build` |
| Build output directory | `dist` |
| Environment variables | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (Production = proyek produksi, Preview = staging), `NODE_VERSION=22` |

`_redirects` mengarahkan semua rute ke `index.html`; `_headers` memasang CSP (hanya `self` + `https://*.supabase.co`), `frame-ancestors 'none'`, HSTS, dan Referrer-Policy. Bila kelak memakai domain Supabase kustom atau Pages Functions di origin lain, perbarui `connect-src` di `_headers`.

## Data baca (Sprint 1)

Layar baca memakai RPC di `supabase/migrations/0006_search.sql`, semuanya SECURITY INVOKER sehingga RLS tetap berlaku: `search_archive` (port `searchArchive_` 3.x), `get_item_detail`, `get_berkas_detail`, `dashboard_counts`, plus `my_account_status` (0005) untuk layar akun tertahan.

## Jembatan unduh file

Pengguna tidak punya akses Google Drive. Alurnya: browser → `POST /api/files/ticket` (JWT Supabase; hak akses dicek `get_file_access` di bawah RLS, akses dicatat `log_file_access`) → tiket 60 detik → `GET /api/files/download?t=…` → token Drive dari gerbang Apps Script (permintaan bertanda tangan HMAC) → file dialirkan dari Drive API.

Variabel server di Cloudflare Pages (Settings → Variables and Secrets, tipe Secret): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `FILE_TICKET_SECRET`, `DRIVE_GATEWAY_URL`, `DRIVE_GATEWAY_SECRET`. Tanpa service-role key. Selama gerbang belum dipasang, tombol file menampilkan "Jembatan Drive belum dipasang". Mode darurat lama (buka URL Drive langsung) hanya bila build diberi `VITE_FILE_ACCESS_MODE=drive-url`.

## CI

`.github/workflows/v4-ci.yml` berjalan untuk perubahan di `v4/**`: job **web** (typecheck termasuk Functions, lint, tes, build, tes gerbang Apps Script) dan job **db** (`v4/tests/db/run.sh` dengan PostgreSQL 16 dari runner).
