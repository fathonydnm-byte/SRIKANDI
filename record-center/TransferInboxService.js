// RC-01 — Endpoint federatif + penerimaan usul pindah.
// Kolom snapshot berkas/item SENGAJA mengikuti persis
// RETENTION_CF04_DETAIL_HEADERS_/RETENTION_CF05_ITEM_HEADERS_ pada
// central-file/RetentionService.js (minus kolom status internal CF) supaya
// data yang diterima tidak perlu dipetakan ulang. Lihat
// docs/ADDENDUM_2026-08-20_PROTOKOL_KEPUTUSAN_RC_CF.md untuk kontrak
// QUERY_DECISION dan alasan model poll (bukan push).

var RC_INBOX_EVENT_HEADERS_ = [
  'EVENT_ID', 'EVENT_TYPE', 'SOURCE_INSTANCE_ID', 'DESTINATION_INSTANCE_ID',
  'SENT_AT', 'RECEIVED_AT', 'SIGNATURE_VALID', 'RESULT_STATUS',
  'RESULT_MESSAGE', 'RC_PROPOSAL_ID', 'RAW_ENVELOPE_FILE_ID'
];

var RC_PROPOSAL_HEADERS_ = [
  'RC_PROPOSAL_ID', 'SOURCE_INSTANCE_ID', 'SOURCE_UNIT_NAME',
  'CF_PROPOSAL_ID', 'CF_PROPOSAL_NUMBER', 'CF_PACKAGE_ID', 'SUBMIT_EVENT_ID',
  'JUDUL_USUL', 'CATATAN', 'BERKAS_COUNT', 'ITEM_COUNT',
  'SUBMITTED_AT', 'SUBMITTED_BY', 'RECEIVED_AT', 'STATUS_PROPOSAL',
  'DECISION_AT', 'DECISION_BY', 'DECISION_REASON',
  'CANCELLED_AT', 'CANCELLED_BY', 'CANCEL_REASON', 'CANCEL_EVENT_ID',
  'NOTA_DINAS_FILE_ID', 'NOTA_DINAS_FILE_URL',
  'DAFTAR_XLSX_FILE_ID', 'DAFTAR_XLSX_FILE_URL',
  'RIWAYAT_JRA_FILE_ID', 'RIWAYAT_JRA_FILE_URL',
  'DAFTAR_PDF_FILE_ID', 'DAFTAR_PDF_FILE_URL',
  'RAW_ENVELOPE_FILE_ID', 'RC_FOLDER_ID', 'RC_FOLDER_URL',
  'CREATED_AT', 'UPDATED_AT'
];

// Identik dengan RETENTION_CF04_DETAIL_HEADERS_ di CF, minus STATUS_DETAIL
// (status internal CF, tidak relevan setelah jadi snapshot di RC).
var RC_PROPOSAL_BERKAS_SNAPSHOT_HEADERS_ = [
  'USUL_DETAIL_ID', 'USUL_PINDAH_ID', 'NO_USUL_PINDAH',
  'BERKAS_ID', 'NO_BERKAS_DEFINITIF', 'PENCIPTA_ARSIP_SNAPSHOT',
  'UNIT_PENCIPTA_ID', 'UNIT_PENCIPTA_SNAPSHOT', 'KODE_KLASIFIKASI_SNAPSHOT',
  'JUDUL_BERKAS_SNAPSHOT', 'KURUN_WAKTU_SNAPSHOT', 'JUMLAH_ITEM_SNAPSHOT',
  'MEDIA_BERKAS_SNAPSHOT', 'LOKASI_ASAL_CF_SNAPSHOT',
  'KLASIFIKASI_KEAMANAN_SNAPSHOT',
  'KATEGORI_ARSIP_SNAPSHOT', 'RETENSI_AKTIF_NILAI_SNAPSHOT',
  'RETENSI_AKTIF_SATUAN_SNAPSHOT', 'RETENSI_INAKTIF_NILAI_SNAPSHOT',
  'RETENSI_INAKTIF_SATUAN_SNAPSHOT', 'NASIB_AKHIR_SNAPSHOT',
  'TGL_ACUAN_RETENSI_SNAPSHOT', 'BATAS_AKTIF_SNAPSHOT',
  'JRA_ID_SNAPSHOT', 'JRA_DASAR_HUKUM_SNAPSHOT', 'JRA_VERSI_SNAPSHOT',
  'SNAPSHOT_AT', 'SNAPSHOT_BY'
];
var RC_PROPOSAL_BERKAS_HEADERS_ = ['RC_PROPOSAL_ID'].concat(RC_PROPOSAL_BERKAS_SNAPSHOT_HEADERS_);

// Identik dengan RETENTION_CF05_ITEM_HEADERS_ di CF, minus STATUS_SNAPSHOT.
var RC_PROPOSAL_ITEM_SNAPSHOT_HEADERS_ = [
  'USUL_ITEM_ID', 'USUL_PINDAH_ID', 'NO_USUL_PINDAH', 'USUL_DETAIL_ID',
  'BERKAS_ID', 'NO_BERKAS_DEFINITIF', 'ITEM_ID', 'NO_ITEM_DEFINITIF',
  'NO_SURAT_UTAMA_SNAPSHOT', 'NO_SURAT_ALTERNATIF_SNAPSHOT',
  'NO_SURAT_DISPLAY_SNAPSHOT', 'TANGGAL_NASKAH_SNAPSHOT',
  'URAIAN_ITEM_SNAPSHOT', 'JUMLAH_HALAMAN_SNAPSHOT',
  'TINGKAT_PERKEMBANGAN_SNAPSHOT', 'KLASIFIKASI_KEAMANAN_SNAPSHOT',
  'MEDIA_SUMBER_SNAPSHOT', 'STATUS_BENTUK_DIGITAL_SNAPSHOT',
  'ALIH_MEDIA_FILE_ID_SNAPSHOT', 'ALIH_MEDIA_FILE_URL_SNAPSHOT',
  'SNAPSHOT_AT', 'SNAPSHOT_BY'
];
var RC_PROPOSAL_ITEM_HEADERS_ = ['RC_PROPOSAL_ID'].concat(RC_PROPOSAL_ITEM_SNAPSHOT_HEADERS_);

var RC_DECISION_OUTBOX_HEADERS_ = [
  'DECISION_ID', 'RC_PROPOSAL_ID', 'CF_PROPOSAL_ID', 'CF_PROPOSAL_NUMBER',
  'SUBMIT_EVENT_ID', 'SOURCE_INSTANCE_ID', 'DECISION', 'REASON',
  'DECIDED_AT', 'DECIDED_BY', 'STATUS', 'ACK_AT', 'CREATED_AT'
];

function ensureTransferInboxSchema_() {
  ensureSystemSheet_(RC_CONFIG.SHEETS.INBOX_EVENTS, RC_INBOX_EVENT_HEADERS_,
    [200, 220, 200, 200, 190, 190, 130, 130, 360, 200, 220]);
  ensureSystemSheet_(RC_CONFIG.SHEETS.TRANSFER_PROPOSAL, RC_PROPOSAL_HEADERS_,
    [200, 200, 250, 190, 150, 200, 200, 300, 300, 110, 110, 190, 240, 190, 140,
      190, 240, 300, 190, 240, 300, 200, 220, 260, 220, 260, 220, 260, 220, 260,
      220, 220, 260, 190, 190]);
  ensureSystemSheet_(RC_CONFIG.SHEETS.TRANSFER_PROPOSAL_BERKAS, RC_PROPOSAL_BERKAS_HEADERS_);
  ensureSystemSheet_(RC_CONFIG.SHEETS.TRANSFER_PROPOSAL_ITEM, RC_PROPOSAL_ITEM_HEADERS_);
  ensureSystemSheet_(RC_CONFIG.SHEETS.DECISION_OUTBOX, RC_DECISION_OUTBOX_HEADERS_,
    [200, 200, 190, 150, 200, 200, 130, 300, 190, 240, 150, 190, 190]);
  return true;
}

// --- Verifikasi envelope federatif (§12.3) ---------------------------------

function verifyInboundEnvelope_(body) {
  body = body || {};
  const eventId = cleanText_(requireValue_(body.eventId, 'eventId'), 150);
  const eventType = cleanText_(requireValue_(body.eventType, 'eventType'), 100);
  const sourceInstanceId = cleanText_(requireValue_(body.sourceInstanceId, 'sourceInstanceId'), 150);
  const destinationInstanceId = cleanText_(
    requireValue_(body.destinationInstanceId, 'destinationInstanceId'), 150);
  const sentAt = cleanText_(requireValue_(body.sentAt, 'sentAt'), 60);
  const payloadSha256 = cleanText_(requireValue_(body.payloadSha256, 'payloadSha256'), 128);
  const signature = cleanText_(requireValue_(body.signature, 'signature'), 256);
  if (body.payload === undefined || body.payload === null) {
    throw new Error('payload wajib disertakan.');
  }

  const settings = readSettings_();
  const ownInstanceId = cleanText_(settings.RC_INSTANCE_ID, 150);
  if (!ownInstanceId) throw new Error('Instance Record Center belum terpasang.');
  if (destinationInstanceId !== ownInstanceId) {
    throw new Error('destinationInstanceId tidak cocok dengan instance Record Center ini.');
  }

  if (!isSourceActive_(sourceInstanceId)) {
    throw new Error('Sumber tidak terdaftar aktif: ' + sourceInstanceId);
  }
  const secret = getSourceSecret_(sourceInstanceId);
  if (!secret) throw new Error('Shared secret sumber belum dikonfigurasi.');

  const sentAtMs = new Date(sentAt).getTime();
  if (!sentAtMs || isNaN(sentAtMs)) throw new Error('sentAt tidak valid.');
  const ageMs = Date.now() - sentAtMs;
  // Baseline §12.3: tolak event >24 jam. Toleransi -5 menit untuk selisih jam
  // server yang wajar; lebih maju dari itu dianggap mencurigakan.
  if (ageMs > RC_CONFIG.MAX_EVENT_AGE_MS || ageMs < -5 * 60 * 1000) {
    throw new Error('Event kedaluwarsa atau waktu tidak valid (usia ' +
      Math.round(ageMs / 60000) + ' menit).');
  }

  const expectedSignature = rcHmacSignature_(eventId, payloadSha256, sentAt, secret);
  if (!rcConstantTimeEquals_(expectedSignature, signature)) {
    throw new Error('Signature tidak valid.');
  }

  // Signature hanya menutupi payloadSha256 (klaim), bukan payload itu sendiri
  // — pengecekan ini yang mencegah payload ditukar tanpa mengubah signature.
  const recomputedHash = rcSha256_(JSON.stringify(body.payload));
  if (!rcConstantTimeEquals_(recomputedHash, payloadSha256)) {
    throw new Error('Hash payload tidak cocok — integritas paket tidak dapat diverifikasi.');
  }

  return {
    eventId: eventId, eventType: eventType, sourceInstanceId: sourceInstanceId,
    destinationInstanceId: destinationInstanceId, sentAt: sentAt,
    payloadSha256: payloadSha256, payload: body.payload
  };
}

function findInboxEventById_(eventId) {
  if (!eventId) return null;
  const rows = readObjects_(RC_CONFIG.SHEETS.INBOX_EVENTS);
  return rows.find(row => String(row.EVENT_ID) === String(eventId)) || null;
}

function logInboxEvent_(rawBody, result) {
  rawBody = rawBody || {};
  result = result || {};
  try {
    appendObject_(RC_CONFIG.SHEETS.INBOX_EVENTS, {
      EVENT_ID: cleanText_(rawBody.eventId, 150),
      EVENT_TYPE: cleanText_(rawBody.eventType, 100),
      SOURCE_INSTANCE_ID: cleanText_(rawBody.sourceInstanceId, 150),
      DESTINATION_INSTANCE_ID: cleanText_(rawBody.destinationInstanceId, 150),
      SENT_AT: cleanText_(rawBody.sentAt, 60),
      RECEIVED_AT: nowIso_(),
      SIGNATURE_VALID: Boolean(result.signatureValid),
      RESULT_STATUS: result.status || 'ERROR',
      RESULT_MESSAGE: cleanText_(result.message, 1000),
      RC_PROPOSAL_ID: result.rcProposalId || '',
      RAW_ENVELOPE_FILE_ID: result.rawEnvelopeFileId || ''
    });
  } catch (ignore) {
    // Jangan sampai kegagalan mencatat log menutupi respons asli ke pemanggil.
  }
}

// --- SUBMIT_TRANSFER_PROPOSAL ----------------------------------------------

function handleSubmitTransferProposal_(rawBody) {
  ensureTransferInboxSchema_();
  const existing = findInboxEventById_(rawBody && rawBody.eventId);
  if (existing && existing.RESULT_STATUS === 'ACCEPTED') {
    return {
      ok: true, duplicate: true,
      rcProposalId: existing.RC_PROPOSAL_ID,
      message: 'Event sudah diproses sebelumnya (idempoten).'
    };
  }

  let envelope;
  try {
    envelope = verifyInboundEnvelope_(rawBody);
  } catch (error) {
    logInboxEvent_(rawBody, {status: 'REJECTED', message: error.message, signatureValid: false});
    throw error;
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const payload = envelope.payload;
    const proposal = payload.proposal || {};
    const source = payload.source || {};
    const documents = payload.documents || {};
    const berkasList = payload.berkas || [];
    const itemList = payload.items || [];

    if (!proposal.id || !proposal.number) {
      throw new Error('Payload usul tidak lengkap (id/number kosong).');
    }
    ['notaDinas', 'daftarUsulPindahXlsx', 'riwayatJra'].forEach(key => {
      if (!documents[key] || !documents[key].fileId) {
        throw new Error('Dokumen wajib hilang pada payload: ' + key);
      }
    });

    const timestamp = nowIso_();
    const rcProposalId = 'RCUP-' + Utilities.getUuid();
    const settings = readSettings_();
    const rootFolder = DriveApp.getFolderById(
      requireValue_(settings.TRANSFER_INBOX_FOLDER_ID, 'TRANSFER_INBOX_FOLDER_ID'));
    const folderName = cleanFileName_(
      proposal.number + '_' + (source.unitName || envelope.sourceInstanceId));
    const proposalFolder = rootFolder.createFolder(folderName);

    const notaDinasCopy = copyDocumentFromSource_(documents.notaDinas, proposalFolder, 'Nota-Dinas');
    const xlsxCopy = copyDocumentFromSource_(documents.daftarUsulPindahXlsx, proposalFolder, 'Daftar-Usul-Pindah');
    const jraCopy = copyDocumentFromSource_(documents.riwayatJra, proposalFolder, 'Riwayat-JRA');
    const pdfCopy = copyDocumentFromSource_(documents.daftarUsulPindahPdf, proposalFolder, 'Daftar-Usul-Pindah-PDF');

    const rawEnvelopeFile = proposalFolder.createFile(
      Utilities.newBlob(JSON.stringify(rawBody), 'application/json',
        cleanFileName_(proposal.number) + '_Envelope-Diterima.json'));

    appendObject_(RC_CONFIG.SHEETS.TRANSFER_PROPOSAL, {
      RC_PROPOSAL_ID: rcProposalId,
      SOURCE_INSTANCE_ID: envelope.sourceInstanceId,
      SOURCE_UNIT_NAME: source.unitName || '',
      CF_PROPOSAL_ID: proposal.id,
      CF_PROPOSAL_NUMBER: proposal.number,
      CF_PACKAGE_ID: payload.packageId || '',
      SUBMIT_EVENT_ID: envelope.eventId,
      JUDUL_USUL: proposal.title || '',
      CATATAN: proposal.notes || '',
      BERKAS_COUNT: berkasList.length,
      ITEM_COUNT: itemList.length,
      SUBMITTED_AT: proposal.submittedAt || '',
      SUBMITTED_BY: proposal.submittedBy || '',
      RECEIVED_AT: timestamp,
      STATUS_PROPOSAL: 'DITERIMA',
      DECISION_AT: '', DECISION_BY: '', DECISION_REASON: '',
      CANCELLED_AT: '', CANCELLED_BY: '', CANCEL_REASON: '', CANCEL_EVENT_ID: '',
      NOTA_DINAS_FILE_ID: notaDinasCopy.fileId, NOTA_DINAS_FILE_URL: notaDinasCopy.fileUrl,
      DAFTAR_XLSX_FILE_ID: xlsxCopy.fileId, DAFTAR_XLSX_FILE_URL: xlsxCopy.fileUrl,
      RIWAYAT_JRA_FILE_ID: jraCopy.fileId, RIWAYAT_JRA_FILE_URL: jraCopy.fileUrl,
      DAFTAR_PDF_FILE_ID: pdfCopy.fileId, DAFTAR_PDF_FILE_URL: pdfCopy.fileUrl,
      RAW_ENVELOPE_FILE_ID: rawEnvelopeFile.getId(),
      RC_FOLDER_ID: proposalFolder.getId(), RC_FOLDER_URL: proposalFolder.getUrl(),
      CREATED_AT: timestamp, UPDATED_AT: timestamp
    });

    if (berkasList.length) {
      appendObjects_(RC_CONFIG.SHEETS.TRANSFER_PROPOSAL_BERKAS,
        berkasList.map(row => buildProposalChildRow_(
          rcProposalId, row, RC_PROPOSAL_BERKAS_SNAPSHOT_HEADERS_)));
    }
    if (itemList.length) {
      appendObjects_(RC_CONFIG.SHEETS.TRANSFER_PROPOSAL_ITEM,
        itemList.map(row => buildProposalChildRow_(
          rcProposalId, row, RC_PROPOSAL_ITEM_SNAPSHOT_HEADERS_)));
    }

    logInboxEvent_(rawBody, {
      status: 'ACCEPTED', message: 'Usul ' + proposal.number + ' diterima.',
      signatureValid: true, rcProposalId: rcProposalId,
      rawEnvelopeFileId: rawEnvelopeFile.getId()
    });
    audit_('RECEIVE', 'TRANSFER_INBOX', 'PROPOSAL', rcProposalId,
      'Menerima usul pindah ' + proposal.number + ' dari ' + envelope.sourceInstanceId,
      berkasList.length + ' berkas, ' + itemList.length + ' item, event ' + envelope.eventId,
      'SUCCESS');

    return {
      ok: true, rcProposalId: rcProposalId,
      message: 'Usul ' + proposal.number + ' diterima dan tersimpan di Record Center.'
    };
  } catch (error) {
    logInboxEvent_(rawBody, {status: 'ERROR', message: error.message, signatureValid: true});
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function buildProposalChildRow_(rcProposalId, sourceRow, headers) {
  sourceRow = sourceRow || {};
  const record = {RC_PROPOSAL_ID: rcProposalId};
  headers.forEach(header => {
    record[header] = sourceRow[header] === undefined ? '' : sourceRow[header];
  });
  return record;
}

function copyDocumentFromSource_(fileRef, targetFolder, labelPrefix) {
  if (!fileRef || !fileRef.fileId) return {fileId: '', fileUrl: ''};
  try {
    const source = DriveApp.getFileById(fileRef.fileId);
    const copy = source.makeCopy(
      cleanFileName_(labelPrefix + '_' + (fileRef.fileName || source.getName())), targetFolder);
    return {fileId: copy.getId(), fileUrl: copy.getUrl()};
  } catch (error) {
    throw new Error('Gagal menyalin dokumen ' + labelPrefix + ' ke Drive Record Center: ' +
      error.message + ' (pastikan Central File sudah membagikan file ini ke email admin RC)');
  }
}

// --- CANCEL_TRANSFER_PROPOSAL -----------------------------------------------

function handleCancelTransferProposal_(rawBody) {
  ensureTransferInboxSchema_();
  const existing = findInboxEventById_(rawBody && rawBody.eventId);
  if (existing && existing.RESULT_STATUS === 'ACCEPTED') {
    return {ok: true, duplicate: true, message: 'Event pembatalan sudah diproses sebelumnya (idempoten).'};
  }

  let envelope;
  try {
    envelope = verifyInboundEnvelope_(rawBody);
  } catch (error) {
    logInboxEvent_(rawBody, {status: 'REJECTED', message: error.message, signatureValid: false});
    throw error;
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const payload = envelope.payload;
    const cfProposalId = cleanText_(payload.proposalId, 150);
    if (!cfProposalId) throw new Error('proposalId wajib pada payload pembatalan.');

    const rows = readObjects_(RC_CONFIG.SHEETS.TRANSFER_PROPOSAL);
    const target = rows.find(row =>
      String(row.CF_PROPOSAL_ID) === cfProposalId &&
      String(row.SOURCE_INSTANCE_ID) === envelope.sourceInstanceId);
    if (!target) {
      throw new Error('Usul dengan proposalId ' + cfProposalId +
        ' dari sumber ini tidak ditemukan di Record Center.');
    }
    const status = String(target.STATUS_PROPOSAL || '').toUpperCase();
    if (status === 'DIBATALKAN') {
      logInboxEvent_(rawBody, {status: 'ACCEPTED', message: 'Sudah dibatalkan sebelumnya.',
        signatureValid: true, rcProposalId: target.RC_PROPOSAL_ID});
      return {ok: true, duplicate: true, message: 'Usul sudah berstatus DIBATALKAN.'};
    }
    if (status === 'DITOLAK') {
      throw new Error('Usul sudah berstatus DITOLAK, tidak perlu/tidak bisa dibatalkan.');
    }
    // DITERIMA atau DISETUJUI boleh dibatalkan CF selama belum diterima fisik
    // (§16.3) — status DITERIMA RECORD CENTER baru ada di RC-02.
    const timestamp = nowIso_();
    updateObjectAtRow_(RC_CONFIG.SHEETS.TRANSFER_PROPOSAL, target._rowNumber, {
      STATUS_PROPOSAL: 'DIBATALKAN',
      CANCELLED_AT: timestamp,
      CANCELLED_BY: payload.cancelledBy || envelope.sourceInstanceId,
      CANCEL_REASON: cleanText_(payload.reason, 1000),
      CANCEL_EVENT_ID: envelope.eventId,
      UPDATED_AT: timestamp
    });

    logInboxEvent_(rawBody, {status: 'ACCEPTED', message: 'Usul dibatalkan.',
      signatureValid: true, rcProposalId: target.RC_PROPOSAL_ID});
    audit_('CANCEL', 'TRANSFER_INBOX', 'PROPOSAL', target.RC_PROPOSAL_ID,
      'Membatalkan usul pindah ' + target.CF_PROPOSAL_NUMBER +
      ' atas permintaan ' + envelope.sourceInstanceId,
      cleanText_(payload.reason, 500), 'SUCCESS');

    return {ok: true, message: 'Usul ' + target.CF_PROPOSAL_NUMBER + ' dibatalkan.'};
  } catch (error) {
    logInboxEvent_(rawBody, {status: 'ERROR', message: error.message, signatureValid: true});
    throw error;
  } finally {
    lock.releaseLock();
  }
}

// --- QUERY_DECISION (protokol poll — lihat addendum) ------------------------

function handleQueryDecision_(rawBody) {
  ensureTransferInboxSchema_();
  let envelope;
  try {
    envelope = verifyInboundEnvelope_(rawBody);
  } catch (error) {
    logInboxEvent_(rawBody, {status: 'REJECTED', message: error.message, signatureValid: false});
    throw error;
  }

  const submitEventId = cleanText_((envelope.payload || {}).submitEventId, 150);
  if (!submitEventId) throw new Error('submitEventId wajib pada payload QUERY_DECISION.');

  const proposals = readObjects_(RC_CONFIG.SHEETS.TRANSFER_PROPOSAL);
  const target = proposals.find(row =>
    String(row.SUBMIT_EVENT_ID) === submitEventId &&
    String(row.SOURCE_INSTANCE_ID) === envelope.sourceInstanceId);

  if (!target) {
    logInboxEvent_(rawBody, {status: 'ACCEPTED', message: 'Belum ditemukan.', signatureValid: true});
    return {ok: true, decisionAvailable: false, status: 'BELUM_DITEMUKAN',
      message: 'Usul dengan event ini belum diterima Record Center.'};
  }

  const status = String(target.STATUS_PROPOSAL || '').toUpperCase();
  if (status === 'DITERIMA') {
    logInboxEvent_(rawBody, {status: 'ACCEPTED', message: 'Menunggu keputusan.',
      signatureValid: true, rcProposalId: target.RC_PROPOSAL_ID});
    return {ok: true, decisionAvailable: false, status: 'MENUNGGU_KEPUTUSAN',
      message: 'Usul sudah diterima Record Center, menunggu keputusan petugas.'};
  }
  if (status === 'DIBATALKAN') {
    logInboxEvent_(rawBody, {status: 'ACCEPTED', message: 'Sudah dibatalkan.',
      signatureValid: true, rcProposalId: target.RC_PROPOSAL_ID});
    return {ok: true, decisionAvailable: false, status: 'DIBATALKAN',
      message: 'Usul berstatus dibatalkan, tidak ada keputusan untuk diambil.'};
  }

  // DISETUJUI atau DITOLAK — tandai terkirim (idempoten, aman dipanggil ulang).
  const outboxRows = readObjects_(RC_CONFIG.SHEETS.DECISION_OUTBOX);
  const decisionRow = outboxRows.find(row => String(row.SUBMIT_EVENT_ID) === submitEventId);
  if (decisionRow && String(decisionRow.STATUS) !== 'ACKNOWLEDGED') {
    updateObjectAtRow_(RC_CONFIG.SHEETS.DECISION_OUTBOX, decisionRow._rowNumber, {
      STATUS: 'ACKNOWLEDGED', ACK_AT: nowIso_()
    });
  }
  logInboxEvent_(rawBody, {status: 'ACCEPTED', message: 'Keputusan dikirim: ' + status,
    signatureValid: true, rcProposalId: target.RC_PROPOSAL_ID});
  return {
    ok: true, decisionAvailable: true, status: status, decision: status,
    reason: target.DECISION_REASON || '',
    decidedAt: target.DECISION_AT || '', decidedBy: target.DECISION_BY || ''
  };
}

// --- Keputusan petugas RC ---------------------------------------------------

function approveProposal_(rcProposalId) {
  requireRecordCenterAdmin_();
  rcProposalId = cleanText_(requireValue_(rcProposalId, 'ID usul'), 150);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const target = findProposalOrThrow_(rcProposalId);
    if (String(target.STATUS_PROPOSAL).toUpperCase() !== 'DITERIMA') {
      throw new Error('Hanya usul berstatus DITERIMA yang dapat diputuskan. Status saat ini: ' +
        target.STATUS_PROPOSAL);
    }
    const timestamp = nowIso_();
    const user = getCurrentUser_();
    updateObjectAtRow_(RC_CONFIG.SHEETS.TRANSFER_PROPOSAL, target._rowNumber, {
      STATUS_PROPOSAL: 'DISETUJUI', DECISION_AT: timestamp, DECISION_BY: user,
      DECISION_REASON: '', UPDATED_AT: timestamp
    });
    appendDecisionOutbox_(target, 'DISETUJUI', '', timestamp, user);
    audit_('APPROVE', 'TRANSFER_INBOX', 'PROPOSAL', target.RC_PROPOSAL_ID,
      'Menyetujui usul pindah ' + target.CF_PROPOSAL_NUMBER, '', 'SUCCESS');
    return {ok: true, message: target.CF_PROPOSAL_NUMBER +
      ' disetujui. Keputusan menunggu diambil Central File saat polling berikutnya.'};
  } finally {
    lock.releaseLock();
  }
}

function rejectProposal_(rcProposalId, reason) {
  requireRecordCenterAdmin_();
  rcProposalId = cleanText_(requireValue_(rcProposalId, 'ID usul'), 150);
  reason = cleanText_(requireValue_(reason, 'Alasan penolakan'), 1000);
  if (reason.length < 10) throw new Error('Alasan penolakan minimal 10 karakter.');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const target = findProposalOrThrow_(rcProposalId);
    if (String(target.STATUS_PROPOSAL).toUpperCase() !== 'DITERIMA') {
      throw new Error('Hanya usul berstatus DITERIMA yang dapat diputuskan. Status saat ini: ' +
        target.STATUS_PROPOSAL);
    }
    const timestamp = nowIso_();
    const user = getCurrentUser_();
    updateObjectAtRow_(RC_CONFIG.SHEETS.TRANSFER_PROPOSAL, target._rowNumber, {
      STATUS_PROPOSAL: 'DITOLAK', DECISION_AT: timestamp, DECISION_BY: user,
      DECISION_REASON: reason, UPDATED_AT: timestamp
    });
    appendDecisionOutbox_(target, 'DITOLAK', reason, timestamp, user);
    audit_('REJECT', 'TRANSFER_INBOX', 'PROPOSAL', target.RC_PROPOSAL_ID,
      'Menolak usul pindah ' + target.CF_PROPOSAL_NUMBER, reason, 'SUCCESS');
    return {ok: true, message: target.CF_PROPOSAL_NUMBER +
      ' ditolak. Keputusan menunggu diambil Central File saat polling berikutnya.'};
  } finally {
    lock.releaseLock();
  }
}

function findProposalOrThrow_(rcProposalId) {
  const rows = readObjects_(RC_CONFIG.SHEETS.TRANSFER_PROPOSAL);
  const target = rows.find(row => String(row.RC_PROPOSAL_ID) === String(rcProposalId));
  if (!target) throw new Error('Usul tidak ditemukan: ' + rcProposalId);
  return target;
}

function appendDecisionOutbox_(target, decision, reason, timestamp, user) {
  appendObject_(RC_CONFIG.SHEETS.DECISION_OUTBOX, {
    DECISION_ID: 'DEC-' + Utilities.getUuid(),
    RC_PROPOSAL_ID: target.RC_PROPOSAL_ID,
    CF_PROPOSAL_ID: target.CF_PROPOSAL_ID,
    CF_PROPOSAL_NUMBER: target.CF_PROPOSAL_NUMBER,
    SUBMIT_EVENT_ID: target.SUBMIT_EVENT_ID,
    SOURCE_INSTANCE_ID: target.SOURCE_INSTANCE_ID,
    DECISION: decision, REASON: reason,
    DECIDED_AT: timestamp, DECIDED_BY: user,
    STATUS: 'PENDING_DELIVERY', ACK_AT: '', CREATED_AT: timestamp
  });
}

function listPendingProposals_() {
  ensureTransferInboxSchema_();
  return readObjects_(RC_CONFIG.SHEETS.TRANSFER_PROPOSAL)
    .filter(row => String(row.STATUS_PROPOSAL).toUpperCase() === 'DITERIMA')
    .sort((a, b) => String(a.RECEIVED_AT).localeCompare(String(b.RECEIVED_AT)));
}

function listAllProposals_() {
  ensureTransferInboxSchema_();
  return readObjects_(RC_CONFIG.SHEETS.TRANSFER_PROPOSAL)
    .sort((a, b) => String(b.RECEIVED_AT).localeCompare(String(a.RECEIVED_AT)));
}

function getTransferInboxHealth_() {
  const spreadsheet = getSpreadsheet_();
  const requirements = [
    [RC_CONFIG.SHEETS.INBOX_EVENTS, RC_INBOX_EVENT_HEADERS_],
    [RC_CONFIG.SHEETS.TRANSFER_PROPOSAL, RC_PROPOSAL_HEADERS_],
    [RC_CONFIG.SHEETS.TRANSFER_PROPOSAL_BERKAS, RC_PROPOSAL_BERKAS_HEADERS_],
    [RC_CONFIG.SHEETS.TRANSFER_PROPOSAL_ITEM, RC_PROPOSAL_ITEM_HEADERS_],
    [RC_CONFIG.SHEETS.DECISION_OUTBOX, RC_DECISION_OUTBOX_HEADERS_]
  ];
  const missing = [];
  requirements.forEach(entry => {
    const sheet = spreadsheet.getSheetByName(entry[0]);
    if (!sheet) { missing.push(entry[0] + '.*'); return; }
    const headers = getHeaders_(sheet);
    entry[1].forEach(header => {
      if (headers.indexOf(header) === -1) missing.push(entry[0] + '.' + header);
    });
  });
  return {ok: missing.length === 0, missing: missing};
}
