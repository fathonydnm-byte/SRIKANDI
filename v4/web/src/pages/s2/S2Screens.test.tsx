import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../../test/renderApp';
import { createFakeClient, makeProfile, makeSession, type RpcHandler } from '../../test/fakeSupabase';
import type { Role } from '../../auth/permissions';
import type { FilingOptions, ReceiptOptions, ReceiptPrint, RegistrationOptions } from '../../lib/s2api';
import { uploads } from '../../lib/uploadStore';
import { canUseHalfPage } from './ReceiptPrintPage';

const RECEIPT_OPTIONS: ReceiptOptions = {
  unit_id: 'unit-1',
  employees: [{ id: 'PGW-1', name: 'Budi Santoso', unit: 'Subbag Umum', label: 'Budi Santoso — Subbag Umum' }],
  receipts: [{
    id: 'RCV-A', number: 'TRM-2026-0001', year: 2026, received_at: '2026-11-13T02:00:00Z', sender_employee_id: 'PGW-1', sender_name: 'Budi Santoso',
    sender_unit: 'Subbag Umum', receiver_name: 'Siti', receiver_unit: 'Bagian Umum', location: 'Surabaya', notes: null, item_count: 1, total_pages: 3,
    status: 'AKTIF', evidence_file_id: null, evidence_name: null, cancellation_reason: null, cancellation_evidence_file_id: null, cancelled_at: null,
    filed_count: 0, pending_count: 1, incomplete_count: 0, print_count: 0, can_edit_header: true, can_edit: true, can_complete_metadata: true,
    items: [{ id: 'RCVI-1', archive_id: 'ARS-1', number: 1, description: 'Surat undangan rapat', page_count: 3, development_level: 'ASLI', condition: 'BAIK',
      security_classification: 'BIASA/TERBUKA', primary_letter_number: 'B-1/2026', alternate_letter_number: null, document_date: '2026-11-01', notes: null,
      filing_status: 'BELUM DIBERKASKAN', filed_berkas_id: null, filed_item_id: null, filed_berkas_number: null, filed_item_number: null, metadata_complete: true, can_edit: true }],
  }],
  defaults: { receiver_name: 'Siti Aminah', receiver_unit: 'Bagian Umum', location: 'Surabaya' },
  development_levels: ['ASLI', 'COPY'],
  conditions: ['BAIK', 'RUSAK RINGAN', 'RUSAK SEDANG', 'RUSAK BERAT'],
  security_classifications: ['BIASA/TERBUKA', 'TERBATAS', 'RAHASIA', 'SANGAT RAHASIA'],
  summary: { total: 1, active: 1, with_evidence: 0, cancelled: 0 },
};

const REG: RegistrationOptions = {
  unit_id: 'unit-1',
  berkas: [{ id: 'BRK-1', number: 1, title: 'Renstra', classification_code: 'PR.01', security_classification: 'BIASA/TERBUKA', label: '1 — Renstra' }],
  classifications: [
    { id: 'K1', parent_id: null, level: '1', code: 'PR', description: 'Perencanaan', label: 'PR – Perencanaan', selectable: false },
    { id: 'K2', parent_id: 'K1', level: '2', code: 'PR.01', description: 'Rencana strategis', label: 'PR.01 – Rencana strategis', selectable: true },
    { id: 'K3', parent_id: 'K2', level: '3', code: 'PR.01.01', description: 'Renstra', label: 'PR.01.01 – Renstra', selectable: true },
  ],
  retention_units: ['TAHUN', 'BULAN'], final_dispositions: ['MUSNAH', 'PERMANEN', 'DINILAI KEMBALI'],
  security_classifications: ['BIASA/TERBUKA', 'TERBATAS', 'RAHASIA', 'SANGAT RAHASIA'], development_levels: ['ASLI', 'COPY'],
};

const QUEUE: FilingOptions = {
  items: [
    { id: 'RCVI-1', archive_id: 'ARS-1', receipt_id: 'RCV-A', receipt_number: 'TRM-2026-0001', receipt_item_number: 1, received_at: '2026-11-13T02:00:00Z',
      sender_name: 'Budi', sender_unit: 'Umum', primary_letter_number: 'B-1/2026', alternate_letter_number: null, document_date: '2026-11-01',
      description: 'Surat undangan rapat', page_count: 3, development_level: 'ASLI', condition: 'BAIK', security_classification: 'BIASA/TERBUKA', notes: null, status: 'BELUM DIBERKASKAN', selectable: true },
    { id: 'RCVI-2', archive_id: 'ARS-2', receipt_id: 'RCV-A', receipt_number: 'TRM-2026-0001', receipt_item_number: 2, received_at: '2026-11-13T02:00:00Z',
      sender_name: 'Budi', sender_unit: 'Umum', primary_letter_number: null, alternate_letter_number: null, document_date: null,
      description: 'Notulen tanpa tanggal', page_count: 2, development_level: 'COPY', condition: 'BAIK', security_classification: 'TERBATAS', notes: null, status: 'PERLU DILENGKAPI', selectable: false },
  ],
  total_queue: 2, truncated: false, summary: { pending: 1, incomplete: 1, filed: 4 }, max_batch_size: 100,
};

function setup(role: Role, rpc: Record<string, RpcHandler>) {
  return createFakeClient({ session: makeSession(), profile: makeProfile(role), rpc });
}

afterEach(() => {
  uploads.reset();
  vi.unstubAllGlobals();
});

describe('Penerimaan Naskah', () => {
  it('menyimpan tanda terima dengan satu ketukan; ketuk ganda tidak membuat duplikat; formulir langsung siap', async () => {
    let release: () => void = () => {};
    const save = vi.fn<RpcHandler>(() => new Promise((r) => (release = () => r({ data: { ok: true, receipt_id: 'RCV-B', number: 'TRM-2026-0002', is_update: false, item_count: 1, total_pages: 2, message: 'Tersimpan.' }, error: null }))));
    const fake = setup('PETUGAS', { receipt_options: () => ({ data: RECEIPT_OPTIONS, error: null }), receipt_save: save });
    renderApp('/penerimaan', fake.client);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText('Pegawai penyerah *'), 'PGW-1');
    expect(screen.getByLabelText('Nama penerima arsip *')).toHaveValue('Siti Aminah'); // default unit
    await user.type(screen.getByLabelText('Uraian informasi arsip *'), 'SK Rektor tentang panitia');
    await user.clear(screen.getByLabelText('Jumlah halaman *'));
    await user.type(screen.getByLabelText('Jumlah halaman *'), '2');
    const btn = screen.getByRole('button', { name: 'Simpan & Cetak' });
    await user.click(btn);
    await user.click(screen.getByRole('button', { name: 'Menyimpan…' }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Menyimpan tanda terima…')).toBeInTheDocument();
    const args = save.mock.calls[0]![0] as { p_request_id: string; p_payload: { items: { description: string; page_count: number }[]; sender_employee_id: string } };
    expect(args.p_request_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(args.p_payload.sender_employee_id).toBe('PGW-1');
    expect(args.p_payload.items[0]).toMatchObject({ description: 'SK Rektor tentang panitia', page_count: 2, development_level: 'ASLI', condition: 'BAIK' });
    release();
    expect(await screen.findByText(/Tanda terima tersimpan: TRM-2026-0002/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Cetak Tanda Terima' })).toHaveAttribute('href', '/penerimaan/RCV-B/cetak');
    expect(screen.getByLabelText('Uraian informasi arsip *')).toHaveValue('');
    expect(screen.getByLabelText('Pegawai penyerah *')).toHaveFocus();
  });

  it('validasi di klien tanpa memanggil server', async () => {
    const save = vi.fn<RpcHandler>();
    renderApp('/penerimaan', setup('PETUGAS', { receipt_options: () => ({ data: RECEIPT_OPTIONS, error: null }), receipt_save: save }).client);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Simpan & Cetak' }));
    expect(screen.getByText('Pilih pegawai penyerah.')).toBeInTheDocument();
    expect(screen.getByText('Uraian wajib diisi.')).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  it('gangguan jaringan: ulang otomatis dengan request id yang SAMA', async () => {
    let n = 0;
    const save = vi.fn<RpcHandler>(() => (++n === 1 ? { data: null, error: { message: 'TypeError: Failed to fetch' } } : { data: { ok: true, receipt_id: 'RCV-C', number: 'TRM-2026-0003', is_update: false, item_count: 1, total_pages: 1, message: '' }, error: null }));
    renderApp('/penerimaan', setup('PETUGAS', { receipt_options: () => ({ data: RECEIPT_OPTIONS, error: null }), receipt_save: save }).client);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText('Pegawai penyerah *'), 'PGW-1');
    await user.type(screen.getByLabelText('Uraian informasi arsip *'), 'x');
    await user.click(screen.getByRole('button', { name: 'Simpan & Cetak' }));
    expect(await screen.findByText(/TRM-2026-0003/, {}, { timeout: 3000 })).toBeInTheDocument();
    const ids = save.mock.calls.map((c) => (c[0] as { p_request_id: string }).p_request_id);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it('error bisnis API_S2 ditampilkan tanpa kode', async () => {
    const save = vi.fn<RpcHandler>(() => ({ data: null, error: { code: 'P0001', message: 'NOT_FOUND: Pegawai penyerah tidak aktif.', hint: 'NOT_FOUND' } as never }));
    renderApp('/penerimaan', setup('PETUGAS', { receipt_options: () => ({ data: RECEIPT_OPTIONS, error: null }), receipt_save: save }).client);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText('Pegawai penyerah *'), 'PGW-1');
    await user.type(screen.getByLabelText('Uraian informasi arsip *'), 'x');
    await user.click(screen.getByRole('button', { name: 'Simpan & Cetak' }));
    expect(await screen.findByText('Pegawai penyerah tidak aktif.')).toBeInTheDocument();
  });

  it('tambah pegawai langsung dari formulir', async () => {
    const add = vi.fn<RpcHandler>(() => ({ data: { ok: true, employee: { id: 'PGW-9', name: 'Ani', unit: 'Keuangan', label: 'Ani — Keuangan' }, created: true, reactivated: false, message: 'Pegawai ditambahkan.' }, error: null }));
    renderApp('/penerimaan', setup('PETUGAS', { receipt_options: () => ({ data: RECEIPT_OPTIONS, error: null }), pegawai_add: add }).client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '+ Pegawai' }));
    const dialog = screen.getByRole('dialog', { name: 'Tambah Pegawai' });
    await user.type(within(dialog).getByLabelText('Nama pegawai *'), 'Ani');
    await user.type(within(dialog).getByLabelText('Unit kerja *'), 'Keuangan');
    await user.click(within(dialog).getByRole('button', { name: 'Simpan Pegawai' }));
    await waitFor(() => expect(screen.getByLabelText('Pegawai penyerah *')).toHaveValue('PGW-9'));
    expect(add.mock.calls[0]![0]).toMatchObject({ p_name: 'Ani', p_unit_kerja: 'Keuangan' });
  });

  it('riwayat: cetak, upload bukti, edit, batalkan sesuai status', async () => {
    renderApp('/penerimaan', setup('PETUGAS', { receipt_options: () => ({ data: RECEIPT_OPTIONS, error: null }) }).client);
    const card = (await screen.findByText('TRM-2026-0001')).closest('li')!;
    expect(within(card).getByRole('link', { name: 'Cetak' })).toHaveAttribute('href', '/penerimaan/RCV-A/cetak');
    for (const b of ['Upload Bukti', 'Edit', 'Batalkan']) expect(within(card).getByRole('button', { name: b })).toBeInTheDocument();
  });

  it('pembatalan: alasan ≥ 10 karakter dan ketik BATALKAN', async () => {
    const cancel = vi.fn<RpcHandler>(() => ({ data: { ok: true, receipt_id: 'RCV-A', evidence_file_id: null, message: 'Tanda terima dibatalkan.' }, error: null }));
    renderApp('/penerimaan', setup('ADMIN_UNIT', { receipt_options: () => ({ data: RECEIPT_OPTIONS, error: null }), receipt_cancel: cancel }).client);
    const user = userEvent.setup();
    const card = (await screen.findByText('TRM-2026-0001')).closest('li')!;
    await user.click(within(card).getByRole('button', { name: 'Batalkan' }));
    const dialog = screen.getByRole('dialog', { name: 'Batalkan Tanda Terima' });
    await user.type(within(dialog).getByLabelText('Alasan pembatalan *'), 'pendek');
    await user.click(within(dialog).getByRole('button', { name: 'Batalkan Tanda Terima' }));
    expect(within(dialog).getByText('Alasan minimal 10 karakter.')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Alasan pembatalan *'), ' karena salah input');
    await user.type(within(dialog).getByLabelText('Konfirmasi *'), 'batalkan');
    await user.click(within(dialog).getByRole('button', { name: 'Batalkan Tanda Terima' }));
    expect(await screen.findByText('Tanda terima dibatalkan.')).toBeInTheDocument();
    expect(cancel.mock.calls[0]![0]).toMatchObject({ p_receipt_id: 'RCV-A', p_reason: 'pendek karena salah input', p_confirmation: 'batalkan', p_evidence_session_id: null });
  });

  it('Admin Pusat harus memilih unit sebelum mencatat', async () => {
    renderApp('/penerimaan', setup('ADMIN_PUSAT', {}).client);
    expect(await screen.findByText('Pilih unit terlebih dahulu.')).toBeInTheDocument();
  });
});

describe('Cetak Tanda Terima', () => {
  const PRINT: ReceiptPrint = {
    ok: true, print_token: 'RCPRINT-1', receipt_id: 'RCV-A', number: 'TRM-2026-0001', received_at: '2026-11-13T02:05:00Z', sender_name: 'Budi Santoso', sender_unit: 'Subbag Umum',
    receiver_name: 'Siti', receiver_unit: 'Bagian Umum', location: 'Surabaya', notes: null, status: 'AKTIF', cancellation_reason: null, cancelled_at: null,
    is_reprint: false, print_number: 1, generated_at: '2026-11-13T03:00:00Z', file_name: 'TRM-2026-0001_Tanda-Terima-Penyerahan-Arsip.pdf',
    items: [{ number: 1, description: 'Surat undangan rapat', page_count: 3, development_level: 'ASLI', condition: 'BAIK' }],
  };
  it('dua salinan dalam satu lembar untuk tanda terima pendek; konfirmasi cetak tercatat', async () => {
    const confirm = vi.fn<RpcHandler>(() => ({ data: { ok: true, print_count: 1 }, error: null }));
    vi.stubGlobal('print', vi.fn(() => window.dispatchEvent(new Event('afterprint'))));
    renderApp('/penerimaan/RCV-A/cetak', setup('PETUGAS', { receipt_print_prepare: () => ({ data: PRINT, error: null }), receipt_print_confirm: confirm }).client);
    expect(await screen.findByRole('region', { name: 'Salinan UNTUK PENYERAH' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Salinan UNTUK PENERIMA' })).toBeInTheDocument();
    expect(screen.getByText('GUNTING DI GARIS INI')).toBeInTheDocument();
    expect(screen.getAllByText('13 November 2026, 09.05 WIB', { exact: false })).toHaveLength(2);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Cetak Tanda Terima' }));
    await user.click(await screen.findByRole('button', { name: 'Ya, sudah tercetak' }));
    expect(await screen.findByText('Cetakan ke-1 tercatat.')).toBeInTheDocument();
    expect(confirm).toHaveBeenCalledWith({ p_receipt_id: 'RCV-A', p_print_token: 'RCPRINT-1', p_file_name: PRINT.file_name }, undefined);
  });
  it('banyak item: satu salinan per lembar; batal diberi tanda', () => {
    expect(canUseHalfPage({ items: PRINT.items, notes: null })).toBe(true);
    expect(canUseHalfPage({ items: Array.from({ length: 4 }, () => PRINT.items[0]!), notes: null })).toBe(false);
    expect(canUseHalfPage({ items: [{ ...PRINT.items[0]!, description: 'x'.repeat(500) }], notes: null })).toBe(false);
  });
});

describe('Registrasi Berkas Baru', () => {
  it('dari antrean penerimaan ke berkas yang ada; hasil menampilkan nomor definitif', async () => {
    const commit = vi.fn<RpcHandler>(() => ({ data: {
      ok: true, request_id: 'x', berkas_id: 'BRK-1', berkas_number: 1, berkas_title: 'Renstra', item_count: 1, total_pages: 3, renumbered_item_count: 0, renumbered_berkas_count: 0,
      items: [{ receipt_item_id: 'RCVI-1', item_id: 'ITM-9', berkas_number: 1, item_number: 3, description: 'Surat undangan rapat' }], drive_tasks: [], message: '',
    }, error: null }));
    renderApp('/pemberkasan', setup('PETUGAS', {
      registration_options: () => ({ data: REG, error: null }), filing_options: () => ({ data: QUEUE, error: null }), filing_commit: commit,
    }).client);
    const user = userEvent.setup();
    const blocked = await screen.findByRole('checkbox', { name: /Notulen tanpa tanggal/ });
    expect(blocked).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: /Surat undangan rapat/ }));
    expect(screen.getByText(/1 item dipilih · 3 halaman/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Berkas induk *'), 'BRK-1');
    await user.click(screen.getByRole('button', { name: 'Berkaskan Item Terpilih' }));
    expect(await screen.findByRole('link', { name: 'Berkas 1 / Item 3 — Surat undangan rapat' })).toHaveAttribute('href', '/cari/berkas/BRK-1');
    expect(commit.mock.calls[0]![0]).toMatchObject({ p_receipt_item_ids: ['RCVI-1'], p_target: { mode: 'EXISTING', berkas_id: 'BRK-1' } });
    expect(screen.queryByRole('checkbox', { name: /Surat undangan rapat/ })).not.toBeInTheDocument();
  });

  it('input manual ke berkas baru: klasifikasi primer→sekunder, lalu PDF diunggah setelah metadata tersimpan', async () => {
    const create = vi.fn<RpcHandler>(() => ({ data: { ok: true, item_id: 'ITM-NEW', berkas_id: 'BRK-NEW', berkas_number: 2, item_number: 1, file_status: 'BELUM DIUNGGAH', renumbered_item_count: 0, renumbered_berkas_count: 0, drive_tasks: [], message: '' }, error: null }));
    const start = vi.spyOn(uploads, 'start').mockReturnValue('JOB');
    renderApp('/pemberkasan', setup('PETUGAS', { registration_options: () => ({ data: REG, error: null }), filing_options: () => ({ data: QUEUE, error: null }), item_create_manual: create }).client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Input Manual' }));
    await user.click(screen.getByRole('button', { name: 'Buat Berkas Baru' }));
    await user.type(screen.getByLabelText('Judul berkas *'), 'Laporan 2026');
    await user.selectOptions(screen.getByLabelText('Primer *'), 'K1');
    expect(screen.getByText('Primer ini memiliki turunan: pilih sekunder.')).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Sekunder'), 'K2');
    await user.type(screen.getByLabelText('Retensi aktif *'), '2');
    await user.type(screen.getByLabelText('Retensi inaktif *'), '3');
    await user.selectOptions(screen.getByLabelText('Nasib akhir *'), 'PERMANEN');
    await user.type(screen.getByLabelText('Uraian informasi arsip *'), 'Laporan triwulan');
    const pdf = new File(['%PDF-1.4'], 'laporan.pdf', { type: 'application/pdf' });
    await user.upload(screen.getByLabelText('PDF alih media (opsional)'), pdf);
    await user.click(screen.getByRole('button', { name: 'Simpan Item' }));
    expect(await screen.findByText(/Tersimpan: Berkas 2 \/ Item 1\. PDF sedang diunggah\./)).toBeInTheDocument();
    expect(create.mock.calls[0]![0]).toMatchObject({
      p_target: { mode: 'NEW', title: 'Laporan 2026', classification_id: 'K2', active_retention_value: 2, inactive_retention_value: 3, final_disposition: 'PERMANEN' },
      p_item: { description: 'Laporan triwulan', page_count: 1, development_level: 'ASLI', security_classification: 'BIASA/TERBUKA' },
    });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'ITEM_PDF', objectId: 'ITM-NEW', fileName: 'laporan.pdf' }), 'PDF Berkas 2 / Item 1', expect.any(Function));
    // berkas terkunci sebagai "yang ada" untuk item berikutnya; isian item bersih
    expect(screen.getByLabelText('Berkas induk *')).toHaveValue('BRK-NEW');
    expect(screen.getByLabelText('Uraian informasi arsip *')).toHaveValue('');
    expect(screen.getByLabelText('Nomor surat utama')).toHaveFocus();
  });
});

describe('Alih Media Arsip', () => {
  it('pilih berkas → item tanpa PDF → unggah; titik sambung pemindai belum aktif', async () => {
    const start = vi.spyOn(uploads, 'start').mockReturnValue('JOB');
    renderApp('/alih-media', setup('PETUGAS', {
      media_options: () => ({ data: { ok: true, unit_id: 'unit-1', total_missing: 1, berkas: [{ id: 'BRK-1', number: 1, title: 'Renstra', label: '1 – Renstra (1 belum ada PDF)',
        items: [{ id: 'ITM-2', number: 2, description: 'Belum ada PDF', document_date: '2026-01-02', page_count: 4, file_status: 'BELUM DIUNGGAH', planned_file_name: '1_2_Belum ada PDF.pdf', label: '2 – Belum ada PDF' }] }] }, error: null }),
    }).client);
    const user = userEvent.setup();
    await user.selectOptions(await screen.findByLabelText('Berkas induk *'), 'BRK-1');
    const itemSel = screen.getByLabelText('Item tanpa PDF *');
    expect(within(itemSel).getAllByRole('option')).toHaveLength(2);
    await user.selectOptions(itemSel, 'ITM-2');
    expect(screen.getByText('Belum ada PDF', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText(/nama file: 1_2_Belum ada PDF\.pdf/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Pindai dengan kamera \(Sprint 6\)/ })).toBeDisabled();
    await user.upload(screen.getByLabelText('PDF alih media *'), new File(['%PDF'], 'scan.pdf', { type: 'application/pdf' }));
    await user.click(screen.getByRole('button', { name: 'Upload Alih Media' }));
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'ITEM_PDF', objectId: 'ITM-2' }), 'PDF Berkas 1 / Item 2', expect.any(Function));
    expect(screen.getByText(/unggahan dimulai/)).toBeInTheDocument();
  });
});
