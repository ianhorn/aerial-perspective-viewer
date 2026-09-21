// Finding the point clouds that cover an area: a search of the state's STAC catalogue (the KyFromAbove point-cloud collections). Phase 3
// (2025 on, where flown) is asked first, and Phase 2 only for the ground that Phase 3 does not cover. Each item is one 5,000 ft tile, a
// COPC file in the KyFromAbove bucket. The network is passed in so this can be tested without one. No DOM here.

import { boxTouchesPolygon, type Box } from './pc-plan.ts';
import { gridBox, gridRing, insideGrid, toGeoJsonPolygon, type LonLat } from './pc-aoi.ts';
import { lonLatToGrid } from './lcc.ts';

export const STAC_URL = 'https://spved5ihrl.execute-api.us-west-2.amazonaws.com';
/** The collections, newest first: Phase 3 is preferred, and Phase 2 fills in where Phase 3 was not flown. */
export const COLLECTIONS = [{ id: 'laz-phase3', phase: 3 }, { id: 'laz-phase2', phase: 2 }] as const;
/** More tiles than this in one load means the area is bigger than it should be. */
export const MAX_ITEMS = 24;

export interface PcItem {
  id: string;
  phase: 2 | 3;
  /** The COPC file. */
  href: string;
  /** The tile on the grid, feet: [xmin, ymin, xmax, ymax]. */
  box: Box;
  /** The number of points in the file. */
  count: number;
  datetime: string | null;
}

export interface Found {
  items: PcItem[];
  /** Items skipped because they are not in the Kentucky Single Zone, the coordinate system everything here assumes. */
  skipped: number;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

interface StacItem {
  id: string;
  bbox?: number[];
  properties?: Record<string, unknown>;
  assets?: Record<string, { href?: string }>;
}
interface StacPage { features?: StacItem[]; links?: { rel: string; method?: string; body?: Record<string, unknown>; href?: string }[] }

async function search(collection: string, area: unknown, fetchFn: Fetch, signal: AbortSignal | undefined): Promise<StacItem[]> {
  const items: StacItem[] = [];
  let body: Record<string, unknown> = { collections: [collection], intersects: area, limit: 50 };
  for (let page = 0; page < 4; page++) {
    const response = await fetchFn(`${STAC_URL}/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
    if (!response.ok) throw new Error(`The point-cloud catalogue answered ${response.status}.`);
    const data = (await response.json()) as StacPage;
    items.push(...(data.features ?? []));
    const next = data.links?.find((l) => l.rel === 'next');
    if (!next?.body) break;
    body = { ...body, ...next.body };
  }
  return items;
}

/** One STAC item as a tile, or null if it is not usable here. */
function asItem(raw: StacItem, phase: 2 | 3): PcItem | null | 'foreign' {
  const href = raw.assets?.['pointcloud']?.href;
  if (!href) return null;
  const wkt = raw.properties?.['proj:wkt2'];
  if (typeof wkt === 'string' && !/Kentucky Single Zone \(ftUS\)/.test(wkt)) return 'foreign';
  const projBox = raw.properties?.['proj:bbox'] as number[] | undefined;
  let box: Box;
  if (projBox && projBox.length >= 4) box = [projBox[0]!, projBox[1]!, projBox[2]!, projBox[3]!];
  else if (raw.bbox && raw.bbox.length >= 4) {
    const a = lonLatToGrid(raw.bbox[0]!, raw.bbox[1]!), b = lonLatToGrid(raw.bbox[2]!, raw.bbox[3]!);
    box = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  } else return null;
  return { id: raw.id, phase, href, box, count: Number(raw.properties?.['pc:count'] ?? 0), datetime: typeof raw.properties?.['datetime'] === 'string' ? raw.properties['datetime'] : null };
}

/** Grid positions spread over a polygon, to ask "is this part of the ground covered". */
export function samplePoints(ring: readonly LonLat[], n = 24): [number, number][] {
  const g = gridRing(ring), box = gridBox(ring);
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = box[0] + ((i + 0.5) / n) * (box[2] - box[0]), y = box[1] + ((j + 0.5) / n) * (box[3] - box[1]);
      if (insideGrid(g, x, y)) out.push([x, y]);
    }
  }
  return out;
}

const covers = (item: PcItem, p: [number, number]): boolean => p[0] >= item.box[0] && p[0] <= item.box[2] && p[1] >= item.box[1] && p[1] <= item.box[3];

/**
 * The tiles to load for an area. Phase 3's tiles that touch it are taken; Phase 2 is searched only if Phase 3 leaves some of the area
 * uncovered, and only the Phase 2 tiles that cover some of that uncovered ground are added.
 */
export async function findPointClouds(ring: readonly LonLat[], fetchFn: Fetch, signal?: AbortSignal): Promise<Found> {
  const area = toGeoJsonPolygon(ring);
  const grid = gridRing(ring);
  let skipped = 0;
  const take = (raws: StacItem[], phase: 2 | 3): PcItem[] => {
    const out: PcItem[] = [];
    for (const raw of raws) {
      const item = asItem(raw, phase);
      if (item === 'foreign') skipped++;
      else if (item && boxTouchesPolygon(item.box, grid)) out.push(item);
    }
    return out;
  };

  const samples = samplePoints(ring);
  const items: PcItem[] = take(await search(COLLECTIONS[0].id, area, fetchFn, signal), 3);
  const uncovered = samples.filter((p) => !items.some((it) => covers(it, p)));
  if (uncovered.length > 0) {
    const older = take(await search(COLLECTIONS[1].id, area, fetchFn, signal), 2);
    items.push(...older.filter((it) => uncovered.some((p) => covers(it, p))));
  }
  if (items.length > MAX_ITEMS) throw new Error(`That area needs ${items.length} tiles, more than the ${MAX_ITEMS} allowed. Choose a smaller area.`);
  return { items, skipped };
}
