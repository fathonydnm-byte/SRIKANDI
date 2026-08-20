function isDeleted_(row) {
  return row.IS_DELETED === true || String(row.IS_DELETED).toUpperCase() === 'TRUE';
}

function parseLocalDate_(value, label) {
  if (value instanceof Date && !isNaN(value)) return new Date(value.getFullYear(), value.getMonth(), value.getDate(), 12);
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error((label || 'Tanggal') + ' tidak valid.');
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) {
    throw new Error((label || 'Tanggal') + ' tidak valid.');
  }
  return date;
}

function dateKey_(value) {
  if (typeof value === 'number' && isFinite(value)) {
    const serialDay = Math.floor(value);
    const date = new Date(Date.UTC(1899, 11, 30) + serialDay * 86400000);
    return [
      date.getUTCFullYear(),
      String(date.getUTCMonth() + 1).padStart(2, '0'),
      String(date.getUTCDate()).padStart(2, '0')
    ].join('-');
  }
  const date = value instanceof Date ? value : parseLocalDate_(String(value).substring(0, 10), 'Tanggal');
  return Utilities.formatDate(date, APP_CONFIG.TIME_ZONE, 'yyyy-MM-dd');
}

function naturalCompare_(a, b) {
  return String(a || '').localeCompare(String(b || ''), 'id', {numeric: true, sensitivity: 'base'});
}

function normalizedLetterNumber_(primary, alternate) {
  const value = cleanText_(primary || alternate || '', 250).toUpperCase();
  return value.replace(/[^A-Z0-9]+/g, ' ').trim() || 'ZZZZZZ';
}

function normalizeItemPayload_(payload) {
  payload = payload || {};
  const pages = positiveInteger_(requireValue_(payload.pageCount, 'Jumlah halaman'), 'Jumlah halaman');
  if (pages < 1) throw new Error('Jumlah halaman minimal 1.');
  const development = String(requireValue_(payload.developmentLevel, 'Tingkat perkembangan')).toUpperCase();
  if (!['ASLI', 'COPY'].includes(development)) throw new Error('Tingkat perkembangan harus ASLI atau COPY.');
  const securityClassification = validateArchiveSecurityClassification_(
    payload.securityClassification,
    'Klasifikasi keamanan dan akses arsip');
  return {
    itemId: cleanText_(requireValue_(payload.itemId, 'ID item'), 80),
    previewCreatedAt: cleanText_(requireValue_(payload.previewCreatedAt, 'Waktu input'), 50),
    berkasId: cleanText_(requireValue_(payload.berkasId, 'Berkas induk'), 80),
    primaryLetterNumber: cleanText_(payload.primaryLetterNumber, 250),
    alternateLetterNumber: cleanText_(payload.alternateLetterNumber, 250),
    documentDate: dateKey_(parseLocalDate_(requireValue_(payload.documentDate, 'Tanggal naskah'), 'Tanggal naskah')),
    description: cleanText_(requireValue_(payload.description, 'Uraian informasi arsip'), 2000),
    pageCount: pages,
    developmentLevel: development,
    securityClassification: securityClassification,
    notes: cleanText_(payload.notes, 1000)
  };
}

function getBerkasOptions_() {
  return readObjects_(APP_CONFIG.SHEETS.BERKAS)
    .filter(row => !isDeleted_(row) && String(row.STATUS_PEMINDAHAN || '').toUpperCase() !== 'SUDAH DIPINDAHKAN')
    .sort((a, b) => naturalCompare_(a.NO_BERKAS_DEFINITIF || '999999', b.NO_BERKAS_DEFINITIF || '999999'))
    .map(row => ({
      id: row.BERKAS_ID,
      number: row.NO_BERKAS_DEFINITIF || '',
      title: row.JUDUL_BERKAS,
      classificationCode: row.KODE_KLASIFIKASI_SNAPSHOT,
      securityClassification: centralFileMetadataNormalizeSecurity_(
        row.KLASIFIKASI_KEAMANAN_AKSES),
      label: (row.NO_BERKAS_DEFINITIF ? row.NO_BERKAS_DEFINITIF + ' – ' : 'DRAFT – ') + row.JUDUL_BERKAS
    }));
}

function buildNumberingPlan_(candidate, virtualParent) {
  return buildBatchNumberingPlan_(
    [candidate],
    virtualParent,
    readObjects_(APP_CONFIG.SHEETS.BERKAS),
    readObjects_(APP_CONFIG.SHEETS.ITEM)
  );
}

function buildBatchNumberingPlan_(candidates, virtualParent, berkasRows, itemRows) {
  candidates = candidates || [];
  if (!candidates.length) throw new Error('Minimal satu item wajib dipilih.');
  if (candidates.length > 100) {
    throw new Error('Satu transaksi maksimal memuat 100 item arsip.');
  }
  const berkas = (berkasRows || [])
    .filter(row => !isDeleted_(row))
    .map(row => Object.assign({}, row));
  const items = (itemRows || [])
    .filter(row => !isDeleted_(row))
    .map(row => Object.assign({}, row));
  if (virtualParent) {
    if (berkas.some(row => row.BERKAS_ID === virtualParent.berkasId)) throw new Error('ID berkas baru sudah digunakan. Ulangi penyimpanan.');
    berkas.push({
      BERKAS_ID: virtualParent.berkasId,
      JUDUL_BERKAS: virtualParent.title,
      KATEGORI_NASKAH_ID: '', POLA_PEMBERKASAN: '',
      KLASIFIKASI_ID: virtualParent.classificationId,
      KODE_KLASIFIKASI_SNAPSHOT: virtualParent.classificationCode,
      URAIAN_KLASIFIKASI_SNAPSHOT: virtualParent.classificationDescription,
      RETENSI_AKTIF_NILAI: virtualParent.activeRetentionValue,
      RETENSI_AKTIF_SATUAN: virtualParent.activeRetentionUnit,
      RETENSI_INAKTIF_NILAI: virtualParent.inactiveRetentionValue,
      RETENSI_INAKTIF_SATUAN: virtualParent.inactiveRetentionUnit,
      NASIB_AKHIR: virtualParent.finalDisposition,
      KLASIFIKASI_KEAMANAN_AKSES:
        virtualParent.securityClassification || 'BIASA/TERBUKA',
      NO_FILLING_KABINET: virtualParent.filingCabinet,
      NO_LACI: virtualParent.drawer,
      CATATAN: virtualParent.notes,
      CREATED_AT: virtualParent.createdAt,
      VERSION: 0, IS_DELETED: false, _virtual: true
    });
  }
  const targetBerkasIds = {};
  candidates.forEach(candidate => {
    if (!candidate || !candidate.itemId) throw new Error('Identitas item tidak valid.');
    if (targetBerkasIds[candidate.itemId]) {
      throw new Error('Item yang sama dipilih lebih dari satu kali.');
    }
    targetBerkasIds[candidate.itemId] = true;
  });
  const targetBerkasId = String(candidates[0].berkasId || '');
  if (!candidates.every(candidate =>
      String(candidate.berkasId || '') === targetBerkasId)) {
    throw new Error('Semua item dalam satu transaksi harus menuju berkas yang sama.');
  }
  const parent = berkas.find(row => row.BERKAS_ID === targetBerkasId);
  if (!parent) throw new Error('Berkas induk tidak ditemukan.');
  if (String(parent.STATUS_PEMINDAHAN || '').toUpperCase() === 'SUDAH DIPINDAHKAN') {
    throw new Error('Berkas sudah dipindahkan ke arsip inaktif dan tidak dapat menerima item baru.');
  }
  const duplicate = candidates.find(candidate =>
    items.some(row => String(row.ITEM_ID) === String(candidate.itemId)));
  if (duplicate) throw new Error('Item ' + duplicate.itemId + ' sudah pernah disimpan.');

  const simulated = items.concat(candidates.map(candidate => ({
    ITEM_ID: candidate.itemId,
    BERKAS_ID: candidate.berkasId,
    TANGGAL_NASKAH: candidate.documentDate,
    NO_SURAT_UTAMA: candidate.primaryLetterNumber,
    NO_SURAT_ALTERNATIF: candidate.alternateLetterNumber,
    URAIAN_LENGKAP: candidate.description,
    JUMLAH_HALAMAN: candidate.pageCount,
    TINGKAT_PERKEMBANGAN: candidate.developmentLevel,
    KLASIFIKASI_KEAMANAN_AKSES: candidate.securityClassification,
    SORT_CREATED_AT: candidate.previewCreatedAt,
    CREATED_AT: candidate.previewCreatedAt,
    NO_ITEM_DEFINITIF: '',
    _candidate: true,
    _candidatePayload: candidate
  })));
  const itemsByParent = {};
  simulated.forEach(item => {
    if (!itemsByParent[item.BERKAS_ID]) itemsByParent[item.BERKAS_ID] = [];
    itemsByParent[item.BERKAS_ID].push(item);
  });

  const parentPlans = berkas.filter(row => (itemsByParent[row.BERKAS_ID] || []).length).map(row => {
    const sortedItems = itemsByParent[row.BERKAS_ID].slice().sort((a, b) => {
      const dateCompare = dateKey_(a.TANGGAL_NASKAH).localeCompare(dateKey_(b.TANGGAL_NASKAH));
      if (dateCompare) return dateCompare;
      const numberCompare = naturalCompare_(normalizedLetterNumber_(a.NO_SURAT_UTAMA, a.NO_SURAT_ALTERNATIF), normalizedLetterNumber_(b.NO_SURAT_UTAMA, b.NO_SURAT_ALTERNATIF));
      if (numberCompare) return numberCompare;
      return naturalCompare_(a.SORT_CREATED_AT || a.CREATED_AT || a.ITEM_ID, b.SORT_CREATED_AT || b.CREATED_AT || b.ITEM_ID);
    });
    return {
      record: row,
      earliest: dateKey_(sortedItems[0].TANGGAL_NASKAH),
      latest: dateKey_(sortedItems[sortedItems.length - 1].TANGGAL_NASKAH),
      items: sortedItems
    };
  });

  parentPlans.sort((a, b) => {
    const dateCompare = a.earliest.localeCompare(b.earliest);
    if (dateCompare) return dateCompare;
    const oldA = Number(a.record.NO_BERKAS_DEFINITIF) || Number.MAX_SAFE_INTEGER;
    const oldB = Number(b.record.NO_BERKAS_DEFINITIF) || Number.MAX_SAFE_INTEGER;
    if (oldA !== oldB) return oldA - oldB;
    return naturalCompare_(a.record.CREATED_AT || a.record.BERKAS_ID, b.record.CREATED_AT || b.record.BERKAS_ID);
  });

  const parentChanges = [];
  const itemChanges = [];
  parentPlans.forEach((plan, parentIndex) => {
    plan.newNumber = parentIndex + 1;
    if (String(plan.record.NO_BERKAS_DEFINITIF || '') !== String(plan.newNumber)) {
      parentChanges.push({id: plan.record.BERKAS_ID, title: plan.record.JUDUL_BERKAS, oldNumber: plan.record.NO_BERKAS_DEFINITIF || '–', newNumber: plan.newNumber});
    }
    plan.items.forEach((item, itemIndex) => {
      item._newNumber = itemIndex + 1;
      item._newParentNumber = plan.newNumber;
      if (item._candidate || String(item.NO_ITEM_DEFINITIF || '') !== String(item._newNumber) || String(item.NO_BERKAS_SNAPSHOT || '') !== String(plan.newNumber)) {
        itemChanges.push({
          id: item.ITEM_ID,
          description: item._candidate && item._candidatePayload
            ? item._candidatePayload.description : item.URAIAN_LENGKAP,
          oldNumber: item.NO_ITEM_DEFINITIF || '–',
          newNumber: item._newNumber,
          parentNumber: plan.newNumber,
          isNew: !!item._candidate
        });
      }
    });
  });

  return {
    candidate: candidates[0],
    candidates: candidates,
    affectedBerkasIds: [targetBerkasId],
    parentPlans,
    parentChanges,
    itemChanges
  };
}

function buildReindexPlan_(affectedBerkasIds, reason) {
  const affected = affectedBerkasIds || [];
  const berkas = readObjects_(APP_CONFIG.SHEETS.BERKAS).filter(row => !isDeleted_(row));
  const items = readObjects_(APP_CONFIG.SHEETS.ITEM).filter(row => !isDeleted_(row));
  const itemsByParent = {};
  items.forEach(item => {
    if (!itemsByParent[item.BERKAS_ID]) itemsByParent[item.BERKAS_ID] = [];
    itemsByParent[item.BERKAS_ID].push(item);
  });

  const parentPlans = berkas.filter(row => (itemsByParent[row.BERKAS_ID] || []).length).map(row => {
    const sortedItems = itemsByParent[row.BERKAS_ID].slice().sort((a, b) => {
      const dateCompare = dateKey_(a.TANGGAL_NASKAH).localeCompare(dateKey_(b.TANGGAL_NASKAH));
      if (dateCompare) return dateCompare;
      const numberCompare = naturalCompare_(normalizedLetterNumber_(a.NO_SURAT_UTAMA, a.NO_SURAT_ALTERNATIF), normalizedLetterNumber_(b.NO_SURAT_UTAMA, b.NO_SURAT_ALTERNATIF));
      if (numberCompare) return numberCompare;
      return naturalCompare_(a.SORT_CREATED_AT || a.CREATED_AT || a.ITEM_ID, b.SORT_CREATED_AT || b.CREATED_AT || b.ITEM_ID);
    });
    return {
      record: row,
      earliest: dateKey_(sortedItems[0].TANGGAL_NASKAH),
      latest: dateKey_(sortedItems[sortedItems.length - 1].TANGGAL_NASKAH),
      items: sortedItems
    };
  });

  parentPlans.sort((a, b) => {
    const dateCompare = a.earliest.localeCompare(b.earliest);
    if (dateCompare) return dateCompare;
    const oldA = Number(a.record.NO_BERKAS_DEFINITIF) || Number.MAX_SAFE_INTEGER;
    const oldB = Number(b.record.NO_BERKAS_DEFINITIF) || Number.MAX_SAFE_INTEGER;
    if (oldA !== oldB) return oldA - oldB;
    return naturalCompare_(a.record.CREATED_AT || a.record.BERKAS_ID, b.record.CREATED_AT || b.record.BERKAS_ID);
  });

  parentPlans.forEach((plan, parentIndex) => {
    plan.newNumber = parentIndex + 1;
    plan.items.forEach((item, itemIndex) => {
      item._newNumber = itemIndex + 1;
      item._newParentNumber = plan.newNumber;
    });
  });
  return {candidate: null, affectedBerkasIds: affected, parentPlans, historyReason: reason || 'Penomoran ulang setelah perubahan data'};
}
