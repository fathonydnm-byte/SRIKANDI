import { describe, expect, it, vi } from 'vitest';
import { ApiError, callRead, callWrite, newRequestId } from './api';
import { createFakeClient, type RpcHandler } from '../test/fakeSupabase';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const noSleep = async () => {};

describe('lapisan api (RPC Postgres)', () => {
  it('newRequestId menghasilkan UUID v4', () => {
    expect(newRequestId()).toMatch(UUID_RE);
    expect(newRequestId()).not.toBe(newRequestId());
  });

  it('callWrite selalu mengirim p_request_id', async () => {
    const h = vi.fn<RpcHandler>(() => ({ data: { id: 'B-1' }, error: null }));
    const fake = createFakeClient({ rpc: { berkas_create: h } });
    const res = await callWrite<{ id: string }>(fake.client, 'berkas_create', { p_judul: 'x' });
    expect(res.data).toEqual({ id: 'B-1' });
    expect(res.requestId).toMatch(UUID_RE);
    expect(h).toHaveBeenCalledWith({ p_judul: 'x', p_request_id: res.requestId }, undefined);
  });

  it('gangguan jaringan diulang otomatis dengan request id yang SAMA', async () => {
    let n = 0;
    const h = vi.fn<RpcHandler>(() => (++n < 3 ? { data: null, error: { message: 'TypeError: Failed to fetch' } } : { data: 1, error: null }));
    const fake = createFakeClient({ rpc: { f: h } });
    const id = newRequestId();
    const res = await callWrite(fake.client, 'f', {}, id, { sleep: noSleep });
    expect(res.requestId).toBe(id);
    expect(h.mock.calls.map((c) => c[0].p_request_id)).toEqual([id, id, id]);
  });

  it('error bisnis (P0001, hint = kode) membawa pesan server tanpa awalan kode; tidak diulang', async () => {
    const h = vi.fn<RpcHandler>(() => ({ data: null, error: { code: 'P0001', message: 'RECEIPT_LOCKED: Nomor berkas sudah dipakai.', hint: 'RECEIPT_LOCKED' } as never }));
    const fake = createFakeClient({ rpc: { f: h } });
    const err = await callWrite(fake.client, 'f', {}, undefined, { sleep: noSleep }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).userMessage.title).toBe('Nomor berkas sudah dipakai.');
    expect((err as ApiError).code).toBe('RECEIPT_LOCKED');
    expect((err as ApiError).userMessage.action).toBe('Untuk koreksi, batalkan tanda terima lalu buat yang baru.');
    expect(h).toHaveBeenCalledTimes(1);
  });

  it('error izin (42501) memakai pesan umum', async () => {
    const fake = createFakeClient({ rpc: { f: () => ({ data: null, error: { code: '42501', message: 'permission denied for function f', status: 403 } }) } });
    const err = (await callWrite(fake.client, 'f', {}).catch((e: unknown) => e)) as ApiError;
    expect(err.userMessage.title).toBe('Anda tidak memiliki izin untuk tindakan ini.');
  });

  it('callRead meneruskan argumen tanpa request id', async () => {
    const h = vi.fn<RpcHandler>(() => ({ data: [1], error: null }));
    const fake = createFakeClient({ rpc: { daftar: h } });
    expect(await callRead(fake.client, 'daftar', { p_x: 1 })).toEqual([1]);
    expect(h).toHaveBeenCalledWith({ p_x: 1 }, undefined);
  });
});
