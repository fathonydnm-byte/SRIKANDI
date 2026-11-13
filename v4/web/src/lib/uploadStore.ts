/*
 * Antrean unggahan global: unggahan tetap berjalan saat petugas pindah ke
 * input berikutnya atau halaman lain (prioritas kecepatan). Ditampilkan oleh
 * <UploadTray/> di AppShell.
 */
import { useSyncExternalStore } from 'react';
import { newRequestId } from './api';
import type { UserMessage } from './errors';
import { FileAccessError, type GetAccessToken } from './files';
import { startUpload, type UploadHandle, type UploadProgress, type UploadRequest, type UploadResult } from './uploader';

export interface UploadJob {
  id: string;
  label: string;
  request: UploadRequest;
  progress: UploadProgress;
  error: UserMessage | null;
  result: UploadResult | null;
  paused: boolean;
}

type Listener = () => void;
let jobs: UploadJob[] = [];
const handles = new Map<string, UploadHandle>();
const callbacks = new Map<string, (r: UploadResult) => void>();
const listeners = new Set<Listener>();
let getTokenRef: GetAccessToken = async () => null;

function set(next: UploadJob[]) {
  jobs = next;
  listeners.forEach((l) => l());
}
function patch(id: string, p: Partial<UploadJob>) {
  set(jobs.map((j) => (j.id === id ? { ...j, ...p } : j)));
}

function run(job: UploadJob) {
  const handle = startUpload(job.request, {
    getToken: getTokenRef,
    onProgress: (progress) => patch(job.id, { progress, paused: progress.stage === 'jeda' }),
  });
  handles.set(job.id, handle);
  handle.promise.then(
    (result) => {
      patch(job.id, { result, error: null });
      callbacks.get(job.id)?.(result);
    },
    (error: unknown) => {
      patch(job.id, { error: error instanceof FileAccessError ? error.userMessage : { title: 'Unggahan gagal.', action: 'Coba lagi.' } });
    },
  );
}

export const uploads = {
  configure(getToken: GetAccessToken) {
    getTokenRef = getToken;
  },
  /** Mulai unggahan. requestId tetap per job, sehingga "Coba lagi" tidak membuat sesi ganda. */
  start(request: Omit<UploadRequest, 'requestId'>, label: string, onDone?: (r: UploadResult) => void): string {
    const id = newRequestId();
    const job: UploadJob = {
      id, label, request: { ...request, requestId: id }, error: null, result: null, paused: false,
      progress: { stage: 'menyiapkan', sent: 0, total: request.file.size },
    };
    if (onDone) callbacks.set(id, onDone);
    set([...jobs, job]);
    run(job);
    return id;
  },
  retry(id: string) {
    const job = jobs.find((j) => j.id === id);
    if (!job) return;
    const next = { ...job, error: null, progress: { stage: 'menyiapkan' as const, sent: 0, total: job.request.file.size } };
    set(jobs.map((j) => (j.id === id ? next : j)));
    run(next);
  },
  pause: (id: string) => handles.get(id)?.pause(),
  resume: (id: string) => handles.get(id)?.resume(),
  abort: (id: string) => handles.get(id)?.abort(),
  dismiss(id: string) {
    handles.delete(id);
    callbacks.delete(id);
    set(jobs.filter((j) => j.id !== id));
  },
  forObject(objectId: string): UploadJob | undefined {
    return [...jobs].reverse().find((j) => j.request.objectId === objectId);
  },
  subscribe(l: Listener) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  snapshot: () => jobs,
  /** Hanya untuk tes. */
  reset() {
    handles.forEach((h) => h.abort());
    handles.clear();
    callbacks.clear();
    set([]);
  },
};

export function useUploads(): UploadJob[] {
  return useSyncExternalStore(uploads.subscribe, uploads.snapshot, uploads.snapshot);
}

export const STAGE_LABELS: Record<UploadProgress['stage'], string> = {
  menyiapkan: 'Menyiapkan…',
  mengunggah: 'Mengunggah',
  jeda: 'Dijeda',
  menyambung: 'Menyambung ulang…',
  memverifikasi: 'Memverifikasi file…',
  selesai: 'Selesai',
  gagal: 'Gagal',
  dibatalkan: 'Dibatalkan',
};

export function percent(p: UploadProgress): number {
  return p.total ? Math.floor((p.sent / p.total) * 100) : 0;
}
