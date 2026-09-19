import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { FrameDetail } from './api.ts';
import { planeImage } from './plane.ts';

const SOURCE = 'frame';
const COLOR = '#e53935';
const PLANE = 'camera-plane';
const EMPTY = { type: 'FeatureCollection', features: [] } as const;

/** Add the layers that show the chosen photo's ground footprint and where the camera was. Call once the style has loaded. */
export function initFootprint(map: MapLibreMap): void {
  map.addSource(SOURCE, { type: 'geojson', data: EMPTY });
  map.addLayer({
    id: 'frame-fill', type: 'fill', source: SOURCE, filter: ['==', ['geometry-type'], 'Polygon'],
    paint: { 'fill-color': COLOR, 'fill-opacity': 0.14 },
  });
  map.addLayer({
    id: 'frame-outline', type: 'line', source: SOURCE, filter: ['==', ['geometry-type'], 'Polygon'],
    paint: { 'line-color': COLOR, 'line-width': 2.5 },
  });
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
