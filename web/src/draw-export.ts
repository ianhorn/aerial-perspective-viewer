// Turning the drawing into files. What all the formats share is here: the geometry in the chosen coordinate system, and the
// attributes each feature carries. GeoJSON is here too; GeoPackage and GeoParquet are in their own files. No DOM.

import type { ExportCrs } from './draw-crs.ts';
import { geometryOf, measuresOf, type Geometry } from './draw-geometry.ts';
import type { DrawFeature } from './draw-model.ts';
import { lonLatToGrid } from './lcc.ts';

/** What every feature carries, as a table row: the same columns in every format. Sizes are on the State Plane grid, in feet and square feet. */
export interface Attributes {
  id: string;
  kind: string;
  label: string;
  notes: string;
  color: string;
  /** A circle's radius in metres, as it was drawn (null for other shapes). */
  radius_m: number | null;
  /** A line's length (null for other shapes). */
  length_ft: number | null;
  /** The distance round a polygon, rectangle or circle. */
  perimeter_ft: number | null;
  area_sqft: number | null;
  created: string;
}

/** The columns in order, with the kind of value each holds: the table's schema in the formats that have one. */
export const COLUMNS: readonly { name: keyof Attributes; type: 'text' | 'real' }[] = [
  { name: 'id', type: 'text' }, { name: 'kind', type: 'text' }, { name: 'label', type: 'text' }, { name: 'notes', type: 'text' }, { name: 'color', type: 'text' },
  { name: 'radius_m', type: 'real' }, { name: 'length_ft', type: 'real' }, { name: 'perimeter_ft', type: 'real' }, { name: 'area_sqft', type: 'real' }, { name: 'created', type: 'text' },
];

export function attributesOf(f: DrawFeature): Attributes {
  const m = measuresOf(f);
  return {
    id: f.id, kind: f.kind, label: f.properties.label, notes: f.properties.notes, color: f.properties.color,
    radius_m: f.kind === 'circle' ? f.radiusM! : null,
    length_ft: m.lengthFt ?? null, perimeter_ft: m.perimeterFt ?? null, area_sqft: m.areaSqFt ?? null,
    created: f.createdAt,
  };
}

/** A feature ready to write: its geometry in the coordinate system asked for, and its attributes. */
export interface Prepared { id: string; geometry: Geometry; attributes: Attributes }

/** The geometry of a feature in a coordinate system. (A circle is a ring of 64 points made on the State Plane grid, so in WGS84 it is those points converted.) */
export function geometryIn(f: DrawFeature, crs: ExportCrs): Geometry {
  if (crs === 'wgs84') return geometryOf(f);
  const grid = (c: readonly [number, number]): [number, number] => lonLatToGrid(c[0], c[1]);
  const g = geometryOf(f);
  switch (g.type) {
    case 'Point': return { type: 'Point', coordinates: grid(g.coordinates) };
    case 'LineString': return { type: 'LineString', coordinates: g.coordinates.map(grid) };
    case 'Polygon': return { type: 'Polygon', coordinates: g.coordinates.map((ring) => ring.map(grid)) };
  }
}

export function prepare(features: readonly DrawFeature[], crs: ExportCrs): Prepared[] {
  return features.map((f) => ({ id: f.id, geometry: geometryIn(f, crs), attributes: attributesOf(f) }));
}

export interface GeoJsonFeature { type: 'Feature'; id: string; geometry: Geometry; properties: Attributes }
export interface GeoJsonCollection { type: 'FeatureCollection'; features: GeoJsonFeature[] }

/**
 * The drawing as GeoJSON (RFC 7946: WGS84, longitude then latitude; there is no other coordinate system in GeoJSON). A circle is a
 * ring of 64 points and carries its radius in `radius_m`; a rectangle is a polygon; text is a point whose `label` is the text, and
 * `kind` tells them from plain points.
 */
export function toGeoJson(features: readonly DrawFeature[]): GeoJsonCollection {
  return { type: 'FeatureCollection', features: features.map((f) => ({ type: 'Feature', id: f.id, geometry: geometryOf(f), properties: attributesOf(f) })) };
}

/** A file name for an export: the date and time make it different each time, and there is nothing in it a file system dislikes. */
export function exportName(extension: string, when: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}-${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
  return `drawing-${stamp}.${extension}`;
}
