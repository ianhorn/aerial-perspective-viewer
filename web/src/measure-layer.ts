// A measurement on the map, in a scene: a GeoJSON source with a fill, a line and a circle layer, and the labels as small
// elements on the map (the map style has no glyphs, so it cannot draw text itself). It takes an `Overlay` whose points
// are already in longitude and latitude (x = longitude, y = latitude).

import { type GeoJSONSource, type Map as MapLibreMap, Marker } from 'maplibre-gl';
import type { Overlay } from './measure-shape.ts';

const SOURCE = 'measure';
const AMBER = '#ffb300';
const EMPTY = { type: 'FeatureCollection', features: [] } as const;
// The live height preview's lines: the vertical to compare with (white), and the line to the cursor (amber, green when plumb).
const TONE_COLOUR = ['match', ['get', 'tone'], 'ok', '#66bb6a', 'plumb', '#ffffff', AMBER] as unknown as string;

export class MeasureLayer {
  private readonly map: MapLibreMap;
  private markers: Marker[] = [];

  constructor(map: MapLibreMap) {
    this.map = map;
  }

  /** Add the layers, above everything else. Call once the style has loaded. */
  init(): void {
    const { map } = this;
    map.addSource(SOURCE, { type: 'geojson', data: EMPTY });
    map.addLayer({ id: 'measure-fill', type: 'fill', source: SOURCE, filter: ['==', ['get', 'role'], 'fill'], paint: { 'fill-color': AMBER, 'fill-opacity': 0.22 } });
    // A dark line under the amber one, so it reads on any picture.
    map.addLayer({ id: 'measure-edge', type: 'line', source: SOURCE, filter: ['==', ['geometry-type'], 'LineString'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#000', 'line-opacity': 0.65, 'line-width': 5 } });
    map.addLayer({
      id: 'measure-line', type: 'line', source: SOURCE, filter: ['all', ['==', ['geometry-type'], 'LineString'], ['!=', ['get', 'dashed'], true]],
      layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': TONE_COLOUR, 'line-width': 2.5 },
    });
    map.addLayer({
      id: 'measure-line-dashed', type: 'line', source: SOURCE, filter: ['all', ['==', ['geometry-type'], 'LineString'], ['==', ['get', 'dashed'], true]],
      layout: { 'line-join': 'round' }, paint: { 'line-color': TONE_COLOUR, 'line-width': 2.5, 'line-dasharray': [2.5, 2] },
    });
    map.addLayer({
      id: 'measure-dot', type: 'circle', source: SOURCE, filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': ['match', ['get', 'kind'], 'first', 7, 'top', 7.5, 5.5],
        'circle-color': ['match', ['get', 'kind'], 'first', '#fff', AMBER],
        'circle-stroke-color': ['match', ['get', 'kind'], 'first', AMBER, '#fff'],
        'circle-stroke-width': 2.5,
      },
    });
  }

  /** Show a measurement, or take it off (an empty overlay). */
  update(overlay: Overlay): void {
    const source = this.map.getSource<GeoJSONSource>(SOURCE);
    if (!source) return;
    const at = (p: { x: number; y: number }): [number, number] => [p.x, p.y];
    const features: unknown[] = [];
    if (overlay.fill && overlay.fill.length >= 3) {
      features.push({ type: 'Feature', properties: { role: 'fill' }, geometry: { type: 'Polygon', coordinates: [[...overlay.fill.map(at), at(overlay.fill[0]!)]] } });
    }
    for (const line of overlay.lines) {
      features.push({ type: 'Feature', properties: { role: 'line', dashed: line.dashed, tone: line.tone ?? 'plain' }, geometry: { type: 'LineString', coordinates: line.points.map(at) } });
    }
    for (const dot of overlay.dots) {
      features.push({ type: 'Feature', properties: { role: 'dot', kind: dot.kind }, geometry: { type: 'Point', coordinates: at(dot.at) } });
    }
    source.setData({ type: 'FeatureCollection', features } as Parameters<GeoJSONSource['setData']>[0]);

    for (const marker of this.markers) marker.remove();
    this.markers = overlay.labels.map((label) => {
      const element = document.createElement('div');
      element.className = 'measure-label';
      element.textContent = label.text;
      return new Marker({ element, anchor: 'bottom', offset: [0, -8] }).setLngLat(at(label.at)).addTo(this.map);
    });
  }
}
