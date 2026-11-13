// Read an .xlsx workbook into header-keyed rows. Row 1 is the header row (as
// in the legacy app). Header lookup is by name (trimmed, upper-cased), never by
// position. Fully blank rows are skipped (blank trailing rows are common).
import ExcelJS from 'exceljs';

/** ExcelJS cell value -> null | string | number | boolean | Date | {error}. */
export function rawValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value !== 'object') return value;
  if ('error' in value) return { error: value.error };
  if ('richText' in value) return value.richText.map((r) => r.text).join('');
  if ('formula' in value || 'sharedFormula' in value) return rawValue(value.result ?? null);
  if ('hyperlink' in value) {
    const text = typeof value.text === 'string' ? value.text
      : value.text && value.text.richText ? value.text.richText.map((r) => r.text).join('') : '';
    return text || value.hyperlink;
  }
  if ('text' in value) return String(value.text);
  return String(value);
}

export const normalizeHeader = (h) => String(h ?? '').trim().toUpperCase();

/**
 * @returns {Promise<Map<string, {name, headers: string[], duplicateHeaders: string[], rows: {rowNumber:number, values: Object<string, any>}[]}>>}
 */
export async function readWorkbook(file, { matrixSheets = [] } = {}) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const sheets = new Map();
  wb.eachSheet((ws) => {
    if (matrixSheets.includes(ws.name)) {
      // Layout-based report sheets: keep raw rows (0-based columns), no header row.
      const matrix = [];
      ws.eachRow({ includeEmpty: false }, (row) => {
        const cells = [];
        for (let c = 1; c <= ws.actualColumnCount; c++) cells.push(rawValue(row.getCell(c).value));
        matrix.push(cells);
      });
      sheets.set(ws.name, { name: ws.name, headers: [], duplicateHeaders: [], rows: [], matrix });
      return;
    }
    const headerRow = ws.getRow(1);
    const columns = []; // {index, name}
    const seen = new Set();
    const duplicateHeaders = [];
    const lastCol = Math.max(ws.actualColumnCount, headerRow.cellCount);
    for (let c = 1; c <= lastCol; c++) {
      const name = normalizeHeader(rawValue(headerRow.getCell(c).value));
      if (!name) continue;
      if (seen.has(name)) { duplicateHeaders.push(name); continue; }
      seen.add(name);
      columns.push({ index: c, name });
    }
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      const values = {};
      let any = false;
      for (const col of columns) {
        const v = rawValue(row.getCell(col.index).value);
        if (!(v === null || (typeof v === 'string' && v.trim() === ''))) any = true;
        values[col.name] = v;
      }
      if (any) rows.push({ rowNumber, values });
    });
    sheets.set(ws.name, { name: ws.name, headers: columns.map((c) => c.name), duplicateHeaders, rows });
  });
  return sheets;
}
