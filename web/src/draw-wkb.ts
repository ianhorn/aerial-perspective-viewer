// Well-known binary (the OGC/ISO standard form: little-endian, two dimensions) for the three geometry types a drawing has. GeoPackage
// and GeoParquet both carry geometry this way. No DOM here.

export type Position = readonly [number, number];
export type WkbGeometry =
  | { type: 'Point'; coordinates: Position }
  | { type: 'LineString'; coordinates: readonly Position[] }
  | { type: 'Polygon'; coordinates: readonly (readonly Position[])[] };

const TYPE_CODE = { Point: 1, LineString: 2, Polygon: 3 } as const;

/** The size in bytes of a geometry's WKB. */
function sizeOf(g: WkbGeometry): number {
  switch (g.type) {
    case 'Point': return 1 + 4 + 16;
    case 'LineString': return 1 + 4 + 4 + 16 * g.coordinates.length;
    case 'Polygon': return 1 + 4 + 4 + g.coordinates.reduce((n, ring) => n + 4 + 16 * ring.length, 0);
  }
}

export function toWkb(g: WkbGeometry): Uint8Array {
  const bytes = new Uint8Array(sizeOf(g));
  const view = new DataView(bytes.buffer);
  let at = 0;
  const u8 = (v: number): void => { view.setUint8(at, v); at += 1; };
  const u32 = (v: number): void => { view.setUint32(at, v, true); at += 4; };
  const xy = (p: Position): void => { view.setFloat64(at, p[0], true); view.setFloat64(at + 8, p[1], true); at += 16; };
  u8(1); // little-endian
  u32(TYPE_CODE[g.type]);
  if (g.type === 'Point') xy(g.coordinates);
  else if (g.type === 'LineString') { u32(g.coordinates.length); g.coordinates.forEach(xy); }
  else { u32(g.coordinates.length); for (const ring of g.coordinates) { u32(ring.length); ring.forEach(xy); } }
  return bytes;
}
