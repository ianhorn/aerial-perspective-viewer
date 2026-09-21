// What a decoding worker does, apart from being a worker, so it can also run (and be tested) in one process: read a node of a COPC file
// by range request, decompress it, and hand back a chunk. It keeps each file's header (a Copc) between nodes, and each load's placement.

import { Copc, type Getter, type Hierarchy } from 'copc';
import type { LazPerf } from 'laz-perf';
import { chunkFromView, type Chunk, type Placement } from './pc-decode.ts';
import type { Xy } from './pc-aoi.ts';
import { Warp } from './pc-warp.ts';

/** Reads a byte range [begin, end) of a file. */
export type MakeGetter = (url: string) => Getter;

export interface BeginMessage {
  type: 'begin';
  loadId: number;
  /** The area on the grid: its polygon and the rectangle round it, and the Web Mercator position that points are placed relative to. */
  ring: Xy[];
  box: [number, number, number, number];
  origin: [number, number];
}
export interface NodeMessage { type: 'node'; loadId: number; id: number; url: string; file: number; key: string; node: Hierarchy.Node }
export interface EndMessage { type: 'end'; loadId: number }
export type WorkerRequest = BeginMessage | NodeMessage | EndMessage;
export type WorkerReply = { id: number; chunk: Chunk } | { id: number; error: string };

export class NodeDecoder {
  private readonly makeGetter: MakeGetter;
  private readonly lazPerf: LazPerf | Promise<LazPerf> | undefined;
  private readonly copcs = new Map<string, Promise<Copc>>();
  private readonly loads = new Map<number, Placement>();

  constructor(makeGetter: MakeGetter, lazPerf?: LazPerf | Promise<LazPerf>) {
    this.makeGetter = makeGetter;
    this.lazPerf = lazPerf;
  }

  begin(m: BeginMessage): void {
    this.loads.set(m.loadId, { ring: m.ring, warp: new Warp(m.box), origin: m.origin });
  }

  end(loadId: number): void {
    this.loads.delete(loadId);
  }

  async decode(m: NodeMessage): Promise<Chunk> {
    const place = this.loads.get(m.loadId);
    if (!place) throw new Error('that load is over');
    const getter = this.makeGetter(m.url);
    let copc = this.copcs.get(m.url);
    if (!copc) this.copcs.set(m.url, (copc = Copc.create(getter)));
    // Only the three dimensions that are drawn are unpacked.
    const view = await Copc.loadPointDataView(getter, await copc, m.node, { lazPerf: await this.lazPerf, include: ['X', 'Y', 'Z'] });
    return chunkFromView(view, place, m.file, m.key, (await copc).info.spacing);
  }

  /** Handle one request. Replies for a node, and nothing for the others. */
  async handle(m: WorkerRequest): Promise<WorkerReply | null> {
    if (m.type === 'begin') { this.begin(m); return null; }
    if (m.type === 'end') { this.end(m.loadId); return null; }
    try {
      return { id: m.id, chunk: await this.decode(m) };
    } catch (error) {
      this.copcs.delete(m.url); // a failed header may work next time
      return { id: m.id, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
