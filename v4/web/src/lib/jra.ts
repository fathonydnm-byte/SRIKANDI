export const JRA_SOURCE_ID = '1aTE2WDOwMpWlH50cl739ZKMCl4AACW54R6_OmF_d2e0';
export const JRA_GID = '917043056';
export const JRA_SOURCE_URL = `https://docs.google.com/spreadsheets/d/${JRA_SOURCE_ID}/edit#gid=${JRA_GID}`;
export const JRA_HEADERS = [
  'Bagian', 'NO', 'JENIS ARSIP', 'AKTIF', 'INAKTIF', 'KETERANGAN',
  'Retensi dalam sel gabungan Word', 'Tabel sumber', 'Baris sumber',
];
export interface JraRow {
  row: number;
  section: string;
  number: string;
  description: string;
  active: string;
  inactive: string;
  disposition: string;
  mergedRetention: string;
  sourceUrl: string;
}
export interface JraResult {
  query: string;
  results: JraRow[];
  total: number;
  nextOffset: number | null;
  snapshot: string;
  sourceUrl: string;
  checkedAt: string;
}
export const normalizeJra = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/\s+/g, ' ').trim().toLowerCase();

/** Bounded RFC4180-style CSV reader; quoted newlines are retained, never split into fake rows. */
export function parseJraCsv(csv: string): string[][] {
  if (!csv || csv.length > 2_000_000) throw new Error('SOURCE_FORMAT');
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false, closed = false, started = false;
  const addCell = () => { row.push(cell); cell = ''; closed = false; started = false; if (row.length > 32) throw new Error('SOURCE_FORMAT'); };
  const addRow = () => { addCell(); rows.push(row); row = []; if (rows.length > 10000) throw new Error('SOURCE_SIZE'); };
  const input = csv.replace(/^\uFEFF/, '');
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (quoted) {
      if (c === '"') {
        if (input[i + 1] === '"') { cell += '"'; i++; }
        else { quoted = false; closed = true; }
      } else cell += c;
    } else if (c === ',') addCell();
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && input[i + 1] === '\n') i++;
      addRow();
    } else if (c === '"' && !started && !closed) { quoted = true; started = true; }
    else {
      if (closed || c === '"') throw new Error('SOURCE_FORMAT');
      cell += c; started = true;
    }
    if (cell.length > 30000) throw new Error('SOURCE_SIZE');
  }
  if (quoted) throw new Error('SOURCE_FORMAT');
  if (started || closed || cell || row.length) addRow();
  if (!JRA_HEADERS.every((h, i) => rows[0]?.[i]?.trim() === h)) throw new Error('SOURCE_HEADERS');
  // Google may append an empty tenth column; reject newly populated columns rather than silently ignoring them.
  if (rows.some((r) => r.slice(9).some((c) => c.trim()))) throw new Error('SOURCE_HEADERS');
  return rows.map((r) => r.slice(0, 9));
}

export function searchJraRows(rows: string[][], query: string, offset: number): Pick<JraResult, 'results' | 'total' | 'nextOffset'> {
  const tokens = normalizeJra(query).split(' ').filter(Boolean);
  const matches: JraRow[] = [];
  rows.slice(1).forEach((r, i) => {
    if (!r[2]?.trim() || !tokens.every((t) => normalizeJra(r.slice(0, 7).join(' ')).includes(t))) return;
    matches.push({
      row: i + 2, section: r[0] ?? '', number: r[1] ?? '', description: r[2],
      active: r[3] ?? '', inactive: r[4] ?? '', disposition: r[5] ?? '', mergedRetention: r[6] ?? '',
      sourceUrl: `${JRA_SOURCE_URL}&range=A${i + 2}:I${i + 2}`,
    });
  });
  if (offset > matches.length) throw new Error('OFFSET');
  return { results: matches.slice(offset, offset + 10), total: matches.length,
    nextOffset: offset + 10 < matches.length ? offset + 10 : null };
}
