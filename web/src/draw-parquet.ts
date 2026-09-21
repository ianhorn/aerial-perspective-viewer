// The drawing as GeoParquet 1.1: an Apache Parquet file with a `geometry` column of well-known binary and a `geo` entry in the file's
// metadata that says so and gives the coordinate system. It opens in GeoPandas, DuckDB (spatial), QGIS and GDAL. One table for the whole
// drawing (unlike a GeoPackage, a Parquet column may hold mixed geometry types). No DOM here.

import { parquetWriteBuffer } from 'hyparquet-writer';
import { CRS, type ExportCrs } from './draw-crs.ts';
import { COLUMNS, type Prepared } from './draw-export.ts';
import { toWkb, type Position, type WkbGeometry } from './draw-wkb.ts';

const positionsOf = (g: WkbGeometry): Position[] => (g.type === 'Point' ? [g.coordinates] : g.type === 'LineString' ? [...g.coordinates] : g.coordinates.flat());

/** The `geo` metadata: what GeoParquet readers look for to know which column is geometry and what it is in. */
export function geoMetadata(features: readonly Prepared[], crs: ExportCrs): object {
  const points = features.flatMap((f) => positionsOf(f.geometry as WkbGeometry));
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  const column: Record<string, unknown> = {
    encoding: 'WKB',
    geometry_types: [...new Set(features.map((f) => f.geometry.type))].sort(),
    ...(points.length > 0 ? { bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] } : {}),
  };
  // Without a `crs` a reader assumes OGC:CRS84 (longitude, latitude), which is what WGS84 here is.
  if (CRS[crs].projjson) column['crs'] = CRS[crs].projjson;
  return { version: '1.1.0', primary_column: 'geometry', columns: { geometry: column } };
}

export function buildGeoParquet(features: readonly Prepared[], crs: ExportCrs): ArrayBuffer {
  return parquetWriteBuffer({
    columnData: [
      // A plain byte-array column with no logical type: the form every GeoParquet reader knows.
      { name: 'geometry', type: 'BYTE_ARRAY', data: features.map((f) => toWkb(f.geometry as WkbGeometry)), nullable: false },
      ...COLUMNS.map((c) => ({
        name: c.name,
        type: (c.type === 'real' ? 'DOUBLE' : 'STRING') as 'DOUBLE' | 'STRING',
        data: features.map((f) => f.attributes[c.name]),
        nullable: c.type === 'real',
      })),
    ],
    kvMetadata: [{ key: 'geo', value: JSON.stringify(geoMetadata(features, crs)) }],
  });
}
