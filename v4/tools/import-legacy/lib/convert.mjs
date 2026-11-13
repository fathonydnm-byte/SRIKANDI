// Value converters: raw cell value (null | string | number | boolean | Date |
// {error}) -> value for the v4 column. Every converter returns null for blank
// input and throws ValueError with an Indonesian message when it cannot parse.
//
// Dates: the legacy app runs in Asia/Jakarta and Sheets stores date cells as
// wall-clock serials without zone. ExcelJS turns a serial into a JS Date whose
// UTC fields equal the wall-clock fields, so we read UTC fields: no day shift.

export class ValueError extends Error {}

export const TIME_ZONE_OFFSET = '+07:00'; // Asia/Jakarta has no DST

export function isBlank(v) {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

function assertNotError(v) {
  if (v && typeof v === 'object' && !(v instanceof Date) && 'error' in v) {
    throw new ValueError(`sel berisi galat spreadsheet ${v.error}`);
  }
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

function validYmd(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function ymd(y, m, d, original) {
  if (!validYmd(y, m, d) || y < 1900 || y > 2200) {
    throw new ValueError(`tanggal tidak valid: "${original}"`);
  }
  return `${y}-${pad(m)}-${pad(d)}`;
}

const MONTHS = {
  januari: 1, jan: 1, january: 1, februari: 2, feb: 2, pebruari: 2, february: 2, maret: 3, mar: 3, march: 3,
  april: 4, apr: 4, mei: 5, may: 5, juni: 6, jun: 6, june: 6, juli: 7, jul: 7, july: 7,
  agustus: 8, agu: 8, ags: 8, agt: 8, aug: 8, august: 8, september: 9, sep: 9, sept: 9,
  oktober: 10, okt: 10, oct: 10, october: 10, november: 11, nov: 11, nopember: 11,
  desember: 12, des: 12, dec: 12, december: 12
};

/** Excel/Sheets serial (days since 1899-12-30, fraction = time of day) -> wall-clock parts. */
function serialParts(serial) {
  if (!Number.isFinite(serial) || serial < 1 || serial > 120000) {
    throw new ValueError(`angka ${serial} bukan nomor seri tanggal yang wajar`);
  }
  const ms = Math.round(serial * 86400000);
  const dt = new Date(Date.UTC(1899, 11, 30) + ms);
  return dateParts(dt);
}

function dateParts(dt) {
  if (Number.isNaN(dt.getTime())) throw new ValueError('tanggal tidak valid');
  return {
    y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(),
    hh: dt.getUTCHours(), mi: dt.getUTCMinutes(), ss: dt.getUTCSeconds(), ms: dt.getUTCMilliseconds()
  };
}

function wallIso(p) {
  const frac = p.ms ? '.' + pad(p.ms, 3) : '';
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.hh)}:${pad(p.mi)}:${pad(p.ss)}${frac}${TIME_ZONE_OFFSET}`;
}

/** Local date of an absolute instant in Asia/Jakarta. */
function jakartaDateOfInstant(dt) {
  const shifted = new Date(dt.getTime() + 7 * 3600000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

const RE_ISO_DATE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const RE_ISO_DT = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;
const RE_DMY = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T,]+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?)?$/;
const RE_TEXT_MONTH = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})(?:[ ,]+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?)?$/;

export const convert = {
  text(v) {
    if (isBlank(v)) return null;
    assertNotError(v);
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (v instanceof Date) {
      const p = dateParts(v);
      return (p.hh || p.mi || p.ss || p.ms) ? wallIso(p) : `${p.y}-${pad(p.m)}-${pad(p.d)}`;
    }
    throw new ValueError(`nilai tidak dikenali: ${JSON.stringify(v)}`);
  },

  int(v) {
    if (isBlank(v)) return null;
    assertNotError(v);
    if (typeof v === 'number') {
      if (!Number.isInteger(v)) throw new ValueError(`bukan bilangan bulat: ${v}`);
      return v;
    }
    if (typeof v === 'string') {
      const s = v.trim();
      if (/^-?\d+(\.0+)?$/.test(s)) return parseInt(s, 10);
      throw new ValueError(`bukan bilangan bulat: "${s}"`);
    }
    throw new ValueError(`bukan bilangan bulat: ${v instanceof Date ? 'tanggal' : JSON.stringify(v)}`);
  },

  bool(v) {
    if (isBlank(v)) return null;
    assertNotError(v);
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number' && (v === 0 || v === 1)) return v === 1;
    const s = String(v).trim().toUpperCase();
    if (['TRUE', 'YA', 'Y', '1', 'BENAR', 'AKTIF'].includes(s)) return true;
    if (['FALSE', 'TIDAK', 'N', '0', 'SALAH', 'NONAKTIF'].includes(s)) return false;
    throw new ValueError(`bukan nilai benar/salah: "${v}"`);
  },

  date(v) {
    if (isBlank(v)) return null;
    assertNotError(v);
    if (v instanceof Date) {
      const p = dateParts(v);
      return ymd(p.y, p.m, p.d, v.toISOString());
    }
    if (typeof v === 'number') {
      const p = serialParts(v);
      return ymd(p.y, p.m, p.d, v);
    }
    if (typeof v !== 'string') throw new ValueError(`bukan tanggal: ${JSON.stringify(v)}`);
    const s = v.trim();
    let m;
    if ((m = s.match(RE_ISO_DATE))) return ymd(+m[1], +m[2], +m[3], s);
    if ((m = s.match(RE_ISO_DT))) {
      if (m[8]) {
        const dt = new Date(s.replace(' ', 'T'));
        if (Number.isNaN(dt.getTime())) throw new ValueError(`tanggal tidak valid: "${s}"`);
        return jakartaDateOfInstant(dt);
      }
      return ymd(+m[1], +m[2], +m[3], s);
    }
    if ((m = s.match(RE_DMY))) return ymd(+m[3], +m[2], +m[1], s);
    if ((m = s.match(RE_TEXT_MONTH))) {
      const month = MONTHS[m[2].toLowerCase()];
      if (!month) throw new ValueError(`nama bulan tidak dikenal: "${s}"`);
      return ymd(+m[3], month, +m[1], s);
    }
    if (/^\d+(\.\d+)?$/.test(s)) return convert.date(Number(s));
    throw new ValueError(`format tanggal tidak dikenali: "${s}"`);
  },

  timestamp(v) {
    if (isBlank(v)) return null;
    assertNotError(v);
    if (v instanceof Date) return wallIso(dateParts(v));
    if (typeof v === 'number') return wallIso(serialParts(v));
    if (typeof v !== 'string') throw new ValueError(`bukan waktu: ${JSON.stringify(v)}`);
    const s = v.trim();
    let m;
    if ((m = s.match(RE_ISO_DT))) {
      const base = `${m[1]}-${m[2]}-${m[3]}`;
      ymd(+m[1], +m[2], +m[3], s);
      const zone = m[8] ? (m[8].toUpperCase() === 'Z' ? 'Z' : m[8].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')) : TIME_ZONE_OFFSET;
      const iso = `${base}T${m[4]}:${m[5]}:${m[6] || '00'}${m[7] || ''}${zone}`;
      if (Number.isNaN(new Date(iso).getTime()) || +m[4] > 23 || +m[5] > 59) throw new ValueError(`waktu tidak valid: "${s}"`);
      return iso;
    }
    if ((m = s.match(RE_ISO_DATE))) return `${ymd(+m[1], +m[2], +m[3], s)}T00:00:00${TIME_ZONE_OFFSET}`;
    if ((m = s.match(RE_DMY)) || (m = s.match(RE_TEXT_MONTH))) {
      const month = /^\d+$/.test(m[2]) ? +m[2] : MONTHS[m[2].toLowerCase()];
      if (!month) throw new ValueError(`nama bulan tidak dikenal: "${s}"`);
      const day = ymd(+m[3], month, +m[1], s);
      const hh = +(m[4] || 0), mi = +(m[5] || 0), ss = +(m[6] || 0);
      if (hh > 23 || mi > 59 || ss > 59) throw new ValueError(`waktu tidak valid: "${s}"`);
      return `${day}T${pad(hh)}:${pad(mi)}:${pad(ss)}${TIME_ZONE_OFFSET}`;
    }
    if (/^\d+(\.\d+)?$/.test(s)) return convert.timestamp(Number(s));
    throw new ValueError(`format waktu tidak dikenali: "${s}"`);
  },

  json(v) {
    if (isBlank(v)) return null;
    assertNotError(v);
    if (typeof v !== 'string') throw new ValueError('bukan teks JSON');
    try {
      return JSON.parse(v);
    } catch {
      throw new ValueError(`JSON tidak valid: "${v.slice(0, 60)}"`);
    }
  }
};

/** Closed list converter: normalise case/spacing/aliases, reject unknown values. */
export function enumOf(values, aliases = {}) {
  const fn = (v) => {
    const s = convert.text(v);
    if (s === null) return null;
    const key = s.toUpperCase().replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (values.includes(key)) return key;
    if (aliases[key]) return aliases[key];
    throw new ValueError(`nilai "${s}" tidak termasuk daftar: ${values.join(', ')}`);
  };
  fn.values = values;
  return fn;
}

export const SECURITY = enumOf(
  ['BIASA/TERBUKA', 'TERBATAS', 'RAHASIA', 'SANGAT RAHASIA'],
  { 'BIASA': 'BIASA/TERBUKA', 'TERBUKA': 'BIASA/TERBUKA', 'BIASA TERBUKA': 'BIASA/TERBUKA',
    'BIASA / TERBUKA': 'BIASA/TERBUKA', 'SANGAT-RAHASIA': 'SANGAT RAHASIA' }
);
export const SATUAN = enumOf(['TAHUN', 'BULAN']);
export const NASIB = enumOf(['MUSNAH', 'PERMANEN', 'DINILAI KEMBALI']);
export const TINGKAT = enumOf(['ASLI', 'COPY'], { 'SALINAN': 'COPY', 'FOTOKOPI': 'COPY' });
export const KONDISI = enumOf(['BAIK', 'RUSAK RINGAN', 'RUSAK SEDANG', 'RUSAK BERAT']);
export const MEDIA_SUMBER = enumOf(['TEKSTUAL', 'AUDIO VISUAL', 'DIGITAL'], { 'AUDIOVISUAL': 'AUDIO VISUAL' });
export const BENTUK_DIGITAL = enumOf(['TIDAK ADA', 'ALIH MEDIA', 'BORN DIGITAL'], { 'BORNDIGITAL': 'BORN DIGITAL' });
export const VERIFIKASI = enumOf(['PERLU VERIFIKASI', 'TERVERIFIKASI']);
export const RECEIPT_STATUS = enumOf(['AKTIF', 'DIBATALKAN']);
export const FILING_STATUS = enumOf(['BELUM DIBERKASKAN', 'SUDAH DIBERKASKAN', 'PERLU DILENGKAPI', 'DIBATALKAN']);
export const JENIS_OBJEK = enumOf(['BERKAS', 'ITEM']);
export const AUDIT_RESULT = enumOf(['SUCCESS', 'FAILED', 'WARNING'],
  { 'BERHASIL': 'SUCCESS', 'GAGAL': 'FAILED', 'PERINGATAN': 'WARNING', 'OK': 'SUCCESS' });

/** Integer that tolerates the legacy "no number" markers; anything else is reported, stored as NULL. */
export function looseInt(v, note) {
  if (isBlank(v)) return null;
  const s = typeof v === 'string' ? v.trim() : v;
  if (s === '–' || s === '-' || s === '—') return null;
  try {
    return convert.int(s);
  } catch {
    note?.(String(s));
    return null;
  }
}
