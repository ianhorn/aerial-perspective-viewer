// The decoding worker: runs `NodeDecoder` (pc-worker-core.ts) off the page's thread, since decompressing a few million points takes seconds.
import { createLazPerf } from 'laz-perf/lib/web';
import lazPerfWasm from 'laz-perf/lib/web/laz-perf.wasm?url';
import { rangeGetter } from './pc-load.ts';
import { NodeDecoder, type WorkerRequest } from './pc-worker-core.ts';

const decoder = new NodeDecoder((url) => rangeGetter((input, init) => fetch(input, init), url), createLazPerf({ locateFile: () => lazPerfWasm }));

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  void decoder.handle(event.data).then((reply) => {
    if (!reply) return;
    if ('chunk' in reply) (self as unknown as Worker).postMessage(reply, [reply.chunk.positions.buffer]);
    else (self as unknown as Worker).postMessage(reply);
  });
};
