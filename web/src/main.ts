import { AttributionControl, Map as MapLibreMap, Marker, NavigationControl, ScaleControl, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { getFrame, getFrames, type Look } from './api.ts';
import { BASEMAP, KENTUCKY_BOUNDS, MAX_BOUNDS } from './config.ts';
import { describeFrame } from './describe.ts';
import { initFootprint, showFootprint } from './footprint.ts';
import { type PanelState, renderPanel } from './panel.ts';
import { createPhotoPane } from './photo.ts';

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
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#1b1f24' } },
      { id: 'basemap', type: 'raster', source: 'basemap' },
    ],
  },
  bounds: KENTUCKY_BOUNDS,
  fitBoundsOptions: { padding: 24 },
  maxBounds: MAX_BOUNDS,
  attributionControl: false,
});

map.addControl(new NavigationControl({ showCompass: true }), 'top-right');
map.addControl(new ScaleControl({ unit: 'imperial' }), 'bottom-left');
map.addControl(new AttributionControl({ compact: true }), 'bottom-right');
map.on('load', () => initFootprint(map));
// A test script can inspect the map in dev, or in a build made with VITE_EXPOSE_MAP=1. Off in normal builds.
if (import.meta.env.DEV || import.meta.env.VITE_EXPOSE_MAP) window.__map = map;

const panel = document.getElementById('panel')!;
// The pane changes the width of the map beside it, so tell the map when it appears or goes.
const photo = createPhotoPane(document.getElementById('photo')!, { onVisibilityChange: () => map.resize() });
const state: PanelState = { point: null, look: 'north', status: 'idle', frames: [], selected: 0 };
let marker: Marker | undefined;
let framesRequest: AbortController | undefined;
let frameRequest: AbortController | undefined;

const render = (): void => renderPanel(panel, state, { onLook: setLook, onSelect: selectFrame });

/** Show the frame at `state.selected`: its photo, and its footprint on the map. A newer choice cancels an older one. */
async function showSelected(): Promise<void> {
  frameRequest?.abort();
  const frame = state.frames[state.selected];
  if (!frame) {
    showFootprint(map, null);
    photo.hide();
    return;
  }
  photo.show(frame, describeFrame(frame, state.look, state.frames.some((f) => f.azOk)));
  const request = (frameRequest = new AbortController());
  try {
    showFootprint(map, await getFrame(frame.filename, request.signal));
  } catch (error) {
    if (request.signal.aborted) return;
    console.error(error);
    showFootprint(map, null);
  }
}

/** Ask the API which photos cover the point, for the current direction. */
async function lookUp(): Promise<void> {
  if (!state.point) return;
  framesRequest?.abort();
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
