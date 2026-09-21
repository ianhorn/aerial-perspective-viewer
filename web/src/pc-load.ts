// Loading a point cloud for an area: search the catalogue for the tiles, read each tile's header and the part of its hierarchy over the
// area (a few tens of kilobytes by range request), choose how deep to read from a budget, then read and decode just those nodes,
// handing each block of points on as it arrives so the map fills in from coarse to fine. The network and the workers are passed in. No DOM here.

import { Copc, type Getter, type Hierarchy } from 'copc';
import { gridToLonLat } from './lcc.ts';
import { areaSqMi, gridBox, gridRing, MAX_AOI_SQ_MI, type LonLat } from './pc-aoi.ts';
import type { Chunk } from './pc-decode.ts';
import { boxTouchesPolygon, DEFAULT_BUDGET, nodeBox, selectNodes, type Budget, type NodeRef } from './pc-plan.ts';
import type { WorkerPool } from './pc-pool.ts';
import { findPointClouds, type Fetch, type PcItem } from './pc-stac.ts';
import { lonLatToMercator } from './pc-warp.ts';

export type Stage = 'searching' | 'reading' | 'loading' | 'done';

export interface Progress {
  stage: Stage;
  /** Known once the search is done. */
  tiles?: { phase3: number; phase2: number };
  /** Known once the hierarchies are read: what will be read. */
  plan?: { depth: number; deepest: number; points: number; bytes: number; nodes: number; over: boolean };
  loadedNodes: number;
  loadedPoints: number;
}

export interface Summary {
  tiles: { phase3: number; phase2: number };
  depth: number;
  deepest: number;
  points: number;
  /** Bytes fetched for headers, hierarchies and nodes. */
  bytes: number;
  /** Tiles that could not be read. */
  failed: number;
  /** Tiles skipped for being in another coordinate system. */
  skipped: number;
  /** Why the top level alone was more than the budget, if it was. */
  over: boolean;
}

export interface LoadOptions {
  fetchFn: Fetch;
  pool: WorkerPool;
  signal?: AbortSignal;
  budget?: Budget;
  maxAreaSqMi?: number;
  onProgress?: (p: Progress) => void;
  onChunk: (c: Chunk) => void;
  /** An id for this load, so a worker can keep the load's placement. */
  loadId: number;
}

/** A getter that reads a byte range of a file by HTTP range request. */
export function rangeGetter(fetchFn: Fetch, url: string, signal?: AbortSignal, count?: (bytes: number) => void): Getter {
  return async (begin, end) => {
    const response = await fetchFn(url, { headers: { Range: `bytes=${begin}-${end - 1}` }, signal });
    if (response.status !== 206) throw new Error(`${response.status === 200 ? 'The file server does not do range requests' : `The file server answered ${response.status}`}.`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    count?.(bytes.length);
    return bytes;
  };
}

/** Run `task` over `items`, `limit` at a time. */
async function mapLimit<T, R>(items: readonly T[], limit: number, task: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await task(items[i]!, i); }
  }));
  return results;
}

/** Every node of a file's hierarchy over the area, reading sub-pages only where they are over the area. */
export async function nodesOver(
  loadPage: (page: Hierarchy.Page) => Promise<Hierarchy.Subtree>,
  info: { cube: readonly number[]; rootHierarchyPage: Hierarchy.Page },
  file: number,
  ring: readonly [number, number][],
): Promise<NodeRef[]> {
  const out: NodeRef[] = [];
  const pending: Hierarchy.Page[] = [info.rootHierarchyPage];
  for (let guard = 0; pending.length > 0 && guard < 200; guard++) {
    const page = pending.pop()!;
    const { nodes, pages } = await loadPage(page);
    for (const [key, n] of Object.entries(nodes)) {
      if (!n || n.pointCount <= 0) continue;
      const box = nodeBox(info.cube, key);
      if (boxTouchesPolygon(box, ring)) out.push({ file, key, depth: Number(key.split('-')[0]), count: n.pointCount, offset: n.pointDataOffset, length: n.pointDataLength, box });
    }
    for (const [key, p] of Object.entries(pages)) if (p && boxTouchesPolygon(nodeBox(info.cube, key), ring)) pending.push(p);
  }
  return out;
}

export async function loadPointCloud(aoi: readonly LonLat[], o: LoadOptions): Promise<Summary> {
  const limit = o.maxAreaSqMi ?? MAX_AOI_SQ_MI;
  if (areaSqMi(aoi) > limit * 1.0001) throw new Error(`That area is bigger than the ${limit} square miles allowed.`);
  const cancelled = (): boolean => o.signal?.aborted === true;
  const check = (): void => { if (cancelled()) throw new DOMException('cancelled', 'AbortError'); };
  let bytes = 0;
  const count = (n: number): void => { bytes += n; };
  const progress: Progress = { stage: 'searching', loadedNodes: 0, loadedPoints: 0 };
  const report = (): void => o.onProgress?.({ ...progress });

  report();
  const ring = gridRing(aoi), box = gridBox(aoi);
  const found = await findPointClouds(aoi, o.fetchFn, o.signal);
  check();
  const tiles = { phase3: found.items.filter((i) => i.phase === 3).length, phase2: found.items.filter((i) => i.phase === 2).length };
  progress.stage = 'reading';
  progress.tiles = tiles;
  report();
  if (found.items.length === 0) {
    progress.stage = 'done';
    report();
    return { tiles, depth: 0, deepest: 0, points: 0, bytes, failed: 0, skipped: found.skipped, over: false };
  }

  // Each tile's header and the part of its hierarchy over the area.
  let failed = 0;
  let firstFailure = '';
  const files = await mapLimit<PcItem, { item: PcItem; nodes: NodeRef[] } | null>(found.items, 4, async (item, file) => {
    try {
      const getter = rangeGetter(o.fetchFn, item.href, o.signal, count);
      const copc = await Copc.create(getter);
      return { item, nodes: await nodesOver((page) => Copc.loadHierarchyPage(getter, page), copc.info, file, ring) };
    } catch (error) {
      if (cancelled()) throw error;
      failed++;
      firstFailure ||= error instanceof Error ? error.message : String(error);
      return null;
    }
  });
  check();
  const ok = files.map((f, file) => (f ? { ...f, file } : null)).filter((f): f is { item: PcItem; nodes: NodeRef[]; file: number } => f !== null);
  if (ok.length === 0) throw new Error(`None of the point-cloud files could be read${firstFailure ? `: ${firstFailure}` : '.'}`);
  const selection = selectNodes(ok.flatMap((f) => f.nodes), box, o.budget ?? DEFAULT_BUDGET);
  progress.stage = 'loading';
  progress.plan = { depth: selection.depth, deepest: selection.deepest, points: selection.points, bytes: selection.bytes, nodes: selection.nodes.length, over: selection.over };
  report();

  // Everything is placed relative to the middle of the area.
  const mid = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2] as const;
  const origin = lonLatToMercator(...gridToLonLat(mid[0], mid[1]));
  o.pool.begin({ loadId: o.loadId, ring, box, origin });
  try {
    // Coarse levels first, so the map fills in from a rough picture to a fine one.
    const ordered = [...selection.nodes].sort((a, b) => a.depth - b.depth);
    let points = 0;
    await mapLimit(ordered, Math.max(o.pool.size * 2, 2), async (n) => {
      check();
      const item = ok.find((f) => f.file === n.file)!.item;
      let chunk: Chunk;
      try {
        chunk = await o.pool.decode({ loadId: o.loadId, url: item.href, file: n.file, key: n.key, node: { pointCount: n.count, pointDataOffset: n.offset, pointDataLength: n.length } });
      } catch (error) {
        if (cancelled()) throw new DOMException('cancelled', 'AbortError');
        throw error;
      }
      check();
      count(n.length);
      points += chunk.count;
      progress.loadedNodes++;
      progress.loadedPoints = points;
      if (chunk.count > 0) o.onChunk(chunk);
      report();
    });
    progress.stage = 'done';
    report();
    return { tiles, depth: selection.depth, deepest: selection.deepest, points, bytes, failed, skipped: found.skipped, over: selection.over };
  } finally {
    o.pool.end(o.loadId);
  }
}
