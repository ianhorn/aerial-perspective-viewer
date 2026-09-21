// Which parts of a COPC file to read. A COPC file is an octree: node "D-X-Y-Z" is a cube one 2^D-th of the file's cube across, holding the
// points of that level that are not held by its parents, so reading every node down to a depth gives an even sample of the ground at
// the spacing of that depth (the file's own `spacing` halves at each level). Only the nodes over the area are read, and only as deep as
// a budget allows. No DOM here.

import { insideGrid, type Xy } from './pc-aoi.ts';

export type Box = [number, number, number, number];

/** A node in a file's hierarchy, with where its bytes are. */
export interface NodeRef {
  /** Which file (the position in the list of files being loaded). */
  file: number;
  key: string;
  depth: number;
  /** How many points it holds. */
  count: number;
  /** Where its compressed points are, in the file. */
  offset: number;
  length: number;
  /** Its footprint on the grid, feet. */
  box: Box;
}

/** The footprint of a node on the grid, from the file's cube ([xmin, ymin, zmin, xmax, ymax, zmax]) and the node's key. */
export function nodeBox(cube: readonly number[], key: string): Box {
  const [d, x, y] = key.split('-').map(Number) as [number, number, number];
  const size = (cube[3]! - cube[0]!) / 2 ** d;
  return [cube[0]! + x * size, cube[1]! + y * size, cube[0]! + (x + 1) * size, cube[1]! + (y + 1) * size];
}

export const boxesOverlap = (a: Box, b: Box): boolean => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

function segmentsCross(p: Xy, q: Xy, r: Xy, s: Xy): boolean {
  const o = (a: Xy, b: Xy, c: Xy): number => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  return o(p, q, r) !== o(p, q, s) && o(r, s, p) !== o(r, s, q);
}

/** Whether a rectangle and a polygon (grid feet) share any ground. */
export function boxTouchesPolygon(box: Box, ring: readonly Xy[]): boolean {
  const corners: Xy[] = [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]];
  if (ring.some((p) => p[0] >= box[0] && p[0] <= box[2] && p[1] >= box[1] && p[1] <= box[3])) return true;
  if (corners.some((c) => insideGrid(ring, c[0], c[1]))) return true;
  for (let i = 0; i < ring.length; i++) {
    for (let k = 0; k < 4; k++) if (segmentsCross(ring[i]!, ring[(i + 1) % ring.length]!, corners[k]!, corners[(k + 1) % 4]!)) return true;
  }
  return false;
}

/** How much of a node's footprint the polygon's bounding box covers, 0 to 1: the share of its points that are wanted, if they are spread evenly. */
export function coveredShare(node: Box, aoi: Box): number {
  const w = Math.min(node[2], aoi[2]) - Math.max(node[0], aoi[0]), h = Math.min(node[3], aoi[3]) - Math.max(node[1], aoi[1]);
  return w > 0 && h > 0 ? (w * h) / ((node[2] - node[0]) * (node[3] - node[1])) : 0;
}

export interface Budget {
  /** The most points to put on the map (an estimate: the share of each node the area covers, times its points). */
  maxPoints: number;
  /** The most compressed bytes to download (every byte of a node is fetched, wanted or not). */
  maxBytes: number;
}

/** About 5.3 bytes a point in the state's files (measured), so 4 million points is about 21 MB. */
export const DEFAULT_BUDGET: Budget = { maxPoints: 4_000_000, maxBytes: 32 * 1024 * 1024 };

export interface Selection {
  /** The deepest level read. */
  depth: number;
  nodes: NodeRef[];
  /** The estimated points that will be on the map. */
  points: number;
  bytes: number;
  /** The deepest level available over the area, if the budget had allowed it. */
  deepest: number;
  /** True when even the top level alone is over the budget (it is read anyway: there is nothing coarser). */
  over: boolean;
}

/**
 * Pick the nodes to read: every node over the area down to the deepest level whose total stays inside the budget. `nodes` are those of
 * every file, already limited to the ones over the area.
 */
export function selectNodes(nodes: readonly NodeRef[], aoi: Box, budget: Budget = DEFAULT_BUDGET): Selection {
  const deepest = nodes.reduce((m, n) => Math.max(m, n.depth), 0);
  const cost = (n: NodeRef): number => n.count * coveredShare(n.box, aoi);
  let depth = 0, points = 0, bytes = 0, over = false;
  for (let d = 0; d <= deepest; d++) {
    const level = nodes.filter((n) => n.depth === d);
    const p = points + level.reduce((s, n) => s + cost(n), 0), b = bytes + level.reduce((s, n) => s + n.length, 0);
    if (d > 0 && (p > budget.maxPoints || b > budget.maxBytes)) break;
    if (d === 0 && (p > budget.maxPoints || b > budget.maxBytes)) over = true;
    depth = d; points = p; bytes = b;
  }
  return { depth, nodes: nodes.filter((n) => n.depth <= depth), points: Math.round(points), bytes, deepest, over };
}
