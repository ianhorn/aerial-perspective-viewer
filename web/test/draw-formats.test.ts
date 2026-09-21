import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parquetMetadata, parquetReadObjects } from 'hyparquet';
import initSqlJs from 'sql.js';
import { attributesOf, COLUMNS, geometryIn, prepare } from '../src/draw-export.ts';
import { buildGeoPackage, geometryBlob } from '../src/draw-gpkg.ts';
import { buildGeoParquet, geoMetadata } from '../src/draw-parquet.ts';
import { toWkb } from '../src/draw-wkb.ts';
import { SAMPLE } from './support/draw-sample.ts';

const SQL = await initSqlJs();
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

describe('well-known binary', () => {
  // Worked out by hand from the OGC layout: byte order 01 (little-endian), the type as a 32-bit number, then the numbers. 1.0 is 000000000000f03f, 2.0 is 0000000000000040.
  it('a point is 21 bytes: order, type 1, x, y', () => {
    assert.equal(hex(toWkb({ type: 'Point', coordinates: [1, 2] })), '01' + '01000000' + '000000000000f03f' + '0000000000000040');
  });
  it('a line is order, type 2, a count, and the points', () => {
    assert.equal(hex(toWkb({ type: 'LineString', coordinates: [[1, 2], [2, 1]] })), '01' + '02000000' + '02000000' + '000000000000f03f0000000000000040' + '0000000000000040000000000000f03f');
  });
  it('a polygon is order, type 3, a ring count, and each ring with its own count', () => {
    const wkb = toWkb({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] });
    assert.equal(hex(wkb).slice(0, 2 + 8 + 8 + 8), '01' + '03000000' + '01000000' + '04000000');
    assert.equal(wkb.length, 1 + 4 + 4 + 4 + 4 * 16);
  });
});

describe('the drawing in a coordinate system', () => {
  const geometry = (id: string, crs: 'wgs84' | 'stateplane') => geometryIn(SAMPLE.find((f) => f.id === id)!, crs);

  it('WGS84 is longitude then latitude as drawn', () => {
    assert.deepEqual(geometry('pt-1', 'wgs84'), { type: 'Point', coordinates: [-85.7, 38.2] });
  });

  it('State Plane is what PROJ gives for EPSG:3089 (pyproj 3.8: -85.7, 38.2 -> 4935617.826942463, 3960523.040211461)', () => {
    const g = geometry('pt-1', 'stateplane') as { coordinates: [number, number] };
    assert.ok(Math.abs(g.coordinates[0] - 4935617.826942463) < 1e-3, `${g.coordinates[0]}`); // a millimetre
    assert.ok(Math.abs(g.coordinates[1] - 3960523.040211461) < 1e-3, `${g.coordinates[1]}`);
    const line = geometry('ln-1', 'stateplane') as { coordinates: [number, number][] };
    const want = [[4935617.826942463, 3960523.040211461], [4949966.13942912, 3978741.928694852], [4964330.051970126, 3975119.6747243325]]; // PROJ
    assert.equal(line.coordinates.length, 3);
    line.coordinates.forEach((c, i) => { assert.ok(Math.abs(c[0] - want[i]![0]) < 1e-3 && Math.abs(c[1] - want[i]![1]) < 1e-3, `vertex ${i}: ${c}`); });
  });

  it('a circle is 64 points 300 m (984.25 ft) from the centre on the grid, in State Plane', () => {
    const ring = (geometry('ci-1', 'stateplane') as { coordinates: [number, number][][] }).coordinates[0]!;
    assert.equal(ring.length, 65);
    assert.deepEqual(ring[0], ring[64]);
    const cx = ring.slice(0, 64).reduce((s, p) => s + p[0], 0) / 64, cy = ring.slice(0, 64).reduce((s, p) => s + p[1], 0) / 64;
    for (const p of ring) assert.ok(Math.abs(Math.hypot(p[0] - cx, p[1] - cy) - 300 / 0.3048006096012192) < 1e-6);
    // and the centre is where PROJ puts -85.75, 38.25: 4921250.000000001, 3978726.5431088833
    assert.ok(Math.abs(cx - 4921250) < 1e-3 && Math.abs(cy - 3978726.5431088833) < 1e-3);
  });

  it('the attributes carry the sizes, and only the ones that apply', () => {
    const a = (id: string) => attributesOf(SAMPLE.find((f) => f.id === id)!);
    assert.equal(a('pt-1').length_ft, null);
    assert.ok(a('ln-1').length_ft! > 10_000);
    assert.equal(a('ln-1').area_sqft, null);
    assert.equal(a('ci-1').radius_m, 300);
    assert.ok(Math.abs(a('ci-1').area_sqft! - Math.PI * (300 / 0.3048006096012192) ** 2) < 1e-6);
    assert.ok(a('pg-1').area_sqft! > 0 && a('pg-1').perimeter_ft! > 0);
  });
});

describe('the GeoPackage', () => {
  const open = (crs: 'wgs84' | 'stateplane', features = SAMPLE) => {
    const bytes = buildGeoPackage(prepare(features, crs), crs, SQL, new Date('2026-09-20T12:00:00.000Z'));
    return { bytes, db: new SQL.Database(bytes) };
  };
  const rows = (db: InstanceType<typeof SQL.Database>, sql: string): unknown[][] => db.exec(sql)[0]?.values ?? [];

  it('is a SQLite file that says it is a GeoPackage 1.3.1', () => {
    const { bytes, db } = open('wgs84');
    assert.equal(Buffer.from(bytes.subarray(0, 15)).toString('latin1'), 'SQLite format 3');
    assert.deepEqual(rows(db, 'PRAGMA application_id'), [[0x47504b47]]);
    assert.deepEqual(rows(db, 'PRAGMA user_version'), [[10301]]);
    assert.deepEqual(rows(db, 'PRAGMA integrity_check'), [['ok']]);
  });

  it('has a layer for each kind of geometry, with the shapes in the right one', () => {
    const { db } = open('wgs84');
    assert.deepEqual(rows(db, 'SELECT table_name, data_type, srs_id FROM gpkg_contents ORDER BY table_name'), [['lines', 'features', 4326], ['points', 'features', 4326], ['polygons', 'features', 4326]]);
    assert.deepEqual(rows(db, 'SELECT table_name, geometry_type_name, srs_id, z, m FROM gpkg_geometry_columns ORDER BY table_name'), [['lines', 'LINESTRING', 4326, 0, 0], ['points', 'POINT', 4326, 0, 0], ['polygons', 'POLYGON', 4326, 0, 0]]);
    assert.deepEqual(rows(db, 'SELECT id FROM points ORDER BY fid'), [['pt-1'], ['tx-1']]);
    assert.deepEqual(rows(db, 'SELECT id FROM lines'), [['ln-1']]);
    assert.deepEqual(rows(db, 'SELECT id FROM polygons ORDER BY fid'), [['pg-1'], ['rc-1'], ['ci-1']]);
  });

  it('holds the three reference systems the standard requires, and State Plane when that is what was asked for', () => {
    assert.deepEqual(rows(open('wgs84').db, 'SELECT srs_id FROM gpkg_spatial_ref_sys ORDER BY srs_id'), [[-1], [0], [4326]]);
    const sp = open('stateplane').db;
    assert.deepEqual(rows(sp, 'SELECT srs_id FROM gpkg_spatial_ref_sys ORDER BY srs_id'), [[-1], [0], [3089], [4326]]);
    assert.deepEqual(rows(sp, 'SELECT srs_id FROM gpkg_contents GROUP BY srs_id'), [[3089]]);
    assert.match(String(rows(sp, 'SELECT definition FROM gpkg_spatial_ref_sys WHERE srs_id = 3089')[0]![0]), /^PROJCS\["NAD83 \/ Kentucky Single Zone \(ftUS\)".*AUTHORITY\["EPSG","3089"\]\]$/);
  });

  it('keeps awkward text exactly: quotes, a newline, accents, a symbol', () => {
    const { db } = open('wgs84');
    assert.deepEqual(rows(db, "SELECT label, notes FROM points WHERE id = 'pt-1'"), [['Gate "A", north', '']]);
    assert.deepEqual(rows(db, "SELECT label, notes FROM points WHERE id = 'tx-1'"), [['Staging area', 'two\nlines, ünïcode ✓']]);
    assert.deepEqual(rows(db, "SELECT kind, color, created FROM points WHERE id = 'tx-1'"), [['text', '#1e88e5', '2026-09-20T12:01:00.000Z']]);
  });

  it('puts a header, an envelope and the WKB in each geometry', () => {
    const g = geometryBlob({ type: 'Point', coordinates: [3, 4] }, 4326);
    assert.equal(hex(g.blob.subarray(0, 8)), '4750' + '00' + '03' + 'e6100000'); // "GP", version 0, flags 3, srs 4326 little-endian
    assert.equal(hex(g.blob.subarray(8, 40)), ['0000000000000840', '0000000000000840', '0000000000001040', '0000000000001040'].join('')); // min x, max x, min y, max y
    assert.equal(hex(g.blob.subarray(40)), hex(toWkb({ type: 'Point', coordinates: [3, 4] })));
  });

  it('records each layer’s extent from its shapes', () => {
    const { db } = open('wgs84');
    assert.deepEqual(rows(db, "SELECT min_x, min_y, max_x, max_y FROM gpkg_contents WHERE table_name = 'points'"), [[-85.7, 38.2, -85.6, 38.3]]);
  });

  it('is still a valid, empty GeoPackage for an empty drawing', () => {
    const { db } = open('wgs84', []);
    assert.deepEqual(rows(db, 'SELECT COUNT(*) FROM gpkg_contents'), [[0]]);
    assert.deepEqual(rows(db, 'PRAGMA integrity_check'), [['ok']]);
  });

  it('only makes the layers that have features', () => {
    const { db } = open('wgs84', SAMPLE.filter((f) => f.kind === 'line'));
    assert.deepEqual(rows(db, 'SELECT table_name FROM gpkg_contents'), [['lines']]);
  });
});

describe('the GeoParquet file', () => {
  const read = async (crs: 'wgs84' | 'stateplane', features = SAMPLE) => {
    const buffer = buildGeoParquet(prepare(features, crs), crs);
    return { buffer, metadata: parquetMetadata(buffer), rows: await parquetReadObjects({ file: buffer }) };
  };

  it('says in its metadata which column is geometry, what it holds and its extent', async () => {
    const { metadata } = await read('wgs84');
    const geo = JSON.parse(metadata.key_value_metadata!.find((kv) => kv.key === 'geo')!.value!) as ReturnType<typeof geoMetadata> & { columns: { geometry: Record<string, unknown> } };
    assert.deepEqual(geo, {
      version: '1.1.0', primary_column: 'geometry',
      columns: { geometry: { encoding: 'WKB', geometry_types: ['LineString', 'Point', 'Polygon'], bbox: geo.columns.geometry['bbox'] } },
    });
    const bbox = geo.columns.geometry['bbox'] as number[];
    assert.ok(bbox[0]! <= -85.73 && bbox[1]! <= 38.1 && bbox[2]! >= -85.45 && bbox[3]! >= 38.3, `${bbox}`);
    assert.ok(bbox[0]! > -85.8 && bbox[3]! < 38.4); // and not wider than the shapes
  });

  it('gives State Plane files a PROJJSON coordinate system for EPSG:3089, and WGS84 files none (the default is OGC:CRS84)', async () => {
    const sp = JSON.parse((await read('stateplane')).metadata.key_value_metadata!.find((kv) => kv.key === 'geo')!.value!) as { columns: { geometry: { crs?: { id: { code: number }; type: string } } } };
    assert.equal(sp.columns.geometry.crs!.type, 'ProjectedCRS');
    assert.equal(sp.columns.geometry.crs!.id.code, 3089);
    const wgs = JSON.parse((await read('wgs84')).metadata.key_value_metadata!.find((kv) => kv.key === 'geo')!.value!) as { columns: { geometry: Record<string, unknown> } };
    assert.equal('crs' in wgs.columns.geometry, false);
  });

  it('has a row for each feature, the geometry as WKB and the attributes in their columns', async () => {
    const { rows } = await read('wgs84');
    assert.equal(rows.length, SAMPLE.length);
    assert.deepEqual(Object.keys(rows[0]!), ['geometry', ...COLUMNS.map((c) => c.name)]);
    const prepared = prepare(SAMPLE, 'wgs84');
    rows.forEach((row, i) => {
      // hyparquet reads the WKB itself and gives back GeoJSON, so this is a second implementation of the format reading the first's bytes
      assert.deepEqual(row['geometry'], prepared[i]!.geometry);
      assert.equal(row['id'], SAMPLE[i]!.id);
      assert.equal(row['label'], SAMPLE[i]!.properties.label);
      assert.equal(row['notes'], SAMPLE[i]!.properties.notes);
      assert.equal(row['created'], SAMPLE[i]!.createdAt);
      assert.equal(row['kind'], SAMPLE[i]!.kind);
      assert.equal(row['color'], SAMPLE[i]!.properties.color);
    });
    const circle = rows.find((r) => r['id'] === 'ci-1')!;
    assert.equal(circle['radius_m'], 300);
    assert.equal(rows.find((r) => r['id'] === 'pt-1')!['radius_m'], null);
  });

  it('is still a valid file for an empty drawing', async () => {
    const { rows, metadata } = await read('wgs84', []);
    assert.deepEqual(rows, []);
    const geo = JSON.parse(metadata.key_value_metadata!.find((kv) => kv.key === 'geo')!.value!) as { columns: { geometry: { geometry_types: string[]; bbox?: number[] } } };
    assert.deepEqual(geo.columns.geometry.geometry_types, []);
    assert.equal(geo.columns.geometry.bbox, undefined);
  });
});
