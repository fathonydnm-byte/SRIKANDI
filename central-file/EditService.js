function getEditOptions_() {
  const berkas = readObjects_(APP_CONFIG.SHEETS.BERKAS)
    .filter(row => !isDeleted_(row))
    .sort((a, b) => naturalCompare_(a.NO_BERKAS_DEFINITIF || '999999', b.NO_BERKAS_DEFINITIF || '999999'));
  const items = readObjects_(APP_CONFIG.SHEETS.ITEM)
    .filter(row => !isDeleted_(row))
    .sort((a, b) => {
      const parentCompare = naturalCompare_(a.NO_BERKAS_SNAPSHOT || '999999', b.NO_BERKAS_SNAPSHOT || '999999');
      return parentCompare || naturalCompare_(a.NO_ITEM_DEFINITIF || '999999', b.NO_ITEM_DEFINITIF || '999999');
    });
  const itemsByBerkas = {};
  items.forEach(row => {
    if (!itemsByBerkas[row.BERKAS_ID]) itemsByBerkas[row.BERKAS_ID] = [];
    itemsByBerkas[row.BERKAS_ID].push({
      id: row.ITEM_ID,
      number: row.NO_ITEM_DEFINITIF || '',
      description: row.URAIAN_LENGKAP || '',
      documentDate: row.TANGGAL_NASKAH ? dateKey_(row.TANGGAL_NASKAH) : '',
      pageCount: Number(row.JUMLAH_HALAMAN || 0),
      developmentLevel: row.TINGKAT_PERKEMBANGAN || 'ASLI',
      condition: row.KONDISI_FISIK || '',
      securityClassification: centralFileMetadataNormalizeSecurity_(
        row.KLASIFIKASI_KEAMANAN_AKSES),
      fileName: row.NAMA_FILE || '',
      fileUrl: row.DRIVE_FILE_URL || '',
      loanStatus: row.STATUS_PEMINJAMAN || 'TERSEDIA',
      label: (row.NO_ITEM_DEFINITIF || '–') + ' – ' + cleanText_(row.URAIAN_LENGKAP || 'Tanpa uraian', 140)
    });
  });
  return {
    berkas: berkas.map(row => ({
      id: row.BERKAS_ID,
      number: row.NO_BERKAS_DEFINITIF || '',
      title: row.JUDUL_BERKAS || '',
      loanStatus: row.STATUS_PEMINJAMAN || 'TERSEDIA',
      label: (row.NO_BERKAS_DEFINITIF || 'DRAFT') + ' – ' + row.JUDUL_BERKAS
    })),
    itemsByBerkas: itemsByBerkas
  };
}

function updateArchiveItem_(form, preUploadedReplacementId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let replacementFile = null;
  let itemUpdated = false;
  let original = null;
  try {
    form = form || {};
    const berkasId = cleanText_(requireValue_(form.editBerkasId, 'Berkas induk'), 80);
    const itemId = cleanText_(requireValue_(form.editItemId, 'Item arsip'), 80);
    const reason = cleanText_(requireValue_(form.editReason, 'Alasan perubahan'), 2000);
    if (reason.length < 10) throw new Error('Alasan perubahan minimal 10 karakter agar jejak audit cukup jelas.');

    const parent = readObjects_(APP_CONFIG.SHEETS.BERKAS).find(row => row.BERKAS_ID === berkasId && !isDeleted_(row));
    if (!parent) throw new Error('Berkas induk tidak ditemukan atau sudah dihapus.');
    const item = readObjects_(APP_CONFIG.SHEETS.ITEM).find(row => row.ITEM_ID === itemId && row.BERKAS_ID === berkasId && !isDeleted_(row));
    if (!item) throw new Error('Item arsip tidak ditemukan atau sudah dihapus.');
    assertItemAvailableForEdit_(parent, item);

    const description = cleanText_(requireValue_(form.editDescription, 'Uraian informasi arsip'), 2000);
    const pageCount = positiveInteger_(requireValue_(form.editPageCount, 'Jumlah halaman'), 'Jumlah halaman');
    if (pageCount < 1) throw new Error('Jumlah halaman minimal 1.');
    const documentDate = dateKey_(parseLocalDate_(requireValue_(form.editDocumentDate, 'Tanggal naskah'), 'Tanggal naskah'));
    const development = String(requireValue_(form.editDevelopmentLevel, 'Tingkat perkembangan')).toUpperCase();
    if (['ASLI', 'COPY'].indexOf(development) === -1) throw new Error('Tingkat perkembangan harus ASLI atau COPY.');
    const condition = String(form.editCondition || '').trim().toUpperCase();
    if (condition && ['BAIK', 'RUSAK RINGAN', 'RUSAK SEDANG', 'RUSAK BERAT'].indexOf(condition) === -1) {
      throw new Error('Kondisi fisik tidak valid.');
    }
    const securityClassification = validateArchiveSecurityClassification_(
      form.editSecurityClassification,
      'Klasifikasi keamanan dan akses arsip');

    const replacementBlob = preUploadedReplacementId ? null : form.replacementPdf;
    const replacementSize = preUploadedReplacementId
      ? Number(DriveApp.getFileById(preUploadedReplacementId).getSize())
      : (replacementBlob && typeof replacementBlob.getBytes === 'function' ? replacementBlob.getBytes().length : 0);
    const hasReplacement = Boolean(preUploadedReplacementId) || replacementSize > 0;
    if (preUploadedReplacementId) {
      replacementFile = DriveApp.getFileById(preUploadedReplacementId);
      validateReplacementDriveFile_(replacementFile, replacementSize);
    } else if (hasReplacement) {
      validateReplacementPdf_(replacementBlob, replacementSize);
    }
    const changed = description !== cleanText_(item.URAIAN_LENGKAP, 2000) ||
      pageCount !== Number(item.JUMLAH_HALAMAN || 0) ||
      documentDate !== dateKey_(item.TANGGAL_NASKAH) ||
      development !== String(item.TINGKAT_PERKEMBANGAN || '').toUpperCase() ||
      condition !== String(item.KONDISI_FISIK || '').toUpperCase() ||
      securityClassification !== centralFileMetadataNormalizeSecurity_(
        item.KLASIFIKASI_KEAMANAN_AKSES) || hasReplacement;
    if (!changed) throw new Error('Tidak ada perubahan yang perlu disimpan.');

    original = {
      TANGGAL_NASKAH: item.TANGGAL_NASKAH,
      TAHUN_KURUN_WAKTU: item.TAHUN_KURUN_WAKTU,
      URAIAN_LENGKAP: item.URAIAN_LENGKAP,
      URAIAN_NAMA_FILE: item.URAIAN_NAMA_FILE,
      JUMLAH_HALAMAN: item.JUMLAH_HALAMAN,
      TINGKAT_PERKEMBANGAN: item.TINGKAT_PERKEMBANGAN,
      KONDISI_FISIK: item.KONDISI_FISIK,
      KLASIFIKASI_KEAMANAN_AKSES:
        item.KLASIFIKASI_KEAMANAN_AKSES,
      STATUS_VERIFIKASI_METADATA: item.STATUS_VERIFIKASI_METADATA,
      METADATA_SCHEMA_VERSION: item.METADATA_SCHEMA_VERSION,
      DRIVE_FILE_ID: item.DRIVE_FILE_ID,
      DRIVE_FILE_URL: item.DRIVE_FILE_URL,
      NAMA_FILE: item.NAMA_FILE,
      MIME_TYPE: item.MIME_TYPE,
      STATUS_FILE: item.STATUS_FILE,
      UPDATED_AT: item.UPDATED_AT,
      UPDATED_BY: item.UPDATED_BY,
      VERSION: item.VERSION
    };

    if (hasReplacement && !replacementFile) {
      const folder = DriveApp.getFolderById(requireValue_(parent.DRIVE_FOLDER_ID, 'Folder Drive berkas'));
      replacementFile = folder.createFile(replacementBlob).setName('TMP_EDIT_' + Utilities.getUuid() + '.pdf');
    }
    const timestamp = nowIso_();
    const user = getCurrentUser_();
    const changes = {
      TANGGAL_NASKAH: parseLocalDate_(documentDate, 'Tanggal naskah'),
      TAHUN_KURUN_WAKTU: Number(documentDate.substring(0, 4)),
      URAIAN_LENGKAP: description,
      URAIAN_NAMA_FILE: cleanFileName_(description),
      JUMLAH_HALAMAN: pageCount,
      TINGKAT_PERKEMBANGAN: development,
      KONDISI_FISIK: condition,
      KLASIFIKASI_KEAMANAN_AKSES: securityClassification,
      STATUS_VERIFIKASI_METADATA: 'TERVERIFIKASI',
      METADATA_SCHEMA_VERSION: CF_METADATA_SCHEMA_VERSION_,
      UPDATED_AT: timestamp,
      UPDATED_BY: user,
      VERSION: Number(item.VERSION || 0) + 1
    };
    if (replacementFile) {
      changes.DRIVE_FILE_ID = replacementFile.getId();
      changes.DRIVE_FILE_URL = replacementFile.getUrl();
      changes.MIME_TYPE = 'application/pdf';
      changes.STATUS_FILE = 'TERSEDIA';
    }
    updateObjectAtRow_(APP_CONFIG.SHEETS.ITEM, item._rowNumber, changes);
    itemUpdated = true;

    const plan = buildReindexPlan_([parent.BERKAS_ID], 'Penomoran ulang kronologis setelah perubahan metadata item');
    applyNumberingPlan_(plan, timestamp, user);
    const warnings = [];
    if (replacementFile && original.DRIVE_FILE_ID) {
      const quarantine = quarantineDriveObject_(
        'FILE',
        original.DRIVE_FILE_ID,
        {
          module: 'EDIT_ARSIP',
          reason: reason,
          relatedObjectId: item.ITEM_ID,
          notes: 'Versi alih media sebelum penggantian'
        }
      );
      if (!quarantine.ok) warnings.push(quarantine.warning);
    }
    try { rebuildReports_(); }
    catch (reportError) {
      warnings.push('Laporan belum dapat disegarkan: ' + reportError.message);
      audit_('REPORT_WARNING', 'EDIT_ARSIP', 'ITEM', item.ITEM_ID, 'Data berubah tetapi laporan gagal disegarkan', reportError.message, 'WARNING');
    }

    const before = 'Sebelum: tanggal ' + dateKey_(item.TANGGAL_NASKAH) + ', ' + Number(item.JUMLAH_HALAMAN || 0) + ' lembar, ' + (item.TINGKAT_PERKEMBANGAN || '–') + ', kondisi ' + (item.KONDISI_FISIK || 'tidak dicatat') + ', "' + cleanText_(item.URAIAN_LENGKAP, 250) + '"';
    const after = 'Sesudah: tanggal ' + documentDate + ', ' + pageCount + ' lembar, ' + development + ', kondisi ' + (condition || 'tidak dicatat') + ', "' + cleanText_(description, 250) + '"';
    audit_('UPDATE', 'EDIT_ARSIP', 'ITEM', item.ITEM_ID, before + ' | ' + after,
      reason + (hasReplacement ? ' | File alih media diganti; versi lama dipindahkan ke karantina.' : ''), warnings.length ? 'WARNING' : 'SUCCESS');
    return {
      ok: true,
      berkasId: parent.BERKAS_ID,
      itemId: item.ITEM_ID,
      warnings: warnings,
      message: 'Perubahan item berhasil disimpan dan laporan telah diperbarui.'
    };
  } catch (error) {
    if (itemUpdated && original && form && form.editItemId) {
      try {
        const current = readObjects_(APP_CONFIG.SHEETS.ITEM).find(row => row.ITEM_ID === cleanText_(form.editItemId, 80));
        if (current) updateObjectAtRow_(APP_CONFIG.SHEETS.ITEM, current._rowNumber, original);
      } catch (rollbackError) {}
    }
    if (replacementFile) {
      try { replacementFile.setTrashed(true); } catch (cleanupError) {}
    }
    audit_('UPDATE', 'EDIT_ARSIP', 'ITEM', form && form.editItemId || '', 'Perubahan item gagal', error.message, 'FAILED');
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function updateBerkasTitle_(form) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let titleUpdated = false;
  let original = null;
  let berkasId = '';
  try {
    form = form || {};
    berkasId = cleanText_(requireValue_(form.editBerkasId, 'Berkas induk'), 80);
    const newTitle = cleanText_(requireValue_(form.editBerkasTitle, 'Judul berkas baru'), 500);
    const reason = cleanText_(requireValue_(form.editReason, 'Alasan perubahan'), 2000);
    if (reason.length < 10) throw new Error('Alasan perubahan minimal 10 karakter agar jejak audit cukup jelas.');

    const parent = readObjects_(APP_CONFIG.SHEETS.BERKAS).find(row => row.BERKAS_ID === berkasId && !isDeleted_(row));
    if (!parent) throw new Error('Berkas induk tidak ditemukan atau sudah dihapus.');
    assertBerkasAvailableForEdit_(parent);

    const oldTitle = cleanText_(parent.JUDUL_BERKAS, 500);
    if (newTitle === oldTitle) throw new Error('Tidak ada perubahan yang perlu disimpan.');

    original = {
      JUDUL_BERKAS: parent.JUDUL_BERKAS,
      UPDATED_AT: parent.UPDATED_AT,
      UPDATED_BY: parent.UPDATED_BY,
      VERSION: parent.VERSION
    };

    const timestamp = nowIso_();
    const user = getCurrentUser_();
    const changes = {
      JUDUL_BERKAS: newTitle,
      UPDATED_AT: timestamp,
      UPDATED_BY: user,
      VERSION: Number(parent.VERSION || 0) + 1
    };
    updateObjectAtRow_(APP_CONFIG.SHEETS.BERKAS, parent._rowNumber, changes);
    titleUpdated = true;

    const warnings = [];
    try { rebuildReports_(); }
    catch (reportError) {
      warnings.push('Laporan belum dapat disegarkan: ' + reportError.message);
      audit_('REPORT_WARNING', 'EDIT_ARSIP', 'BERKAS', parent.BERKAS_ID, 'Data berubah tetapi laporan gagal disegarkan', reportError.message, 'WARNING');
    }

    audit_('UPDATE_TITLE', 'EDIT_ARSIP', 'BERKAS', parent.BERKAS_ID,
      'Sebelum: "' + oldTitle + '" | Sesudah: "' + newTitle + '"',
      reason, warnings.length ? 'WARNING' : 'SUCCESS');
    return {
      ok: true,
      berkasId: parent.BERKAS_ID,
      warnings: warnings,
      message: 'Judul berkas berhasil diubah dan laporan telah diperbarui.'
    };
  } catch (error) {
    if (titleUpdated && original && berkasId) {
      try {
        const current = readObjects_(APP_CONFIG.SHEETS.BERKAS).find(row => row.BERKAS_ID === berkasId);
        if (current) updateObjectAtRow_(APP_CONFIG.SHEETS.BERKAS, current._rowNumber, original);
      } catch (rollbackError) {}
    }
    audit_('UPDATE_TITLE', 'EDIT_ARSIP', 'BERKAS', berkasId || '', 'Perubahan judul berkas gagal', error.message, 'FAILED');
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function assertBerkasAvailableForEdit_(parent) {
  if (String(parent.STATUS_PEMINJAMAN || 'TERSEDIA').toUpperCase() !== 'TERSEDIA') {
    throw new Error('Berkas sedang dipinjam. Selesaikan transaksi peminjaman sebelum mengedit.');
  }
  const activeLoan = readObjects_(APP_CONFIG.SHEETS.PEMINJAMAN).find(loan => {
    if (String(loan.STATUS || '').toUpperCase() !== 'DIPINJAM') return false;
    const loanBerkasId = String(loan.BERKAS_ID || (String(loan.JENIS_OBJEK || '').toUpperCase() === 'BERKAS' ? loan.OBJEK_ID : '') || '');
    return loanBerkasId === String(parent.BERKAS_ID);
  });
  if (activeLoan) throw new Error('Masih ada transaksi peminjaman aktif untuk berkas ini. Selesaikan pengembalian sebelum mengedit.');
}

function assertItemAvailableForEdit_(parent, item) {
  if (String(parent.STATUS_PEMINJAMAN || 'TERSEDIA').toUpperCase() !== 'TERSEDIA' ||
      String(item.STATUS_PEMINJAMAN || 'TERSEDIA').toUpperCase() !== 'TERSEDIA') {
    throw new Error('Berkas atau item sedang dipinjam. Selesaikan transaksi peminjaman sebelum mengedit.');
  }
  const activeLoan = readObjects_(APP_CONFIG.SHEETS.PEMINJAMAN).find(loan => {
    if (String(loan.STATUS || '').toUpperCase() !== 'DIPINJAM') return false;
    const loanBerkasId = String(loan.BERKAS_ID || (String(loan.JENIS_OBJEK || '').toUpperCase() === 'BERKAS' ? loan.OBJEK_ID : '') || '');
    const loanItemId = String(loan.ITEM_ID || (String(loan.JENIS_OBJEK || '').toUpperCase() === 'ITEM' ? loan.OBJEK_ID : '') || '');
    return loanBerkasId === String(parent.BERKAS_ID) || loanItemId === String(item.ITEM_ID);
  });
  if (activeLoan) throw new Error('Masih ada transaksi peminjaman aktif untuk item ini. Selesaikan pengembalian sebelum mengedit.');
}

function validateReplacementPdf_(blob, byteLength) {
  const originalName = String(blob.getName() || 'dokumen.pdf');
  const contentType = String(blob.getContentType() || '').toLowerCase();
  if (!originalName.toLowerCase().endsWith('.pdf') || (contentType && ['application/pdf', 'application/octet-stream'].indexOf(contentType) === -1)) {
    throw new Error('File alih media pengganti harus berformat PDF.');
  }
  if (Number(byteLength || 0) >= ITEM_UPLOAD_MAX_SIZE_) throw new Error('Ukuran PDF pengganti harus kurang dari 100 MB.');
}

function validateReplacementDriveFile_(file, byteLength) {
  const contentType = String(file.getMimeType() || '').toLowerCase();
  if (contentType !== 'application/pdf') throw new Error('File alih media pengganti harus berformat PDF.');
  if (!Number(byteLength || 0)) throw new Error('File alih media pengganti kosong.');
  if (Number(byteLength || 0) >= ITEM_UPLOAD_MAX_SIZE_) throw new Error('Ukuran PDF pengganti harus kurang dari 100 MB.');
}
