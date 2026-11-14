// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { attestationCanonical, CHUNK_SIZE, folderAttestationCanonical, handleUploadCancel, handleUploadChunk, handleUploadComplete, handleUploadSession, magicMatches, taskAttestationCanonical, validSessionUrl } from './uploadHandler';
import { handleDriveTasks } from './driveTasks';
import { clearFolderCache } from './drive';
import { clearGatewayCache } from './gateway';
import type { FetchFn, FileEnv } from './env';

const NOW = 1_800_000_000;
const ENV: FileEnv = {
  SUPABASE_URL: 'https://proj.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
  UPLOAD_ATTEST_SECRET: 'u'.repeat(40),
  DRIVE_GATEWAY_URL: 'https://script.google.com/macros/s/X/exec',
  DRIVE_GATEWAY_SECRET: 'g'.repeat(64),
};
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln';
const RID = '2b8f0c3e-1d2a-4b5c-9d8e-7f6a5b4c3d2e';
const BEGIN = {
  session_id: 'UPS-1', unit_id: 'u-1', unit_code: 'BAU', folder_path: ['2026', 'Berkas 12'], drive_name: '12_3_Surat.pdf', known_folder_id: null, max_bytes: 100 * 1024 * 1024,
};

interface Folder { id: string; name: string; parent: string; createdTime: string }

/** Dunia palsu: gerbang + Drive (folder, resumable, file) + PostgREST. */
function world(over: { begin?: unknown; beginStatus?: number; commitStatus?: number; file?: Record<string, unknown> | null; head?: string | Uint8Array; folders?: Folder[]; raceFolder?: boolean; cancelFile?: string } = {}) {
  const folders: Folder[] = over.folders ? [...over.folders] : [];
  const calls: { url: string; init?: RequestInit; body?: unknown }[] = [];
  let seq = 0;
  const fetchFn = vi.fn<FetchFn>(async (url, init) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, ...(init ? { init } : {}), body });
    const u = new URL(url);
    if (u.hostname === 'script.google.com') return Response.json({ ok: true, accessToken: 'ya29.TOK', expiresInHint: 1800 });
    if (u.pathname.startsWith('/rest/v1/rpc/')) {
      const fn = u.pathname.split('/').pop();
      if (fn === 'upload_begin') return Response.json(over.begin ?? BEGIN, { status: over.beginStatus ?? 200 });
      if (fn === 'drive_task_list') return Response.json({ tasks: [
        { id: 'T1', kind: 'RENAME_FOLDER', drive_id: 'F4', new_name: '13_Berkas baru' },
        { id: 'T2', kind: 'RENAME_FILE', drive_id: 'LEGACY1', new_name: '13_1_x.pdf' },
        { id: 'T3', kind: 'RENAME_FILE', drive_id: 'BUSY1', new_name: '13_2_y.pdf' },
      ] });
      if (fn === 'upload_cancel') return Response.json({ ok: true, drive_file_id: over.cancelFile ?? null });
      if (fn === 'upload_commit') return Response.json(over.commitStatus && over.commitStatus >= 400 ? { code: 'P0001', message: 'UPLOAD_ATTESTATION_EXPIRED: Sesi unggah sudah dipakai.', hint: 'UPLOAD_ATTESTATION_EXPIRED' } : { item_id: 'ITM-1' }, { status: over.commitStatus ?? 200 });
      return Response.json(null);
    }
    if (u.pathname === '/drive/v3/files' && init?.method === 'GET') {
      const q = u.searchParams.get('q')!;
      expect(q).toContain("appProperties has { key='cfV4' and value='1' }");
      const name = /name = '((?:\\'|[^'])*)'/.exec(q)![1]!.replace(/\\'/g, "'");
      const parent = /'([^']+)' in parents/.exec(q)![1]!;
      return Response.json({ files: folders.filter((f) => f.name === name && f.parent === parent).sort((a, b) => a.createdTime.localeCompare(b.createdTime)) });
    }
    if (u.pathname === '/drive/v3/files' && init?.method === 'POST') {
      const id = `F${++seq}`;
      const b = body as { name: string; parents: string[] };
      if (over.raceFolder) folders.push({ id: 'OLDER', name: b.name, parent: b.parents[0]!, createdTime: '2000-01-01' });
      folders.push({ id, name: b.name, parent: b.parents[0]!, createdTime: `2026-01-0${seq}` });
      return Response.json({ id });
    }
    if (u.pathname === '/upload/drive/v3/files') {
      return new Response(null, { status: 200, headers: { Location: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=ABC' } });
    }
    const m = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (m && init?.method === 'PATCH') return m[1] === 'LEGACY1' ? new Response('{"error":{}}', { status: 403 }) : m[1] === 'BUSY1' ? new Response('', { status: 503 }) : Response.json({});
    if (m && (m[1] === 'KNOWN1' || m[1] === 'ROOTAPP')) return Response.json({ id: m[1], mimeType: 'application/vnd.google-apps.folder', trashed: false, appProperties: { cfV4: '1' } });
    if (m && m[1] === 'LEGACYFOLDER') return Response.json({ id: 'LEGACYFOLDER', mimeType: 'application/vnd.google-apps.folder', trashed: false });
    if (m && u.searchParams.get('alt') === 'media') return new Response((over.head ?? '%PDF-1.7\n...') as BodyInit, { status: 206 });
    if (m) return over.file === null ? new Response('', { status: 404 }) : Response.json(over.file ?? {});
    if (init?.method === 'DELETE') return new Response(null, { status: 499 });
    throw new Error(`unexpected ${init?.method} ${url}`);
  });
  return { fetchFn, calls, folders };
}

function post(path: string, body: unknown, auth = true) {
  return new Request(`https://cf.example${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${JWT}` } : {}) },
    body: JSON.stringify(body),
  });
}
const SESSION_BODY = { requestId: RID, purpose: 'ITEM_PDF', objectId: 'ITM-1', fileName: 'Surat.pdf', mime: 'application/pdf', size: 1000 };

beforeEach(() => {
  clearGatewayCache();
  clearFolderCache();
});

describe('POST /api/files/upload-session', () => {
  it('membuat folder aplikasi, memulai sesi resumable dengan Origin aplikasi, tanpa membocorkan token', async () => {
    const w = world();
    const res = await handleUploadSession(post('/api/files/upload-session', SESSION_BODY), ENV, w.fetchFn, NOW);
    const out = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(out).toMatchObject({ ok: true, sessionId: 'UPS-1', uploadUrl: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=ABC', chunkSize: CHUNK_SIZE });
    expect(CHUNK_SIZE % (256 * 1024)).toBe(0);
    expect(JSON.stringify(out)).not.toContain('ya29');
    expect(w.folders.map((f) => `${f.parent}/${f.name}`)).toEqual(['root/CENTRAL FILE V4', 'F1/BAU', 'F2/2026', 'F3/Berkas 12']);
    const begin = w.calls.find((c) => c.url.endsWith('/rpc/upload_begin'))!;
    expect(begin.body).toEqual({ p_request_id: RID, p_purpose: 'ITEM_PDF', p_object_id: 'ITM-1', p_file_name: 'Surat.pdf', p_mime: 'application/pdf', p_size: 1000, p_unit_id: null });
    expect((begin.init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${JWT}`);
    const init = w.calls.find((c) => c.url.includes('/upload/drive/v3/files'))!;
    const h = init.init!.headers as Headers;
    expect(h.get('Origin')).toBe('https://cf.example');
    expect(h.get('X-Upload-Content-Length')).toBe('1000');
    expect(h.get('X-Upload-Content-Type')).toBe('application/pdf');
    expect(init.body).toEqual({ name: '12_3_Surat.pdf', parents: ['F4'], mimeType: 'application/pdf', appProperties: { cfV4: '1', cfSession: 'UPS-1' } });
    // Akar unit (CENTRAL FILE V4/BAU) dan folder tujuan dicatat ke DB, bertanda tangan.
    const regs = w.calls.filter((c) => c.url.endsWith('/rpc/upload_register_folder')).map((c) => c.body as Record<string, unknown>);
    const sig = (id: string, kind: 'ROOT' | 'TARGET') => createHmac('sha256', ENV.UPLOAD_ATTEST_SECRET!).update(folderAttestationCanonical('UPS-1', id, NOW, kind)).digest('hex');
    expect(regs).toEqual([
      { p_session_id: 'UPS-1', p_folder_id: 'F2', p_kind: 'ROOT', p_attested_at: NOW, p_attestation: sig('F2', 'ROOT') },
      { p_session_id: 'UPS-1', p_folder_id: 'F4', p_kind: 'TARGET', p_attested_at: NOW, p_attestation: sig('F4', 'TARGET') },
    ]);
    expect(folderAttestationCanonical('S', 'F', 7)).toBe('CFFD1\nS\nF\n7');
    expect(folderAttestationCanonical('S', 'F', 7, 'ROOT')).toBe('CFFD1\nS\nF\n7\nROOT');
  });

  it('folder dipakai ulang dari cache; known_folder_id melewati pencarian', async () => {
    const w = world();
    await handleUploadSession(post('/api/files/upload-session', SESSION_BODY), ENV, w.fetchFn, NOW);
    const folderCalls = () => w.calls.filter((c) => c.url.includes('/drive/v3/files?') && !c.url.includes('/upload/')).length;
    const before = folderCalls();
    await handleUploadSession(post('/api/files/upload-session', SESSION_BODY), ENV, w.fetchFn, NOW);
    expect(folderCalls()).toBe(before);
    const k = world({ begin: { ...BEGIN, known_folder_id: 'KNOWN1' } });
    clearFolderCache();
    await handleUploadSession(post('/api/files/upload-session', SESSION_BODY), ENV, k.fetchFn, NOW);
    expect(k.calls.some((c) => c.url.includes('/drive/v3/files?') && !c.url.includes('/upload/'))).toBe(false);
    expect((k.calls.find((c) => c.url.includes('/upload/drive/v3/files'))!.body as { parents: string[] }).parents).toEqual(['KNOWN1']);
    expect(k.calls.some((c) => c.url.endsWith('/rpc/upload_register_folder'))).toBe(false);
    // Folder berkas lama dari 3.x (bukan buatan aplikasi) tidak bisa ditulis: buat pohon V4.
    const l = world({ begin: { ...BEGIN, known_folder_id: 'LEGACYFOLDER' } });
    clearFolderCache();
    await handleUploadSession(post('/api/files/upload-session', SESSION_BODY), ENV, l.fetchFn, NOW);
    expect((l.calls.find((c) => c.url.includes('/upload/drive/v3/files'))!.body as { parents: string[] }).parents).toEqual(['F4']);
  });

  it('root_folder_id v4 dari DB: start dingin tanpa mencari akar; akar asing diabaikan', async () => {
    const r = world({ begin: { ...BEGIN, root_folder_id: 'ROOTAPP' } });
    await handleUploadSession(post('/api/files/upload-session', SESSION_BODY), ENV, r.fetchFn, NOW);
    expect(r.folders.map((f) => `${f.parent}/${f.name}`)).toEqual(['ROOTAPP/2026', 'F1/Berkas 12']);
    const regs = r.calls.filter((c) => c.url.endsWith('/rpc/upload_register_folder')).map((c) => (c.body as { p_kind: string; p_folder_id: string }));
    expect(regs.map((x) => `${x.p_kind}:${x.p_folder_id}`)).toEqual(['TARGET:F2']);
    // Folder yang sudah terverifikasi tidak dicek ulang di isolate yang sama.
    const before = r.calls.filter((c) => c.url.includes('/drive/v3/files/ROOTAPP')).length;
    await handleUploadSession(post('/api/files/upload-session', SESSION_BODY), ENV, r.fetchFn, NOW);
    expect(r.calls.filter((c) => c.url.includes('/drive/v3/files/ROOTAPP')).length).toBe(before);
    // Akar tercatat tapi bukan milik aplikasi → bangun akar v4 dan catat sebagai ROOT.
    clearFolderCache();
    const bad = world({ begin: { ...BEGIN, root_folder_id: 'LEGACYFOLDER' } });
    await handleUploadSession(post('/api/files/upload-session', SESSION_BODY), ENV, bad.fetchFn, NOW);
    expect(bad.folders[0]).toMatchObject({ parent: 'root', name: 'CENTRAL FILE V4' });
    expect(bad.calls.filter((c) => c.url.endsWith('/rpc/upload_register_folder')).map((c) => (c.body as { p_kind: string }).p_kind)).toEqual(['ROOT', 'TARGET']);
  });

  it('folder kembar karena balapan: pakai yang tertua, buang yang baru', async () => {
    const w = world({ raceFolder: true });
    await handleUploadSession(post('/api/files/upload-session', SESSION_BODY), ENV, w.fetchFn, NOW);
    expect(w.calls.filter((c) => c.init?.method === 'PATCH').length).toBeGreaterThan(0);
    const init = w.calls.find((c) => c.url.includes('/upload/drive/v3/files'))!;
    expect((init.body as { parents: string[] }).parents).toEqual(['OLDER']);
  });

  it('batas ukuran dari server; sesi dibatalkan', async () => {
    const w = world({ begin: { ...BEGIN, max_bytes: 500 } });
    const res = await handleUploadSession(post('/api/files/upload-session', SESSION_BODY), ENV, w.fetchFn, NOW);
    expect(res.status).toBe(413);
    expect(w.calls.some((c) => c.url.endsWith('/rpc/upload_cancel'))).toBe(true);
    expect(w.calls.some((c) => c.url.includes('googleapis'))).toBe(false);
  });

  it('error sistem Postgres/PostgREST tidak pernah diteruskan teksnya', async () => {
    const w = world({ begin: { code: 'PGRST202', message: 'Could not find the function public.upload_begin(p_x) in the schema cache' }, beginStatus: 404 });
    const res = await handleUploadSession(post('/x', SESSION_BODY), ENV, w.fetchFn, NOW);
    const body = (await res.json()) as { message: string };
    expect(res.status).toBe(502);
    expect(body.message).not.toMatch(/function|schema|upload_begin/);
    const w2 = world({ begin: { code: '42883', message: 'function public.upload_begin(unknown) does not exist' }, beginStatus: 400 });
    expect(((await (await handleUploadSession(post('/x', SESSION_BODY), ENV, w2.fetchFn, NOW)).json()) as { message: string }).message).not.toMatch(/function/);
  });

  it('error RPC: pesan server diteruskan; tanpa sesi/konfigurasi/input buruk ditolak', async () => {
    const w = world({ begin: { code: 'P0001', message: 'ITEM_HAS_FILE: Item ini sudah memiliki PDF.', hint: 'ITEM_HAS_FILE' }, beginStatus: 400 });
    const res = await handleUploadSession(post('/api/files/upload-session', SESSION_BODY), ENV, w.fetchFn, NOW);
    expect(res.status).toBe(409);
    expect(res.headers.get('X-Api-Code')).toBe('ITEM_HAS_FILE');
    expect(await res.json()).toMatchObject({ code: 'CONFLICT', message: 'Item ini sudah memiliki PDF.' });
    const f = world({ begin: { code: 'P0001', message: 'FORBIDDEN_ROLE: Peran Anda tidak boleh mengunggah.', hint: 'FORBIDDEN_ROLE' }, beginStatus: 400 });
    expect((await handleUploadSession(post('/x', SESSION_BODY), ENV, f.fetchFn, NOW)).status).toBe(403);
    const never = vi.fn<FetchFn>();
    expect((await handleUploadSession(post('/x', SESSION_BODY, false), ENV, never, NOW)).status).toBe(401);
    expect((await handleUploadSession(post('/x', { ...SESSION_BODY, requestId: 'nope' }), ENV, never, NOW)).status).toBe(400);
    expect((await handleUploadSession(post('/x', { ...SESSION_BODY, size: -1 }), ENV, never, NOW)).status).toBe(400);
    expect((await handleUploadSession(post('/x', SESSION_BODY), { ...ENV, UPLOAD_ATTEST_SECRET: 'short' }, never, NOW)).status).toBe(503);
    const noGw = await handleUploadSession(post('/x', SESSION_BODY), { ...ENV, DRIVE_GATEWAY_URL: '' }, never, NOW);
    expect(await noGw.json()).toMatchObject({ code: 'GATEWAY_NOT_CONFIGURED' });
    expect(never).not.toHaveBeenCalled();
  });

  it('URL sesi hanya dari host upload Google', () => {
    expect(validSessionUrl('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=A', ENV)).not.toBeNull();
    expect(validSessionUrl('https://evil.example/upload/drive/v3/files?upload_id=A', ENV)).toBeNull();
    expect(validSessionUrl('https://www.googleapis.com/drive/v3/files?upload_id=A', ENV)).toBeNull();
    expect(validSessionUrl('http://127.0.0.1:9/upload/drive/v3/files?upload_id=A', ENV)).toBeNull();
    expect(validSessionUrl('http://127.0.0.1:9/upload/drive/v3/files?upload_id=A', { ...ENV, DRIVE_API_BASE: 'http://127.0.0.1:9' })).not.toBeNull();
  });
});

async function sessionContext(): Promise<string> {
  const w = world();
  const res = await handleUploadSession(post('/api/files/upload-session', SESSION_BODY), ENV, w.fetchFn, NOW);
  return ((await res.json()) as { context: string }).context;
}

const GOOD_FILE = { id: 'DRV1', size: '1000', md5Checksum: 'd41d8cd98f00b204e9800998ecf8427e', mimeType: 'application/pdf', parents: ['F4'], trashed: false, appProperties: { cfV4: '1', cfSession: 'UPS-1' }, webViewLink: 'https://drive.google.com/file/d/DRV1/view' };

describe('tujuan unggah S3 (ITEM_PDF_REPLACE, DELETION_EVIDENCE)', () => {
  it('tujuan baru diteruskan apa adanya ke upload_begin; bukti gambar PNG lolos sesi', async () => {
    const w = world({ begin: { ...BEGIN, drive_name: '20261114-101500_ITEM_1-2_x.png', folder_path: ['BUKTI PENGHAPUSAN'], max_bytes: 26214400 } });
    const res = await handleUploadSession(post('/x', { ...SESSION_BODY, purpose: 'DELETION_EVIDENCE', objectId: 'ITM-1', fileName: 'bukti.png', mime: 'image/png', size: 5000 }), ENV, w.fetchFn, NOW);
    expect(res.status).toBe(200);
    expect(w.calls.find((c) => c.url.endsWith('/rpc/upload_begin'))!.body).toMatchObject({ p_purpose: 'DELETION_EVIDENCE', p_mime: 'image/png' });
    const r2 = world({ begin: { ...BEGIN, max_bytes: 104857599 } });
    expect((await handleUploadSession(post('/x', { ...SESSION_BODY, purpose: 'ITEM_PDF_REPLACE', size: 90 * 1024 * 1024 }), ENV, r2.fetchFn, NOW)).status).toBe(200);
  });

  it('bukti PNG/JPEG: tanda tangan byte diperiksa; isi HTML berlabel PNG ditolak dan dibuang', async () => {
    const session = async () => ((await (await handleUploadSession(post('/x', { ...SESSION_BODY, purpose: 'DELETION_EVIDENCE', fileName: 'b.png', mime: 'image/png', size: 1000 }), ENV, world().fetchFn, NOW)).json()) as { context: string }).context;
    const file = { ...GOOD_FILE, mimeType: 'image/png' };
    const bad = world({ file, head: '<html>' });
    expect((await handleUploadComplete(post('/x', { sessionId: 'UPS-1', driveFileId: 'DRV1', context: await session() }), ENV, bad.fetchFn, NOW)).status).toBe(422);
    expect(bad.calls.some((c) => c.url.endsWith('/rpc/upload_cancel'))).toBe(true);
    const good = world({ file, head: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]) });
    const ok = await handleUploadComplete(post('/x', { sessionId: 'UPS-1', driveFileId: 'DRV1', context: await session() }), ENV, good.fetchFn, NOW);
    expect(ok.status).toBe(200);
    expect((good.calls.find((c) => c.url.endsWith('/rpc/upload_commit'))!.body as { p_mime: string }).p_mime).toBe('image/png');
  });

  it('LAST_ITEM_IN_BERKAS dari upload_begin → 409 dengan pesan server', async () => {
    const w = world({ begin: { code: 'P0001', message: 'LAST_ITEM_IN_BERKAS: Item terakhir tidak bisa dibatalkan sendiri.', hint: 'LAST_ITEM_IN_BERKAS' }, beginStatus: 400 });
    const res = await handleUploadSession(post('/x', { ...SESSION_BODY, purpose: 'DELETION_EVIDENCE' }), ENV, w.fetchFn, NOW);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ message: 'Item terakhir tidak bisa dibatalkan sendiri.' });
  });
});

describe('POST /api/files/upload-complete', () => {
  it('verifikasi di Drive → atestasi HMAC → upload_commit sebagai pengguna', async () => {
    const context = await sessionContext();
    const w = world({ file: GOOD_FILE });
    const res = await handleUploadComplete(post('/api/files/upload-complete', { sessionId: 'UPS-1', driveFileId: 'DRV1', context }), ENV, w.fetchFn, NOW);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, result: { item_id: 'ITM-1' } });
    const commit = w.calls.find((c) => c.url.endsWith('/rpc/upload_commit'))!.body as Record<string, unknown>;
    const at = NOW;
    const expected = createHmac('sha256', ENV.UPLOAD_ATTEST_SECRET!).update(attestationCanonical('UPS-1', 'DRV1', 1000, GOOD_FILE.md5Checksum, 'application/pdf', at)).digest('hex');
    expect(commit).toEqual({
      p_session_id: 'UPS-1', p_drive_file_id: 'DRV1', p_drive_url: 'https://drive.google.com/file/d/DRV1/view', p_size: 1000,
      p_md5: GOOD_FILE.md5Checksum, p_mime: 'application/pdf', p_attested_at: at, p_attestation: expected,
    });
    expect(attestationCanonical('S', 'D', 1, 'm', 'application/pdf', 1700000000)).toBe('CFUP1\nS\nD\n1\nm\napplication/pdf\n1700000000');
    const range = w.calls.find((c) => c.url.includes('alt=media'))!;
    expect(new Headers(range.init!.headers).get('Range')).toBe('bytes=0-1023');
  });

  it('file bukan milik sesi / beda folder / beda ukuran → ditolak; yang salah dibuang', async () => {
    const context = await sessionContext();
    for (const [file, trashed] of [
      [{ ...GOOD_FILE, appProperties: { cfSession: 'OTHER' } }, false],
      [{ ...GOOD_FILE, parents: ['ELSEWHERE'] }, true],
      [{ ...GOOD_FILE, size: '999' }, true],
      [{ ...GOOD_FILE, mimeType: 'text/html' }, true],
      [{ ...GOOD_FILE, trashed: true }, false],
      [null, false],
    ] as const) {
      const w = world({ file });
      const res = await handleUploadComplete(post('/x', { sessionId: 'UPS-1', driveFileId: 'DRV1', context }), ENV, w.fetchFn, NOW);
      expect(res.status, JSON.stringify(file)).toBe(409);
      expect(w.calls.some((c) => c.init?.method === 'PATCH')).toBe(trashed);
      expect(w.calls.some((c) => c.url.endsWith('/rpc/upload_commit'))).toBe(false);
    }
  });

  it('isi bukan PDF → 422, file dibuang, sesi dibatalkan', async () => {
    const context = await sessionContext();
    const w = world({ file: GOOD_FILE, head: '<html><script>' });
    const res = await handleUploadComplete(post('/x', { sessionId: 'UPS-1', driveFileId: 'DRV1', context }), ENV, w.fetchFn, NOW);
    expect(res.status).toBe(422);
    expect(w.calls.some((c) => c.init?.method === 'PATCH')).toBe(true);
    expect(w.calls.some((c) => c.url.endsWith('/rpc/upload_cancel'))).toBe(true);
  });

  it('konteks dipalsukan / sesi lain / kedaluwarsa → 400', async () => {
    const context = await sessionContext();
    const w = world({ file: GOOD_FILE });
    for (const body of [
      { sessionId: 'UPS-1', driveFileId: 'DRV1', context: context.slice(0, -2) + 'AA' },
      { sessionId: 'UPS-2', driveFileId: 'DRV1', context },
      { sessionId: 'UPS-1', driveFileId: '../x', context },
    ]) {
      expect((await handleUploadComplete(post('/x', body), ENV, w.fetchFn, NOW)).status).toBe(400);
    }
    expect((await handleUploadComplete(post('/x', { sessionId: 'UPS-1', driveFileId: 'DRV1', context }), ENV, w.fetchFn, NOW + 8 * 24 * 3600)).status).toBe(400);
  });

  it('penolakan upload_commit diteruskan', async () => {
    const context = await sessionContext();
    const w = world({ file: GOOD_FILE, commitStatus: 400 });
    const res = await handleUploadComplete(post('/x', { sessionId: 'UPS-1', driveFileId: 'DRV1', context }), ENV, w.fetchFn, NOW);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ message: 'Sesi unggah sudah dipakai.' });
  });
});

describe('POST /api/files/upload-cancel', () => {
  it('upload_cancel + DELETE sesi Google (hanya URL sah)', async () => {
    const w = world();
    const res = await handleUploadCancel(post('/x', { sessionId: 'UPS-1', uploadUrl: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=ABC' }), ENV, w.fetchFn);
    expect(res.status).toBe(200);
    expect(w.calls.find((c) => c.url.endsWith('/rpc/upload_cancel'))!.body).toEqual({ p_session_id: 'UPS-1' });
    expect(w.calls.some((c) => c.init?.method === 'DELETE' && c.url.startsWith('https://www.googleapis.com/upload/'))).toBe(true);
    const w2 = world();
    await handleUploadCancel(post('/x', { sessionId: 'UPS-1', uploadUrl: 'https://evil.example/x?upload_id=1' }), ENV, w2.fetchFn);
    expect(w2.calls.some((c) => c.init?.method === 'DELETE')).toBe(false);
  });
});

describe('POST /api/files/drive-tasks', () => {
  it('ganti nama milik aplikasi; file lama 3.x tercatat gagal; hasil bertanda tangan', async () => {
    const w = world();
    const res = await handleDriveTasks(post('/x', {}), ENV, w.fetchFn, NOW);
    expect(await res.json()).toEqual({ ok: true, done: 1, failed: 2, remaining: 0 });
    const completes = w.calls.filter((c) => c.url.endsWith('/rpc/drive_task_complete')).map((c) => c.body as Record<string, unknown>);
    const sig = (id: string, ok: boolean) => createHmac('sha256', ENV.UPLOAD_ATTEST_SECRET!).update(taskAttestationCanonical(id, ok, NOW)).digest('hex');
    expect(completes).toEqual([
      { p_task_id: 'T1', p_ok: true, p_error: null, p_permanent: false, p_attested_at: NOW, p_attestation: sig('T1', true) },
      { p_task_id: 'T2', p_ok: false, p_error: 'NOT_APP_FILE', p_permanent: true, p_attested_at: NOW, p_attestation: sig('T2', false) },
      // Galat sementara: dicoba lagi nanti (tidak permanen).
      { p_task_id: 'T3', p_ok: false, p_error: 'HTTP_503', p_permanent: false, p_attested_at: NOW, p_attestation: sig('T3', false) },
    ]);
    expect(taskAttestationCanonical('T', false, 5)).toBe('CFDT1\nT\nfail\n5');
  });

  it('upload-cancel membuang file bukti yang tidak terpakai', async () => {
    const w = world({ cancelFile: 'ORPHAN1' });
    await handleUploadCancel(post('/x', { sessionId: 'UPS-1' }), ENV, w.fetchFn);
    expect(w.calls.some((c) => c.init?.method === 'PATCH' && c.url.includes('/ORPHAN1'))).toBe(true);
  });
});

describe('PUT /api/files/upload-chunk (cadangan CORS)', () => {
  const SESSION_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=ABC';
  function chunkReq(ctx: string, range: string, body: Uint8Array | null, opts: { sid?: string; length?: string | null; auth?: boolean } = {}) {
    const headers: Record<string, string> = { 'X-Upload-Context': ctx, 'Content-Range': range };
    if (opts.auth !== false) headers.Authorization = `Bearer ${JWT}`;
    const len = opts.length === undefined ? String(body?.byteLength ?? 0) : opts.length;
    if (len !== null) headers['Content-Length'] = len;
    return new Request(`https://cf.example/api/files/upload-chunk?sid=${opts.sid ?? 'UPS-1'}`, {
      method: 'PUT', headers, ...(body ? { body, duplex: 'half' } : {}),
    } as RequestInit);
  }
  function google(reply: (init: RequestInit) => Response) {
    const seen: { url: string; init: RequestInit; bytes: number }[] = [];
    const fetchFn = vi.fn<FetchFn>(async (url, init) => {
      const bytes = init?.body ? (await new Response(init.body as BodyInit).arrayBuffer()).byteLength : 0;
      seen.push({ url, init: init!, bytes });
      return reply(init!);
    });
    return { fetchFn, seen };
  }

  it('mengalirkan potongan ke URL sesi dari konteks; 308 → JSON {range}; 200 → {id}', async () => {
    const context = await sessionContext();
    const g = google(() => new Response(null, { status: 308, headers: { Range: 'bytes=0-499' } }));
    const res = await handleUploadChunk(chunkReq(context, 'bytes 0-499/1000', new Uint8Array(500)), ENV, g.fetchFn, NOW);
    expect(await res.json()).toEqual({ ok: true, upstreamStatus: 308, range: 'bytes=0-499', id: null });
    expect(g.seen[0]!.url).toBe(SESSION_URL);
    expect(g.seen[0]!.bytes).toBe(500);
    expect(new Headers(g.seen[0]!.init.headers).get('Content-Range')).toBe('bytes 0-499/1000');
    expect(new Headers(g.seen[0]!.init.headers).get('Authorization')).toBeNull(); // tanpa token Google/pengguna
    const done = google(() => Response.json({ id: 'DRV1' }));
    const fin = await handleUploadChunk(chunkReq(context, 'bytes 500-999/1000', new Uint8Array(500)), ENV, done.fetchFn, NOW);
    expect(await fin.json()).toEqual({ ok: true, upstreamStatus: 200, range: null, id: 'DRV1' });
    // Tanya posisi (tanpa badan) dan status lain diteruskan apa adanya.
    const gone = google(() => new Response('', { status: 404 }));
    expect(await (await handleUploadChunk(chunkReq(context, 'bytes */1000', null), ENV, gone.fetchFn, NOW)).json()).toEqual({ ok: true, upstreamStatus: 404, range: null, id: null });
  });

  it('menolak konteks palsu/sesi lain, rentang tak cocok, tanpa Content-Length, dan potongan terlalu besar', async () => {
    const context = await sessionContext();
    const never = vi.fn<FetchFn>();
    const cases: [Request, number][] = [
      [chunkReq(context.slice(0, -2) + 'AA', 'bytes 0-9/1000', new Uint8Array(10)), 400],
      [chunkReq(context, 'bytes 0-9/1000', new Uint8Array(10), { sid: 'UPS-2' }), 400],
      [chunkReq(context, 'bytes 0-9/999', new Uint8Array(10)), 400],
      [chunkReq(context, 'bytes 0-1000/1000', new Uint8Array(10)), 400],
      [chunkReq(context, 'bytes 0-9/1000', new Uint8Array(10), { length: '9' }), 400],
      [chunkReq(context, 'bytes 0-9/1000', new Uint8Array(10), { length: null }), 400],
      [chunkReq(context, 'bytes 0-9/1000', new Uint8Array(10), { auth: false }), 401],
      [chunkReq(context, 'garbage', null), 400],
    ];
    for (const [req, status] of cases) expect((await handleUploadChunk(req, ENV, never, NOW)).status).toBe(status);
    // Sesi besar: satu potongan melebihi CHUNK_SIZE ditolak sebelum dibaca.
    const big = world({ begin: { ...BEGIN, max_bytes: 200 * 1024 * 1024 } });
    const bigCtx = ((await (await handleUploadSession(post('/x', { ...SESSION_BODY, size: 50 * 1024 * 1024 }), ENV, big.fetchFn, NOW)).json()) as { context: string }).context;
    const over = CHUNK_SIZE + 1;
    expect((await handleUploadChunk(chunkReq(bigCtx, `bytes 0-${over - 1}/${50 * 1024 * 1024}`, new Uint8Array(1), { length: String(over) }), ENV, never, NOW)).status).toBe(413);
    expect(never).not.toHaveBeenCalled();
  });

  it('Google tak terjangkau → 502', async () => {
    const context = await sessionContext();
    const down = vi.fn<FetchFn>(async () => { throw new TypeError('fetch failed'); });
    expect((await handleUploadChunk(chunkReq(context, 'bytes */1000', null), ENV, down, NOW)).status).toBe(502);
  });
});

describe('tanda tangan byte awal', () => {
  it('PDF/JPEG/PNG', () => {
    const b = (s: string) => new TextEncoder().encode(s);
    expect(magicMatches('application/pdf', b('%PDF-1.4'))).toBe(true);
    expect(magicMatches('application/pdf', b('\n\n%PDF-1.4'))).toBe(true);
    expect(magicMatches('application/pdf', b('<html>'))).toBe(false);
    expect(magicMatches('image/jpeg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(magicMatches('image/png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(true);
    expect(magicMatches('image/png', b('GIF89a'))).toBe(false);
  });
});
