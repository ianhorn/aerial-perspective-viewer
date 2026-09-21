// The words on the point cloud card: what is happening, what is on the map, and what was limited. No DOM here.

import { MAX_AOI_SQ_MI } from './pc-aoi.ts';
import type { Report } from './pc-session.ts';

const n = (value: number): string => Math.round(value).toLocaleString('en-US');
const millions = (value: number): string => (value >= 1_000_000 ? `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)} million` : n(value));
const megabytes = (bytes: number): string => `${(bytes / 1_048_576).toFixed(bytes < 10_485_760 ? 1 : 0)} MB`;
const tileWords = (t: { phase3: number; phase2: number }): string => {
  const total = t.phase3 + t.phase2;
  const parts = [t.phase3 > 0 ? `${t.phase3} from Phase 3` : '', t.phase2 > 0 ? `${t.phase2} from Phase 2` : ''].filter(Boolean);
  return `${total} tile${total === 1 ? '' : 's'} (${parts.join(', ')})`;
};

/** What the card says about the state of things, one line each. */
export function statusLines(report: Report): string[] {
  const p = report.progress;
  if (report.state === 'loading') {
    if (!p || p.stage === 'searching') return ['Searching the catalogue for point clouds…'];
    if (p.stage === 'reading') return [`Found ${p.tiles ? tileWords(p.tiles) : 'tiles'}. Reading their layout…`];
    const plan = p.plan;
    if (!plan) return []; // finished with nothing to read (no tiles cover the area): the notes say so
    return [
      `Loading ${n(p.loadedNodes)} of ${n(plan.nodes)} blocks: ${millions(p.loadedPoints)} of about ${millions(plan.points)} points (${megabytes(plan.bytes)}).`,
      plan.depth < plan.deepest ? `Detail level ${plan.depth + 1} of ${plan.deepest + 1}, as much as fits.` : 'The full detail of this area.',
    ];
  }
  if (report.points === 0) return report.summaries.length > 0 ? ['Nothing was loaded.'] : [];
  const last = report.summaries.at(-1);
  const lines = [`On the map: ${millions(report.points)} points${report.summaries.length > 1 ? ` from ${report.summaries.length} loads` : ''}.`];
  if (last) lines.push(`The last load: ${tileWords(last.tiles)}, ${megabytes(last.bytes)} downloaded.`);
  if (report.refining) lines.push('Adding detail for this view…');
  return lines;
}

export const LIMITS_TEXT = `One load covers up to ${MAX_AOI_SQ_MI} square miles and reads about 4 million points to start; zooming in reads finer detail for what you see.`;

/** The heights at the ends of the legend, like "412 ft". */
export const heightLabel = (feet: number): string => `${n(feet)} ft`;
