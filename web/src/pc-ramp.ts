// The colours for a point cloud coloured by height: one ramp, used by the map's shader and by the legend on the card, so they cannot
// disagree. It is viridis (perceptually even, and readable with the common kinds of colour blindness), sampled at five stops.
// No DOM here.

/** The stops from low to high, evenly spaced, as [r, g, b] in 0 to 255. (Viridis at 0, 0.25, 0.5, 0.75 and 1.) */
export const RAMP: readonly (readonly [number, number, number])[] = [
  [68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37],
];

/** The colour a height fraction (0 lowest to 1 highest, clamped) gets, as [r, g, b] in 0 to 255. */
export function rampColor(t: number): [number, number, number] {
  const x = Math.min(Math.max(Number.isFinite(t) ? t : 0, 0), 1) * (RAMP.length - 1);
  const i = Math.min(Math.floor(x), RAMP.length - 2);
  const f = x - i;
  const a = RAMP[i]!, b = RAMP[i + 1]!;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

/** A CSS gradient of the ramp, from low (left) to high (right), for the legend. */
export const RAMP_CSS = `linear-gradient(to right, ${RAMP.map((c, i) => `rgb(${c.join(',')}) ${(i / (RAMP.length - 1)) * 100}%`).join(', ')})`;

/**
 * The height range a ramp should span for a set of heights: the 2nd to the 98th percentile, so that a few stray points (a bird, a
 * cable, a low outlier) do not squash everything else into one colour. Sorts a copy; pass a sample for a very large set.
 */
export function heightRange(heights: ArrayLike<number>): [number, number] | null {
  const values = Array.from(heights).filter(Number.isFinite).sort((a, b) => a - b);
  if (values.length === 0) return null;
  const at = (p: number): number => values[Math.min(values.length - 1, Math.floor(p * (values.length - 1)))]!;
  const lo = at(0.02), hi = at(0.98);
  return hi > lo ? [lo, hi] : [lo, lo + 1];
}
