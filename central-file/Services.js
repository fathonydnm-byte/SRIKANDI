function getCurrentUser_() {
  return Session.getActiveUser().getEmail() ||
    Session.getEffectiveUser().getEmail() ||
    'PENGGUNA_TIDAK_TERIDENTIFIKASI';
}

function nowIso_() {
  return Utilities.formatDate(new Date(), APP_CONFIG.TIME_ZONE, "yyyy-MM-dd'T'HH:mm:ssXXX");
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

function positiveInteger_(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(label + ' harus berupa bilangan bulat nol atau lebih.');
  return number;
}

function getClassificationData_() {
  const rows = readObjects_(APP_CONFIG.SHEETS.KLASIFIKASI)
    .filter(row => row.AKTIF === true || String(row.AKTIF).toUpperCase() === 'TRUE')
    .sort((a, b) => Number(a.URUTAN) - Number(b.URUTAN));
  const byParent = {};
  rows.forEach(row => {
    const parent = row.PARENT_ID || 'ROOT';
    if (!byParent[parent]) byParent[parent] = [];
    byParent[parent].push({
      id: row.KLASIFIKASI_ID,
      parentId: row.PARENT_ID || '',
      level: row.LEVEL,
      code: row.KODE_LENGKAP,
      description: row.URAIAN,
      label: row.LABEL_DROPDOWN
    });
  });
  return {rows, byParent};
}

function validateClassification_(classificationId) {
  const data = getClassificationData_();
  const selected = data.rows.find(row => row.KLASIFIKASI_ID === classificationId);
  if (!selected) throw new Error('Kode klasifikasi tidak aktif atau tidak ditemukan.');
  if ((data.byParent[classificationId] || []).length > 0) {
    throw new Error('Pilih kode klasifikasi sampai tingkat paling akhir yang tersedia.');
  }
  return selected;
}

function audit_(action, moduleName, objectType, objectId, summary, reason, status) {
  appendObject_(APP_CONFIG.SHEETS.AUDIT, {
    LOG_ID: 'LOG-' + Utilities.getUuid(),
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

function isCentralFileAdmin_() {
  const settings = readSettings_();
  const adminEmail = cleanText_(settings.UNIT_ADMIN_EMAIL, 250).toLowerCase();
  if (!adminEmail) return false;
  return getCurrentUser_().toLowerCase() === adminEmail;
}

function getMasterLog_(limit) {
  if (!isCentralFileAdmin_()) {
    return {
      ok: true,
      authorized: false,
      message: 'Hanya administrator unit (' + (readSettings_().UNIT_ADMIN_EMAIL || 'belum diatur') + ') yang dapat membuka Master Log Perubahan.'
    };
  }
  const cappedLimit = Math.min(Math.max(Number(limit) || 200, 1), 500);
  const rows = readObjects_(APP_CONFIG.SHEETS.AUDIT)
    .sort((a, b) => String(b.TIMESTAMP || '').localeCompare(String(a.TIMESTAMP || '')))
    .slice(0, cappedLimit)
    .map(row => ({
      timestamp: formatAuditTimestamp_(row.TIMESTAMP),
      userEmail: cleanText_(row.USER_EMAIL, 250),
      aksi: cleanText_(row.AKSI, 50),
      modul: cleanText_(row.MODUL, 100),
      jenisObjek: cleanText_(row.JENIS_OBJEK, 100),
      objekId: cleanText_(row.OBJEK_ID, 100),
      ringkasan: cleanText_(row.RINGKASAN, 500),
      alasan: cleanText_(row.ALASAN, 2000),
      status: cleanText_(row.STATUS, 30) === 'FAILED' ? 'GAGAL' : 'BERHASIL'
    }));
  return {ok: true, authorized: true, rows, generatedAt: nowIso_()};
}

function formatAuditTimestamp_(value) {
  const text = String(value || '').trim();
  if (!text) return '–';
  const parsed = new Date(text);
  if (isNaN(parsed.getTime())) return text;
  return Utilities.formatDate(parsed, APP_CONFIG.TIME_ZONE, 'dd/MM/yyyy HH:mm');
}

function getDashboardSummary_() {
  const berkas = readObjects_(APP_CONFIG.SHEETS.BERKAS)
    .filter(row => !isDeleted_(row) && String(row.STATUS_PEMINDAHAN || '').toUpperCase() !== 'SUDAH DIPINDAHKAN');
  const activeBerkasIds = {};
  berkas.forEach(row => activeBerkasIds[row.BERKAS_ID] = true);
  const items = readObjects_(APP_CONFIG.SHEETS.ITEM)
    .filter(row => !isDeleted_(row) && activeBerkasIds[row.BERKAS_ID]);
  const loans = readObjects_(APP_CONFIG.SHEETS.PEMINJAMAN);
  const todayKey = Utilities.formatDate(new Date(), APP_CONFIG.TIME_ZONE, 'yyyy-MM-dd');
  let expired = 0;
  let dueSoon = 0;
  berkas.forEach(row => {
    if (!row.BATAS_AKTIF) return;
    const days = retentionDayDifference_(todayKey, dateKey_(row.BATAS_AKTIF));
    if (days < 0) expired++;
    else if (days <= 7) dueSoon++;
  });
  return {
    totalBerkas: berkas.length,
    totalItems: items.length,
    activeLoans: Array.from(new Set(loans
      .filter(row => row.STATUS === 'DIPINJAM')
      .map(row => typeof loanGroupId_ === 'function'
        ? loanGroupId_(row) : String(row.PEMINJAMAN_ID || ''))
      .filter(Boolean))).length,
    expiredRetention: expired,
    retentionDueSoon: dueSoon
  };
}

function createBerkas_(payload) {
  payload = payload || {};
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const normalized = normalizeNewBerkasPayload_(payload, 'BRK-' + Utilities.getUuid(), nowIso_());
    const settings = readSettings_();
    const archiveFolderId = requireValue_(settings.ARCHIVE_FOLDER_ID, 'ARCHIVE_FOLDER_ID pada SETTINGS');
    const berkasId = normalized.berkasId;
    const timestamp = normalized.createdAt;
    const user = getCurrentUser_();
    const folderName = 'DRAFT_' + berkasId.slice(4, 12) + '_' + cleanFileName_(normalized.title);
    const folder = DriveApp.getFolderById(archiveFolderId).createFolder(folderName);

    const record = {
      BERKAS_ID: berkasId,
      JUDUL_BERKAS: normalized.title,
      KATEGORI_NASKAH_ID: '',
      POLA_PEMBERKASAN: '',
      KLASIFIKASI_ID: normalized.classificationId,
      KODE_KLASIFIKASI_SNAPSHOT: normalized.classificationCode,
      URAIAN_KLASIFIKASI_SNAPSHOT: normalized.classificationDescription,
      RETENSI_AKTIF_NILAI: normalized.activeRetentionValue,
      RETENSI_AKTIF_SATUAN: normalized.activeRetentionUnit,
      RETENSI_INAKTIF_NILAI: normalized.inactiveRetentionValue,
      RETENSI_INAKTIF_SATUAN: normalized.inactiveRetentionUnit,
      NASIB_AKHIR: normalized.finalDisposition,
      STATUS_RETENSI: APP_CONFIG.STATUS.RETENSI_MENUNGGU_ITEM,
      NO_FILLING_KABINET: normalized.filingCabinet,
      NO_LACI: normalized.drawer,
      DRIVE_FOLDER_ID: folder.getId(),
      DRIVE_FOLDER_URL: folder.getUrl(),
      STATUS_PEMINJAMAN: APP_CONFIG.STATUS.PEMINJAMAN_TERSEDIA,
      STATUS_BERKAS: APP_CONFIG.STATUS.BERKAS_DRAFT,
      CATATAN: normalized.notes,
      CREATED_AT: timestamp,
      CREATED_BY: user,
      UPDATED_AT: timestamp,
      UPDATED_BY: user,
      VERSION: 1,
      IS_DELETED: false
    };
    appendObject_(APP_CONFIG.SHEETS.BERKAS, record);
    audit_('CREATE', 'BERKAS', 'BERKAS', berkasId, 'Membuat draft berkas: ' + normalized.title, '', 'SUCCESS');
    return {ok: true, berkasId, folderUrl: folder.getUrl(), message: 'Draft berkas berhasil dibuat.'};
  } catch (error) {
    audit_('CREATE', 'BERKAS', 'BERKAS', '', 'Gagal membuat draft berkas', error.message, 'FAILED');
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function normalizeNewBerkasPayload_(payload, berkasId, createdAt) {
  payload = payload || {};
  const title = cleanText_(requireValue_(payload.title, 'Judul berkas'), 500);
  const classification = validateClassification_(requireValue_(payload.classificationId, 'Kode klasifikasi'));
  const activeValue = positiveInteger_(requireValue_(payload.activeRetentionValue, 'Retensi aktif'), 'Retensi aktif');
  const inactiveValue = positiveInteger_(requireValue_(payload.inactiveRetentionValue, 'Retensi inaktif'), 'Retensi inaktif');
  const activeUnit = String(requireValue_(payload.activeRetentionUnit, 'Satuan retensi aktif')).toUpperCase();
  const inactiveUnit = String(requireValue_(payload.inactiveRetentionUnit, 'Satuan retensi inaktif')).toUpperCase();
  const finalDisposition = String(requireValue_(payload.finalDisposition, 'Nasib akhir')).toUpperCase();
  if (!APP_CONFIG.RETENTION_UNITS.includes(activeUnit) || !APP_CONFIG.RETENTION_UNITS.includes(inactiveUnit)) throw new Error('Satuan retensi harus TAHUN atau BULAN.');
  if (!APP_CONFIG.FINAL_DISPOSITIONS.includes(finalDisposition)) throw new Error('Nasib akhir tidak valid.');
  return {
    berkasId, createdAt, title,
    classificationId: classification.KLASIFIKASI_ID,
    classificationCode: classification.KODE_LENGKAP,
    classificationDescription: classification.URAIAN,
    activeRetentionValue: activeValue,
    activeRetentionUnit: activeUnit,
    inactiveRetentionValue: inactiveValue,
    inactiveRetentionUnit: inactiveUnit,
    finalDisposition,
    filingCabinet: cleanText_(payload.filingCabinet, 50),
    drawer: cleanText_(payload.drawer, 50),
    notes: cleanText_(payload.berkasNotes || payload.notes, 1000)
  };
}
