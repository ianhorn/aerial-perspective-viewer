import type { FramePick, Look } from './api.ts';

// The directions the panel offers. There is no "Down": the Color (nadir) camera was fired with the obliques
// and is the source of the Phase 3 orthoimagery, which the basemap already shows at close zoom. The API
// still supports `look=down`.
export const LOOKS: { id: Look; label: string }[] = [
  { id: 'north', label: 'North' },
  { id: 'east', label: 'East' },
  { id: 'south', label: 'South' },
  { id: 'west', label: 'West' },
];

const WINDS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

/** The eight-point compass name for a bearing in degrees. */
export function compassName(bearing: number): string {
  const wrapped = ((bearing % 360) + 360) % 360;
  return WINDS[Math.round(wrapped / 45) % 8]!;
}

/** The caveat for a point near a photo's edge or where it is coarse. Also shown once under the list when several photos share it. */
export const NEAR_EDGE_NOTE = 'The point is near the edge of this photo, or the resolution is coarse there.';

export interface FrameSummary {
  /** One line: which way the photo looks. */
  title: string;
  /** Plain facts about the photo. */
  facts: string[];
  /** Caveats the viewer should know about, in words. */
  notes: string[];
  /** True when `notes` holds the near-the-edge caveat, so a list can show it once for several photos. */
  nearEdge: boolean;
}

/**
 * Put a ranked frame into words. `want` is the direction the user asked for, and `anyInTolerance` says
 * whether at least one photo in the list looks that way, which decides what an off-direction one means.
 */
export function describeFrame(frame: FramePick, want: Look, anyInTolerance: boolean): FrameSummary {
  const title = frame.lookAzimuth === null ? 'Straight down' : `Looking ${compassName(frame.lookAzimuth)}`;

  const facts = [`${frame.camera} camera`, `flown ${frame.flownUtc.slice(0, 10)}`];
  if (frame.estGsdFt !== null) facts.push(`about ${frame.estGsdFt.toFixed(2)} ft per pixel here`);

  const notes: string[] = [];
  if (!frame.azOk && want !== 'down') {
    const away = Math.round(frame.azOff ?? 0);
    notes.push(anyInTolerance
      ? `Looks ${away}° away from ${want}.`
      : `No photo here looks ${want}. This is the closest, ${away}° away.`);
  }
  if (!frame.eligible) notes.push(NEAR_EDGE_NOTE);
  if (frame.isReflight) notes.push('From a later re-flight of the line.');
  return { title, facts, notes, nearEdge: !frame.eligible };
}

/**
 * Whether a list should show the near-the-edge caveat once, with an asterisk on each photo it covers, instead
 * of repeating it: yes when two or more photos have it. A single photo keeps its own note.
 */
export function sharesEdgeNote(summaries: FrameSummary[]): boolean {
  return summaries.filter((summary) => summary.nearEdge).length >= 2;
}
