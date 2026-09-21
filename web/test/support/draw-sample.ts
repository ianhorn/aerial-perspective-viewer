import type { DrawFeature } from '../../src/draw-model.ts';

/** One of each kind of feature, with awkward text in the labels and notes (quotes, a newline, accents, a symbol, a comma), for the export tests. */
export const SAMPLE: DrawFeature[] = [
  { id: 'pt-1', kind: 'point', coordinates: [[-85.7, 38.2]], properties: { label: 'Gate "A", north', notes: '', color: '#e53935' }, createdAt: '2026-09-20T12:00:00.000Z' },
  { id: 'tx-1', kind: 'text', coordinates: [[-85.6, 38.3]], properties: { label: 'Staging area', notes: 'two\nlines, ünïcode ✓', color: '#1e88e5' }, createdAt: '2026-09-20T12:01:00.000Z' },
  { id: 'ln-1', kind: 'line', coordinates: [[-85.7, 38.2], [-85.65, 38.25], [-85.6, 38.24]], properties: { label: 'Access road', notes: 'gravel', color: '#fb8c00' }, createdAt: '2026-09-20T12:02:00.000Z' },
  { id: 'pg-1', kind: 'polygon', coordinates: [[-85.72, 38.1], [-85.68, 38.1], [-85.66, 38.14], [-85.7, 38.16], [-85.73, 38.13]], properties: { label: 'Parcel 7', notes: '', color: '#43a047' }, createdAt: '2026-09-20T12:03:00.000Z' },
  { id: 'rc-1', kind: 'rectangle', coordinates: [[-85.5, 38.1], [-85.45, 38.1], [-85.45, 38.13], [-85.5, 38.13]], properties: { label: '', notes: '', color: '#8e24aa' }, createdAt: '2026-09-20T12:04:00.000Z' },
  { id: 'ci-1', kind: 'circle', coordinates: [[-85.75, 38.25]], radiusM: 300, properties: { label: 'Pond', notes: 'about 2 acres', color: '#212121' }, createdAt: '2026-09-20T12:05:00.000Z' },
];
