// Open and verify a backup package (a folder or a .zip of that folder): manifest, sha256 of every part,
// row counts per part / table / total. Nothing here touches a database.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { readZip } from './zip.mjs';
import { RESTORE_TABLES } from './tables.mjs';

export const FORMAT = 'CFBACKUP1';
const MAX_PART_BYTES = 512 * 1024 * 1024;

export function openPackage(target) {
  const st = fs.statSync(target);
  if (st.isDirectory()) {
    let dir = target;
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
      const subs = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'manifest.json')));
      if (subs.length !== 1) throw new Error(`manifest.json tidak ditemukan di ${target}`);
      dir = path.join(dir, subs[0].name);
    }
    return { name: path.basename(dir), has: (f) => fs.existsSync(path.join(dir, f)), read: (f) => fs.readFileSync(path.join(dir, path.basename(f))), files: () => fs.readdirSync(dir) };
  }
  const entries = readZip(fs.readFileSync(target));
  const manifestPath = [...entries.keys()].filter((k) => path.posix.basename(k) === 'manifest.json').sort((a, b) => a.length - b.length)[0];
  if (!manifestPath) throw new Error('manifest.json tidak ditemukan di dalam ZIP.');
  const prefix = path.posix.dirname(manifestPath);
  const byName = new Map();
  for (const [k, v] of entries) if (path.posix.dirname(k) === prefix) byName.set(path.posix.basename(k), v);
  return { name: path.basename(target), has: (f) => byName.has(f), read: (f) => byName.get(path.basename(f)), files: () => [...byName.keys()] };
}

export function parseNdjson(buf) {
  const text = buf.toString('utf8');
  if (text === '') return [];
  if (!text.endsWith('\n')) throw new Error('NDJSON terpotong (tanpa baris akhir).');
  return text.slice(0, -1).split('\n').map((l) => JSON.parse(l));
}

export function readPart(pkg, file) {
  return parseNdjson(zlib.gunzipSync(pkg.read(file), { maxOutputLength: MAX_PART_BYTES }));
}

/** @returns {{manifest, problems: string[], counts: Record<string, number>}} problems empty = the package is intact. */
export function verifyPackage(pkg) {
  const problems = [];
  let manifest;
  try {
    manifest = JSON.parse(pkg.read('manifest.json').toString('utf8'));
  } catch (e) {
    return { manifest: null, problems: [`manifest.json tidak dapat dibaca: ${e.message}`], counts: {} };
  }
  if (manifest.format !== FORMAT) problems.push(`format manifest ${JSON.stringify(manifest.format)} tidak dikenal (diharapkan ${FORMAT})`);
  if (typeof manifest.schema_version !== 'string' || !/^\d{4}$/.test(manifest.schema_version)) problems.push('schema_version tidak ada atau tidak valid');
  if (!manifest.unit || typeof manifest.unit.code !== 'string') problems.push('data unit di manifest tidak ada');
  if (!manifest.tables || typeof manifest.tables !== 'object') {
    problems.push('daftar tabel di manifest tidak ada');
    return { manifest, problems, counts: {} };
  }
  const counts = {};
  let total = 0;
  for (const [table, info] of Object.entries(manifest.tables)) {
    if (!RESTORE_TABLES.includes(table)) { problems.push(`tabel ${JSON.stringify(table)} tidak boleh dipulihkan dari paket`); continue; }
    let rows = 0;
    const seenFiles = new Set();
    for (const part of info.parts || []) {
      const label = `${table}/${part.file}`;
      if (typeof part.file !== 'string' || path.basename(part.file) !== part.file || !part.file.startsWith(`${table}.`)) { problems.push(`${label}: nama berkas tidak sah`); continue; }
      if (seenFiles.has(part.file)) { problems.push(`${label}: terdaftar dua kali`); continue; }
      seenFiles.add(part.file);
      if (!pkg.has(part.file)) { problems.push(`${label}: berkas hilang`); continue; }
      const bytes = pkg.read(part.file);
      const sha = crypto.createHash('sha256').update(bytes).digest('hex');
      if (sha !== part.sha256) { problems.push(`${label}: sha256 tidak cocok (rusak atau diubah)`); continue; }
      if (bytes.length !== part.bytes) { problems.push(`${label}: ukuran tidak cocok`); continue; }
      let n;
      try { n = readPart(pkg, part.file).length; } catch (e) { problems.push(`${label}: isi tidak dapat dibaca (${e.message})`); continue; }
      if (n !== part.rows) problems.push(`${label}: jumlah baris ${n}, manifest ${part.rows}`);
      rows += n;
    }
    if (rows !== info.rows) problems.push(`tabel ${table}: jumlah baris ${rows}, manifest ${info.rows}`);
    counts[table] = rows;
    total += rows;
  }
  if (total !== manifest.total_rows) problems.push(`total baris ${total}, manifest ${manifest.total_rows}`);
  const inv = manifest.drive_inventory;
  if (inv) {
    let n = 0;
    for (const part of inv.parts || []) {
      if (!pkg.has(part.file)) { problems.push(`inventaris/${part.file}: berkas hilang`); continue; }
      if (crypto.createHash('sha256').update(pkg.read(part.file)).digest('hex') !== part.sha256) { problems.push(`inventaris/${part.file}: sha256 tidak cocok`); continue; }
      try { n += readPart(pkg, part.file).length; } catch (e) { problems.push(`inventaris/${part.file}: ${e.message}`); }
    }
    if (n !== inv.rows) problems.push(`inventaris file Drive: ${n} baris, manifest ${inv.rows}`);
  }
  const listed = new Set(['manifest.json', ...Object.values(manifest.tables).flatMap((t) => (t.parts || []).map((p) => p.file)), ...((inv && inv.parts) || []).map((p) => p.file)]);
  for (const f of pkg.files()) if (!listed.has(f) && !f.startsWith('.')) problems.push(`berkas tak terdaftar di manifest: ${f}`);
  return { manifest, problems, counts };
}
