// The point cloud on the map as a whole: what has been loaded, what is loading, and what the card should say. It runs one load at a time
// (a new one cancels the old), keeps the total on the map inside a limit, and hands each block of points to a sink (the map layer).
// The network, the workers and the sink are passed in, so it is tested without a browser. No DOM here.

import { areaSqMi, withinLimit, type LonLat } from './pc-aoi.ts';
import type { Chunk } from './pc-decode.ts';
import { loadPointCloud, mapLimit, type Area, type Progress, type Retry, type Summary } from './pc-load.ts';
import { nodesForView, place, type View } from './pc-lod.ts';
import { DEFAULT_BUDGET, type Budget, type NodeRef } from './pc-plan.ts';
import type { WorkerPool } from './pc-pool.ts';
import type { Fetch } from './pc-stac.ts';
import { DEFS, pcLimits, type PcLimits } from './settings.ts';

/** The most points on the map at once, across loads (about 140 MB of graphics memory). Clear the point cloud to load more. */
export const MAX_TOTAL_POINTS = 12_000_000;

/** The id of a block of points: which load (area), file and node it is. */
export const chunkId = (c: { loadId: number; file: number; key: string }): string => `${c.loadId}:${c.file}:${c.key}`;

/** The budget for a load when `room` more points fit on the map. */
export const budgetFor = (room: number, budget: Budget = DEFAULT_BUDGET): Budget => ({ ...budget, maxPoints: Math.min(budget.maxPoints, room) });

export interface Sink {
  add(chunk: Chunk): void;
  /** Take blocks off the map, by the id `chunkId` gives them. */
  remove(ids: readonly string[]): void;
  clear(): void;
  /** The area outlines. */
  setAreas(rings: readonly LonLat[][], active: LonLat[] | null): void;
}

/** The limits when nothing changes them: the settings' defaults. */
const DEFAULT_LIMITS: PcLimits = pcLimits({ get: (key) => DEFS[key].default });

export interface SessionDeps {
  /** The limits now (asked each time they are used, so a change to a setting applies to the next load or pass). Default: the settings' defaults. */
  limits?: () => PcLimits;
  /** The most points on the map at once (default: from `limits`). */
  maxTotalPoints?: number;
  /** The budget for one load (default: from `limits`). */
  budget?: Budget;
  /** The budget for each pass of adding detail for the screen (default: from `limits`). */
  refineBudget?: Budget;
  /** The least room, in points, a new load needs on the map (default 50,000). */
  minRoom?: number;
  /** How range requests are retried (default `RETRY`). */
  retry?: Retry;
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
  /** Finer detail is being read for the part of the map on the screen. */
  refining: boolean;
  /** Something the last pass of adding detail could not do (blocks it could not fetch), or null. */
  detailProblem: string | null;
}

export class PcSession {
  private readonly deps: SessionDeps;
  private readonly listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private loadId = 0;
  private areas: LonLat[][] = [];
  private zSample: number[] = [];
  /** The workers, kept while there is anything on the map so that detail can be added later (they hold each area's placement). */
  private pool: WorkerPool | null = null;
  /** What each load found over its area, for adding detail without searching again. */
  private readonly found = new Map<number, Area>();
  /** The blocks on the map, by `chunkId`, with the node each is (to judge how far it is from the screen). */
  private readonly onMap = new Map<string, { count: number; node: NodeRef | undefined; loadId: number }>();
  /** Every node read, including ones with no points inside the area: none of them is read again. */
  private readonly read = new Set<string>();
  private readonly inFlight = new Set<string>();
  /** Blocks a load could not fetch: gaps, until a later pass gets them. */
  private readonly gaps = new Set<string>();
  private refineController: AbortController | null = null;
  private pendingView: View | null = null;
  report: Report = { state: 'idle', progress: null, points: 0, summaries: [], notes: [], error: null, refining: false, detailProblem: null };
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

  private limits(): PcLimits {
    return this.deps.limits?.() ?? DEFAULT_LIMITS;
  }

  get loading(): boolean {
    return this.report.state === 'loading';
  }

  /** Load the point cloud for an area (shrunk to the limit if it is bigger). Cancels a load in progress. */
  async load(ring: readonly LonLat[]): Promise<void> {
    this.controller?.abort();
    const controller = (this.controller = new AbortController());
    const lim = this.limits();
    const { ring: area, limited } = withinLimit(ring, lim.areaSqMi);
    const notes: string[] = [];
    if (limited) notes.push(`That area is bigger than the ${lim.areaSqMi} square miles allowed at once, so the middle ${lim.areaSqMi} square miles were used.`);
    const room = (this.deps.maxTotalPoints ?? lim.maxTotalPoints) - this.report.points;
    if (room < (this.deps.minRoom ?? 50_000)) {
      this.report = { ...this.report, state: 'idle', progress: null, notes: [], error: 'The map is holding as many points as it can. Clear the point cloud, then load again.' };
      this.changed();
      return;
    }
    const id = ++this.loadId;
    this.deps.sink.setAreas(this.areas, area);
    this.report = { ...this.report, state: 'loading', progress: null, notes, error: null };
    this.changed();
    this.refineController?.abort(); // a load takes the workers; detail is added again once it is over
    const pool = (this.pool ??= this.deps.makePool());
    let first = true;
    try {
      const summary = await loadPointCloud(area, {
        fetchFn: this.deps.fetchFn, pool, signal: controller.signal, loadId: id, keepPlacement: true, ...(this.deps.retry ? { retry: this.deps.retry } : {}),
        budget: budgetFor(room, this.deps.budget ?? lim.budget), maxAreaSqMi: lim.areaSqMi,
        onProgress: (progress) => { if (this.loadId === id) { this.report = { ...this.report, progress }; this.changed(); } },
        onArea: (found) => { if (this.loadId === id) this.found.set(id, found); },
        onDecoded: (chunk) => { if (this.loadId === id) this.read.add(chunkId(chunk)); },
        onFailed: (node) => { if (this.loadId === id) this.gaps.add(chunkId(node)); },
        onChunk: (chunk) => {
          if (this.loadId !== id) return;
          this.put(chunk);
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
      if (summary.depth < summary.deepest) notes.push('This area has more detail than fits at once, so it is shown coarser. Zoom in and finer detail is read for what you are looking at.');
      if (summary.over) notes.push('This area is very dense; only its coarsest level was read.');
      this.report = { ...this.report, state: 'idle', summaries: [...this.report.summaries, summary], notes: this.withGapNote(notes), error: null };
    } catch (error) {
      if (this.loadId !== id) return; // a newer load took over
      const cancelled = (error as Error).name === 'AbortError';
      this.deps.sink.setAreas(this.areas, null);
      this.report = { ...this.report, state: 'idle', progress: null, notes: cancelled ? ['Stopped. The points loaded so far are on the map.'] : [], error: cancelled ? null : (error as Error).message };
    } finally {
      if (this.controller === controller) this.controller = null;
    }
    this.changed();
    if (this.pendingView) { const view = this.pendingView; this.pendingView = null; void this.refine(view); }
  }

  /** The notes, with one about gaps (blocks a load could not fetch) if there are any left. */
  private withGapNote(notes: readonly string[]): string[] {
    const rest = notes.filter((n) => !n.includes('of points could not be fetched'));
    const n = this.gaps.size;
    return n === 0 ? rest : [...rest, `${n} block${n > 1 ? 's' : ''} of points could not be fetched, so there ${n > 1 ? 'are gaps' : 'is a gap'}. They are tried again when the screen is over them.`];
  }

  /** Put a block of points on the map and account for it. */
  private put(chunk: Chunk, node?: NodeRef): void {
    const id = chunkId(chunk);
    this.deps.sink.add(chunk);
    if (this.gaps.delete(id)) this.report = { ...this.report, notes: this.withGapNote(this.report.notes) };
    this.onMap.set(id, { count: chunk.count, node: node ?? this.found.get(chunk.loadId)?.nodes.find((n) => n.file === chunk.file && n.key === chunk.key), loadId: chunk.loadId });
    this.report = { ...this.report, points: this.report.points + chunk.count };
    if (this.zSample.length < 500_000) {
      const stride = Math.max(1, Math.floor(chunk.count / 400));
      for (let i = 0; i < chunk.count; i += stride) this.zSample.push(chunk.positions[i * 3 + 2]!);
    }
  }

  /**
   * Read finer detail for what is on the screen now, within the areas already loaded: nodes that are on the screen and fine enough to be worth it at
   * this zoom (`nodesForView`), not read already, coarse first. When the map would hold more than its limit, blocks that are off the screen are
   * dropped, farthest first (and are read again if the screen comes back to them). One pass at a time: a view asked for during a pass is done after it.
   */
  async refine(view: View): Promise<void> {
    if (this.loading || this.report.refining) { this.pendingView = view; return; } // asked for during a load or a pass: done after it
    if (this.found.size === 0 || !this.pool) return;
    const pool = this.pool;
    const controller = (this.refineController = new AbortController());
    const lim = this.limits();
    const cap = this.deps.maxTotalPoints ?? lim.maxTotalPoints;
    this.report = { ...this.report, refining: true };
    this.changed();
    try {
      const wanted: { area: Area; node: NodeRef }[] = [];
      for (const area of this.found.values()) {
        const nodes = nodesForView(area.nodes, view, {
          aoi: area.box, targetPx: lim.targetPx, budget: budgetFor(cap, this.deps.refineBudget ?? lim.budget),
          skip: (n) => { const id = chunkId({ loadId: area.loadId, file: n.file, key: n.key }); return this.read.has(id) || this.inFlight.has(id); },
        });
        for (const node of nodes) wanted.push({ area, node });
      }
      wanted.sort((a, b) => a.node.depth - b.node.depth); // stable: within a level, nearest the middle of the screen first, as `nodesForView` ordered them
      const keep = new Set<string>();
      let failed = 0;
      await mapLimit(wanted, Math.max(pool.size * 2, 2), async ({ area, node }) => {
        if (controller.signal.aborted) return;
        const id = chunkId({ loadId: area.loadId, file: node.file, key: node.key });
        this.inFlight.add(id);
        try {
          const chunk = await pool.decode({ loadId: area.loadId, url: area.urls[node.file]!, file: node.file, key: node.key, node: { pointCount: node.count, pointDataOffset: node.offset, pointDataLength: node.length } });
          if (controller.signal.aborted || !this.found.has(area.loadId)) return;
          this.read.add(id);
          if (chunk.count === 0) return;
          if (!this.makeRoom(chunk.count, view, keep)) return; // the map is full of what is on the screen
          keep.add(id);
          this.put(chunk, node);
          this.changed();
        } catch {
          // a block that could not be fetched is tried again the next time the screen asks for it, and the card says so
          if (!controller.signal.aborted) failed++;
        } finally {
          this.inFlight.delete(id);
        }
      });
      if (!controller.signal.aborted) this.report = { ...this.report, detailProblem: failed > 0 ? `${failed} block${failed > 1 ? 's' : ''} of finer detail could not be fetched. They are tried again the next time the map moves.` : null };
    } finally {
      if (this.refineController === controller) this.refineController = null;
      this.report = { ...this.report, refining: false };
      this.changed();
      if (this.pendingView && !controller.signal.aborted) { const next = this.pendingView; this.pendingView = null; void this.refine(next); }
    }
  }

  /** Make room for `extra` points by taking off blocks that are off the screen, farthest from its middle first. Blocks in `keep` (just added) and on the screen stay. */
  private makeRoom(extra: number, view: View, keep: ReadonlySet<string>): boolean {
    const cap = this.deps.maxTotalPoints ?? this.limits().maxTotalPoints;
    const middle = { x: view.width / 2, y: view.height / 2 };
    while (this.report.points + extra > cap) {
      let worst: { id: string; distance: number } | null = null;
      for (const [id, c] of this.onMap) {
        if (keep.has(id) || !c.node) continue;
        const placed = place(c.node, view);
        if (placed?.onScreen) continue;
        const distance = placed ? Math.hypot(placed.centre.x - middle.x, placed.centre.y - middle.y) : Infinity;
        if (!worst || distance > worst.distance) worst = { id, distance };
      }
      if (!worst) return false;
      const gone = this.onMap.get(worst.id)!;
      this.deps.sink.remove([worst.id]);
      this.onMap.delete(worst.id);
      this.read.delete(worst.id); // it is read again if the screen comes back to it
      this.report = { ...this.report, points: this.report.points - gone.count };
    }
    return true;
  }

  private updateRange(): void {
    const values = this.zSample;
    if (values.length === 0) { this.range = null; return; }
    const sorted = [...values].sort((a, b) => a - b);
    const clip = this.limits().clip;
    const lo = sorted[Math.floor(clip * (sorted.length - 1))]!, hi = sorted[Math.floor((1 - clip) * (sorted.length - 1))]!;
    this.range = hi > lo ? [lo, hi] : [lo, lo + 1];
  }

  /** The colours again, after the limits changed (the share of points trimmed from each end of the range). */
  recolor(): void {
    this.updateRange();
    this.changed();
  }

  /** Stop the load in progress. What has arrived stays on the map. */
  cancel(): void {
    this.controller?.abort();
    this.refineController?.abort();
  }

  /** Take everything off the map. */
  clear(): void {
    this.controller?.abort();
    this.refineController?.abort();
    this.pendingView = null;
    this.pool?.close();
    this.pool = null;
    this.found.clear();
    this.onMap.clear();
    this.read.clear();
    this.inFlight.clear();
    this.gaps.clear();
    this.loadId++;
    this.areas = [];
    this.zSample = [];
    this.range = null;
    this.deps.sink.clear();
    this.deps.sink.setAreas([], null);
    this.report = { state: 'idle', progress: null, points: 0, summaries: [], notes: [], error: null, refining: false, detailProblem: null };
    this.changed();
  }

  /** The area size, for the card to show as an AOI is picked. */
  static areaSqMi(ring: readonly LonLat[]): number {
    return areaSqMi(ring);
  }
}
