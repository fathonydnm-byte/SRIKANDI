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
