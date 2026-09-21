// The drawing as a GeoPackage (OGC 12-128r18, version 1.3.1): one SQLite file that QGIS, ArcGIS and GDAL open. There is a layer
// (feature table) for each kind of geometry that is present: `points` (points and text), `lines`, and `polygons` (polygons,
// rectangles and circles), since a table holds one geometry type. The SQLite engine is sql.js (WebAssembly), handed in by the
// caller so it is loaded only when someone exports. No DOM here.

import type { SqlJsStatic } from 'sql.js';
import { COLUMNS, type Prepared } from './draw-export.ts';
import { CRS, type ExportCrs } from './draw-crs.ts';
import { toWkb, type Position, type WkbGeometry } from './draw-wkb.ts';

/** "GPKG" as a 32-bit number: the file's application id. */
const APPLICATION_ID = 0x47504b47;
/** Version 1.3.1. */
const USER_VERSION = 10301;

const LAYERS = [
  { table: 'points', type: 'Point', name: 'POINT' },
  { table: 'lines', type: 'LineString', name: 'LINESTRING' },
  { table: 'polygons', type: 'Polygon', name: 'POLYGON' },
] as const;

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

function positionsOf(g: WkbGeometry): Position[] {
  switch (g.type) {
    case 'Point': return [g.coordinates];
    case 'LineString': return [...g.coordinates];
    case 'Polygon': return g.coordinates.flat();
  }
}

/** The standard header of a geometry in a GeoPackage (binary version 0, little-endian, with an XY envelope), then the WKB. */
export function geometryBlob(g: WkbGeometry, srsId: number): { blob: Uint8Array; bounds: [number, number, number, number] } {
  const points = positionsOf(g);
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const bounds: [number, number, number, number] = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const wkb = toWkb(g);
  const blob = new Uint8Array(8 + 32 + wkb.length);
  const view = new DataView(blob.buffer);
  blob[0] = 0x47; blob[1] = 0x50; // "GP"
  blob[2] = 0; // version 0
  blob[3] = 0b0000_0011; // little-endian, envelope of XY (indicator 1), not empty, standard geometry
  view.setInt32(4, srsId, true);
  view.setFloat64(8, bounds[0], true); // min x
  view.setFloat64(16, bounds[2], true); // max x
  view.setFloat64(24, bounds[1], true); // min y
  view.setFloat64(32, bounds[3], true); // max y
  blob.set(wkb, 40);
  return { blob, bounds };
}

export function buildGeoPackage(features: readonly Prepared[], crs: ExportCrs, SQL: SqlJsStatic, changed: Date = new Date()): Uint8Array {
  const srs = CRS[crs];
  const db = new SQL.Database();
  try {
    db.run(`PRAGMA application_id = ${APPLICATION_ID}`);
    db.run(`PRAGMA user_version = ${USER_VERSION}`);
    db.run(`CREATE TABLE gpkg_spatial_ref_sys (
      srs_name TEXT NOT NULL, srs_id INTEGER NOT NULL PRIMARY KEY, organization TEXT NOT NULL,
      organization_coordsys_id INTEGER NOT NULL, definition TEXT NOT NULL, description TEXT)`);
    db.run(`CREATE TABLE gpkg_contents (
      table_name TEXT NOT NULL PRIMARY KEY, data_type TEXT NOT NULL, identifier TEXT UNIQUE, description TEXT DEFAULT '',
      last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      min_x DOUBLE, min_y DOUBLE, max_x DOUBLE, max_y DOUBLE, srs_id INTEGER,
      CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys(srs_id))`);
    db.run(`CREATE TABLE gpkg_geometry_columns (
      table_name TEXT NOT NULL, column_name TEXT NOT NULL, geometry_type_name TEXT NOT NULL, srs_id INTEGER NOT NULL, z TINYINT NOT NULL, m TINYINT NOT NULL,
      CONSTRAINT pk_geom_cols PRIMARY KEY (table_name, column_name), CONSTRAINT uk_gc_table_name UNIQUE (table_name),
      CONSTRAINT fk_gc_tn FOREIGN KEY (table_name) REFERENCES gpkg_contents(table_name),
      CONSTRAINT fk_gc_srs FOREIGN KEY (srs_id) REFERENCES gpkg_spatial_ref_sys (srs_id))`);

    // The three systems the standard requires to be there, and the one the drawing is in.
    const addSrs = db.prepare('INSERT INTO gpkg_spatial_ref_sys VALUES (?, ?, ?, ?, ?, ?)');
    addSrs.run(['Undefined Cartesian SRS', -1, 'NONE', -1, 'undefined', 'undefined Cartesian coordinate reference system']);
    addSrs.run(['Undefined geographic SRS', 0, 'NONE', 0, 'undefined', 'undefined geographic coordinate reference system']);
    addSrs.run([CRS.wgs84.name, CRS.wgs84.code, 'EPSG', CRS.wgs84.code, CRS.wgs84.wkt, 'longitude/latitude coordinates in decimal degrees on the WGS 84 spheroid']);
    if (crs !== 'wgs84') addSrs.run([srs.name, srs.code, 'EPSG', srs.code, srs.wkt, 'Kentucky Single Zone, US survey feet']);
    addSrs.free();

    const columns = COLUMNS.map((c) => `${quote(c.name)} ${c.type === 'real' ? 'REAL' : 'TEXT'}`).join(', ');
    for (const layer of LAYERS) {
      const rows = features.filter((f) => f.geometry.type === layer.type);
      if (rows.length === 0) continue;
      db.run(`CREATE TABLE ${quote(layer.table)} (fid INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, geom ${layer.name}, ${columns})`);
      const insert = db.prepare(`INSERT INTO ${quote(layer.table)} (geom, ${COLUMNS.map((c) => quote(c.name)).join(', ')}) VALUES (${['?', ...COLUMNS.map(() => '?')].join(', ')})`);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const row of rows) {
        const { blob, bounds } = geometryBlob(row.geometry as WkbGeometry, srs.code);
        minX = Math.min(minX, bounds[0]); minY = Math.min(minY, bounds[1]); maxX = Math.max(maxX, bounds[2]); maxY = Math.max(maxY, bounds[3]);
        insert.run([blob, ...COLUMNS.map((c) => row.attributes[c.name])]);
      }
      insert.free();
      db.run('INSERT INTO gpkg_contents (table_name, data_type, identifier, description, last_change, min_x, min_y, max_x, max_y, srs_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [layer.table, 'features', layer.table, '', changed.toISOString(), minX, minY, maxX, maxY, srs.code]);
      db.run('INSERT INTO gpkg_geometry_columns VALUES (?, ?, ?, ?, ?, ?)', [layer.table, 'geom', layer.name, srs.code, 0, 0]);
    }
    return db.export();
  } finally {
    db.close();
  }
}
