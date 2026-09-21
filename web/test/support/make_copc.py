"""Write a tiny COPC file (a cloud-optimised, LAZ-compressed point cloud) for the tests: test/fixtures/tiny.copc.laz.

It is made by hand from the LAS 1.4 and COPC 1.0 layouts, with the LAZ compression done by lazrs (the Rust LAZ codec that laspy uses), and
laspy reads it back to check it. Nothing here comes from the state's data: the points are a made-up surface over a 5,000 ft tile in the
Kentucky Single Zone (EPSG:3089, feet), laid out like the state's Phase 2 tiles (the same tile corner as N077E228, in Louisville).

The points are a regular lattice, 100 x 100 points 50 ft apart, shared out over three levels of the octree so that a reader can be tested
on choosing a depth:
  level 0  (1 node):   every 4th point in x and y            625 points, 200 ft apart
  level 1  (4 nodes):  the rest of every 2nd point            1,875 points, in the four quadrants
  level 2  (16 nodes): everything else                        7,500 points, in the sixteen sixteenths
Height is a made-up rolling surface, 400 to 475 ft, with a 40 ft box (a "building") near the middle, classified 6; the rest is class 2.

usage:  python make_copc.py <output.copc.laz>     (needs numpy, laspy, lazrs: see requirements-geo.txt)
"""
import io
import struct
import sys

import laspy
import lazrs
import numpy as np

X0, Y0, Z0, SIDE = 4914999.99, 3974999.99, 380.0, 5000.0  # the cube of the tile; Z0 is a little under the lowest point
N, STEP = 100, 50.0
SCALE = 0.01
WKT = ('COMPD_CS["NAD83 / Kentucky Single Zone (ftUS) + NAVD88 height (ftUS) - Geoid12B (ftUS)",'
       'PROJCS["NAD83 / Kentucky Single Zone (ftUS)",GEOGCS["NAD83",DATUM["North_American_Datum_1983",'
       'SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],'
       'PROJECTION["Lambert_Conformal_Conic_2SP"],PARAMETER["standard_parallel_1",37.0833333333333],'
       'PARAMETER["standard_parallel_2",38.6666666666667],PARAMETER["latitude_of_origin",36.3333333333333],'
       'PARAMETER["central_meridian",-85.75],PARAMETER["false_easting",4921250],PARAMETER["false_northing",3280833.333],'
       'UNIT["US survey foot",0.304800609601219]],VERT_CS["NAVD88 height (ftUS)",VERT_DATUM["North American Vertical Datum 1988",2005],'
       'UNIT["US survey foot",0.304800609601219],AXIS["Up",UP]]]')

POINT = np.dtype([('x', '<i4'), ('y', '<i4'), ('z', '<i4'), ('intensity', '<u2'), ('returns', 'u1'), ('flags', 'u1'), ('classification', 'u1'),
                  ('user_data', 'u1'), ('scan_angle', '<i2'), ('point_source_id', '<u2'), ('gps_time', '<f8')])
assert POINT.itemsize == 30


def height(x, y):
    """A rolling surface with a box on it."""
    z = 420.0 + 20.0 * np.sin((x - X0) / 700.0) * np.cos((y - Y0) / 900.0)
    building = (abs(x - (X0 + 2500)) < 300) & (abs(y - (Y0 + 2500)) < 300)
    return np.where(building, z + 40.0, z), np.where(building, 6, 2)


def lattice():
    i, j = np.meshgrid(np.arange(N), np.arange(N), indexing='ij')
    i, j = i.ravel(), j.ravel()
    x, y = X0 + (i + 0.5) * STEP, Y0 + (j + 0.5) * STEP
    z, cls = height(x, y)
    return i, j, x, y, z, cls


def node_of(level, x, y):
    size = SIDE / 2 ** level
    return level, int((x - X0) // size), int((y - Y0) // size), 0


def build():
    i, j, x, y, z, cls = lattice()
    level = np.full(len(i), 2)
    level[(i % 2 == 0) & (j % 2 == 0)] = 1
    level[(i % 4 == 0) & (j % 4 == 0)] = 0
    nodes = {}
    for k in range(len(i)):
        nodes.setdefault(node_of(int(level[k]), x[k], y[k]), []).append(k)
    return x, y, z, cls, nodes


def pack(idx, x, y, z, cls):
    p = np.zeros(len(idx), dtype=POINT)
    p['x'] = np.round((x[idx] - 0) / SCALE).astype('<i4')
    p['y'] = np.round((y[idx] - 0) / SCALE).astype('<i4')
    p['z'] = np.round((z[idx] - 0) / SCALE).astype('<i4')
    p['intensity'] = 100 + (idx % 900)
    p['returns'] = 0x11  # return 1 of 1
    p['classification'] = cls[idx]
    p['gps_time'] = 1000.0 + idx
    return p


def vlr(user, record_id, data, description=''):
    return struct.pack('<H16sHH32s', 0, user.encode(), record_id, len(data), description.encode()) + data


def main(out):
    x, y, z, cls, nodes = build()
    order = sorted(nodes)  # by level, then x, y
    # the LAZ VLR, with variable-size chunks because each COPC node is one chunk
    laz = lazrs.LazVlr.new_for_compression(6, 0, True)
    raw = laz.record_data()

    copc_info_size = 54 + 160
    laz_vlr = vlr('laszip encoded', 22204, bytes(raw), 'laz-rs')
    wkt_vlr = vlr('LASF_Projection', 2112, WKT.encode() + b'\0')
    point_start = 375 + copc_info_size + len(laz_vlr) + len(wkt_vlr)

    body = io.BytesIO()
    body.seek(0)
    comp = lazrs.LasZipCompressor(body, laz)
    comp.reserve_offset_to_chunk_table()
    entries = []  # (key, offset, size, count)
    # lazrs writes an 8-byte placeholder for the chunk table's position first, so the first chunk starts at 8
    for key in order:
        idx = np.array(nodes[key])
        start = body.tell() if entries else 8
        comp.compress_many(np.frombuffer(pack(idx, x, y, z, cls).tobytes(), dtype=np.uint8))
        comp.finish_current_chunk()
        entries.append((key, point_start + start, body.tell() - start, len(idx)))
    comp.done()
    body_bytes = bytearray(body.getvalue())
    # the compressor wrote the chunk table's position as an offset within `body`; in the file it is measured from the start of the file
    struct.pack_into('<Q', body_bytes, 0, struct.unpack_from('<Q', body_bytes, 0)[0] + point_start)
    body_bytes = bytes(body_bytes)

    hier = b''.join(struct.pack('<iiiiQii', *k, off, size, count) for k, off, size, count in entries)
    evlr_start = point_start + len(body_bytes)
    evlr = struct.pack('<H16sHQ32s', 0, b'copc', 1000, len(hier), b'hierarchy') + hier
    hier_offset = evlr_start + 60

    cx, cy, cz, half = X0 + SIDE / 2, Y0 + SIDE / 2, Z0 + SIDE / 2, SIDE / 2
    info = struct.pack('<5dQQ2d11Q', cx, cy, cz, half, 200.0, hier_offset, len(hier), 1000.0, 1000.0 + len(x), *([0] * 11))
    assert len(info) == 160
    copc_vlr = vlr('copc', 1, info, 'COPC info')

    n = len(x)
    header = struct.pack(
        '<4sHH16sBB32s32sHHHIIBHI5I3d3d6dQQIQ15Q',
        b'LASF', 0, 0x10, b'\0' * 16, 1, 4, b'made-up test data'.ljust(32, b'\0'), b'make_copc.py'.ljust(32, b'\0'), 1, 2026, 375,
        point_start, 3, 6 | 0x80, 30, 0, 0, 0, 0, 0, 0,
        SCALE, SCALE, SCALE, 0.0, 0.0, 0.0,
        float(x.max()), float(x.min()), float(y.max()), float(y.min()), float(z.max()), float(z.min()),
        0, evlr_start, 1, n, n, *([0] * 14))
    assert len(header) == 375, len(header)
    with open(out, 'wb') as f:
        f.write(header + copc_vlr + laz_vlr + wkt_vlr + body_bytes + evlr)
    print('wrote', out, 'points', n, 'nodes', len(entries))


if __name__ == '__main__':
    main(sys.argv[1])
