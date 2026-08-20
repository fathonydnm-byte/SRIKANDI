function getDeletionOptions_() {
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
      loanStatus: row.STATUS_PEMINJAMAN || 'TERSEDIA',
      label: (row.NO_ITEM_DEFINITIF || '–') + ' – ' + cleanText_(row.URAIAN_LENGKAP || 'Tanpa uraian', 140)
    });
  });
  return {
    berkas: berkas.map(row => ({
      id: row.BERKAS_ID,
      number: row.NO_BERKAS_DEFINITIF || '',
      title: row.JUDUL_BERKAS || '',
      itemCount: (itemsByBerkas[row.BERKAS_ID] || []).length,
      pageCount: Number(row.TOTAL_HALAMAN || 0),
      loanStatus: row.STATUS_PEMINJAMAN || 'TERSEDIA',
      label: (row.NO_BERKAS_DEFINITIF || 'DRAFT') + ' – ' + row.JUDUL_BERKAS
    })),
    itemsByBerkas: itemsByBerkas
  };
}

function deleteArchive_(form, preUploadedEvidenceId, evidenceOriginalName) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const context = resolveDeletionContext_(form);
    form = context.form;
    const scope = context.scope;
    const reason = context.reason;
    const parent = context.parent;
    const activeItems = context.activeItems;
    const targetItem = context.targetItem;
    const evidence = saveDeletionEvidence_(form.dispositionFile, scope, parent, targetItem, preUploadedEvidenceId, evidenceOriginalName);
    const timestamp = nowIso_();
    const user = getCurrentUser_();
    const warnings = [];
    const auditReason = reason + (evidence ? ' | Bukti disposisi: ' + evidence.url : '');

    if (scope === 'BERKAS') {
      activeItems.forEach(item => {
        updateObjectAtRow_(APP_CONFIG.SHEETS.ITEM, item._rowNumber, {
          IS_DELETED: true,
          STATUS_FILE: 'DIHAPUS',
          UPDATED_AT: timestamp,
          UPDATED_BY: user,
          VERSION: Number(item.VERSION || 0) + 1,
          CATATAN: appendDeletionNote_(item.CATATAN, reason)
        });
        audit_('DELETE', 'PENGHAPUSAN', 'ITEM', item.ITEM_ID,
          'Item ' + (item.NO_BERKAS_SNAPSHOT || parent.NO_BERKAS_DEFINITIF || '–') + '/' + (item.NO_ITEM_DEFINITIF || '–') + ' dihapus bersama berkas induk',
          auditReason, 'SUCCESS');
      });
      updateObjectAtRow_(APP_CONFIG.SHEETS.BERKAS, parent._rowNumber, {
        IS_DELETED: true,
        STATUS_BERKAS: 'DIHAPUS',
        UPDATED_AT: timestamp,
        UPDATED_BY: user,
        VERSION: Number(parent.VERSION || 0) + 1,
        CATATAN: appendDeletionNote_(parent.CATATAN, reason)
      });
      if (parent.DRIVE_FOLDER_ID) {
        const quarantine = quarantineDriveObject_(
          'FOLDER',
          parent.DRIVE_FOLDER_ID,
          {
            module: 'PENGHAPUSAN_BERKAS',
            reason: reason,
            relatedObjectId: parent.BERKAS_ID
          }
        );
        if (!quarantine.ok) warnings.push(quarantine.warning);
      }
      audit_('DELETE', 'PENGHAPUSAN', 'BERKAS', parent.BERKAS_ID,
        'Menghapus berkas ' + (parent.NO_BERKAS_DEFINITIF || 'DRAFT') + ' – ' + parent.JUDUL_BERKAS + ' beserta ' + activeItems.length + ' item',
        auditReason, warnings.length ? 'WARNING' : 'SUCCESS');
      try {
        const releaseResult = releaseReceiptItemsAfterDeletion_(activeItems, timestamp, user);
        const released = Number(releaseResult.released || 0);
        if (released) {
          audit_('RELEASE_SOURCE', 'PENGHAPUSAN', 'PENERIMAAN_ITEM', parent.BERKAS_ID,
            released + ' sumber penerimaan dikembalikan ke antrean pemberkasan',
            'Berkas definitif dihapus', 'SUCCESS');
        }
      } catch (releaseError) {
        warnings.push('Antrean penerimaan belum dipulihkan: ' + releaseError.message);
      }
      applyNumberingPlan_(buildReindexPlan_([], 'Penomoran ulang kronologis setelah penghapusan berkas'), timestamp, user);
    } else {
      updateObjectAtRow_(APP_CONFIG.SHEETS.ITEM, targetItem._rowNumber, {
        IS_DELETED: true,
        STATUS_FILE: 'DIHAPUS',
        UPDATED_AT: timestamp,
        UPDATED_BY: user,
        VERSION: Number(targetItem.VERSION || 0) + 1,
        CATATAN: appendDeletionNote_(targetItem.CATATAN, reason)
      });
      if (targetItem.DRIVE_FILE_ID) {
        const quarantine = quarantineDriveObject_(
          'FILE',
          targetItem.DRIVE_FILE_ID,
          {
            module: 'PENGHAPUSAN_ITEM',
            reason: reason,
            relatedObjectId: targetItem.ITEM_ID
          }
        );
        if (!quarantine.ok) warnings.push(quarantine.warning);
      }
      audit_('DELETE', 'PENGHAPUSAN', 'ITEM', targetItem.ITEM_ID,
        'Menghapus item ' + (parent.NO_BERKAS_DEFINITIF || '–') + '/' + (targetItem.NO_ITEM_DEFINITIF || '–') + ' – ' + cleanText_(targetItem.URAIAN_LENGKAP, 300),
        auditReason, warnings.length ? 'WARNING' : 'SUCCESS');
      try {
        const releaseResult = releaseReceiptItemsAfterDeletion_([targetItem], timestamp, user);
        const released = Number(releaseResult.released || 0);
        if (released) {
          audit_('RELEASE_SOURCE', 'PENGHAPUSAN', 'PENERIMAAN_ITEM', targetItem.ITEM_ID,
            'Sumber penerimaan dikembalikan ke antrean pemberkasan',
            'Item definitif dihapus', 'SUCCESS');
        }
      } catch (releaseError) {
        warnings.push('Antrean penerimaan belum dipulihkan: ' + releaseError.message);
      }
      applyNumberingPlan_(buildReindexPlan_([parent.BERKAS_ID], 'Penomoran ulang kronologis setelah penghapusan item'), timestamp, user);
    }

    try { rebuildReports_(); }
    catch (reportError) {
      warnings.push('Laporan belum dapat disegarkan: ' + reportError.message);
      audit_('REPORT_WARNING', 'PENGHAPUSAN', scope, scope === 'BERKAS' ? parent.BERKAS_ID : targetItem.ITEM_ID,
        'Data terhapus tetapi laporan gagal disegarkan', reportError.message, 'WARNING');
    }
    return {
      ok: true,
      scope: scope,
      berkasId: parent.BERKAS_ID,
      itemId: targetItem ? targetItem.ITEM_ID : '',
      warnings: warnings,
      message: scope === 'BERKAS'
        ? 'Berkas dan ' + activeItems.length + ' item berhasil dihapus dari arsip aktif.'
        : 'Item berhasil dihapus dan nomor item telah disusun ulang.'
    };
  } catch (error) {
    audit_('DELETE', 'PENGHAPUSAN', 'SISTEM', '', 'Penghapusan gagal', error.message, 'FAILED');
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function resolveDeletionContext_(form) {
  form = form || {};
  const scope = String(requireValue_(form.deletionScope, 'Objek penghapusan')).toUpperCase();
  if (['BERKAS', 'ITEM'].indexOf(scope) === -1) throw new Error('Objek penghapusan tidak valid.');
  const reason = cleanText_(requireValue_(form.deletionReason, 'Alasan penghapusan'), 2000);
  if (reason.length < 10) throw new Error('Alasan penghapusan minimal 10 karakter agar jejak audit cukup jelas.');
  if (String(form.deletionConfirmation || '').trim().toUpperCase() !== 'HAPUS') throw new Error('Ketik HAPUS pada kolom konfirmasi.');

  const allBerkas = readObjects_(APP_CONFIG.SHEETS.BERKAS);
  const allItems = readObjects_(APP_CONFIG.SHEETS.ITEM);
  const berkasId = cleanText_(requireValue_(form.deletionBerkasId, 'Berkas'), 80);
  const parent = allBerkas.find(row => row.BERKAS_ID === berkasId && !isDeleted_(row));
  if (!parent) throw new Error('Berkas tidak ditemukan atau sudah dihapus.');
  const activeItems = allItems.filter(row => row.BERKAS_ID === berkasId && !isDeleted_(row));
  assertNotBorrowedForDeletion_(parent, scope === 'BERKAS' ? activeItems : []);

  let targetItem = null;
  if (scope === 'ITEM') {
    const itemId = cleanText_(requireValue_(form.deletionItemId, 'Item arsip'), 80);
    targetItem = activeItems.find(row => row.ITEM_ID === itemId);
    if (!targetItem) throw new Error('Item tidak ditemukan atau sudah dihapus.');
    assertNotBorrowedForDeletion_(parent, [targetItem]);
    if (activeItems.length <= 1) throw new Error('Item ini adalah item terakhir. Gunakan pilihan Hapus seluruh berkas agar database tetap konsisten.');
  }
  return {form: form, scope: scope, reason: reason, parent: parent, activeItems: activeItems, targetItem: targetItem};
}

function assertNotBorrowedForDeletion_(parent, items) {
  if (String(parent.STATUS_PEMINJAMAN || 'TERSEDIA').toUpperCase() !== 'TERSEDIA') {
    throw new Error('Berkas sedang dipinjam. Selesaikan transaksi peminjaman sebelum menghapus.');
  }
  const borrowedItem = (items || []).find(item => String(item.STATUS_PEMINJAMAN || 'TERSEDIA').toUpperCase() !== 'TERSEDIA');
  if (borrowedItem) throw new Error('Item ' + (borrowedItem.NO_ITEM_DEFINITIF || borrowedItem.ITEM_ID) + ' sedang dipinjam. Selesaikan transaksi peminjaman sebelum menghapus.');
  const itemIds = (items || []).map(item => String(item.ITEM_ID));
  const activeLoan = readObjects_(APP_CONFIG.SHEETS.PEMINJAMAN).find(loan => {
    if (String(loan.STATUS || '').toUpperCase() !== 'DIPINJAM') return false;
    const loanBerkasId = String(loan.BERKAS_ID || (String(loan.JENIS_OBJEK || '').toUpperCase() === 'BERKAS' ? loan.OBJEK_ID : '') || '');
    const loanItemId = String(loan.ITEM_ID || (String(loan.JENIS_OBJEK || '').toUpperCase() === 'ITEM' ? loan.OBJEK_ID : '') || '');
    return loanBerkasId === String(parent.BERKAS_ID) || itemIds.indexOf(loanItemId) !== -1;
  });
  if (activeLoan) throw new Error('Masih ada transaksi peminjaman aktif untuk objek ini. Selesaikan pengembalian sebelum menghapus.');
}

function saveDeletionEvidence_(blob, scope, parent, item, preUploadedFileId, originalUploadedName) {
  let file = null;
  let byteLength = 0;
  let originalName = '';
  let contentType = '';
  if (preUploadedFileId) {
    file = DriveApp.getFileById(preUploadedFileId);
    byteLength = Number(file.getSize());
    originalName = String(originalUploadedName || file.getName() || 'bukti');
    contentType = String(file.getMimeType() || '').toLowerCase();
  } else {
    if (!blob || typeof blob.getBytes !== 'function') return null;
    const bytes = blob.getBytes();
    if (!bytes || !bytes.length) return null;
    byteLength = bytes.length;
    originalName = String(blob.getName() || 'bukti');
    contentType = String(blob.getContentType() || '').toLowerCase();
  }
  if (byteLength > 25 * 1024 * 1024) throw new Error('Ukuran bukti disposisi maksimal 25 MB.');
  const extension = (originalName.match(/\.([^.]+)$/) || [,''])[1].toLowerCase();
  const allowedExtension = ['pdf', 'jpg', 'jpeg', 'png'].indexOf(extension) !== -1;
  const allowedType = !contentType || ['application/pdf', 'image/jpeg', 'image/png', 'application/octet-stream'].indexOf(contentType) !== -1;
  if (!allowedExtension || !allowedType) throw new Error('Bukti disposisi harus PDF, JPG, JPEG, atau PNG.');
  const folder = getDeletionEvidenceFolder_();
  const objectNumber = item
    ? (parent.NO_BERKAS_DEFINITIF || 'DRAFT') + '-' + (item.NO_ITEM_DEFINITIF || 'ITEM')
    : (parent.NO_BERKAS_DEFINITIF || 'DRAFT');
  const stamp = Utilities.formatDate(new Date(), APP_CONFIG.TIME_ZONE, 'yyyyMMdd-HHmmss');
  const title = item ? item.URAIAN_LENGKAP : parent.JUDUL_BERKAS;
  const finalName = stamp + '_' + scope + '_' + objectNumber + '_' + cleanFileName_(title) + '.' + extension;
  if (file) file.setName(finalName);
  else file = folder.createFile(blob).setName(finalName);
  return {id: file.getId(), url: file.getUrl(), name: file.getName()};
}

function getDeletionEvidenceFolder_() {
  const settings = readSettings_();
  if (settings.DELETION_EVIDENCE_FOLDER_ID) {
    try { return DriveApp.getFolderById(settings.DELETION_EVIDENCE_FOLDER_ID); }
    catch (ignore) {}
  }
  const root = DriveApp.getFolderById(requireValue_(settings.ARCHIVE_FOLDER_ID, 'ARCHIVE_FOLDER_ID pada SETTINGS'));
  const matches = root.getFoldersByName('BUKTI PENGHAPUSAN');
  return matches.hasNext() ? matches.next() : root.createFolder('BUKTI PENGHAPUSAN');
}

function appendDeletionNote_(existing, reason) {
  const prefix = cleanText_(existing, 1000);
  const note = '[DIHAPUS ' + nowIso_() + '] ' + cleanText_(reason, 1000);
  return cleanText_(prefix ? prefix + ' | ' + note : note, 2000);
}
