// Core of the legacy importer: workbook -> analysis -> one transaction -> report.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import pg from 'pg';
import { readWorkbook } from './workbook.mjs';
import { convert, ValueError, isBlank, looseInt } from './convert.mjs';
import { TABLES, DEFERRED_SHEETS, REPORT_SHEETS, OPEN_QUESTIONS, SECRET_KEY_RE } from './spec.mjs';

export class FatalImportError extends Error {}

const REQUIRED_SHEETS = ['SETTINGS', 'MASTER_KLASIFIKASI', 'DB_BERKAS', 'DB_ITEM'];
const SAMPLE = 10;

const stableJson = (o) => JSON.stringify(o, Object.keys(o).sort());

function newTableReport(spec) {
  return {
    label: spec.label, sheets: [], read: 0, accepted: 0, inserted: 0, updated: 0, unchanged: 0,
    rejected: 0, rejectedRows: [], duplicateIdenticalRows: 0, inDatabaseNotInExport: 0,
    defaultsApplied: {}, changedColumns: {}
  };
}

/** Value of a settings row according to its TYPE (Repository.readSettings_). */
function settingValue(raw, type) {
  if (isBlank(raw)) return null;
  const t = String(type || 'STRING').toUpperCase();
  if (t === 'BOOLEAN') return convert.bool(raw);
  if (t === 'NUMBER') {
    if (typeof raw === 'number') return raw;
    const n = Number(String(raw).trim());
    if (!Number.isFinite(n)) throw new ValueError(`bukan angka: "${raw}"`);
    return n;
  }
  return convert.text(raw);
}

/** Resolve spec columns against a sheet's headers. */
function resolveColumns(spec, sheet) {
  const present = new Set(sheet.headers);
  const used = new Set();
  const resolved = [];
  const missingOptional = [];
  const missingRequired = [];
  for (const col of spec.columns) {
    const names = Array.isArray(col.h) ? col.h : [col.h];
    const header = names.find((n) => present.has(n));
    if (header) {
      names.filter((n) => present.has(n)).forEach((n) => used.add(n));
    } else if (col.required) {
      missingRequired.push(names[0]);
    } else {
      missingOptional.push(names[0]);
    }
    resolved.push({ ...col, header: header || null });
  }
  const unknown = sheet.headers.filter((h) => !used.has(h));
  return { resolved, unknown, missingOptional, missingRequired };
}

function convertRow(spec, sheetName, row, resolved, tr, notes) {
  const out = {};
  const errors = [];
  const fatal = [];
  for (const col of resolved) {
    const raw = col.header ? row.values[col.header] : null;
    const where = `sheet ${sheetName} baris ${row.rowNumber} kolom ${col.header || (Array.isArray(col.h) ? col.h[0] : col.h)}`;
    let value;
    try {
      if (col.t === 'settingValue') {
        value = settingValue(raw, row.values.TYPE);
      } else if (col.t === 'looseInt') {
        value = looseInt(raw, (s) => notes.looseInt.push({ sheet: sheetName, row: row.rowNumber, column: col.header, value: s }));
      } else {
        value = col.t(raw);
      }
    } catch (error) {
      const msg = `${where}: ${error.message}`;
      if (col.required) fatal.push(msg); else errors.push(msg);
      continue;
    }
    if (value === null && col.required) {
      fatal.push(`${where}: nilai wajib kosong`);
      continue;
    }
    if (value === null && col.def !== undefined) {
      value = col.def;
      tr.defaultsApplied[col.c] = (tr.defaultsApplied[col.c] || 0) + 1;
    }
    out[col.c] = value;
  }
  for (const col of resolved) {
    if (col.fallback && out[col.c] === null) out[col.c] = out[col.fallback] ?? null;
  }
  return { out, errors, fatal };
}

function distinctSample(values) {
  const counts = new Map();
  for (const v of values) {
    const key = v === null || v === undefined || v === '' ? '(kosong)' : (v instanceof Date ? `tanggal ${v.toISOString().slice(0, 10)}` : `${typeof v === 'number' ? 'angka ' : ''}${v}`);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, SAMPLE).map(([value, count]) => ({ value, count }));
}

/** Parse the derived legacy report sheets (DAFTAR BERKAS / DAFTAR ISI BERKAS) by content, not layout. */
function parseLegacyReports(matrices) {
  const result = {};
  const isPosInt = (v) => typeof v === 'number' ? Number.isInteger(v) && v > 0 : /^\d+$/.test(String(v ?? '').trim());
  const num = (v) => Number(String(v ?? '').trim() || 0);
  const berkasRows = matrices.get(REPORT_SHEETS.berkas);
  if (berkasRows) {
    const rows = berkasRows.filter((r) => isPosInt(r[0]) && typeof r[4] === 'string' && r[4].trim());
    result.berkas = {
      sheet: REPORT_SHEETS.berkas, count: rows.length,
      perBerkas: Object.fromEntries(rows.map((r) => [String(num(r[0])), { items: num(r[6]), pages: num(r[7]) }]))
    };
  }
  const itemRows = matrices.get(REPORT_SHEETS.item);
  if (itemRows) {
    const rows = itemRows.filter((r) => isPosInt(r[0]) && isPosInt(r[1]) && typeof r[6] === 'string' && r[6].trim());
    result.item = { sheet: REPORT_SHEETS.item, count: rows.length };
  }
  return result;
}

/** Analyse the workbook: convert rows, classify sheets, collect findings. No database access. */
export async function analyseWorkbook(file) {
  const sheets = await readWorkbook(file, { matrixSheets: Object.values(REPORT_SHEETS) });
  const fatal = [];
  const report = {
    sheets: { imported: [], deferred: [], reportsOnly: [], unknown: [], missing: [] },
    unknownColumns: {}, missingOptionalColumns: {}, duplicateHeaders: {}, columnOrder: {},
    skippedSecretSettings: [], openQuestions: [], notes: { looseInt: [] }, tables: {}
  };
  const data = {};
  const claimed = new Set();

  for (const spec of TABLES) {
    const tr = newTableReport(spec);
    report.tables[spec.table] = tr;
    const names = [...sheets.keys()].filter((n) => spec.sheets.includes(n) || (spec.sheetPattern && spec.sheetPattern.test(n))).sort();
    if (!names.length) {
      for (const s of spec.sheets) {
        report.sheets.missing.push(s);
        if (REQUIRED_SHEETS.includes(s)) fatal.push(`Sheet wajib "${s}" tidak ada di workbook.`);
      }
    }
    const rows = new Map(); // key -> {out, sheet, row}
    for (const name of names) {
      claimed.add(name);
      const sheet = sheets.get(name);
      tr.sheets.push(name);
      report.sheets.imported.push({ name, table: spec.table, rows: sheet.rows.length });
      if (sheet.duplicateHeaders.length) report.duplicateHeaders[name] = sheet.duplicateHeaders;
      if (['DB_BERKAS', 'DB_ITEM'].includes(name)) report.columnOrder[name] = sheet.headers;
      const { resolved, unknown, missingOptional, missingRequired } = resolveColumns(spec, sheet);
      if (unknown.length) report.unknownColumns[name] = unknown;
      if (missingOptional.length) report.missingOptionalColumns[name] = missingOptional;
      for (const h of missingRequired) fatal.push(`Sheet ${name}: kolom wajib ${h} tidak ada.`);
      if (missingRequired.length) continue;

      for (const row of sheet.rows) {
        tr.read++;
        const { out, errors, fatal: rowFatal } = convertRow(spec, name, row, resolved, tr, report.notes);
        if (rowFatal.length) { fatal.push(...rowFatal); continue; }
        if (spec.table === 'unit_settings' && out.key) {
          if (SECRET_KEY_RE.test(out.key)) { report.skippedSecretSettings.push(out.key); continue; }
          if (!/^[A-Z][A-Z0-9_]*$/.test(out.key)) errors.push(`sheet ${name} baris ${row.rowNumber} kolom KEY: format kunci tidak valid "${out.key}"`);
        }
        if (errors.length) {
          tr.rejected++;
          tr.rejectedRows.push({ sheet: name, row: row.rowNumber, id: out[spec.key.at(-1)] ?? null, reasons: errors });
          continue;
        }
        const key = spec.key.filter((k) => k !== 'unit_id').map((k) => out[k]).join('\u0001');
        const prev = rows.get(key);
        if (prev) {
          if (stableJson(prev.out) === stableJson(out)) { tr.duplicateIdenticalRows++; continue; }
          fatal.push(`Sheet ${name} baris ${row.rowNumber}: ID ${key} sudah dipakai di sheet ${prev.sheet} baris ${prev.row} dengan isi berbeda.`);
          continue;
        }
        rows.set(key, { out, sheet: name, row: row.rowNumber });
      }
    }
    data[spec.table] = rows;
  }

  for (const [name, sheet] of sheets) {
    if (claimed.has(name)) continue;
    if (DEFERRED_SHEETS[name]) {
      const d = DEFERRED_SHEETS[name];
      report.sheets.deferred.push({ name, rows: sheet.rows.length, sprint: d.sprint, module: d.module });
    } else if (Object.values(REPORT_SHEETS).includes(name)) {
      report.sheets.reportsOnly.push({ name, rows: sheet.matrix ? sheet.matrix.length : sheet.rows.length });
    } else {
      report.sheets.unknown.push({ name, rows: sheet.rows.length, headers: sheet.headers.slice(0, 30) });
    }
  }
  report.sheets.deferred.sort((a, b) => a.name.localeCompare(b.name));

  // Open questions from Sprint 0: what does the export actually contain?
  for (const q of OPEN_QUESTIONS) {
    const sheet = sheets.get(q.sheet);
    const found = sheet ? q.headers.filter((h) => sheet.headers.includes(h)) : [];
    const entry = { sheet: q.sheet, question: q.question, sheetPresent: Boolean(sheet), headersFound: found, columns: {} };
    for (const h of found) {
      const values = sheet.rows.map((r) => r.values[h]);
      const nonEmpty = values.filter((v) => !isBlank(v));
      const col = { nonEmpty: nonEmpty.length };
      if (q.sensitive) col.note = 'isi tidak ditampilkan (data pribadi)';
      else col.distinct = distinctSample(values);
      if (q.check === 'unique') {
        const seen = new Map();
        for (const v of nonEmpty) seen.set(String(v), (seen.get(String(v)) || 0) + 1);
        col.duplicates = [...seen.values()].filter((n) => n > 1).length;
      }
      if (q.check === 'integer') {
        col.nonInteger = nonEmpty.filter((v) => !(typeof v === 'number' ? Number.isInteger(v) : /^-?\d+$/.test(String(v).trim()))).length;
      }
      entry.columns[h] = col;
    }
    report.openQuestions.push(entry);
  }

  const legacyReports = parseLegacyReports(new Map(
    [...sheets.values()].filter((s) => s.matrix).map((s) => [s.name, s.matrix])));
  return { data, report, fatal, legacyReports, sheetsSeen: [...sheets.keys()] };
}

/** Cross-row checks: orphans, links to null, duplicate numbers, legacy totals. Mutates rows (nulls dangling optional links). */
function crossCheck(data, existing, report, fatal) {
  const ids = (table) => new Set([...data[table].values()].map((r) => r.out.id).concat([...existing[table]]));
  const tr = report.tables;
  const orphans = { rejected: [], linksCleared: [], arsipWithoutSource: [] };
  report.orphans = orphans;

  const reject = (table, key, entry, reason) => {
    data[table].delete(key);
    tr[table].rejected++;
    tr[table].rejectedRows.push({ sheet: entry.sheet, row: entry.row, id: entry.out.id, reasons: [reason] });
    orphans.rejected.push({ table, id: entry.out.id, reason });
  };
  const clear = (table, entry, column, target) => {
    orphans.linksCleared.push({ table, id: entry.out.id, column, value: entry.out[column], missingIn: target });
    entry.out[column] = null;
  };

  // required parents
  const berkasIds = ids('berkas');
  for (const [k, e] of [...data.item]) {
    if (!berkasIds.has(e.out.berkas_id)) reject('item', k, e, `berkas ${e.out.berkas_id} tidak ditemukan (item tanpa berkas)`);
  }
  const penerimaanIds = ids('penerimaan');
  for (const [k, e] of [...data.penerimaan_item]) {
    if (!penerimaanIds.has(e.out.penerimaan_id)) reject('penerimaan_item', k, e, `penerimaan ${e.out.penerimaan_id} tidak ditemukan (item penerimaan tanpa penerimaan)`);
  }
  // optional links: keep the row, clear the dangling reference, report the original value
  const klasIds = ids('klasifikasi');
  const pegawaiIds = ids('pegawai');
  const itemIds = ids('item');
  const piIds = ids('penerimaan_item');
  const links = [
    ['klasifikasi', 'parent_id', klasIds, 'klasifikasi'],
    ['berkas', 'klasifikasi_id', klasIds, 'klasifikasi'],
    ['penerimaan', 'penyerah_pegawai_id', pegawaiIds, 'pegawai'],
    ['item', 'penerimaan_id', penerimaanIds, 'penerimaan'],
    ['item', 'penerimaan_item_id', piIds, 'penerimaan_item'],
    ['penerimaan_item', 'berkas_id_tujuan', berkasIds, 'berkas'],
    ['penerimaan_item', 'item_id_definitif', itemIds, 'item'],
    ['riwayat_nomor', 'berkas_id', berkasIds, 'berkas']
  ];
  for (const [table, column, set, target] of links) {
    for (const e of data[table].values()) {
      if (e.out[column] !== null && e.out[column] !== undefined && !set.has(e.out[column])) clear(table, e, column, target);
    }
  }
  // item.arsip_id must be its own id (manual input) or come from a receipt item
  const receiptArsip = new Set([...data.penerimaan_item.values()].map((e) => e.out.arsip_id).filter(Boolean).concat([...existing.penerimaanItemArsip]));
  for (const e of data.item.values()) {
    const a = e.out.arsip_id;
    if (a && a !== e.out.id && !receiptArsip.has(a)) {
      orphans.arsipWithoutSource.push({ itemId: e.out.id, arsipId: a, sumber: e.out.sumber_registrasi });
    }
  }

  // duplicate display numbers (would violate the per-unit constraints)
  const dup = (rows, keyFn) => {
    const m = new Map();
    for (const e of rows) { const k = keyFn(e.out); if (k === null) continue; (m.get(k) || m.set(k, []).get(k)).push(e.out.id); }
    return [...m.entries()].filter(([, v]) => v.length > 1).map(([number, idsList]) => ({ number, ids: idsList.sort() }));
  };
  report.duplicates = {
    berkasNumber: dup(data.berkas.values(), (o) => (!o.is_deleted && o.no_berkas_definitif !== null ? String(o.no_berkas_definitif) : null)),
    itemNumber: dup(data.item.values(), (o) => (!o.is_deleted && o.no_item_definitif !== null ? `${o.berkas_id} #${o.no_item_definitif}` : null)),
    receiptNumber: dup(data.penerimaan.values(), (o) => o.nomor_tanda_terima)
  };
  for (const [kind, list] of Object.entries(report.duplicates)) {
    for (const d of list) fatal.push(`Nomor ganda (${kind}) ${d.number}: ${d.ids.join(', ')}`);
  }

  // totals as the legacy reports compute them (ReportService.rebuildReports_)
  const activeBerkas = [...data.berkas.values()].map((e) => e.out)
    .filter((b) => !b.is_deleted && b.no_berkas_definitif !== null && String(b.status_pemindahan || '').toUpperCase() !== 'SUDAH DIPINDAHKAN');
  const activeIds = new Set(activeBerkas.map((b) => b.id));
  const activeItems = [...data.item.values()].map((e) => e.out)
    .filter((i) => !i.is_deleted && i.no_item_definitif !== null && activeIds.has(i.berkas_id));
  const perBerkas = new Map(activeBerkas.map((b) => [b.id, { items: 0, pages: 0 }]));
  for (const i of activeItems) { const p = perBerkas.get(i.berkas_id); p.items++; p.pages += i.jumlah_halaman || 0; }
  const mismatches = [];
  for (const b of activeBerkas.sort((x, y) => x.no_berkas_definitif - y.no_berkas_definitif)) {
    const p = perBerkas.get(b.id);
    if ((b.jumlah_item ?? null) !== p.items || (b.total_halaman ?? null) !== p.pages) {
      mismatches.push({ berkasId: b.id, nomor: b.no_berkas_definitif, jumlahItemTercatat: b.jumlah_item, jumlahItemDihitung: p.items, totalHalamanTercatat: b.total_halaman, totalHalamanDihitung: p.pages });
    }
  }
  report.totals = {
    berkasAktif: activeBerkas.length,
    itemAktif: activeItems.length,
    totalLembarItemAktif: activeItems.reduce((s, i) => s + (i.jumlah_halaman || 0), 0),
    berkasDibatalkanAtauDihapus: [...data.berkas.values()].filter((e) => e.out.is_deleted).length,
    itemDihapus: [...data.item.values()].filter((e) => e.out.is_deleted).length,
    penerimaanDibatalkan: [...data.penerimaan.values()].filter((e) => e.out.status === 'DIBATALKAN').length,
    selisihJumlahPerBerkas: mismatches,
    perBerkas: Object.fromEntries(activeBerkas.map((b) => [String(b.no_berkas_definitif), perBerkas.get(b.id)]))
  };
}

function compareLegacyReports(report, legacyReports) {
  const out = {};
  if (legacyReports.berkas) {
    const differences = [];
    const computed = report.totals.perBerkas;
    const numbers = new Set([...Object.keys(computed), ...Object.keys(legacyReports.berkas.perBerkas)]);
    for (const n of [...numbers].sort((a, b) => a - b)) {
      const a = computed[n], b = legacyReports.berkas.perBerkas[n];
      if (!a || !b || a.items !== b.items || a.pages !== b.pages) differences.push({ nomorBerkas: n, impor: a || null, laporanLama: b || null });
    }
    out.daftarBerkas = { sheet: legacyReports.berkas.sheet, barisLaporan: legacyReports.berkas.count, berkasAktifImpor: report.totals.berkasAktif, cocok: legacyReports.berkas.count === report.totals.berkasAktif && !differences.length, selisih: differences };
  }
  if (legacyReports.item) {
    out.daftarIsiBerkas = { sheet: legacyReports.item.sheet, barisLaporan: legacyReports.item.count, itemAktifImpor: report.totals.itemAktif, cocok: legacyReports.item.count === report.totals.itemAktif };
  }
  report.legacyReports = out;
}

async function stageAndMerge(client, spec, rows, unitId, tr, piiActive) {
  const keyCols = spec.key;
  const specCols = [...new Set(spec.columns.map((c) => c.c))];
  const piiCols = new Set(spec.columns.filter((c) => c.pii).map((c) => c.c));
  const cols = ['unit_id', ...specCols.filter((c) => c !== 'unit_id')];
  const usedCols = cols.filter((c) => !piiCols.has(c) || piiActive.has(c));
  const { rows: types } = await client.query(
    `select attname, format_type(atttypid, atttypmod) as type from pg_attribute
     where attrelid = $1::regclass and attnum > 0 and not attisdropped`, [`public.${spec.table}`]);
  const typeOf = Object.fromEntries(types.map((t) => [t.attname, t.type]));
  const stage = `_imp_${spec.table}`;
  const q = (c) => `"${c}"`;
  await client.query(`drop table if exists pg_temp.${stage}`);
  await client.query(`create temp table ${stage} (${usedCols.map((c) => `${q(c)} ${piiCols.has(c) ? 'text' : typeOf[c]}`).join(', ')}) on commit drop`);
  const payload = [...rows.values()].map((e) => {
    const o = { unit_id: unitId };
    for (const c of usedCols) if (c !== 'unit_id') o[c] = e.out[c] ?? null;
    return o;
  });
  await client.query(`insert into ${stage} select * from jsonb_populate_recordset(null::pg_temp.${stage}, $1::jsonb)`, [JSON.stringify(payload)]);

  const match = keyCols.map((k) => `t.${q(k)} = s.${q(k)}`).join(' and ');
  if (keyCols.length === 1) {
    const { rows: foreign } = await client.query(
      `select s.id from ${stage} s join public.${spec.table} t on t.id = s.id where t.unit_id <> s.unit_id order by 1 limit 20`);
    if (foreign.length) {
      throw new FatalImportError(`Tabel ${spec.table}: ID sudah dimiliki unit lain: ${foreign.map((r) => r.id).join(', ')}`);
    }
  }
  const valueCols = usedCols.filter((c) => !keyCols.includes(c));
  const tExpr = (c) => (piiCols.has(c) ? `app.decrypt_pii(t.${q(c)})` : `t.${q(c)}`);
  const sExpr = (c) => (piiCols.has(c) ? `app.encrypt_pii(s.${q(c)})` : `s.${q(c)}`);
  const diffArray = `array_remove(array[${valueCols.map((c) => `case when ${tExpr(c)} is distinct from s.${q(c)} then '${c}' end`).join(', ')}]::text[], null)`;
  const { rows: diffs } = await client.query(
    `select ${keyCols.map((k) => `s.${q(k)}`).join(', ')}, ${diffArray} as changed
     from ${stage} s join public.${spec.table} t on ${match}
     where cardinality(${diffArray}) > 0 order by ${keyCols.map((k) => `s.${q(k)}`).join(', ')}`);

  const ins = await client.query(
    `insert into public.${spec.table} (${usedCols.map(q).join(', ')})
     select ${usedCols.map(sExpr).join(', ')} from ${stage} s
     where not exists (select 1 from public.${spec.table} t where ${match})
     order by ${keyCols.map((k) => `s.${q(k)}`).join(', ')}`);
  tr.inserted = ins.rowCount;

  if (diffs.length) {
    if (spec.appendOnly) {
      for (const d of diffs) {
        tr.rejected++;
        const id = d[keyCols.at(-1)];
        tr.rejectedRows.push({ sheet: rows.get(String(id))?.sheet, row: rows.get(String(id))?.row, id, reasons: [`berbeda dengan data yang sudah ada (tabel append-only, tidak diubah): ${d.changed.join(', ')}`] });
      }
    } else {
      const upd = await client.query(
        `update public.${spec.table} t set ${valueCols.map((c) => `${q(c)} = ${sExpr(c)}`).join(', ')}
         from ${stage} s where ${match} and cardinality(${diffArray}) > 0`);
      tr.updated = upd.rowCount;
      for (const d of diffs) for (const c of d.changed) tr.changedColumns[c] = (tr.changedColumns[c] || 0) + 1;
    }
  }
  tr.accepted = rows.size;
  tr.unchanged = rows.size - tr.inserted - diffs.length;
  const { rows: [missing] } = await client.query(
    `select count(*)::int n from public.${spec.table} t where t.unit_id = $1
     and not exists (select 1 from ${stage} s where ${match})`, [unitId]);
  tr.inDatabaseNotInExport = missing.n;
}

async function loadExisting(client, unitId) {
  const existing = {};
  const q = async (sql) => (unitId ? (await client.query(sql, [unitId])).rows.map((r) => r.v) : []);
  existing.klasifikasi = new Set(await q('select id v from public.klasifikasi where unit_id = $1'));
  existing.pegawai = new Set(await q('select id v from public.pegawai where unit_id = $1'));
  existing.berkas = new Set(await q('select id v from public.berkas where unit_id = $1'));
  existing.penerimaan = new Set(await q('select id v from public.penerimaan where unit_id = $1'));
  existing.item = new Set(await q('select id v from public.item where unit_id = $1'));
  existing.penerimaan_item = new Set(await q('select id v from public.penerimaan_item where unit_id = $1'));
  existing.penerimaanItemArsip = new Set(await q('select arsip_id v from public.penerimaan_item where unit_id = $1 and arsip_id is not null'));
  for (const t of ['unit_settings', 'riwayat_nomor', 'audit_log']) existing[t] = new Set();
  return existing;
}

async function upsertUnit(client, opts, settings, report) {
  const instanceFromSettings = settings.INSTANCE_ID ?? null;
  if (opts.legacyInstanceId && instanceFromSettings && opts.legacyInstanceId !== instanceFromSettings) {
    throw new FatalImportError(`--legacy-instance-id (${opts.legacyInstanceId}) berbeda dengan SETTINGS.INSTANCE_ID (${instanceFromSettings}).`);
  }
  const want = {
    code: opts.unitCode, name: opts.unitName,
    legacy_instance_id: opts.legacyInstanceId || instanceFromSettings,
    legacy_unit_id: settings.UNIT_ID != null ? String(settings.UNIT_ID) : null
  };
  if (want.legacy_instance_id) {
    const { rows } = await client.query('select code from public.units where legacy_instance_id = $1 and code <> $2', [want.legacy_instance_id, want.code]);
    if (rows.length) throw new FatalImportError(`ID instance ${want.legacy_instance_id} sudah dipakai unit ${rows[0].code}.`);
  }
  const { rows: [unit] } = await client.query('select * from public.units where code = $1', [want.code]);
  const ur = { code: want.code, name: want.name, legacyInstanceId: want.legacy_instance_id, legacyUnitId: want.legacy_unit_id };
  if (!unit) {
    const { rows: [created] } = await client.query(
      'insert into public.units (code, name, legacy_instance_id, legacy_unit_id) values ($1, $2, $3, $4) returning id',
      [want.code, want.name, want.legacy_instance_id, want.legacy_unit_id]);
    report.unit = { ...ur, id: created.id, action: 'DIBUAT' };
    return created.id;
  }
  if (unit.legacy_instance_id && want.legacy_instance_id && unit.legacy_instance_id !== want.legacy_instance_id) {
    throw new FatalImportError(`Unit ${want.code} sudah terhubung ke instance ${unit.legacy_instance_id}, bukan ${want.legacy_instance_id}.`);
  }
  const changed = ['name', 'legacy_instance_id', 'legacy_unit_id'].filter((k) => want[k] !== null && unit[k] !== want[k]);
  if (changed.length) {
    await client.query('update public.units set name = $2, legacy_instance_id = coalesce($3, legacy_instance_id), legacy_unit_id = coalesce($4, legacy_unit_id) where id = $1',
      [unit.id, want.name, want.legacy_instance_id, want.legacy_unit_id]);
  }
  report.unit = { ...ur, id: unit.id, action: changed.length ? `DIPERBARUI (${changed.join(', ')})` : 'TIDAK BERUBAH' };
  return unit.id;
}

async function verifyDatabase(client, unitId, report) {
  const { rows: [r] } = await client.query(`
    with b as (select * from public.berkas where unit_id = $1),
         ab as (select id from b where not is_deleted and no_berkas_definitif is not null
                and upper(coalesce(status_pemindahan, '')) <> 'SUDAH DIPINDAHKAN'),
         ai as (select i.* from public.item i join ab on ab.id = i.berkas_id
                where i.unit_id = $1 and not i.is_deleted and i.no_item_definitif is not null)
    select (select count(*) from ab)::int berkas_aktif, (select count(*) from ai)::int item_aktif,
           (select coalesce(sum(jumlah_halaman), 0) from ai)::int total_lembar`, [unitId]);
  const counts = {};
  for (const t of TABLES.map((s) => s.table)) {
    counts[t] = (await client.query(`select count(*)::int n from public.${t} where unit_id = $1`, [unitId])).rows[0].n;
  }
  report.dbVerification = {
    berkasAktif: r.berkas_aktif, itemAktif: r.item_aktif, totalLembarItemAktif: r.total_lembar,
    cocokDenganEkspor: r.berkas_aktif === report.totals.berkasAktif && r.item_aktif === report.totals.itemAktif
      && r.total_lembar === report.totals.totalLembarItemAktif,
    jumlahBarisPerTabel: counts
  };
}

/**
 * Run an import. opts: { file, unitCode, unitName, legacyInstanceId?, dryRun?, strict?, piiKey?, pg? (pg.Client config) }
 * Returns the report (never throws for data problems; report.status = 'GAGAL' and report.fatal lists them).
 */
export async function runImport(opts) {
  const fileBuf = await readFile(opts.file);
  const report = {
    tool: 'cf-import-legacy', version: 1,
    file: basename(opts.file), fileSha256: createHash('sha256').update(fileBuf).digest('hex'),
    mode: opts.dryRun ? 'UJI_COBA' : 'IMPOR', strict: Boolean(opts.strict),
    status: null, fatal: [], generatedAt: new Date().toISOString()
  };
  let analysis;
  try {
    analysis = await analyseWorkbook(opts.file);
  } catch (error) {
    report.status = 'GAGAL';
    report.fatal.push(`Workbook tidak dapat dibaca: ${error.message}`);
    return report;
  }
  Object.assign(report, analysis.report);
  report.fatal.push(...analysis.fatal);

  const settings = Object.fromEntries([...analysis.data.unit_settings.values()].map((e) => [e.out.key, e.out.value]));
  const piiActive = new Set();
  for (const spec of TABLES) {
    for (const col of spec.columns.filter((c) => c.pii)) {
      if ([...analysis.data[spec.table].values()].some((e) => e.out[col.c] !== null && e.out[col.c] !== undefined)) piiActive.add(col.c);
    }
  }
  if (piiActive.size && !opts.piiKey) {
    report.fatal.push(`Ekspor berisi data pribadi (${[...piiActive].join(', ')}) tetapi kunci enkripsi tidak diberikan (--pii-key-env).`);
  }
  report.piiColumnsEncrypted = [...piiActive];

  const client = new pg.Client(opts.pg);
  await client.connect();
  try {
    await client.query('begin');
    await client.query("set local timezone = 'Asia/Jakarta'");
    if (opts.piiKey) await client.query("select set_config('app.pii_key', $1, true)", [opts.piiKey]);
    const { rows: [u] } = await client.query('select id from public.units where code = $1', [opts.unitCode]);
    const existing = await loadExisting(client, u?.id);
    crossCheck(analysis.data, existing, report, report.fatal);
    compareLegacyReports(report, analysis.legacyReports);
    if (opts.strict) {
      const rejected = Object.values(report.tables).reduce((s, t) => s + t.rejected, 0);
      if (rejected) report.fatal.push(`Mode ketat: ${rejected} baris ditolak.`);
      if (report.orphans.linksCleared.length) report.fatal.push(`Mode ketat: ${report.orphans.linksCleared.length} referensi yatim dikosongkan.`);
    }
    if (report.fatal.length) throw new FatalImportError('analisis gagal');

    const unitId = await upsertUnit(client, opts, settings, report);
    for (const spec of TABLES) {
      await stageAndMerge(client, spec, analysis.data[spec.table], unitId, report.tables[spec.table], piiActive);
    }
    if (opts.strict && Object.values(report.tables).some((t) => t.rejected)) {
      report.fatal.push('Mode ketat: ada baris append-only yang berbeda dengan database.');
      throw new FatalImportError('strict');
    }
    await client.query('set constraints all immediate');
    await verifyDatabase(client, unitId, report);
    if (opts.dryRun) {
      await client.query('rollback');
      report.status = 'UJI_COBA_BERHASIL';
    } else {
      await client.query('commit');
      report.status = 'BERHASIL';
    }
  } catch (error) {
    await client.query('rollback').catch(() => {});
    if (!(error instanceof FatalImportError)) {
      report.fatal.push(`Database: ${error.message}${error.detail ? ` (${error.detail})` : ''}${error.constraint ? ` [${error.constraint}]` : ''}`);
    } else if (!['analisis gagal', 'strict'].includes(error.message)) {
      report.fatal.push(error.message);
    }
    report.status = 'GAGAL';
  } finally {
    await client.end();
  }
  return report;
}
