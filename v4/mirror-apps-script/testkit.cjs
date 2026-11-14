// Test kit for Code.gs: loads the script in a vm context with fake Apps Script services
// (Utilities, PropertiesService, LockService, ScriptApp, UrlFetchApp, SpreadsheetApp, Drive REST behind UrlFetchApp)
// and a controllable clock. Used by mirror.test.cjs and by v4/tools/restore-backup/test (round trip).
//
// Fidelity notes (what is FAKED, so tests do not over-claim):
//  * Drive REST: in-memory; understands the small subset of the v4 API the script uses (files.list with q, get,
//    create, patch, media upload). Files of other apps ("foreign") are invisible and untouchable, like drive.file.
//  * Spreadsheets: in-memory grid with bounds checks (setValues outside the sheet throws), unique tab names,
//    "cannot delete the last visible sheet", 50 000-character cell limit, and a formula detector (a string cell that
//    starts with "=" is counted in world.formulaCells; the guard must keep this at 0).
//  * Real Sheets/Drive/UrlFetch latency, quotas and exact error behaviour are NOT reproduced.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const crypto = require('crypto');

const SOURCE = fs.readFileSync(path.join(__dirname, 'Code.gs'), 'utf8');
const toSigned = (buf) => Array.from(buf, (b) => (b > 127 ? b - 256 : b));
const fromBytes = (arr) => (Buffer.isBuffer(arr) ? arr : Buffer.from(Array.from(arr, (b) => b & 0xff)));
/** Values built inside the vm have another realm's prototypes; compare them through JSON. */
const plain = (x) => JSON.parse(JSON.stringify(x));

function makeBlob(data, contentType, name) {
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : fromBytes(data);
  return {
    _bytes: bytes, getBytes: () => toSigned(bytes), getName: () => name || '', getContentType: () => contentType || 'application/octet-stream',
    getDataAsString: () => bytes.toString('utf8'),
  };
}

// ---------------------------------------------------------------------------
// Fake Drive (REST) -- drive.file semantics
// ---------------------------------------------------------------------------
function makeDrive(world) {
  const files = new Map();
  let seq = 0;
  const api = {
    files,
    log: [],
    pageSize: null, // override page size to exercise pagination
    addForeign(meta) {
      const id = meta.id || `foreign${++seq}`;
      files.set(id, { id, name: meta.name, mimeType: meta.mimeType || 'application/pdf', parents: meta.parents || [], trashed: false, appProperties: {}, bytes: Buffer.alloc(0), foreign: true });
      return id;
    },
    visible: (f) => f && !f.foreign,
    byName(name, parent) {
      return [...files.values()].filter((f) => !f.foreign && f.name === name && (!parent || f.parents.includes(parent)));
    },
    children(parent, { trashed = false } = {}) {
      return [...files.values()].filter((f) => !f.foreign && f.parents.includes(parent) && f.trashed === trashed);
    },
    bytesOf: (id) => files.get(id).bytes,
  };

  function matchQ(f, q) {
    let rest = q;
    const checks = [];
    rest = rest.replace(/appProperties has \{ key='((?:[^'\\]|\\.)*)' and value='((?:[^'\\]|\\.)*)' \}/g, (_m, k, v) => { checks.push((x) => String((x.appProperties || {})[unesc(k)]) === unesc(v)); return ''; });
    for (const clause of rest.split(' and ').map((c) => c.trim()).filter(Boolean)) {
      let m;
      if ((m = /^'((?:[^'\\]|\\.)*)' in parents$/.exec(clause))) checks.push((x) => x.parents.includes(unesc(m[1])));
      else if ((m = /^name = '((?:[^'\\]|\\.)*)'$/.exec(clause))) checks.push((x) => x.name === unesc(m[1]));
      else if ((m = /^trashed = (true|false)$/.exec(clause))) checks.push((x) => x.trashed === (m[1] === 'true'));
      else if ((m = /^mimeType = '([^']*)'$/.exec(clause))) checks.push((x) => x.mimeType === m[1]);
      else throw new Error(`fake drive: unsupported q clause: ${clause}`);
    }
    return checks.every((c) => c(f));
  }
  const unesc = (s) => s.replace(/\\(.)/g, '$1');
  const pick = (f, fields) => {
    const out = {};
    const want = String(fields || 'id').replace(/files\(|\)/g, '').split(',');
    for (const k of want) {
      if (k === 'size') out.size = String(f.bytes.length);
      else if (k in f) out[k] = f[k];
    }
    return out;
  };

  api.handle = function handle(method, url, params) {
    const u = new URL(url);
    const p = u.pathname;
    const body = params && params.payload;
    api.log.push({ method, path: p, query: u.search });
    const reply = (code, obj) => ({ code, text: obj === null ? '' : JSON.stringify(obj) });
    let m;
    if (method === 'get' && p === '/drive/v3/files') {
      const q = u.searchParams.get('q') || '';
      const fields = u.searchParams.get('fields') || '';
      const size = api.pageSize || Number(u.searchParams.get('pageSize') || 100);
      const all = [...files.values()].filter((f) => !f.foreign && matchQ(f, q));
      const start = Number(u.searchParams.get('pageToken') || 0);
      const slice = all.slice(start, start + size);
      const out = { files: slice.map((f) => pick(f, fields.replace('nextPageToken,', ''))) };
      if (start + size < all.length) out.nextPageToken = String(start + size);
      return reply(200, out);
    }
    if ((m = /^\/drive\/v3\/files\/([^/]+)$/.exec(p))) {
      const f = files.get(decodeURIComponent(m[1]));
      if (!f || f.foreign) return reply(404, { error: { code: 404 } });
      if (method === 'get') return reply(200, pick(f, u.searchParams.get('fields')));
      if (method === 'patch') {
        const meta = JSON.parse(body);
        if ('name' in meta) f.name = meta.name;
        if ('trashed' in meta) f.trashed = meta.trashed;
        if (meta.appProperties) f.appProperties = { ...f.appProperties, ...meta.appProperties };
        api.log.push({ mutates: f.id, kind: 'meta', meta });
        return reply(200, { id: f.id });
      }
    }
    if (method === 'post' && p === '/drive/v3/files') {
      const meta = JSON.parse(body);
      const id = `drv${String(++seq).padStart(6, '0')}${crypto.randomBytes(6).toString('hex')}`;
      const f = { id, name: meta.name, mimeType: meta.mimeType, parents: meta.parents || [], trashed: false, appProperties: meta.appProperties || {}, bytes: Buffer.alloc(0) };
      files.set(id, f);
      if (f.mimeType === 'application/vnd.google-apps.spreadsheet') world.sheetsBook.create(id);
      return reply(200, { id, name: f.name });
    }
    if ((m = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(p)) && method === 'patch') {
      const f = files.get(decodeURIComponent(m[1]));
      if (!f || f.foreign) return reply(404, {});
      f.bytes = fromBytes(body);
      api.log.push({ mutates: f.id, kind: 'media' });
      return reply(200, { id: f.id });
    }
    return reply(400, { error: 'fake drive: unsupported ' + method + ' ' + p });
  };
  return api;
}

// ---------------------------------------------------------------------------
// Fake Spreadsheet service
// ---------------------------------------------------------------------------
function makeSheetsBook(world) {
  const books = new Map();
  const book = { books, formulaCells: 0, deletedSheets: [], hooks: {} };

  function newSheet(ss, name) {
    if (ss.sheets.some((s) => s.name === name)) throw new Error(`A sheet with the name "${name}" already exists. Please enter another name.`);
    const sh = { name, hidden: false, maxRows: 1000, maxCols: 26, cells: new Map(), protections: [], frozen: 0, tabColor: null };
    ss.sheets.push(sh);
    return sh;
  }
  const visible = (ss) => ss.sheets.filter((s) => !s.hidden);

  book.create = (id) => {
    const ss = { id, sheets: [] };
    newSheet(ss, 'Sheet1');
    books.set(id, ss);
  };

  function sheetApi(ss, sh) {
    const api = {
      getName: () => sh.name,
      setName(n) { if (book.hooks.beforeSetName) book.hooks.beforeSetName(sh.name, n); if (n !== sh.name && ss.sheets.some((s) => s.name === n)) throw new Error(`A sheet with the name "${n}" already exists.`); sh.name = n; return api; },
      getMaxRows: () => sh.maxRows,
      getMaxColumns: () => sh.maxCols,
      insertRowsAfter(pos, n) { sh.maxRows += n; },
      insertColumnsAfter(pos, n) { sh.maxCols += n; },
      getLastRow() { let m = 0; for (const k of sh.cells.keys()) { const [r] = k.split(',').map(Number); m = Math.max(m, r); } return m; },
      getLastColumn() { let m = 0; for (const k of sh.cells.keys()) { const c = Number(k.split(',')[1]); m = Math.max(m, c); } return m; },
      hideSheet() { if (visible(ss).length === 1 && !sh.hidden) throw new Error('You cannot hide the only visible sheet.'); sh.hidden = true; return api; },
      showSheet() { sh.hidden = false; return api; },
      isSheetHidden: () => sh.hidden,
      setFrozenRows(n) { sh.frozen = n; },
      setTabColor(c) { sh.tabColor = c; return api; },
      clear() { sh.cells.clear(); return api; },
      protect() {
        const prot = { warningOnly: false, description: '' };
        sh.protections.push(prot);
        const o = { setWarningOnly(b) { prot.warningOnly = b; return o; }, setDescription(d) { prot.description = d; return o; } };
        return o;
      },
      getRange(r, c, nr = 1, nc = 1) {
        if (r < 1 || c < 1 || r + nr - 1 > sh.maxRows || c + nc - 1 > sh.maxCols) throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
        return {
          setValues(values) {
            if (values.length !== nr || values.some((row) => row.length !== nc)) throw new Error('The number of rows or columns in the data does not match the number in the range.');
            values.forEach((row, i) => row.forEach((v, j) => {
              let val = v;
              if (typeof val === 'string') {
                if (val.length > 50000) throw new Error('Your input contains more than the maximum of 50000 characters in a single cell.');
                if (val.startsWith('=')) book.formulaCells++;
                if (/^\d{4}-\d{2}-\d{2}$/.test(val)) val = new Date(`${val}T00:00:00Z`); // Sheets parses typed dates
              }
              const key = `${r + i},${c + j}`;
              if (val === '' || val === null || val === undefined) sh.cells.delete(key); else sh.cells.set(key, val);
            }));
            return this;
          },
          getValues() {
            const out = [];
            for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) row.push(sh.cells.has(`${r + i},${c + j}`) ? sh.cells.get(`${r + i},${c + j}`) : ''); out.push(row); }
            return out;
          },
        };
      },
    };
    return api;
  }

  book.SpreadsheetApp = {
    openById(id) {
      const ss = books.get(id);
      if (!ss) throw new Error(`Unexpected error while getting the method or property openById on object SpreadsheetApp.`);
      const apis = new Map();
      const wrap = (sh) => { if (!apis.has(sh)) apis.set(sh, sheetApi(ss, sh)); return apis.get(sh); };
      const rawOf = (api) => ss.sheets.find((s) => wrap(s) === api);
      return {
        getId: () => id,
        getUrl: () => `https://docs.google.com/spreadsheets/d/${id}/edit`,
        getSheets: () => ss.sheets.map(wrap),
        getSheetByName: (n) => { const s = ss.sheets.find((x) => x.name === n); return s ? wrap(s) : null; },
        insertSheet(n) { return wrap(newSheet(ss, n)); },
        deleteSheet(api) {
          const raw = rawOf(api);
          if (!raw) throw new Error('sheet not in this spreadsheet');
          if (!raw.hidden && visible(ss).length === 1) throw new Error("You can't delete the last visible sheet.");
          if (ss.sheets.length === 1) throw new Error("You can't delete the last sheet.");
          ss.sheets.splice(ss.sheets.indexOf(raw), 1);
          book.deletedSheets.push(raw.name);
        },
        setActiveSheet(api) { ss.active = rawOf(api); },
        moveActiveSheet(pos) { const raw = ss.active; ss.sheets.splice(ss.sheets.indexOf(raw), 1); ss.sheets.splice(pos - 1, 0, raw); },
      };
    },
    flush() {},
  };

  /** Test accessor: visible tabs with 2D values. */
  book.tabs = (id) => (books.get(id)?.sheets ?? []).map((s) => s.name);
  book.read = (id, name) => {
    const ss = books.get(id);
    const sh = ss && ss.sheets.find((s) => s.name === name);
    if (!sh) return null;
    const api = sheetApi(ss, sh);
    const lr = api.getLastRow();
    const lc = api.getLastColumn();
    return lr && lc ? api.getRange(1, 1, lr, lc).getValues() : [];
  };
  book.raw = (id, name) => books.get(id)?.sheets.find((s) => s.name === name);
  return book;
}

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------
function createWorld(options = {}) {
  const clock = { now: options.now ?? Date.UTC(2026, 10, 14, 18, 5, 0) }; // 2026-11-15 01:05 Asia/Jakarta
  const RealDate = Date;
  function FakeDate(...a) { return a.length ? new RealDate(...a) : new RealDate(clock.now); }
  FakeDate.now = () => clock.now;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.parse = RealDate.parse;
  FakeDate.prototype = RealDate.prototype;

  const world = { clock, logs: [], props: new Map(), triggers: [], lockBusy: false, fetchLog: [], sleeps: 0 };
  world.sheetsBook = makeSheetsBook(world);
  world.drive = makeDrive(world);
  world.apiHandler = options.apiHandler || (() => ({ status: 500, text: '{}', headers: {} }));
  let trigSeq = 0;

  const Utilities = {
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    newBlob: makeBlob,
    computeDigest: (alg, bytes) => toSigned(crypto.createHash('sha256').update(typeof bytes === 'string' ? Buffer.from(bytes) : fromBytes(bytes)).digest()),
    computeHmacSha256Signature: (value, key) => toSigned(crypto.createHmac('sha256', fromBytes(key)).update(fromBytes(value)).digest()),
    gzip: (blob, name) => makeBlob(zlib.gzipSync(blob._bytes, { level: 6 }), 'application/x-gzip', name),
    getUuid: () => crypto.randomUUID(),
    sleep: (ms) => { world.sleeps += 1; clock.now += ms; },
    formatDate(date, tz, pattern) {
      if (tz !== 'Asia/Jakarta') throw new Error('fake formatDate: only Asia/Jakarta');
      const d = new RealDate(date.getTime() + 7 * 3600 * 1000);
      const iso = d.toISOString();
      if (pattern === 'yyyy-MM-dd') return iso.slice(0, 10);
      if (pattern === "yyyy-MM-dd'T'HH:mm:ssXXX") return `${iso.slice(0, 19)}+07:00`;
      throw new Error(`fake formatDate: pattern ${pattern}`);
    },
  };

  const response = (code, text, headers = {}) => ({ getResponseCode: () => code, getContentText: () => text, getHeaders: () => headers });
  const UrlFetchApp = {
    fetch(url, params = {}) {
      world.fetchLog.push({ url, method: params.method, headers: params.headers });
      if (options.fetchFault) { const f = options.fetchFault(url, params, world); if (f === 'throw') throw new Error('Exception: Address unavailable'); if (f) return response(f.code, f.text || '', f.headers || {}); }
      const base = world.props.get('BASE_URL');
      if (base && url === `${base}/api/jobs/export`) {
        const out = world.apiHandler(JSON.parse(params.payload), params);
        return response(out.status, out.text, out.headers || {});
      }
      if (/^https:\/\/www\.googleapis\.com\/(upload\/)?drive\/v3\//.test(url)) {
        if (!params.headers || params.headers.Authorization !== 'Bearer ya29.FAKE_OAUTH') return response(401, '{}');
        const out = world.drive.handle(params.method, url, params);
        return response(out.code, out.text);
      }
      throw new Error(`fake UrlFetchApp: unexpected URL ${url}`);
    },
  };

  const triggerObj = (h, spec) => ({ getHandlerFunction: () => h, getUniqueId: () => spec.id, spec });
  const ScriptApp = {
    getOAuthToken: () => 'ya29.FAKE_OAUTH',
    getProjectTriggers: () => world.triggers.map((t) => triggerObj(t.handler, t)),
    deleteTrigger: (t) => { world.triggers = world.triggers.filter((x) => x.id !== t.getUniqueId()); },
    newTrigger(handler) {
      const spec = { id: `t${++trigSeq}`, handler };
      const b = {
        timeBased: () => b,
        after: (ms) => { spec.afterMs = ms; return b; },
        everyDays: (n) => { spec.everyDays = n; return b; },
        atHour: (h) => { spec.atHour = h; return b; },
        create: () => { world.triggers.push(spec); return triggerObj(handler, spec); },
      };
      return b;
    },
  };

  const ctx = vm.createContext({
    console: { log: (m) => world.logs.push(['log', String(m)]), warn: (m) => world.logs.push(['warn', String(m)]), error: (m) => world.logs.push(['error', String(m)]) },
    Logger: { log: (m) => world.logs.push(['log', String(m)]) },
    Date: FakeDate,
    Utilities,
    UrlFetchApp,
    ScriptApp,
    SpreadsheetApp: world.sheetsBook.SpreadsheetApp,
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (world.props.has(k) ? world.props.get(k) : null),
      setProperty: (k, v) => { world.props.set(k, String(v)); },
      deleteProperty: (k) => { world.props.delete(k); },
    }) },
    LockService: { getScriptLock: () => ({ tryLock: () => !world.lockBusy, releaseLock: () => { world.lockReleased = (world.lockReleased || 0) + 1; } }) },
  });
  vm.runInContext(SOURCE, ctx);
  world.ctx = ctx;
  world.call = (fn, ...args) => ctx[fn](...args);
  world.configure = ({ base = 'https://app.example.pages.dev', secret = 'S'.repeat(48) } = {}) => { world.props.set('BASE_URL', base); world.props.set('JOB_SECRET', secret); return { base, secret }; };
  return world;
}

// ---------------------------------------------------------------------------
// Independent verifier + in-memory API (the "server" for unit tests). Same contract as server/jobsExport.ts.
// ---------------------------------------------------------------------------
function canonicalJson(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object') return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

function makeFakeApi({ secret, units, data, tables, schema = '0022', maxRows = 1000, nowMs = () => Date.now(), fail = null }) {
  const seen = new Set();
  const api = { requests: [], runs: new Map(), finishes: [], handler: null, seen };
  const keyOf = (t) => tables[t].key;
  api.handler = (body) => {
    api.requests.push(body);
    const { action, ts, nonce, sig, ...params } = body;
    const expected = crypto.createHmac('sha256', secret).update(`CFJOB1\n${action}\n${ts}\n${nonce}\n${crypto.createHash('sha256').update(canonicalJson(params)).digest('hex')}`).digest('hex');
    const denied = { status: 401, text: JSON.stringify({ ok: false, code: 'JOB_DENIED' }) };
    if (sig !== expected || Math.abs(Math.floor(nowMs() / 1000) - ts) > 120 || seen.has(nonce)) return denied;
    seen.add(nonce);
    const injected = fail && fail(action, params, api);
    if (injected) return injected;
    if (action === 'LIST_UNITS') {
      return { status: 200, text: JSON.stringify({ ok: true, schema_version: schema, max_page_limit: 2000, tables, units }) };
    }
    if (action === 'TABLE_PAGE') {
      const rows = (data[params.unit_id] || {})[params.table] || [];
      const keys = keyOf(params.table);
      const cmp = (a, b) => { for (const k of keys) { if (a[k] < b[k]) return -1; if (a[k] > b[k]) return 1; } return 0; };
      const sorted = [...rows].sort(cmp);
      let page = sorted;
      if (params.after) page = sorted.filter((r) => { const a = Object.fromEntries(keys.map((k, i) => [k, params.after[i]])); return cmp(r, a) > 0; });
      page = page.slice(0, Math.min(params.limit || 1000, maxRows));
      const headers = params.after ? {} : { 'X-Total-Count': String(rows.length) };
      return { status: 200, text: JSON.stringify(page), headers };
    }
    if (action === 'RUN_BEGIN') {
      const id = crypto.randomUUID();
      api.runs.set(id, { id, kind: params.kind, unit_id: params.unit_id, status: 'RUNNING' });
      return { status: 200, text: JSON.stringify({ ok: true, run_id: id }) };
    }
    if (action === 'RUN_FINISH') {
      const r = api.runs.get(params.run_id);
      if (!r) return { status: 404, text: JSON.stringify({ ok: false, code: 'NOT_FOUND' }) };
      Object.assign(r, { status: params.status, stats: params.stats, mirror_url: params.mirror_url, mirror_file_id: params.mirror_file_id, backup_file_id: params.backup_file_id, error: params.error });
      api.finishes.push(r);
      return { status: 200, text: JSON.stringify({ ok: true }) };
    }
    return { status: 400, text: '{}' };
  };
  return api;
}

module.exports = { createWorld, makeFakeApi, canonicalJson, plain, SOURCE };
