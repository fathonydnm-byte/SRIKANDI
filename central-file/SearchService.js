function searchArchive_(criteria) {
  criteria = criteria || {};
  const query = cleanText_(criteria.query, 250);
  const normalizedQuery = normalizeArchiveSearchText_(query);
  const queryTokens = normalizedQuery ? normalizedQuery.split(' ').filter(Boolean) : [];
  const classification = normalizeArchiveSearchText_(cleanText_(criteria.classification, 80));
  const development = String(criteria.development || 'ALL').toUpperCase();
  const fileStatus = String(criteria.fileStatus || 'ALL').toUpperCase();
  const dateFrom = cleanText_(criteria.dateFrom, 20);
  const dateTo = cleanText_(criteria.dateTo, 20);
  const limit = Math.min(Math.max(Number(criteria.limit) || 200, 1), 300);

  if (dateFrom) parseLocalDate_(dateFrom, 'Tanggal awal');
  if (dateTo) parseLocalDate_(dateTo, 'Tanggal akhir');
  if (dateFrom && dateTo && dateFrom > dateTo) throw new Error('Tanggal awal tidak boleh lebih besar daripada tanggal akhir.');
  if (['ALL', 'ASLI', 'COPY'].indexOf(development) === -1) throw new Error('Filter tingkat perkembangan tidak valid.');
  if (['ALL', 'TERSEDIA', 'BELUM_DIUNGGAH'].indexOf(fileStatus) === -1) throw new Error('Filter status alih media tidak valid.');

  const parents = readObjects_(APP_CONFIG.SHEETS.BERKAS).filter(row => !isDeleted_(row));
  const parentById = {};
  parents.forEach(row => parentById[row.BERKAS_ID] = row);
  const matches = [];

  readObjects_(APP_CONFIG.SHEETS.ITEM).forEach(item => {
    if (isDeleted_(item)) return;
    const parent = parentById[item.BERKAS_ID];
    if (!parent) return;
    const documentDate = item.TANGGAL_NASKAH ? dateKey_(item.TANGGAL_NASKAH) : '';
    if (dateFrom && documentDate < dateFrom) return;
    if (dateTo && documentDate > dateTo) return;

    const itemDevelopment = String(item.TINGKAT_PERKEMBANGAN || '').toUpperCase();
    if (development !== 'ALL' && itemDevelopment !== development) return;
    const hasFile = Boolean(cleanText_(item.DRIVE_FILE_ID, 250));
    if (fileStatus === 'TERSEDIA' && !hasFile) return;
    if (fileStatus === 'BELUM_DIUNGGAH' && hasFile) return;

    const classificationCode = cleanText_(item.KODE_KLASIFIKASI_SNAPSHOT || parent.KODE_KLASIFIKASI_SNAPSHOT, 80);
    if (classification && normalizeArchiveSearchText_(classificationCode).indexOf(classification) === -1) return;

    const location = archiveLocationLabel_(parent);
    const primaryNumber = cleanText_(item.NO_SURAT_UTAMA, 250);
    const alternateNumber = cleanText_(item.NO_SURAT_ALTERNATIF, 250);
    const displayNumber = cleanText_(item.NO_SURAT_DISPLAY || displayLetterNumber_(primaryNumber, alternateNumber), 500);
    const description = cleanText_(item.URAIAN_LENGKAP, 2000);
    const condition = cleanText_(item.KONDISI_FISIK, 100);
    const title = cleanText_(parent.JUDUL_BERKAS, 500);
    const corpus = normalizeArchiveSearchText_([
      primaryNumber, alternateNumber, displayNumber, description, title, classificationCode,
      parent.URAIAN_KLASIFIKASI_SNAPSHOT, location, parent.NO_BERKAS_DEFINITIF,
      item.NO_ITEM_DEFINITIF, item.NAMA_FILE, condition
    ].join(' '));
    if (queryTokens.length && !queryTokens.every(token => corpus.indexOf(token) !== -1)) return;

    const itemLoanStatus = String(item.STATUS_PEMINJAMAN || 'TERSEDIA').toUpperCase();
    const parentLoanStatus = String(parent.STATUS_PEMINJAMAN || 'TERSEDIA').toUpperCase();
    matches.push({
      score: archiveSearchScore_(normalizedQuery, primaryNumber, alternateNumber, displayNumber, title, description, classificationCode),
      berkasId: parent.BERKAS_ID,
      itemId: item.ITEM_ID,
      berkasNumber: parent.NO_BERKAS_DEFINITIF || item.NO_BERKAS_SNAPSHOT || '',
      itemNumber: item.NO_ITEM_DEFINITIF || '',
      title: title,
      letterNumber: displayNumber,
      primaryLetterNumber: primaryNumber,
      alternateLetterNumber: alternateNumber,
      documentDate: documentDate,
      description: description,
      pageCount: Number(item.JUMLAH_HALAMAN || 0),
      developmentLevel: itemDevelopment || '–',
      condition: condition || '',
      classificationCode: classificationCode,
      classificationDescription: cleanText_(parent.URAIAN_KLASIFIKASI_SNAPSHOT, 500),
      location: location,
      fileStatus: hasFile ? 'TERSEDIA' : 'BELUM DIUNGGAH',
      fileUrl: item.DRIVE_FILE_URL || '',
      folderUrl: parent.DRIVE_FOLDER_URL || '',
      loanStatus: itemLoanStatus !== 'TERSEDIA' ? itemLoanStatus : parentLoanStatus
    });
  });

  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const parentCompare = naturalCompare_(a.berkasNumber || '999999', b.berkasNumber || '999999');
    return parentCompare || naturalCompare_(a.itemNumber || '999999', b.itemNumber || '999999');
  });
  return {
    ok: true,
    query: query,
    totalMatches: matches.length,
    returnedCount: Math.min(matches.length, limit),
    truncated: matches.length > limit,
    results: matches.slice(0, limit)
  };
}

function normalizeArchiveSearchText_(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function archiveSearchScore_(query, primary, alternate, display, title, description, classification) {
  if (!query) return 0;
  const primaryKey = normalizeArchiveSearchText_(primary);
  const alternateKey = normalizeArchiveSearchText_(alternate);
  const displayKey = normalizeArchiveSearchText_(display);
  if (query === primaryKey || query === alternateKey || query === displayKey) return 1000;
  if (primaryKey.indexOf(query) === 0 || alternateKey.indexOf(query) === 0) return 800;
  if (primaryKey.indexOf(query) !== -1 || alternateKey.indexOf(query) !== -1 || displayKey.indexOf(query) !== -1) return 600;
  if (normalizeArchiveSearchText_(title).indexOf(query) !== -1) return 300;
  if (normalizeArchiveSearchText_(classification).indexOf(query) !== -1) return 200;
  if (normalizeArchiveSearchText_(description).indexOf(query) !== -1) return 100;
  return 10;
}

function archiveLocationLabel_(parent) {
  const parts = [];
  if (cleanText_(parent.NO_FILLING_KABINET, 100)) parts.push('Kabinet ' + cleanText_(parent.NO_FILLING_KABINET, 100));
  if (cleanText_(parent.NO_LACI, 100)) parts.push('Laci ' + cleanText_(parent.NO_LACI, 100));
  const folder = parent.NO_FOLDER || parent.NO_BERKAS_DEFINITIF;
  if (folder !== '' && folder !== null && folder !== undefined) parts.push('Folder ' + folder);
  return parts.join(' · ') || 'Lokasi belum diisi';
}
