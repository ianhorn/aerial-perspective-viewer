// The sharp picture of the scene: several photos blended into one, following the view. When the map stops
// moving it asks the API which photos the view needs (from the direction being looked, by the same rule as the
// list), reads each one's terrain and the tiles under the screen at the resolution the zoom calls for, blends them
// (`mosaic.ts`) into one picture the size of the screen, and lays it on the map over the whole-photo preview.
// Panning and zooming leave the last picture showing until the new one is ready.

import type { Map as MapLibreMap } from 'maplibre-gl';
import { getScene, type Look, type SceneFrame } from './api.ts';
import { type Camera, createCamera } from './camera.ts';
import { levelsOf, loadRegion, planRegion, sharedTiles } from './cog.ts';
import { maxScreenScale, photoRegionUnder } from './detail.ts';
import { type Corners, createOverlay } from './drape.ts';
import { gridToLonLat, lonLatToGrid } from './lcc.ts';
import { LruCache } from './lru.ts';
import { type MosaicFrame, mosaicRaster } from './mosaic.ts';
import { canvasToRaster, groundHeight, rasterToCanvas } from './ortho-canvas.ts';
import { meanGroundHeight } from './scene.ts';
import { fetchTerrain } from './terrain.ts';

/** What the last picture cost and covered, for tests and for a curious developer. */
export interface MosaicStats {
  /** How many photos were blended. */
  frames: number;
  filenames: string[];
  /** The widest level read, in pixels (the full-size level of the photo is 10,300 to 14,144). */
  levelWidth: number;
  levelWidths: number[];
  tiles: number;
  /** Bytes fetched for the tiles; tiles already kept are free. */
  bytes: number;
  canvas: [number, number];
  /** Screen device pixels per full-size photo pixel that the zoom calls for, for the photo that needs most. */
  needScale: number;
  /** Milliseconds spent blending, including reading the pixels out of the tiles' canvases (part of `ms`). */
  warpMs: number;
  /** Of `warpMs`: reading the pixels out of the canvases, the blend itself, and turning the result into an image for the map. */
  convertMs: number;
  blendMs: number;
  encodeMs: number;
  ms: number;
}

const SETTLE_MS = 250;
/** Under this camera zoom (level 15.5) the view is too wide for a mosaic to be worth its tiles: only the chosen photo's preview shows. */
const MIN_ZOOM = 14.5;
/** Tiles for the whole picture, shared between the photos. */
const TILE_BUDGET = 40;

interface Prepared { frame: SceneFrame; camera: Camera; heightAt: (x: number, y: number) => number; bias: number }

export class MosaicLayer {
  private readonly map: MapLibreMap;
  private readonly overlay = createOverlay('drape-detail');
  private readonly scenes = new LruCache<string, SceneFrame[]>(24);
  private look: Exclude<Look, 'down'> | null = null;
  private chosen: SceneFrame | null = null;
  private visible = true;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private request: AbortController | undefined;
  /** The last picture put on the map, or null when there is none. */
  lastStats: MosaicStats | null = null;

  private readonly flatGround: boolean;

  constructor(map: MapLibreMap, options: { flatGround?: boolean } = {}) {
    this.map = map;
    this.flatGround = options.flatGround ?? false;
  }

  /** Start showing the scene from a direction (or stop, with null). Whatever is on the map goes and the new picture is made. */
  setLook(look: Exclude<Look, 'down'> | null): void {
    this.look = look;
    this.reset();
    if (look) this.schedule(0);
  }

  /** The photo the user chose in the list: it is always included, and wins where photos are otherwise equal. */
  setChosen(chosen: SceneFrame | null): void {
    this.chosen = chosen;
    if (this.look) this.schedule(0);
  }

  /** The user can switch the photo off; the picture goes with it and comes back with it. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (visible) {
      this.schedule(0);
    } else {
      this.reset();
    }
  }

  /** The map moved: wait until it settles, then look again. */
  refresh(): void {
    this.schedule(SETTLE_MS);
  }

  private reset(): void {
    clearTimeout(this.timer);
    this.request?.abort();
    this.request = undefined;
    this.overlay.clear(this.map);
    this.lastStats = null;
  }

  private schedule(delay: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), delay);
  }

  private async run(): Promise<void> {
    const look = this.look;
    if (!look || !this.visible) return;
    this.request?.abort();
    const request = (this.request = new AbortController());
    const { signal } = request;
    const started = performance.now();
    try {
      const map = this.map;
      if (map.getZoom() < MIN_ZOOM) return this.drop(request);
      const canvas = map.getCanvas();
      const w = canvas.clientWidth, h = canvas.clientHeight;
      // The screen as it is now: its corners (where the picture will be laid) and nine points (what the view covers).
      const screen: Corners = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => {
        const at = map.unproject([x!, y!]);
        return [at.lng, at.lat];
      }) as Corners;
      const ground = [0, 0.5, 1].flatMap((fy) => [0, 0.5, 1].map((fx) => {
        const at = map.unproject([fx * w, fy * h]);
        return lonLatToGrid(at.lng, at.lat);
      }));

      // Which photos this view needs: the API's answer for the view's box, rounded outward so nearby views share it.
      const lons = screen.map((c) => c[0]), lats = screen.map((c) => c[1]);
      const round = 0.002;
      const box = {
        west: Math.floor(Math.min(...lons) / round) * round, south: Math.floor(Math.min(...lats) / round) * round,
        east: Math.ceil(Math.max(...lons) / round) * round, north: Math.ceil(Math.max(...lats) / round) * round,
      };
      let frames: SceneFrame[] = [];
      if (box.east - box.west <= 0.08 && box.north - box.south <= 0.08) {
        const key = `${box.west.toFixed(3)},${box.south.toFixed(3)},${box.east.toFixed(3)},${box.north.toFixed(3)}|${look}`;
        const kept = this.scenes.get(key);
        frames = kept ?? await getScene(box, look, signal).catch((error: unknown) => {
          if (!signal.aborted) console.error('no scene frames from the API, using the chosen photo only', error);
          return [] as SceneFrame[];
        });
        if (!kept && frames.length > 0) this.scenes.set(key, frames);
      }
      if (signal.aborted) return;
      const chosen = this.chosen;
      if (chosen && !frames.some((f) => f.filename === chosen.filename)) frames = [chosen, ...frames];
      if (frames.length === 0) return this.drop(request);

      const prepared = await Promise.all(frames.map((frame) => this.prepare(frame, chosen, signal)));
      if (signal.aborted) return;

      // Read, for each photo, the tiles under the screen at the level the zoom needs, sharing a budget of tiles.
      const toScreen = (x: number, y: number): [number, number] => {
        const [lon, lat] = gridToLonLat(x, y);
        const p = map.project([lon, lat]);
        return [p.x, p.y];
      };
      const dpr = window.devicePixelRatio || 1;
      const perFrame = Math.max(6, Math.floor(TILE_BUDGET / Math.max(1, prepared.length)));
      const loaded = await Promise.all(prepared.map(async (p) => {
        const region = photoRegionUnder(p.camera, p.heightAt, ground);
        if (!region) return null;
        const flat = p.heightAt(...ground[4]!);
        const k = maxScreenScale(p.camera, flat, region, toScreen);
        if (k === null) return null;
        const need = k * dpr;
        const levels = await levelsOf(p.frame.url, signal);
        const plan = planRegion(levels, region, need, perFrame);
        if (!plan) return null;
        const { canvas: piece, bytes } = await loadRegion(p.frame.url, plan, { signal, cache: sharedTiles });
        return { p, plan, piece, bytes, need };
      }).map((job) => job.catch((error: unknown) => {
        if (!signal.aborted) console.error('a photo could not be read; the others are used', error);
        return null;
      })));
      if (signal.aborted) return;
      const ready = loaded.filter((x): x is NonNullable<typeof x> => x !== null);
      if (ready.length === 0) return this.drop(request);

      // Blend them into one picture at the screen's own pixels (at most 2048), laid at the screen's corners.
      const warpStart = performance.now();
      const shrink = Math.min(1, 2048 / (Math.max(w, h) * dpr));
      const outW = Math.max(2, Math.round(w * dpr * shrink)), outH = Math.max(2, Math.round(h * dpr * shrink));
      const convertStart = performance.now();
      const mosaicFrames: MosaicFrame[] = ready.map(({ p, plan, piece }) => ({
        camera: p.camera, heightAt: p.heightAt, source: canvasToRaster(piece),
        scaleX: plan.scaleX, scaleY: plan.scaleY, offsetX: plan.rect.x, offsetY: plan.rect.y, bias: p.bias,
      }));
      const blendStart = performance.now();
      const raster = mosaicRaster({ corners: screen, width: outW, height: outH, frames: mosaicFrames });
      const blendMs = performance.now() - blendStart;
      const convertMs = blendStart - convertStart;
      const warpMs = performance.now() - warpStart;
      if (signal.aborted) return;
      const encodeStart = performance.now();
      const laid = rasterToCanvas(raster);
      await this.overlay.show(map, laid, screen, true);
      const encodeMs = performance.now() - encodeStart;
      if (signal.aborted) return;
      this.lastStats = {
        frames: ready.length, filenames: ready.map((r) => r.p.frame.filename),
        levelWidth: Math.max(...ready.map((r) => r.plan.level.width)), levelWidths: ready.map((r) => r.plan.level.width),
        tiles: ready.reduce((s, r) => s + r.plan.tiles.length, 0), bytes: ready.reduce((s, r) => s + r.bytes, 0),
        canvas: [laid.width, laid.height], needScale: Math.max(...ready.map((r) => r.need)), warpMs, convertMs, blendMs, encodeMs, ms: performance.now() - started,
      };
    } catch (error) {
      if (signal.aborted) return; // a newer look replaced this one
      console.error(error);
    }
  }

  /** A photo's camera and ground: its terrain patch, or flat at its mean height if that cannot be had. */
  private async prepare(frame: SceneFrame, chosen: SceneFrame | null, signal: AbortSignal): Promise<Prepared> {
    const terrain = this.flatGround ? null : await fetchTerrain(frame.url, signal).catch((error: unknown) => {
      if (!signal.aborted) console.error('no terrain for a photo, using flat ground for it', error);
      return null;
    });
    return {
      frame, camera: createCamera(frame.eo, frame.sensor),
      heightAt: groundHeight(terrain, meanGroundHeight(frame.footprint3089)),
      bias: chosen && frame.filename === chosen.filename ? 1.5 : 1,
    };
  }

  /** There is nothing to show for this view: take any picture off. */
  private drop(request: AbortController): void {
    if (request.signal.aborted) return;
    this.overlay.clear(this.map);
    this.lastStats = null;
  }
}
