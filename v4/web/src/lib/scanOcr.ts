import { createWorker, OEM, PSM, type Worker } from 'tesseract.js';
import { uprightScanPhoto, type ScanPage } from './scan';

export type OcrProgress = { page: number; total: number; percent: number } | null;
const ASSETS = '/ocr/v1';
const INIT_LIMIT = 60_000;
const PAGE_LIMIT = 45_000;
const TOTAL_LIMIT = 180_000;

async function within<T>(signal: AbortSignal, ms: number, work: (deadline: AbortSignal) => Promise<T>): Promise<T> {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(ms)]);
  deadline.throwIfAborted();
  let cancel!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    cancel = () => reject(deadline.reason);
    deadline.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await Promise.race([stopped, work(deadline)]);
  } finally {
    deadline.removeEventListener('abort', cancel);
  }
}

/** Text-only Tesseract PDF pages, in the same orientation and order as the visible photos. */
export async function recognizeScan(
  pages: readonly ScanPage[], signal: AbortSignal, onProgress: (p: OcrProgress) => void,
): Promise<(Uint8Array | null)[]> {
  let worker: Worker | undefined;
  let page = 0;
  let percent = 0;
  const session = AbortSignal.any([signal, AbortSignal.timeout(TOTAL_LIMIT)]);
  const layers: (Uint8Array | null)[] = [];
  try {
    onProgress(null);
    worker = await within(session, INIT_LIMIT, async (deadline) => {
      let reportFailure!: (reason: unknown) => void;
      const error = new Promise<never>((_, reject) => { reportFailure = reject; });
      let abandoned = false;
      const relative = new URL(ASSETS + '/', window.location.origin);
      const pending = createWorker(['ind', 'eng'], OEM.LSTM_ONLY, {
        workerPath: new URL('worker.min.js', relative).href,
        corePath: relative.href,
        langPath: relative.href.slice(0, -1),
        workerBlobURL: false,
        cacheMethod: 'none', // The versioned assets already use the browser HTTP cache.
        errorHandler: reportFailure,
        logger: (update) => {
          if (session.aborted || !page || update.status !== 'recognizing text' || !Number.isFinite(update.progress)) return;
          const next = Math.min(99, Math.max(0, Math.floor(update.progress * 100)));
          if (next <= percent) return;
          percent = next;
          onProgress({ page, total: pages.length, percent });
        },
      }).then(async (started) => {
        if (deadline.aborted || abandoned) {
          await started.terminate();
          deadline.throwIfAborted();
          throw new Error('OCR tidak dapat dimulai.');
        }
        return started;
      });
      try {
        return await Promise.race([error, pending]);
      } catch (err) {
        abandoned = true;
        throw err;
      }
    });
    const active = worker;
    await within(session, PAGE_LIMIT, () => active.setParameters({ tessedit_pageseg_mode: PSM.AUTO, user_defined_dpi: '300' }));

    for (const [index, input] of pages.entries()) {
      page = index + 1;
      percent = 0;
      onProgress({ page, total: pages.length, percent });
      const layer = await within(session, PAGE_LIMIT, async (deadline) => {
        const jpeg = await uprightScanPhoto(input);
        deadline.throwIfAborted();
        const { data } = await active.recognize(jpeg, { pdfTextOnly: true }, { text: true, pdf: true });
        if (!data.text?.trim()) return null;
        if (!data.pdf?.length) throw new Error('Lapisan teks OCR tidak dapat dibuat.');
        return Uint8Array.from(data.pdf);
      });
      layers.push(layer);
      onProgress({ page, total: pages.length, percent: 100 });
    }
    return layers;
  } finally {
    if (worker) await worker.terminate();
  }
}
