import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { FrameDetail } from './api.ts';
import { planeImage } from './plane.ts';

const SOURCE = 'frame';
const COLOR = '#e53935';
const PLANE = 'camera-plane';
const PICK = 'photo-pick';
const HOVER = 'frame-hover';
const PICK_COLOR = '#1e88e5'; // blue, so it is not taken for the red pin or the footprint
const EMPTY = { type: 'FeatureCollection', features: [] } as const;

// The footprint is for finding your way at wide zoom. Up close it only tints and outlines the photo, so it fades
// out as you zoom in: the fill first, then the outline. Camera zooms (MapLibre's, one below the Bing/Google
// level): the fill goes from full at 14.5 (level 15.5) to nothing at 16 (level 17), the outline from full at
// 15.5 (level 16.5) to nothing at 17 (level 18). Once invisible the layers are not drawn at all.
const FILL_FADE = { from: 14.5, to: 16 } as const;
const OUTLINE_FADE = { from: 15.5, to: 17 } as const;
const FILL_OPACITY = 0.14;

/** Add the layers that show the chosen photo's ground footprint and where the camera was. Call once the style has loaded. */
export function initFootprint(map: MapLibreMap): void {
  map.addSource(SOURCE, { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'frame-fill', type: 'fill', source: SOURCE, filter: ['==', ['geometry-type'], 'Polygon'], maxzoom: FILL_FADE.to,
    paint: { 'fill-color': COLOR, 'fill-opacity': ['interpolate', ['linear'], ['zoom'], FILL_FADE.from, FILL_OPACITY, FILL_FADE.to, 0] },
  });
  map.addLayer({
    id: 'frame-outline', type: 'line', source: SOURCE, filter: ['==', ['geometry-type'], 'Polygon'], maxzoom: OUTLINE_FADE.to,
    paint: { 'line-color': COLOR, 'line-width': 2.5, 'line-opacity': ['interpolate', ['linear'], ['zoom'], OUTLINE_FADE.from, 1, OUTLINE_FADE.to, 0] },
  });
  // The footprint of the photo the pointer is over in the list: a dashed white outline (with a dark edge, so it reads on any
  // picture) and a faint tint. It does not fade out with zoom, since it is a brief preview, and it sits under the camera plane.
  map.addSource(HOVER, { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'frame-hover-fill', type: 'fill', source: HOVER, paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.12 } });
  map.addLayer({ id: 'frame-hover-edge', type: 'line', source: HOVER, layout: { 'line-join': 'round' }, paint: { 'line-color': '#000000', 'line-opacity': 0.55, 'line-width': 5 } });
  map.addLayer({ id: 'frame-hover-outline', type: 'line', source: HOVER, layout: { 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 2.5, 'line-dasharray': [2, 1.5] } });
  // Where the camera was. With a known heading it is a plane pointing the way the aircraft flew (turned with
  // the map, so it keeps pointing that way when the map is rotated); without one, a plain dot.
  map.addImage(PLANE, planeImage(80), { pixelRatio: 2 });
  map.addLayer({
    id: 'frame-camera', type: 'symbol', source: SOURCE, filter: ['all', ['==', ['geometry-type'], 'Point'], ['has', 'heading']],
    layout: {
      'icon-image': PLANE, 'icon-rotate': ['get', 'heading'], 'icon-rotation-alignment': 'map', 'icon-pitch-alignment': 'map',
      'icon-allow-overlap': true, 'icon-ignore-placement': true,
    },
  });
  map.addLayer({
    id: 'frame-camera-dot', type: 'circle', source: SOURCE, filter: ['all', ['==', ['geometry-type'], 'Point'], ['!', ['has', 'heading']]],
    paint: { 'circle-radius': 6, 'circle-color': COLOR, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 },
  });
  // The spot the user clicked in the photo pane, on the ground: a dot with a soft ring, above everything else.
  map.addSource(PICK, { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'photo-pick-halo', type: 'circle', source: PICK, paint: { 'circle-radius': 15, 'circle-color': PICK_COLOR, 'circle-opacity': 0.28 } });
  map.addLayer({
    id: 'photo-pick-dot', type: 'circle', source: PICK,
    paint: { 'circle-radius': 6.5, 'circle-color': PICK_COLOR, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 },
  });
}

/** Preview a photo's footprint while the pointer is over its card in the list, or take it off with null. */
export function showHover(map: MapLibreMap, frame: FrameDetail | null): void {
  const source = map.getSource<GeoJSONSource>(HOVER);
  if (!source) return;
  source.setData(frame ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: frame.footprintLonLat }] } : EMPTY);
}

/** Show the ground spot the user clicked in the photo pane, or take it off with null. */
export function showPick(map: MapLibreMap, at: [number, number] | null): void {
  const source = map.getSource<GeoJSONSource>(PICK);
  if (!source) return;
  source.setData(at ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: at } }] } : EMPTY);
}

/**
 * Show or hide the footprint's tint. In a scene the footprint is only an outline, so the photo under it stays clear.
 * The layer is hidden, not removed: the photo drape is placed just under it (drape.ts).
 */
export function setFootprintFill(map: MapLibreMap, shown: boolean): void {
  if (map.getLayer('frame-fill')) map.setLayoutProperty('frame-fill', 'visibility', shown ? 'visible' : 'none');
}

/**
 * Show a frame's footprint and camera position, or clear them when given null. `heading` is the direction the
 * aircraft was flying, as a true bearing in degrees; when it is null the camera is a dot.
 */
export function showFootprint(map: MapLibreMap, frame: FrameDetail | null, heading: number | null = null): void {
  const source = map.getSource<GeoJSONSource>(SOURCE);
  if (!source) return;
  if (!frame) {
    source.setData(EMPTY);
    return;
  }
  source.setData({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: frame.footprintLonLat },
      {
        type: 'Feature', properties: heading === null ? {} : { heading },
        geometry: { type: 'Point', coordinates: [frame.eo.lon, frame.eo.lat] },
      },
    ],
  });
}
