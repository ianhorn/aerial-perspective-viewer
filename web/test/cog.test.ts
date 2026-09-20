import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type CogLevel, fetchBytes, HttpStatusError, NeedMoreBytes, parseCogHeader, pickLevel, planChunks, planRegion, readHeader, tileGrid, tileJpeg, tileRange } from '../src/cog.ts';

interface Spec {
  width: number; height: number; tw: number; th: number; offsets: number[]; counts: number[];
  tables?: number[]; compression?: number;
}

/** Build the first bytes of a classic tiled TIFF: header, one directory per level, then the value arrays. */
function buildTiff(levels: Spec[], little = true): Uint8Array {
  type Entry = [tag: number, type: number, values: number[]];
  const entries = (l: Spec): Entry[] => [
    [256, 3, [l.width]], [257, 3, [l.height]], [259, 3, [l.compression ?? 7]], [322, 3, [l.tw]], [323, 3, [l.th]],
    [324, 4, l.offsets], [325, 4, l.counts], ...(l.tables ? [[347, 7, l.tables] as Entry] : []),
  ];
  const size = { 3: 2, 4: 4, 7: 1 } as Record<number, number>;
  let pos = 8;
  const starts = levels.map((l) => { const at = pos; pos += 2 + entries(l).length * 12 + 4; return at; });
  const out = new Uint8Array(pos + 4096 + levels.reduce((n, l) => n + 4 * (l.offsets.length + l.counts.length) + (l.tables?.length ?? 0) + 8, 0));
  const view = new DataView(out.buffer);
  out.set(little ? [0x49, 0x49] : [0x4d, 0x4d], 0);
  view.setUint16(2, 42, little);
  view.setUint32(4, starts[0]!, little);
  let data = pos;
  const put = (at: number, type: number, values: number[]) => values.forEach((v, k) => {
    if (type === 3) view.setUint16(at + 2 * k, v, little);
    else if (type === 4) view.setUint32(at + 4 * k, v, little);
    else view.setUint8(at + k, v);
  });
  levels.forEach((l, li) => {
    const list = entries(l);
    const base = starts[li]!;
    view.setUint16(base, list.length, little);
    list.forEach(([tag, type, values], i) => {
      const at = base + 2 + i * 12;
      view.setUint16(at, tag, little); view.setUint16(at + 2, type, little); view.setUint32(at + 4, values.length, little);
      const bytes = size[type]! * values.length;
      if (bytes <= 4) put(at + 8, type, values);
      else { view.setUint32(at + 8, data, little); put(data, type, values); data += bytes + (bytes % 2); }
    });
    view.setUint32(base + 2 + list.length * 12, li + 1 < levels.length ? starts[li + 1]! : 0, little);
  });
  return out.slice(0, data);
}

const TABLES = [0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x01, 0xff, 0xd9];
const sample: Spec[] = [
  { width: 1000, height: 600, tw: 512, th: 512, offsets: [900, 950, 1000, 1050], counts: [50, 50, 50, 50], tables: TABLES },
  { width: 500, height: 300, tw: 512, th: 512, offsets: [100], counts: [700], tables: TABLES },
];

describe('parseCogHeader', () => {
  for (const little of [true, false]) {
    it(`reads the levels, tiles and tables (${little ? 'little' : 'big'}-endian)`, () => {
      const levels = parseCogHeader(buildTiff(sample, little));
      assert.equal(levels.length, 2);
      assert.deepEqual(levels.map((l) => [l.width, l.height]), [[1000, 600], [500, 300]]);
      assert.equal(levels[0]!.tileWidth, 512);
      assert.equal(levels[0]!.compression, 7);
      assert.deepEqual(levels[0]!.offsets, [900, 950, 1000, 1050]);
      assert.deepEqual(levels[0]!.byteCounts, [50, 50, 50, 50]);
      assert.deepEqual(levels[1]!.offsets, [100]);
      assert.deepEqual([...levels[0]!.jpegTables!], TABLES);
    });
  }

  it('asks for more bytes when the header is cut short', () => {
    const whole = buildTiff(sample);
    assert.throws(() => parseCogHeader(whole.slice(0, 30)), NeedMoreBytes);
    assert.throws(() => parseCogHeader(whole.slice(0, whole.length - 20)), NeedMoreBytes);
    assert.doesNotThrow(() => parseCogHeader(whole));
  });

  it('refuses what it cannot read', () => {
    assert.throws(() => parseCogHeader(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), /not a TIFF/);
    const big = buildTiff(sample);
    new DataView(big.buffer).setUint16(2, 43, true);
    assert.throws(() => parseCogHeader(big), /BigTIFF/);
    const striped = buildTiff([{ ...sample[0]!, offsets: [], counts: [] }]);
    assert.throws(() => parseCogHeader(striped), /tiled|offsets/);
  });
});

const level = (width: number, height: number, start: number, span: number): CogLevel => ({
  width, height, tileWidth: 512, tileHeight: 512, compression: 7, offsets: [start, start + span - 10], byteCounts: [10, 10], jpegTables: null,
});
// A landscape photo shaped like the real ones: overviews first in the file, the full size last.
const landscape = [level(10300, 7700, 12_000_000, 41_000_000), level(5150, 3850, 1_000_000, 11_000_000), level(2575, 1925, 640_000, 2_700_000), level(1287, 962, 5_600, 642_000)];

describe('tileRange', () => {
  it('spans the first tile to the end of the last', () => {
    assert.deepEqual(tileRange(level(1287, 962, 5_600, 642_000)), { start: 5_600, end: 5_600 + 642_000 });
  });
});

describe('pickLevel', () => {
  const pick = (w: number, h: number, dpr: number, maxBytes = 12_000_000) => pickLevel(landscape, w, h, dpr, maxBytes).width;

  it('takes the smallest level that covers the pixels on screen', () => {
    assert.equal(pick(700, 800, 1), 1287);
    assert.equal(pick(700, 800, 2), 2575);
    assert.equal(pick(1200, 900, 1), 1287); // a 900 px tall box limits the photo to 1204 px wide
  });

  it('is limited by the box height for a tall box', () => {
    assert.equal(pick(2000, 500, 1), 1287); // 500 px tall shows the photo 669 px wide
  });

  it('never goes over the byte budget, and falls back to the largest affordable level', () => {
    assert.equal(pick(6000, 6000, 1), 5150); // the full-size level is 41 MB, over budget
    assert.equal(pick(6000, 6000, 1, 1_000_000), 1287);
  });

  it('handles a portrait photo', () => {
    const portrait = [level(962, 1287, 5_600, 642_000), level(1925, 2575, 640_000, 2_700_000)];
    assert.equal(pickLevel(portrait, 800, 600, 1, 12_000_000).width, 962); // 600 px tall shows it 448 px wide
    assert.equal(pickLevel(portrait, 800, 1400, 2, 12_000_000).width, 1925);
  });
});

describe('tileJpeg', () => {
  it('puts the tables in front of the tile and drops the extra markers', () => {
    const tile = Uint8Array.from([0xff, 0xd8, 0xaa, 0xbb, 0xff, 0xd9]);
    const out = tileJpeg(Uint8Array.from(TABLES), tile);
    assert.deepEqual([...out], [0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x01, 0xaa, 0xbb, 0xff, 0xd9]);
  });

  it('returns a tile unchanged when the file has no tables', () => {
    const tile = Uint8Array.from([0xff, 0xd8, 0x01, 0xff, 0xd9]);
    assert.equal(tileJpeg(null, tile), tile);
  });

  it('refuses malformed input', () => {
    assert.throws(() => tileJpeg(Uint8Array.from([0xff, 0xd8, 0x01]), Uint8Array.from([0xff, 0xd8, 0x01])), /EOI/);
    assert.throws(() => tileJpeg(Uint8Array.from(TABLES), Uint8Array.from([0x01, 0x02, 0x03])), /SOI/);
  });
});

// A fake network for a 1000-byte file whose byte at offset n is n % 251, so every range has its own content.
const FILE = Uint8Array.from({ length: 1000 }, (_, n) => n % 251);
const URL_ = 'https://example.test/photo.tif';

type Behavior = (call: { start: number; end: number; attempt: number; signal: AbortSignal | null | undefined }) => Promise<Response> | null;

/** Answers ranges of FILE, unless `behavior` returns something for that call. Counts calls per range start. */
function fakeFetch(behavior: Behavior = () => null) {
  const calls = new Map<number, number>();
  const impl = (async (_url: unknown, init?: RequestInit) => {
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get('Range')!)!;
    const start = Number(a), end = Number(b) + 1;
    const attempt = (calls.get(start) ?? 0) + 1;
    calls.set(start, attempt);
    if (start >= FILE.length) return new Response('', { status: 416 }); // like S3, for a range past the end
    const special = behavior({ start, end, attempt, signal: init?.signal });
    if (special) return special;
    return new Response(FILE.slice(start, Math.min(end, FILE.length)), { status: 206 });
  }) as typeof fetch;
  return { impl, calls };
}
/** A response that never arrives, until the request is abandoned. */
const stall = (signal: AbortSignal | null | undefined) =>
  new Promise<Response>((_, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));

describe('planChunks', () => {
  it('splits a range into consecutive pieces', () => {
    assert.deepEqual(planChunks(0, 10, 4), [{ start: 0, end: 4 }, { start: 4, end: 8 }, { start: 8, end: 10 }]);
    assert.deepEqual(planChunks(5, 9, 4), [{ start: 5, end: 9 }]);
    assert.deepEqual(planChunks(3, 3, 4), []);
  });
});

describe('fetchBytes', () => {
  it('joins the chunks in order', async () => {
    const { impl, calls } = fakeFetch();
    const out = await fetchBytes(URL_, 100, 700, { chunkSize: 128, fetchImpl: impl });
    assert.deepEqual([...out], [...FILE.subarray(100, 700)]);
    assert.equal(calls.size, 5); // 600 bytes in chunks of 128
  });

  it('asks again for a chunk that stalls, without waiting out the time limit', async () => {
    const { impl, calls } = fakeFetch(({ start, attempt, signal }) => (start === 356 && attempt === 1 ? stall(signal) : null));
    const t0 = Date.now();
    const out = await fetchBytes(URL_, 100, 700, { chunkSize: 128, timeoutMs: 400, hedgeMs: 30, fetchImpl: impl });
    assert.deepEqual([...out], [...FILE.subarray(100, 700)]);
    assert.equal(calls.get(356), 2, 'the stalled chunk was asked for twice');
    assert.ok(Date.now() - t0 < 300, 'the second request answered long before the 400 ms limit');
  });

  it('lets the first request win if it finishes after the second was started', async () => {
    let release: (() => void) | undefined;
    const { impl, calls } = fakeFetch(({ start, attempt, signal }) => start === 0 && attempt === 1
      ? new Promise<Response>((resolve, reject) => {
          release = () => resolve(new Response(FILE.slice(0, 50), { status: 206 }));
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })
      : start === 0 && attempt === 2 ? stall(signal) : null);
    const pending = fetchBytes(URL_, 0, 50, { hedgeMs: 20, timeoutMs: 1000, retries: 1, fetchImpl: impl }); // two attempts: the second one stalls
    setTimeout(() => release?.(), 80);
    assert.deepEqual([...await pending], [...FILE.subarray(0, 50)]);
    assert.equal(calls.get(0), 2);
  });

  it('gives up after the retries, and says which bytes', async () => {
    const { impl, calls } = fakeFetch(({ signal }) => stall(signal));
    await assert.rejects(fetchBytes(URL_, 0, 100, { chunkSize: 128, timeoutMs: 15, hedgeMs: 1000, retries: 1, fetchImpl: impl }), /bytes 0-99: gave up after 2 attempts/);
    assert.equal(calls.get(0), 2);
  });

  it('retries a server error but not a missing file or an ignored range', async () => {
    const flaky = fakeFetch(({ attempt }) => (attempt === 1 ? Promise.resolve(new Response('', { status: 503 })) : null));
    assert.deepEqual([...await fetchBytes(URL_, 0, 50, { fetchImpl: flaky.impl })], [...FILE.subarray(0, 50)]);
    assert.equal(flaky.calls.get(0), 2);

    for (const status of [404, 200]) {
      const { impl, calls } = fakeFetch(() => Promise.resolve(new Response('', { status })));
      await assert.rejects(fetchBytes(URL_, 0, 50, { fetchImpl: impl }), (e: unknown) => e instanceof HttpStatusError && e.status === status);
      assert.equal(calls.get(0), 1, `a ${status} is not asked for again`);
    }
  });

  it('reads a range that runs past the end of the file, as far as the file goes', async () => {
    const { impl } = fakeFetch();
    const out = await fetchBytes(URL_, 900, 1200, { chunkSize: 128, fetchImpl: impl }); // the 2nd and 3rd chunks are answered 416
    assert.equal(out.length, 100);
    assert.deepEqual([...out], [...FILE.subarray(900)]);
    assert.equal((await fetchBytes(URL_, 2000, 2100, { chunkSize: 128, fetchImpl: impl })).length, 0);
  });

  it('refuses a short chunk that is followed by more data', async () => {

    const short = fakeFetch(({ start }) => (start === 128 ? Promise.resolve(new Response(FILE.slice(128, 200), { status: 206 })) : null));
    await assert.rejects(fetchBytes(URL_, 0, 400, { chunkSize: 128, fetchImpl: short.impl }), /got 72 bytes, expected 128/);
  });

  it('stops at once, without retrying, when the caller cancels', async () => {
    const { impl, calls } = fakeFetch(({ signal }) => stall(signal));
    const caller = new AbortController();
    const pending = fetchBytes(URL_, 0, 100, { timeoutMs: 5000, fetchImpl: impl, signal: caller.signal });
    setTimeout(() => caller.abort(), 20);
    await assert.rejects(pending);
    assert.equal(calls.get(0), 1);
  });

  it('never has more than `concurrency` requests in flight', async () => {
    let now = 0, peak = 0;
    const { impl } = fakeFetch(() => {
      now++; peak = Math.max(peak, now);
      return new Promise<Response>((resolve) => setTimeout(() => { now--; resolve(new Response(new Uint8Array(10), { status: 206 })); }, 5));
    });
    await fetchBytes(URL_, 0, 80, { chunkSize: 10, concurrency: 3, fetchImpl: impl });
    assert.equal(peak, 3);
  });
});

/** A fake server for one file, answering range requests and noting each range asked for. */
function serve(file: Uint8Array) {
  const ranges: [number, number][] = [];
  const impl = (async (_url: unknown, init?: RequestInit) => {
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(new Headers(init?.headers).get('Range')!)!;
    const start = Number(a), end = Number(b) + 1;
    ranges.push([start, end]);
    if (start >= file.length) return new Response('', { status: 416 });
    return new Response(file.slice(start, Math.min(end, file.length)), { status: 206 });
  }) as typeof fetch;
  // One request per read, so `ranges` shows each read and not its chunks.
  return { net: { fetchImpl: impl, chunkSize: 1 << 30 }, ranges };
}

describe('readHeader', () => {
  it('reads a small header with one small request', async () => {
    const file = buildTiff(sample);
    const { net, ranges } = serve(file);
    const { levels, head, fetched } = await readHeader(URL_, 4096, net);
    assert.deepEqual(levels.map((l) => l.width), [1000, 500]);
    assert.deepEqual(ranges, [[0, 4096]]);
    assert.equal(head.length, file.length); // the file is shorter than the read
    assert.equal(fetched, file.length);
  });

  it('reads again with four times as much when the header is longer than the first read', async () => {
    const tiles = 3000; // two arrays of 3000 offsets are about 24 KB, so the header runs past 1 KB and 4 KB
    const big: Spec[] = [{ width: 512 * 60, height: 512 * 50, tw: 512, th: 512, offsets: Array.from({ length: tiles }, (_, i) => 100000 + i * 10), counts: Array(tiles).fill(10), tables: TABLES }];
    const file = buildTiff(big);
    assert.ok(file.length > 16384 && file.length < 65536, `the fixture is ${file.length} bytes`);
    const { net, ranges } = serve(file);
    const { levels } = await readHeader(URL_, 1024, net);
    assert.equal(levels[0]!.offsets.length, tiles);
    assert.deepEqual(ranges, [[0, 1024], [0, 4096], [0, 16384], [0, 65536]]);
  });

  it('gives up after 4 MiB instead of reading the whole file', async () => {
    const bad = new Uint8Array(64);
    bad.set([0x49, 0x49, 42, 0], 0);
    new DataView(bad.buffer).setUint32(4, 0x00ffffff, true); // the first directory is far beyond anything fetched
    const { net, ranges } = serve(bad);
    await assert.rejects(readHeader(URL_, 1024 * 1024, net), NeedMoreBytes);
    assert.deepEqual(ranges, [[0, 1024 * 1024], [0, 4 * 1024 * 1024]]);
  });

  it('passes other failures through', async () => {
    const { net } = serve(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    await assert.rejects(readHeader(URL_, 4096, net), /not a TIFF file/);
  });
});

// A photo like the 4.1-sensor obliques: 14144 x 10560, 512 px tiles, levels down to 442 wide.
function photoLevels(): CogLevel[] {
  const make = (width: number, height: number): CogLevel => {
    const across = Math.ceil(width / 512), down = Math.ceil(height / 512), n = across * down;
    return { width, height, tileWidth: 512, tileHeight: 512, compression: 7, offsets: Array.from({ length: n }, (_, i) => i * 1000), byteCounts: Array(n).fill(1000), jpegTables: null };
  };
  return [make(14144, 10560), make(7072, 5280), make(3536, 2640), make(1768, 1320), make(884, 660), make(442, 330)];
}

describe('tileGrid', () => {
  it('counts tiles across and down, rounding up', () => {
    assert.deepEqual(tileGrid(photoLevels()[0]!), { across: 28, down: 21 });
    assert.deepEqual(tileGrid(photoLevels()[5]!), { across: 1, down: 1 });
  });
});

describe('planRegion', () => {
  const levels = photoLevels();
  const region = { x0: 3000, y0: 2000, x1: 4400, y1: 3100 };

  it('reads the full-size level when the screen shows at least one pixel per photo pixel', () => {
    const plan = planRegion(levels, region, 1)!;
    assert.equal(plan.level.width, 14144);
    assert.deepEqual([plan.scaleX, plan.scaleY], [1, 1]);
    // columns 5 to 8 (3000/512 = 5.86, 4400/512 = 8.59) and rows 3 to 6 (2000/512 = 3.9, 3100/512 = 6.05)
    assert.deepEqual(plan.rect, { x: 5 * 512, y: 3 * 512, width: 4 * 512, height: 4 * 512 });
    assert.equal(plan.tiles.length, 16);
    assert.deepEqual(plan.tiles[0], { index: 3 * 28 + 5, col: 5, row: 3 });
    assert.deepEqual(plan.tiles[15], { index: 6 * 28 + 8, col: 8, row: 6 });
  });

  it('takes the smallest level with enough pixels for a coarser zoom', () => {
    assert.equal(planRegion(levels, region, 0.5)!.level.width, 7072);
    assert.equal(planRegion(levels, region, 0.3)!.level.width, 7072); // 3536 is 0.25, too few
    assert.equal(planRegion(levels, region, 0.25)!.level.width, 3536);
    assert.equal(planRegion(levels, region, 0.0625)!.level.width, 884);
    assert.equal(planRegion(levels, region, 0.001)!.level.width, 442); // the coarsest there is
  });

  it('takes a smaller level when a lower share of the wanted pixels will do (thumbnails)', () => {
    assert.equal(planRegion(levels, region, 0.088)!.level.width, 1768); // 90%: 0.079 needs the 0.125 level (1768)
    assert.equal(planRegion(levels, region, 0.088, 30, 4096, 0.6)!.level.width, 884); // 60%: 0.053 is met by 0.0625 (884)
    assert.equal(planRegion(levels, region, 0.088, 30, 4096, 1)!.level.width, 1768); // exactly 0.088 is still met by 0.125
  });

  it('asks for the full-size level even when the screen shows more than one pixel per photo pixel', () => {
    assert.equal(planRegion(levels, region, 3)!.level.width, 14144);
  });

  it('covers the region with whole tiles, in the level\'s own pixels', () => {
    const plan = planRegion(levels, region, 0.5)!;
    assert.deepEqual([plan.scaleX, plan.scaleY], [0.5, 0.5]);
    const covered = { x0: plan.rect.x / 0.5, x1: (plan.rect.x + plan.rect.width) / 0.5, y0: plan.rect.y / 0.5, y1: (plan.rect.y + plan.rect.height) / 0.5 };
    assert.ok(covered.x0 <= region.x0 && covered.x1 >= region.x1 && covered.y0 <= region.y0 && covered.y1 >= region.y1);
  });

  it('clips at the edge of the photo, where the last tile is partial', () => {
    const plan = planRegion(levels, { x0: 13500, y0: 10000, x1: 20000, y1: 20000 }, 1)!;
    assert.deepEqual(plan.rect, { x: 26 * 512, y: 19 * 512, width: 14144 - 26 * 512, height: 10560 - 19 * 512 });
    assert.deepEqual(plan.tiles.map((t) => [t.col, t.row]), [[26, 19], [27, 19], [26, 20], [27, 20]]);
  });

  it('gives up on detail rather than read too many tiles: a smaller level when the region is big', () => {
    const whole = { x0: 0, y0: 0, x1: 14144, y1: 10560 };
    const plan = planRegion(levels, whole, 1, 30)!; // 588 tiles at full size
    assert.ok(plan.tiles.length <= 30, `${plan.tiles.length} tiles`);
    assert.ok(plan.level.width < 14144);
    assert.ok(plan.rect.width <= 4096 && plan.rect.height <= 4096);
  });

  it('keeps the canvas within what a graphics card can hold', () => {
    const plan = planRegion(levels, { x0: 0, y0: 0, x1: 7000, y1: 3000 }, 1, 1000, 4096)!;
    assert.ok(plan.rect.width <= 4096 && plan.rect.height <= 4096, `${plan.rect.width} x ${plan.rect.height}`);
  });

  it('returns null for an empty region or one outside the photo', () => {
    assert.equal(planRegion(levels, { x0: 5, y0: 5, x1: 5, y1: 100 }, 1), null);
    assert.equal(planRegion(levels, { x0: 20000, y0: 0, x1: 30000, y1: 500 }, 1), null);
    assert.equal(planRegion(levels, { x0: -500, y0: -500, x1: -10, y1: -10 }, 1), null);
  });

  it('works on a photo with few levels (10300 x 7700, smallest 1287 wide)', () => {
    const three = (w: number, h: number): CogLevel => { const n = Math.ceil(w / 512) * Math.ceil(h / 512); return { width: w, height: h, tileWidth: 512, tileHeight: 512, compression: 7, offsets: Array.from({ length: n }, (_, i) => i), byteCounts: Array(n).fill(1), jpegTables: null }; };
    const plan = planRegion([three(10300, 7700), three(5150, 3850), three(2575, 1925), three(1287, 962)], { x0: 100, y0: 100, x1: 900, y1: 700 }, 0.1)!;
    assert.equal(plan.level.width, 1287); // 0.125 is enough for 0.1
  });
});
