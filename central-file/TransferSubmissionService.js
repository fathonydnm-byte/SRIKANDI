var TRANSFER_SUBMISSION_UPLOAD_PREFIX_ = 'TRANSFER_SUBMISSION_UPLOAD_';
var TRANSFER_SUBMISSION_MAX_FILE_SIZE_ = 10 * 1024 * 1024;
var TRANSFER_SUBMISSION_CHUNK_SIZE_ = 512 * 1024;

var TRANSFER_CF06_PROPOSAL_HEADERS_ = [
  'NOTA_DINAS_FILE_NAME', 'NOTA_DINAS_UPLOADED_AT',
  'NOTA_DINAS_UPLOADED_BY', 'RECORD_CENTER_NAME_SNAPSHOT',
  'RECORD_CENTER_EMAIL_SNAPSHOT', 'SUBMISSION_PACKAGE_ID',
  'SUBMISSION_PAYLOAD_FILE_ID', 'SUBMISSION_PAYLOAD_FILE_URL',
  'SUBMISSION_PAYLOAD_SHA256', 'OUTBOX_ID', 'OUTBOX_STATUS',
  'OUTBOX_LAST_ATTEMPT_AT', 'OUTBOX_LAST_ERROR'
];

var TRANSFER_CF06_OUTBOX_HEADERS_ = [
  'OUTBOX_ID', 'EVENT_TYPE', 'USUL_PINDAH_ID', 'NO_USUL_PINDAH',
  'STATUS_OUTBOX', 'DESTINATION_INSTANCE_ID', 'DESTINATION_NAME',
  'DESTINATION_EMAIL', 'ENDPOINT_URL_SNAPSHOT', 'PAYLOAD_FILE_ID',
  'PAYLOAD_FILE_URL', 'PAYLOAD_SHA256', 'CREATED_AT', 'CREATED_BY',
  'LAST_ATTEMPT_AT', 'ATTEMPT_COUNT', 'SENT_AT', 'RESPONSE_CODE',
  'RESPONSE_BODY', 'LAST_ERROR', 'UPDATED_AT'
];

function ensureTransferSubmissionSchema_() {
  ensureColumnsOnSheet_(
    APP_CONFIG.SHEETS.TRANSFER_PROPOSAL,
    TRANSFER_CF06_PROPOSAL_HEADERS_,
    [240, 180, 220, 280, 240, 190, 220, 260, 260, 190, 170]
  );
  ensureSystemSheet_(
    APP_CONFIG.SHEETS.TRANSFER_OUTBOX,
    TRANSFER_CF06_OUTBOX_HEADERS_,
    [190, 180, 190, 150, 170, 210, 280, 240, 320, 220, 260]
  );
  return {ok: true};
}

function getTransferSubmissionHealth_() {
  const spreadsheet = getSpreadsheet_();
  const missing = [];
  const proposalSheet = spreadsheet.getSheetByName(
    APP_CONFIG.SHEETS.TRANSFER_PROPOSAL);
  if (!proposalSheet) {
    missing.push(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL + '.*');
  } else {
    const proposalHeaders = getHeaders_(proposalSheet);
    TRANSFER_CF06_PROPOSAL_HEADERS_.forEach(header => {
      if (proposalHeaders.indexOf(header) === -1) {
        missing.push(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL + '.' + header);
      }
    });
  }
  const outboxSheet = spreadsheet.getSheetByName(APP_CONFIG.SHEETS.TRANSFER_OUTBOX);
  if (!outboxSheet) {
    missing.push(APP_CONFIG.SHEETS.TRANSFER_OUTBOX + '.*');
  } else {
    const outboxHeaders = getHeaders_(outboxSheet);
    TRANSFER_CF06_OUTBOX_HEADERS_.forEach(header => {
      if (outboxHeaders.indexOf(header) === -1) {
        missing.push(APP_CONFIG.SHEETS.TRANSFER_OUTBOX + '.' + header);
      }
    });
  }
  return {ok: missing.length === 0, missing: missing};
}

function startTransferSubmissionUpload_(request) {
  purgeOldUploadSessionsByPrefix_(TRANSFER_SUBMISSION_UPLOAD_PREFIX_);
  ensureTransferSubmissionSchema_();
  const context = validateTransferSubmissionRequest_(request);
  const sessionId = 'RC-SUBMIT-' + Utilities.getUuid();
  const temporaryName = 'UPLOAD_NOTA_DINAS_' + sessionId + '.pdf';
  const sessionUrl = initializeDriveResumableUpload_(
    temporaryName, context.fileSize, context.outputFolderId, 'application/pdf');
  const session = {
    sessionId: sessionId,
    sessionUrl: sessionUrl,
    userEmail: getCurrentUser_(),
    proposalId: context.proposalId,
    recordCenterName: context.recordCenterName,
    recordCenterEmail: context.recordCenterEmail,
    originalFileName: context.fileName,
    fileSize: context.fileSize,
    uploadedBytes: 0,
    driveFileId: '',
    committed: false,
    commitResult: null,
    createdAt: nowIso_()
  };
  saveTransferSubmissionSession_(session);
  audit_('UPLOAD_START', 'USUL_PEMINDAHAN', 'USUL_PINDAH', context.proposalId,
    'Memulai upload Nota Dinas pengajuan',
    context.fileName + ' · ' + context.fileSize + ' byte', 'SUCCESS');
  return transferSubmissionProgress_(session);
}

function uploadTransferSubmissionChunk_(request) {
  request = request || {};
  const session = getTransferSubmissionSession_(request.sessionId);
  if (session.driveFileId) return transferSubmissionProgress_(session);
  const total = Number(request.total);
  const start = Number(request.start);
  const endExclusive = Number(request.end);
  if (total !== Number(session.fileSize)) {
    throw new Error('Ukuran Nota Dinas berubah selama upload. Pilih ulang PDF.');
  }
  if (!Number.isInteger(start) || !Number.isInteger(endExclusive) ||
      start < 0 || endExclusive <= start || endExclusive > total) {
    throw new Error('Posisi potongan Nota Dinas tidak valid.');
  }
  if (start !== Number(session.uploadedBytes || 0)) {
    return transferSubmissionProgress_(session);
  }
  const bytes = Utilities.base64Decode(String(request.base64 || ''));
  if (bytes.length !== endExclusive - start) {
    throw new Error('Ukuran potongan Nota Dinas tidak sesuai.');
  }
  if (endExclusive < total && bytes.length % (256 * 1024) !== 0) {
    throw new Error('Potongan selain yang terakhir harus kelipatan 256 KB.');
  }
  const response = sendDriveResumableChunk_(
    session.sessionUrl, bytes, start, endExclusive, total, 'application/pdf');
  if (response.complete) {
    session.uploadedBytes = total;
    session.driveFileId = response.fileId;
  } else {
    session.uploadedBytes = response.uploadedBytes;
  }
  saveTransferSubmissionSession_(session);
  return transferSubmissionProgress_(session);
}

function getTransferSubmissionUploadStatus_(sessionId) {
  const session = getTransferSubmissionSession_(sessionId);
  if (session.committed && session.commitResult) {
    return transferSubmissionProgress_(session);
  }
  if (!session.driveFileId) {
    const response = queryDriveResumableStatus_(
      session.sessionUrl, session.fileSize, 'application/pdf');
    if (response.complete) {
      session.uploadedBytes = session.fileSize;
      session.driveFileId = response.fileId;
    } else {
      session.uploadedBytes = response.uploadedBytes;
    }
    saveTransferSubmissionSession_(session);
  }
  return transferSubmissionProgress_(session);
}

function finalizeTransferSubmissionUpload_(sessionId) {
  let session = getTransferSubmissionSession_(sessionId);
  if (session.committed && session.commitResult) return session.commitResult;
  const recovered = recoverTransferSubmissionResult_(session);
  if (recovered) {
    session.committed = true;
    session.commitResult = recovered;
    saveTransferSubmissionSession_(session);
    return recovered;
  }
  if (!session.driveFileId) {
    const status = getTransferSubmissionUploadStatus_(sessionId);
    if (!status.complete) {
      throw new Error('UPLOAD_INCOMPLETE: Nota Dinas baru terunggah ' +
        status.uploadedBytes + ' dari ' + status.fileSize + ' byte.');
    }
    session = getTransferSubmissionSession_(sessionId);
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    ensureTransferSubmissionSchema_();
    const proposals = readObjects_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL);
    const proposal = proposals.find(row =>
      String(row.USUL_PINDAH_ID || '') === String(session.proposalId));
    validateTransferSubmissionProposal_(proposal);
    const notaFile = DriveApp.getFileById(session.driveFileId);
    if (String(notaFile.getMimeType() || '').toLowerCase() !== 'application/pdf') {
      throw new Error('File hasil upload Nota Dinas bukan PDF.');
    }
    const safeNumber = cleanFileName_(proposal.NO_USUL_PINDAH || 'USUL-PINDAH');
    const notaFileName = safeNumber + '_Nota-Dinas-Permohonan-Pemindahan.pdf';
    notaFile.setName(notaFileName);

    const timestamp = nowIso_();
    const user = getCurrentUser_();
    const details = readObjects_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL_DETAIL)
      .filter(row => String(row.USUL_PINDAH_ID || '') === String(session.proposalId) &&
        String(row.STATUS_DETAIL || 'AKTIF').toUpperCase() !== 'DIBATALKAN');
    const items = readObjects_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL_ITEM)
      .filter(row => String(row.USUL_PINDAH_ID || '') === String(session.proposalId) &&
        String(row.STATUS_SNAPSHOT || 'AKTIF').toUpperCase() !== 'DIBATALKAN');
    const settings = readSettings_();
    const packageId = 'PKG-' + Utilities.getUuid();
    const outboxId = 'OUT-' + Utilities.getUuid();
    const envelope = buildTransferSubmissionEnvelope_(
      proposal, details, items, notaFile, settings, session,
      packageId, outboxId, timestamp, user);
    const payloadText = JSON.stringify(envelope);
    const payloadHash = transferSubmissionSha256_(payloadText);
    const outputFolder = DriveApp.getFolderById(
      requireValue_(proposal.OUTPUT_FOLDER_ID, 'Folder keluaran usul'));
    const payloadName = safeNumber + '_Paket-Pengajuan-Record-Center.json';
    const payloadFile = outputFolder.createFile(
      Utilities.newBlob(payloadText, 'application/json', payloadName));
    const destination = transferSubmissionDestination_(settings, session);
    appendObject_(APP_CONFIG.SHEETS.TRANSFER_OUTBOX, {
      OUTBOX_ID: outboxId,
      EVENT_TYPE: 'SUBMIT_TRANSFER_PROPOSAL',
      USUL_PINDAH_ID: proposal.USUL_PINDAH_ID,
      NO_USUL_PINDAH: proposal.NO_USUL_PINDAH,
      STATUS_OUTBOX: destination.ready ? 'PENDING' : 'PENDING_CONFIGURATION',
      DESTINATION_INSTANCE_ID: destination.instanceId,
      DESTINATION_NAME: destination.name,
      DESTINATION_EMAIL: destination.email,
      ENDPOINT_URL_SNAPSHOT: destination.endpointUrl,
      PAYLOAD_FILE_ID: payloadFile.getId(),
      PAYLOAD_FILE_URL: payloadFile.getUrl(),
      PAYLOAD_SHA256: payloadHash,
      CREATED_AT: timestamp,
      CREATED_BY: user,
      ATTEMPT_COUNT: 0,
      UPDATED_AT: timestamp
    });
    updateObjectAtRow_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL, proposal._rowNumber, {
      STATUS_USUL: 'DIAJUKAN',
      NOTA_DINAS_FILE_ID: notaFile.getId(),
      NOTA_DINAS_FILE_URL: notaFile.getUrl(),
      NOTA_DINAS_FILE_NAME: notaFileName,
      NOTA_DINAS_UPLOADED_AT: timestamp,
      NOTA_DINAS_UPLOADED_BY: user,
      RECORD_CENTER_INSTANCE_ID: destination.instanceId,
      RECORD_CENTER_NAME_SNAPSHOT: destination.name,
      RECORD_CENTER_EMAIL_SNAPSHOT: destination.email,
      SUBMISSION_PACKAGE_ID: packageId,
      SUBMISSION_PAYLOAD_FILE_ID: payloadFile.getId(),
      SUBMISSION_PAYLOAD_FILE_URL: payloadFile.getUrl(),
      SUBMISSION_PAYLOAD_SHA256: payloadHash,
      OUTBOX_ID: outboxId,
      OUTBOX_STATUS: destination.ready ? 'PENDING' : 'PENDING_CONFIGURATION',
      OUTBOX_LAST_ERROR: destination.ready ? '' :
        'Koneksi Record Center belum dikonfigurasi.',
      SUBMITTED_AT: timestamp,
      SUBMITTED_BY: user,
      UPDATED_AT: timestamp,
      UPDATED_BY: user
    });
    markTransferProposalBerkasSubmitted_(proposal.USUL_PINDAH_ID, timestamp, user);
    audit_('SUBMIT', 'USUL_PEMINDAHAN', 'USUL_PINDAH', proposal.USUL_PINDAH_ID,
      'Mengajukan ' + proposal.NO_USUL_PINDAH + ' ke Record Center',
      details.length + ' berkas · ' + items.length + ' item · outbox ' + outboxId,
      destination.ready ? 'SUCCESS' : 'WARNING');

    let dispatchResult = {
      ok: true,
      status: destination.ready ? 'PENDING' : 'PENDING_CONFIGURATION',
      message: destination.ready
        ? 'Paket masuk antrean pengiriman Record Center.'
        : 'Paket tersimpan aman dan menunggu koneksi aplikasi Record Center.'
    };
    if (destination.ready) {
      try { dispatchResult = dispatchTransferOutbox_(outboxId); }
      catch (error) {
        dispatchResult = {ok: false, status: 'FAILED', message: error.message};
      }
    }
    const result = {
      ok: true,
      proposalId: proposal.USUL_PINDAH_ID,
      proposalNumber: proposal.NO_USUL_PINDAH,
      status: 'DIAJUKAN',
      notaDinasUrl: notaFile.getUrl(),
      payloadUrl: payloadFile.getUrl(),
      outboxStatus: dispatchResult.status,
      message: proposal.NO_USUL_PINDAH + ' berstatus DIAJUKAN. ' +
        dispatchResult.message
    };
    session.committed = true;
    session.committedAt = timestamp;
    session.commitResult = result;
    saveTransferSubmissionSession_(session);
    return result;
  } catch (error) {
    audit_('SUBMIT', 'USUL_PEMINDAHAN', 'USUL_PINDAH',
      session.proposalId || '', 'Pengajuan usul ke Record Center gagal',
      error.message, 'FAILED');
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function cancelTransferSubmissionUpload_(sessionId) {
  const session = getTransferSubmissionSession_(sessionId);
  if (session.driveFileId && !session.committed) {
    try { DriveApp.getFileById(session.driveFileId).setTrashed(true); }
    catch (ignore) {}
  }
  PropertiesService.getScriptProperties().deleteProperty(
    transferSubmissionPropertyKey_(sessionId));
  return {ok: true};
}

function listDiajukanProposalsForRetry_() {
  ensureTransferSubmissionSchema_();
  return readObjects_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL)
    .filter(row => String(row.STATUS_USUL || '').toUpperCase() === 'DIAJUKAN')
    .map(row => ({
      proposalId: row.USUL_PINDAH_ID,
      number: row.NO_USUL_PINDAH,
      outboxStatus: row.OUTBOX_STATUS,
      lastAttempt: row.OUTBOX_LAST_ATTEMPT_AT,
      lastError: row.OUTBOX_LAST_ERROR
    }));
}

function retryTransferSubmission_(proposalId) {
  ensureTransferSubmissionSchema_();
  const proposal = readObjects_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL)
    .find(row => String(row.USUL_PINDAH_ID || '') === String(proposalId || ''));
  if (!proposal) throw new Error('Pengajuan usul tidak ditemukan.');
  if (String(proposal.STATUS_USUL || '').toUpperCase() !== 'DIAJUKAN') {
    throw new Error('Hanya usul berstatus DIAJUKAN yang dapat dikirim ulang.');
  }
  const outboxId = cleanText_(requireValue_(proposal.OUTBOX_ID, 'ID outbox'), 100);
  const result = dispatchTransferOutbox_(outboxId);
  return {
    ok: result.ok,
    status: result.status,
    message: proposal.NO_USUL_PINDAH + ': ' + result.message
  };
}

function dispatchTransferOutbox_(outboxId) {
  const outboxRows = readObjects_(APP_CONFIG.SHEETS.TRANSFER_OUTBOX);
  const outbox = outboxRows.find(row => String(row.OUTBOX_ID || '') === String(outboxId));
  if (!outbox) throw new Error('Outbox pengajuan tidak ditemukan.');
  if (String(outbox.STATUS_OUTBOX || '').toUpperCase() === 'SENT') {
    return {ok: true, status: 'SENT', message: 'Paket sudah diterima endpoint Record Center.'};
  }
  const settings = readSettings_();
  const destination = transferSubmissionDestination_(settings, {
    recordCenterName: outbox.DESTINATION_NAME,
    recordCenterEmail: outbox.DESTINATION_EMAIL
  });
  const timestamp = nowIso_();
  const attempts = Number(outbox.ATTEMPT_COUNT || 0) + 1;
  if (!destination.ready) {
    updateTransferOutboxStatus_(outbox, 'PENDING_CONFIGURATION', {
      LAST_ATTEMPT_AT: timestamp,
      ATTEMPT_COUNT: attempts,
      LAST_ERROR: 'Endpoint, instance ID, atau shared secret Record Center belum dikonfigurasi.'
    });
    updateTransferProposalOutboxMirror_(outbox.USUL_PINDAH_ID,
      'PENDING_CONFIGURATION', timestamp,
      'Koneksi Record Center belum dikonfigurasi.');
    return {
      ok: true,
      status: 'PENDING_CONFIGURATION',
      message: 'Paket tetap tersimpan dan menunggu konfigurasi aplikasi Record Center.'
    };
  }
  const payloadFile = DriveApp.getFileById(outbox.PAYLOAD_FILE_ID);
  const payloadText = payloadFile.getBlob().getDataAsString('UTF-8');
  const actualHash = transferSubmissionSha256_(payloadText);
  if (actualHash !== String(outbox.PAYLOAD_SHA256 || '')) {
    throw new Error('Integritas paket pengajuan berubah. Pengiriman dihentikan.');
  }
  shareTransferPackageWithRecordCenter_(outbox, payloadText, destination.email);
  const signature = transferSubmissionSignature_(
    outbox.OUTBOX_ID, actualHash, timestamp, destination.secret);
  let response;
  try {
    response = UrlFetchApp.fetch(destination.endpointUrl, {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      payload: JSON.stringify({
        eventId: outbox.OUTBOX_ID,
        eventType: outbox.EVENT_TYPE,
        sourceInstanceId: settings.INSTANCE_ID || '',
        destinationInstanceId: destination.instanceId,
        sentAt: timestamp,
        payloadSha256: actualHash,
        signature: signature,
        payload: JSON.parse(payloadText)
      })
    });
  } catch (error) {
    updateTransferOutboxStatus_(outbox, 'FAILED', {
      LAST_ATTEMPT_AT: timestamp, ATTEMPT_COUNT: attempts,
      LAST_ERROR: cleanText_(error.message, 1000)
    });
    updateTransferProposalOutboxMirror_(outbox.USUL_PINDAH_ID,
      'FAILED', timestamp, error.message);
    throw new Error('Koneksi ke Record Center gagal: ' + error.message);
  }
  const code = response.getResponseCode();
  const body = cleanText_(response.getContentText(), 4000);
  let parsed = {};
  try { parsed = body ? JSON.parse(body) : {}; }
  catch (ignore) {}
  if (code < 200 || code >= 300 || parsed.ok !== true) {
    const message = parsed.message || ('HTTP ' + code + (body ? ': ' + body : ''));
    updateTransferOutboxStatus_(outbox, 'FAILED', {
      LAST_ATTEMPT_AT: timestamp, ATTEMPT_COUNT: attempts,
      RESPONSE_CODE: code, RESPONSE_BODY: body,
      LAST_ERROR: cleanText_(message, 1000)
    });
    updateTransferProposalOutboxMirror_(outbox.USUL_PINDAH_ID,
      'FAILED', timestamp, message);
    throw new Error('Record Center menolak paket teknis: ' + message);
  }
  updateTransferOutboxStatus_(outbox, 'SENT', {
    LAST_ATTEMPT_AT: timestamp, ATTEMPT_COUNT: attempts,
    SENT_AT: timestamp, RESPONSE_CODE: code, RESPONSE_BODY: body,
    LAST_ERROR: ''
  });
  updateTransferProposalOutboxMirror_(outbox.USUL_PINDAH_ID,
    'SENT', timestamp, '');
  audit_('DISPATCH', 'USUL_PEMINDAHAN', 'USUL_PINDAH', outbox.USUL_PINDAH_ID,
    'Paket pengajuan dikirim ke Record Center', outbox.OUTBOX_ID, 'SUCCESS');
  return {ok: true, status: 'SENT', message: 'Paket diterima endpoint Record Center.'};
}

function validateTransferSubmissionRequest_(request) {
  request = request || {};
  const proposalId = cleanText_(requireValue_(request.proposalId, 'ID usul'), 100);
  if (String(request.confirmation || '').trim().toUpperCase() !== 'AJUKAN') {
    throw new Error('Ketik AJUKAN untuk mengonfirmasi pengajuan.');
  }
  const proposal = readObjects_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL)
    .find(row => String(row.USUL_PINDAH_ID || '') === proposalId);
  validateTransferSubmissionProposal_(proposal);
  const fileName = cleanText_(requireValue_(request.fileName, 'Nama Nota Dinas'), 250);
  const fileSize = Number(request.fileSize);
  const mimeType = cleanText_(request.mimeType || 'application/pdf', 100).toLowerCase();
  if (!fileName.toLowerCase().endsWith('.pdf')) {
    throw new Error('Nota Dinas harus berupa PDF.');
  }
  if (['application/pdf', 'application/octet-stream', ''].indexOf(mimeType) === -1) {
    throw new Error('Nota Dinas harus berupa PDF.');
  }
  if (!Number.isInteger(fileSize) || fileSize < 1) {
    throw new Error('Ukuran Nota Dinas tidak valid.');
  }
  if (fileSize >= TRANSFER_SUBMISSION_MAX_FILE_SIZE_) {
    throw new Error('Ukuran Nota Dinas harus kurang dari 10 MB.');
  }
  const outputFolderId = cleanText_(
    requireValue_(proposal.OUTPUT_FOLDER_ID, 'Folder keluaran usul'), 250);
  DriveApp.getFolderById(outputFolderId).getName();
  const settings = readSettings_();
  const recordCenterEmailValue = cleanText_(request.recordCenterEmail, 250) ||
    cleanText_(settings.RECORD_CENTER_EMAIL, 250);
  return {
    proposalId: proposalId,
    fileName: fileName,
    fileSize: fileSize,
    outputFolderId: outputFolderId,
    recordCenterName: cleanText_(request.recordCenterName, 250) ||
      cleanText_(settings.RECORD_CENTER_NAME, 250) ||
      'Record Center Rektorat / Unit Kearsipan I',
    recordCenterEmail: recordCenterEmailValue
      ? normalizeEmail_(recordCenterEmailValue) : ''
  };
}

function validateTransferSubmissionProposal_(proposal) {
  if (!proposal) throw new Error('Draft usul pemindahan tidak ditemukan.');
  if (String(proposal.STATUS_USUL || '').toUpperCase() !== 'DRAFT') {
    throw new Error('Hanya usul berstatus DRAFT yang dapat diajukan.');
  }
  const required = [
    ['DAFTAR_XLSX_FILE_ID', 'Daftar Arsip Usul Pindah XLSX'],
    ['RIWAYAT_JRA_FILE_ID', 'Riwayat JRA'],
    ['DAFTAR_PDF_FILE_ID', 'Daftar Arsip Usul Pindah PDF']
  ];
  required.forEach(entry => {
    const fileId = cleanText_(proposal[entry[0]], 250);
    if (!fileId) throw new Error(entry[1] + ' belum dibuat.');
    try { DriveApp.getFileById(fileId).getName(); }
    catch (error) { throw new Error(entry[1] + ' tidak dapat diakses.'); }
  });
}

function buildTransferSubmissionEnvelope_(proposal, details, items, notaFile,
    settings, session, packageId, outboxId, timestamp, user) {
  return {
    schema: 'UINSA-ARSIP-TRANSFER-PROPOSAL/1.0',
    eventId: outboxId,
    packageId: packageId,
    proposal: {
      id: proposal.USUL_PINDAH_ID || '',
      number: proposal.NO_USUL_PINDAH || '',
      title: proposal.JUDUL_USUL || '',
      status: 'DIAJUKAN',
      notes: proposal.CATATAN || '',
      createdAt: proposal.CREATED_AT || '',
      submittedAt: timestamp,
      submittedBy: user,
      berkasCount: Number(proposal.JUMLAH_BERKAS || details.length || 0),
      itemCount: Number(proposal.JUMLAH_ITEM_SNAPSHOT || items.length || 0)
    },
    source: {
      instanceId: settings.INSTANCE_ID || '',
      unitId: settings.UNIT_ID || proposal.UNIT_ID || '',
      unitName: settings.UNIT_NAME || proposal.UNIT_NAMA_SNAPSHOT || '',
      administratorEmail: settings.UNIT_ADMIN_EMAIL || user,
      applicationRelease: APP_RELEASE.VERSION,
      schemaVersion: APP_RELEASE.SCHEMA_VERSION
    },
    destination: {
      instanceId: settings.RECORD_CENTER_INSTANCE_ID || '',
      name: session.recordCenterName || settings.RECORD_CENTER_NAME || '',
      email: session.recordCenterEmail || settings.RECORD_CENTER_EMAIL || ''
    },
    documents: {
      notaDinas: transferSubmissionFileReference_(notaFile),
      daftarUsulPindahXlsx: transferSubmissionFileReference_(
        DriveApp.getFileById(proposal.DAFTAR_XLSX_FILE_ID)),
      riwayatJra: transferSubmissionFileReference_(
        DriveApp.getFileById(proposal.RIWAYAT_JRA_FILE_ID)),
      daftarUsulPindahPdf: transferSubmissionFileReference_(
        DriveApp.getFileById(proposal.DAFTAR_PDF_FILE_ID))
    },
    berkas: (details || []).map(transferSubmissionDetailPayload_),
    items: (items || []).map(transferSubmissionItemPayload_)
  };
}

function transferSubmissionDetailPayload_(row) {
  const result = {};
  RETENTION_CF04_DETAIL_HEADERS_.forEach(header => {
    if (header === 'STATUS_DETAIL') return;
    result[header] = row[header] === undefined ? '' : row[header];
  });
  return result;
}

function transferSubmissionItemPayload_(row) {
  const result = {};
  RETENTION_CF05_ITEM_HEADERS_.forEach(header => {
    if (header === 'STATUS_SNAPSHOT') return;
    result[header] = row[header] === undefined ? '' : row[header];
  });
  return result;
}

function transferSubmissionFileReference_(file) {
  return {
    fileId: file.getId(),
    fileName: file.getName(),
    fileUrl: file.getUrl(),
    mimeType: file.getMimeType(),
    size: Number(file.getSize() || 0)
  };
}

function transferSubmissionDestination_(settings, session) {
  settings = settings || {};
  session = session || {};
  let secret = String(settings.RECORD_CENTER_SHARED_SECRET || '');
  try {
    secret = String(PropertiesService.getScriptProperties()
      .getProperty('RECORD_CENTER_SHARED_SECRET') || secret);
  } catch (ignore) {}
  const destination = {
    instanceId: cleanText_(settings.RECORD_CENTER_INSTANCE_ID, 150),
    name: cleanText_(session.recordCenterName, 250) ||
      cleanText_(settings.RECORD_CENTER_NAME, 250) ||
      'Record Center Rektorat / Unit Kearsipan I',
    email: cleanText_(session.recordCenterEmail, 250) ||
      cleanText_(settings.RECORD_CENTER_EMAIL, 250),
    endpointUrl: cleanText_(settings.RECORD_CENTER_ENDPOINT_URL, 1000),
    secret: secret
  };
  destination.ready = Boolean(destination.instanceId &&
    destination.endpointUrl && destination.secret);
  return destination;
}

// Update konfigurasi koneksi Record Center TANPA menjalankan ulang seluruh
// installer unit (yang mewajibkan re-entry unitId/unitCode/unitName/dst).
// Hanya menyentuh RECORD_CENTER_* pada Settings + Script Properties secret,
// tidak mengubah data arsip/transaksi apa pun. Dipakai sekali per konfigurasi
// federasi (handoff §19.3 langkah 10), bukan bagian dari alur harian.
function updateRecordCenterConnection_(form) {
  form = form || {};
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const recordCenterName = cleanText_(
      requireValue_(form.recordCenterName, 'Nama Record Center'), 250);
    const recordCenterEmailValue = cleanText_(form.recordCenterEmail, 250);
    const recordCenterEmail = recordCenterEmailValue
      ? normalizeEmail_(recordCenterEmailValue) : '';
    const recordCenterInstanceId = cleanText_(
      requireValue_(form.recordCenterInstanceId, 'Instance ID Record Center'), 150);
    const recordCenterEndpointUrl = cleanText_(form.recordCenterEndpointUrl, 1000);
    if (recordCenterEndpointUrl &&
        !/^https:\/\/script\.google\.com\//i.test(recordCenterEndpointUrl)) {
      throw new Error('Endpoint Record Center harus berupa URL Web App Apps Script.');
    }
    const recordCenterSharedSecret = String(form.recordCenterSharedSecret || '');
    if (recordCenterSharedSecret && recordCenterSharedSecret.length < 32) {
      throw new Error('Shared secret Record Center minimal 32 karakter.');
    }

    upsertReliabilitySettingsBatch_([
      ['RECORD_CENTER_NAME', recordCenterName, 'STRING', 'Tujuan pengajuan usul pemindahan'],
      ['RECORD_CENTER_EMAIL', recordCenterEmail, 'STRING', 'Email aplikasi/petugas Record Center'],
      ['RECORD_CENTER_INSTANCE_ID', recordCenterInstanceId, 'STRING', 'ID instance aplikasi Record Center'],
      ['RECORD_CENTER_ENDPOINT_URL', recordCenterEndpointUrl, 'URL', 'Endpoint federatif aplikasi Record Center']
    ]);
    if (recordCenterSharedSecret) {
      PropertiesService.getScriptProperties()
        .setProperty('RECORD_CENTER_SHARED_SECRET', recordCenterSharedSecret);
    }

    audit_('UPDATE', 'RELIABILITY', 'RECORD_CENTER_CONNECTION', recordCenterInstanceId,
      'Memperbarui konfigurasi koneksi Record Center: ' + recordCenterName +
      (recordCenterSharedSecret ? ' (secret diperbarui)' : ' (secret tidak diubah)'),
      '', 'SUCCESS');

    const health = runReliabilityHealthCheck_(true);
    const connectionCheck = health.checks.find(
      check => check.code === 'RECORD_CENTER_CONNECTION') || {};
    return {
      ok: true,
      recordCenterConnectionStatus: connectionCheck.status || 'UNKNOWN',
      message: 'Konfigurasi Record Center diperbarui. Status RECORD_CENTER_CONNECTION: ' +
        (connectionCheck.status || 'UNKNOWN') + ' — ' + (connectionCheck.detail || '') +
        (recordCenterEndpointUrl ? '' :
          ' (endpoint masih kosong sampai RC-01 dirilis; outbox tetap PENDING_CONFIGURATION, ini normal)')
    };
  } finally {
    lock.releaseLock();
  }
}

function markTransferProposalBerkasSubmitted_(proposalId, timestamp, user) {
  const details = readObjects_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL_DETAIL)
    .filter(row => String(row.USUL_PINDAH_ID || '') === String(proposalId) &&
      String(row.STATUS_DETAIL || 'AKTIF').toUpperCase() !== 'DIBATALKAN');
  const berkasRows = readObjects_(APP_CONFIG.SHEETS.BERKAS);
  const byId = {};
  berkasRows.forEach(row => byId[String(row.BERKAS_ID || '')] = row);
  const updates = [];
  details.forEach(detail => {
    const parent = byId[String(detail.BERKAS_ID || '')];
    if (!parent || String(parent.USUL_PINDAH_ID_AKTIF || '') !== String(proposalId)) return;
    updates.push({
      rowNumber: parent._rowNumber,
      changes: {
        STATUS_RETENSI: 'DIAJUKAN KE RECORD CENTER',
        UPDATED_AT: timestamp,
        UPDATED_BY: user,
        VERSION: Number(parent.VERSION || 0) + 1
      }
    });
  });
  if (updates.length) updateObjectsAtRows_(APP_CONFIG.SHEETS.BERKAS, updates);
}

function queueTransferCancellation_(proposal, reason, timestamp, user) {
  if (!proposal || !proposal.SUBMISSION_PAYLOAD_FILE_ID) return {ok: true};
  ensureTransferSubmissionSchema_();
  const settings = readSettings_();
  const destination = transferSubmissionDestination_(settings, {
    recordCenterName: proposal.RECORD_CENTER_NAME_SNAPSHOT,
    recordCenterEmail: proposal.RECORD_CENTER_EMAIL_SNAPSHOT
  });
  const eventId = 'OUT-' + Utilities.getUuid();
  const payload = JSON.stringify({
    schema: 'UINSA-ARSIP-TRANSFER-CANCELLATION/1.0',
    eventId: eventId,
    proposalId: proposal.USUL_PINDAH_ID || '',
    proposalNumber: proposal.NO_USUL_PINDAH || '',
    reason: reason,
    cancelledAt: timestamp,
    cancelledBy: user,
    sourcePackageId: proposal.SUBMISSION_PACKAGE_ID || ''
  });
  const hash = transferSubmissionSha256_(payload);
  const folder = DriveApp.getFolderById(proposal.OUTPUT_FOLDER_ID);
  const file = folder.createFile(Utilities.newBlob(payload, 'application/json',
    cleanFileName_(proposal.NO_USUL_PINDAH || 'USUL') + '_Pembatalan.json'));
  appendObject_(APP_CONFIG.SHEETS.TRANSFER_OUTBOX, {
    OUTBOX_ID: eventId,
    EVENT_TYPE: 'CANCEL_TRANSFER_PROPOSAL',
    USUL_PINDAH_ID: proposal.USUL_PINDAH_ID,
    NO_USUL_PINDAH: proposal.NO_USUL_PINDAH,
    STATUS_OUTBOX: destination.ready ? 'PENDING' : 'PENDING_CONFIGURATION',
    DESTINATION_INSTANCE_ID: destination.instanceId,
    DESTINATION_NAME: destination.name,
    DESTINATION_EMAIL: destination.email,
    ENDPOINT_URL_SNAPSHOT: destination.endpointUrl,
    PAYLOAD_FILE_ID: file.getId(),
    PAYLOAD_FILE_URL: file.getUrl(),
    PAYLOAD_SHA256: hash,
    CREATED_AT: timestamp,
    CREATED_BY: user,
    ATTEMPT_COUNT: 0,
    UPDATED_AT: timestamp
  });
  if (destination.ready) {
    try { return dispatchTransferOutbox_(eventId); }
    catch (error) { return {ok: false, status: 'FAILED', message: error.message}; }
  }
  return {ok: true, status: 'PENDING_CONFIGURATION'};
}

function shareTransferPackageWithRecordCenter_(outbox, payloadText, email) {
  if (!email) return;
  const payload = JSON.parse(payloadText);
  const documents = payload.documents || {};
  Object.keys(documents).forEach(key => {
    const fileId = documents[key] && documents[key].fileId;
    if (!fileId) return;
    try { DriveApp.getFileById(fileId).addViewer(email); }
    catch (error) {
      throw new Error('Gagal memberi akses ' + key + ' kepada Record Center: ' +
        error.message);
    }
  });
  DriveApp.getFileById(outbox.PAYLOAD_FILE_ID).addViewer(email);
}

function updateTransferOutboxStatus_(outbox, status, changes) {
  changes = changes || {};
  changes.STATUS_OUTBOX = status;
  changes.UPDATED_AT = nowIso_();
  updateObjectAtRow_(APP_CONFIG.SHEETS.TRANSFER_OUTBOX,
    outbox._rowNumber, changes);
}

function updateTransferProposalOutboxMirror_(proposalId, status, timestamp, error) {
  const proposal = readObjects_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL)
    .find(row => String(row.USUL_PINDAH_ID || '') === String(proposalId || ''));
  if (!proposal) return;
  updateObjectAtRow_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL, proposal._rowNumber, {
    OUTBOX_STATUS: status,
    OUTBOX_LAST_ATTEMPT_AT: timestamp,
    OUTBOX_LAST_ERROR: cleanText_(error, 1000),
    UPDATED_AT: timestamp,
    UPDATED_BY: getCurrentUser_()
  });
}

function transferSubmissionSignature_(eventId, hash, timestamp, secret) {
  const bytes = Utilities.computeHmacSha256Signature(
    String(eventId) + '|' + String(hash) + '|' + String(timestamp),
    String(secret), Utilities.Charset.UTF_8);
  return bytes.map(byte => ('0' + ((byte + 256) % 256).toString(16)).slice(-2)).join('');
}

function transferSubmissionSha256_(text) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(text), Utilities.Charset.UTF_8);
  return bytes.map(byte => ('0' + ((byte + 256) % 256).toString(16)).slice(-2)).join('');
}

function transferSubmissionPropertyKey_(sessionId) {
  return TRANSFER_SUBMISSION_UPLOAD_PREFIX_ +
    cleanText_(requireValue_(sessionId, 'ID sesi pengajuan'), 100);
}

function saveTransferSubmissionSession_(session) {
  PropertiesService.getScriptProperties().setProperty(
    transferSubmissionPropertyKey_(session.sessionId), JSON.stringify(session));
}

function getTransferSubmissionSession_(sessionId) {
  const value = PropertiesService.getScriptProperties().getProperty(
    transferSubmissionPropertyKey_(sessionId));
  if (!value) {
    throw new Error('UPLOAD_SESSION_NOT_FOUND: Sesi pengajuan tidak ditemukan. Mulai ulang upload Nota Dinas.');
  }
  const session = JSON.parse(value);
  if (session.userEmail && session.userEmail !== getCurrentUser_()) {
    throw new Error('Sesi pengajuan dibuat oleh pengguna lain.');
  }
  return session;
}

function transferSubmissionProgress_(session) {
  return {
    ok: true,
    sessionId: session.sessionId,
    chunkSize: TRANSFER_SUBMISSION_CHUNK_SIZE_,
    uploadedBytes: Number(session.uploadedBytes || 0),
    fileSize: Number(session.fileSize || 0),
    complete: Boolean(session.driveFileId),
    committed: Boolean(session.committed),
    result: session.commitResult || null
  };
}

function recoverTransferSubmissionResult_(session) {
  const proposal = readObjects_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL)
    .find(row => String(row.USUL_PINDAH_ID || '') === String(session.proposalId || ''));
  if (!proposal || String(proposal.STATUS_USUL || '').toUpperCase() !== 'DIAJUKAN' ||
      String(proposal.NOTA_DINAS_FILE_ID || '') !== String(session.driveFileId || '')) {
    return null;
  }
  return {
    ok: true,
    proposalId: proposal.USUL_PINDAH_ID,
    proposalNumber: proposal.NO_USUL_PINDAH,
    status: proposal.STATUS_USUL,
    notaDinasUrl: proposal.NOTA_DINAS_FILE_URL || '',
    payloadUrl: proposal.SUBMISSION_PAYLOAD_FILE_URL || '',
    outboxStatus: proposal.OUTBOX_STATUS || '',
    message: proposal.NO_USUL_PINDAH + ' sudah berstatus DIAJUKAN. Status dipulihkan tanpa membuat paket ganda.'
  };
}

// --- CF-06.1 — Poll keputusan Record Center (QUERY_DECISION) ---------------
// Lihat docs/ADDENDUM_2026-08-20_PROTOKOL_KEPUTUSAN_RC_CF.md: CF yang
// bertanya ke RC (poll), bukan RC memanggil balik CF (push) — memakai pola
// signed request yang identik dengan dispatchTransferOutbox_ di atas.

var TRANSFER_CF061_PROPOSAL_HEADERS_ = [
  'DECISION_STATUS', 'DECISION_REASON', 'DECISION_AT', 'DECISION_BY',
  'DECISION_SYNCED_AT', 'LAST_QUERY_AT', 'LAST_QUERY_STATUS', 'LAST_QUERY_ERROR'
];

function ensureTransferDecisionSyncSchema_() {
  ensureColumnsOnSheet_(
    APP_CONFIG.SHEETS.TRANSFER_PROPOSAL,
    TRANSFER_CF061_PROPOSAL_HEADERS_,
    [150, 360, 190, 240, 190, 190, 150, 360]
  );
  return {ok: true};
}

function getTransferDecisionSyncHealth_() {
  const sheet = getSpreadsheet_().getSheetByName(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL);
  if (!sheet) return {ok: false, missing: [APP_CONFIG.SHEETS.TRANSFER_PROPOSAL + '.*']};
  const headers = getHeaders_(sheet);
  const missing = TRANSFER_CF061_PROPOSAL_HEADERS_
    .filter(header => headers.indexOf(header) === -1)
    .map(header => APP_CONFIG.SHEETS.TRANSFER_PROPOSAL + '.' + header);
  return {ok: missing.length === 0, missing: missing};
}

// Dipanggil trigger terjadwal (semua usul DIAJUKAN+SENT) maupun tombol
// "Cek Status" manual (satu usul). Tidak melempar untuk kondisi bisnis biasa
// (belum ada keputusan, dsb.) — hanya melempar untuk kegagalan teknis nyata.
function queryTransferDecision_(proposalId) {
  ensureTransferSubmissionSchema_();
  ensureTransferDecisionSyncSchema_();
  const proposal = readObjects_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL)
    .find(row => String(row.USUL_PINDAH_ID || '') === String(proposalId || ''));
  if (!proposal) throw new Error('Pengajuan usul tidak ditemukan.');
  if (String(proposal.STATUS_USUL || '').toUpperCase() !== 'DIAJUKAN') {
    return {ok: true, status: 'TIDAK_PERLU',
      message: proposal.NO_USUL_PINDAH + ' sudah berstatus ' + proposal.STATUS_USUL + ', tidak perlu polling.'};
  }
  if (!proposal.OUTBOX_ID || String(proposal.OUTBOX_STATUS || '').toUpperCase() !== 'SENT') {
    return {ok: true, status: 'BELUM_TERKIRIM',
      message: proposal.NO_USUL_PINDAH + ': paket belum terkonfirmasi terkirim (outbox: ' +
        (proposal.OUTBOX_STATUS || 'kosong') + '). Kirim/kirim ulang dulu sebelum cek keputusan.'};
  }

  const settings = readSettings_();
  const destination = transferSubmissionDestination_(settings, {
    recordCenterName: proposal.RECORD_CENTER_NAME_SNAPSHOT,
    recordCenterEmail: proposal.RECORD_CENTER_EMAIL_SNAPSHOT
  });
  if (!destination.ready) {
    return {ok: true, status: 'BELUM_TERKONFIGURASI',
      message: proposal.NO_USUL_PINDAH + ': koneksi Record Center belum lengkap (endpoint/instance/secret).'};
  }

  const timestamp = nowIso_();
  const eventId = 'QRY-' + Utilities.getUuid();
  const queryPayload = {submitEventId: proposal.OUTBOX_ID};
  const payloadText = JSON.stringify(queryPayload);
  const hash = transferSubmissionSha256_(payloadText);
  const signature = transferSubmissionSignature_(eventId, hash, timestamp, destination.secret);

  let response;
  try {
    response = UrlFetchApp.fetch(destination.endpointUrl, {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true,
      payload: JSON.stringify({
        eventId: eventId,
        eventType: 'QUERY_DECISION',
        sourceInstanceId: settings.INSTANCE_ID || '',
        destinationInstanceId: destination.instanceId,
        sentAt: timestamp,
        payloadSha256: hash,
        signature: signature,
        payload: queryPayload
      })
    });
  } catch (error) {
    updateQueryTrackingFields_(proposal, timestamp, 'ERROR', error.message);
    throw new Error('Gagal menghubungi Record Center: ' + error.message);
  }

  const code = response.getResponseCode();
  const body = cleanText_(response.getContentText(), 4000);
  let parsed = {};
  try { parsed = body ? JSON.parse(body) : {}; } catch (ignore) {}

  if (code < 200 || code >= 300 || parsed.ok !== true) {
    const message = parsed.message || ('HTTP ' + code + (body ? ': ' + body : ''));
    updateQueryTrackingFields_(proposal, timestamp, 'ERROR', message);
    throw new Error('Record Center menolak permintaan status: ' + message);
  }

  updateQueryTrackingFields_(proposal, timestamp, parsed.status || '', '');

  if (!parsed.decisionAvailable) {
    return {ok: true, status: parsed.status || 'MENUNGGU_KEPUTUSAN',
      message: proposal.NO_USUL_PINDAH + ': ' + (parsed.message || 'belum ada keputusan.')};
  }

  return applyTransferDecision_(proposal, parsed, timestamp);
}

function updateQueryTrackingFields_(proposal, timestamp, status, error) {
  try {
    updateObjectAtRow_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL, proposal._rowNumber, {
      LAST_QUERY_AT: timestamp, LAST_QUERY_STATUS: status, LAST_QUERY_ERROR: cleanText_(error, 500)
    });
  } catch (ignore) {
    // Kegagalan mencatat status polling tidak boleh menutupi hasil sesungguhnya.
  }
}

function applyTransferDecision_(proposal, parsed, timestamp) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    // Baca ulang di dalam lock — mencegah menerapkan keputusan dua kali bila
    // trigger otomatis dan klik manual berbenturan (idempoten).
    const fresh = readObjects_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL)
      .find(row => String(row.USUL_PINDAH_ID) === String(proposal.USUL_PINDAH_ID));
    if (!fresh) throw new Error('Usul tidak ditemukan saat menerapkan keputusan.');
    if (String(fresh.STATUS_USUL || '').toUpperCase() !== 'DIAJUKAN') {
      return {ok: true, status: fresh.STATUS_USUL, alreadyApplied: true,
        message: fresh.NO_USUL_PINDAH + ': keputusan sudah diterapkan sebelumnya (' + fresh.STATUS_USUL + ').'};
    }
    const decision = String(parsed.decision || '').toUpperCase();
    if (['DISETUJUI', 'DITOLAK'].indexOf(decision) === -1) {
      throw new Error('Keputusan tidak dikenali dari Record Center: ' + parsed.decision);
    }
    const user = getCurrentUser_();
    updateObjectAtRow_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL, fresh._rowNumber, {
      STATUS_USUL: decision,
      DECISION_STATUS: decision,
      DECISION_REASON: cleanText_(parsed.reason, 1000),
      DECISION_AT: parsed.decidedAt || '',
      DECISION_BY: parsed.decidedBy || '',
      DECISION_SYNCED_AT: timestamp,
      UPDATED_AT: timestamp,
      UPDATED_BY: user
    });

    let releasedCount = 0;
    if (decision === 'DITOLAK') {
      // §12.5/§16.3: berkas pada usul ditolak dilepas agar dapat
      // diperbaiki/diajukan ulang. Berkas disetujui SENGAJA tidak diubah di
      // sini — tetap terkunci sampai diterima fisik/ditata (RC-02+).
      releasedCount = releaseTransferProposalBerkas_(fresh.USUL_PINDAH_ID, timestamp, user);
    }

    audit_(decision === 'DITOLAK' ? 'REJECT_SYNCED' : 'APPROVE_SYNCED',
      'USUL_PEMINDAHAN', 'USUL_PINDAH', fresh.USUL_PINDAH_ID,
      'Keputusan Record Center diterima: ' + decision + ' untuk ' + fresh.NO_USUL_PINDAH,
      cleanText_(parsed.reason, 500) +
        (decision === 'DITOLAK' ? ' | ' + releasedCount + ' berkas dilepas kembali' : ''),
      'SUCCESS');

    return {
      ok: true, status: decision,
      message: fresh.NO_USUL_PINDAH + ' ' + decision + ' oleh Record Center.' +
        (decision === 'DITOLAK'
          ? (parsed.reason ? ' Alasan: ' + parsed.reason + '.' : '') +
            ' ' + releasedCount + ' berkas dilepas kembali menjadi kandidat usul pemindahan.'
          : ' Berkas tetap terkunci dalam proses sampai diterima fisik Record Center.')
    };
  } finally {
    lock.releaseLock();
  }
}

// Sama persis pola pelepasan berkas pada cancelTransferProposalDraft_ di
// RetentionService.js — sengaja ditulis terpisah, bukan refactor fungsi yang
// sudah lulus UAT, supaya perubahan CF-06.1 ini tidak menyentuh perilaku lama.
function releaseTransferProposalBerkas_(proposalId, timestamp, user) {
  const details = readObjects_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL_DETAIL)
    .filter(row => String(row.USUL_PINDAH_ID) === String(proposalId) &&
      String(row.STATUS_DETAIL || 'AKTIF').toUpperCase() !== 'DIBATALKAN');
  const berkasRows = readObjects_(APP_CONFIG.SHEETS.BERKAS);
  const byId = {};
  berkasRows.forEach(row => byId[String(row.BERKAS_ID || '')] = row);
  const updates = [];
  details.forEach(detail => {
    const parent = byId[String(detail.BERKAS_ID || '')];
    if (!parent || String(parent.USUL_PINDAH_ID_AKTIF || '') !== String(proposalId)) return;
    updates.push({
      rowNumber: parent._rowNumber,
      changes: {
        USUL_PINDAH_ID_AKTIF: '',
        USUL_PINDAH_NO_AKTIF: '',
        STATUS_RETENSI: 'HABIS AKTIF – KANDIDAT USUL PINDAH',
        UPDATED_AT: timestamp,
        UPDATED_BY: user,
        VERSION: Number(parent.VERSION || 0) + 1
      }
    });
  });
  if (updates.length) updateObjectsAtRows_(APP_CONFIG.SHEETS.BERKAS, updates);
  return updates.length;
}

function listDiajukanSentProposalsForPoll_() {
  ensureTransferSubmissionSchema_();
  return readObjects_(APP_CONFIG.SHEETS.TRANSFER_PROPOSAL)
    .filter(row => String(row.STATUS_USUL || '').toUpperCase() === 'DIAJUKAN' &&
      String(row.OUTBOX_STATUS || '').toUpperCase() === 'SENT');
}

// Trigger terjadwal (dipasang lewat installTransferDecisionPollTrigger_).
// Satu usul gagal tidak boleh menghentikan usul lain dalam batch yang sama.
function scheduledTransferDecisionPoll() {
  try {
    listDiajukanSentProposalsForPoll_().forEach(row => {
      try {
        queryTransferDecision_(row.USUL_PINDAH_ID);
      } catch (error) {
        audit_('QUERY_DECISION', 'USUL_PEMINDAHAN', 'USUL_PINDAH', row.USUL_PINDAH_ID,
          'Polling keputusan Record Center gagal (' + row.NO_USUL_PINDAH + ')',
          error.message, 'FAILED');
      }
    });
  } catch (error) {
    if (typeof recordReliabilityJobError_ === 'function') {
      recordReliabilityJobError_('TRANSFER_DECISION_POLL', error);
    }
  }
}

function installTransferDecisionPollTrigger_() {
  ScriptApp.getProjectTriggers()
    .filter(trigger => trigger.getHandlerFunction() === 'scheduledTransferDecisionPoll')
    .forEach(trigger => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger('scheduledTransferDecisionPoll').timeBased().everyHours(2).create();
  return {ok: true, message: 'Trigger polling keputusan Record Center aktif (tiap 2 jam).'};
}
