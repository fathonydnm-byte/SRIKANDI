import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from '../../test/renderApp';
import { createFakeClient, makeProfile, makeSession, type RpcHandler } from '../../test/fakeSupabase';
import type { Role } from '../../auth/permissions';
import { canOpenModule, MODULES } from '../../auth/permissions';
import type { CancelOptions, EditOptions, QuarantineList } from '../../lib/s3api';
import { uploads } from '../../lib/uploadStore';

const EDIT: EditOptions = {
  ok: true, unit_id: 'unit-1',
  berkas: [{
    id: 'BRK-1', number: 1, title: 'Renstra 2026', classification_code: 'PR.01', classification_description: 'Rencana strategis', security_classification: 'BIASA/TERBUKA', loan_status: 'TERSEDIA', can_edit: true, label: '1 — Renstra 2026',
    items: [
      { id: 'ITM-1', number: 1, description: 'Surat undangan rapat', document_date: '2026-03-01', page_count: 3, development_level: 'ASLI', condition: 'BAIK', security_classification: 'BIASA/TERBUKA',
        primary_letter_number: 'B-1/2026', alternate_letter_number: null, file_name: '1_1_Surat.pdf', file_url: null, has_file: true, file_status: 'TERSEDIA', loan_status: 'TERSEDIA', can_edit: true, version: 2, label: '1' },
      { id: 'ITM-2', number: 2, description: 'Notulen dipinjam', document_date: '2026-04-01', page_count: 2, development_level: 'COPY', condition: null, security_classification: 'TERBATAS',
        primary_letter_number: null, alternate_letter_number: null, file_name: null, file_url: null, has_file: false, file_status: 'BELUM DIUNGGAH', loan_status: 'DIPINJAM', can_edit: false, version: 1, label: '2' },
    ],
  }, {
    id: 'BRK-2', number: 2, title: 'Berkas dipinjam', classification_code: 'PR.02', classification_description: null, security_classification: 'BIASA/TERBUKA', loan_status: 'DIPINJAM', can_edit: false, label: '2', items: [],
  }],
  development_levels: ['ASLI', 'COPY'], conditions: ['BAIK', 'RUSAK RINGAN', 'RUSAK SEDANG', 'RUSAK BERAT'],
  security_classifications: ['BIASA/TERBUKA', 'TERBATAS', 'RAHASIA', 'SANGAT RAHASIA'], min_reason_length: 10, replacement_max_bytes: 104857599,
};

const CANCEL: CancelOptions = {
  ok: true, unit_id: 'unit-1',
  berkas: [{
    id: 'BRK-1', number: 1, title: 'Renstra 2026', item_count: 2, page_count: 5, loan_status: 'TERSEDIA', can_cancel: true, label: '1',
    items: [
      { id: 'ITM-1', number: 1, description: 'Surat undangan rapat', document_date: '2026-03-01', page_count: 3, loan_status: 'TERSEDIA', has_file: true, from_receipt: true, receipt_number: 'TRM-2026-0001', is_last_item: false, can_cancel: true, label: '1' },
      { id: 'ITM-2', number: 2, description: 'Notulen terakhir', document_date: '2026-04-01', page_count: 2, loan_status: 'TERSEDIA', has_file: false, from_receipt: false, receipt_number: null, is_last_item: true, can_cancel: false, label: '2' },
    ],
  }],
  scopes: ['ITEM', 'BERKAS'], confirmation_word: 'HAPUS', min_reason_length: 10,
  evidence: { optional: true, max_bytes: 26214400, extensions: ['pdf', 'jpg', 'jpeg', 'png'], mime_types: ['application/pdf', 'image/jpeg', 'image/png'] },
};

const QUAR: QuarantineList = {
  ok: true, unit_id: 'unit-1', total: 1,
  items: [{ id: 'KRN-1', occurred_at: '2026-11-13T02:00:00Z', user_email: 'a@uinsa.ac.id', object_type: 'FILE', object_id: 'DRV-OLD', original_name: '<b>lama.pdf</b>', original_url: null, module: 'EDIT_ARSIP',
    reason: 'Ganti PDF <script>x</script>', status: 'QUARANTINED', notes: null, related_object_type: 'ITEM', related_object_id: 'ITM-1', berkas_id: 'BRK-1', pembatalan_id: null, request_id: 'r',
    app_owned: true, moved_in_drive: false, quarantine_url: null, downloadable: true }],
};

const ok = (data: unknown) => ({ data, error: null });
const biz = (code: string, msg: string) => ({ data: null, error: { code: 'P0001', message: `${code}: ${msg}`, hint: code } as never });

function setup(role: Role, rpc: Record<string, RpcHandler>) {
  return createFakeClient({ session: makeSession(), profile: makeProfile(role), rpc });
}
const rids = (fn: ReturnType<typeof vi.fn<RpcHandler>>) => fn.mock.calls.map((c) => (c[0] as { p_request_id: string }).p_request_id);

const UPDATE_OK = {
  ok: true, request_id: 'x', item_id: 'ITM-1', berkas_id: 'BRK-1', berkas_number: 1, item_number: 2, changed_fields: ['document_date', 'description'], file_replaced: false,
  drive_file_id: null, old_drive_file_id: null, quarantine_id: null, security_classification: 'BIASA/TERBUKA', berkas_security_classification: 'BIASA/TERBUKA',
  renumbered_item_count: 2, renumbered_berkas_count: 0, drive_tasks: [], warnings: [], message: 'Perubahan item tersimpan.', replayed: false,
};

afterEach(() => {
  uploads.reset();
  vi.restoreAllMocks();
});

async function pickItem(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('Cari berkas atau item'), 'undangan');
  await user.click(await screen.findByRole('button', { name: /Item 1 — Surat undangan rapat/ }));
}

describe('Perubahan Arsip', () => {
  it('formulir terisi data saat ini; alasan wajib 10 karakter dengan penghitung; item terpinjam tidak bisa dipilih', async () => {
    const upd = vi.fn<RpcHandler>();
    renderApp('/edit', setup('PETUGAS', { edit_options: () => ok(EDIT), item_update: upd }).client);
    const user = userEvent.setup();
    expect(await screen.findByRole('button', { name: /Notulen dipinjam/ })).toBeDisabled();
    expect(screen.getByText('Sedang dipinjam')).toBeInTheDocument();
    await pickItem(user);
    expect(screen.getByLabelText('Uraian informasi arsip *')).toHaveValue('Surat undangan rapat');
    expect(screen.getByLabelText('Jumlah halaman *')).toHaveValue(3);
    expect(screen.getByLabelText('Kondisi fisik')).toHaveValue('BAIK');
    expect(screen.getByText(/Nomor surat, berkas, klasifikasi arsip/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Alasan perubahan *'), 'pendek');
    expect(screen.getByText('6 / minimal 10 karakter')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Uraian informasi arsip *'));
    await user.type(screen.getByLabelText('Uraian informasi arsip *'), 'Undangan rapat koordinasi');
    await user.click(screen.getByRole('button', { name: 'Simpan Perubahan' }));
    expect(screen.getByText('Alasan minimal 10 karakter.')).toBeInTheDocument();
    expect(upd).not.toHaveBeenCalled();
  });

  it('tanpa perubahan: ditolak di klien (NO_CHANGES) tanpa memanggil server', async () => {
    const upd = vi.fn<RpcHandler>();
    renderApp('/edit', setup('PETUGAS', { edit_options: () => ok(EDIT), item_update: upd }).client);
    const user = userEvent.setup();
    await pickItem(user);
    await user.type(screen.getByLabelText('Alasan perubahan *'), 'alasan yang cukup panjang');
    await user.click(screen.getByRole('button', { name: 'Simpan Perubahan' }));
    expect(screen.getByText('Tidak ada perubahan yang perlu disimpan.')).toBeInTheDocument();
    expect(upd).not.toHaveBeenCalled();
  });

  it('simpan metadata tanpa PDF: payload lengkap, hasil menampilkan nomor lama → baru', async () => {
    const upd = vi.fn<RpcHandler>(() => ok(UPDATE_OK));
    renderApp('/edit', setup('PETUGAS', { edit_options: () => ok(EDIT), item_update: upd }).client);
    const user = userEvent.setup();
    await pickItem(user);
    await user.clear(screen.getByLabelText('Tanggal naskah *'));
    await user.type(screen.getByLabelText('Tanggal naskah *'), '2026-05-01');
    await user.type(screen.getByLabelText('Alasan perubahan *'), 'Tanggal naskah keliru saat input');
    await user.click(screen.getByRole('button', { name: 'Simpan Perubahan' }));
    const box = await screen.findByRole('region', { name: 'Hasil perubahan' });
    expect(within(box).getByText('Nomor item berubah: 1 → 2.')).toBeInTheDocument();
    expect(within(box).getByText(/Penomoran ulang kronologis: 2 item dan 0 berkas/)).toBeInTheDocument();
    expect(upd).toHaveBeenCalledTimes(1);
    expect(upd.mock.calls[0]![0]).toMatchObject({
      p_item_id: 'ITM-1', p_replacement_session_id: null, p_validate_only: false, p_reason: 'Tanggal naskah keliru saat input',
      p_payload: { berkas_id: 'BRK-1', description: 'Surat undangan rapat', page_count: 3, document_date: '2026-05-01', development_level: 'ASLI', condition: 'BAIK', security_classification: 'BIASA/TERBUKA' },
    });
  });

  it('ganti PDF: validasi server dulu (gagal = tidak ada unggahan), lalu unggah, baru item_update dengan sesi; metadata tak berubah', async () => {
    const order: string[] = [];
    let valid = false;
    const upd = vi.fn<RpcHandler>((a) => {
      order.push(a.p_validate_only ? 'validate' : 'update');
      if (a.p_validate_only && !valid) return biz('OBJECT_BORROWED', 'Item sedang dipinjam.');
      return ok(a.p_validate_only ? { ok: true, valid: true, item_id: 'ITM-1', berkas_id: 'BRK-1', changed_fields: [], has_file: true } : { ...UPDATE_OK, changed_fields: ['pdf'], file_replaced: true, quarantine_id: 'KRN-9', item_number: 1 });
    });
    const start = vi.spyOn(uploads, 'start').mockImplementation(() => { order.push('upload'); return 'JOB'; });
    renderApp('/edit', setup('PETUGAS', { edit_options: () => ok(EDIT), item_update: upd }).client);
    const user = userEvent.setup();
    await pickItem(user);
    await user.upload(screen.getByLabelText('Ganti PDF alih media (opsional)'), new File(['%PDF-1.4'], 'baru.pdf', { type: 'application/pdf' }));
    await user.type(screen.getByLabelText('Alasan perubahan *'), 'PDF lama buram, diganti hasil scan ulang');
    await user.click(screen.getByRole('button', { name: 'Simpan Perubahan' }));
    expect(await screen.findByText('Item sedang dipinjam.')).toBeInTheDocument();
    expect(start).not.toHaveBeenCalled();
    valid = true;
    await user.click(screen.getByRole('button', { name: 'Simpan Perubahan' }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(start.mock.calls[0]![0]).toMatchObject({ purpose: 'ITEM_PDF_REPLACE', objectId: 'ITM-1', fileName: 'baru.pdf' });
    expect(order).toEqual(['validate', 'validate', 'upload']); // belum ada update sebelum unggahan selesai
    const done = start.mock.calls[0]![2] as (r: { sessionId: string; driveFileId: string; result: unknown }) => void;
    done({ sessionId: 'UPS-7', driveFileId: 'DRV-NEW', result: {} });
    const box = await screen.findByRole('region', { name: 'Hasil perubahan' });
    expect(within(box).getByText(/Versi lama dipindahkan ke karantina/)).toBeInTheDocument();
    expect(order).toEqual(['validate', 'validate', 'upload', 'update']);
    const last = upd.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect(last).toMatchObject({ p_replacement_session_id: 'UPS-7', p_validate_only: false, p_payload: { description: 'Surat undangan rapat', page_count: 3, condition: 'BAIK', security_classification: 'BIASA/TERBUKA' } });
  });

  it('gangguan jaringan saat menyimpan: request id yang sama dipakai ulang (otomatis dan saat diulang manual)', async () => {
    let n = 0;
    const upd = vi.fn<RpcHandler>(() => (++n <= 3 ? { data: null, error: { message: 'TypeError: Failed to fetch' } } : ok(UPDATE_OK)));
    renderApp('/edit', setup('PETUGAS', { edit_options: () => ok(EDIT), item_update: upd }).client);
    const user = userEvent.setup();
    await pickItem(user);
    await user.clear(screen.getByLabelText('Jumlah halaman *'));
    await user.type(screen.getByLabelText('Jumlah halaman *'), '4');
    await user.type(screen.getByLabelText('Alasan perubahan *'), 'Satu lembar tambahan ditemukan');
    await user.click(screen.getByRole('button', { name: 'Simpan Perubahan' }));
    expect(await screen.findByText(/Tidak dapat terhubung ke server/, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(upd).toHaveBeenCalledTimes(3);
    await user.click(screen.getByRole('button', { name: 'Simpan Perubahan' }));
    await screen.findByRole('region', { name: 'Hasil perubahan' });
    const ids = rids(upd);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(1);
  }, 15000);

  it('ubah judul berkas: berkas terpinjam nonaktif; tersimpan menampilkan judul lama dan baru', async () => {
    const t = vi.fn<RpcHandler>(() => ok({ ok: true, request_id: 'x', berkas_id: 'BRK-1', berkas_number: 1, old_title: 'Renstra 2026', title: 'Renstra 2026–2030', drive_tasks: [], warnings: [], message: 'Judul berkas diperbarui.', replayed: false }));
    renderApp('/edit', setup('PETUGAS', { edit_options: () => ok(EDIT), berkas_update_title: t }).client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Ubah judul berkas' }));
    expect(await screen.findByRole('button', { name: /Berkas dipinjam/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /Renstra 2026/ }));
    await user.clear(screen.getByLabelText('Judul berkas baru *'));
    await user.type(screen.getByLabelText('Judul berkas baru *'), 'Renstra 2026–2030');
    await user.type(screen.getByLabelText('Alasan perubahan *'), 'Periode renstra diperpanjang');
    await user.click(screen.getByRole('button', { name: 'Simpan Judul Berkas' }));
    const box = await screen.findByRole('region', { name: 'Hasil perubahan judul' });
    expect(within(box).getByText('Judul baru: Renstra 2026–2030')).toBeInTheDocument();
    expect(t.mock.calls[0]![0]).toMatchObject({ p_berkas_id: 'BRK-1', p_title: 'Renstra 2026–2030', p_reason: 'Periode renstra diperpanjang' });
  });
});

describe('Koreksi & Pembatalan', () => {
  async function fill(user: ReturnType<typeof userEvent.setup>, word = 'HAPUS') {
    await user.click(await screen.findByRole('button', { name: /Item 1 — Surat undangan rapat/ }));
    await user.type(screen.getByLabelText('Alasan pembatalan *'), 'Naskah ganda, dibatalkan');
    if (word) await user.type(screen.getByLabelText('Konfirmasi *'), word);
  }
  const CANCEL_OK = { ok: true, request_id: 'x', cancellation_id: 'BTL-1', scope: 'ITEM', berkas_id: 'BRK-1', item_id: 'ITM-1', cancelled_item_ids: ['ITM-1'], cancelled_item_count: 1,
    released_receipt_item_ids: ['RCVI-1'], quarantine_ids: ['KRN-1'], evidence_file_id: null, renumbered_item_count: 1, renumbered_berkas_count: 0, drive_tasks: [], warnings: [],
    message: 'Item berhasil dihapus dan nomor item telah disusun ulang.', replayed: false };

  it('item terakhir tidak dapat dipilih; dampak ditampilkan; tombol terkunci sampai kata konfirmasi persis', async () => {
    const cancel = vi.fn<RpcHandler>();
    renderApp('/koreksi', setup('PETUGAS', { cancel_options: () => ok(CANCEL), archive_cancel: cancel }).client);
    const user = userEvent.setup();
    expect(await screen.findByRole('button', { name: /Notulen terakhir/ })).toBeDisabled();
    expect(screen.getByText('Item terakhir: batalkan seluruh berkas')).toBeInTheDocument();
    await fill(user, 'hapuss');
    const dampak = screen.getByText('Dampak pembatalan').parentElement!;
    expect(within(dampak).getByText(/1 baris tanda terima \(TRM-2026-0001\) kembali ke antrean pemberkasan/)).toBeInTheDocument();
    const go = screen.getByRole('button', { name: 'Periksa dan Lanjutkan' });
    expect(go).toBeDisabled();
    await user.clear(screen.getByLabelText('Konfirmasi *'));
    await user.type(screen.getByLabelText('Konfirmasi *'), ' hapus ');
    expect(go).toBeEnabled();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('validate-only gagal: pesan server tampil dan tidak ada pembatalan', async () => {
    const cancel = vi.fn<RpcHandler>(() => biz('OBJECT_BORROWED', 'Item sedang dipinjam; kembalikan dulu.'));
    renderApp('/koreksi', setup('PETUGAS', { cancel_options: () => ok(CANCEL), archive_cancel: cancel }).client);
    const user = userEvent.setup();
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Periksa dan Lanjutkan' }));
    expect(await screen.findByText('Item sedang dipinjam; kembalikan dulu.')).toBeInTheDocument();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel.mock.calls[0]![0]).toMatchObject({ p_validate_only: true, p_confirmation: 'HAPUS', p_scope: 'ITEM', p_item_id: 'ITM-1' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('tanpa bukti: periksa → dialog akhir → batalkan; ketuk ganda satu efek; hasil menampilkan baris tanda terima', async () => {
    const cancel = vi.fn<RpcHandler>((a) => ok(a.p_validate_only ? { ok: true, valid: true, scope: 'ITEM', berkas_id: 'BRK-1', item_id: 'ITM-1', item_count: 1 } : CANCEL_OK));
    renderApp('/koreksi', setup('PETUGAS', { cancel_options: () => ok(CANCEL), archive_cancel: cancel }).client);
    const user = userEvent.setup();
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Periksa dan Lanjutkan' }));
    const dialog = await screen.findByRole('dialog', { name: 'Konfirmasi akhir pembatalan' });
    await user.dblClick(within(dialog).getByRole('button', { name: 'Ya, batalkan dari arsip aktif' }));
    const box = await screen.findByRole('region', { name: 'Hasil pembatalan' });
    expect(within(box).getByText('1 baris tanda terima kembali ke antrean pemberkasan.')).toBeInTheDocument();
    expect(within(box).getByText('Nomor pembatalan: BTL-1')).toBeInTheDocument();
    const real = cancel.mock.calls.filter((c) => !(c[0] as { p_validate_only: boolean }).p_validate_only);
    expect(real).toHaveLength(1);
    expect(real[0]![0]).toMatchObject({ p_evidence_session_id: null, p_reason: 'Naskah ganda, dibatalkan' });
  });

  it('dengan bukti: validasi → unggah DELETION_EVIDENCE → archive_cancel membawa sesi', async () => {
    const order: string[] = [];
    const cancel = vi.fn<RpcHandler>((a) => { order.push(a.p_validate_only ? 'validate' : 'cancel'); return ok(a.p_validate_only ? { ok: true, valid: true, scope: 'ITEM', berkas_id: 'BRK-1', item_id: 'ITM-1', item_count: 1 } : { ...CANCEL_OK, evidence_file_id: 'DRV-E' }); });
    const start = vi.spyOn(uploads, 'start').mockImplementation(() => { order.push('upload'); return 'JOB'; });
    renderApp('/koreksi', setup('PETUGAS', { cancel_options: () => ok(CANCEL), archive_cancel: cancel }).client);
    const user = userEvent.setup();
    await fill(user);
    await user.upload(screen.getByLabelText('Bukti disposisi (opsional)'), new File([new Uint8Array([0x89, 0x50])], 'bukti.png', { type: 'image/png' }));
    await user.click(screen.getByRole('button', { name: 'Periksa dan Lanjutkan' }));
    await user.click(await screen.findByRole('button', { name: 'Ya, batalkan dari arsip aktif' }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(start.mock.calls[0]![0]).toMatchObject({ purpose: 'DELETION_EVIDENCE', objectId: 'ITM-1', mime: 'image/png', fileName: 'bukti.png' });
    expect(order).toEqual(['validate', 'upload']);
    (start.mock.calls[0]![2] as (r: { sessionId: string; driveFileId: string; result: unknown }) => void)({ sessionId: 'UPS-E', driveFileId: 'DRV-E', result: {} });
    expect(await screen.findByText('Bukti disposisi tersimpan.')).toBeInTheDocument();
    expect(order).toEqual(['validate', 'upload', 'cancel']);
    expect(cancel.mock.calls.at(-1)![0]).toMatchObject({ p_evidence_session_id: 'UPS-E', p_validate_only: false });
  });

  it('seluruh berkas: objek upload = id berkas; gangguan jaringan memakai request id yang sama', async () => {
    let n = 0;
    const cancel = vi.fn<RpcHandler>((a) => {
      if (a.p_validate_only) return ok({ ok: true, valid: true, scope: 'BERKAS', berkas_id: 'BRK-1', item_id: null, item_count: 2 });
      return ++n === 1 ? { data: null, error: { message: 'TypeError: Failed to fetch' } } : ok({ ...CANCEL_OK, scope: 'BERKAS', item_id: null, cancelled_item_count: 2, message: 'Berkas dan 2 item berhasil dihapus dari arsip aktif.' });
    });
    renderApp('/koreksi', setup('PETUGAS', { cancel_options: () => ok(CANCEL), archive_cancel: cancel }).client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Seluruh berkas' }));
    await user.click(await screen.findByRole('button', { name: /Berkas 1 — Renstra 2026/ }));
    expect(screen.getByText(/beserta 2 item \(5 lembar\)/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('Alasan pembatalan *'), 'Berkas dibuat ganda tidak sengaja');
    await user.type(screen.getByLabelText('Konfirmasi *'), 'HAPUS');
    await user.click(screen.getByRole('button', { name: 'Periksa dan Lanjutkan' }));
    await user.click(await screen.findByRole('button', { name: 'Ya, batalkan dari arsip aktif' }));
    expect(await screen.findByText('Berkas dan 2 item berhasil dihapus dari arsip aktif.', {}, { timeout: 3000 })).toBeInTheDocument();
    const real = cancel.mock.calls.filter((c) => !(c[0] as { p_validate_only: boolean }).p_validate_only);
    expect(real).toHaveLength(2);
    expect(rids(cancel as never).slice(-2)[0]).toBe(rids(cancel as never).slice(-1)[0]);
  });
});

describe('Karantina dan peran', () => {
  it('ADMIN_UNIT melihat daftar; isi log ditampilkan sebagai teks, bukan HTML', async () => {
    const { container } = renderApp('/karantina', setup('ADMIN_UNIT', { quarantine_list: () => ok(QUAR) }).client);
    expect(await screen.findByText('<b>lama.pdf</b>')).toBeInTheDocument();
    expect(screen.getByText('Ganti PDF <script>x</script>')).toBeInTheDocument();
    expect(container.querySelector('b, script')).toBeNull();
    expect(screen.getByRole('button', { name: 'Buka file lama' })).toBeEnabled();
    expect(screen.getByText('a@uinsa.ac.id')).toBeInTheDocument();
  });

  it.each<[Role, string]>([['PETUGAS', '/karantina'], ['PIMPINAN', '/karantina'], ['PIMPINAN', '/edit'], ['PIMPINAN', '/koreksi']])('%s ditolak membuka %s', async (role, path) => {
    const rpc = { quarantine_list: vi.fn<RpcHandler>(), edit_options: vi.fn<RpcHandler>(), cancel_options: vi.fn<RpcHandler>() };
    renderApp(path, setup(role, rpc).client);
    expect(await screen.findByText(/Anda tidak memiliki akses ke/)).toBeInTheDocument();
    expect(rpc.quarantine_list).not.toHaveBeenCalled();
    expect(rpc.edit_options).not.toHaveBeenCalled();
    expect(rpc.cancel_options).not.toHaveBeenCalled();
  });

  it('kemampuan menurut peran: Karantina hanya admin; Perubahan/Penghapusan tidak untuk Pimpinan', () => {
    const q = MODULES.find((m) => m.id === 'karantina')!;
    expect(q.group).toBe('Keamanan & Audit');
    expect((['ADMIN_PUSAT', 'ADMIN_UNIT', 'PETUGAS', 'PIMPINAN'] as Role[]).filter((r) => canOpenModule(r, q))).toEqual(['ADMIN_PUSAT', 'ADMIN_UNIT']);
    for (const id of ['edit', 'koreksi']) expect(canOpenModule('PIMPINAN', MODULES.find((m) => m.id === id)!)).toBe(false);
    for (const id of ['edit', 'koreksi']) expect(canOpenModule('PETUGAS', MODULES.find((m) => m.id === id)!)).toBe(true);
  });
});
