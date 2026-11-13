import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth, useProfile } from '../auth/AuthContext';
import { findModuleByPath, mobileNav, NAV_GROUP_ORDER, ROLE_LABELS, visibleModules, type ModuleDef } from '../auth/permissions';
import { BrandMark } from './BrandMark';
import { OfflineBanner } from './OfflineBanner';
import { UnitSwitcher, useActiveUnitLabel } from './UnitSwitcher';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? (parts[0]![0] ?? '') + (parts[parts.length - 1]![0] ?? '') : (parts[0] ?? '–').slice(0, 2);
  return letters.toUpperCase();
}

function pageLabel(pathname: string): string {
  if (pathname === '/akun/kata-sandi') return 'Ubah kata sandi';
  return findModuleByPath(pathname)?.label ?? 'Halaman';
}

function SignOutButton({ className }: { className: string }) {
  const { signOut } = useAuth();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={className}
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void signOut();
      }}
    >
      <span className="nav-icon" aria-hidden="true">🚪</span>
      <span className="nav-label">{busy ? 'Keluar…' : 'Keluar'}</span>
    </button>
  );
}

function Sidebar({ modules }: { modules: ModuleDef[] }) {
  const { profile } = useProfile();
  const unitLabel = useActiveUnitLabel();
  return (
    <aside className="sidebar" aria-label="Menu samping">
      <div className="brand">
        <span className="brand-mark">
          <BrandMark />
        </span>
        <div className="brand-text">
          <strong>Central File</strong>
          <small>{unitLabel}</small>
        </div>
      </div>
      <nav className="sidebar-nav">
        {NAV_GROUP_ORDER.map((group) => {
          const items = modules.filter((m) => m.group === group);
          if (!items.length) return null;
          return (
            <div key={group} className="nav-group" role="group" aria-labelledby={group === 'Utama' ? undefined : `nav-${group}`}>
              {group !== 'Utama' ? (
                <div className="nav-group-title" id={`nav-${group}`}>
                  {group}
                </div>
              ) : null}
              {items.map((m) => (
                <NavLink key={m.id} to={m.path} className="nav-button">
                  <span className="nav-icon" aria-hidden="true">{m.icon}</span>
                  <span className="nav-label">{m.label}</span>
                </NavLink>
              ))}
            </div>
          );
        })}
      </nav>
      <div className="sidebar-footer">
        <div className="sidebar-user">
          <span className="avatar" aria-hidden="true">{initials(profile.full_name)}</span>
          <div className="sidebar-user-meta">
            <strong>{profile.full_name}</strong>
            <span>{ROLE_LABELS[profile.role]}</span>
          </div>
        </div>
        <NavLink to="/akun/kata-sandi" className="nav-button">
          <span className="nav-icon" aria-hidden="true">🔑</span>
          <span className="nav-label">Ubah kata sandi</span>
        </NavLink>
        <SignOutButton className="nav-button" />
      </div>
    </aside>
  );
}

function MoreSheet({ modules, onClose }: { modules: ModuleDef[]; onClose(): void }) {
  const { profile } = useProfile();
  const unitLabel = useActiveUnitLabel();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>('a, button, select');
    first?.focus();
  }, []);

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !ref.current) return;
    const focusables = Array.from(ref.current.querySelectorAll<HTMLElement>('a, button, select')).filter((el) => !el.hasAttribute('disabled'));
    if (!focusables.length) return;
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="sheet-root">
      <div className="sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title" ref={ref} onKeyDown={onKeyDown}>
        <div className="sheet-header">
          <h2 id="sheet-title">Lainnya</h2>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Tutup menu Lainnya">
            ✕
          </button>
        </div>
        <div className="sheet-user">
          <span className="avatar" aria-hidden="true">{initials(profile.full_name)}</span>
          <div>
            <strong>{profile.full_name}</strong>
            <span>
              {ROLE_LABELS[profile.role]} · {unitLabel}
            </span>
          </div>
        </div>
        <UnitSwitcher />
        {modules.length ? (
          <nav aria-label="Modul lainnya" className="sheet-nav">
            {modules.map((m) => (
              <NavLink key={m.id} to={m.path} className="nav-button" onClick={onClose}>
                <span className="nav-icon" aria-hidden="true">{m.icon}</span>
                <span className="nav-label">{m.label}</span>
              </NavLink>
            ))}
          </nav>
        ) : null}
        <div className="sheet-nav sheet-account">
          <NavLink to="/akun/kata-sandi" className="nav-button" onClick={onClose}>
            <span className="nav-icon" aria-hidden="true">🔑</span>
            <span className="nav-label">Ubah kata sandi</span>
          </NavLink>
          <SignOutButton className="nav-button" />
        </div>
      </div>
    </div>
  );
}

export function AppShell() {
  const { profile } = useProfile();
  const location = useLocation();
  const modules = visibleModules(profile.role);
  const { primary, more } = mobileNav(profile.role);
  const [sheetOpen, setSheetOpen] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const firstRender = useRef(true);
  const unitLabel = useActiveUnitLabel();

  // Pindahkan fokus ke judul halaman setelah navigasi (pembaca layar).
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    document.getElementById('page-title')?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, [location.pathname]);

  const closeSheet = () => {
    setSheetOpen(false);
    moreButton.current?.focus();
  };
  const moreActive = more.some((m) => m.path === location.pathname) || location.pathname === '/akun/kata-sandi';

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Langsung ke konten
      </a>
      <Sidebar modules={modules} />
      <div className="shell-main">
        <header className="topbar">
          <Link to="/dashboard" className="topbar-brand" aria-label="Central File — ke Dashboard">
            <span className="brand-mark small">
              <BrandMark size={22} />
            </span>
            <span className="topbar-brand-text">
              <strong>Central File</strong>
              <small>{unitLabel}</small>
            </span>
          </Link>
          <div className="topbar-crumbs" aria-hidden="true">
            <span>Central File</span>
            <span>/</span>
            <strong>{pageLabel(location.pathname)}</strong>
          </div>
          <div className="topbar-actions">
            <UnitSwitcher compact />
            <span className="user-badge">
              <span className="user-badge-name">{profile.full_name}</span>
              <span className="user-badge-role">{ROLE_LABELS[profile.role]}</span>
            </span>
          </div>
        </header>
        <OfflineBanner />
        <main id="main" className="content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>

      <nav className="bottom-nav" aria-label="Navigasi utama">
        {primary.map((m) => (
          <NavLink key={m.id} to={m.path} className="bottom-nav-item">
            <span className="bottom-nav-icon" aria-hidden="true">{m.icon}</span>
            <span className="bottom-nav-label">{m.shortLabel}</span>
          </NavLink>
        ))}
        <button
          type="button"
          ref={moreButton}
          className={`bottom-nav-item${moreActive ? ' active' : ''}`}
          aria-haspopup="dialog"
          aria-expanded={sheetOpen}
          onClick={() => setSheetOpen(true)}
        >
          <span className="bottom-nav-icon" aria-hidden="true">☰</span>
          <span className="bottom-nav-label">Lainnya</span>
        </button>
      </nav>

      {sheetOpen ? <MoreSheet modules={more} onClose={closeSheet} /> : null}
    </div>
  );
}
