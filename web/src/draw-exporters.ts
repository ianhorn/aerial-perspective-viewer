// The export formats the drawing card offers. The two binary formats load their libraries (a SQLite engine in WebAssembly, and a
// Parquet writer) only when someone exports, so the page does not carry them until then.

import sqlWasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url';
import { CRS } from './draw-crs.ts';
import { prepare, toGeoJson } from './draw-export.ts';
import type { Exporter } from './draw-ui.ts';

let sql: Promise<import('sql.js').SqlJsStatic> | undefined;
/** The SQLite engine, started once. */
function loadSql(): Promise<import('sql.js').SqlJsStatic> {
  sql ??= import('sql.js/dist/sql-wasm-browser.js').then(({ default: init }) => init({ locateFile: () => sqlWasmUrl }));
  // If it could not be started (offline, or the file is blocked), try again next time rather than remembering the failure.
  sql.catch(() => { sql = undefined; });
  return sql;
}

export const EXPORTERS: readonly Exporter[] = [
  {
    id: 'geojson', label: 'GeoJSON', hint: 'A GeoJSON file (always WGS 84 longitude and latitude, as the standard says)', extension: 'geojson', mime: 'application/geo+json',
    build: (features) => JSON.stringify(toGeoJson(features), null, 2),
  },
  {
    id: 'gpkg', label: 'GeoPackage', hint: 'A GeoPackage (.gpkg): a layer each for points, lines and polygons', extension: 'gpkg', mime: 'application/geopackage+sqlite3',
    build: async (features, crs) => {
      const [{ buildGeoPackage }, SQL] = await Promise.all([import('./draw-gpkg.ts'), loadSql()]);
      return new Uint8Array(buildGeoPackage(prepare(features, crs), crs, SQL)); // a copy, whose buffer is a plain ArrayBuffer
    },
  },
  {
    id: 'parquet', label: 'GeoParquet', hint: 'A GeoParquet file (.parquet), one table for everything', extension: 'parquet', mime: 'application/vnd.apache.parquet',
    build: async (features, crs) => {
      const { buildGeoParquet } = await import('./draw-parquet.ts');
      return buildGeoParquet(prepare(features, crs), crs);
    },
  },
];

/** The coordinate systems to choose from, for the card. */
export const CRS_CHOICES = [
  { id: 'wgs84', label: CRS.wgs84.label },
  { id: 'stateplane', label: CRS.stateplane.label },
] as const;
