import { describe, expect, it } from 'vitest';
import { ApiError, callWrite, newRequestId } from './api';
import { createFakeClient } from '../test/fakeSupabase';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('lapisan api', () => {
  it('newRequestId menghasilkan UUID v4', () => {
    expect(newRequestId()).toMatch(UUID_RE);
    expect(newRequestId()).not.toBe(newRequestId());
  });

  it('callWrite selalu mengirim requestId', async () => {
    const fake = createFakeClient({ functionResponse: { ok: true, data: { id: 'B-1' } } });
    const res = await callWrite<{ id: string }>(fake.client, 'berkas-create', { uraian: 'x' });
    expect(res.data).toEqual({ id: 'B-1' });
    expect(res.requestId).toMatch(UUID_RE);
    expect(fake.functions.invoke).toHaveBeenCalledWith('berkas-create', { body: { uraian: 'x', requestId: res.requestId } });
  });

  it('callWrite memakai ulang requestId yang diberikan (retry idempoten)', async () => {
    const fake = createFakeClient();
    const id = newRequestId();
    const res = await callWrite(fake.client, 'f', {}, id);
    expect(res.requestId).toBe(id);
  });

  it('error dari server menjadi ApiError', async () => {
    const fake = createFakeClient({ functionResponse: { ok: false, error: { code: 'NOMOR_BENTROK', message: 'Nomor berkas sudah dipakai.' } } });
    await expect(callWrite(fake.client, 'f', {})).rejects.toBeInstanceOf(ApiError);
  });


});
