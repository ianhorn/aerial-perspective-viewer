import type { FramePick, Look } from './api.ts';

export const LOOKS: { id: Look; label: string }[] = [
  { id: 'down', label: 'Down' },
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

export interface FrameSummary {
  /** One line: which way the photo looks. */
  title: string;
  /** Plain facts about the photo. */
  facts: string[];
  /** Caveats the viewer should know about, in words. */
  notes: string[];
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
  if (!frame.eligible) notes.push('The point is near the edge of this photo, or the resolution is coarse there.');
  if (frame.isReflight) notes.push('From a later re-flight of the line.');
  return { title, facts, notes };
}
