import type { GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { FrameDetail } from './api.ts';

const SOURCE = 'frame';
const COLOR = '#e53935';
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
  map.addLayer({
    id: 'frame-camera', type: 'circle', source: SOURCE, filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': 6, 'circle-color': COLOR, 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 },
  });
}

/** Show a frame's footprint and camera position, or clear them when given null. */
export function showFootprint(map: MapLibreMap, frame: FrameDetail | null): void {
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
      { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [frame.eo.lon, frame.eo.lat] } },
    ],
  });
}
