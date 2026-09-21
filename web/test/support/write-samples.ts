// Write the sample drawing in every format into a folder (argument 1), for a reader that is not this code to check: the input as
// `sample.json` (what the drawing holds, before any export), and one file per format and coordinate system.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import initSqlJs from 'sql.js';
import { prepare, toGeoJson } from '../../src/draw-export.ts';
import { buildGeoPackage } from '../../src/draw-gpkg.ts';
import { buildGeoParquet } from '../../src/draw-parquet.ts';
import { SAMPLE } from './draw-sample.ts';

const dir = process.argv[2];
if (!dir) throw new Error('usage: write-samples.ts <folder>');
mkdirSync(dir, { recursive: true });
const SQL = await initSqlJs();
writeFileSync(join(dir, 'sample.json'), JSON.stringify(SAMPLE));
writeFileSync(join(dir, 'drawing.geojson'), JSON.stringify(toGeoJson(SAMPLE)));
for (const crs of ['wgs84', 'stateplane'] as const) {
  const rows = prepare(SAMPLE, crs);
  writeFileSync(join(dir, `drawing-${crs}.gpkg`), buildGeoPackage(rows, crs, SQL));
  writeFileSync(join(dir, `drawing-${crs}.parquet`), new Uint8Array(buildGeoParquet(rows, crs)));
}
console.log('wrote', dir);
