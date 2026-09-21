// The settings a person can change: what each is, its range, its default, and where the choice is kept. Every setting is a number (a switch is 0 or 1) with a
// smallest and largest value and a step, so whatever is stored or typed is brought inside those (a stored value that is nonsense, or from an older version, cannot
// do harm). Kept in the browser's `localStorage`, only the ones that differ from the default. No DOM here.

import { browserStorage, type Store } from './draw-storage.ts';

export const SETTINGS_KEY = 'aerial-perspective-viewer.settings';
const VERSION = 1;

export type Group = 'Point cloud' | 'Photos';

export interface Def {
  label: string;
  /** What it does, and what a bigger value costs. */
  hint: string;
  group: Group;
  min: number;
  max: number;
  step: number;
  default: number;
  /** Shown after the number ("million", "MB"). */
  unit: string;
  /** A switch: 0 is off and 1 is on. */
  toggle?: boolean;
}

export const DEFS = {
  pcAreaSqMi: { label: 'Largest area per load', hint: 'A bigger view or rectangle is cut down to this, round its middle. Bigger areas read more files.', group: 'Point cloud', min: 0.25, max: 8, step: 0.25, default: 4, unit: 'square miles' },
  pcLoadMillions: { label: 'Points read per load', hint: 'How many points a load reads to start (an estimate). More is finer over a big area, and slower.', group: 'Point cloud', min: 0.5, max: 8, step: 0.5, default: 4, unit: 'million' },
  pcLoadMb: { label: 'Download per load', hint: 'The most a load fetches. Whichever of this and the points is reached first ends the load.', group: 'Point cloud', min: 8, max: 96, step: 8, default: 32, unit: 'MB' },
  pcTotalMillions: { label: 'Points on the map, most', hint: 'The most held at once, about 12 bytes of graphics memory each. When it is full, what is off the screen is dropped, and a new load asks you to clear.', group: 'Point cloud', min: 2, max: 20, step: 1, default: 12, unit: 'million' },
  pcTargetPx: { label: 'Space between points, zoomed in', hint: 'Finer detail is read until points are no farther apart than this on the screen. Smaller is denser, and reads more.', group: 'Point cloud', min: 1, max: 8, step: 0.5, default: 3, unit: 'px' },
  pcSizeScale: { label: 'Point size', hint: 'How big a dot is, against the gap between points. Smaller shows the ground between them.', group: 'Point cloud', min: 0.3, max: 2.5, step: 0.05, default: 1.15, unit: '×' },
  pcMaxSizePx: { label: 'Largest point', hint: 'A dot is never bigger than this on the screen (coarse levels, when zoomed in).', group: 'Point cloud', min: 3, max: 30, step: 1, default: 14, unit: 'px' },
  pcShading: { label: 'Depth shading', hint: 'Darkens points that have nearer ones beside them, so edges, walls and height stand out (eye-dome lighting). 0 turns it off. Needs a graphics card that can draw to float textures; without one it is left off.', group: 'Point cloud', min: 0, max: 2, step: 0.1, default: 0.5, unit: '×' },
  pcClipPercent: { label: 'Colour range trims', hint: 'The lowest and highest heights this share of the points have are left out of the colours, so a few outliers do not flatten the rest.', group: 'Point cloud', min: 0, max: 10, step: 0.5, default: 2, unit: '% each end' },
  photosAtATime: { label: 'Photos added at a time', hint: 'How many photos the list shows to start, and adds when you scroll. Applies to the next lookup.', group: 'Photos', min: 3, max: 10, step: 1, default: 5, unit: '' },
} as const satisfies Record<string, Def>;

export type SettingKey = keyof typeof DEFS;
export const KEYS = Object.keys(DEFS) as SettingKey[];
export type Values = Record<SettingKey, number>;

/** How many decimals a step needs, so a snapped value is not 0.30000000000000004. */
const decimals = (step: number): number => (String(step).split('.')[1] ?? '').length;

/** A value brought to the setting's range and its step. Anything that is not a number gives the default. */
export function fit(key: SettingKey, value: unknown): number {
  const d: Def = DEFS[key];
  const v = typeof value === 'number' && Number.isFinite(value) ? value : d.default;
  const clamped = Math.min(Math.max(v, d.min), d.max);
  const snapped = d.min + Math.round((clamped - d.min) / d.step) * d.step;
  return Number(Math.min(snapped, d.max).toFixed(decimals(d.step)));
}

export const defaults = (): Values => Object.fromEntries(KEYS.map((k) => [k, DEFS[k].default])) as Values;

export class Settings {
  private readonly storage: Store | null;
  private current: Values = defaults();
  private readonly listeners = new Set<() => void>();

  constructor(storage: Store | null = browserStorage()) {
    this.storage = storage;
    try {
      const saved = JSON.parse(storage?.getItem(SETTINGS_KEY) ?? 'null') as { version?: number; values?: Record<string, unknown> } | null;
      if (saved?.version === VERSION && saved.values && typeof saved.values === 'object') {
        for (const key of KEYS) if (key in saved.values) this.current[key] = fit(key, saved.values[key]);
      }
    } catch {
      // unreadable: the defaults
    }
  }

  get(key: SettingKey): number {
    return this.current[key];
  }
  all(): Readonly<Values> {
    return this.current;
  }
  isDefault(key: SettingKey): boolean {
    return this.current[key] === DEFS[key].default;
  }
  get changed(): boolean {
    return KEYS.some((k) => !this.isDefault(k));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Change a setting (brought to its range and step). Returns the value now held. */
  set(key: SettingKey, value: number): number {
    const v = fit(key, value);
    if (v === this.current[key]) return v;
    this.current = { ...this.current, [key]: v };
    this.save();
    for (const l of this.listeners) l();
    return v;
  }

  /** Put one setting, or all of them, back to the default. */
  reset(key?: SettingKey): void {
    this.current = key ? { ...this.current, [key]: DEFS[key].default } : defaults();
    this.save();
    for (const l of this.listeners) l();
  }

  private save(): void {
    try {
      const values = Object.fromEntries(KEYS.filter((k) => !this.isDefault(k)).map((k) => [k, this.current[k]]));
      this.storage?.setItem(SETTINGS_KEY, JSON.stringify({ version: VERSION, values }));
    } catch {
      // storage refused (full, blocked): the settings still apply for this visit
    }
  }
}

/** What the point cloud code needs, in its own units. */
export interface PcLimits {
  areaSqMi: number;
  /** Points and bytes for one load or one pass of adding detail. */
  budget: { maxPoints: number; maxBytes: number };
  maxTotalPoints: number;
  targetPx: number;
  /** The share of points trimmed from each end of the colour range, 0 to 0.1. */
  clip: number;
  sizeScale: number;
  maxSizePx: number;
  /** The strength of the depth shading, 0 for none. */
  shading: number;
}

export function pcLimits(s: { get(key: SettingKey): number }): PcLimits {
  return {
    areaSqMi: s.get('pcAreaSqMi'),
    budget: { maxPoints: s.get('pcLoadMillions') * 1_000_000, maxBytes: s.get('pcLoadMb') * 1024 * 1024 },
    maxTotalPoints: s.get('pcTotalMillions') * 1_000_000,
    targetPx: s.get('pcTargetPx'),
    clip: s.get('pcClipPercent') / 100,
    sizeScale: s.get('pcSizeScale'),
    maxSizePx: s.get('pcMaxSizePx'),
    shading: s.get('pcShading'),
  };
}
