// The `look` query parameter: the direction the camera should look.
//   north | east | south | west   a compass direction
//   down                          straight down (the nadir Color camera)
//   a number                      a bearing in degrees clockwise from north, any value; it is wrapped to 0-360
export interface Look {
  /** What the caller asked for, normalised for echoing back. */
  label: string;
  /** Compass bearing in degrees, or null for straight down. */
  azimuth: number | null;
}

const NAMED = new Map<string, number | null>([
  ['north', 0],
  ['east', 90],
  ['south', 180],
  ['west', 270],
  ['down', null],
]);

export function parseLook(raw: string): Look | null {
  const key = raw.trim().toLowerCase();
  if (NAMED.has(key)) return { label: key, azimuth: NAMED.get(key) ?? null };
  if (/^-?\d{1,4}(\.\d+)?$/.test(key)) {
    const bearing = Number(key);
    return { label: key, azimuth: ((bearing % 360) + 360) % 360 };
  }
  return null;
}
