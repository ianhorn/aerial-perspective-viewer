import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { FramePick } from '../src/api.ts';
import { compassName, describeFrame, NEAR_EDGE_NOTE, sharesEdgeNote } from '../src/describe.ts';

const frame = (over: Partial<FramePick> = {}): FramePick => ({
  pick: 1, filename: 'KY_KYAPED_2023_Season1_3IN/Fwd_1_1.tif', url: 'https://example.test/f.tif', camera: 'Fwd',
  lookAzimuth: 359.7, azOff: 0.3, azOk: true, eligible: true, isReflight: false, flownUtc: '2023-04-19T17:09:37Z',
  passId: 'p', shot: 1, centerDistFt: 268, edgeFrac: 0.37, estGsdFt: 0.202, ...over,
});

describe('compassName', () => {
  it('names the eight winds and wraps', () => {
    assert.equal(compassName(0), 'north');
    assert.equal(compassName(359.7), 'north');
    assert.equal(compassName(44), 'northeast');
    assert.equal(compassName(90), 'east');
    assert.equal(compassName(225), 'southwest');
    assert.equal(compassName(-90), 'west');
    assert.equal(compassName(720 + 180), 'south');
  });
});

describe('describeFrame', () => {
  it('describes a good pick with no caveats', () => {
    const s = describeFrame(frame(), 'north', true);
    assert.equal(s.title, 'Looking north');
    assert.deepEqual(s.facts, ['Fwd camera', 'flown 2023-04-19', 'about 0.20 ft per pixel here']);
    assert.deepEqual(s.notes, []);
  });

  it('says so when no photo looks the requested way', () => {
    const s = describeFrame(frame({ camera: 'Left', lookAzimuth: 90, azOff: 89.6, azOk: false }), 'north', false);
    assert.equal(s.title, 'Looking east');
    assert.match(s.notes[0]!, /No photo here looks north\. This is the closest, 90° away\./);
  });

  it('does not claim to be the closest when other photos do look the requested way', () => {
    const s = describeFrame(frame({ camera: 'Right', lookAzimuth: 270, azOff: 89.4, azOk: false }), 'north', true);
    assert.equal(s.notes[0], 'Looks 89° away from north.');
    assert.ok(!s.notes.join(' ').includes('closest'));
  });

  it('does not complain about direction when looking down', () => {
    const s = describeFrame(frame({ camera: 'Color', lookAzimuth: null, azOff: 0 }), 'down', true);
    assert.equal(s.title, 'Straight down');
    assert.deepEqual(s.notes, []);
  });

  it('flags edge or coarse resolution, and reflights', () => {
    const s = describeFrame(frame({ eligible: false, isReflight: true, estGsdFt: null }), 'north', true);
    assert.equal(s.notes.length, 2);
    assert.ok(s.facts.every((fact) => !fact.includes('per pixel')));
  });
});

describe('sharing the near-the-edge note', () => {
  const summary = (eligible: boolean) => describeFrame(frame({ eligible }), 'north', true);

  it('marks which summaries carry the note', () => {
    assert.equal(summary(false).nearEdge, true);
    assert.ok(summary(false).notes.includes(NEAR_EDGE_NOTE));
    assert.equal(summary(true).nearEdge, false);
  });

  it('shares it only when two or more photos have it', () => {
    assert.equal(sharesEdgeNote([]), false);
    assert.equal(sharesEdgeNote([summary(true), summary(true)]), false);
    assert.equal(sharesEdgeNote([summary(true), summary(false), summary(true)]), false); // one keeps its own note
    assert.equal(sharesEdgeNote([summary(false), summary(true), summary(false)]), true);
    assert.equal(sharesEdgeNote([summary(false), summary(false), summary(false), summary(false), summary(false)]), true);
  });

  it('ignores other notes', () => {
    const away = describeFrame(frame({ azOk: false, azOff: 60 }), 'north', true);
    const reflight = describeFrame(frame({ isReflight: true }), 'north', true);
    assert.equal(sharesEdgeNote([away, reflight, away, reflight]), false);
  });
});
