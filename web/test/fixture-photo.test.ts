import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCogHeader, tileJpeg } from '../src/cog.ts';
import { buildPhoto, flatTile, JPEG_TABLES, PALETTE, rangeOf, tileColour } from '../e2e/fixture-photo.ts';

// The photo the browser tests are served (e2e/fixture-photo.ts) has to be a file the app's own reader accepts, and its
// tiles real JPEG streams the browser can decode (checked separately against Pillow, an independent decoder).

describe('the made-up photo', () => {
  const photo = buildPhoto(14144, 10560);

  it('is read by the app\'s own TIFF reader, largest level first, down to under 1,000 px wide', () => {
    const levels = parseCogHeader(photo.bytes);
    assert.deepEqual(levels.map((l) => [l.width, l.height]), [[14144, 10560], [7072, 5280], [3536, 2640], [1768, 1320], [884, 660]]);
    assert.deepEqual(levels.map((l) => l.offsets.length), [28 * 21, 14 * 11, 7 * 6, 4 * 3, 2 * 2]);
    for (const level of levels) {
      assert.equal(level.compression, 7);
      assert.equal(level.tileWidth, 512);
      assert.equal(level.tileHeight, 512);
      assert.equal(level.offsets.length, level.byteCounts.length);
    }
  });

  it('is small, because tiles of one colour share their bytes', () => {
    assert.ok(photo.bytes.length < 100_000, `${photo.bytes.length} bytes`);
    const level = parseCogHeader(photo.bytes)[0]!;
    assert.ok(new Set(level.offsets).size <= PALETTE.length);
  });

  it('puts each tile\'s colour where the pattern says, in every level', () => {
    for (const level of parseCogHeader(photo.bytes)) {
      const across = Math.ceil(level.width / 512);
      level.offsets.forEach((offset, i) => {
        const expected = flatTile(PALETTE[tileColour(i % across, Math.floor(i / across))]!);
        assert.deepEqual(photo.bytes.subarray(offset, offset + level.byteCounts[i]!), expected);
      });
    }
  });

  it('has tiles that become whole JPEG streams once the shared tables are put back', () => {
    const level = parseCogHeader(photo.bytes)[0]!;
    const tile = photo.bytes.subarray(level.offsets[0]!, level.offsets[0]! + level.byteCounts[0]!);
    const stream = tileJpeg(level.jpegTables, tile);
    assert.deepEqual([...stream.subarray(0, 2)], [0xff, 0xd8]);
    assert.deepEqual([...stream.subarray(-2)], [0xff, 0xd9]);
    assert.deepEqual(level.jpegTables, JPEG_TABLES);
    // one start of frame, one start of scan, and no 0xff data byte left unstuffed inside the scan
    const marks = [...stream].map((b, i) => (b === 0xff ? stream[i + 1] : -1));
    assert.equal(marks.filter((m) => m === 0xc0).length, 1);
    assert.equal(marks.filter((m) => m === 0xda).length, 1);
  });

  it('makes portrait photos for the side cameras too', () => {
    const levels = parseCogHeader(buildPhoto(10560, 14144).bytes);
    assert.deepEqual([levels[0]!.width, levels[0]!.height], [10560, 14144]);
    assert.deepEqual([levels.at(-1)!.width, levels.at(-1)!.height], [660, 884]);
  });
});

describe('answering a range request as a bucket does', () => {
  const bytes = new Uint8Array(1000).map((_, i) => i % 256);
  it('gives the bytes asked for, with the range they are of', () => {
    const r = rangeOf(bytes, 'bytes=10-19');
    assert.equal(r.status, 206);
    assert.equal(r.headers['content-range'], 'bytes 10-19/1000');
    assert.deepEqual([...r.body], [...bytes.subarray(10, 20)]);
  });
  it('clips a range that runs past the end, and answers 416 for one that starts there', () => {
    assert.equal(rangeOf(bytes, 'bytes=990-2000').headers['content-range'], 'bytes 990-999/1000');
    assert.equal(rangeOf(bytes, 'bytes=1000-1010').status, 416);
  });
  it('gives the whole file for no range, and the last bytes for a suffix range', () => {
    assert.equal(rangeOf(bytes, undefined).body.length, 1000);
    assert.deepEqual([...rangeOf(bytes, 'bytes=-4').body], [...bytes.subarray(996)]);
  });
});
