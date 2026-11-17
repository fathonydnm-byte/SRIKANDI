import { createHash } from 'node:crypto';
import { KONDISI, convert } from './convert.mjs';

const required = (value) => {
  if (value == null || value === '') throw new Error();
  return value;
};
function checked(row, key, f, mandatory = false) {
  try {
    const value = f(row.values[key]);
    return mandatory ? required(value) : value;
  } catch {
    // Never leak cell values, identities, accessibility URLs or free-text notes.
    throw new Error(`${row.sheet} baris ${row.rowNumber}: kolom ${key} kosong atau tidak valid.`);
  }
}
function rowsOf(sheets, name, headers) {
  const sheet = sheets.get(name);
  if (!sheet || sheet.duplicateHeaders.length || headers.some((h) => !sheet.headers.includes(h))) {
    throw new Error(`Header tab ${name} tidak lengkap atau ganda.`);
  }
  return sheet.rows.map((r) => ({ ...r, sheet: name }));
}
const t = (r, k, mandatory) => checked(r, k, convert.text, mandatory);
const d = (r, k) => checked(r, k, convert.date, true);
const int = (r, k) => checked(r, k, (x) => {
  const n = convert.int(x);
  if (n != null && (n < 0 || n > 2147483647)) throw new Error();
  return n;
});
const problem = (r, msg) => new Error(`${r.sheet} baris ${r.rowNumber}: ${msg}.`);
const one = (rows, pick, field) => {
  const values = [...new Set(rows.map(pick).filter((v) => v != null))];
  if (values.length > 1) throw problem(rows[0], `data ${field} berbeda dalam satu grup`);
  return values[0] ?? null;
};

export function readLoanHistory(sheets) {
  const settings = rowsOf(sheets, 'SETTINGS', ['KEY', 'VALUE']);
  const instances = settings.filter((r) => t(r, 'KEY')?.toUpperCase() === 'INSTANCE_ID');
  if (instances.length !== 1) throw new Error('SETTINGS harus memiliki tepat satu INSTANCE_ID.');
  const instance = t(instances[0], 'VALUE', true);
  const groups = new Map();
  const loanByObject = new Map();
  for (const r of rowsOf(sheets, 'PEMINJAMAN', [
    'PEMINJAMAN_ID', 'BERKAS_ID', 'JENIS_OBJEK', 'STATUS', 'NAMA_PEMINJAM',
    'TANGGAL_PINJAM', 'TANGGAL_WAJIB_KEMBALI', 'TANGGAL_KEMBALI',
  ])) {
    const id = t(r, 'PEMINJAMAN_ID', true);
    const group = t(r, 'LOAN_GROUP_ID') || id;
    if (loanByObject.has(id)) throw problem(r, 'ID objek peminjaman ganda');
    loanByObject.set(id, group);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(r);
  }
  const prints = [];
  for (const [name, action] of [
    ['LOG_CETAK_OUT_INDICATOR', 'LEGACY_OUT_INDICATOR'],
    ['LOG_CETAK_BERITA_ACARA', 'LEGACY_BERITA_ACARA'],
  ]) {
    const seen = new Set();
    for (const r of rowsOf(sheets, name, ['PRINT_ID', 'TIMESTAMP', 'LOAN_GROUP_ID', 'STATUS'])) {
      const id = t(r, 'PRINT_ID', true);
      if (seen.has(id)) throw problem(r, 'ID log cetak ganda');
      seen.add(id);
      const ref = t(r, 'LOAN_GROUP_ID', true);
      const group = groups.has(ref) ? ref : loanByObject.get(ref) || ref;
      const status = t(r, 'STATUS', true).toUpperCase();
      if (!['PDF_DIBUAT', 'DOCS_DIBUAT', 'DICETAK'].includes(status)) throw problem(r, 'status dokumen tidak dikenal');
      prints.push({ id, group, action, status, time: checked(r, 'TIMESTAMP', convert.timestamp, true), row: r });
    }
  }
  return { instance, groups, prints };
}

export async function applyLoanHistory(client, unitCode, history, apply = false) {
  const report = { addedLoans: 0, existingLoans: 0, skippedOpenLoans: 0, addedPrintLogs: 0, existingPrintLogs: 0, unmatchedPrintRows: [] };
  await client.query('begin');
  try {
    const { rows: [unit] } = await client.query('select id,legacy_instance_id from public.units where code = $1', [unitCode]);
    if (!unit || unit.legacy_instance_id !== history.instance) {
      throw new Error('Unit tujuan tidak ditemukan atau INSTANCE_ID ekspor tidak cocok.');
    }
    const unitId = unit.id;
    await client.query('select app.lock_unit($1)', [unitId]);
    const { rows: prior } = await client.query('select id from public.loan_groups where unit_id = $1', [unitId]);
    const known = new Set(prior.map(({ id }) => id));
    for (const [id, rows] of history.groups) {
      // Never rewrite v4 data, even when the old spreadsheet still marks it active.
      if (known.has(id)) { report.existingLoans++; continue; }
      const status = one(rows, (r) => t(r, 'STATUS', true).toUpperCase(), 'status');
      if (status === 'DIPINJAM') { report.skippedOpenLoans++; continue; }
      if (status !== 'KEMBALI') throw problem(rows[0], 'status pinjaman tidak dikenal');
      const value = (key) => one(rows, (r) => t(r, key), key);
      const date = (key) => one(rows, (r) => d(r, key), key);
      const start = date('TANGGAL_PINJAM'), due = date('TANGGAL_WAJIB_KEMBALI'), end = date('TANGGAL_KEMBALI');
      if (due < start || end < start) throw problem(rows[0], 'tanggal pinjam, jatuh tempo atau kembali tidak konsisten');
      const condition = (k) => one(rows, (r) => checked(r, k, KONDISI), k);
      const created = one(rows, (r) => checked(r, 'CREATED_AT', convert.timestamp), 'CREATED_AT');
      const objects = [];
      const seen = new Map();
      for (const r of rows) {
        const objectId = t(r, 'PEMINJAMAN_ID', true), folderId = t(r, 'BERKAS_ID', true);
        const type = t(r, 'JENIS_OBJEK', true).toUpperCase();
        const itemId = t(r, 'ITEM_ID');
        if (!(type === 'ITEM' && itemId || type === 'BERKAS' && !itemId)) throw problem(r, 'jenis atau ID objek tidak konsisten');
        const folderItems = seen.get(folderId) ?? new Set();
        if (folderItems.has(itemId) || folderItems.has(null) || (!itemId && folderItems.size)) {
          throw problem(r, 'objek berulang atau bertumpang tindih dalam satu grup');
        }
        folderItems.add(itemId);
        seen.set(folderId, folderItems);
        // Resolve only by stable identifiers within the unit, not by a recycled folder number.
        const { rows: [b] } = await client.query(`select b.no_berkas_definitif, b.judul_berkas,
          i.id item_id, i.no_item_definitif, i.uraian_lengkap
          from public.berkas b left join public.item i on i.unit_id=b.unit_id and i.berkas_id=b.id and i.id=$3
          where b.unit_id=$1 and b.id=$2`, [unitId, folderId, itemId]);
        if (!b || (itemId && !b.item_id)) throw problem(r, 'berkas atau item tidak ditemukan pada unit dan hubungan yang sesuai');
        const number = int(r, 'NO_BERKAS_SNAPSHOT') ?? b.no_berkas_definitif;
        if (number == null) throw problem(r, 'nomor berkas tidak tersedia');
        const description = t(r, 'URAIAN_OBJEK_SNAPSHOT');
        objects.push([unitId, objectId, id, folderId, itemId, number,
          (!itemId && description) || b.judul_berkas,
          itemId ? int(r, 'NO_ITEM_SNAPSHOT') ?? b.no_item_definitif : null,
          itemId ? description || b.uraian_lengkap : null,
          t(r, 'LOKASI_ASAL_SNAPSHOT') || '—', int(r, 'JUMLAH_HALAMAN_ITEM') ?? 0]);
      }
      const count = one(rows, (r) => int(r, 'JUMLAH_HALAMAN_GRUP_SNAPSHOT'), 'jumlah halaman grup')
        ?? objects.reduce((n, o) => n + o[10], 0);
      if (!count || count > 2147483647) throw problem(rows[0], 'jumlah halaman grup tidak valid');
      const borrower = value('NAMA_PEMINJAM');
      if (!borrower) throw problem(rows[0], 'nama peminjam tidak tersedia');
      await client.query(`insert into public.loan_groups
        (unit_id,id,borrower_name,borrower_position,borrower_unit,officer_name,officer_position,purpose,
          borrowed_on,due_on,borrow_condition,notes,page_count,returned_on,return_condition,
          return_officer_name,return_officer_position,created_at)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
          coalesce($18::timestamptz,$9::date::timestamp at time zone 'Asia/Jakarta'))`,
      [unitId,id,borrower,value('JABATAN_PEMINJAM') ?? '',value('UNIT_KERJA') ?? '',
        value('PETUGAS_PINJAM_NAMA') ?? '',value('PETUGAS_PINJAM_JABATAN') ?? '',value('KEPERLUAN') ?? '',
        start,due,condition('KONDISI_PINJAM'),value('CATATAN'),count,end,condition('KONDISI_KEMBALI'),
        value('PETUGAS_KEMBALI_NAMA'),value('PETUGAS_KEMBALI_JABATAN'),created]);
      for (const o of objects) {
        await client.query(`insert into public.loan_objects
          (unit_id,id,loan_id,berkas_id,item_id,berkas_no,berkas_title,item_no,item_description,location,page_count)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,o);
      }
      known.add(id);
      report.addedLoans++;
    }
    for (const log of history.prints) {
      if (!known.has(log.group)) {
        report.unmatchedPrintRows.push({ sheet: log.row.sheet, row: log.row.rowNumber });
        continue;
      }
      const auditId = 'S4H-' + createHash('sha256').update(JSON.stringify([unitId, log.action, log.id])).digest('hex');
      const result = await client.query(`insert into public.audit_log
        (id,unit_id,occurred_at,action,module,object_type,object_id,summary,request_id,after_data)
        values ($1,$2,$3,$4,'PEMINJAMAN','LOAN',$5,'Riwayat dokumen dari Central File 3.x',$6,$7)
        on conflict (id) do nothing`,
      [auditId,unitId,log.time,log.action,log.group,log.id,{ source_status: log.status }]);
      if (result.rowCount) report.addedPrintLogs++;
      else report.existingPrintLogs++;
    }
    // Review unmatched links first. Even --apply leaves the database untouched in this case.
    const committed = apply && !report.unmatchedPrintRows.length;
    await client.query(committed ? 'commit' : 'rollback');
    return { committed, ...report };
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
}
