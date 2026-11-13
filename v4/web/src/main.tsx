import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { readConfig } from './config';
import { detectRecoveryLink, getSupabase } from './lib/supabase';
import './styles/global.css';

const config = readConfig();
// Dibaca sebelum klien Supabase dibuat (klien membersihkan fragmen URL).
const initialRecovery = detectRecoveryLink(window.location);
if (config.ok) getSupabase(config); // inisialisasi dini: membaca token dari URL
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <BrowserRouter>
        <App config={config} createClient={getSupabase} initialRecovery={initialRecovery} />
      </BrowserRouter>
    </StrictMode>,
  );
}
