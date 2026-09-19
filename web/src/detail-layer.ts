// The sharp part of the draped photo. The drape is a small preview of the whole photo, which is blurry once you
// zoom in. This layer follows the map: after the map stops moving it works out which part of the photo is on
// screen and how sharp it has to be, reads just those tiles from the photo at the right resolution, and lays
// them over the preview. Panning and zooming leave the preview showing until the new piece is ready.

import type { Map as MapLibreMap } from 'maplibre-gl';
import type { Camera } from './camera.ts';
import { type CogLevel, loadRegion, planRegion, readHeader } from './cog.ts';
import { maxScreenScale, photoRegionUnder } from './detail.ts';
import { type Corners, createOverlay } from './drape.ts';
import { gridToLonLat, lonLatToGrid } from './lcc.ts';
import { LruCache } from './lru.ts';

export interface DetailPhoto {
  url: string;
  camera: Camera;
  /** The height of the flat ground the photo is laid on, in feet, the same as for the preview. */
  groundZ: number;
  /** How much of the photo's full detail the preview has: its width over the full width. */
  baseScale: number;
}

/** What the last piece cost and covered, for tests and for a curious developer. */
export interface DetailStats {
  levelWidth: number;
  tiles: number;
  /** Bytes fetched for this piece; tiles already kept are free. */
  bytes: number;
  canvas: [number, number];
  /** Screen device pixels per full-size photo pixel that the zoom calls for. */
  needScale: number;
  ms: number;
}

const SETTLE_MS = 250;

export class DetailLayer {
  private readonly map: MapLibreMap;
  private readonly overlay = createOverlay('drape-detail');
  private readonly headers = new LruCache<string, CogLevel[]>(8);
  // Tiles are ~130 KB each at full size, so this holds about 20 MB, enough to pan back and forth.
  private readonly tiles = new LruCache<string, Uint8Array>(150);
  private photo: DetailPhoto | null = null;
  private visible = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private request: AbortController | undefined;
  /** The last piece put on the map, or null when the preview is enough. */
  lastStats: DetailStats | null = null;

  constructor(map: MapLibreMap) {
    this.map = map;
  }

  /** Use a new photo (or none): whatever piece is showing goes, and the new photo's piece is loaded. */
  setPhoto(photo: DetailPhoto | null): void {
    this.cancel();
    this.overlay.clear(this.map);
    this.lastStats = null;
    this.photo = photo;
    if (photo) this.schedule(0);
  }

  /** The user can switch the photo off; the sharp part goes with it and comes back with it. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) {
      this.schedule(0);
    } else {
      this.cancel();
      this.overlay.clear(this.map);
      this.lastStats = null;
    }
  }

  /** The map moved: wait until it settles, then look again. */
  refresh(): void {
    this.schedule(SETTLE_MS);
  }

  private cancel(): void {
    clearTimeout(this.timer);
    this.request?.abort();
    this.request = undefined;
  }

  private schedule(delay: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), delay);
  }

  private async run(): Promise<void> {
    const photo = this.photo;
    if (!photo || !this.visible) return;
    this.request?.abort();
    const request = (this.request = new AbortController());
    const started = performance.now();
    try {
      const map = this.map;
      const canvas = map.getCanvas();
      const w = canvas.clientWidth, h = canvas.clientHeight;
      // The screen's corners, edge middles and middle, as ground in grid feet.
      const ground = [0, 0.5, 1].flatMap((fy) => [0, 0.5, 1].map((fx) => {
        const at = map.unproject([fx * w, fy * h]);
        return lonLatToGrid(at.lng, at.lat);
      }));
      const region = photoRegionUnder(photo.camera, photo.groundZ, ground);
      const toScreen = (x: number, y: number): [number, number] => {
        const [lon, lat] = gridToLonLat(x, y);
        const p = map.project([lon, lat]);
        return [p.x, p.y];
      };
      const k = region && maxScreenScale(photo.camera, photo.groundZ, region, toScreen);
      if (!region || k === null || k === undefined) return this.drop(request);

      // Device pixels the screen has per photo pixel. If the preview already has that many, there is nothing to add.
      const need = k * (window.devicePixelRatio || 1);
      if (need <= photo.baseScale * 1.1) return this.drop(request);

      let levels = this.headers.get(photo.url);
      if (!levels) {
        levels = (await readHeader(photo.url, 64 * 1024, { signal: request.signal })).levels;
        this.headers.set(photo.url, levels);
      }
      const plan = planRegion(levels, region, need);
      const full = levels.reduce((a, b) => (b.width > a.width ? b : a));
      if (!plan || plan.level.width / full.width <= photo.baseScale * 1.1) return this.drop(request);

      const { canvas: piece, bytes } = await loadRegion(photo.url, plan, { signal: request.signal, cache: this.tiles });
      if (request.signal.aborted) return;

      // Where the piece's four corners are on the ground: the tile-aligned rectangle, in full-size photo pixels.
      const { rect, scaleX, scaleY } = plan;
      const px: [number, number][] = [
        [rect.x / scaleX, rect.y / scaleY], [(rect.x + rect.width) / scaleX, rect.y / scaleY],
        [(rect.x + rect.width) / scaleX, (rect.y + rect.height) / scaleY], [rect.x / scaleX, (rect.y + rect.height) / scaleY],
      ];
      const corners = px.map(([col, row]) => {
        const g = photo.camera.pixelToGround(col, row, photo.groundZ);
        return g && gridToLonLat(g[0], g[1]);
      });
      if (corners.some((c) => c === null)) return this.drop(request);

      await this.overlay.show(map, piece, corners as Corners, true);
      if (request.signal.aborted) return;
      this.lastStats = { levelWidth: plan.level.width, tiles: plan.tiles.length, bytes, canvas: [piece.width, piece.height], needScale: need, ms: performance.now() - started };
    } catch (error) {
      if (request.signal.aborted) return; // a newer look replaced this one
      console.error(error);
    }
  }

  /** The preview is enough here: take any sharp piece off. */
  private drop(request: AbortController): void {
    if (request.signal.aborted) return;
    this.overlay.clear(this.map);
    this.lastStats = null;
  }
}
