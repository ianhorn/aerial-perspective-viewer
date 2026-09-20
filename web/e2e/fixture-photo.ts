// A photo for the browser tests, made in memory: a tiled, JPEG-compressed TIFF laid out the way the KyFromAbove oblique
// photos are (largest level first in the directory chain, 512 px tiles, one shared copy of the JPEG tables), which is the
// layout `web/src/cog.ts` reads. The synthetic frames (pipeline/synthetic) have no photos, and image files may not be
// committed (the hygiene check forbids them), so the tests build one instead.
//
// What the picture is: every tile is one flat colour, picked from a small palette by its position. That is enough to see
// that the right tiles are drawn in the right places, and it makes the file tiny: tiles of the same colour share their
// bytes (a TIFF only says where each tile is), so a photo of 14,144 by 10,560 px is about 50 KB, and the JPEG for a flat
// tile is written by hand here (a DC-only baseline stream), with no encoder.
//
// The size matters: the app maps regions of the photo in the camera's own pixels onto the file's largest level, so the
// file has to be exactly as big as the sensor the frame says it has (see `web/src/camera.ts`).

const TILE = 512;

/** The flat colours of the tiles (sRGB). Muted, so the picture looks a little like the ground. */
export const PALETTE: readonly (readonly [number, number, number])[] = [
  [96, 122, 74], [141, 132, 96], [110, 110, 110], [70, 96, 64], [166, 150, 118], [88, 104, 122], [128, 96, 80], [150, 168, 132],
];

/** Which palette colour the tile at column `col` and row `row` of a level has. */
export const tileColour = (col: number, row: number): number => (col + 2 * row) % PALETTE.length;

// --- a flat-colour JPEG tile ---

// Huffman tables that hold only the symbols a flat tile needs, which a baseline decoder accepts as readily as the
// standard ones. DC: categories 0 to 11 as 4-bit codes (in order, so code = category). AC: only the end-of-block symbol,
// as the 1-bit code 0.
const QUANT = 8; // every entry of the quantisation table: it scales the DC value down to a small number

function segment(marker: number, body: number[]): number[] {
  const length = body.length + 2;
  return [0xff, marker, length >> 8, length & 0xff, ...body];
}
const DQT = segment(0xdb, [0x00, ...new Array<number>(64).fill(QUANT)]);
const DHT_DC = segment(0xc4, [0x00, 0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...Array.from({ length: 12 }, (_, i) => i)]);
const DHT_AC = segment(0xc4, [0x10, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x00]);

/** The JPEGTables of the file: a stream that holds only the tables. */
export const JPEG_TABLES = new Uint8Array([0xff, 0xd8, ...DQT, ...DHT_DC, ...DHT_AC, 0xff, 0xd9]);

/** One 512 by 512 tile, all one colour, as a JPEG stream without tables. */
export function flatTile(rgb: readonly [number, number, number]): Uint8Array {
  const [r, g, b] = rgb;
  // DC of a flat 8 by 8 block is 8 x (value - 128), and the quantiser divides by QUANT (also 8).
  const dc = [
    0.299 * r + 0.587 * g + 0.114 * b,
    128 - 0.168736 * r - 0.331264 * g + 0.5 * b,
    128 + 0.5 * r - 0.418688 * g - 0.081312 * b,
  ].map((v) => Math.round(Math.max(0, Math.min(255, v)) - 128));

  const out: number[] = [];
  let acc = 0, nbits = 0;
  const put = (value: number, bits: number): void => {
    for (let i = bits - 1; i >= 0; i--) {
      acc = (acc << 1) | ((value >> i) & 1);
      if (++nbits === 8) {
        out.push(acc);
        if (acc === 0xff) out.push(0x00); // a data byte of 0xff is followed by a stuffed 0
        acc = 0;
        nbits = 0;
      }
    }
  };
  const block = (diff: number): void => {
    if (diff === 0) put(0, 4); // category 0
    else {
      const category = 32 - Math.clz32(Math.abs(diff));
      put(category, 4);
      put(diff > 0 ? diff : diff + (1 << category) - 1, category);
    }
    put(0, 1); // end of block
  };
  const mcus = (TILE / 8) * (TILE / 8);
  for (let m = 0; m < mcus; m++) {
    for (let c = 0; c < 3; c++) block(m === 0 ? dc[c]! : 0); // each block's DC is coded as the change from the last of its component
  }
  while (nbits !== 0) put(1, 1); // pad the last byte with ones

  const SOF = segment(0xc0, [8, TILE >> 8, TILE & 0xff, TILE >> 8, TILE & 0xff, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]);
  const SOS = segment(0xda, [3, 1, 0x00, 2, 0x00, 3, 0x00, 0, 63, 0]);
  return new Uint8Array([0xff, 0xd8, ...SOF, ...SOS, ...out, 0xff, 0xd9]);
}

// --- the TIFF ---

export interface FixturePhoto {
  /** The whole file. */
  bytes: Uint8Array;
  /** The size of each level, largest first. */
  levels: { width: number; height: number; across: number; down: number }[];
}

const T = { short: 3, long: 4, undefined: 7 } as const;

/** Build a photo of `width` by `height` pixels, with overview levels down to under 1,000 px wide. */
export function buildPhoto(width: number, height: number): FixturePhoto {
  const levels: FixturePhoto['levels'] = [];
  for (let w = width, h = height; ; w = Math.ceil(w / 2), h = Math.ceil(h / 2)) {
    levels.push({ width: w, height: h, across: Math.ceil(w / TILE), down: Math.ceil(h / TILE) });
    if (w < 1000) break;
  }
  const blobs = PALETTE.map((rgb) => flatTile(rgb));

  // Layout: the 8-byte header, then for each level its directory (11 entries) and the arrays it points to, then the tables, then the tile bytes.
  const ENTRIES = 11;
  const ifdSize = 2 + ENTRIES * 12 + 4;
  let at = 8;
  const plan = levels.map((level) => {
    const n = level.across * level.down;
    const ifd = at;
    const arrays = ifd + ifdSize;
    const bits = arrays;                // 3 shorts (6 bytes), padded to 8
    const offsets = bits + 8;
    const counts = offsets + (n > 1 ? 4 * n : 0);
    at = counts + (n > 1 ? 4 * n : 0);
    return { ...level, n, ifd, bits, offsets, counts };
  });
  const tablesAt = at;
  const blobsAt = tablesAt + JPEG_TABLES.length + (JPEG_TABLES.length % 2);
  const blobStart: number[] = [];
  let end = blobsAt;
  for (const blob of blobs) {
    blobStart.push(end);
    end += blob.length + (blob.length % 2);
  }

  const bytes = new Uint8Array(end);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0x4949, true); // "II": little-endian
  view.setUint16(2, 42, true);
  view.setUint32(4, plan[0]!.ifd, true);
  bytes.set(JPEG_TABLES, tablesAt);
  blobs.forEach((blob, i) => bytes.set(blob, blobStart[i]!));

  plan.forEach((p, li) => {
    let e = p.ifd;
    view.setUint16(e, ENTRIES, true);
    e += 2;
    const entry = (tag: number, type: number, count: number, value: number): void => {
      view.setUint16(e, tag, true);
      view.setUint16(e + 2, type, true);
      view.setUint32(e + 4, count, true);
      if (type === T.short && count === 1) view.setUint16(e + 8, value, true);
      else view.setUint32(e + 8, value, true);
      e += 12;
    };
    entry(256, T.long, 1, p.width);
    entry(257, T.long, 1, p.height);
    entry(258, T.short, 3, p.bits);
    entry(259, T.short, 1, 7); // JPEG
    entry(262, T.short, 1, 6); // YCbCr
    entry(277, T.short, 1, 3);
    entry(322, T.long, 1, TILE);
    entry(323, T.long, 1, TILE);
    // Where each tile is. Tiles of one colour share their bytes.
    const offsets: number[] = [], counts: number[] = [];
    for (let row = 0; row < p.down; row++) {
      for (let col = 0; col < p.across; col++) {
        const c = tileColour(col, row);
        offsets.push(blobStart[c]!);
        counts.push(blobs[c]!.length);
      }
    }
    entry(324, T.long, p.n, p.n > 1 ? p.offsets : offsets[0]!);
    entry(325, T.long, p.n, p.n > 1 ? p.counts : counts[0]!);
    entry(347, T.undefined, JPEG_TABLES.length, tablesAt);
    view.setUint32(e, li + 1 < plan.length ? plan[li + 1]!.ifd : 0, true); // the next directory, or none
    [8, 8, 8].forEach((v, k) => view.setUint16(p.bits + 2 * k, v, true));
    if (p.n > 1) {
      offsets.forEach((v, k) => view.setUint32(p.offsets + 4 * k, v, true));
      counts.forEach((v, k) => view.setUint32(p.counts + 4 * k, v, true));
    }
  });

  return { bytes, levels };
}

/** Answer a Range request for part of the photo: what a bucket does. Returns the status, the headers and the body. */
export function rangeOf(bytes: Uint8Array, header: string | undefined): { status: number; headers: Record<string, string>; body: Buffer } {
  const total = bytes.length;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!m) return { status: 200, headers: { 'content-length': String(total), 'accept-ranges': 'bytes' }, body: Buffer.from(bytes) };
  const start = m[1] === '' ? Math.max(0, total - Number(m[2])) : Number(m[1]);
  const last = m[1] === '' || m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
  if (start >= total || start > last) return { status: 416, headers: { 'content-range': `bytes */${total}` }, body: Buffer.alloc(0) };
  const body = Buffer.from(bytes.subarray(start, last + 1));
  return { status: 206, headers: { 'content-range': `bytes ${start}-${last}/${total}`, 'content-length': String(body.length), 'accept-ranges': 'bytes' }, body };
}
