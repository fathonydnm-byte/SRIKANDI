#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readWorkbook } from './lib/workbook.mjs';

const proposalStates = ['DRAFT', 'DIAJUKAN', 'DISETUJUI', 'DITOLAK', 'DIBATALKAN',
  'DITERIMA RECORD CENTER', 'TERTATA INAKTIF'];
const deliveryStates = ['PENDING_CONFIGURATION', 'PENDING', 'FAILED', 'SENT'];
const eventTypes = ['SUBMIT_TRANSFER_PROPOSAL', 'CANCEL_TRANSFER_PROPOSAL'];
const fields = {
  SETTINGS: ['KEY', 'VALUE'],
  USUL_PINDAH: ['USUL_PINDAH_ID', 'STATUS_USUL', 'OUTBOX_ID'],
  OUTBOX_RECORD_CENTER: ['OUTBOX_ID', 'USUL_PINDAH_ID', 'STATUS_OUTBOX', 'EVENT_TYPE'],
};

const cell = (value) => typeof value === 'string' ? value.trim() : '';
const bucket = (value, allowed) => {
  const key = cell(value).toUpperCase();
  if (allowed.includes(key)) return key;
  return value == null || (typeof value === 'string' && !key) ? 'KOSONG' : 'LAINNYA';
};
const counts = (rows, allowed, column) => {
  const result = Object.fromEntries([...allowed, 'KOSONG', 'LAINNYA'].map((key) => [key, 0]));
  for (const row of rows) result[bucket(row[column], allowed)]++;
  return result;
};

function readRows(sheets, tab) {
  const sheet = sheets.get(tab);
  if (!sheet || sheet.duplicateHeaders.length || fields[tab].some((name) => !sheet.headers.includes(name))) {
    throw new Error(`Tab ${tab} absen, tidak lengkap, atau memiliki header ganda.`);
  }
  return sheet.rows.map((row) => row.values);
}

function byId(rows, column, tab) {
  const result = new Map();
  for (const row of rows) {
    const id = cell(row[column]);
    if (!id || result.has(id)) throw new Error(`Tab ${tab} memiliki ID kosong atau ganda.`);
    result.set(id, row);
  }
  return result;
}

function summarize(sheets, unit) {
  const unitRows = readRows(sheets, 'SETTINGS').filter((row) => cell(row.KEY).toUpperCase() === 'UNIT_CODE');
  if (unitRows.length !== 1 || cell(unitRows[0].VALUE).toUpperCase() !== unit) {
    throw new Error('UNIT_CODE pada ekspor hilang, ganda, atau tidak cocok.');
  }
  const proposals = readRows(sheets, 'USUL_PINDAH');
  const events = readRows(sheets, 'OUTBOX_RECORD_CENTER');
  const proposalIds = byId(proposals, 'USUL_PINDAH_ID', 'USUL_PINDAH');
  const eventIds = byId(events, 'OUTBOX_ID', 'OUTBOX_RECORD_CENTER');
  const sent = events.filter((row) => bucket(row.STATUS_OUTBOX, deliveryStates) === 'SENT');
  const pendingDecision = proposals.filter((row) => {
    const event = eventIds.get(cell(row.OUTBOX_ID));
    return bucket(row.STATUS_USUL, proposalStates) === 'DIAJUKAN' &&
      event && cell(event.USUL_PINDAH_ID) === cell(row.USUL_PINDAH_ID) &&
      bucket(event.EVENT_TYPE, eventTypes) === 'SUBMIT_TRANSFER_PROPOSAL' &&
      bucket(event.STATUS_OUTBOX, deliveryStates) === 'SENT';
  });
  return {
    unit,
    status: proposals.length || events.length ? 'PERLU_REKONSILIASI' : 'TIDAK_ADA_RIWAYAT_DI_EKSPOR',
    usul: { total: proposals.length, per_status: counts(proposals, proposalStates, 'STATUS_USUL') },
    outbox: {
      total: events.length,
      per_status: counts(events, deliveryStates, 'STATUS_OUTBOX'),
      per_jenis: counts(events, eventTypes, 'EVENT_TYPE'),
      sudah_terkirim_per_jenis: counts(sent, eventTypes, 'EVENT_TYPE'),
    },
    diajukan_dan_sudah_terkirim: pendingDecision.length,
    temuan_relasi: {
      outbox_tanpa_induk_usul: events.filter((row) => !proposalIds.has(cell(row.USUL_PINDAH_ID))).length,
      usul_dengan_rujukan_outbox_tidak_cocok: proposals.filter((row) => {
        if (!cell(row.OUTBOX_ID)) return bucket(row.STATUS_USUL, proposalStates) === 'DIAJUKAN';
        const event = eventIds.get(cell(row.OUTBOX_ID));
        return !event || cell(event.USUL_PINDAH_ID) !== cell(row.USUL_PINDAH_ID) ||
          bucket(event.EVENT_TYPE, eventTypes) !== 'SUBMIT_TRANSFER_PROPOSAL';
      }).length,
    },
  };
}

try {
  let args;
  try { args = parseArgs({ options: { legacy: { type: 'string' }, unit: { type: 'string' } } }).values; }
  catch { throw new Error('Penggunaan: node transfer-inventory.mjs --legacy EKSPOR.xlsx --unit KODE'); }
  const unit = cell(args.unit).toUpperCase();
  if (!args.legacy || !/^[A-Z0-9_-]+$/.test(unit)) {
    throw new Error('Penggunaan: node transfer-inventory.mjs --legacy EKSPOR.xlsx --unit KODE');
  }
  let sheets;
  try { sheets = await readWorkbook(args.legacy); }
  catch { throw new Error('Ekspor XLSX Central File 3.x tidak dapat dibaca.'); }
  const report = summarize(sheets, unit);
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === 'PERLU_REKONSILIASI' ? 1 : 0;
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
