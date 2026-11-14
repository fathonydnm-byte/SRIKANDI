import { useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useAuth, useProfile } from '../../auth/AuthContext';
import { validateEmail } from '../../auth/validation';
import { assignableRoles, canManageUser, ROLE_LABELS, ROLES, type Role } from '../../auth/permissions';
import { Alert } from '../../components/Alert';
import { PageHeader } from '../../components/PageHeader';
import { Sheet } from '../../components/Sheet';
import { ApiError, newRequestId } from '../../lib/api';
import { toUserMessage, type UserMessage } from '../../lib/errors';
import { formatNumber } from '../../lib/format';
import { useLoad } from '../../lib/useLoad';
import { adminUsersRequest, fetchUsers, generateTempPassword, tempPasswordOk, type AdminUsersRequest, type UserRow } from '../../lib/usersApi';
import './usersPage.css';

function useGetToken() {
  const { client } = useAuth();
  return useMemo(() => async () => (await client.auth.getSession()).data.session?.access_token ?? null, [client]);
}

const tidy = (v: string) => v.replace(/\s+/g, ' ').trim();

function messageOf(error: unknown): UserMessage {
  return error instanceof ApiError ? error.userMessage : toUserMessage(error);
}

// ---------------------------------------------------------------------------
// Kata sandi sementara: tampil SEKALI
// ---------------------------------------------------------------------------
function TempPasswordResult({ heading, name, email, password, onClose }: { heading: string; name: string; email: string | null; password: string; onClose(): void }) {
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const box = useRef<HTMLOutputElement>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(password);
      setCopied('ok');
    } catch {
      // Clipboard API tidak tersedia/ditolak: pilih teksnya supaya bisa disalin manual.
      const el = box.current;
      if (el) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      }
      setCopied('fail');
    }
  }

  return (
    <div className="stack temp-result">
      <Alert tone="success">
        <strong>{heading}</strong>
      </Alert>
      <p className="temp-who">
        <strong>{name}</strong>
        {email ? <span className="muted"> · {email}</span> : null}
      </p>
      <div className="temp-box">
        <span className="temp-label" id="temp-label">Kata sandi sementara</span>
        <output ref={box} className="temp-password" aria-labelledby="temp-label" data-testid="temp-password">
          {password}
        </output>
        <button type="button" className="btn btn-primary" onClick={() => void copy()}>
          Salin kata sandi
        </button>
        <p className="sr-only" role="status" aria-live="polite">
          {copied === 'ok' ? 'Kata sandi tersalin.' : copied === 'fail' ? 'Tidak dapat menyalin otomatis. Pilih teks lalu salin manual.' : ''}
        </p>
        {copied === 'ok' ? <small className="field-hint" aria-hidden="true">Tersalin.</small> : null}
        {copied === 'fail' ? <small className="field-error">Tidak dapat menyalin otomatis. Teks sudah dipilih; salin secara manual.</small> : null}
      </div>
      <Alert tone="warning">
        <strong>Sampaikan kata sandi ini kepada pengguna secara langsung atau lewat pesan pribadi.</strong>{' '}
        <span>
          Jangan ditulis di grup, surel umum, atau catatan bersama. Kata sandi ini hanya tampil sekali dan tidak dapat dilihat lagi setelah jendela ini ditutup;
          bila hilang, gunakan &quot;Atur ulang kata sandi&quot;. Pengguna wajib menggantinya saat pertama kali masuk.
        </span>
      </Alert>
      <button type="button" className="btn btn-secondary btn-block" onClick={onClose}>
        Selesai, tutup
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Buat pengguna
// ---------------------------------------------------------------------------
function CreateUserSheet({ onClose, onChanged }: { onClose(): void; onChanged(): void }) {
  const { units } = useAuth();
  const { profile, unit: ownUnit } = useProfile();
  const getToken = useGetToken();
  const roles = assignableRoles(profile.role);
  const fixedUnit = profile.role !== 'ADMIN_PUSAT';
  const ids = { name: useId(), email: useId(), role: useId(), unit: useId() };

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>(roles.includes('PETUGAS') ? 'PETUGAS' : (roles[0] ?? 'PETUGAS'));
  const [unitId, setUnitId] = useState(fixedUnit ? (profile.unit_id ?? '') : '');
  const [errors, setErrors] = useState<{ name?: string; email?: string; unit?: string }>({});
  const [formError, setFormError] = useState<UserMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ name: string; email: string; password: string } | null>(null);

  // Satu requestId per isi formulir: klik ganda / kirim ulang setelah gangguan jaringan memakai id yang sama;
  // mengubah isian berarti permintaan baru.
  const attempt = useRef<{ key: string; requestId: string; password: string | null } | null>(null);
  const needsUnit = role !== 'ADMIN_PUSAT';
  const effectiveUnit = needsUnit ? unitId : '';

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const next: typeof errors = {};
    const name = tidy(fullName);
    if (!name) next.name = 'Nama lengkap wajib diisi.';
    const emailError = validateEmail(email);
    if (emailError) next.email = emailError;
    if (needsUnit && !effectiveUnit) next.unit = 'Pilih unit.';
    setErrors(next);
    setFormError(null);
    if (next.name || next.email || next.unit) return;

    const cleanEmail = email.trim().toLowerCase();
    const key = JSON.stringify([name, cleanEmail, role, effectiveUnit]);
    if (!attempt.current || attempt.current.key !== key) attempt.current = { key, requestId: newRequestId(), password: null };
    const a = attempt.current;
    if (!a.password || !tempPasswordOk(a.password, cleanEmail)) a.password = generateTempPassword(cleanEmail);
    const body: AdminUsersRequest = {
      action: 'create', requestId: a.requestId, email: cleanEmail, fullName: name, role,
      unitId: needsUnit ? effectiveUnit : null, tempPassword: a.password,
    };
    setBusy(true);
    try {
      await adminUsersRequest(getToken, body);
      setResult({ name, email: cleanEmail, password: a.password });
      attempt.current = null;
      onChanged();
    } catch (error) {
      setFormError(messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  const unitOptions = units.filter((u) => u.active);
  return (
    <Sheet title={result ? 'Akun berhasil dibuat' : 'Tambah pengguna'} onClose={onClose} variant="dialog">
      {result ? (
        <TempPasswordResult heading="Akun dibuat. Catat kata sandi sementaranya sekarang." name={result.name} email={result.email} password={result.password} onClose={onClose} />
      ) : (
        <form className="stack user-form" onSubmit={(e) => void submit(e)} noValidate>
          {formError ? <Alert tone="error" message={formError} /> : null}
          <div className={`field${errors.name ? ' field-invalid' : ''}`}>
            <label htmlFor={ids.name}>Nama lengkap</label>
            <div className="field-control">
              <input id={ids.name} value={fullName} maxLength={120} autoComplete="off" onChange={(e) => setFullName(e.target.value)} aria-invalid={errors.name ? true : undefined} />
            </div>
            {errors.name ? <small className="field-error">{errors.name}</small> : null}
          </div>
          <div className={`field${errors.email ? ' field-invalid' : ''}`}>
            <label htmlFor={ids.email}>Email</label>
            <div className="field-control">
              <input id={ids.email} type="email" inputMode="email" autoComplete="off" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={errors.email ? true : undefined} />
            </div>
            {errors.email ? <small className="field-error">{errors.email}</small> : null}
          </div>
          <div className="field">
            <label htmlFor={ids.role}>Peran</label>
            <select id={ids.role} value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
          {needsUnit ? (
            fixedUnit ? (
              <div className="field">
                <span className="field-static-label">Unit</span>
                <p className="field-static" data-testid="fixed-unit">{ownUnit ? `${ownUnit.code} · ${ownUnit.name}` : 'Unit Anda'}</p>
                <small className="field-hint">Akun baru otomatis masuk unit Anda.</small>
              </div>
            ) : (
              <div className={`field${errors.unit ? ' field-invalid' : ''}`}>
                <label htmlFor={ids.unit}>Unit</label>
                <select id={ids.unit} value={unitId} onChange={(e) => setUnitId(e.target.value)} aria-invalid={errors.unit ? true : undefined}>
                  <option value="">Pilih unit…</option>
                  {unitOptions.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.code} · {u.name}
                    </option>
                  ))}
                </select>
                {errors.unit ? <small className="field-error">{errors.unit}</small> : null}
              </div>
            )
          ) : (
            <p className="muted">Admin Pusat bekerja lintas unit, tanpa unit tetap.</p>
          )}
          <p className="muted">Kata sandi sementara dibuat otomatis dan ditampilkan sekali setelah akun dibuat. Pengguna wajib menggantinya saat pertama masuk.</p>
          <div className="filter-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Batal
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Membuat akun…' : 'Buat akun'}
            </button>
          </div>
        </form>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Ubah pengguna
// ---------------------------------------------------------------------------
function EditUserSheet({ user, self, onClose, onChanged }: { user: UserRow; self: boolean; onClose(): void; onChanged(): void }) {
  const { units } = useAuth();
  const { profile } = useProfile();
  const getToken = useGetToken();
  const roles = assignableRoles(profile.role);
  const isPusat = profile.role === 'ADMIN_PUSAT';
  const ids = { name: useId(), role: useId(), unit: useId(), active: useId() };

  const [fullName, setFullName] = useState(user.full_name);
  const [role, setRole] = useState<Role>(user.role);
  const [unitId, setUnitId] = useState(user.unit_id ?? '');
  const [active, setActive] = useState(user.active);
  const [error, setError] = useState<UserMessage | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const attempt = useRef<{ key: string; requestId: string } | null>(null);

  const needsUnit = role !== 'ADMIN_PUSAT';
  const lockedAccess = self; // peran, unit, dan status akun sendiri tidak dapat diubah

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const name = tidy(fullName);
    if (!name) {
      setNameError('Nama lengkap wajib diisi.');
      return;
    }
    setNameError(null);
    const changes: { fullName?: string; role?: Role; unitId?: string | null; active?: boolean } = {};
    if (name !== user.full_name) changes.fullName = name;
    if (!lockedAccess) {
      if (role !== user.role) changes.role = role;
      if (needsUnit && unitId !== (user.unit_id ?? '')) changes.unitId = unitId;
      if (needsUnit && user.role === 'ADMIN_PUSAT' && !unitId) {
        setError({ title: 'Unit wajib dipilih.', action: 'Pilih unit untuk peran ini.' });
        return;
      }
      if (active !== user.active) changes.active = active;
    }
    if (Object.keys(changes).length === 0) {
      setError({ title: 'Belum ada yang diubah.', action: 'Ubah minimal satu isian lalu simpan.' });
      return;
    }
    const key = JSON.stringify(changes);
    if (!attempt.current || attempt.current.key !== key) attempt.current = { key, requestId: newRequestId() };
    const body: AdminUsersRequest = { action: 'update', requestId: attempt.current.requestId, userId: user.user_id, ...changes };
    setBusy(true);
    try {
      await adminUsersRequest(getToken, body);
      setDone(true);
      onChanged();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  const unitOptions = units.filter((u) => u.active || u.id === user.unit_id);
  return (
    <Sheet title="Ubah pengguna" onClose={onClose} variant="dialog">
      {done ? (
        <div className="stack">
          <Alert tone="success">
            <strong>Perubahan tersimpan.</strong>
            {!active && user.active ? ' Pengguna ini tidak dapat masuk lagi.' : ''}
          </Alert>
          <button type="button" className="btn btn-primary btn-block" onClick={onClose}>
            Tutup
          </button>
        </div>
      ) : (
        <form className="stack user-form" onSubmit={(e) => void submit(e)} noValidate>
          {error ? <Alert tone="error" message={error} /> : null}
          <p className="muted user-form-email">{user.email ?? 'Email tidak tercatat'}</p>
          <div className={`field${nameError ? ' field-invalid' : ''}`}>
            <label htmlFor={ids.name}>Nama lengkap</label>
            <div className="field-control">
              <input id={ids.name} value={fullName} maxLength={120} autoComplete="off" onChange={(e) => setFullName(e.target.value)} aria-invalid={nameError ? true : undefined} />
            </div>
            {nameError ? <small className="field-error">{nameError}</small> : null}
          </div>
          <div className="field">
            <label htmlFor={ids.role}>Peran</label>
            <select id={ids.role} value={role} disabled={lockedAccess} onChange={(e) => setRole(e.target.value as Role)}>
              {(roles.includes(user.role) ? roles : ROLES.filter((r) => r === user.role || roles.includes(r))).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
          {needsUnit ? (
            <div className="field">
              <label htmlFor={ids.unit}>Unit</label>
              <select id={ids.unit} value={unitId} disabled={lockedAccess || !isPusat} onChange={(e) => setUnitId(e.target.value)}>
                {!unitId ? <option value="">Pilih unit…</option> : null}
                {unitOptions.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.code} · {u.name}
                  </option>
                ))}
              </select>
              {!isPusat ? <small className="field-hint">Pengguna tidak dapat dipindah ke unit lain oleh Admin Unit.</small> : null}
            </div>
          ) : null}
          <label className="check-row" htmlFor={ids.active}>
            <input id={ids.active} type="checkbox" checked={active} disabled={lockedAccess} onChange={(e) => setActive(e.target.checked)} />
            <span>Akun aktif</span>
          </label>
          {!active && user.active ? <Alert tone="warning"><span>Pengguna tidak akan dapat masuk sampai akun diaktifkan kembali. Data dan riwayatnya tetap tersimpan.</span></Alert> : null}
          {lockedAccess ? <p className="muted">Anda tidak dapat mengubah peran, unit, atau status akun Anda sendiri.</p> : null}
          <div className="filter-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Batal
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? 'Menyimpan…' : 'Simpan perubahan'}
            </button>
          </div>
        </form>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Atur ulang kata sandi sementara
// ---------------------------------------------------------------------------
function ResetPasswordSheet({ user, onClose, onChanged }: { user: UserRow; onClose(): void; onChanged(): void }) {
  const getToken = useGetToken();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UserMessage | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const attempt = useRef<{ requestId: string; password: string } | null>(null);

  async function run() {
    if (busy) return;
    setError(null);
    if (!attempt.current) attempt.current = { requestId: newRequestId(), password: generateTempPassword(user.email) };
    setBusy(true);
    try {
      await adminUsersRequest(getToken, { action: 'reset-password', requestId: attempt.current.requestId, userId: user.user_id, tempPassword: attempt.current.password });
      setResult(attempt.current.password);
      attempt.current = null;
      onChanged();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'WEAK_PASSWORD') attempt.current = null;
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title={result ? 'Kata sandi sementara baru' : 'Atur ulang kata sandi'} onClose={onClose} variant="dialog">
      {result ? (
        <TempPasswordResult heading="Kata sandi diatur ulang. Catat kata sandi sementaranya sekarang." name={user.full_name} email={user.email} password={result} onClose={onClose} />
      ) : (
        <div className="stack">
          {error ? <Alert tone="error" message={error} /> : null}
          <p>
            Buat kata sandi sementara baru untuk <strong>{user.full_name}</strong>? Kata sandi lama langsung tidak berlaku, dan pengguna wajib menggantinya saat masuk berikutnya.
          </p>
          <div className="filter-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Batal
            </button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run()}>
              {busy ? 'Memproses…' : 'Buat kata sandi sementara'}
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Halaman
// ---------------------------------------------------------------------------
type StatusFilter = '' | 'aktif' | 'nonaktif';
type Dialog = { kind: 'create' } | { kind: 'edit'; user: UserRow } | { kind: 'reset'; user: UserRow } | null;

export function UsersPage() {
  const { client, units, state } = useAuth();
  const { profile } = useProfile();
  const isPusat = profile.role === 'ADMIN_PUSAT';
  const [list, reload] = useLoad<UserRow[]>('users', () => fetchUsers(client));
  const [q, setQ] = useState('');
  const [roleFilter, setRoleFilter] = useState<'' | Role>('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('');
  const [unitFilter, setUnitFilter] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const opener = useRef<HTMLElement | null>(null);
  const ids = { q: useId(), role: useId(), status: useId(), unit: useId() };
  const myId = state.status === 'signedIn' ? state.session.user.id : null;

  const rows = useMemo(() => (list.kind === 'ok' ? list.data : []), [list]);
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return rows.filter(
      (u) =>
        (!term || u.full_name.toLowerCase().includes(term) || (u.email ?? '').toLowerCase().includes(term)) &&
        (!roleFilter || u.role === roleFilter) &&
        (!statusFilter || (statusFilter === 'aktif') === u.active) &&
        (!unitFilter || u.unit_id === unitFilter),
    );
  }, [rows, q, roleFilter, statusFilter, unitFilter]);
  const filterCount = [q.trim(), roleFilter, statusFilter, unitFilter].filter(Boolean).length;

  function open(d: NonNullable<Dialog>, trigger: HTMLElement | null) {
    opener.current = trigger;
    setDialog(d);
  }
  function close() {
    setDialog(null);
    opener.current?.focus();
  }

  let body;
  if (list.kind === 'loading') {
    body = (
      <ul className="result-list" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <li key={i} className="result-card skeleton">
            <span className="sk sk-line short" />
            <span className="sk sk-line" />
          </li>
        ))}
      </ul>
    );
  } else if (list.kind === 'error') {
    body = (
      <div className="stack">
        <Alert tone="error" message={list.message} />
        <button type="button" className="btn btn-secondary" onClick={reload}>
          Coba lagi
        </button>
      </div>
    );
  } else if (filtered.length === 0) {
    body = (
      <div className="empty-state card">
        <h2 className="section-title">{rows.length === 0 ? 'Belum ada pengguna' : 'Tidak ada pengguna yang cocok'}</h2>
        <p className="muted">{rows.length === 0 ? 'Tambahkan pengguna pertama dengan tombol "Tambah pengguna".' : 'Coba ubah atau bersihkan filter.'}</p>
      </div>
    );
  } else {
    body = (
      <ul className="user-list">
        {filtered.map((u) => {
          const self = u.user_id === myId;
          const manageable = canManageUser({ role: profile.role, unitId: profile.unit_id }, { role: u.role, unitId: u.unit_id });
          return (
            <li key={u.user_id} className={`user-card${u.active ? '' : ' is-inactive'}`}>
              <div className="user-main">
                <strong className="user-name">
                  {u.full_name}
                  {self ? <span className="badge-pill badge-info user-self">Anda</span> : null}
                </strong>
                <span className="user-email">{u.email ?? 'Email tidak tercatat'}</span>
              </div>
              <div className="user-badges">
                <span className="badge-pill badge-info">{ROLE_LABELS[u.role]}</span>
                <span className="user-unit">{u.unit_code ?? 'Lintas unit'}</span>
                <span className={`badge-pill ${u.active ? 'badge-ok' : 'badge-danger'}`}>{u.active ? 'Aktif' : 'Nonaktif'}</span>
                {u.must_change_password ? <span className="badge-pill badge-warn">Belum ganti kata sandi</span> : null}
              </div>
              {manageable ? (
                <div className="user-actions">
                  <button type="button" className="btn btn-secondary btn-sm" aria-label={`Ubah ${u.full_name}`} onClick={(e) => open({ kind: 'edit', user: u }, e.currentTarget)}>
                    Ubah
                  </button>
                  {!self ? (
                    <button type="button" className="btn btn-secondary btn-sm" aria-label={`Atur ulang kata sandi ${u.full_name}`} onClick={(e) => open({ kind: 'reset', user: u }, e.currentTarget)}>
                      Atur ulang sandi
                    </button>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <>
      <PageHeader title="Kelola Pengguna" subtitle={isPusat ? 'Akun semua unit. Admin Pusat dapat membuat peran apa pun.' : 'Akun Petugas Arsip dan Pimpinan di unit Anda.'}>
        <button type="button" className="btn btn-primary" onClick={(e) => open({ kind: 'create' }, e.currentTarget)}>
          + Tambah pengguna
        </button>
      </PageHeader>
      <form className="user-filters" role="search" onSubmit={(e) => e.preventDefault()}>
        <div className="field user-filter-q">
          <label htmlFor={ids.q}>Cari nama atau email</label>
          <div className="field-control">
            <input id={ids.q} type="search" value={q} autoComplete="off" maxLength={100} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>
        {isPusat ? (
          <div className="field">
            <label htmlFor={ids.unit}>Unit</label>
            <select id={ids.unit} value={unitFilter} onChange={(e) => setUnitFilter(e.target.value)}>
              <option value="">Semua unit</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.code}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="field">
          <label htmlFor={ids.role}>Peran</label>
          <select id={ids.role} value={roleFilter} onChange={(e) => setRoleFilter(e.target.value as '' | Role)}>
            <option value="">Semua peran</option>
            {(isPusat ? ROLES : assignableRoles(profile.role)).map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={ids.status}>Status</label>
          <select id={ids.status} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}>
            <option value="">Semua status</option>
            <option value="aktif">Aktif</option>
            <option value="nonaktif">Nonaktif</option>
          </select>
        </div>
      </form>
      <p className="result-summary" role="status" aria-live="polite">
        {list.kind === 'ok' ? `${formatNumber(filtered.length)}${filterCount ? ` dari ${formatNumber(rows.length)}` : ''} pengguna` : 'Memuat pengguna…'}
      </p>
      <div className="search-results" aria-busy={list.kind === 'loading' ? true : undefined}>
        {body}
      </div>
      {dialog?.kind === 'create' ? <CreateUserSheet onClose={close} onChanged={reload} /> : null}
      {dialog?.kind === 'edit' ? (
        <EditUserSheet
          user={dialog.user}
          self={dialog.user.user_id === myId}
          onClose={close}
          onChanged={reload}
        />
      ) : null}
      {dialog?.kind === 'reset' ? <ResetPasswordSheet user={dialog.user} onClose={close} onChanged={reload} /> : null}
    </>
  );
}
