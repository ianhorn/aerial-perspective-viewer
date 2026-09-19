import { AttributionControl, Map as MapLibreMap, Marker, NavigationControl, ScaleControl, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { getFrame, getFrames, type FrameDetail, type Look } from './api.ts';
import { createCamera } from './camera.ts';
import { loadOverview, type Overview } from './cog.ts';
import { BASEMAP, KENTUCKY_BOUNDS, MAX_BOUNDS, ORTHO_CLOSE } from './config.ts';
import { describeFrame } from './describe.ts';
import { clearDrape, setDrapeVisible, showDrape } from './drape.ts';
import { initFootprint, showFootprint } from './footprint.ts';
import { LevelControl } from './level-control.ts';
import { LruCache } from './lru.ts';
import { type PanelState, renderPanel, setThumb } from './panel.ts';
import { shrink } from './thumb.ts';
import { warmUp } from './warm.ts';
import { createPhotoPane } from './photo.ts';
import { flightHeading, gridBearingToTrue, meanGroundHeight, photoCorners, upBearing } from './scene.ts';
import { SceneControl } from './scene-control.ts';

// MapLibre 6 finds its worker next to its own script. Vite pre-bundles (dev) or bundles (build) that
// script, so the guess points at a file that does not exist and every source that needs the worker,
// GeoJSON included, silently never loads. Have Vite build the worker and say where it is.
setWorkerUrl(workerUrl);

declare global {
  interface Window { __map?: MapLibreMap }
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
if (import.meta.env.DEV || import.meta.env.VITE_EXPOSE_MAP) window.__map = map;

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
let thumbRequest: AbortController | undefined;
const state: PanelState = { point: null, look: 'north', status: 'idle', frames: [], selected: 0, thumbs };
let marker: Marker | undefined;
// The scene: the chosen photo draped on the map, turned so it looks up. It needs the frame's detail (for the
// camera) and the decoded photo, which arrive separately, so each is remembered with the name it belongs to.
let sceneOn = false;
let photoShown = true; // the draped photo can be switched off to see the map underneath; the scene stays on
let latestDetail: FrameDetail | undefined;
let latestPhoto: { filename: string; overview: Overview } | undefined;
let framesRequest: AbortController | undefined;
let frameRequest: AbortController | undefined;

const render = (): void => renderPanel(panel, state, { onLook: setLook, onSelect: selectFrame });

/** Put the chosen photo on the map, or take it off, according to the scene button. */
async function applyScene(): Promise<void> {
  if (!sceneOn) {
    clearDrape(map);
    map.easeTo({ bearing: 0 });
    return;
  }
  const wanted = state.frames[state.selected]?.filename;
  if (!wanted || latestDetail?.filename !== wanted || latestPhoto?.filename !== wanted) return; // the other half is still on its way
  const camera = createCamera(latestDetail.eo, latestDetail.sensor);
  const z = meanGroundHeight(latestDetail.footprint3089);
  const corners = photoCorners(camera, z);
  const bearing = upBearing(camera, z);
  if (!corners || bearing === null) return;
  await showDrape(map, latestPhoto.overview.canvas, corners, photoShown);
  const lons = corners.map((c) => c[0]);
  const lats = corners.map((c) => c[1]);
  map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { bearing, padding: 40, duration: 800 });
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

/**
 * Fetch a small picture for each listed photo that has none, best first and two at a time, and put each in
 * its row as it arrives. The smallest overview of a photo sits in the first bytes of the file, so this costs
 * from about 60 KB to 550 KB a photo (a small first read for the header, then only the smallest overview). A photo that fails just keeps an empty box.
 */
async function loadThumbs(): Promise<void> {
  thumbRequest?.abort();
  const request = (thumbRequest = new AbortController());
  const todo = state.frames.filter((frame) => !thumbs.get(frame.filename));
  const worker = async (): Promise<void> => {
    for (let frame = todo.shift(); frame; frame = todo.shift()) {
      try {
        const ratio = Math.max(1, window.devicePixelRatio || 1);
        const overview = await loadOverview(frame.url, {
          boxWidth: THUMB_WIDTH, boxHeight: THUMB_HEIGHT, pixelRatio: ratio, maxBytes: 600 * 1024, firstFetch: 32 * 1024, signal: request.signal,
        });
        // The overview can be 1287 px wide (5 MB decoded); keep only a copy at the size it is shown.
        const canvas = shrink(overview.canvas, THUMB_WIDTH * ratio, THUMB_HEIGHT * ratio);
        canvas.className = 'thumb-canvas';
        canvas.setAttribute('aria-hidden', 'true'); // the row's text already says what the photo is
        thumbs.set(frame.filename, canvas);
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
  void lookUp();
});

render();
