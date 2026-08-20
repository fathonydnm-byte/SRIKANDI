function classificationSegments_(code) {
  const parts = String(code || '').split('.');
  return [parts[0] || '', parts[1] || '', parts[2] ? (parts[1] + '.' + parts[2]) : ''];
}

function itemReportSecurityClassification_(item, parent) {
  item = item || {};
  parent = parent || {};
  return centralFileMetadataNormalizeSecurity_(
    item.KLASIFIKASI_KEAMANAN_AKSES ||
      parent.KLASIFIKASI_KEAMANAN_AKSES ||
      'BIASA/TERBUKA'
  );
}

var BERKAS_REPORT_LAYOUT_PROPERTY_ = 'BERKAS_REPORT_LAYOUT_V1';

function ensureBerkasReportTotalPagesColumn_(forceRepair) {
  const properties = PropertiesService.getScriptProperties();
  if (!forceRepair) {
    const cached = properties.getProperty(BERKAS_REPORT_LAYOUT_PROPERTY_);
    if (cached) {
      try {
        const layout = JSON.parse(cached);
        if (layout.headerRow && layout.numberRow && layout.dataStartRow && layout.itemCountColumn && layout.totalPagesColumn) return layout;
      } catch (ignore) {}
    }
  }
  const sheet = getSheetOrThrow_(APP_CONFIG.SHEETS.REPORT_BERKAS);
  const scanRowCount = Math.min(sheet.getMaxRows(), 20);
  const scanColumnCount = Math.max(sheet.getLastColumn(), 8);
  const values = sheet.getRange(1, 1, scanRowCount, scanColumnCount).getDisplayValues();
  let headerRow = 0;
  let itemCountColumn = 0;

  values.some((row, rowIndex) => row.some((value, columnIndex) => {
    const header = cleanText_(value).toUpperCase();
    if (header.includes('JUMLAH') && header.includes('ITEM') && header.includes('ARSIP')) {
      headerRow = rowIndex + 1;
      itemCountColumn = columnIndex + 1;
      return true;
    }
    return false;
  }));
  if (!headerRow || !itemCountColumn) throw new Error('Header Jumlah (Item Arsip) pada DAFTAR BERKAS tidak ditemukan.');

  const numberRow = sheet.getFrozenRows() || 12;
  const dataStartRow = numberRow + 1;
  const targetColumn = itemCountColumn + 1;
  const nextHeader = cleanText_(sheet.getRange(headerRow, targetColumn).getDisplayValue()).toUpperCase();
  const totalPagesAlreadyExists = nextHeader.includes('JUMLAH') && (nextHeader.includes('LEMBAR') || nextHeader.includes('HALAMAN'));
  if (!totalPagesAlreadyExists) {
    sheet.insertColumnAfter(itemCountColumn);
    sheet.getRange(headerRow, itemCountColumn, sheet.getMaxRows() - headerRow + 1, 1)
      .copyFormatToRange(sheet, targetColumn, targetColumn, headerRow, sheet.getMaxRows());
  }

  const itemNumber = Number(sheet.getRange(numberRow, itemCountColumn).getValue()) || itemCountColumn;
  sheet.getRange(headerRow, targetColumn).setValue('Jumlah (Lembar)');
  sheet.getRange(numberRow, targetColumn).setValue(itemNumber + 1);
  sheet.getRange(numberRow, targetColumn + 1).setValue(itemNumber + 2);
  const layout = {headerRow, numberRow, dataStartRow, itemCountColumn, totalPagesColumn: targetColumn};
  properties.setProperty(BERKAS_REPORT_LAYOUT_PROPERTY_, JSON.stringify(layout));
  return layout;
}

function rebuildReports_(options) {
  options = options || {};
  const berkasLayout = ensureBerkasReportTotalPagesColumn_(Boolean(options.forceLayoutRepair));
  const berkas = readObjects_(APP_CONFIG.SHEETS.BERKAS).filter(row =>
    !isDeleted_(row) &&
    row.NO_BERKAS_DEFINITIF !== '' &&
    String(row.STATUS_PEMINDAHAN || '').toUpperCase() !== 'SUDAH DIPINDAHKAN'
  );
  const activeBerkasIds = {};
  berkas.forEach(row => activeBerkasIds[row.BERKAS_ID] = true);
  const items = readObjects_(APP_CONFIG.SHEETS.ITEM).filter(row =>
    !isDeleted_(row) &&
    row.NO_ITEM_DEFINITIF !== '' &&
    activeBerkasIds[row.BERKAS_ID]
  );
  berkas.sort((a, b) => Number(a.NO_BERKAS_DEFINITIF) - Number(b.NO_BERKAS_DEFINITIF));
  items.sort((a, b) => Number(a.NO_BERKAS_SNAPSHOT) - Number(b.NO_BERKAS_SNAPSHOT) || Number(a.NO_ITEM_DEFINITIF) - Number(b.NO_ITEM_DEFINITIF));
  const berkasById = {};
  berkas.forEach(row => berkasById[row.BERKAS_ID] = row);
  const itemStatsByBerkas = {};
  items.forEach(row => {
    if (!itemStatsByBerkas[row.BERKAS_ID]) itemStatsByBerkas[row.BERKAS_ID] = {count: 0, pages: 0};
    itemStatsByBerkas[row.BERKAS_ID].count += 1;
    itemStatsByBerkas[row.BERKAS_ID].pages += Number(row.JUMLAH_HALAMAN || 0);
  });

  const berkasRows = berkas.map(row => {
    const code = classificationSegments_(row.KODE_KLASIFIKASI_SNAPSHOT);
    const stats = itemStatsByBerkas[row.BERKAS_ID] || {count: 0, pages: 0};
    return [row.NO_BERKAS_DEFINITIF, code[0], code[1], code[2], row.JUDUL_BERKAS, row.KURUN_WAKTU, stats.count, stats.pages, row.STATUS_RETENSI];
  });
  const itemRows = items.map(row => {
    const parent = berkasById[row.BERKAS_ID] || {};
    const code = classificationSegments_(row.KODE_KLASIFIKASI_SNAPSHOT);
    return [
      row.NO_BERKAS_SNAPSHOT, row.NO_ITEM_DEFINITIF, row.NO_SURAT_DISPLAY, code[0], code[1], code[2],
      row.URAIAN_LENGKAP, String(row.TAHUN_KURUN_WAKTU || ''), row.JUMLAH_HALAMAN, row.TANGGAL_NASKAH,
      row.TINGKAT_PERKEMBANGAN, parent.NO_FILLING_KABINET || '', parent.NO_LACI || '', row.NO_BERKAS_SNAPSHOT,
      itemReportSecurityClassification_(row, parent), '', '', parent.BATAS_AKTIF || '',
      parent.STATUS_RETENSI || '', row.DRIVE_FILE_URL || ''
    ];
  });
  replaceReportRows_(APP_CONFIG.SHEETS.REPORT_BERKAS, berkasLayout.dataStartRow, 9, berkasRows);
  replaceReportRows_(APP_CONFIG.SHEETS.REPORT_ITEM, 13, 20, itemRows);
  const itemSheet = getSheetOrThrow_(APP_CONFIG.SHEETS.REPORT_ITEM);
  const berkasSheet = getSheetOrThrow_(APP_CONFIG.SHEETS.REPORT_BERKAS);
  if (berkasRows.length) berkasSheet.getRange(berkasLayout.dataStartRow, berkasLayout.itemCountColumn, berkasRows.length, 2).setNumberFormat('0');
  if (itemRows.length) {
    itemSheet.getRange(13, 8, itemRows.length, 1).setNumberFormat('@');
    itemSheet.getRange(13, 10, itemRows.length, 1).setNumberFormat('dd mmmm yyyy');
    itemSheet.getRange(13, 18, itemRows.length, 1).setNumberFormat('dd mmmm yyyy');
  }
  return {berkasCount: berkasRows.length, itemCount: itemRows.length, berkasLayout};
}
