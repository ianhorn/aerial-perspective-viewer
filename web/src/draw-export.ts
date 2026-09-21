// Turning the drawing into files. GeoJSON here; GeoPackage and GeoParquet are in their own files. No DOM.

import { geometryOf, type Geometry } from './draw-geometry.ts';
import type { DrawFeature } from './draw-model.ts';

export interface GeoJsonFeature {
  type: 'Feature';
  id: string;
  geometry: Geometry;
  properties: { id: string; kind: string; label: string; notes: string; color: string; radius_m: number | null; created: string };
}
export interface GeoJsonCollection { type: 'FeatureCollection'; features: GeoJsonFeature[] }

/**
 * The drawing as GeoJSON (RFC 7946: WGS84, longitude then latitude). A circle is a ring of 64 points and carries its radius in
 * `radius_m`; a rectangle is a polygon; text is a point whose `label` is the text, and `kind` tells them from plain points.
 */
export function toGeoJson(features: readonly DrawFeature[]): GeoJsonCollection {
  return {
    type: 'FeatureCollection',
    features: features.map((f) => ({
      type: 'Feature',
      id: f.id,
      geometry: geometryOf(f),
      properties: { id: f.id, kind: f.kind, label: f.properties.label, notes: f.properties.notes, color: f.properties.color, radius_m: f.kind === 'circle' ? f.radiusM! : null, created: f.createdAt },
    })),
  };
}

/** A file name for an export: the date and time make it different each time, and there is nothing in it a file system dislikes. */
export function exportName(extension: string, when: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}-${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
  return `drawing-${stamp}.${extension}`;
}
