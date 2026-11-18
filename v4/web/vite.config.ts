/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'script-defer',
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      manifest: {
        name: 'Central File UINSA',
        short_name: 'Central File',
        description: 'Pengelolaan arsip aktif unit kerja UIN Sunan Ampel Surabaya',
        lang: 'id',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#F8FAFC',
        theme_color: '#0B4D2C',
        icons: [
          { src: 'uinsa-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'uinsa-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'uinsa-icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      injectManifest: {
        // Aset dan shell saja; tidak pernah menyimpan respons Supabase atau Pages Functions.
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'],
        globIgnores: ['ocr/**'], // Models and OCR engines download only on demand.
      },
    }),
  ],
  build: {
    sourcemap: false,
    rolldownOptions: {
      output: {
        // Pisahkan vendor agar cache browser bertahan antar-rilis aplikasi.
        codeSplitting: {
          groups: [
            { name: 'supabase', test: /node_modules[\\/]@supabase[\\/]/ },
            { name: 'react', test: /node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/ },
          ],
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    restoreMocks: true,
  },
});
