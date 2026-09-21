import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Progress, Summary } from '../src/pc-load.ts';
import type { Report } from '../src/pc-session.ts';
import { heightLabel, statusLines } from '../src/pc-text.ts';

const report = (over: Partial<Report>): Report => ({ state: 'idle', progress: null, points: 0, summaries: [], notes: [], error: null, ...over });
const progress = (over: Partial<Progress>): Progress => ({ stage: 'loading', loadedNodes: 0, loadedPoints: 0, ...over });
const summary = (over: Partial<Summary> = {}): Summary => ({ tiles: { phase3: 1, phase2: 2 }, depth: 4, deepest: 4, points: 1, bytes: 12 * 1_048_576, failed: 0, skipped: 0, over: false, ...over });

describe('what the point cloud card says', () => {
  it('says nothing before anything is loaded', () => {
    assert.deepEqual(statusLines(report({})), []);
  });

  it('follows the stages of a load', () => {
    assert.deepEqual(statusLines(report({ state: 'loading' })), ['Searching the catalogue for point clouds…']);
    assert.deepEqual(statusLines(report({ state: 'loading', progress: progress({ stage: 'searching' }) })), ['Searching the catalogue for point clouds…']);
    assert.deepEqual(statusLines(report({ state: 'loading', progress: progress({ stage: 'reading', tiles: { phase3: 1, phase2: 2 } }) })), ['Found 3 tiles (1 from Phase 3, 2 from Phase 2). Reading their layout…']);
    assert.deepEqual(statusLines(report({ state: 'loading', progress: progress({ stage: 'reading', tiles: { phase3: 0, phase2: 1 } }) })), ['Found 1 tile (1 from Phase 2). Reading their layout…']);
  });

  it('shows blocks and points loaded against the plan, and whether it is the full detail', () => {
    const plan = { depth: 3, deepest: 5, points: 3_400_000, bytes: 18 * 1_048_576, nodes: 120, over: false };
    const lines = statusLines(report({ state: 'loading', progress: progress({ plan, loadedNodes: 30, loadedPoints: 850_000 }) }));
    assert.equal(lines[0], 'Loading 30 of 120 blocks: 850,000 of about 3.4 million points (18 MB).');
    assert.equal(lines[1], 'Detail level 4 of 6, as much as fits.');
    const full = statusLines(report({ state: 'loading', progress: progress({ plan: { ...plan, depth: 5 }, loadedNodes: 1 }) }));
    assert.equal(full[1], 'The full detail of this area.');
  });

  it('does not fall over when a load finishes with nothing to read (no tile covers the area)', () => {
    assert.deepEqual(statusLines(report({ state: 'loading', progress: progress({ stage: 'done', tiles: { phase3: 0, phase2: 0 } }) })), []);
  });

  it('says what is on the map once a load is over, in millions when large', () => {
    assert.deepEqual(statusLines(report({ points: 10_000, summaries: [summary()] })), ['On the map: 10,000 points.', 'The last load: 3 tiles (1 from Phase 3, 2 from Phase 2), 12 MB downloaded.']);
    assert.equal(statusLines(report({ points: 3_456_789, summaries: [summary()] }))[0], 'On the map: 3.5 million points.');
    assert.equal(statusLines(report({ points: 12_300_000, summaries: [summary()] }))[0], 'On the map: 12 million points.');
    assert.equal(statusLines(report({ points: 2_000_000, summaries: [summary(), summary()] }))[0], 'On the map: 2.0 million points from 2 loads.');
  });

  it('says so when a load found nothing, and formats heights', () => {
    assert.deepEqual(statusLines(report({ summaries: [summary({ tiles: { phase3: 0, phase2: 0 } })] })), ['Nothing was loaded.']);
    assert.equal(heightLabel(412.4), '412 ft');
    assert.equal(heightLabel(1234.6), '1,235 ft');
  });
});
