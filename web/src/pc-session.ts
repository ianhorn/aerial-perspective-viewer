// The point cloud on the map as a whole: what has been loaded, what is loading, and what the card should say. It runs one load at a time
// (a new one cancels the old), keeps the total on the map inside a limit, and hands each block of points to a sink (the map layer).
// The network, the workers and the sink are passed in, so it is tested without a browser. No DOM here.

import { areaSqMi, MAX_AOI_SQ_MI, withinLimit, type LonLat } from './pc-aoi.ts';
import type { Chunk } from './pc-decode.ts';
import { loadPointCloud, type Progress, type Summary } from './pc-load.ts';
import { DEFAULT_BUDGET, type Budget } from './pc-plan.ts';
import type { WorkerPool } from './pc-pool.ts';
import type { Fetch } from './pc-stac.ts';

/** The most points on the map at once, across loads (about 140 MB of graphics memory). Clear the point cloud to load more. */
export const MAX_TOTAL_POINTS = 12_000_000;

/** The budget for a load when `room` more points fit on the map. */
export const budgetFor = (room: number, budget: Budget = DEFAULT_BUDGET): Budget => ({ ...budget, maxPoints: Math.min(budget.maxPoints, room) });

export interface Sink {
  add(chunk: Chunk): void;
  clear(): void;
  /** The area outlines. */
  setAreas(rings: readonly LonLat[][], active: LonLat[] | null): void;
}

export interface SessionDeps {
  /** The most points on the map at once (default `MAX_TOTAL_POINTS`). */
  maxTotalPoints?: number;
  /** The budget for one load (default `DEFAULT_BUDGET`). */
  budget?: Budget;
  fetchFn: Fetch;
  makePool: () => WorkerPool;
  sink: Sink;
}

export type State = 'idle' | 'loading';

export interface Report {
  state: State;
  progress: Progress | null;
  /** Points on the map. */
  points: number;
  /** Loads that finished, most recent last. */
  summaries: Summary[];
  /** A message for the user about the latest load: what was limited, what failed. */
  notes: string[];
  error: string | null;
}

export class PcSession {
  private readonly deps: SessionDeps;
  private readonly listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private loadId = 0;
  private areas: LonLat[][] = [];
  private zSample: number[] = [];
  report: Report = { state: 'idle', progress: null, points: 0, summaries: [], notes: [], error: null };
  /** The heights the colours span, in feet: the middle 96% of what is loaded. Null with nothing loaded. */
  range: [number, number] | null = null;

  constructor(deps: SessionDeps) {
    this.deps = deps;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed(): void {
    for (const l of this.listeners) l();
  }

  get loading(): boolean {
    return this.report.state === 'loading';
  }

  /** Load the point cloud for an area (shrunk to the limit if it is bigger). Cancels a load in progress. */
  async load(ring: readonly LonLat[]): Promise<void> {
    this.controller?.abort();
    const controller = (this.controller = new AbortController());
    const { ring: area, limited } = withinLimit(ring);
    const notes: string[] = [];
    if (limited) notes.push(`That area is bigger than the ${MAX_AOI_SQ_MI} square miles allowed at once, so the middle ${MAX_AOI_SQ_MI} square miles were used.`);
    const room = (this.deps.maxTotalPoints ?? MAX_TOTAL_POINTS) - this.report.points;
    if (room < 50_000) {
      this.report = { ...this.report, state: 'idle', progress: null, notes: [], error: 'The map is holding as many points as it can. Clear the point cloud, then load again.' };
      this.changed();
      return;
    }
    const id = ++this.loadId;
    this.deps.sink.setAreas(this.areas, area);
    this.report = { ...this.report, state: 'loading', progress: null, notes, error: null };
    this.changed();
    const pool = this.deps.makePool();
    let first = true;
    try {
      const summary = await loadPointCloud(area, {
        fetchFn: this.deps.fetchFn, pool, signal: controller.signal, loadId: id,
        budget: budgetFor(room, this.deps.budget),
        onProgress: (progress) => { if (this.loadId === id) { this.report = { ...this.report, progress }; this.changed(); } },
        onChunk: (chunk) => {
          if (this.loadId !== id) return;
          this.deps.sink.add(chunk);
          this.report = { ...this.report, points: this.report.points + chunk.count };
          const stride = Math.max(1, Math.floor(chunk.count / 400));
          for (let i = 0; i < chunk.count; i += stride) this.zSample.push(chunk.positions[i * 3 + 2]!);
          if (first) { first = false; this.updateRange(); } // the colours are set from the coarse first block, then again at the end
        },
      });
      if (this.loadId !== id) return;
      this.updateRange();
      this.areas.push(area);
      this.deps.sink.setAreas(this.areas, null);
      if (summary.tiles.phase3 + summary.tiles.phase2 === 0) notes.push('No KyFromAbove point cloud covers that area.');
      if (summary.skipped > 0) notes.push(`${summary.skipped} tile${summary.skipped > 1 ? 's' : ''} in another coordinate system ${summary.skipped > 1 ? 'were' : 'was'} left out.`);
      if (summary.failed > 0) notes.push(`${summary.failed} tile${summary.failed > 1 ? 's' : ''} could not be read.`);
      if (summary.depth < summary.deepest) notes.push('This area has more detail than fits in the limit. Zoom in and load a smaller area for the full detail.');
      if (summary.over) notes.push('This area is very dense; only its coarsest level was read.');
      this.report = { ...this.report, state: 'idle', summaries: [...this.report.summaries, summary], notes, error: null };
    } catch (error) {
      if (this.loadId !== id) return; // a newer load took over
      const cancelled = (error as Error).name === 'AbortError';
      this.deps.sink.setAreas(this.areas, null);
      this.report = { ...this.report, state: 'idle', progress: null, notes: cancelled ? ['Stopped. The points loaded so far are on the map.'] : [], error: cancelled ? null : (error as Error).message };
    } finally {
      pool.close();
      if (this.controller === controller) this.controller = null;
    }
    this.changed();
  }

  private updateRange(): void {
    const values = this.zSample;
    if (values.length === 0) { this.range = null; return; }
    const sorted = [...values].sort((a, b) => a - b);
    const lo = sorted[Math.floor(0.02 * (sorted.length - 1))]!, hi = sorted[Math.floor(0.98 * (sorted.length - 1))]!;
    this.range = hi > lo ? [lo, hi] : [lo, lo + 1];
  }

  /** Stop the load in progress. What has arrived stays on the map. */
  cancel(): void {
    this.controller?.abort();
  }

  /** Take everything off the map. */
  clear(): void {
    this.controller?.abort();
    this.loadId++;
    this.areas = [];
    this.zSample = [];
    this.range = null;
    this.deps.sink.clear();
    this.deps.sink.setAreas([], null);
    this.report = { state: 'idle', progress: null, points: 0, summaries: [], notes: [], error: null };
    this.changed();
  }

  /** The area size, for the card to show as an AOI is picked. */
  static areaSqMi(ring: readonly LonLat[]): number {
    return areaSqMi(ring);
  }
}
