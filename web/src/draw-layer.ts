// The drawing on the map: a GeoJSON source with a fill, a casing and a line layer and a circle layer for points, a second source
// for what is being drawn and the handles of the selected shape, and the labels as small elements on the map (the map style has no
// glyphs, so it cannot draw text itself). It only draws what it is given.

import { type GeoJSONSource, type Map as MapLibreMap, Marker } from 'maplibre-gl';
import { geometryOf, labelPoint } from './draw-geometry.ts';
import type { Handle } from './draw-hit.ts';
import type { DrawFeature } from './draw-model.ts';

const SOURCE = 'draw';
const EDIT = 'draw-edit';
const AMBER = '#ffb300';
const EMPTY = { type: 'FeatureCollection', features: [] } as const;

export interface DrawScene {
  features: readonly DrawFeature[];
  selectedId: string | null;
  /** The shape being drawn, as a feature, drawn dashed. */
  preview: DrawFeature | null;
  /** The fixed points of the shape being drawn. */
  draftPoints: readonly [number, number][];
  handles: readonly Handle[];
}

/** The colour to put round writing so it reads on any picture: white round dark writing, dark round light. */
export function outlineFor(colour: string): string {
  const n = parseInt(colour.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b < 110 ? '#ffffff' : '#000000';
}

export class DrawLayer {
  private readonly map: MapLibreMap;
  private readonly markers = new Map<string, { marker: Marker; element: HTMLElement; key: string }>();

  constructor(map: MapLibreMap) {
    this.map = map;
  }

  /** Add the layers. Call once the style has loaded. */
  init(): void {
    const { map } = this;
    map.addSource(SOURCE, { type: 'geojson', data: EMPTY });
    map.addSource(EDIT, { type: 'geojson', data: EMPTY });
    map.addLayer({ id: 'draw-fill', type: 'fill', source: SOURCE, filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.25 } });
    // A dark (or, round a selected shape, white) line under the coloured one, so it reads on any picture.
    map.addLayer({
      id: 'draw-casing', type: 'line', source: SOURCE, filter: ['!=', ['geometry-type'], 'Point'], layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['case', ['get', 'selected'], '#ffffff', '#000000'], 'line-opacity': ['case', ['get', 'selected'], 0.95, 0.55], 'line-width': ['case', ['get', 'selected'], 7.5, 5] },
    });
    map.addLayer({ id: 'draw-line', type: 'line', source: SOURCE, filter: ['!=', ['geometry-type'], 'Point'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 3 } });
    map.addLayer({
      id: 'draw-point', type: 'circle', source: SOURCE, filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': ['case', ['==', ['get', 'kind'], 'text'], 3.5, 6.5],
        'circle-color': ['get', 'color'],
        'circle-stroke-color': ['case', ['get', 'selected'], AMBER, '#ffffff'],
        'circle-stroke-width': ['case', ['get', 'selected'], 3.5, 2],
      },
    });
    // What is being drawn: dashed, in amber.
    map.addLayer({ id: 'draw-draft-fill', type: 'fill', source: EDIT, filter: ['all', ['==', ['geometry-type'], 'Polygon'], ['==', ['get', 'role'], 'preview']], paint: { 'fill-color': AMBER, 'fill-opacity': 0.18 } });
    map.addLayer({ id: 'draw-draft-line', type: 'line', source: EDIT, filter: ['all', ['!=', ['geometry-type'], 'Point'], ['==', ['get', 'role'], 'preview']], layout: { 'line-join': 'round' }, paint: { 'line-color': AMBER, 'line-width': 2.5, 'line-dasharray': [2.5, 2] } });
    map.addLayer({
      id: 'draw-draft-dot', type: 'circle', source: EDIT, filter: ['==', ['get', 'role'], 'draft-point'],
      paint: { 'circle-radius': 4.5, 'circle-color': '#ffffff', 'circle-stroke-color': AMBER, 'circle-stroke-width': 2 },
    });
    map.addLayer({
      id: 'draw-handle', type: 'circle', source: EDIT, filter: ['==', ['get', 'role'], 'handle'],
      paint: { 'circle-radius': 6, 'circle-color': '#ffffff', 'circle-stroke-color': '#1b1b1b', 'circle-stroke-width': 2 },
    });
  }

  update(scene: DrawScene): void {
    const source = this.map.getSource<GeoJSONSource>(SOURCE);
    const edit = this.map.getSource<GeoJSONSource>(EDIT);
    if (!source || !edit) return;
    source.setData({
      type: 'FeatureCollection',
      features: scene.features.map((f) => ({
        type: 'Feature', properties: { id: f.id, kind: f.kind, color: f.properties.color, selected: f.id === scene.selectedId }, geometry: geometryOf(f),
      })),
    } as Parameters<GeoJSONSource['setData']>[0]);

    const editing: unknown[] = [];
    if (scene.preview) editing.push({ type: 'Feature', properties: { role: 'preview' }, geometry: geometryOf(scene.preview) });
    for (const at of scene.draftPoints) editing.push({ type: 'Feature', properties: { role: 'draft-point' }, geometry: { type: 'Point', coordinates: at } });
    for (const h of scene.handles) editing.push({ type: 'Feature', properties: { role: 'handle', index: h.index }, geometry: { type: 'Point', coordinates: h.at } });
    edit.setData({ type: 'FeatureCollection', features: editing } as Parameters<GeoJSONSource['setData']>[0]);

    this.updateLabels(scene.features);
  }

  /** The labels: one small element for each feature that has a label, kept from one update to the next and only changed if it has changed. */
  private updateLabels(features: readonly DrawFeature[]): void {
    const seen = new Set<string>();
    for (const f of features) {
      if (f.properties.label.trim() === '') continue;
      seen.add(f.id);
      const at = labelPoint(f);
      const key = `${f.properties.label}|${f.properties.color}|${f.kind}`;
      const have = this.markers.get(f.id);
      if (have) {
        if (have.key !== key) this.style(have.element, f);
        have.key = key;
        have.marker.setLngLat(at);
        continue;
      }
      const element = document.createElement('div');
      this.style(element, f);
      // A point's label sits above it; the label of anything else is centred on its place.
      const marker = new Marker({ element, anchor: f.kind === 'point' ? 'bottom' : 'center', offset: f.kind === 'point' ? [0, -10] : [0, 0] }).setLngLat(at).addTo(this.map);
      this.markers.set(f.id, { marker, element, key });
    }
    for (const [id, m] of this.markers) {
      if (!seen.has(id)) { m.marker.remove(); this.markers.delete(id); }
    }
  }

  private style(element: HTMLElement, f: DrawFeature): void {
    element.className = f.kind === 'text' ? 'draw-label draw-text' : 'draw-label';
    element.textContent = f.properties.label;
    element.dataset.feature = f.id;
    element.style.color = f.properties.color;
    element.style.setProperty('--outline', outlineFor(f.properties.color));
  }
}
