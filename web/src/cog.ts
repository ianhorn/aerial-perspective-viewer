// Reading a photo from its Cloud Optimized GeoTIFF in the browser.
//
// The KyFromAbove oblique photos are tiled, JPEG-compressed COGs of about 40 MB, with a few smaller
// overview levels stored first in the file. So one HTTP range request from the start of the file
// gets the header and the smallest overview, and a second range gets a larger one. Each 512 px tile
// is a JPEG stream without its tables, and the file keeps one shared copy of the tables. Putting
// the tables back in front of a tile makes an ordinary JPEG the browser can decode itself.
//
// The photos are not georeferenced (their GeoTIFF tags are empty), so this only reads pixels.

export interface CogLevel {
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  /** TIFF compression code. 7 is JPEG. */
  compression: number;
  offsets: number[];
  byteCounts: number[];
  /** The shared JPEG tables (a complete JPEG stream that holds only tables), or null. */
  jpegTables: Uint8Array | null;
}

/** The fetched header ended before the tags we need. Fetch more of the file and try again. */
export class NeedMoreBytes extends Error {
  constructor() {
    super('the header is longer than the bytes fetched');
  }
}

const TAG = { width: 256, height: 257, compression: 259, tileWidth: 322, tileHeight: 323, offsets: 324, byteCounts: 325, jpegTables: 347 } as const;
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 7: 1 };

/**
 * Read the image directories of a classic (not Big) TIFF from the first bytes of the file, largest
 * level first, as they appear in the file. Throws NeedMoreBytes if a directory or one of its arrays
 * lies beyond the bytes given.
 */
export function parseCogHeader(bytes: Uint8Array): CogLevel[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = bytes[0] === 0x49 && bytes[1] === 0x49;
  if (!little && !(bytes[0] === 0x4d && bytes[1] === 0x4d)) throw new Error('not a TIFF file');
  if (view.getUint16(2, little) !== 42) throw new Error('only classic TIFF is supported (this looks like BigTIFF)');

  const levels: CogLevel[] = [];
  let ifd = view.getUint32(4, little);
  while (ifd !== 0) {
    if (ifd + 2 > bytes.length) throw new NeedMoreBytes();
    const count = view.getUint16(ifd, little);
    const end = ifd + 2 + count * 12 + 4;
    if (end > bytes.length) throw new NeedMoreBytes();

    const numbers = new Map<number, number[]>();
    let tables: Uint8Array | null = null;
    for (let i = 0; i < count; i++) {
      const entry = ifd + 2 + i * 12;
      const tag = view.getUint16(entry, little);
      if (!Object.values(TAG).includes(tag as never)) continue;
      const type = view.getUint16(entry + 2, little);
      const n = view.getUint32(entry + 4, little);
      const size = (TYPE_SIZE[type] ?? 1) * n;
      const at = size <= 4 ? entry + 8 : view.getUint32(entry + 8, little);
      if (at + size > bytes.length) throw new NeedMoreBytes();
      if (tag === TAG.jpegTables) {
        tables = bytes.slice(at, at + size);
        continue;
      }
      const values: number[] = [];
      for (let k = 0; k < n; k++) {
        if (type === 3) values.push(view.getUint16(at + 2 * k, little));
        else if (type === 4) values.push(view.getUint32(at + 4 * k, little));
        else values.push(view.getUint8(at + k));
      }
      numbers.set(tag, values);
    }

    const one = (tag: number, fallback?: number): number => {
      const value = numbers.get(tag)?.[0] ?? fallback;
      if (value === undefined) throw new Error(`the TIFF has no tag ${tag} (is it tiled?)`);
      return value;
    };
    const offsets = numbers.get(TAG.offsets);
    const byteCounts = numbers.get(TAG.byteCounts);
    if (!offsets || !byteCounts || offsets.length === 0 || offsets.length !== byteCounts.length) {
      throw new Error('the TIFF has no tile offsets (is it tiled?)');
    }
    levels.push({
      width: one(TAG.width), height: one(TAG.height), tileWidth: one(TAG.tileWidth), tileHeight: one(TAG.tileHeight),
      compression: one(TAG.compression, 1), offsets, byteCounts, jpegTables: tables,
    });
    ifd = view.getUint32(end - 4, little);
  }
  if (levels.length === 0) throw new Error('the TIFF has no image directories');
  return levels;
}

/** The byte range, end exclusive, that holds every tile of a level. Tiles of one level are stored together. */
export function tileRange(level: CogLevel): { start: number; end: number } {
  return {
    start: Math.min(...level.offsets),
    end: Math.max(...level.offsets.map((offset, i) => offset + level.byteCounts[i]!)),
  };
}

/**
 * Choose the smallest level that still has at least as many pixels as will be shown on screen, so a
 * small pane fetches a small file. `boxWidth` and `boxHeight` are the space in CSS pixels; the photo is
 * shown as large as fits in it. Falls back to the largest level within `maxBytes` when none is big enough.
 */
export function pickLevel(levels: CogLevel[], boxWidth: number, boxHeight: number, pixelRatio: number, maxBytes: number): CogLevel {
  const bySize = [...levels].sort((a, b) => a.width - b.width);
  const affordable = bySize.filter((level) => {
    const { start, end } = tileRange(level);
    return end - start <= maxBytes;
  });
  const pool = affordable.length > 0 ? affordable : [bySize[0]!];
  const enough = pool.find((level) => {
    const shownWidth = Math.min(boxWidth, boxHeight * (level.width / level.height));
    return level.width >= shownWidth * pixelRatio;
  });
  return enough ?? pool[pool.length - 1]!;
}

/** Put the shared tables back in front of one tile, which makes a complete JPEG stream. */
export function tileJpeg(tables: Uint8Array | null, tile: Uint8Array): Uint8Array {
  if (!tables) return tile;
  // A tables-only stream is SOI, tables, EOI. A tile is SOI, scan, EOI. Drop the tables' EOI and the tile's SOI.
  if (tables[tables.length - 2] !== 0xff || tables[tables.length - 1] !== 0xd9) throw new Error('the JPEG tables do not end with EOI');
  if (tile[0] !== 0xff || tile[1] !== 0xd8) throw new Error('a tile does not start with SOI');
  const out = new Uint8Array(tables.length - 2 + tile.length - 2);
  out.set(tables.subarray(0, tables.length - 2), 0);
  out.set(tile.subarray(2), tables.length - 2);
  return out;
}

/** The server answered with a status that will not get better by asking again. */
export class HttpStatusError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(`${detail} answered ${status}`);
    this.status = status;
  }
}

export interface FetchOptions {
  /** Bytes per request. Small requests finish quickly and lose little when one has to be repeated. */
  chunkSize?: number;
  /** An attempt that has not fully arrived by then is abandoned. */
  timeoutMs?: number;
  /** A chunk still not in after this long is asked for a second time, in parallel with the first. */
  hedgeMs?: number;
  /** Extra attempts per chunk after the first. */
  retries?: number;
  /** Chunks in flight at once. */
  concurrency?: number;
  signal?: AbortSignal;
  /** For tests. */
  fetchImpl?: typeof fetch;
}

// Measured against the KyFromAbove bucket from one machine: a 1 MiB range read sometimes stalled for
// 17-25 s after a normal first byte, while 64 KB and 256 KB reads did not. Normal 256 KB reads take
// well under a second, so asking again after 1.5 s (without giving up on the first request) turns a
// stall into a small delay, and a slow but steady connection is never cut off before the 8 s limit.
const FETCH_DEFAULTS = { chunkSize: 256 * 1024, timeoutMs: 8000, hedgeMs: 1500, retries: 2, concurrency: 6 };

/** Split [start, endExclusive) into consecutive ranges of at most chunkSize bytes. */
export function planChunks(start: number, endExclusive: number, chunkSize: number): { start: number; end: number }[] {
  const chunks: { start: number; end: number }[] = [];
  for (let at = start; at < endExclusive; at += chunkSize) chunks.push({ start: at, end: Math.min(at + chunkSize, endExclusive) });
  return chunks;
}

const retryable = (error: unknown): boolean => !(error instanceof HttpStatusError) || error.status >= 500 || error.status === 429;

/**
 * One chunk, with up to retries + 1 attempts. An attempt that fails or hits the time limit is replaced
 * at once. An attempt that is merely slow gets company: after hedgeMs a second identical request starts
 * while the first keeps going, and whichever finishes first wins. The others are then cancelled.
 */
function fetchChunk(url: string, start: number, endExclusive: number, o: Required<Omit<FetchOptions, 'signal'>> & { signal?: AbortSignal }): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const maxAttempts = o.retries + 1;
    const controllers: AbortController[] = [];
    let launched = 0;
    let failures = 0;
    let lastError: unknown;
    let settled = false;
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined;

    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(hedgeTimer);
      o.signal?.removeEventListener('abort', onCallerAbort);
      controllers.forEach((controller) => controller.abort()); // the losers
      finish();
    };
    const onCallerAbort = (): void => settle(() => reject(o.signal?.reason ?? new DOMException('aborted', 'AbortError')));

    const launch = (): void => {
      if (settled || launched >= maxAttempts) return;
      launched++;
      const controller = new AbortController();
      controllers.push(controller);
      const limit = setTimeout(() => controller.abort(), o.timeoutMs);
      clearTimeout(hedgeTimer);
      hedgeTimer = setTimeout(launch, o.hedgeMs);

      void (async () => {
        try {
          const response = await o.fetchImpl(url, { headers: { Range: `bytes=${start}-${endExclusive - 1}` }, signal: controller.signal });
          if (response.status === 416) return settle(() => resolve(new Uint8Array(0))); // the range starts past the end of the file
          if (response.status !== 206) {
            void response.body?.cancel(); // a server that ignores Range would send the whole 40 MB
            throw new HttpStatusError(response.status, `${url} to a range request`);
          }
          const bytes = new Uint8Array(await response.arrayBuffer());
          settle(() => resolve(bytes));
        } catch (error) {
          if (settled) return; // a loser that was cancelled, or a late failure after the winner
          if (!retryable(error)) return settle(() => reject(error)); // asking again cannot help
          lastError = error;
          failures++;
          if (failures >= maxAttempts) {
            settle(() => reject(new Error(`${url} bytes ${start}-${endExclusive - 1}: gave up after ${maxAttempts} attempts (${lastError})`)));
          } else if (launched < maxAttempts) {
            launch(); // replace the failed attempt at once
          }
        } finally {
          clearTimeout(limit);
        }
      })();
    };

    if (o.signal?.aborted) return onCallerAbort();
    o.signal?.addEventListener('abort', onCallerAbort, { once: true });
    launch();
  });
}

/**
 * Read bytes [start, endExclusive) of a file with several small range requests at once. Each one has
 * a time limit and is repeated if it stalls or fails. A file shorter than the range yields fewer bytes
 * (a chunk that starts past the end is answered 416 and counts as empty).
 */
export async function fetchBytes(url: string, start: number, endExclusive: number, options: FetchOptions = {}): Promise<Uint8Array> {
  const o = { ...FETCH_DEFAULTS, fetchImpl: globalThis.fetch.bind(globalThis), ...options };
  const chunks = planChunks(start, endExclusive, o.chunkSize);
  const parts: Uint8Array[] = new Array(chunks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < chunks.length) {
      const i = next++;
      const { start: a, end: b } = chunks[i]!;
      parts[i] = await fetchChunk(url, a, b, o);
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.concurrency, chunks.length) }, worker));

  // A chunk may come back short only where the file ends, and then nothing after it may have any bytes.
  let total = 0;
  parts.forEach((part, i) => {
    const wanted = chunks[i]!.end - chunks[i]!.start;
    const dataAfter = parts.slice(i + 1).some((later) => later.length > 0);
    if (part.length > wanted || (part.length < wanted && dataAfter)) {
      throw new Error(`${url} bytes ${chunks[i]!.start}-${chunks[i]!.end - 1}: got ${part.length} bytes, expected ${wanted}`);
    }
    total += part.length;
  });
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** Decode every tile of a level into one canvas. `blob` holds the bytes from `blobStart`. */
export async function decodeLevel(level: CogLevel, blob: Uint8Array, blobStart: number): Promise<HTMLCanvasElement> {
  if (level.compression !== 7) throw new Error(`tile compression ${level.compression} is not JPEG`);
  const canvas = document.createElement('canvas');
  canvas.width = level.width;
  canvas.height = level.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2D canvas context');
  const across = Math.ceil(level.width / level.tileWidth);
  await Promise.all(level.offsets.map(async (offset, i) => {
    const tile = blob.subarray(offset - blobStart, offset - blobStart + level.byteCounts[i]!);
    const bitmap = await createImageBitmap(new Blob([tileJpeg(level.jpegTables, tile) as BlobPart], { type: 'image/jpeg' }));
    context.drawImage(bitmap, (i % across) * level.tileWidth, Math.floor(i / across) * level.tileHeight);
    bitmap.close();
  }));
  return canvas;
}

export interface OverviewOptions {
  /** Space the photo will fill, in CSS pixels. */
  boxWidth: number;
  boxHeight: number;
  pixelRatio?: number;
  /** Never fetch a level bigger than this. */
  maxBytes?: number;
  signal?: AbortSignal;
  /** Chunk size, time limit and retries for the range requests. */
  fetch?: FetchOptions;
  /**
   * How much of the start of the file to read first. The default (1 MiB) also brings the smallest overview,
   * which suits a photo shown large. A header is only 8 to 24 KB, so a small picture can start with much less.
   */
  firstFetch?: number;
}

export interface Overview {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  /** Bytes fetched from the server, for information. */
  bytes: number;
}

// The header and the smallest overview normally sit in the first megabyte, so one read gets both.
const FIRST_FETCH = 1024 * 1024;
const MAX_HEADER = 4 * FIRST_FETCH;

/**
 * Read the start of a file and parse its TIFF directories. If they run past what was fetched, read again
 * with four times as much, up to 4 MiB. Returns the parsed levels and the bytes read (the last read, which
 * covers everything before it), and how many bytes were fetched in all.
 */
export async function readHeader(
  url: string, firstFetch: number, net: FetchOptions,
): Promise<{ levels: CogLevel[]; head: Uint8Array; fetched: number }> {
  let size = Math.min(Math.max(1, firstFetch), MAX_HEADER);
  let fetched = 0;
  for (;;) {
    const head = await fetchBytes(url, 0, size, net);
    fetched += head.length;
    try {
      return { levels: parseCogHeader(head), head, fetched };
    } catch (error) {
      if (!(error instanceof NeedMoreBytes) || size >= MAX_HEADER) throw error;
      size = Math.min(size * 4, MAX_HEADER);
    }
  }
}

/** Fetch and decode the overview of a photo that best fits the box, reading it in small parallel range requests. */
export async function loadOverview(url: string, options: OverviewOptions): Promise<Overview> {
  const { boxWidth, boxHeight, pixelRatio = 1, maxBytes = 12 * 1024 * 1024, signal, firstFetch = FIRST_FETCH } = options;
  const net: FetchOptions = { ...options.fetch, signal };
  const { levels, head, fetched } = await readHeader(url, firstFetch, net);
  let bytes = fetched;

  const level = pickLevel(levels, boxWidth, boxHeight, pixelRatio, maxBytes);
  const { start, end } = tileRange(level);
  let blob = head;
  let blobStart = 0;
  if (end > head.length) {
    blob = await fetchBytes(url, start, end, net);
    blobStart = start;
    bytes += blob.length;
  }
  return { canvas: await decodeLevel(level, blob, blobStart), width: level.width, height: level.height, bytes };
}
