import { AttributionControl, Map as MapLibreMap, Marker, NavigationControl, ScaleControl, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { type FramePick, getFrame, getFrames, type FrameDetail, type Look, type SceneFrame } from './api.ts';
import { createCamera } from './camera.ts';
import { cogStats } from './cog.ts';
import { MosaicLayer } from './mosaic-layer.ts';
import { loadOverview, type Overview } from './cog.ts';
import { BASEMAP, KENTUCKY_BOUNDS, MAX_BOUNDS, ORTHO_CLOSE } from './config.ts';
import { describeFrame, LOOK_AZIMUTH } from './describe.ts';
import { clearDrape, setDrapeVisible, showDrape } from './drape.ts';
import { initFootprint, showFootprint } from './footprint.ts';
import { LevelControl } from './level-control.ts';
import { LruCache } from './lru.ts';
import { type PanelState, renderPanel, setThumb } from './panel.ts';
import { shrink } from './thumb.ts';
import { cropThumbnail } from './thumb-crop.ts';
import { lonLatToGrid } from './lcc.ts';
import { warmUp } from './warm.ts';
import { createPhotoPane } from './photo.ts';
import { groundHeight, wholePhotoOnGround } from './ortho-canvas.ts';
import { flightHeading, gridBearingToTrue, meanGroundHeight, planeHeightAt } from './scene.ts';
import { fetchTerrain } from './terrain.ts';
import { SceneControl } from './scene-control.ts';

// MapLibre 6 finds its worker next to its own script. Vite pre-bundles (dev) or bundles (build) that
// script, so the guess points at a file that does not exist and every source that needs the worker,
// GeoJSON included, silently never loads. Have Vite build the worker and say where it is.
setWorkerUrl(workerUrl);

declare global {
  interface Window { __map?: MapLibreMap; __detail?: MosaicLayer; __thumbBytes?: () => { tiles: number; headers: number } }
}

const map = new MapLibreMap({
  container: 'map',
  style: {
    version: 8,
    sources: {
      basemap: {
        type: 'raster',
        tiles: [BASEMAP.tiles],
        tileSize: BASEMAP.tileSize,
        minzoom: 0,
        maxzoom: BASEMAP.maxzoom,
        attribution: BASEMAP.attribution,
      },
      // Level 21 of the Phase 3 orthoimagery, for the closest zoom, where the basemap has run out of tiles.
      ortho: {
        type: 'raster',
        tiles: [ORTHO_CLOSE.tiles],
        tileSize: ORTHO_CLOSE.tileSize,
        minzoom: ORTHO_CLOSE.level,
        maxzoom: ORTHO_CLOSE.level,
        bounds: KENTUCKY_BOUNDS,
        attribution: BASEMAP.attribution,
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#1b1f24' } },
      { id: 'basemap', type: 'raster', source: 'basemap' },
      // MapLibre's camera zoom is one below the tile level, so level 21 starts at camera zoom 20.
      { id: 'ortho-close', type: 'raster', source: 'ortho', minzoom: ORTHO_CLOSE.level - 1 },
    ],
  },
  bounds: KENTUCKY_BOUNDS,
  fitBoundsOptions: { padding: 24 },
  maxBounds: MAX_BOUNDS,
  attributionControl: false,
});

map.addControl(new NavigationControl({ showCompass: true }), 'top-right');
map.addControl(new SceneControl({
  onScene: (on) => {
    sceneOn = on;
    photoShown = true; // each time the scene starts, the photo is shown
    if (on) photo.tuck(true); // the map is the main view now; the pane is one click away on its tab
    void applyScene();
  },
  onPhoto: (shown) => {
    photoShown = shown;
    setDrapeVisible(map, shown);
    mosaic.setVisible(shown);
  },
}), 'top-right');
map.addControl(new ScaleControl({ unit: 'imperial' }), 'bottom-left');
map.addControl(new LevelControl(), 'bottom-left');
map.addControl(new AttributionControl({ compact: true }), 'bottom-right');
map.on('load', () => initFootprint(map));
// Wake the TiTiler as the app opens, in case it sleeps between uses. Only if its address is configured
// (VITE_TITILER_URL, kept in a git-ignored .env.local); the result does not matter.
void warmUp(import.meta.env.VITE_TITILER_URL);
// A test script can inspect the map in dev, or in a build made with VITE_EXPOSE_MAP=1. Off in normal builds.
// Photos are laid on flat ground at their footprint's mean height, as the vendor's own viewer did: fast, and sharp,
// because a photo seen from its own camera is never stretched. Correcting for terrain places hills better but streaks
// steep ground that faces away from the camera, and costs a request per photo, so it is off unless `?terrain=on` is in
// the address (for comparing, and for a 3D view later).
const useTerrain = new URLSearchParams(location.search).get('terrain') === 'on';
const mosaic = new MosaicLayer(map, { flatGround: !useTerrain });
if (import.meta.env.DEV || import.meta.env.VITE_EXPOSE_MAP) { window.__map = map; window.__detail = mosaic; window.__thumbBytes = () => ({ tiles: thumbTileBytes, headers: cogStats.headerBytes }); }
// After the map stops moving, look again at which part of the photo is on screen and how sharp it has to be.
map.on('moveend', () => mosaic.refresh());

const panel = document.getElementById('panel')!;
// The pane changes the width of the map beside it, so tell the map when it appears or goes.
const photo = createPhotoPane(document.getElementById('photo')!, {
  onVisibilityChange: () => map.resize(),
  onPhoto: (filename, overview) => {
    latestPhoto = { filename, overview };
    void applyScene();
  },
});
// Small pictures for the rows of the list. They are kept, so changing the direction and back costs nothing.
const THUMB_WIDTH = 96;
const THUMB_HEIGHT = 72;
const thumbs = new LruCache<string, HTMLCanvasElement>(40);
// A thumbnail shows the ground around the clicked point, so it depends on the point as well as the photo.
const pointKey = (): string => {
  if (!state.point) return '';
  const [x, y] = lonLatToGrid(state.point.lng, state.point.lat);
  return `${Math.round(x)},${Math.round(y)}`;
};
const thumbKey = (filename: string): string => `${filename}@${pointKey()}`;
let thumbTileBytes = 0; // tile bytes fetched for thumbnails, for measuring
let thumbRequest: AbortController | undefined;
const state: PanelState = { point: null, look: 'north', status: 'idle', frames: [], selected: 0, thumbs: { get: (filename) => thumbs.get(thumbKey(filename)) } };
let marker: Marker | undefined;
// The scene: the chosen photo draped on the map, turned so it looks up. It needs the frame's detail (for the
// camera) and the decoded photo, which arrive separately, so each is remembered with the name it belongs to.
let sceneOn = false;
let fittedFor: string | null = null; // the photo the map was last fitted to in this scene
let keepView = false; // set when the direction or the point changes in a scene: turn the map, but keep its place
let sceneVersion = 0; // each call of applyScene takes the next number, so a slow one can tell it has been replaced
let photoShown = true; // the draped photo can be switched off to see the map underneath; the scene stays on
let latestDetail: FrameDetail | undefined;
let latestPhoto: { filename: string; overview: Overview } | undefined;
let framesRequest: AbortController | undefined;
let frameRequest: AbortController | undefined;

const render = (): void => renderPanel(panel, state, { onLook: setLook, onSelect: selectFrame });

/** Put the chosen photo on the map, or take it off, according to the scene button. */
async function applyScene(): Promise<void> {
  const version = ++sceneVersion;
  if (!sceneOn) {
    mosaic.setLook(null);
    mosaic.setChosen(null);
    fittedFor = null;
    clearDrape(map);
    map.easeTo({ bearing: 0 });
    return;
  }
  const wanted = state.frames[state.selected]?.filename;
  if (!wanted || latestDetail?.filename !== wanted || latestPhoto?.filename !== wanted) return; // the other half is still on its way
  const detailNow = latestDetail, photoNow = latestPhoto, frameNow = state.frames[state.selected]!;
  const camera = createCamera(detailNow.eo, detailNow.sensor);
  const flatZ = meanGroundHeight(detailNow.footprint3089);
  // The ground under the photo: flat at its mean height, or (with `?terrain=on`) its own terrain patch.
  const terrain = !useTerrain ? null : await fetchTerrain(frameNow.url).catch((error: unknown) => {
    console.error('no terrain for this photo, using flat ground', error);
    return null;
  });
  if (sceneVersion !== version || latestDetail !== detailNow || latestPhoto !== photoNow) return; // the choice changed while it loaded
  const heightAt = groundHeight(terrain, flatZ);
  const footprint = detailNow.footprintLonLat.coordinates[0]!.slice(0, 4) as [number, number][];
  const whole = wholePhotoOnGround(footprint, camera, heightAt, photoNow.overview.canvas);
  await showDrape(map, whole.canvas, whole.corners, photoShown);

  // The scene proper: the photos the view needs, blended, in the direction being looked, over the chosen photo's preview.
  const look = state.look === 'down' ? null : state.look;
  mosaic.setChosen(sceneFrameOf(detailNow, frameNow));
  mosaic.setLook(look);
  mosaic.setVisible(photoShown);

  // The map is turned to the exact direction of the button, whichever photos are in view. It is fitted to the chosen
  // photo the first time, or when another photo is chosen; when only the direction changed it keeps its place.
  const bearing = LOOK_AZIMUTH[look ?? 'north'];
  if (fittedFor !== wanted) {
    fittedFor = wanted;
    if (keepView) {
      keepView = false;
      map.easeTo({ bearing, duration: 800 });
    } else {
      const lons = footprint.map((c) => c[0]);
      const lats = footprint.map((c) => c[1]);
      map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { bearing, padding: 40, duration: 800 });
    }
  }
}

/** A photo as the mosaic layer wants it: what the list and the frame's detail know, in the API's scene shape. */
function sceneFrameOf(detail: FrameDetail, frame: FramePick): SceneFrame {
  return {
    filename: detail.filename, url: frame.url, camera: detail.camera, lookAzimuth: detail.lookAzimuth, isReflight: frame.isReflight,
    flownUtc: frame.flownUtc, wins: 0, eo: detail.eo, sensor: detail.sensor, footprint3089: detail.footprint3089,
  };
}

/** The direction the aircraft flew when it took a frame, as a true bearing, or null if it can't be worked out. */
function trueFlightHeading(detail: FrameDetail): number | null {
  const grid = flightHeading(detail.camera, detail.lookAzimuth, detail.trackHeading);
  return grid === null ? null : gridBearingToTrue(detail.eo.x, detail.eo.y, grid);
}

/** Show the frame at `state.selected`: its photo, and its footprint on the map. A newer choice cancels an older one. */
async function showSelected(): Promise<void> {
  frameRequest?.abort();
  const frame = state.frames[state.selected];
  if (!frame) {
    showFootprint(map, null);
    photo.hide();
    clearDrape(map);
    return;
  }
  photo.show(frame, describeFrame(frame, state.look, state.frames.some((f) => f.azOk)));
  const request = (frameRequest = new AbortController());
  try {
    latestDetail = await getFrame(frame.filename, request.signal);
    showFootprint(map, latestDetail, trueFlightHeading(latestDetail));
    void applyScene();
  } catch (error) {
    if (request.signal.aborted) return;
    console.error(error);
    showFootprint(map, null);
  }
}

/** The clicked point on the ground: grid feet and the height there, from a plane through the top photo's footprint (its terrain patch with `?terrain=on`). */
async function groundAtPoint(signal: AbortSignal): Promise<{ x: number; y: number; z: number } | null> {
  const point = state.point, top = state.frames[0];
  if (!point || !top) return null;
  const [x, y] = lonLatToGrid(point.lng, point.lat);
  const [detail, terrain] = await Promise.all([getFrame(top.filename, signal), useTerrain ? fetchTerrain(top.url, signal).catch(() => null) : null]);
  return { x, y, z: terrain?.heightAt(x, y) ?? planeHeightAt(detail.footprint3089, x, y) };
}

/** A small picture of the whole photo, for when the point cannot be found in it. */
async function wholePhotoThumb(url: string, ratio: number, signal: AbortSignal): Promise<HTMLCanvasElement> {
  const overview = await loadOverview(url, {
    boxWidth: THUMB_WIDTH, boxHeight: THUMB_HEIGHT, pixelRatio: ratio, maxBytes: 600 * 1024, firstFetch: 32 * 1024, signal,
  });
  // The overview can be 1287 px wide (5 MB decoded); keep only a copy at the size it is shown.
  return shrink(overview.canvas, THUMB_WIDTH * ratio, THUMB_HEIGHT * ratio);
}

/**
 * Make a small picture for each listed photo that has none, best first and two at a time, and put each in its
 * row as it arrives. It shows the ground around the point that was clicked, with a ring on the point: only the
 * few tiles under that part of the photo are read (tens of kilobytes). If the point cannot be found in a photo
 * it shows the whole photo instead, and if that fails the row keeps an empty box.
 */
async function loadThumbs(): Promise<void> {
  thumbRequest?.abort();
  const request = (thumbRequest = new AbortController());
  const todo = state.frames.filter((frame) => !thumbs.get(thumbKey(frame.filename)));
  if (todo.length === 0) return;
  const ratio = Math.max(1, window.devicePixelRatio || 1);
  const ground = await groundAtPoint(request.signal).catch((error: unknown) => {
    if (!request.signal.aborted) console.error('no ground height for the thumbnails, showing whole photos', error);
    return null;
  });
  if (request.signal.aborted) return;
  const worker = async (): Promise<void> => {
    for (let frame = todo.shift(); frame; frame = todo.shift()) {
      try {
        let canvas: HTMLCanvasElement | null = null;
        if (ground) {
          try {
            const detail = await getFrame(frame.filename, request.signal);
            const made = await cropThumbnail({
              url: frame.url, camera: createCamera(detail.eo, detail.sensor), point: ground,
              width: THUMB_WIDTH, height: THUMB_HEIGHT, pixelRatio: ratio, signal: request.signal,
            });
            canvas = made && made.canvas;
            if (made) thumbTileBytes += made.bytes;
          } catch (error) {
            if (request.signal.aborted) return;
            console.error('no clipped thumbnail, showing the whole photo', error);
          }
        }
        canvas ??= await wholePhotoThumb(frame.url, ratio, request.signal);
        canvas.className = 'thumb-canvas';
        canvas.setAttribute('aria-hidden', 'true'); // the row's text already says what the photo is
        thumbs.set(thumbKey(frame.filename), canvas);
        setThumb(panel, frame.filename, canvas);
      } catch (error) {
        if (request.signal.aborted) return;
        console.error(error);
      }
    }
  };
  await Promise.all([worker(), worker()]);
}

/** Ask the API which photos cover the point, for the current direction. */
async function lookUp(): Promise<void> {
  if (!state.point) return;
  framesRequest?.abort();
  thumbRequest?.abort();
  const request = (framesRequest = new AbortController());
  state.status = 'loading';
  render();
  try {
    const { frames } = await getFrames(state.point.lng, state.point.lat, state.look, request.signal);
    state.frames = frames;
    state.selected = 0;
    state.status = 'ready';
  } catch (error) {
    if (request.signal.aborted) return; // a newer lookup replaced this one
    console.error(error);
    state.frames = [];
    state.status = 'error';
  }
  render();
  void showSelected();
  void loadThumbs();
}

function setLook(look: Look): void {
  if (look === state.look) return;
  state.look = look;
  if (sceneOn) {
    // In a scene you have been panning, so the direction is about what is in the middle of the map, not the old click.
    const centre = map.getCenter();
    state.point = { lng: centre.lng, lat: centre.lat };
    marker ??= new Marker({ color: '#e53935' });
    marker.setLngLat([centre.lng, centre.lat]).addTo(map);
    keepView = true;
  }
  void lookUp();
}

function selectFrame(index: number): void {
  state.selected = index;
  render();
  void showSelected();
}

map.on('click', (event) => {
  const { lng, lat } = event.lngLat;
  marker ??= new Marker({ color: '#e53935' });
  marker.setLngLat([lng, lat]).addTo(map);
  state.point = { lng, lat };
  if (sceneOn) keepView = true; // clicking in a scene picks a place; it does not move the map
  void lookUp();
});

render();
