function getCurrentUser_() {
  return Session.getActiveUser().getEmail() ||
    Session.getEffectiveUser().getEmail() ||
    'PENGGUNA_TIDAK_TERIDENTIFIKASI';
}

function nowIso_() {
  return Utilities.formatDate(new Date(), RC_CONFIG.TIME_ZONE, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

function cleanText_(value, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return maxLength ? text.substring(0, maxLength) : text;
}

function cleanFileName_(value) {
  return cleanText_(value, 120)
    .replace(/[\\/:*?"<>|#%{}~]/g, '-')
    .replace(/[. ]+$/g, '') || 'Tanpa Judul';
}

function requireValue_(value, label) {
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error(label + ' wajib diisi.');
  }
  return value;
}

function normalizeEmail_(value) {
  const email = cleanText_(value, 250).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Format email tidak valid: ' + value);
  }
  return email;
}

function rcBoolean_(value) {
  return value === true || String(value).toUpperCase() === 'TRUE' || String(value) === '1';
}

function audit_(action, moduleName, objectType, objectId, summary, reason, status) {
  appendObject_(RC_CONFIG.SHEETS.AUDIT, {
    LOG_ID: 'RCLOG-' + Utilities.getUuid(),
    TIMESTAMP: nowIso_(),
    USER_EMAIL: getCurrentUser_(),
    AKSI: action,
    MODUL: moduleName,
    JENIS_OBJEK: objectType,
    OBJEK_ID: objectId,
    RINGKASAN: summary,
    ALASAN: reason || '',
    REQUEST_ID: 'REQ-' + Utilities.getUuid(),
    STATUS: status || 'SUCCESS'
  });
}

// Guardrail §13.4/§13.6: dashboard operator hanya boleh diakses administrator
// instance, dan pemeriksaannya tidak boleh hanya mengandalkan setting akses
// deployment (§22.3: Session.getActiveUser() dapat kosong pada deployment
// tertentu) — karena itu fungsi ini dipakai di server, bukan hanya UI.
function isRecordCenterAdmin_(email) {
  const settings = readSettings_();
  const configured = cleanText_(settings.RC_ADMIN_EMAIL, 250).toLowerCase();
  const candidate = cleanText_(email || getCurrentUser_(), 250).toLowerCase();
  if (!configured) return false;
  if (candidate === configured) return true;
  const extra = cleanText_(settings.RC_ADDITIONAL_ADMIN_EMAILS, 1000)
    .split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  return extra.indexOf(candidate) !== -1;
}

function requireRecordCenterAdmin_() {
  const user = getCurrentUser_();
  if (!isRecordCenterAdmin_(user)) {
    throw new Error(
      'Akses ditolak. Dashboard Record Center hanya untuk administrator instance (' + user + ').'
    );
  }
  return user;
}

// --- Kriptografi protokol federasi (§12.3) ---------------------------------
// Skema identik dengan transferSubmissionSha256_/transferSubmissionSignature_
// pada central-file/TransferSubmissionService.js — HARUS tetap sama persis
// di kedua sisi supaya signature yang dihitung CF bisa diverifikasi RC.

function rcSha256_(text) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, String(text), Utilities.Charset.UTF_8);
  return bytes.map(byte => ('0' + ((byte + 256) % 256).toString(16)).slice(-2)).join('');
}

function rcHmacSignature_(eventId, hash, timestamp, secret) {
  const bytes = Utilities.computeHmacSha256Signature(
    String(eventId) + '|' + String(hash) + '|' + String(timestamp),
    String(secret), Utilities.Charset.UTF_8);
  return bytes.map(byte => ('0' + ((byte + 256) % 256).toString(16)).slice(-2)).join('');
}

// Perbandingan constant-time (§12.3) — panjang tetap diperiksa dulu (bocoran
// panjang dianggap dapat diterima, itu bukan bagian rahasia), lalu XOR semua
// byte tanpa short-circuit supaya waktu eksekusi tidak bocorkan posisi
// karakter yang salah.
function rcConstantTimeEquals_(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
