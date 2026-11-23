import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

const cli = fileURLToPath(new URL('../transfer-inventory.mjs', import.meta.url));

async function fixture(t, { before = {}, omitOutbox = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cf-transfer-inventory-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const book = new ExcelJS.Workbook();
  const tables = {
    SETTINGS: [['KEY', 'VALUE'], ['UNIT_CODE', 'BAGUM'], ['SECRET', 'jangan-dicetak']],
    USUL_PINDAH: [['USUL_PINDAH_ID', 'STATUS_USUL', 'OUTBOX_ID', 'CATATAN']],
    OUTBOX_RECORD_CENTER: [['OUTBOX_ID', 'USUL_PINDAH_ID', 'STATUS_OUTBOX', 'EVENT_TYPE']],
    ...before,
  };
  if (omitOutbox) delete tables.OUTBOX_RECORD_CENTER;
  for (const [name, rows] of Object.entries(tables)) book.addWorksheet(name).addRows(rows);
  const file = join(dir, 'legacy.xlsx');
  await book.xlsx.writeFile(file);
  return (unit = 'BAGUM') =>
    spawnSync(process.execPath, [cli, '--legacy', file, '--unit', unit], { encoding: 'utf8' });
}

test('keeps sent submissions and cancellations separate and reports only aggregate data', async (t) => {
  const invoke = await fixture(t, { before: {
    USUL_PINDAH: [
      ['USUL_PINDAH_ID', 'STATUS_USUL', 'OUTBOX_ID', 'CATATAN'],
      ['usul-internal-a', 'DIAJUKAN', 'event-internal-a', 'catatan internal'],
      ['usul-internal-b', 'DIAJUKAN', 'event-internal-b'],
      ['usul-internal-c', 'status privat baru'],
    ],
    OUTBOX_RECORD_CENTER: [
      ['OUTBOX_ID', 'USUL_PINDAH_ID', 'STATUS_OUTBOX', 'EVENT_TYPE'],
      ['event-internal-a', 'usul-internal-a', 'SENT', 'SUBMIT_TRANSFER_PROPOSAL'],
      ['event-internal-b', 'usul-internal-b', 'SENT', 'CANCEL_TRANSFER_PROPOSAL'],
      ['event-internal-c', 'usul-internal-d', 'FAILED', 'SUBMIT_TRANSFER_PROPOSAL'],
    ],
  } });
  const { status, stdout, stderr } = invoke();
  assert.equal(status, 1, stderr);
  const report = JSON.parse(stdout);
  assert.equal(report.usul.per_status.LAINNYA, 1);
  assert.equal(report.outbox.sudah_terkirim_per_jenis.SUBMIT_TRANSFER_PROPOSAL, 1);
  assert.equal(report.outbox.sudah_terkirim_per_jenis.CANCEL_TRANSFER_PROPOSAL, 1);
  assert.equal(report.diajukan_dan_sudah_terkirim, 1);
  assert.deepEqual(report.temuan_relasi, {
    outbox_tanpa_induk_usul: 1,
    usul_dengan_rujukan_outbox_tidak_cocok: 1,
  });
  assert.doesNotMatch(stdout + stderr, /usul-internal|event-internal|catatan internal|status privat|jangan-dicetak/);
});

test('distinguishes an empty history from an incomplete export or a different unit', async (t) => {
  const empty = await fixture(t);
  const valid = empty();
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).status, 'TIDAK_ADA_RIWAYAT_DI_EKSPOR');
  assert.equal(empty('TEST').status, 2);

  const incomplete = (await fixture(t, { omitOutbox: true }))();
  assert.equal(incomplete.status, 2);
  assert.equal(incomplete.stdout, '');
  assert.match(incomplete.stderr, /OUTBOX_RECORD_CENTER/);
});
