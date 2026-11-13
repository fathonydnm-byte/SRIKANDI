// Readable (Indonesian) rendering of the reconciliation report.
const STATUS = {
  BERHASIL: 'BERHASIL — data tersimpan',
  UJI_COBA_BERHASIL: 'UJI COBA BERHASIL — tidak ada yang disimpan (--dry-run)',
  GAGAL: 'GAGAL — tidak ada yang disimpan'
};

const n = (v) => (v ?? 0).toLocaleString('id-ID');

export function renderText(r) {
  const out = [];
  const line = (s = '') => out.push(s);
  const h = (s) => { line(); line(s); line('-'.repeat(s.length)); };

  line('LAPORAN IMPOR CENTRAL FILE 3.x -> v4');
  line(`Berkas ekspor : ${r.file} (sha256 ${r.fileSha256?.slice(0, 16)}…)`);
  line(`Mode          : ${r.mode === 'UJI_COBA' ? 'uji coba (--dry-run)' : 'impor'}${r.strict ? ', ketat' : ''}`);
  line(`Status        : ${STATUS[r.status] || r.status}`);
  if (r.unit) line(`Unit          : ${r.unit.code} — ${r.unit.name} (${r.unit.action}); instance ${r.unit.legacyInstanceId || '–'}`);

  if (r.fatal?.length) {
    h('Kesalahan yang menghentikan impor');
    r.fatal.forEach((f) => line(`  ! ${f}`));
  }

  if (r.tables) {
    h('Ringkasan per tabel');
    line('  tabel             dibaca  diterima  baru  diubah  tetap  ditolak  hanya-di-DB');
    for (const [t, s] of Object.entries(r.tables)) {
      line(`  ${t.padEnd(17)} ${String(s.read).padStart(6)} ${String(s.accepted).padStart(9)} ${String(s.inserted).padStart(5)} ${String(s.updated).padStart(7)} ${String(s.unchanged).padStart(6)} ${String(s.rejected).padStart(8)} ${String(s.inDatabaseNotInExport).padStart(12)}`);
    }
    for (const [t, s] of Object.entries(r.tables)) {
      if (s.duplicateIdenticalRows) line(`  ${t}: ${s.duplicateIdenticalRows} baris kembar identik dilewati`);
      if (Object.keys(s.defaultsApplied).length) line(`  ${t}: nilai kosong diisi bawaan — ${Object.entries(s.defaultsApplied).map(([c, k]) => `${c} ×${k}`).join(', ')}`);
      if (Object.keys(s.changedColumns).length) line(`  ${t}: kolom yang berubah — ${Object.entries(s.changedColumns).map(([c, k]) => `${c} ×${k}`).join(', ')}`);
    }
    const rejected = Object.entries(r.tables).flatMap(([t, s]) => s.rejectedRows.map((x) => ({ t, ...x })));
    if (rejected.length) {
      h('Baris ditolak');
      rejected.forEach((x) => line(`  ${x.t} ${x.id ?? '?'} (sheet ${x.sheet ?? '?'} baris ${x.row ?? '?'}): ${x.reasons.join('; ')}`));
    }
  }

  if (r.orphans) {
    h('Pemeriksaan yatim (orphan)');
    line(`  Ditolak karena induk tidak ada : ${r.orphans.rejected.length}`);
    r.orphans.rejected.forEach((o) => line(`    - ${o.table} ${o.id}: ${o.reason}`));
    line(`  Referensi dikosongkan          : ${r.orphans.linksCleared.length}`);
    r.orphans.linksCleared.forEach((o) => line(`    - ${o.table} ${o.id}.${o.column} = ${o.value} (tidak ada di ${o.missingIn})`));
    line(`  ARSIP_ID item tanpa sumber     : ${r.orphans.arsipWithoutSource.length}`);
    r.orphans.arsipWithoutSource.forEach((o) => line(`    - item ${o.itemId}: ARSIP_ID ${o.arsipId} (sumber ${o.sumber || '–'})`));
  }

  if (r.duplicates) {
    h('Nomor ganda pada data aktif');
    const all = Object.entries(r.duplicates).flatMap(([k, l]) => l.map((d) => `${k} ${d.number}: ${d.ids.join(', ')}`));
    line(all.length ? all.map((s) => `  ! ${s}`).join('\n') : '  tidak ada');
  }

  if (r.totals) {
    h('Total pembanding laporan lama');
    line(`  Berkas aktif (bernomor, tidak dihapus, belum dipindahkan): ${n(r.totals.berkasAktif)}`);
    line(`  Item aktif                                              : ${n(r.totals.itemAktif)}`);
    line(`  Total lembar item aktif                                 : ${n(r.totals.totalLembarItemAktif)}`);
    line(`  Berkas dihapus/dibatalkan: ${n(r.totals.berkasDibatalkanAtauDihapus)} · item dihapus: ${n(r.totals.itemDihapus)} · penerimaan dibatalkan: ${n(r.totals.penerimaanDibatalkan)}`);
    if (r.totals.selisihJumlahPerBerkas.length) {
      line('  Selisih JUMLAH_ITEM/TOTAL_HALAMAN tercatat vs jumlah item aktif:');
      r.totals.selisihJumlahPerBerkas.forEach((m) => line(`    - berkas no ${m.nomor} (${m.berkasId}): item ${m.jumlahItemTercatat ?? '–'} vs ${m.jumlahItemDihitung}, lembar ${m.totalHalamanTercatat ?? '–'} vs ${m.totalHalamanDihitung}`));
    } else line('  JUMLAH_ITEM dan TOTAL_HALAMAN setiap berkas aktif cocok dengan item aktifnya.');
  }
  if (r.legacyReports && Object.keys(r.legacyReports).length) {
    h('Perbandingan dengan sheet laporan lama');
    const b = r.legacyReports.daftarBerkas;
    if (b) {
      line(`  ${b.sheet}: ${b.barisLaporan} baris vs ${b.berkasAktifImpor} berkas aktif — ${b.cocok ? 'COCOK' : 'TIDAK COCOK'}`);
      b.selisih.forEach((d) => line(`    - berkas no ${d.nomorBerkas}: impor ${JSON.stringify(d.impor)} · laporan ${JSON.stringify(d.laporanLama)}`));
    }
    const i = r.legacyReports.daftarIsiBerkas;
    if (i) line(`  ${i.sheet}: ${i.barisLaporan} baris vs ${i.itemAktifImpor} item aktif — ${i.cocok ? 'COCOK' : 'TIDAK COCOK'}`);
  }
  if (r.dbVerification) {
    h('Verifikasi database setelah tulis');
    const v = r.dbVerification;
    line(`  berkas aktif ${v.berkasAktif}, item aktif ${v.itemAktif}, lembar ${v.totalLembarItemAktif} — ${v.cocokDenganEkspor ? 'cocok dengan ekspor' : 'TIDAK cocok dengan ekspor (ada data lain di DB?)'}`);
    line(`  baris per tabel untuk unit ini: ${Object.entries(v.jumlahBarisPerTabel).map(([t, c]) => `${t}=${c}`).join(', ')}`);
  }

  if (r.sheets) {
    h('Sheet');
    line(`  Diimpor        : ${r.sheets.imported.map((s) => `${s.name} (${s.rows})`).join(', ') || '–'}`);
    line('  Ditunda        :');
    r.sheets.deferred.forEach((s) => line(`    - ${s.name}: ${n(s.rows)} baris — ditunda ke sprint ${s.sprint} (${s.module})`));
    if (!r.sheets.deferred.length) line('    –');
    line(`  Laporan turunan (tidak diimpor, dipakai untuk pembanding): ${r.sheets.reportsOnly.map((s) => s.name).join(', ') || '–'}`);
    line(`  Tidak dikenal  : ${r.sheets.unknown.map((s) => `${s.name} (${s.rows} baris)`).join(', ') || '–'}`);
    if (r.sheets.missing.length) line(`  Tidak ada di workbook: ${r.sheets.missing.join(', ')}`);
  }
  if (r.skippedSecretSettings?.length) {
    h('Pengaturan rahasia yang TIDAK diimpor (nama saja)');
    r.skippedSecretSettings.forEach((k) => line(`  - ${k}`));
  }
  if (r.piiColumnsEncrypted?.length) line(`\nKolom data pribadi yang dienkripsi: ${r.piiColumnsEncrypted.join(', ')}`);
  h('Kolom tidak dikenal (tidak diimpor)');
  const unk = Object.entries(r.unknownColumns || {});
  line(unk.length ? unk.map(([s, c]) => `  ${s}: ${c.join(', ')}`).join('\n') : '  tidak ada');
  h('Kolom opsional yang tidak ada');
  const miss = Object.entries(r.missingOptionalColumns || {});
  line(miss.length ? miss.map(([s, c]) => `  ${s}: ${c.join(', ')}`).join('\n') : '  tidak ada');
  if (r.notes?.looseInt?.length) {
    h('Nilai nomor riwayat yang bukan angka (disimpan kosong)');
    r.notes.looseInt.forEach((x) => line(`  ${x.sheet} baris ${x.row} ${x.column}: "${x.value}"`));
  }
  if (r.columnOrder && Object.keys(r.columnOrder).length) {
    h('Urutan kolom sebenarnya');
    for (const [s, c] of Object.entries(r.columnOrder)) line(`  ${s}: ${c.join(', ')}`);
  }
  if (r.openQuestions?.length) {
    h('Pertanyaan terbuka Sprint 0 — isi ekspor sebenarnya');
    for (const q of r.openQuestions) {
      line(`  • ${q.question}`);
      if (!q.sheetPresent) { line(`      sheet ${q.sheet} tidak ada`); continue; }
      if (!q.headersFound.length) { line('      kolom tidak ada di ekspor'); continue; }
      for (const [col, c] of Object.entries(q.columns)) {
        const parts = [`${col}: ${c.nonEmpty} terisi`];
        if (c.distinct) parts.push(`nilai: ${c.distinct.map((d) => `${d.value} ×${d.count}`).join('; ')}`);
        if (c.note) parts.push(c.note);
        if (c.duplicates !== undefined) parts.push(`${c.duplicates} nilai ganda`);
        if (c.nonInteger !== undefined) parts.push(`${c.nonInteger} bukan angka`);
        line(`      ${parts.join(' · ')}`);
      }
    }
  }
  line();
  return out.join('\n');
}
