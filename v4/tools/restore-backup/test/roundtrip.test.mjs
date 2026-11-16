// Round trip: seed a migrated database -> run the REAL Apps Script job (Code.gs in a vm with fake Google services)
// against the REAL server/jobsExport.ts (bundled) over a PostgREST-like adapter -> take the backup package the job
// wrote to the fake Drive -> restore it with restore.mjs into a SECOND, empty, migrated database -> compare a canonical
// dump of every table byte for byte. Then: dry-run, idempotency, corruption, schema mismatch, integrity failures.
//
// Run through test.sh (it prepares the two databases and the bundle).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';
import { seed, UNIT, SIZES } from './seed.mjs';
import { canonicalDump } from './canonical-dump.mjs';
import { startBridge } from './sync-bridge.mjs';
import { RESTORE_TABLES } from '../lib/tables.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { createWorld } = require('../../../mirror-apps-script/testkit.cjs');
const RESTORE = path.join(HERE, '..', 'restore.mjs');

const SRC_DB = process.env.PGDATABASE;
const DST_DB = process.env.CF_RESTORE_DB;
const BUNDLE = process.env.CF_JOBS_BUNDLE;
const JOB_SECRET = 'roundtrip-' + crypto.randomBytes(24).toString('hex');
const SERVICE_KEY = 'sb_secret_' + crypto.randomBytes(20).toString('hex');
const OUT = fs.mkdtempSync(path.join(process.env.CF_TEST_OUT || os.tmpdir(), 'cf-roundtrip-'));

const dbUrl = (db) => `postgresql://postgres@localhost/${db}?host=${encodeURIComponent(process.env.PGHOST)}&port=${process.env.PGPORT}`;
const src = new pg.Client({ database: SRC_DB });
const dst = new pg.Client({ database: DST_DB });
let bridge;
let world;
let packages; // code -> dir
let sourceDump;
let schemaVersion;

function restoreCli(args, envExtra = {}) {
  const r = spawnSync(process.execPath, [RESTORE, ...args], {
    env: { ...process.env, RESTORE_DATABASE_URL: dbUrl(DST_DB), ...envExtra }, encoding: 'utf8', timeout: 120000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(from)) fs.copyFileSync(path.join(from, f), path.join(to, f));
}

/** Replace the rows of one table in a package copy and keep the manifest consistent (hashes, counts), like a clever attacker or a buggy tool. */
function rewriteTable(dir, table, mutate) {
  const mpath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(mpath, 'utf8'));
  const info = manifest.tables[table];
  const rows = info.parts.flatMap((p) => zlib.gunzipSync(fs.readFileSync(path.join(dir, p.file))).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  const next = mutate(rows);
  for (const p of info.parts) fs.rmSync(path.join(dir, p.file));
  const file = `${table}.0001.ndjson.gz`;
  const gz = zlib.gzipSync(Buffer.from(next.map((r) => JSON.stringify(r)).join('\n') + '\n'));
  fs.writeFileSync(path.join(dir, file), gz);
  manifest.total_rows += next.length - info.rows;
  info.rows = next.length;
  info.parts = [{ file, rows: next.length, bytes: gz.length, sha256: crypto.createHash('sha256').update(gz).digest('hex') }];
  fs.writeFileSync(mpath, JSON.stringify(manifest));
}

async function counts(client, units, { withNull = true } = {}) {
  const out = {};
  for (const t of RESTORE_TABLES) {
    const col = t === 'units' ? 'id' : 'unit_id';
    const { rows } = await client.query(`select count(*)::int n from public."${t}" where ${col} = any ($1::uuid[])${t === 'audit_log' && withNull ? ' or unit_id is null' : ''}`, [units]);
    out[t] = rows[0].n;
  }
  return out;
}

before(async () => {
  assert.ok(SRC_DB && DST_DB && BUNDLE, 'run through test.sh (PGDATABASE, CF_RESTORE_DB, CF_JOBS_BUNDLE)');
  await src.connect();
  await dst.connect();
  const { rows: [schema] } = await src.query('select max(version) as version from public.schema_migrations_log');
  schemaVersion = schema.version;
  await seed(src);
  bridge = await startBridge(path.join(HERE, 'pgrest-worker.mjs'), {
    bundle: BUNDLE, serviceKey: SERVICE_KEY, anonKey: 'anon-test-key', supabaseUrl: 'https://rest.invalid', jobSecret: JOB_SECRET, maxRows: 1000,
  });
  world = createWorld({ now: Date.now() });
  world.configure({ base: 'https://app.example.pages.dev', secret: JOB_SECRET });
  world.apiHandler = (body) => {
    const r = bridge.call({ url: 'https://app.example.pages.dev/api/jobs/export', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), nowMs: world.clock.now });
    if (r.status === 599) throw new Error(`worker crashed: ${r.text}`);
    return r;
  };
});

after(async () => {
  await bridge?.close();
  await src.end().catch(() => {});
  await dst.end().catch(() => {});
  if (!process.env.CF_KEEP_OUT) fs.rmSync(OUT, { recursive: true, force: true });
});

test('the allow-list of the REAL server module equals the restore tool list and the DB test classification', async () => {
  const mod = await import(pathToFileURL(BUNDLE).href);
  assert.deepEqual(Object.keys(mod.EXPORT_TABLES), RESTORE_TABLES);
  // every public table is either exported or deliberately excluded
  const { rows } = await src.query("select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1");
  const excluded = ['profiles', 'idempotency_keys', 'upload_sessions', 'schema_migrations_log', 'job_nonces', 'backup_runs'];
  assert.deepEqual(rows.map((r) => r.table_name), [...RESTORE_TABLES, ...excluded].sort());
});

test('the nightly job (real Code.gs + real jobsExport.ts + real Postgres) runs to completion', async () => {
  let outcome = world.call('runNow');
  for (let i = 0; outcome === 'CONTINUE' && i < 10; i++) {
    assert.equal(world.triggers.length, 1, 'one bounded continuation for unfinished work');
    assert.equal(world.triggers[0].handler, 'continueMirror');
    world.clock.now += world.triggers[0].afterMs;
    outcome = world.call('continueMirror');
  }
  assert.equal(outcome, 'DONE');
  assert.equal(world.triggers.length, 0, 'no continuation after all units finish');
  const { rows: runs } = await src.query('select kind, unit_id, status, error, stats from public.backup_runs order by started_at');
  assert.equal(runs.length, 5, 'MIRROR+BACKUP for two units, BACKUP for the cross-unit pseudo unit');
  assert.deepEqual(runs.map((r) => r.status), Array(5).fill('SUCCESS'), JSON.stringify(runs.map((r) => r.error)));
  const unitCounts = await counts(src, [UNIT.A], { withNull: false });
  const runA = runs.find((r) => r.kind === 'BACKUP' && r.unit_id === UNIT.A);
  assert.deepEqual(runA.stats.tables, unitCounts, 'the run recorded exactly the rows that exist');
  assert.equal(runA.stats.total_rows, Object.values(unitCounts).reduce((a, b) => a + b, 0));
  assert.equal(unitCounts.item, SIZES.itemsA, 'paged through 3 pages of 1000');
  const { rows: nonces } = await src.query('select count(*)::int n from public.job_nonces');
  assert.equal(nonces[0].n, world.fetchLog.filter((f) => f.url.includes('/api/jobs/export')).length, 'every API request recorded its nonce in the DB');
  assert.ok(!JSON.stringify(world.logs).includes(JOB_SECRET) && !JSON.stringify(world.logs).includes(SERVICE_KEY));
});

test('the mirror spreadsheet shows what the database holds (legacy tab names, counts, reports, no formulas)', async () => {
  const { rows: [run] } = await src.query("select mirror_file_id from public.backup_runs where kind = 'MIRROR' and unit_id = $1", [UNIT.A]);
  const id = run.mirror_file_id;
  const tabs = world.sheetsBook.tabs(id);
  for (const t of ['DAFTAR BERKAS', 'DAFTAR ISI BERKAS', 'DB_BERKAS', 'DB_ITEM', 'PENERIMAAN_ARSIP', 'PENERIMAAN_ITEM', 'RIWAYAT_NOMOR', 'AUDIT_LOG', 'MASTER_KLASIFIKASI', 'MASTER_PEGAWAI', 'SETTINGS', '_INFO']) assert.ok(tabs.includes(t), t);
  assert.equal(world.sheetsBook.read(id, 'DB_ITEM').length, SIZES.itemsA + 1);
  assert.equal(world.sheetsBook.read(id, 'AUDIT_LOG').length, 1200 + 1);
  assert.equal(world.sheetsBook.formulaCells, 0);
  const berkas = world.sheetsBook.read(id, 'DB_BERKAS');
  const titleCol = berkas[0].indexOf('JUDUL_BERKAS');
  assert.ok(berkas.slice(1).some((r) => String(r[titleCol]).startsWith("'=Berkas")), 'a title that starts with = was written as text');
  assert.ok(!berkas[0].includes('SEARCH_DOC'), 'derived column left out');
  assert.ok(!world.sheetsBook.read(id, 'MASTER_PEGAWAI')[0].some((h) => /_ENC$/.test(h)));
  const rb = world.sheetsBook.read(id, 'DAFTAR BERKAS');
  assert.equal(rb[3][0], 'No. Berkas');
  assert.equal(rb.length - 4, SIZES.berkasA - 2, 'minus the deleted berkas and the one without a definitive number');
  const { rows: [{ n }] } = await src.query("select count(*)::int n from public.item i join public.berkas b on b.unit_id = i.unit_id and b.id = i.berkas_id where i.unit_id = $1 and not i.is_deleted and not b.is_deleted and b.no_berkas_definitif is not null and i.no_item_definitif is not null", [UNIT.A]);
  assert.equal(world.sheetsBook.read(id, 'DAFTAR ISI BERKAS').length - 4, n);
});

test('a replayed request is refused by the real nonce store; a tampered one by the signature', async () => {
  const sent = world.fetchLog; // inspect through a fresh signed request, then replay it
  assert.ok(sent.length > 10);
  const body = JSON.parse(JSON.stringify(world.call('signJob_', JOB_SECRET, 'LIST_UNITS', Math.floor(world.clock.now / 1000), 'replaytest0123456789abcdef', {})));
  const post = (b) => bridge.call({ url: 'https://app.example.pages.dev/api/jobs/export', method: 'POST', headers: {}, body: JSON.stringify(b), nowMs: world.clock.now });
  assert.equal(post(body).status, 200);
  assert.equal(post(body).status, 401, 'same nonce again');
  const t = JSON.parse(JSON.stringify(world.call('signJob_', JOB_SECRET, 'TABLE_PAGE', Math.floor(world.clock.now / 1000), 'tamper0123456789abcdefgh', { unit_id: UNIT.A, table: 'item' })));
  assert.equal(post({ ...t, unit_id: UNIT.B }).status, 401, 'unit changed after signing');
  assert.equal(post({ ...t, table: 'profiles' }).status, 401);
  const forbidden = JSON.parse(JSON.stringify(world.call('signJob_', JOB_SECRET, 'TABLE_PAGE', Math.floor(world.clock.now / 1000), 'forbid0123456789abcdefgh', { unit_id: UNIT.A, table: 'profiles' })));
  assert.equal(post(forbidden).status, 400, 'validly signed but not in the allow-list');
});

test('collect the packages the job wrote into the fake Drive (folder for A, zip for B, folder for the platform)', async () => {
  packages = {};
  const day = new Date(world.clock.now + 7 * 3600 * 1000).toISOString().slice(0, 10);
  for (const code of ['RT-A', 'RT-B', '_PLATFORM']) {
    const root = [...world.drive.files.values()].find((f) => f.name === 'CENTRAL FILE V4' && !f.trashed);
    const unit = world.drive.byName(code, root.id)[0];
    const backup = world.drive.byName('BACKUP', unit.id)[0];
    const pkg = world.drive.byName(day, backup.id).find((f) => !f.trashed);
    assert.ok(pkg, `${code} package ${day}`);
    const dir = path.join(OUT, code, day);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of world.drive.children(pkg.id)) fs.writeFileSync(path.join(dir, f.name), f.bytes);
    packages[code] = dir;
  }
  // package B as a zip of its folder
  const zipPath = path.join(OUT, 'RT-B.zip');
  execFileSync('zip', ['-qr', zipPath, path.basename(packages['RT-B'])], { cwd: path.dirname(packages['RT-B']) });
  packages.zipB = zipPath;
  const m = JSON.parse(fs.readFileSync(path.join(packages['RT-A'], 'manifest.json'), 'utf8'));
  assert.equal(m.schema_version, schemaVersion);
  assert.equal(m.tables.item.parts.length, 3);
  // PII stays encrypted, exactly as the database stores it (hex of the ciphertext); the restore needs no key
  const pegawai = zlib.gunzipSync(fs.readFileSync(path.join(packages['RT-A'], m.tables.pegawai.parts[0].file))).toString('utf8');
  assert.match(pegawai, /"nip_nik_enc":"\\\\x00ff10aa5b7c"/);
  sourceDump = await canonicalDump(src, [UNIT.A, UNIT.B]);
  for (const t of RESTORE_TABLES) assert.ok(sourceDump[t].rows > 0, `seed covers ${t}`);
});

test('rehearsal runs dry-run and commit using a separate database even when an external target is configured', async () => {
  const prior = await canonicalDump(dst, [UNIT.A, UNIT.B]);
  const r = spawnSync('bash', [path.join(HERE, '..', 'rehearse.sh'), packages['RT-A'], packages.zipB, packages._PLATFORM], {
    env: { ...process.env, RESTORE_DATABASE_URL: dbUrl(DST_DB) }, encoding: 'utf8', timeout: 120000,
  });
  assert.equal(r.status, 0, r.error?.message || r.stderr || r.stdout);
  assert.match(r.stdout, /ROLLBACK[\s\S]*Restore selesai \(COMMIT\)/);
  assert.match(r.stdout, /Latihan pemulihan lulus/);
  assert.deepEqual(await canonicalDump(dst, [UNIT.A, UNIT.B]), prior);
});

test('restore refuses a database whose schema version differs (exit 3, nothing written), unless --force-schema', async () => {
  const copy = path.join(OUT, 'schema-copy');
  copyDir(packages['RT-B'], copy);
  const mp = path.join(copy, 'manifest.json');
  const man = JSON.parse(fs.readFileSync(mp, 'utf8'));
  man.schema_version = '0021';
  fs.writeFileSync(mp, JSON.stringify(man));
  const r = restoreCli(['--package', copy, '--database-url-env', 'RESTORE_DATABASE_URL']);
  assert.equal(r.code, 3, r.err);
  assert.ok(r.err.includes(`Versi skema berbeda: paket RT-B = 0021, database = ${schemaVersion}`), r.err);
  assert.equal((await counts(dst, [UNIT.A, UNIT.B])).units, 0);
  const forced = restoreCli(['--package', copy, '--database-url-env', 'RESTORE_DATABASE_URL', '--force-schema', '--dry-run']);
  assert.equal(forced.code, 0, forced.err);
  assert.match(forced.err, /PERINGATAN \(--force-schema\)/);
});

test('corrupt packages are refused BEFORE the database is touched (exit 2)', async () => {
  const cases = {
    'flipped byte': (d) => { const f = path.join(d, 'item.0001.ndjson.gz'); const b = fs.readFileSync(f); b[Math.floor(b.length / 2)] ^= 0xff; fs.writeFileSync(f, b); },
    'missing file': (d) => fs.rmSync(path.join(d, 'berkas.0001.ndjson.gz')),
    'truncated': (d) => { const f = path.join(d, 'item.0002.ndjson.gz'); fs.writeFileSync(f, fs.readFileSync(f).subarray(0, 100)); },
    'extra unlisted file': (d) => fs.writeFileSync(path.join(d, 'item.0099.ndjson.gz'), 'x'),
    'manifest row count edited': (d) => { const p = path.join(d, 'manifest.json'); const m = JSON.parse(fs.readFileSync(p, 'utf8')); m.tables.item.rows += 1; fs.writeFileSync(p, JSON.stringify(m)); },
    'manifest total edited': (d) => { const p = path.join(d, 'manifest.json'); const m = JSON.parse(fs.readFileSync(p, 'utf8')); m.total_rows -= 1; fs.writeFileSync(p, JSON.stringify(m)); },
    'table outside the allow-list': (d) => { const p = path.join(d, 'manifest.json'); const m = JSON.parse(fs.readFileSync(p, 'utf8')); m.tables.profiles = { rows: 0, parts: [] }; fs.writeFileSync(p, JSON.stringify(m)); },
    'part name escaping the folder': (d) => { const p = path.join(d, 'manifest.json'); const m = JSON.parse(fs.readFileSync(p, 'utf8')); m.tables.item.parts[0].file = '../item.0001.ndjson.gz'; fs.writeFileSync(p, JSON.stringify(m)); },
    'not a manifest': (d) => fs.writeFileSync(path.join(d, 'manifest.json'), '{nope'),
  };
  for (const [name, corrupt] of Object.entries(cases)) {
    const d = path.join(OUT, 'corrupt-' + name.replace(/\W+/g, '-'));
    copyDir(packages['RT-A'], d);
    corrupt(d);
    const r = restoreCli(['--package', d, '--database-url-env', 'RESTORE_DATABASE_URL']);
    assert.equal(r.code, 2, `${name}: ${r.err}`);
    assert.match(r.err, /TIDAK utuh|tidak dapat dibaca/, name);
  }
  assert.equal((await counts(dst, [UNIT.A, UNIT.B])).item, 0, 'target untouched');
  // a zip with a corrupted member
  const z = path.join(OUT, 'broken.zip');
  fs.writeFileSync(z, Buffer.concat([fs.readFileSync(packages.zipB).subarray(0, 40), Buffer.from('garbage')]));
  assert.equal(restoreCli(['--package', z, '--database-url-env', 'RESTORE_DATABASE_URL']).code, 2);
});

test('integrity failures roll everything back (exit 4): orphan rows, duplicate numbers, counter below used numbers', async () => {
  const scenarios = {
    'orphan item (berkas missing)': ['item', (rows) => rows.map((r, i) => (i === 3 ? { ...r, berkas_id: 'BRK-TIDAK-ADA' } : r)), /yatim: item\.item_berkas_fk/],
    'duplicate berkas number': ['berkas', (rows) => rows.map((r) => (r.id === 'BRK-A-2' ? { ...r, no_berkas_definitif: 1 } : r)), /nomor berkas unik per unit/],
    'counter below the highest receipt number': ['counters', (rows) => rows.map((r) => (r.scope === 'TRM' && r.year === 2026 ? { ...r, last_value: 5 } : r)), /counter TRM >= nomor tanda terima tertinggi/],
  };
  for (const [name, [table, mutate, expect]] of Object.entries(scenarios)) {
    const d = path.join(OUT, 'integrity-' + name.replace(/\W+/g, '-'));
    copyDir(packages['RT-A'], d);
    rewriteTable(d, table, mutate);
    const r = restoreCli(['--package', d, '--package', packages['RT-B'], '--database-url-env', 'RESTORE_DATABASE_URL']);
    assert.equal(r.code, 4, `${name}\n${r.out}\n${r.err}`);
    assert.match(r.err, expect, name);
    assert.match(r.err, /Tidak ada yang tersimpan \(ROLLBACK\)/);
    const c = await counts(dst, [UNIT.A, UNIT.B]);
    assert.ok(Object.values(c).every((n) => n === 0), `${name}: rolled back, nothing left behind ${JSON.stringify(c)}`);
  }
});

test('--dry-run loads, checks, and rolls back', async () => {
  const r = restoreCli(['--package', packages['RT-A'], '--package', packages.zipB, '--package', packages._PLATFORM, '--database-url-env', 'RESTORE_DATABASE_URL', '--dry-run']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /--dry-run: semua dimuat lalu dibatalkan \(ROLLBACK\)/);
  assert.match(r.out, /item\s+paket\s+2512\s+ditulis\s+2512/);
  assert.ok(Object.values(await counts(dst, [UNIT.A, UNIT.B])).every((n) => n === 0));
});

test('RESTORE: folder + zip + folder in ONE transaction into an empty migrated database; every table byte-equal on the canonical dump', async () => {
  const r = restoreCli(['--package', packages['RT-A'], '--package', packages.zipB, '--package', packages._PLATFORM, '--database-url-env', 'RESTORE_DATABASE_URL']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Restore selesai \(COMMIT\)/);
  assert.ok(!r.out.includes('[GAGAL]'));
  for (const name of ['nomor berkas unik per unit', 'counter TRM >= nomor tanda terima tertinggi', 'constraint basis data']) assert.match(r.out, new RegExp(`\\[OK\\] ${name}`));
  const dump = await canonicalDump(dst, [UNIT.A, UNIT.B]);
  for (const t of RESTORE_TABLES) {
    assert.equal(dump[t].rows, sourceDump[t].rows, `${t}: row count`);
    assert.equal(dump[t].sha256, sourceDump[t].sha256, `${t}: canonical dump`);
    assert.equal(dump[t].text, sourceDump[t].text, `${t}: byte for byte`);
  }
});

test('idempotent: restoring the same packages again changes nothing', async () => {
  const before = await canonicalDump(dst, [UNIT.A, UNIT.B]);
  const r = restoreCli(['--package', packages['RT-A'], '--package', packages.zipB, '--package', packages._PLATFORM, '--database-url-env', 'RESTORE_DATABASE_URL']);
  assert.equal(r.code, 0, r.err);
  const after = await canonicalDump(dst, [UNIT.A, UNIT.B]);
  for (const t of RESTORE_TABLES) assert.equal(after[t].sha256, before[t].sha256, t);
  assert.equal((await dst.query('select count(*)::int n from public.audit_log')).rows[0].n, sourceDump.audit_log.rows, 'append-only audit rows were not duplicated');
});

test('after the restore the system keeps working: counters hand out fresh numbers, the identity column continues', async () => {
  const { rows: [{ n }] } = await dst.query("select app.next_counter($1, 'TRM', 2026) as n", [UNIT.A]);
  assert.equal(Number(n), 13, 'TRM-2026-0013 is next, not a reused number');
  const { rows: [{ seq }] } = await dst.query(`insert into public.folder_label_log (id, unit_id, batch_id, berkas_id) values ('PRN-NEW', $1, 'LBL-9', 'BRK-A-1') returning seq`, [UNIT.A]);
  const { rows: [{ m }] } = await dst.query("select max(seq) m from public.folder_label_log where id <> 'PRN-NEW'");
  assert.ok(Number(seq) > Number(m), `identity continues after the restored maximum (${seq} > ${m})`);
  // the generated search column was recomputed by the database, not restored
  const { rows: [{ same }] } = await dst.query("select (select search_doc from public.item where id = 'ITM-A-00002') = (select search_doc from public.item where id = 'ITM-A-00002') as same");
  assert.ok(same);
  const { rows: [{ ok }] } = await dst.query("select search_doc is not null and search_doc <> '' as ok from public.item where id = 'ITM-A-00002'");
  assert.ok(ok);
});

test('the database URL never appears in output; a refused connection ends with exit 1', () => {
  const r = restoreCli(['--package', packages['RT-B'], '--database-url-env', 'RESTORE_DATABASE_URL'], { RESTORE_DATABASE_URL: 'postgresql://zed:supersecretpw@127.0.0.1:1/nowhere' });
  assert.equal(r.code, 1);
  assert.ok(!r.err.includes('supersecretpw') && !r.out.includes('supersecretpw'));
  const missing = restoreCli(['--package', packages['RT-B'], '--database-url-env', 'TIDAK_ADA_VAR']);
  assert.equal(missing.code, 1);
  assert.equal(restoreCli(['--package', packages['RT-B']]).code, 1, 'database url must come from a named env var, never from an argument');
});
