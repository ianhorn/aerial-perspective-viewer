import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type CogLevel, fetchBytes, HttpStatusError, NeedMoreBytes, parseCogHeader, pickLevel, planChunks, tileJpeg, tileRange } from '../src/cog.ts';

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
  const out = new Uint8Array(pos + 4096);
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
