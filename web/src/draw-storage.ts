// The drawing kept in the browser between visits. Storage can be missing, full or blocked (a private window, cleared site data),
// so nothing here throws: a load that fails gives an empty drawing, and a save that fails says so and the page carries on.

import type { DrawFeature } from './draw-model.ts';

export const STORAGE_KEY = 'aerial-perspective-viewer.drawing';
const VERSION = 1;

/** The part of `Storage` that is used, so a test can give it a plain object. */
export interface Store { getItem(key: string): string | null; setItem(key: string, value: string): void }

/** The saved features, as they were read (still to be checked by `repair`); empty if there are none or they cannot be read. */
export function loadDrawing(storage: Store | null): unknown[] {
  try {
    const text = storage?.getItem(STORAGE_KEY);
    if (!text) return [];
    const saved = JSON.parse(text) as { version?: unknown; features?: unknown };
    return saved.version === VERSION && Array.isArray(saved.features) ? saved.features : [];
  } catch {
    return [];
  }
}

/** Save the drawing. Returns whether it was saved. */
export function saveDrawing(storage: Store | null, features: readonly DrawFeature[]): boolean {
  try {
    if (!storage) return false;
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: VERSION, features }));
    return true;
  } catch {
    return false;
  }
}

/** The browser's local storage, or null if the browser will not give it (the accessor itself can throw). */
export function browserStorage(): Store | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
