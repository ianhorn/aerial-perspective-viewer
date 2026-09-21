"""Check the files the drawing exports with readers that are not this app's code: GDAL (through pyogrio), GeoPandas and pyarrow, and
PROJ (pyproj) for the coordinates. The expected geometry is worked out here from sample.json (what was drawn), not read back from the
exporter: State Plane coordinates by PROJ, a circle's ring by its definition, sizes by shapely.

usage: verify_exports.py <folder written by write-samples.ts>
"""
import json
import math
import sqlite3
import struct
import sys
from pathlib import Path

import geopandas as gpd
import pyarrow.parquet as pq
import pandas as pd
import pyogrio
from pyproj import CRS, Transformer
import shapely
from shapely.geometry import LineString, Point, Polygon

FOOT = 0.3048006096012192  # metres in a US survey foot
folder = Path(sys.argv[1])
sample = json.loads((folder / 'sample.json').read_text())
to_grid = Transformer.from_crs('EPSG:4326', 'EPSG:3089', always_xy=True)
to_lonlat = Transformer.from_crs('EPSG:3089', 'EPSG:4326', always_xy=True)
problems = []


def check(condition, message):
    if not condition:
        problems.append(message)


def expected_ring_grid(f):
    """A circle as the app draws it: 64 points on a planar circle in State Plane feet, closed."""
    cx, cy = to_grid.transform(*f['coordinates'][0])
    r = f['radiusM'] / FOOT
    ring = [(cx + r * math.cos(2 * math.pi * i / 64), cy + r * math.sin(2 * math.pi * i / 64)) for i in range(64)]
    return ring + [ring[0]]


def expected_geometry(f, crs):
    """The shape of a feature in 'wgs84' or 'stateplane' coordinates, worked out from what was drawn."""
    kind = f['kind']
    def conv(c):
        return to_grid.transform(*c) if crs == 'stateplane' else tuple(c)
    if kind in ('point', 'text'):
        return Point(conv(f['coordinates'][0]))
    if kind == 'line':
        return LineString([conv(c) for c in f['coordinates']])
    if kind == 'circle':
        ring = expected_ring_grid(f)
        return Polygon(ring if crs == 'stateplane' else [to_lonlat.transform(*p) for p in ring])
    return Polygon([conv(c) for c in f['coordinates']])


def expected_sizes(f):
    """Length, perimeter, area in feet and square feet, on the State Plane grid."""
    kind = f['kind']
    if kind == 'line':
        return {'length_ft': LineString([to_grid.transform(*c) for c in f['coordinates']]).length}
    if kind in ('polygon', 'rectangle'):
        p = Polygon([to_grid.transform(*c) for c in f['coordinates']])
        return {'perimeter_ft': p.length, 'area_sqft': p.area}
    if kind == 'circle':
        r = f['radiusM'] / FOOT
        return {'perimeter_ft': 2 * math.pi * r, 'area_sqft': math.pi * r * r}  # the true circle, not the 64-sided ring that draws it
    return {}


def check_table(gdf, crs, source):
    """The rows, whatever the file format: same ids, geometry, attributes and sizes as what was drawn."""
    by_id = {row.id: row for row in gdf.itertuples()}
    check(set(by_id) == {f['id'] for f in sample}, f'{source}: ids {sorted(by_id)}')
    for f in sample:
        row = by_id.get(f['id'])
        if row is None:
            continue
        where = f"{source} {f['id']}"
        want = expected_geometry(f, crs)
        tolerance = 1e-4 if crs == 'stateplane' else 1e-9  # a thousandth of a millimetre; a hundred-thousandth of a millimetre in degrees
        check(row.geometry.geom_type == want.geom_type, f'{where}: type {row.geometry.geom_type} not {want.geom_type}')
        check(row.geometry.geom_type == want.geom_type and row.geometry.equals_exact(want, tolerance), f'{where}: geometry differs\n  got  {row.geometry.wkt[:160]}\n  want {want.wkt[:160]}')
        check(row.kind == f['kind'], f'{where}: kind {row.kind}')
        check(row.label == f['properties']['label'], f'{where}: label {row.label!r}')
        check(row.notes == f['properties']['notes'], f'{where}: notes {row.notes!r}')
        check(row.color == f['properties']['color'], f'{where}: color {row.color}')
        # GDAL turns an ISO time in GeoJSON into a date-time; a GeoPackage or Parquet text column keeps the text
        check(pd.Timestamp(row.created) == pd.Timestamp(f['createdAt']), f'{where}: created {row.created}')
        sizes = expected_sizes(f)
        for column in ('length_ft', 'perimeter_ft', 'area_sqft'):
            got = getattr(row, column)
            if column in sizes:
                check(got == got and abs(got - sizes[column]) <= 1e-6 * sizes[column], f'{where}: {column} {got} not {sizes[column]}')
            else:
                check(got is None or got != got, f'{where}: {column} should be empty, is {got}')
        got_radius = row.radius_m
        if f['kind'] == 'circle':
            check(abs(got_radius - f['radiusM']) < 1e-9, f'{where}: radius_m {got_radius}')
        else:
            check(got_radius is None or got_radius != got_radius, f'{where}: radius_m should be empty')


def crs_matches(crs, want):
    """Whether a file's coordinate system is the one asked for (State Plane by EPSG:3089's own definition; WGS84 as EPSG:4326 or OGC:CRS84)."""
    if want == 'stateplane':
        return crs is not None and crs.equals(CRS.from_epsg(3089)) and crs.to_epsg() == 3089
    return crs is not None and (crs.equals(CRS.from_epsg(4326)) or crs.equals(CRS.from_user_input('OGC:CRS84')))


for crs in ('wgs84', 'stateplane'):
    # --- GeoPackage, read by GDAL ---
    path = folder / f'drawing-{crs}.gpkg'
    layers = {name: kind for name, kind in pyogrio.list_layers(path)}
    check(layers == {'points': 'Point', 'lines': 'LineString', 'polygons': 'Polygon'}, f'{path.name}: layers {layers}')
    frames = []
    for name in layers:
        gdf = gpd.read_file(path, layer=name)
        check(crs_matches(gdf.crs, crs), f'{path.name}/{name}: crs {gdf.crs}')
        frames.append(gdf)
    check_table(pd.concat(frames, ignore_index=True), crs, path.name)
    info = pyogrio.read_info(path, layer='polygons')
    check(info['geometry_type'] == 'Polygon' and info['fid_column'] == 'fid', f'{path.name}: polygons info {info}')

    # The file as a GeoPackage, by the standard's own rules: the SQLite header, integrity, and the extent each layer says it has.
    db = sqlite3.connect(path)
    check(db.execute('PRAGMA application_id').fetchone()[0] == 0x47504B47, f'{path.name}: application_id')
    check(db.execute('PRAGMA user_version').fetchone()[0] == 10301, f'{path.name}: user_version')
    check(db.execute('PRAGMA integrity_check').fetchall() == [('ok',)], f'{path.name}: integrity')
    check(db.execute('PRAGMA foreign_key_check').fetchall() == [], f'{path.name}: foreign keys')
    srs = {row[0]: row for row in db.execute('SELECT srs_id, organization, organization_coordsys_id FROM gpkg_spatial_ref_sys')}
    check({-1, 0, 4326} <= set(srs), f'{path.name}: required reference systems {sorted(srs)}')
    kinds = {'points': ('point', 'text'), 'lines': ('line',), 'polygons': ('polygon', 'rectangle', 'circle')}
    for table, minx, miny, maxx, maxy, srs_id in db.execute('SELECT table_name, min_x, min_y, max_x, max_y, srs_id FROM gpkg_contents'):
        shapes = [expected_geometry(f, crs) for f in sample if f['kind'] in kinds[table]]
        want = [min(g.bounds[0] for g in shapes), min(g.bounds[1] for g in shapes), max(g.bounds[2] for g in shapes), max(g.bounds[3] for g in shapes)]
        got = [minx, miny, maxx, maxy]
        check(all(abs(a - b) <= 1e-9 * max(1, abs(b)) for a, b in zip(got, want)), f'{path.name}/{table}: extent {got} not {want}')
        check(srs_id == (3089 if crs == 'stateplane' else 4326), f'{path.name}/{table}: contents srs_id {srs_id}')
    # Each geometry's own header: "GP", version 0, flags, the reference system, and an envelope that really is the shape's extent (GDAL
    # ignores the envelope, so it is read here by hand, from the standard's layout: min x, max x, min y, max y).
    for table in layers:
        for fid, blob in db.execute(f'SELECT fid, geom FROM {table}'):
            where = f'{path.name}/{table} fid {fid}'
            check(blob[:2] == b'GP' and blob[2] == 0, f'{where}: header magic or version')
            flags = blob[3]
            check(flags & 1 == 1, f'{where}: flags say big-endian')
            check((flags >> 1) & 7 == 1, f'{where}: envelope indicator {(flags >> 1) & 7}')
            check((flags >> 4) & 1 == 0 and (flags >> 5) & 1 == 0, f'{where}: flags say empty or extended')
            header_srs, = struct.unpack('<i', blob[4:8])
            check(header_srs == (3089 if crs == 'stateplane' else 4326), f'{where}: header srs_id {header_srs}')
            minx, maxx, miny, maxy = struct.unpack('<4d', blob[8:40])
            b = shapely.from_wkb(blob[40:]).bounds
            check(all(abs(a - c) <= 1e-9 * max(1, abs(c)) for a, c in zip((minx, miny, maxx, maxy), b)), f'{where}: envelope {(minx, maxx, miny, maxy)} vs shape {b}')
    db.close()

    # --- GeoParquet, read by GeoPandas and pyarrow ---
    path = folder / f'drawing-{crs}.parquet'
    gdf = gpd.read_parquet(path)
    check(crs_matches(gdf.crs, crs), f'{path.name}: crs {gdf.crs}')
    check_table(gdf, crs, path.name)
    table = pq.read_table(path)
    geo = json.loads(table.schema.metadata[b'geo'])
    check(geo['version'] == '1.1.0' and geo['primary_column'] == 'geometry', f'{path.name}: geo {geo}')
    column = geo['columns']['geometry']
    check(column['encoding'] == 'WKB', f'{path.name}: encoding')
    check(sorted(column['geometry_types']) == ['LineString', 'Point', 'Polygon'], f'{path.name}: geometry_types {column["geometry_types"]}')
    bounds = list(gdf.total_bounds)
    check(all(abs(a - b) <= 1e-6 * max(1, abs(b)) for a, b in zip(column['bbox'], bounds)), f'{path.name}: bbox {column["bbox"]} vs {bounds}')
    check(str(table.schema.field('geometry').type) == 'binary', f'{path.name}: geometry column is {table.schema.field("geometry").type}')

# --- GeoJSON, which is always longitude and latitude ---
gdf = gpd.read_file(folder / 'drawing.geojson')
check(crs_matches(gdf.crs, 'wgs84'), f'geojson crs {gdf.crs}')
check_table(gdf, 'wgs84', 'drawing.geojson')

if problems:
    print('\n'.join(problems))
    sys.exit(1)
print('OK: GDAL, GeoPandas, pyarrow and PROJ read every export and agree with what was drawn')
