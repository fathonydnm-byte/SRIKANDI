// Blocking call into a worker thread (Apps Script's UrlFetchApp.fetch is synchronous; the real handler is async).
import { Worker, MessageChannel, receiveMessageOnPort } from 'node:worker_threads';

export async function startBridge(workerFile, workerData) {
  const worker = new Worker(workerFile, { workerData });
  const { port1, port2 } = new MessageChannel();
  const ready = new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
  worker.postMessage({ port: port2 }, [port2]);
  await ready;
  const sab = new SharedArrayBuffer(4);
  const flag = new Int32Array(sab);
  const call = (payload) => {
    Atomics.store(flag, 0, 0);
    port1.postMessage({ payload, sab });
    const r = Atomics.wait(flag, 0, 0, 60000);
    if (r === 'timed-out') throw new Error('bridge: worker did not answer in 60 s');
    const m = receiveMessageOnPort(port1);
    if (!m) throw new Error('bridge: no message after wake-up');
    return m.message;
  };
  return { call, close: () => { port1.close(); return worker.terminate(); } };
}
