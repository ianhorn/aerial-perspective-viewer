// The point-cloud pieces that need a browser: real Web Workers for the pool.
import type { WorkerLike } from './pc-pool.ts';
import { WorkerPool } from './pc-pool.ts';
import type { WorkerReply, WorkerRequest } from './pc-worker-core.ts';

function spawn(): WorkerLike {
  const worker = new Worker(new URL('./pc-worker.ts', import.meta.url), { type: 'module' });
  return {
    post: (message: WorkerRequest) => worker.postMessage(message),
    onReply: (callback) => { worker.onmessage = (event: MessageEvent<WorkerReply>) => callback(event.data); },
    close: () => worker.terminate(),
  };
}

/** A pool of decoding workers: as many as the machine has cores, at least two and at most four. */
export const makeBrowserPool = (): WorkerPool => new WorkerPool(spawn, Math.min(4, Math.max(2, (navigator.hardwareConcurrency ?? 4) - 1)));
