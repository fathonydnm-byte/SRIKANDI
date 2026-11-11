// Read-only reference lookup. Archive retention values are still entered manually.
var JRA_REFERENCE_ = Object.freeze({
  spreadsheetId: '1aTE2WDOwMpWlH50cl739ZKMCl4AACW54R6_OmF_d2e0',
  sheetName: 'Jadwal Retensi', sheetId: 917043056, maxRows: 10000, pageSize: 10
});
var JRA_REFERENCE_HEADERS_ = [
  'Bagian', 'NO', 'JENIS ARSIP', 'AKTIF', 'INAKTIF', 'KETERANGAN',
  'Retensi dalam sel gabungan Word', 'Tabel sumber', 'Baris sumber'
];

function normalizeJraLookup_(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

function apiSearchJraReference(request) {
  request = request || {};
  const query = String(request.query || '').trim();
  if (query.length < 2 || query.length > 120) throw new Error('Masukkan kata kunci JRA sepanjang 2–120 karakter.');
  const offset = request.offset === undefined ? 0 : Number(request.offset);
  if (!Number.isInteger(offset) || offset < 0) throw new Error('Posisi hasil JRA tidak valid. Tekan Cari JRA kembali.');
  // Load only when searched, not during application bootstrap; one bounded values read.
  let values;
  try {
    const source = SpreadsheetApp.openById(JRA_REFERENCE_.spreadsheetId);
    const sheet = source.getSheetByName(JRA_REFERENCE_.sheetName);
    if (!sheet) throw new Error('Tab Jadwal Retensi tidak ditemukan.');
    const last = sheet.getLastRow();
    if (last > JRA_REFERENCE_.maxRows) throw new Error('Sumber melebihi batas 10.000 baris.');
    values = sheet.getRange(1, 1, Math.max(1, last), 9).getDisplayValues();
  } catch (error) {
    throw new Error('Sumber JRA belum dapat dibaca. Periksa akses akun aplikasi ke spreadsheet rujukan dan coba lagi. ' + String(error.message || '').slice(0, 200));
  }
  if (!JRA_REFERENCE_HEADERS_.every((name, i) => String(values[0][i] || '').trim() === name)) {
    throw new Error('Susunan kolom sumber JRA berubah. Periksa tabel rujukan sebelum mencari kembali.');
  }
  return searchJraReferenceRows_(values, query, offset, String(request.snapshot || ''));
}

function searchJraReferenceRows_(values, query, offset, previousSnapshot) {
  const snapshot = Utilities.base64EncodeWebSafe(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, JSON.stringify(values)));
  if (offset > 0 && (!previousSnapshot || previousSnapshot !== snapshot)) {
    throw new Error('Data JRA berubah sejak pencarian dimulai. Tekan Cari JRA untuk memuat hasil terbaru.');
  }
  const tokens = normalizeJraLookup_(query).split(' ').filter(Boolean);
  const matches = [];
  values.slice(1).forEach((row, index) => {
    if (!String(row[2] || '').trim()) return;
    const corpus = normalizeJraLookup_(row.slice(0, 7).join(' '));
    if (tokens.every(token => corpus.includes(token))) matches.push({
      row: index + 2, section: String(row[0] || ''), number: String(row[1] || ''),
      description: String(row[2] || ''), active: String(row[3] || ''),
      inactive: String(row[4] || ''), disposition: String(row[5] || ''),
      mergedRetention: String(row[6] || ''),
      sourceUrl: 'https://docs.google.com/spreadsheets/d/' + JRA_REFERENCE_.spreadsheetId +
        '/edit#gid=' + JRA_REFERENCE_.sheetId + '&range=A' + (index + 2) + ':I' + (index + 2)
    });
  });
  if (offset > matches.length) throw new Error('Posisi hasil JRA tidak valid. Tekan Cari JRA kembali.');
  const end = Math.min(offset + JRA_REFERENCE_.pageSize, matches.length);
  return {query: query, results: matches.slice(offset, end), total: matches.length,
    nextOffset: end < matches.length ? end : null, snapshot: snapshot,
    sourceUrl: 'https://docs.google.com/spreadsheets/d/' + JRA_REFERENCE_.spreadsheetId +
      '/edit#gid=' + JRA_REFERENCE_.sheetId,
    checkedAt: Utilities.formatDate(new Date(), APP_CONFIG.TIME_ZONE, 'dd/MM/yyyy HH:mm:ss')};
}
