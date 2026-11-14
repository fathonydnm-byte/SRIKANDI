/**
 * Central File v4 — Cermin Spreadsheet & Backup harian (proyek Apps Script TERPISAH dari gerbang Drive).
 *
 * Tugas, setiap malam, untuk setiap unit:
 *   (a) CERMIN : satu Google Sheet baca-saja per unit ("CERMIN CENTRAL FILE – <kode unit>") berisi semua tabel
 *               (nama sheet dan header memakai nama 3.x bila ada) + laporan DAFTAR BERKAS dan DAFTAR ISI BERKAS.
 *   (b) BACKUP : paket harian di Drive: folder <tanggal>/ berisi NDJSON.gz per tabel (dipecah ≤ 1.000 baris per berkas)
 *               + manifest.json (versi skema, jumlah baris, sha256 tiap berkas, inventaris file Drive).
 *   Sekaligus menjaga proyek Supabase gratis tetap aktif (tiap malam ada permintaan ke database).
 *
 * Batas keamanan (appsscript.json): spreadsheets, drive.file, script.external_request, script.scriptapp. SAJA.
 *   - drive.file: hanya file/folder yang DIBUAT proyek ini yang terlihat/bisa diubah/dihapus. Arsip PDF lama tak tersentuh.
 *   - Tidak ada doGet/doPost: proyek ini tidak bisa dipanggil dari luar. Ia hanya MEMANGGIL aplikasi (POST bertanda tangan).
 *   - Tidak mencetak token apa pun.
 *   - Cermin dan paket backup tidak dienkripsi di lapisan ini: berada di akun Drive pribadi instansi yang sama dengan
 *     seluruh PDF arsip. Kolom data pribadi di dalamnya tetap terenkripsi (cermin tidak memuatnya sama sekali).
 *
 * Pasang: lihat PASANG.md. Fungsi operator: setupMirror, setBaseUrl, installNightlyTrigger, runNow, statusMirror,
 * rotateJobSecret, resetJob, removeTriggers.
 *
 * Permintaan ke aplikasi: POST {BASE_URL}/api/jobs/export, JSON {action, ts, nonce, sig, ...parameter}
 *   sig = hex(HMAC-SHA256(JOB_SECRET, "CFJOB1\n" + action + "\n" + ts + "\n" + nonce + "\n" + sha256hex(canonicalJson(parameter))))
 */

var JOB_VERSION = 'CFJOB1';
var BACKUP_FORMAT = 'CFBACKUP1';
var SCRIPT_VERSION = 'cermin-apps-script/1.0.0';
var P_SECRET = 'JOB_SECRET';
var P_BASE = 'BASE_URL';
var P_STATE = 'JOB_STATE';
var P_FOLDERS = 'DRIVE_FOLDERS';
var P_SHEETS = 'MIRROR_SHEETS';
var HANDLER_NIGHTLY = 'nightlyMirror';
var HANDLER_CONTINUE = 'continueMirror';
var TZ = 'Asia/Jakarta';
var TIME_BUDGET_MS = 270000;          // berhenti memulai halaman baru setelah 4,5 menit (batas Apps Script: 6 menit)
var HEAVY_MIN_MS = 120000;            // sisa waktu minimal untuk memulai fase berat
var CONTINUE_DELAY_MS = 60000;        // lanjutan dipicu 1 menit kemudian
var STATE_STALE_MS = 12 * 3600 * 1000;
var PAGE_LIMIT = 1000;
var API_ATTEMPTS = 3;
var ROOT_FOLDER_NAME = 'CENTRAL FILE V4';
var SHEET_CELL_CAP = 9000000;         // batas Google Sheets 10 juta sel per berkas; sisakan ruang
var CELL_TEXT_MAX = 49000;            // batas Sheets 50.000 karakter per sel
var KEEP_DAILY = 30;
var KEEP_MONTHS = 12;
var FOLDER_MIME = 'application/vnd.google-apps.folder';
var SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
var DRIVE_API = 'https://www.googleapis.com/drive/v3';
var DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
var STATE_MAX_BYTES = 8500;           // batas properti skrip: 9 KB per nilai

// ---------------------------------------------------------------------------
// Spesifikasi sheet: nama sheet dan header 3.x bila ada (LEGACY_COLUMN_MAP.md); selain itu HURUF_BESAR dari kolom.
// ---------------------------------------------------------------------------
var MIRROR_TABLES = {
  units: { sheet: 'UNIT', rename: { id: 'UNIT_UUID', code: 'UNIT_CODE', name: 'UNIT_NAME', legacy_instance_id: 'INSTANCE_ID', legacy_unit_id: 'UNIT_ID' } },
  unit_settings: { sheet: 'SETTINGS', rename: { value_type: 'TYPE' } },
  counters: { sheet: 'PENOMORAN', rename: {} },
  klasifikasi: { sheet: 'MASTER_KLASIFIKASI', rename: { id: 'KLASIFIKASI_ID' } },
  jenis_naskah: { sheet: 'MASTER_JENIS_NASKAH', rename: {} },
  pegawai: { sheet: 'MASTER_PEGAWAI', rename: { id: 'PEGAWAI_ID' } },
  berkas: { sheet: 'DB_BERKAS', rename: { id: 'BERKAS_ID' } },
  item: { sheet: 'DB_ITEM', rename: { id: 'ITEM_ID', lampiran: 'LAMPIRAN_JSON' } },
  penerimaan: { sheet: 'PENERIMAAN_ARSIP', rename: { id: 'PENERIMAAN_ID' } },
  penerimaan_item: { sheet: 'PENERIMAAN_ITEM', rename: { id: 'PENERIMAAN_ITEM_ID' } },
  riwayat_nomor: { sheet: 'RIWAYAT_NOMOR', rename: { id: 'RIWAYAT_ID' } },
  penerimaan_cetak_log: { sheet: 'LOG_CETAK_PENERIMAAN', rename: { id: 'CETAK_ID', printed_at: 'TIMESTAMP' } },
  folder_label_log: { sheet: 'LOG_CETAK_LIDAH', rename: { id: 'PRINT_ID', printed_at: 'TIMESTAMP' } },
  karantina: { sheet: 'SYSTEM_QUARANTINE', rename: {} },
  pembatalan_arsip: { sheet: 'PEMBATALAN_ARSIP', rename: {} },
  drive_tasks: { sheet: 'ANTREAN_DRIVE', rename: {} },
  audit_log: {
    sheet: 'AUDIT_LOG',
    rename: {
      id: 'LOG_ID', occurred_at: 'TIMESTAMP', actor_email_snapshot: 'USER_EMAIL', action: 'AKSI', module: 'MODUL', object_type: 'JENIS_OBJEK',
      object_id: 'OBJEK_ID', summary: 'RINGKASAN', reason: 'ALASAN', result: 'STATUS', before_data: 'DATA_SEBELUM_JSON', after_data: 'DATA_SESUDAH_JSON'
    }
  }
};
var REPORT_BERKAS_SHEET = 'DAFTAR BERKAS';
var REPORT_ITEM_SHEET = 'DAFTAR ISI BERKAS';
var INFO_SHEET = '_INFO';
var TMP_PREFIX = '~';
var OLD_PREFIX = '~lama~';
var REPORT_HEADER_ROW = 4;

var REPORT_BERKAS_HEADERS = ['No. Berkas', 'Kode Primer', 'Kode Sekunder', 'Kode Tersier', 'Judul Berkas', 'Kurun Waktu', 'Jumlah (Item Arsip)', 'Jumlah (Lembar)', 'Status Retensi'];
var REPORT_ITEM_HEADERS = [
  'No. Berkas', 'No. Item', 'No. Surat', 'Kode Primer', 'Kode Sekunder', 'Kode Tersier', 'Uraian Informasi', 'Tahun', 'Jumlah (Lembar)', 'Tanggal Naskah',
  'Tingkat Perkembangan', 'No. Filling Kabinet', 'No. Laci', 'No. Folder', 'Klasifikasi Keamanan', 'Keterangan 1', 'Keterangan 2', 'Batas Aktif',
  'Status Retensi', 'Tautan File'
];

// ===========================================================================
// LOGIKA MURNI (diuji di Node: mirror.test.cjs)
// ===========================================================================

/** JSON kanonik: kunci objek diurutkan (rekursif), tanpa spasi. Harus sama persis dengan server/jobsExport.ts. */
function canonicalJson_(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    return '[' + value.map(function (v) { return canonicalJson_(v === undefined ? null : v); }).join(',') + ']';
  }
  var t = typeof value;
  if (t === 'string' || t === 'boolean') return JSON.stringify(value);
  if (t === 'number') {
    if (!isFinite(value)) throw new Error('angka tidak hingga');
    return JSON.stringify(value);
  }
  if (t === 'object') {
    return '{' + Object.keys(value)
      .filter(function (k) { return value[k] !== undefined; })
      .sort()
      .map(function (k) { return JSON.stringify(k) + ':' + canonicalJson_(value[k]); })
      .join(',') + '}';
  }
  throw new Error('nilai tidak didukung');
}

function bytesToHex_(bytes) {
  var out = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = bytes[i] & 0xff;
    out += (b < 16 ? '0' : '') + b.toString(16);
  }
  return out;
}

function sha256Hex_(input) {
  var bytes = typeof input === 'string' ? Utilities.newBlob(input).getBytes() : input;
  return bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes));
}

function hmacHex_(secret, message) {
  return bytesToHex_(Utilities.computeHmacSha256Signature(Utilities.newBlob(message).getBytes(), Utilities.newBlob(secret).getBytes()));
}

function jobCanonical_(action, ts, nonce, params) {
  return JOB_VERSION + '\n' + action + '\n' + ts + '\n' + nonce + '\n' + sha256Hex_(canonicalJson_(params));
}

/** Badan permintaan bertanda tangan. Setiap parameter ikut ditandatangani. */
function signJob_(secret, action, ts, nonce, params) {
  params = params || {};
  var body = { action: action, ts: ts, nonce: nonce, sig: hmacHex_(secret, jobCanonical_(action, ts, nonce, params)) };
  Object.keys(params).forEach(function (k) { if (params[k] !== undefined) body[k] = params[k]; });
  return body;
}

function newNonce_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 48);
}

/** Pelindung injeksi rumus: sel teks berawalan = + - @ (atau tab/CR) ditulis sebagai teks (awalan '). */
function safeCell_(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return isFinite(v) ? v : '';
  if (typeof v === 'boolean') return v;
  if (Object.prototype.toString.call(v) === '[object Date]') return v;
  var s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (s.length > CELL_TEXT_MAX) s = s.slice(0, CELL_TEXT_MAX) + '…[dipotong; isi lengkap ada di paket backup]';
  if (/^[=+\-@\t\r]/.test(s)) return "'" + s;
  return s;
}

function mirrorSpec_(table) {
  return MIRROR_TABLES.hasOwnProperty(table) ? MIRROR_TABLES[table] : { sheet: String(table).toUpperCase(), rename: {} };
}

function sheetNameFor_(table) {
  return mirrorSpec_(table).sheet;
}

function headerFor_(table, column) {
  var spec = mirrorSpec_(table);
  if (spec.rename.hasOwnProperty(column)) return spec.rename[column];
  if (column === 'unit_id') return 'UNIT_UUID';
  return String(column).toUpperCase();
}

/** Kolom terenkripsi (PII, *_enc) tidak dimasukkan ke cermin yang dapat dibaca; tetap ada di paket backup. */
function mirrorColumns_(table, rows) {
  if (!rows || !rows.length) return [];
  return Object.keys(rows[0]).filter(function (c) { return !/_enc$/.test(c); }).map(function (c) { return { col: c, header: headerFor_(table, c) }; });
}

function rowsToValues_(columns, rows) {
  return rows.map(function (row) { return columns.map(function (c) { return safeCell_(row[c.col]); }); });
}

function rowsToNdjson_(rows) {
  return rows.map(function (r) { return JSON.stringify(r); }).join('\n') + '\n';
}

function pad4_(n) {
  var s = String(n);
  while (s.length < 4) s = '0' + s;
  return s;
}

function partName_(table, n) {
  return table + '.' + pad4_(n) + '.ndjson.gz';
}

/** Kursor keyset berikutnya: nilai kolom kunci dari baris terakhir. */
function keysetAfter_(keyCols, lastRow) {
  return keyCols.map(function (c) { return lastRow[c]; });
}

/** File Drive yang dirujuk baris data (untuk inventaris di manifest). */
function extractInventory_(table, rows) {
  var out = [];
  function add(source, id, fileId, name, size, sha, md5, mime, kind) {
    if (!fileId) return;
    out.push({
      source: source, source_id: id, kind: kind || 'FILE', file_id: fileId, name: name || null,
      size: size === undefined || size === null ? null : size, sha256: sha || null, md5: md5 || null, mime: mime || null
    });
  }
  rows.forEach(function (r) {
    switch (table) {
      case 'item': add('item', r.id, r.drive_file_id, r.nama_file, r.drive_file_size_bytes, r.drive_file_sha256, null, r.mime_type); break;
      case 'berkas': add('berkas', r.id, r.drive_folder_id, r.judul_berkas, null, null, null, null, 'FOLDER'); break;
      case 'penerimaan':
        add('penerimaan.bukti_ttd', r.id, r.bukti_ttd_file_id, r.bukti_ttd_nama, r.bukti_ttd_size_bytes, null, r.bukti_ttd_md5, null);
        add('penerimaan.batal_bukti', r.id, r.batal_bukti_file_id, r.batal_bukti_nama, r.batal_bukti_size_bytes, null, r.batal_bukti_md5, null);
        break;
      case 'penerimaan_item': add('penerimaan_item', r.id, r.file_digital_id, null, r.file_digital_size_bytes, r.file_digital_sha256, null, r.file_digital_mime_type); break;
      case 'pembatalan_arsip': add('pembatalan_arsip', r.id, r.bukti_file_id, r.bukti_nama, r.bukti_size_bytes, null, r.bukti_md5, r.bukti_mime); break;
      case 'karantina': add('karantina', r.id, r.object_id, r.original_name, r.size_bytes, null, r.md5, r.mime_type, r.object_type === 'FOLDER' ? 'FOLDER' : 'FILE'); break;
      default: break;
    }
  });
  return out;
}

/**
 * Manifest paket backup. parts = [{table, file, rows, bytes, sha256}] (tabel '_drive_inventory' untuk inventaris).
 * info = {createdAt, day, unit:{id,code,name}, schemaVersion, tables:[nama tabel]}
 */
function buildManifest_(info, parts) {
  var tables = {};
  info.tables.forEach(function (t) { tables[t] = { rows: 0, parts: [] }; });
  var inventory = { rows: 0, parts: [] };
  var total = 0;
  parts.slice().sort(function (a, b) { return a.file < b.file ? -1 : a.file > b.file ? 1 : 0; }).forEach(function (p) {
    var entry = { file: p.file, rows: p.rows, bytes: p.bytes, sha256: p.sha256 };
    if (p.table === '_drive_inventory') {
      inventory.rows += p.rows;
      inventory.parts.push(entry);
    } else {
      if (!tables[p.table]) tables[p.table] = { rows: 0, parts: [] };
      tables[p.table].rows += p.rows;
      tables[p.table].parts.push(entry);
      total += p.rows;
    }
  });
  return {
    format: BACKUP_FORMAT,
    generator: SCRIPT_VERSION,
    created_at: info.createdAt,
    day: info.day,
    unit: info.unit,
    schema_version: info.schemaVersion,
    tables: tables,
    total_rows: total,
    drive_inventory: inventory
  };
}

function daysBetweenKey_(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s + 'T00:00:00Z').getTime());
}

/**
 * Retensi: simpan 30 paket harian terbaru + paket pertama tiap bulan selama 12 bulan terakhir (bulan ini dihitung).
 * names = nama folder paket; hanya yang berformat YYYY-MM-DD yang dipertimbangkan (selain itu TIDAK pernah dihapus).
 */
function selectRetention_(names, today) {
  var valid = names.filter(daysBetweenKey_).sort().reverse();
  var keep = {};
  valid.slice(0, KEEP_DAILY).forEach(function (n) { keep[n] = true; });
  var ty = parseInt(today.slice(0, 4), 10);
  var tm = parseInt(today.slice(5, 7), 10);
  var cutoffIndex = ty * 12 + (tm - 1) - (KEEP_MONTHS - 1);
  var firstOfMonth = {};
  valid.slice().reverse().forEach(function (n) {
    var m = n.slice(0, 7);
    if (!firstOfMonth[m]) firstOfMonth[m] = n; // terlama dulu => paket pertama bulan itu
  });
  Object.keys(firstOfMonth).forEach(function (m) {
    var idx = parseInt(m.slice(0, 4), 10) * 12 + (parseInt(m.slice(5, 7), 10) - 1);
    if (idx >= cutoffIndex && idx <= ty * 12 + (tm - 1)) keep[firstOfMonth[m]] = true;
  });
  return {
    keep: valid.filter(function (n) { return keep[n]; }),
    remove: valid.filter(function (n) { return !keep[n]; })
  };
}

function normalizeSecurity_(value) {
  var v = String(value === null || value === undefined ? '' : value).toUpperCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (v === 'BIASA' || v === 'TERBUKA' || v === 'BIASA TERBUKA' || v === 'BIASA/TERBUKA') return 'BIASA/TERBUKA';
  if (v === 'TERBATAS' || v === 'RAHASIA' || v === 'SANGAT RAHASIA') return v;
  return 'BIASA/TERBUKA';
}

function isTrue_(v) {
  return v === true || String(v).toUpperCase() === 'TRUE' || String(v).toUpperCase() === 'YA';
}

function classificationSegments_(code) {
  var parts = String(code === null || code === undefined ? '' : code).split('.');
  return [parts[0] || '', parts[1] || '', parts[2] ? (parts[1] + '.' + parts[2]) : ''];
}

function num_(v) {
  var n = Number(v);
  return isFinite(n) ? n : 0;
}

/**
 * Laporan 3.x (ReportService.rebuildReports_). Masukan: objek berkunci header 3.x (hasil baca balik tab cermin).
 * Berkas: tidak dihapus, bernomor definitif, belum "SUDAH DIPINDAHKAN". Item: tidak dihapus, bernomor, berkasnya termasuk.
 */
function buildReports_(berkasObjs, itemObjs) {
  var berkas = berkasObjs.filter(function (r) {
    return !isTrue_(r.IS_DELETED) && r.NO_BERKAS_DEFINITIF !== '' && r.NO_BERKAS_DEFINITIF !== null && r.NO_BERKAS_DEFINITIF !== undefined &&
      String(r.STATUS_PEMINDAHAN || '').toUpperCase() !== 'SUDAH DIPINDAHKAN';
  });
  var active = {};
  berkas.forEach(function (r) { active[r.BERKAS_ID] = true; });
  var items = itemObjs.filter(function (r) {
    return !isTrue_(r.IS_DELETED) && r.NO_ITEM_DEFINITIF !== '' && r.NO_ITEM_DEFINITIF !== null && r.NO_ITEM_DEFINITIF !== undefined && active[r.BERKAS_ID];
  });
  berkas.sort(function (a, b) { return num_(a.NO_BERKAS_DEFINITIF) - num_(b.NO_BERKAS_DEFINITIF); });
  items.sort(function (a, b) { return (num_(a.NO_BERKAS_SNAPSHOT) - num_(b.NO_BERKAS_SNAPSHOT)) || (num_(a.NO_ITEM_DEFINITIF) - num_(b.NO_ITEM_DEFINITIF)); });
  var byId = {};
  berkas.forEach(function (r) { byId[r.BERKAS_ID] = r; });
  var stats = {};
  items.forEach(function (r) {
    var s = stats[r.BERKAS_ID] || (stats[r.BERKAS_ID] = { count: 0, pages: 0 });
    s.count += 1;
    s.pages += num_(r.JUMLAH_HALAMAN);
  });
  var berkasRows = berkas.map(function (r) {
    var c = classificationSegments_(r.KODE_KLASIFIKASI_SNAPSHOT);
    var s = stats[r.BERKAS_ID] || { count: 0, pages: 0 };
    return [r.NO_BERKAS_DEFINITIF, c[0], c[1], c[2], r.JUDUL_BERKAS, r.KURUN_WAKTU, s.count, s.pages, r.STATUS_RETENSI];
  });
  var itemRows = items.map(function (r) {
    var parent = byId[r.BERKAS_ID] || {};
    var c = classificationSegments_(r.KODE_KLASIFIKASI_SNAPSHOT);
    return [
      r.NO_BERKAS_SNAPSHOT, r.NO_ITEM_DEFINITIF, r.NO_SURAT_DISPLAY, c[0], c[1], c[2], r.URAIAN_LENGKAP,
      String(r.TAHUN_KURUN_WAKTU === null || r.TAHUN_KURUN_WAKTU === undefined ? '' : r.TAHUN_KURUN_WAKTU), r.JUMLAH_HALAMAN, r.TANGGAL_NASKAH,
      r.TINGKAT_PERKEMBANGAN, parent.NO_FILLING_KABINET || '', parent.NO_LACI || '', r.NO_BERKAS_SNAPSHOT,
      normalizeSecurity_(r.KLASIFIKASI_KEAMANAN_AKSES || parent.KLASIFIKASI_KEAMANAN_AKSES || 'BIASA/TERBUKA'), '', '', parent.BATAS_AKTIF || '',
      parent.STATUS_RETENSI || '', r.DRIVE_FILE_URL || ''
    ];
  });
  return { berkasRows: berkasRows, itemRows: itemRows };
}

function escapeQ_(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function folderKey_(code, kind) {
  return code + '/' + kind;
}

function safeName_(s) {
  var t = String(s).replace(/[\\\/:*?"<>|#%{}~\r\n\t]+/g, '-').replace(/\s+/g, ' ').trim();
  return t || 'tanpa-nama';
}

function jakartaIso_(date) {
  return Utilities.formatDate(date, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

function jakartaDay_(date) {
  return Utilities.formatDate(date, TZ, 'yyyy-MM-dd');
}

function sheetUrl_(id) {
  return 'https://docs.google.com/spreadsheets/d/' + id + '/edit';
}

/** Pesan galat yang aman dikirim ke aplikasi: tanpa URL, token, atau secret. */
function sanitizeError_(err) {
  var m = String((err && err.message) || err || 'Galat tidak diketahui');
  m = m.replace(/https?:\/\/\S+/g, '[url]').replace(/Bearer\s+\S+/gi, 'Bearer [dihapus]').replace(/[A-Fa-f0-9]{40,}/g, '[dihapus]');
  return m.slice(0, 400);
}

// ===========================================================================
// STATE (properti skrip)
// ===========================================================================
function props_() {
  return PropertiesService.getScriptProperties();
}

function getJson_(key) {
  var raw = props_().getProperty(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

function setJson_(key, value) {
  var raw = JSON.stringify(value);
  if (raw.length > STATE_MAX_BYTES) throw new Error('Status pekerjaan terlalu besar untuk properti skrip (' + key + ').');
  props_().setProperty(key, raw);
}

function loadState_() {
  return getJson_(P_STATE);
}

function saveState_(state) {
  setJson_(P_STATE, state);
}

function clearState_() {
  props_().deleteProperty(P_STATE);
}

// ===========================================================================
// PANGGILAN KE APLIKASI
// ===========================================================================
function getConfig_() {
  var secret = props_().getProperty(P_SECRET);
  var base = props_().getProperty(P_BASE);
  if (!secret || secret.length < 32) throw new Error('JOB_SECRET belum dibuat. Jalankan setupMirror().');
  if (!base) throw new Error('Alamat aplikasi belum diisi. Jalankan setBaseUrl("https://...").');
  return { secret: secret, base: base };
}

/**
 * Satu panggilan API bertanda tangan. Nonce BARU di setiap percobaan (nonce lama sudah tercatat di server).
 * Mengembalikan {json, text, headers}. Galat HTTP 4xx tidak diulang; 429/5xx/jaringan diulang sampai API_ATTEMPTS kali.
 */
function apiCall_(action, params) {
  var cfg = getConfig_();
  var lastError = null;
  for (var attempt = 1; attempt <= API_ATTEMPTS; attempt++) {
    var body = signJob_(cfg.secret, action, Math.floor(Date.now() / 1000), newNonce_(), params || {});
    var res;
    try {
      res = UrlFetchApp.fetch(cfg.base + '/api/jobs/export', {
        method: 'post', contentType: 'application/json', payload: JSON.stringify(body), muteHttpExceptions: true, followRedirects: false
      });
    } catch (e) {
      lastError = new Error('API ' + action + ': jaringan gagal');
      Utilities.sleep(1000 * attempt);
      continue;
    }
    var code = res.getResponseCode();
    if (code === 200) {
      var text = res.getContentText();
      return { text: text, headers: res.getHeaders() || {}, json: null };
    }
    if (code === 429 || code >= 500) {
      lastError = new Error('API ' + action + ': HTTP ' + code);
      Utilities.sleep(1000 * attempt);
      continue;
    }
    var apiCode = '';
    try { apiCode = JSON.parse(res.getContentText()).code || ''; } catch (e2) { /* badan bukan JSON */ }
    throw new Error('API ' + action + ' ditolak (HTTP ' + code + (apiCode ? ' ' + apiCode : '') + ')');
  }
  throw lastError || new Error('API ' + action + ': gagal');
}

function apiJson_(action, params) {
  var r = apiCall_(action, params);
  var json;
  try { json = JSON.parse(r.text); } catch (e) { throw new Error('API ' + action + ': jawaban bukan JSON'); }
  if (!json || json.ok !== true) throw new Error('API ' + action + ': jawaban tidak ok');
  return json;
}

function headerValue_(headers, name) {
  var lower = name.toLowerCase();
  var keys = Object.keys(headers || {});
  for (var i = 0; i < keys.length; i++) if (keys[i].toLowerCase() === lower) return headers[keys[i]];
  return null;
}

/** Satu halaman tabel: {rows, total}. total hanya ada di halaman pertama (kursor kosong). */
function fetchPage_(unitId, table, after) {
  var params = { unit_id: unitId, table: table, limit: PAGE_LIMIT };
  if (after) params.after = after;
  var r = apiCall_('TABLE_PAGE', params);
  var rows;
  try { rows = JSON.parse(r.text); } catch (e) { throw new Error('TABLE_PAGE ' + table + ': jawaban bukan JSON'); }
  if (!Array.isArray(rows)) throw new Error('TABLE_PAGE ' + table + ': jawaban bukan daftar');
  var total = null;
  if (!after) {
    var t = headerValue_(r.headers, 'X-Total-Count');
    total = t === null ? null : parseInt(t, 10);
    if (total === null || isNaN(total)) throw new Error('TABLE_PAGE ' + table + ': jumlah total tidak diberikan server');
  }
  return { rows: rows, total: total };
}

// ===========================================================================
// DRIVE (REST; hanya cakupan drive.file => hanya file buatan proyek ini yang terlihat)
// ===========================================================================
function driveRequest_(method, url, options) {
  options = options || {};
  var lastError = null;
  for (var attempt = 1; attempt <= API_ATTEMPTS; attempt++) {
    var params = {
      method: method, headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true, followRedirects: false
    };
    if (options.json !== undefined) { params.contentType = 'application/json'; params.payload = JSON.stringify(options.json); }
    if (options.bytes !== undefined) { params.contentType = options.contentType || 'application/octet-stream'; params.payload = options.bytes; }
    var res;
    try {
      res = UrlFetchApp.fetch(url, params);
    } catch (e) {
      lastError = new Error('Drive: jaringan gagal');
      Utilities.sleep(1000 * attempt);
      continue;
    }
    var code = res.getResponseCode();
    if (code >= 200 && code < 300) {
      var text = res.getContentText();
      return text ? JSON.parse(text) : {};
    }
    if (code === 404 && options.allow404) return null;
    if (code === 429 || code >= 500 || (code === 403 && /rateLimit|userRateLimit/i.test(res.getContentText()))) {
      lastError = new Error('Drive: HTTP ' + code);
      Utilities.sleep(1000 * attempt);
      continue;
    }
    throw new Error('Drive: ditolak (HTTP ' + code + ')');
  }
  throw lastError || new Error('Drive: gagal');
}

function driveList_(q, fields) {
  var out = [];
  var token = '';
  do {
    var url = DRIVE_API + '/files?q=' + encodeURIComponent(q) + '&pageSize=1000&fields=' + encodeURIComponent('nextPageToken,files(' + fields + ')') +
      (token ? '&pageToken=' + encodeURIComponent(token) : '');
    var r = driveRequest_('get', url);
    (r.files || []).forEach(function (f) { out.push(f); });
    token = r.nextPageToken || '';
  } while (token);
  return out;
}

function driveGet_(id, fields) {
  return driveRequest_('get', DRIVE_API + '/files/' + encodeURIComponent(id) + '?fields=' + encodeURIComponent(fields), { allow404: true });
}

function driveCreate_(name, parentId, mime, appProps) {
  var meta = { name: name, mimeType: mime };
  if (parentId) meta.parents = [parentId];
  if (appProps) meta.appProperties = appProps;
  return driveRequest_('post', DRIVE_API + '/files?fields=id,name', { json: meta }).id;
}

function driveRename_(id, name) {
  driveRequest_('patch', DRIVE_API + '/files/' + encodeURIComponent(id) + '?fields=id', { json: { name: name } });
}

function driveTrash_(id) {
  driveRequest_('patch', DRIVE_API + '/files/' + encodeURIComponent(id) + '?fields=id', { json: { trashed: true } });
}

function driveFindChild_(parentId, name, mime) {
  var q = "'" + escapeQ_(parentId) + "' in parents and name = '" + escapeQ_(name) + "' and trashed = false" + (mime ? " and mimeType = '" + mime + "'" : '');
  var files = driveList_(q, 'id,name,appProperties');
  return files.length ? files[0] : null;
}

/** Unggah/timpa berkas bernama sama di folder (idempoten untuk lanjutan setelah putus). */
function driveUpload_(parentId, name, bytes, mime, appProps) {
  var existing = driveFindChild_(parentId, name, null);
  var id = existing ? existing.id : driveCreate_(name, parentId, mime, appProps);
  driveRequest_('patch', DRIVE_UPLOAD + '/files/' + encodeURIComponent(id) + '?uploadType=media&fields=id', { bytes: bytes, contentType: mime });
  if (existing && appProps) driveRequest_('patch', DRIVE_API + '/files/' + encodeURIComponent(id) + '?fields=id', { json: { appProperties: appProps } });
  return id;
}

/** Folder (id disimpan di properti skrip; diverifikasi masih ada dan tidak di tempat sampah). */
function ensureFolder_(key, name, parentId, appProps) {
  var map = getJson_(P_FOLDERS) || {};
  var cached = map[key];
  if (cached) {
    var meta = driveGet_(cached, 'id,trashed');
    if (meta && !meta.trashed) return cached;
  }
  var found = driveFindChild_(parentId, name, FOLDER_MIME);
  var id = found ? found.id : driveCreate_(name, parentId, FOLDER_MIME, appProps);
  map[key] = id;
  setJson_(P_FOLDERS, map);
  return id;
}

function ensureUnitFolders_(code) {
  var root = ensureFolder_('root', ROOT_FOLDER_NAME, null, { cfApp: 'cermin' });
  var unit = ensureFolder_(code, safeName_(code), root, { cfApp: 'cermin' });
  return {
    cermin: ensureFolder_(folderKey_(code, 'CERMIN'), 'CERMIN', unit, { cfApp: 'cermin' }),
    backup: ensureFolder_(folderKey_(code, 'BACKUP'), 'BACKUP', unit, { cfApp: 'cermin' })
  };
}

function ensureSpreadsheet_(code, folderId) {
  var name = 'CERMIN CENTRAL FILE – ' + code;
  var map = getJson_(P_SHEETS) || {};
  if (map[code]) {
    var meta = driveGet_(map[code], 'id,trashed');
    if (meta && !meta.trashed) return map[code];
  }
  var found = driveFindChild_(folderId, name, SHEET_MIME);
  var id = found ? found.id : driveCreate_(name, folderId, SHEET_MIME, { cfApp: 'cermin' });
  map[code] = id;
  setJson_(P_SHEETS, map);
  return id;
}

// ===========================================================================
// SHEETS
// ===========================================================================
function ensureSize_(sheet, rows, cols) {
  var maxRows = sheet.getMaxRows();
  if (maxRows < rows) sheet.insertRowsAfter(maxRows, rows - maxRows);
  var maxCols = sheet.getMaxColumns();
  if (maxCols < cols) sheet.insertColumnsAfter(maxCols, cols - maxCols);
}

function removeSheetIfExists_(ss, name) {
  var s = ss.getSheetByName(name);
  if (s) {
    if (ss.getSheets().length === 1) ss.insertSheet('~sementara');
    ss.deleteSheet(s);
  }
}

function writeBlock_(sheet, startRow, values) {
  if (!values.length) return;
  var cols = values[0].length;
  ensureSize_(sheet, startRow + values.length - 1, cols);
  sheet.getRange(startRow, 1, values.length, cols).setValues(values);
}

function readColumns_(sheet, headerRow, names, firstDataRow, count) {
  var out = {};
  var lastCol = sheet.getLastColumn ? sheet.getLastColumn() : sheet.getMaxColumns();
  var header = sheet.getRange(headerRow, 1, 1, lastCol).getValues()[0];
  names.forEach(function (n) {
    var idx = header.indexOf(n);
    out[n] = idx < 0 || count < 1 ? [] : sheet.getRange(firstDataRow, idx + 1, count, 1).getValues().map(function (r) { return r[0]; });
  });
  return out;
}

function columnsToObjects_(cols, count) {
  var objs = [];
  var names = Object.keys(cols);
  for (var i = 0; i < count; i++) {
    var o = {};
    names.forEach(function (n) { o[n] = cols[n][i] === undefined ? '' : cols[n][i]; });
    objs.push(o);
  }
  return objs;
}

// ===========================================================================
// MESIN PEKERJAAN (resumable)
// ===========================================================================
function tablesOf_(state, unit) {
  return unit.backup_only ? (unit.tables || ['audit_log']) : (unit.tables || Object.keys(state.tables));
}

function freshState_(now) {
  var list = apiJson_('LIST_UNITS', {});
  if (!list.units || !list.units.length) throw new Error('LIST_UNITS kosong');
  var tables = {};
  Object.keys(list.tables).forEach(function (t) { tables[t] = list.tables[t].key; });
  var state = {
    v: 1, day: jakartaDay_(new Date(now)), startedAt: now, schema: list.schema_version, tables: tables,
    units: list.units.map(function (u) { var o = { id: u.id, code: u.code, name: u.name, bo: !!u.backup_only }; if (u.backup_only) o.t = u.tables; return o; }),
    ui: 0, step: 'UNIT_BEGIN', u: null, results: []
  };
  return state;
}

function currentUnit_(state) {
  return state.units[state.ui];
}

function unitTables_(state, unit) {
  return unit.t && unit.t.length ? unit.t : (unit.bo ? ['audit_log'] : Object.keys(state.tables));
}

function stepUnitBegin_(state) {
  var unit = currentUnit_(state);
  var u = { rows: {}, ti: 0, after: null, total: null, written: 0, part: 0, attempt: 0, inv: 0, invParts: 0, cells: 0, mirror: !unit.bo };
  state.u = u;
  if (u.mirror) u.runMirror = apiJson_('RUN_BEGIN', { kind: 'MIRROR', unit_id: unit.id }).run_id;
  u.runBackup = apiJson_('RUN_BEGIN', { kind: 'BACKUP', unit_id: unit.id }).run_id;
  var folders = ensureUnitFolders_(unit.bo ? '_PLATFORM' : unit.code);
  u.backupFolder = folders.backup;
  // sisa paket gagal sebelumnya (nama sementara) dibuang; hanya yang dibuat proyek ini yang terlihat
  driveList_("'" + escapeQ_(folders.backup) + "' in parents and trashed = false and mimeType = '" + FOLDER_MIME + "'", 'id,name').forEach(function (f) {
    if (f.name.indexOf('_tmp-') === 0) driveTrash_(f.id);
  });
  u.pkg = driveCreate_('_tmp-' + state.day, folders.backup, FOLDER_MIME, { cfBackup: '1', day: state.day, unit: unit.code });
  if (u.mirror) {
    u.ssId = ensureSpreadsheet_(unit.code, folders.cermin);
    var ss = SpreadsheetApp.openById(u.ssId);
    ss.getSheets().forEach(function (s) {
      if (s.getName().indexOf(TMP_PREFIX) === 0) {
        if (ss.getSheets().length === 1) ss.insertSheet('~sementara');
        ss.deleteSheet(s);
      }
    });
  }
  state.step = 'TABLE';
}

function resetTableOutputs_(state, unit, table) {
  var u = state.u;
  // buang bagian paket tabel ini dari percobaan sebelumnya
  driveList_("'" + escapeQ_(u.pkg) + "' in parents and trashed = false and appProperties has { key='table' and value='" + escapeQ_(table) + "' }", 'id').forEach(function (f) { driveTrash_(f.id); });
  if (u.mirror) {
    var ss = SpreadsheetApp.openById(u.ssId);
    var tmp = ss.getSheetByName(TMP_PREFIX + sheetNameFor_(table));
    if (tmp) { if (ss.getSheets().length === 1) ss.insertSheet('~sementara'); ss.deleteSheet(tmp); }
  }
  u.after = null; u.total = null; u.written = 0; u.part = 0;
}

function stepTable_(state) {
  var unit = currentUnit_(state);
  var u = state.u;
  var tables = unitTables_(state, unit);
  var table = tables[u.ti];
  var keyCols = state.tables[table];
  if (!keyCols) throw new Error('Tabel tidak dikenal server: ' + table);
  if (u.retrying) {
    resetTableOutputs_(state, unit, table);
    u.retrying = false;
  }
  var page = fetchPage_(unit.id, table, u.after);
  if (u.after === null) u.total = page.total;
  var rows = page.rows;
  if (rows.length) {
    var columns = mirrorColumns_(table, rows);
    if (u.mirror) {
      var ss = SpreadsheetApp.openById(u.ssId);
      var tmpName = TMP_PREFIX + sheetNameFor_(table);
      var sheet = ss.getSheetByName(tmpName);
      if (!sheet) {
        sheet = ss.insertSheet(tmpName);
        sheet.hideSheet();
        writeBlock_(sheet, 1, [columns.map(function (c) { return c.header; })]);
      }
      u.cells += rows.length * columns.length;
      if (u.cells > SHEET_CELL_CAP) throw new Error('Batas ukuran Google Sheets hampir tercapai (' + table + '); cermin tidak dapat dilanjutkan.');
      writeBlock_(sheet, u.written + 2, rowsToValues_(columns, rows));
    }
    // paket backup: bagian NDJSON.gz (isi lengkap, termasuk kolom terenkripsi apa adanya)
    var name = partName_(table, u.part + 1);
    var gz = Utilities.gzip(Utilities.newBlob(rowsToNdjson_(rows), 'application/x-ndjson', name.replace(/\.gz$/, '')), name).getBytes();
    var sha = sha256Hex_(gz);
    driveUpload_(u.pkg, name, gz, 'application/gzip', { table: table, part: String(u.part + 1), rows: String(rows.length), sha256: sha });
    var inv = extractInventory_(table, rows);
    if (inv.length) {
      var iname = partName_('_drive_inventory', u.invParts + 1);
      var igz = Utilities.gzip(Utilities.newBlob(rowsToNdjson_(inv), 'application/x-ndjson', iname.replace(/\.gz$/, '')), iname).getBytes();
      driveUpload_(u.pkg, iname, igz, 'application/gzip', { table: '_drive_inventory', part: String(u.invParts + 1), rows: String(inv.length), sha256: sha256Hex_(igz) });
      u.invParts += 1;
      u.inv += inv.length;
    }
    u.written += rows.length;
    u.part += 1;
    u.after = keysetAfter_(keyCols, rows[rows.length - 1]);
  }
  var done = rows.length === 0 || (rows.length < PAGE_LIMIT && u.written >= u.total);
  if (!done) return;
  if (u.written !== u.total) {
    if (u.attempt >= 1) throw new Error('Jumlah baris tidak cocok untuk ' + table + ': ditulis ' + u.written + ', server ' + u.total);
    u.attempt += 1; // coba ulang tabel ini sekali dari awal
    u.retrying = true;
    u.after = null; u.total = null; u.written = 0; u.part = 0;
    return;
  }
  if (u.mirror && u.written > 0) {
    var tmp = SpreadsheetApp.openById(u.ssId).getSheetByName(TMP_PREFIX + sheetNameFor_(table));
    if (!tmp || tmp.getLastRow() - 1 !== u.written) throw new Error('Cermin ' + table + ' tidak sesuai jumlah baris yang ditulis.');
  }
  u.rows[table] = u.written;
  u.ti += 1;
  u.after = null; u.total = null; u.written = 0; u.part = 0; u.attempt = 0; u.retrying = false;
  if (u.ti >= tables.length) state.step = u.mirror ? 'REPORTS' : 'MANIFEST';
}

function stepReports_(state) {
  var unit = currentUnit_(state);
  var u = state.u;
  var ss = SpreadsheetApp.openById(u.ssId);
  var bSheet = ss.getSheetByName(TMP_PREFIX + sheetNameFor_('berkas'));
  var iSheet = ss.getSheetByName(TMP_PREFIX + sheetNameFor_('item'));
  var nB = u.rows.berkas || 0;
  var nI = u.rows.item || 0;
  var berkasObjs = bSheet && nB ? columnsToObjects_(readColumns_(bSheet, 1, ['BERKAS_ID', 'NO_BERKAS_DEFINITIF', 'STATUS_PEMINDAHAN', 'IS_DELETED', 'JUDUL_BERKAS', 'KODE_KLASIFIKASI_SNAPSHOT', 'KURUN_WAKTU', 'STATUS_RETENSI', 'NO_FILLING_KABINET', 'NO_LACI', 'BATAS_AKTIF', 'KLASIFIKASI_KEAMANAN_AKSES'], 2, nB), nB) : [];
  var itemObjs = iSheet && nI ? columnsToObjects_(readColumns_(iSheet, 1, ['ITEM_ID', 'BERKAS_ID', 'NO_ITEM_DEFINITIF', 'NO_BERKAS_SNAPSHOT', 'NO_SURAT_DISPLAY', 'KODE_KLASIFIKASI_SNAPSHOT', 'URAIAN_LENGKAP', 'TAHUN_KURUN_WAKTU', 'JUMLAH_HALAMAN', 'TANGGAL_NASKAH', 'TINGKAT_PERKEMBANGAN', 'KLASIFIKASI_KEAMANAN_AKSES', 'DRIVE_FILE_URL', 'IS_DELETED'], 2, nI), nI) : [];
  var rep = buildReports_(berkasObjs, itemObjs);
  var title = function (name) { return [['DAFTAR ' + name + ' – ' + unit.name + ' (' + unit.code + ')'], ['Dibuat otomatis ' + jakartaIso_(new Date(Date.now())) + '. HANYA-BACA: perubahan di sini tidak masuk ke aplikasi.'], ['']]; };
  [[REPORT_BERKAS_SHEET, 'BERKAS', REPORT_BERKAS_HEADERS, rep.berkasRows], [REPORT_ITEM_SHEET, 'ISI BERKAS', REPORT_ITEM_HEADERS, rep.itemRows]].forEach(function (spec) {
    var tmpName = TMP_PREFIX + spec[0];
    var old = ss.getSheetByName(tmpName);
    if (old) ss.deleteSheet(old);
    var sh = ss.insertSheet(tmpName);
    sh.hideSheet();
    var width = spec[2].length;
    var head = title(spec[1]).map(function (r) { return r.concat(new Array(width - 1).fill('')); });
    writeBlock_(sh, 1, head.concat([spec[2]]));
    writeBlock_(sh, REPORT_HEADER_ROW + 1, spec[3].map(function (r) { return r.map(safeCell_); }));
  });
  u.rows['_laporan_berkas'] = rep.berkasRows.length;
  u.rows['_laporan_item'] = rep.itemRows.length;
  state.step = 'SWAP';
}

function stepSwap_(state) {
  var unit = currentUnit_(state);
  var u = state.u;
  var ss = SpreadsheetApp.openById(u.ssId);
  var order = [REPORT_BERKAS_SHEET, REPORT_ITEM_SHEET].concat(unitTables_(state, unit).map(sheetNameFor_));
  // Setiap tab diganti satu per satu dan kemajuan disimpan (u.si): bila terputus, dilanjutkan tanpa menimpa tab yang sudah baru.
  for (var i = u.si || 0; i < order.length; i++) {
    var name = order[i];
    var tmp = ss.getSheetByName(TMP_PREFIX + name);
    if (!tmp) {
      tmp = ss.insertSheet(TMP_PREFIX + name); // tabel kosong: tab berisi catatan saja
      writeBlock_(tmp, 1, [['(kosong)']]);
    }
    var cur = ss.getSheetByName(name);
    if (cur) cur.setName(OLD_PREFIX + name);
    tmp.setName(name);
    tmp.showSheet();
    tmp.setFrozenRows(i < 2 ? REPORT_HEADER_ROW : 1);
    tmp.setTabColor('#9AA0A6');
    var prot = tmp.protect();
    prot.setWarningOnly(true);
    prot.setDescription('Cermin hanya-baca: diganti otomatis setiap malam; perubahan tidak masuk ke aplikasi.');
    u.si = i + 1;
    saveState_(state);
  }
  writeInfo_(state, ss);
  // sisa tab lama ("~lama~"), tab sementara, dan sheet bawaan kosong dibersihkan
  ss.getSheets().forEach(function (s) {
    var n = s.getName();
    if (/^(Sheet|Lembar)\s?\d+$/i.test(n) || n.indexOf(TMP_PREFIX) === 0) ss.deleteSheet(s);
  });
  order.concat([INFO_SHEET]).forEach(function (n, idx) {
    var sh = ss.getSheetByName(n);
    if (sh) { ss.setActiveSheet(sh); ss.moveActiveSheet(idx + 1); }
  });
  SpreadsheetApp.flush();
  var stats = { tables: u.rows, total_rows: sumRows_(u.rows) };
  apiJson_('RUN_FINISH', { run_id: u.runMirror, status: 'SUCCESS', stats: stats, mirror_url: sheetUrl_(u.ssId), mirror_file_id: u.ssId });
  u.mirrorDone = true;
  state.step = 'MANIFEST';
}

function sumRows_(rows) {
  var n = 0;
  Object.keys(rows).forEach(function (k) { if (k.charAt(0) !== '_') n += rows[k]; });
  return n;
}

function writeInfo_(state, ss) {
  var unit = currentUnit_(state);
  var u = state.u;
  removeSheetIfExists_(ss, INFO_SHEET);
  var sh = ss.insertSheet(INFO_SHEET);
  var rows = [
    ['CERMIN CENTRAL FILE – ' + unit.code, ''],
    ['HANYA-BACA', 'Perubahan di sini tidak masuk ke aplikasi. Isi diganti seluruhnya setiap malam.'],
    ['Dibuat pada', jakartaIso_(new Date(Date.now()))],
    ['Unit', unit.name + ' (' + unit.code + ')'],
    ['Versi skema aplikasi', state.schema],
    ['Versi skrip cermin', SCRIPT_VERSION],
    ['Catatan', 'Kolom data pribadi terenkripsi (*_enc) tidak dimuat di cermin. Sel lebih dari 49.000 karakter dipotong; isi lengkap ada di paket backup. Sel berawalan = + - @ ditulis sebagai teks.'],
    ['', ''],
    ['Tab', 'Jumlah baris']
  ];
  unitTables_(state, unit).forEach(function (t) { rows.push([sheetNameFor_(t), u.rows[t] || 0]); });
  rows.push([REPORT_BERKAS_SHEET, u.rows._laporan_berkas || 0]);
  rows.push([REPORT_ITEM_SHEET, u.rows._laporan_item || 0]);
  writeBlock_(sh, 1, rows.map(function (r) { return [safeCell_(r[0]), safeCell_(r[1])]; }));
  sh.setTabColor('#9AA0A6');
  var p = sh.protect();
  p.setWarningOnly(true);
}

function stepManifest_(state) {
  var unit = currentUnit_(state);
  var u = state.u;
  var files = driveList_("'" + escapeQ_(u.pkg) + "' in parents and trashed = false", 'id,name,size,appProperties');
  var parts = [];
  files.forEach(function (f) {
    var ap = f.appProperties || {};
    if (!ap.table) return;
    parts.push({ table: ap.table, file: f.name, rows: parseInt(ap.rows, 10), bytes: parseInt(f.size, 10), sha256: ap.sha256 });
  });
  var tables = unitTables_(state, unit);
  var manifest = buildManifest_({ createdAt: jakartaIso_(new Date(Date.now())), day: state.day, unit: { id: unit.id, code: unit.code, name: unit.name }, schemaVersion: state.schema, tables: tables }, parts);
  // verifikasi akhir: setiap tabel di paket sama dengan yang ditulis dan dengan total server
  tables.forEach(function (t) {
    if (manifest.tables[t].rows !== (u.rows[t] || 0)) throw new Error('Manifest tidak cocok untuk ' + t + ': ' + manifest.tables[t].rows + ' vs ' + (u.rows[t] || 0));
  });
  if (manifest.drive_inventory.rows !== u.inv) throw new Error('Manifest tidak cocok untuk inventaris file Drive.');
  driveUpload_(u.pkg, 'manifest.json', Utilities.newBlob(JSON.stringify(manifest, null, 1)).getBytes(), 'application/json', { cfBackup: '1', manifest: '1' });
  // ganti paket hari yang sama (jalan ulang manual), lalu beri nama akhir
  driveList_("'" + escapeQ_(u.backupFolder) + "' in parents and trashed = false and name = '" + escapeQ_(state.day) + "'", 'id,appProperties').forEach(function (f) {
    if (f.appProperties && f.appProperties.cfBackup === '1') driveTrash_(f.id);
  });
  driveRename_(u.pkg, state.day);
  runRetention_(u.backupFolder, state.day);
  apiJson_('RUN_FINISH', {
    run_id: u.runBackup, status: 'SUCCESS', backup_file_id: u.pkg,
    stats: { tables: u.rows, total_rows: manifest.total_rows, drive_files: manifest.drive_inventory.rows, schema_version: state.schema, parts: parts.length }
  });
  u.backupDone = true;
  state.step = 'UNIT_END';
}

function runRetention_(backupFolderId, today) {
  var kids = driveList_("'" + escapeQ_(backupFolderId) + "' in parents and trashed = false and mimeType = '" + FOLDER_MIME + "'", 'id,name,appProperties');
  var ours = {};
  kids.forEach(function (f) { if (f.appProperties && f.appProperties.cfBackup === '1') ours[f.name] = f.id; });
  var sel = selectRetention_(Object.keys(ours), today);
  sel.remove.forEach(function (n) { driveTrash_(ours[n]); });
  return sel;
}

function failUnit_(state, err) {
  var unit = currentUnit_(state);
  var u = state.u || {};
  var msg = sanitizeError_(err);
  console.error('Unit ' + unit.code + ' gagal: ' + msg);
  var result = { unit: unit.code, mirror: unit.bo ? '-' : (u.mirrorDone ? 'SUCCESS' : 'FAILED'), backup: u.backupDone ? 'SUCCESS' : 'FAILED', error: msg };
  [['runMirror', 'mirrorDone'], ['runBackup', 'backupDone']].forEach(function (pair) {
    if (u[pair[0]] && !u[pair[1]]) {
      try { apiJson_('RUN_FINISH', { run_id: u[pair[0]], status: 'FAILED', stats: { tables: u.rows || {} }, error: msg }); } catch (e) { console.error('RUN_FINISH gagal: ' + sanitizeError_(e)); }
    }
  });
  if (u.pkg && !u.backupDone) { try { driveTrash_(u.pkg); } catch (e2) { /* biarkan; dibuang pada awal unit berikutnya */ } }
  state.results.push(result);
  state.u = null;
  state.ui += 1;
  state.step = 'UNIT_BEGIN';
}

/** Satu langkah terbatas (satu halaman atau satu fase). Mengembalikan false bila semua unit selesai. */
function stepOnce_(state) {
  if (state.ui >= state.units.length) return false;
  try {
    switch (state.step) {
      case 'UNIT_BEGIN': stepUnitBegin_(state); break;
      case 'TABLE': stepTable_(state); break;
      case 'REPORTS': stepReports_(state); break;
      case 'SWAP': stepSwap_(state); break;
      case 'MANIFEST': stepManifest_(state); break;
      case 'UNIT_END': {
        var unit = currentUnit_(state);
        state.results.push({ unit: unit.code, mirror: unit.bo ? '-' : 'SUCCESS', backup: 'SUCCESS', total_rows: sumRows_(state.u.rows) });
        state.u = null;
        state.ui += 1;
        state.step = 'UNIT_BEGIN';
        break;
      }
      default: throw new Error('Langkah tidak dikenal: ' + state.step);
    }
  } catch (err) {
    failUnit_(state, err);
  }
  return state.ui < state.units.length;
}

function deleteContinuationTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === HANDLER_CONTINUE) ScriptApp.deleteTrigger(t);
  });
}

function scheduleContinuation_() {
  deleteContinuationTriggers_();
  ScriptApp.newTrigger(HANDLER_CONTINUE).timeBased().after(CONTINUE_DELAY_MS).create();
}

/**
 * Inti pekerjaan. Mengembalikan 'DONE' | 'CONTINUE' | 'LOCKED'. Melempar galat bila API tidak dapat dijangkau sama sekali
 * atau bila ada unit yang gagal (agar Google mengirim email kegagalan ke pemilik skrip).
 */
function runJob_(options) {
  options = options || {};
  var startedAt = Date.now();
  var deadline = startedAt + (options.budgetMs || TIME_BUDGET_MS);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    console.warn('Cermin: pekerjaan lain sedang berjalan; dilewati.');
    return 'LOCKED';
  }
  try {
    deleteContinuationTriggers_();
    var state = loadState_();
    if (state && Date.now() - state.startedAt > STATE_STALE_MS) {
      abandonState_(state);
      state = null;
    }
    if (!state) state = freshState_(Date.now());
    saveState_(state);
    while (stepOnce_(state)) {
      saveState_(state);
      var heavy = state.step === 'REPORTS' || state.step === 'SWAP' || state.step === 'MANIFEST';
      // fase berat (baca-balik, penggantian tab, manifest) tidak dimulai bila sisa waktu kurang dari 2 menit
      if (Date.now() >= deadline || (heavy && Date.now() - startedAt > 30000 && deadline - Date.now() < HEAVY_MIN_MS)) {
        scheduleContinuation_();
        console.log('Cermin: waktu habis; dilanjutkan otomatis (unit ' + (state.ui + 1) + '/' + state.units.length + ', langkah ' + state.step + ').');
        return 'CONTINUE';
      }
    }
    var failed = state.results.filter(function (r) { return r.error; });
    clearState_();
    console.log('Cermin selesai: ' + JSON.stringify(state.results));
    if (failed.length) throw new Error('Cermin/backup selesai dengan ' + failed.length + ' unit gagal: ' + failed.map(function (r) { return r.unit; }).join(', '));
    return 'DONE';
  } finally {
    lock.releaseLock();
  }
}

/** Status lama yang tidak pernah selesai: laporkan GAGAL agar halaman admin tidak menampilkan "berjalan" selamanya. */
function abandonState_(state) {
  var u = state.u || {};
  [u.runMirror, u.runBackup].forEach(function (id, i) {
    var done = i === 0 ? u.mirrorDone : u.backupDone;
    if (id && !done) {
      try { apiJson_('RUN_FINISH', { run_id: id, status: 'FAILED', stats: {}, error: 'Dihentikan: pekerjaan tidak selesai dalam 12 jam.' }); } catch (e) { /* diabaikan */ }
    }
  });
  clearState_();
}

// ---------------------------------------------------------------------------
// Pemicu
// ---------------------------------------------------------------------------
function nightlyMirror() { return runJob_({}); }
function continueMirror() { return runJob_({}); }

// ===========================================================================
// OPERATOR
// ===========================================================================
function randomSecret_() {
  var s = '';
  for (var i = 0; i < 3; i++) s += Utilities.getUuid().replace(/-/g, '');
  return s;
}

function driveCheck_() {
  // cakupan drive.file: mendaftar file buatan proyek ini (kosong pada awalnya) membuktikan token Drive berlaku
  driveRequest_('get', DRIVE_API + '/files?pageSize=1&fields=files(id)');
}

/**
 * Langkah 1. Membuat JOB_SECRET acak (sekali) dan menampilkannya SEKALI di log. Salin ke Cloudflare Pages
 * (Variables and Secrets, tipe Secret) dengan nama JOB_SECRET. Jangan ke chat atau repo.
 */
function setupMirror() {
  var existing = props_().getProperty(P_SECRET);
  if (existing) {
    var again = 'JOB_SECRET sudah ada (tidak diganti). Untuk membuat yang baru jalankan rotateJobSecret(), lalu perbarui Cloudflare.';
    Logger.log(again);
    console.log(again);
    checkDriveAccess_();
    return null;
  }
  var secret = randomSecret_();
  props_().setProperty(P_SECRET, secret);
  var message = 'JOB_SECRET baru (salin ke Cloudflare Pages sebagai Secret bernama JOB_SECRET; jangan dibagikan): ' + secret +
    ' | Berikutnya: isi alamat aplikasi dengan setBaseUrl("https://...") lalu installNightlyTrigger().';
  Logger.log(message);
  console.log(message);
  checkDriveAccess_();
  return secret;
}

function checkDriveAccess_() {
  try {
    driveCheck_();
    Logger.log('Akses Drive (file buatan proyek ini) OK.');
  } catch (e) {
    Logger.log('Peringatan: akses Drive belum berhasil (' + sanitizeError_(e) + '). Izinkan akses saat diminta lalu jalankan ulang setupMirror().');
  }
}

function rotateJobSecret() {
  var secret = randomSecret_();
  props_().setProperty(P_SECRET, secret);
  var message = 'JOB_SECRET diganti (salin ke Cloudflare Pages sebagai Secret JOB_SECRET; yang lama langsung tidak berlaku): ' + secret;
  Logger.log(message);
  console.log(message);
  return secret;
}

/** Alamat dasar aplikasi, mis. https://central-file.pages.dev (tanpa jalur). */
function setBaseUrl(url) {
  var m = /^https:\/\/([A-Za-z0-9.-]+)(:\d+)?\/?$/.exec(String(url || '').trim());
  if (!m || m[1].indexOf('.') < 0) throw new Error('Alamat tidak valid. Contoh: https://central-file.pages.dev (wajib https, tanpa jalur).');
  var base = 'https://' + m[1] + (m[2] || '');
  props_().setProperty(P_BASE, base);
  Logger.log('Alamat aplikasi disimpan: ' + base);
  return base;
}

/** Cara mudah bagi operator: ubah teks ALAMAT di bawah, lalu Jalankan fungsi ini. */
function aturAlamatAplikasi() {
  var ALAMAT = 'https://GANTI-DENGAN-ALAMAT-APLIKASI.pages.dev';
  return setBaseUrl(ALAMAT);
}

/** Satu pemicu harian 01:00–02:00 (zona waktu skrip Asia/Jakarta). Aman dijalankan berulang. */
function installNightlyTrigger() {
  var existing = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === HANDLER_NIGHTLY; });
  if (existing.length === 1) {
    Logger.log('Pemicu malam sudah ada (satu). Tidak ada perubahan.');
    return 'ADA';
  }
  existing.forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger(HANDLER_NIGHTLY).timeBased().everyDays(1).atHour(1).create();
  Logger.log('Pemicu malam dipasang: setiap hari antara 01:00 dan 02:00 (Asia/Jakarta).');
  return 'DIPASANG';
}

function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var h = t.getHandlerFunction();
    if (h === HANDLER_NIGHTLY || h === HANDLER_CONTINUE) ScriptApp.deleteTrigger(t);
  });
}

/** Jalankan sekarang (manual). Bila ada pekerjaan yang belum selesai (< 12 jam), dilanjutkan. */
function runNow() {
  return runJob_({});
}

/** Buang status pekerjaan yang macet (tidak menghapus apa pun di Drive). */
function resetJob() {
  deleteContinuationTriggers_();
  clearState_();
  Logger.log('Status pekerjaan dihapus.');
}

function statusMirror() {
  var state = loadState_();
  var msg = state
    ? 'Berjalan: unit ' + (state.ui + 1) + '/' + state.units.length + ', langkah ' + state.step + ', mulai ' + jakartaIso_(new Date(state.startedAt)) + '. Hasil sejauh ini: ' + JSON.stringify(state.results)
    : 'Tidak ada pekerjaan yang sedang berjalan.';
  Logger.log(msg);
  return msg;
}
