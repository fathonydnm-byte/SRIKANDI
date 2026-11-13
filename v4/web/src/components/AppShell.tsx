import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth, useProfile } from '../auth/AuthContext';
import { findModuleByPath, mobileNav, NAV_GROUP_ORDER, ROLE_LABELS, SUBMENUS, visibleModules, type ModuleDef, type SubmenuId } from '../auth/permissions';
import { SHORTCUTS } from '../pages/dashboard/shortcuts';
import { BrandMark } from './BrandMark';
import { Sheet } from './Sheet';
import { OfflineBanner } from './OfflineBanner';
import { UnitSwitcher, useActiveUnitLabel } from './UnitSwitcher';

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? (parts[0]![0] ?? '') + (parts[parts.length - 1]![0] ?? '') : (parts[0] ?? '–').slice(0, 2);
  return letters.toUpperCase();
}

function pageLabel(pathname: string): string {
  if (pathname === '/akun/kata-sandi') return 'Ubah kata sandi';
  if (pathname.startsWith('/cari/item/')) return 'Detail arsip';
  if (pathname.startsWith('/cari/berkas/')) return 'Daftar Isi Berkas';
  const shortcut = SHORTCUTS.find((x) => pathname === `/dashboard/${x.slug}`);
  if (shortcut) return shortcut.title;
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

function NavItem({ m, sub = false }: { m: ModuleDef; sub?: boolean }) {
  return (
    <NavLink to={m.path} className={`nav-button${sub ? ' nav-sub' : ''}`}>
      {sub ? null : <span className="nav-icon" aria-hidden="true">{m.icon}</span>}
      <span className="nav-label">{m.label}</span>
    </NavLink>
  );
}

/** Sub-menu lipat seperti "Kelola Informasi Arsip" di 3.x; terbuka bila salah satu isinya aktif. */
function Submenu({ id, items }: { id: SubmenuId; items: ModuleDef[] }) {
  const location = useLocation();
  const containsActive = items.some((m) => location.pathname === m.path || location.pathname.startsWith(`${m.path}/`));
  const [open, setOpen] = useState(containsActive);
  const [seenActive, setSeenActive] = useState(containsActive);
  if (containsActive !== seenActive) {
    setSeenActive(containsActive);
    if (containsActive) setOpen(true);
  }
  const menuId = useId();
  const def = SUBMENUS[id];
  return (
    <div className="nav-dropdown">
      <button
        type="button"
        className={`nav-button nav-dropdown-toggle${containsActive ? ' contains-active' : ''}`}
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="nav-icon" aria-hidden="true">{def.icon}</span>
        <span className="nav-label">{def.label}</span>
        <span className="nav-caret" aria-hidden="true">▾</span>
      </button>
      <div id={menuId} className="nav-dropdown-menu" hidden={!open}>
        {items.map((m) => (
          <NavItem key={m.id} m={m} sub />
        ))}
      </div>
    </div>
  );
}

/** Pencarian cepat di top bar (3.x: "Cari cepat …", Ctrl+K) → Pencarian Arsip. */
function QuickSearch() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        const el = ref.current;
        if (el && el.offsetParent !== null) el.focus();
        else navigate('/cari');
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);
  function submit(e: FormEvent) {
    e.preventDefault();
    const term = q.trim();
    setQ('');
    ref.current?.blur();
    navigate(term ? `/cari?q=${encodeURIComponent(term)}` : '/cari');
  }
  return (
    <form className="topbar-search" role="search" onSubmit={submit}>
      <span aria-hidden="true">🔍</span>
      <label htmlFor="topbar-q" className="sr-only">
        Cari cepat
      </label>
      <input
        id="topbar-q"
        ref={ref}
        type="search"
        enterKeyHint="search"
        autoComplete="off"
        placeholder="Cari cepat nomor berkas, uraian, peminjam…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <kbd className="kbd" aria-hidden="true">Ctrl+K</kbd>
    </form>
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
              {items.map((m, i) => {
                if (!m.submenu) return <NavItem key={m.id} m={m} />;
                // Satu disclosure per sub-menu, dirender pada anggota pertamanya.
                if (items.findIndex((x) => x.submenu === m.submenu) !== i) return null;
                return <Submenu key={m.submenu} id={m.submenu} items={items.filter((x) => x.submenu === m.submenu)} />;
              })}
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
  return (
    <Sheet title="Lainnya" onClose={onClose} variant="more">
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
    </Sheet>
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
          <QuickSearch />
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
