// A few decoding workers sharing the nodes of a load. The workers are behind a small interface, so the same code runs with real Web
// Workers in the page and with in-process ones in a test. No DOM here.

import type { Chunk } from './pc-decode.ts';
import type { BeginMessage, NodeMessage, WorkerReply, WorkerRequest } from './pc-worker-core.ts';

export interface WorkerLike {
  post(message: WorkerRequest): void;
  onReply(callback: (reply: WorkerReply) => void): void;
  close(): void;
}

export class WorkerPool {
  private readonly workers: WorkerLike[];
  private readonly busy: number[];
  private readonly waiting = new Map<number, { resolve: (c: Chunk) => void; reject: (e: Error) => void; worker: number }>();
  private nextId = 1;
  private closed = false;

  constructor(spawn: () => WorkerLike, size: number) {
    this.workers = Array.from({ length: size }, spawn);
    this.busy = this.workers.map(() => 0);
    this.workers.forEach((w, i) => w.onReply((reply) => {
      const entry = this.waiting.get(reply.id);
      if (!entry) return;
      this.waiting.delete(reply.id);
      this.busy[i]!--;
      if ('error' in reply) entry.reject(new Error(reply.error));
      else entry.resolve(reply.chunk);
    }));
  }

  get size(): number {
    return this.workers.length;
  }

  /** Tell every worker about a load (the area and where points are placed from). */
  begin(m: Omit<BeginMessage, 'type'>): void {
    for (const w of this.workers) w.post({ type: 'begin', ...m });
  }

  end(loadId: number): void {
    if (!this.closed) for (const w of this.workers) w.post({ type: 'end', loadId });
  }

  /** Decode a node on the least busy worker. */
  decode(m: Omit<NodeMessage, 'type' | 'id'>): Promise<Chunk> {
    if (this.closed) return Promise.reject(new Error('cancelled'));
    let w = 0;
    for (let i = 1; i < this.workers.length; i++) if (this.busy[i]! < this.busy[w]!) w = i;
    const id = this.nextId++;
    this.busy[w]!++;
    return new Promise<Chunk>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject, worker: w });
      this.workers[w]!.post({ type: 'node', id, ...m });
    });
  }

  /** Stop the workers. Anything still being decoded is rejected. */
  close(): void {
    this.closed = true;
    for (const w of this.workers) w.close();
    for (const entry of this.waiting.values()) entry.reject(new Error('cancelled'));
    this.waiting.clear();
  }
}
