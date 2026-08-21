function doGet() {
  if (!getInstanceSpreadsheetId_(true)) {
    return HtmlService.createHtmlOutput(
      '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<style>body{font-family:Arial,sans-serif;background:#f4f7f9;color:#17344c;padding:40px}' +
      'main{max-width:680px;margin:auto;background:white;border:1px solid #dbe4ea;border-radius:16px;padding:28px}' +
      'h1{color:#143b5d}</style></head><body><main>' +
      '<h1>Instance belum dikonfigurasi</h1>' +
      '<p>Buka spreadsheet template, lalu pilih menu <strong>Arsip Aktif → Instalasi &amp; Reliability</strong>.</p>' +
      '<p>Setelah installer selesai, buat atau perbarui versioned deployment Web App.</p>' +
      '</main></body></html>'
    ).setTitle('Instalasi Aplikasi Arsip');
  }
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('Sistem Pengelolaan Arsip Aktif UINSA')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Arsip Aktif')
    .addItem('Instalasi & Reliability…', 'showReliabilityDialog')
    .addItem('Update Koneksi Record Center (tanpa dialog)…', 'updateRecordCenterConnectionViaPrompts')
    .addSeparator()
    .addItem('Perbaiki / Segarkan Laporan', 'repairReports')
    .addItem('Pasang / Perbaiki Modul Penerimaan', 'repairReceiptModule')
    .addItem('Uji Jalur Upload PDF', 'showUploadDiagnostic')
    .addItem('Uji Upload Bukti Penghapusan', 'showDeletionEvidenceUploadDiagnostic')
    .addSeparator()
    .addItem('Hapus Data Pilot…', 'showPilotResetDialog')
    .addToUi();
}

// Jalur ui.prompt() native — tidak lewat HtmlService/google.script.run —
// dipakai kalau dialog "Instalasi & Reliability" gagal dimuat karena
// lingkungan browser memblokir iframe otorisasi Apps Script (lihat catatan
// yang sama pada record-center/Code.js). Hanya mengubah RECORD_CENTER_*,
// tidak menyentuh field instalasi unit lainnya.
function updateRecordCenterConnectionViaPrompts() {
  const ui = SpreadsheetApp.getUi();
  try {
    let response = ui.prompt('1/5 — Nama Record Center',
      'Nama resmi Record Center tujuan pengajuan:', ui.ButtonSet.OK_CANCEL);
    if (response.getSelectedButton() !== ui.Button.OK) return;
    const recordCenterName = response.getResponseText();

    response = ui.prompt('2/5 — Instance ID Record Center',
      'Contoh: RC-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx', ui.ButtonSet.OK_CANCEL);
    if (response.getSelectedButton() !== ui.Button.OK) return;
    const recordCenterInstanceId = response.getResponseText();

    response = ui.prompt('3/5 — Email Record Center (opsional)',
      'Boleh dikosongkan:', ui.ButtonSet.OK_CANCEL);
    if (response.getSelectedButton() !== ui.Button.OK) return;
    const recordCenterEmail = response.getResponseText();

    response = ui.prompt('4/5 — Endpoint Federatif Record Center',
      'URL Web App RC-01 (https://script.google.com/macros/s/.../exec). ' +
      'Kosongkan bila RC-01 belum di-deploy — outbox tetap PENDING_CONFIGURATION, ini normal:',
      ui.ButtonSet.OK_CANCEL);
    if (response.getSelectedButton() !== ui.Button.OK) return;
    const recordCenterEndpointUrl = response.getResponseText();

    response = ui.prompt('5/5 — Shared Secret',
      'Salin persis dari layar pendaftaran sumber di aplikasi Record Center ' +
      '(kosongkan untuk mempertahankan secret yang sudah ada):', ui.ButtonSet.OK_CANCEL);
    if (response.getSelectedButton() !== ui.Button.OK) return;
    const recordCenterSharedSecret = response.getResponseText();

    const result = updateRecordCenterConnection_({
      recordCenterName: recordCenterName,
      recordCenterInstanceId: recordCenterInstanceId,
      recordCenterEmail: recordCenterEmail,
      recordCenterEndpointUrl: recordCenterEndpointUrl,
      recordCenterSharedSecret: recordCenterSharedSecret
    });
    ui.alert('Berhasil', result.message, ui.ButtonSet.OK);
  } catch (error) {
    ui.alert('Gagal', error.message, ui.ButtonSet.OK);
  }
}

function apiGetBootstrap() {
  const classifications = getClassificationData_();
  return {
    user: getCurrentUser_(),
    instance: getInstancePresentation_(),
    dashboard: getDashboardSummary_(),
    berkasOptions: getBerkasOptions_(),
    classificationsByParent: classifications.byParent,
    retentionUnits: APP_CONFIG.RETENTION_UNITS,
    finalDispositions: APP_CONFIG.FINAL_DISPOSITIONS
  };
}

function apiCommitItem(formObject) {
  return commitItem_(formObject);
}

function apiCommitItemMetadata(formObject) {
  return commitItem_(formObject, '', true);
}

function apiStartItemUpload(request) {
  return startItemUpload_(request);
}

function apiUploadItemChunk(request) {
  return uploadItemChunk_(request);
}

function apiGetItemUploadStatus(sessionId) {
  return getItemUploadStatus_(sessionId);
}

function apiFinalizeItemUpload(sessionId) {
  return finalizeItemUpload_(sessionId);
}

function apiCancelItemUpload(sessionId) {
  return cancelItemUpload_(sessionId);
}

function apiGetMediaUploadOptions() {
  return getMediaUploadOptions_();
}

function apiStartMediaUpload(request) {
  return startMediaUpload_(request);
}

function apiUploadMediaChunk(request) {
  return uploadMediaChunk_(request);
}

function apiGetMediaUploadStatus(sessionId) {
  return getMediaUploadStatus_(sessionId);
}

function apiFinalizeMediaUpload(sessionId) {
  return finalizeMediaUpload_(sessionId);
}

function apiCancelMediaUpload(sessionId) {
  return cancelMediaUpload_(sessionId);
}

function apiSearchArchive(criteria) {
  return searchArchive_(criteria);
}

function apiGetFolderLabelOptions() {
  return getFolderLabelOptions_();
}

function apiPrepareFolderLabels(request) {
  return prepareFolderLabels_(request);
}

function apiGetRetentionOptions() {
  return getRetentionOptions_();
}

function apiVerifyRetentionCandidateMetadata(berkasId) {
  return verifyRetentionCandidateMetadata_(berkasId);
}

function apiCreateTransferProposalDraft(formObject) {
  return createTransferProposalDraft_(formObject);
}

function apiGenerateTransferProposalDocuments(proposalId) {
  return generateTransferProposalDocuments_(proposalId);
}

function apiCancelTransferProposalDraft(formObject) {
  return cancelTransferProposalDraft_(formObject);
}

function apiStartTransferSubmissionUpload(request) {
  return startTransferSubmissionUpload_(request);
}

function apiUploadTransferSubmissionChunk(request) {
  return uploadTransferSubmissionChunk_(request);
}

function apiGetTransferSubmissionUploadStatus(sessionId) {
  return getTransferSubmissionUploadStatus_(sessionId);
}

function apiFinalizeTransferSubmissionUpload(sessionId) {
  return finalizeTransferSubmissionUpload_(sessionId);
}

function apiCancelTransferSubmissionUpload(sessionId) {
  return cancelTransferSubmissionUpload_(sessionId);
}

function apiRetryTransferSubmission(proposalId) {
  return retryTransferSubmission_(proposalId);
}

function apiMarkBerkasTransferred(formObject) {
  return markBerkasTransferred_(formObject);
}

function apiStartRetentionTransferEvidenceUpload(request) {
  return startRetentionTransferEvidenceUpload_(request);
}

function apiUploadRetentionTransferEvidenceChunk(request) {
  return uploadRetentionTransferEvidenceChunk_(request);
}

function apiGetRetentionTransferEvidenceUploadStatus(sessionId) {
  return getRetentionTransferEvidenceUploadStatus_(sessionId);
}

function apiFinalizeRetentionTransferEvidenceUpload(sessionId) {
  return finalizeRetentionTransferEvidenceUpload_(sessionId);
}

function apiCancelRetentionTransferEvidenceUpload(sessionId) {
  return cancelRetentionTransferEvidenceUpload_(sessionId);
}

function apiGetLoanOptions() {
  return getLoanOptions_();
}

function apiCreateLoan(formObject) {
  return createLoan_(formObject);
}

function apiReturnLoan(formObject) {
  return returnLoan_(formObject);
}

function apiPrepareLoanOutIndicator(loanGroupId) {
  return prepareLoanOutIndicator_(loanGroupId);
}

function apiStartLoanEvidenceUpload(request) {
  return startLoanEvidenceUpload_(request);
}

function apiUploadLoanEvidenceChunk(request) {
  return uploadLoanEvidenceChunk_(request);
}

function apiGetLoanEvidenceUploadStatus(sessionId) {
  return getLoanEvidenceUploadStatus_(sessionId);
}

function apiFinalizeLoanEvidenceUpload(sessionId) {
  return finalizeLoanEvidenceUpload_(sessionId);
}

function apiCancelLoanEvidenceUpload(sessionId) {
  return cancelLoanEvidenceUpload_(sessionId);
}

function apiGetReceiptOptions() {
  return getReceiptOptions_();
}

function apiAddReceiptEmployee(formObject) {
  return addReceiptEmployee_(formObject);
}

function apiSaveReceipt(formObject) {
  return saveReceipt_(formObject);
}

function apiRecoverReceiptSave(requestId) {
  return recoverReceiptSave_(requestId);
}

function apiGetReceiptFilingOptions() {
  return getReceiptFilingOptions_();
}

function apiCommitReceiptFiling(formObject) {
  return commitReceiptFiling_(formObject);
}

function apiRecoverReceiptFiling(requestId, receiptItemIds) {
  return recoverReceiptFiling_(requestId, receiptItemIds);
}

function apiRefreshReceiptFilingReports(requestId) {
  return refreshReceiptFilingReports_(requestId);
}

function apiPrepareReceiptPrint(receiptId) {
  return prepareReceiptPrint_(receiptId);
}

function apiConfirmReceiptPrint(request) {
  return confirmReceiptPrint_(request);
}

function apiCancelReceipt(formObject) {
  return cancelReceipt_(formObject);
}

function apiStartReceiptEvidenceUpload(request) {
  return startReceiptEvidenceUpload_(request);
}

function apiUploadReceiptEvidenceChunk(request) {
  return uploadReceiptEvidenceChunk_(request);
}

function apiGetReceiptEvidenceUploadStatus(sessionId) {
  return getReceiptEvidenceUploadStatus_(sessionId);
}

function apiFinalizeReceiptEvidenceUpload(sessionId) {
  return finalizeReceiptEvidenceUpload_(sessionId);
}

function apiCancelReceiptEvidenceUpload(sessionId) {
  return cancelReceiptEvidenceUpload_(sessionId);
}

function apiGetDeletionOptions() {
  return getDeletionOptions_();
}

function apiDeleteArchive(formObject) {
  return deleteArchive_(formObject);
}

function apiStartDeletionEvidenceUpload(request) {
  return startDeletionEvidenceUpload_(request);
}

function apiUploadDeletionEvidenceChunk(request) {
  return uploadDeletionEvidenceChunk_(request);
}

function apiGetDeletionEvidenceUploadStatus(sessionId) {
  return getDeletionEvidenceUploadStatus_(sessionId);
}

function apiFinalizeDeletionEvidenceUpload(sessionId) {
  return finalizeDeletionEvidenceUpload_(sessionId);
}

function apiCancelDeletionEvidenceUpload(sessionId) {
  return cancelDeletionEvidenceUpload_(sessionId);
}

function apiGetEditOptions() {
  return getEditOptions_();
}

function apiUpdateArchiveItem(formObject) {
  return updateArchiveItem_(formObject);
}

function apiStartEditReplacementUpload(request) {
  return startEditReplacementUpload_(request);
}

function apiUploadEditReplacementChunk(request) {
  return uploadEditReplacementChunk_(request);
}

function apiGetEditReplacementUploadStatus(sessionId) {
  return getEditReplacementUploadStatus_(sessionId);
}

function apiFinalizeEditReplacementUpload(sessionId) {
  return finalizeEditReplacementUpload_(sessionId);
}

function apiCancelEditReplacementUpload(sessionId) {
  return cancelEditReplacementUpload_(sessionId);
}

function apiGetUnitSetup() {
  return getUnitSetup_();
}

function apiInstallUnitInstance(formObject) {
  return installUnitInstance_(formObject);
}

function apiGetReliabilityDashboard() {
  return getReliabilityDashboard_();
}

function apiRunReliabilityHealthCheck() {
  return runReliabilityHealthCheck_(true);
}

function apiStartReliabilityBackup(request) {
  return startReliabilityBackup_(request);
}

function apiVerifyReliabilityBackup(backupId) {
  return verifyReliabilityBackup_(backupId);
}

function apiCreateDistributionTemplate() {
  return createDistributionTemplate_();
}

function apiHealthCheck() {
  const result = runReliabilityHealthCheck_(true);
  result.missing = result.checks
    .filter(check => check.code === 'REQUIRED_SHEETS' && check.status === 'ERROR')
    .map(check => check.detail);
  return result;
}

function repairReports() {
  const result = rebuildReports_({forceLayoutRepair: true});
  return {
    ok: true,
    message: 'Laporan berhasil dibangun ulang. Kolom Jumlah (Lembar) berada di kolom ' + result.berkasLayout.totalPagesColumn + '.',
    repairedAt: nowIso_()
  };
}

function repairReceiptModule() {
  const result = ensureReceiptModule_();
  ensureReceiptFilingSchema_();
  const migration = backfillReceiptFilingSchema_();
  return {
    ok: true,
    message:
      'Modul Penerimaan Arsip dan integrasi pemberkasan siap. Sheet database: ' +
      result.sheets.join(', ') + '. ' +
      Number(migration.receiptItemsUpdated || 0) + ' item penerimaan dan ' +
      Number(migration.dbItemsUpdated || 0) + ' item arsip dimigrasikan.',
    repairedAt: nowIso_()
  };
}

function diagnoseUploadPipeline() {
  return runUploadPipelineDiagnostic_();
}

function showUploadDiagnostic() {
  const ui = SpreadsheetApp.getUi();
  try {
    const result = runUploadPipelineDiagnostic_();
    ui.alert('Uji upload berhasil', result.message, ui.ButtonSet.OK);
  } catch (error) {
    ui.alert('Uji upload gagal', error.message, ui.ButtonSet.OK);
    throw error;
  }
}

function diagnoseDeletionEvidenceUpload() {
  return runDeletionEvidenceUploadDiagnostic_();
}

function showDeletionEvidenceUploadDiagnostic() {
  const ui = SpreadsheetApp.getUi();
  try {
    const result = runDeletionEvidenceUploadDiagnostic_();
    ui.alert('Uji bukti disposisi berhasil', result.message, ui.ButtonSet.OK);
  } catch (error) {
    ui.alert('Uji bukti disposisi gagal', error.message, ui.ButtonSet.OK);
    throw error;
  }
}

function showPilotResetDialog() {
  const ui = SpreadsheetApp.getUi();
  if (getInstanceSpreadsheetId_(true)) {
    const settings = readSettings_();
    if (settings.ALLOW_PILOT_RESET !== true) {
      ui.alert(
        'Reset pilot dinonaktifkan',
        'Instance produksi tidak mengizinkan penghapusan data pilot. ' +
        'Gunakan prosedur koreksi atau karantina yang tercatat.',
        ui.ButtonSet.OK
      );
      return;
    }
  }
  const response = ui.prompt(
    'Hapus Data Pilot',
    'Tindakan ini menghapus seluruh DB_BERKAS, DB_ITEM, peminjaman, dan riwayat nomor. Folder arsip pilot akan dipindahkan ke Trash. Ketik HAPUS DATA PILOT untuk melanjutkan.',
    ui.ButtonSet.OK_CANCEL
  );
  if (response.getSelectedButton() !== ui.Button.OK) return;
  if (response.getResponseText().trim().toUpperCase() !== 'HAPUS DATA PILOT') {
    ui.alert('Dibatalkan', 'Teks konfirmasi tidak sesuai. Tidak ada data yang dihapus.', ui.ButtonSet.OK);
    return;
  }
  const result = resetPilotData_();
  const warningText = result.driveWarnings.length
    ? '\n\nSebagian folder Drive tidak dapat dipindahkan ke Trash:\n' + result.driveWarnings.join('\n')
    : '';
  ui.alert('Reset selesai', 'Data pilot telah dihapus. ' + result.trashedFolderCount + ' folder dipindahkan ke Trash.' + warningText, ui.ButtonSet.OK);
}

function resetPilotData_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const berkas = readObjects_(APP_CONFIG.SHEETS.BERKAS);
    const folderIds = [...new Set(berkas.map(row => cleanText_(row.DRIVE_FOLDER_ID)).filter(Boolean))];
    const driveWarnings = [];
    let trashedFolderCount = 0;
    folderIds.forEach(folderId => {
      try {
        DriveApp.getFolderById(folderId).setTrashed(true);
        trashedFolderCount++;
      } catch (error) {
        driveWarnings.push(folderId + ': ' + error.message);
      }
    });

    [APP_CONFIG.SHEETS.ITEM, APP_CONFIG.SHEETS.BERKAS, APP_CONFIG.SHEETS.PEMINJAMAN, APP_CONFIG.SHEETS.HISTORY]
      .forEach(clearDataRows_);
    clearFolderLabelPilotLog_();
    rebuildReports_();
    audit_('RESET', 'DATA_PILOT', 'SISTEM', '', 'Menghapus seluruh data arsip pilot', 'Dikonfirmasi melalui menu spreadsheet', 'SUCCESS');
    return {ok: true, trashedFolderCount, driveWarnings};
  } finally {
    lock.releaseLock();
  }
}

function clearDataRows_(sheetName) {
  const sheet = getSheetOrThrow_(sheetName);
  const dataRowCount = sheet.getLastRow() - 1;
  if (dataRowCount > 0) sheet.getRange(2, 1, dataRowCount, sheet.getLastColumn()).clearContent();
}
