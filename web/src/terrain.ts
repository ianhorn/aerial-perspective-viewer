// The ground under a photo. Each photo has a small elevation patch (a JSON file next to the .tif) from the same
// terrain model the vendor used to place its photos: a grid of heights in US survey feet in EPSG:3089, one
// value per 50 ft cell. Rows run from the bottom up (row 0 is at `lowerLeftY`), which was checked against the
// statewide elevation tiles (top-down read the wrong way by 23 to 240 ft, bottom-up agreed to under 2 ft), and
// the cell values are read as heights at the cell's centre.

import { LruCache } from './lru.ts';

/** The patch as it is stored. */
export interface TerrainGrid {
  cellSize: number;
  lowerLeftX: number;
  lowerLeftY: number;
  noDataValue: number;
  /** Rows of heights, the first row being the bottom (southernmost) one. */
  value: number[][];
}

export interface Terrain {
  /** The ground height in feet at a grid position, or null outside the patch or where it has no data. */
  heightAt(x: number, y: number): number | null;
  /** The area the patch covers, in grid feet. */
  readonly extent: { xMin: number; yMin: number; xMax: number; yMax: number };
}

export function createTerrain(grid: TerrainGrid): Terrain {
  const rows = grid.value.length;
  const cols = grid.value[0]?.length ?? 0;
  if (rows < 1 || cols < 1 || !(grid.cellSize > 0)) throw new Error('the terrain patch is empty');
  const { cellSize, lowerLeftX: x0, lowerLeftY: y0 } = grid;
  const extent = { xMin: x0, yMin: y0, xMax: x0 + cols * cellSize, yMax: y0 + rows * cellSize };
  const cell = (col: number, row: number): number | null => {
    const v = grid.value[row]?.[col];
    return v === undefined || v === grid.noDataValue || !Number.isFinite(v) ? null : v;
  };

  return {
    extent,
    heightAt(x, y) {
      if (x < extent.xMin || x > extent.xMax || y < extent.yMin || y > extent.yMax) return null;
      // Positions in cells, measured between cell centres, kept inside the first and last centre.
      const u = Math.min(cols - 1, Math.max(0, (x - x0) / cellSize - 0.5));
      const v = Math.min(rows - 1, Math.max(0, (y - y0) / cellSize - 0.5));
      const i = Math.min(cols - 2, Math.floor(u)), j = Math.min(rows - 2, Math.floor(v));
      const i0 = Math.max(0, i), j0 = Math.max(0, j), i1 = Math.min(cols - 1, i0 + 1), j1 = Math.min(rows - 1, j0 + 1);
      const fu = u - i0, fv = v - j0;
      const corners: [number | null, number][] = [
        [cell(i0, j0), (1 - fu) * (1 - fv)], [cell(i1, j0), fu * (1 - fv)], [cell(i0, j1), (1 - fu) * fv], [cell(i1, j1), fu * fv],
      ];
      // All four corners have data: plain bilinear. Where one is missing, use the others, weighted the same way but
      // with a little weight added to each, so the answer still comes from its neighbours right at the missing cell.
      const missing = corners.some(([value]) => value === null);
      let sum = 0, weight = 0;
      for (const [value, w] of corners) if (value !== null) { const wt = missing ? w + 0.05 : w; sum += value * wt; weight += wt; }
      return weight > 1e-9 ? sum / weight : null;
    },
  };
}

const cache = new LruCache<string, Terrain>(12);
const pending = new Map<string, Promise<Terrain>>();

/**
 * Read a photo's elevation patch. Kept, so a photo seen again costs nothing, and a patch already being fetched is
 * shared. The photo's own address with `.json` in place of `.tif` is where it lives.
 */
export function fetchTerrain(photoUrl: string, signal?: AbortSignal): Promise<Terrain> {
  const url = photoUrl.replace(/\.tif$/, '.json');
  const kept = cache.get(url);
  if (kept) return Promise.resolve(kept);
  let request = pending.get(url);
  if (!request) {
    // Not tied to one caller's signal: it is shared, small (about 64 KB) and worth finishing.
    request = fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`${url} answered ${response.status}`);
        return response.json() as Promise<TerrainGrid>;
      })
      .then((grid) => {
        const terrain = createTerrain(grid);
        cache.set(url, terrain);
        return terrain;
      })
      .finally(() => pending.delete(url));
    pending.set(url, request);
  }
  if (!signal) return request;
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', () => reject(signal.reason ?? new DOMException('aborted', 'AbortError')), { once: true });
    request.then(resolve, reject);
  });
}
