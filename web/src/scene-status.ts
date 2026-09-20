/**
 * The "rendering" indicator: a small pill at the bottom of the map with a spinning ring, shown while the scene is
 * still fetching or drawing photos. It is announced politely to screen readers. When to show it is decided by
 * `busy-gate.ts`; this only draws it.
 */
export interface SceneStatus {
  setShown(shown: boolean): void;
}

export function createSceneStatus(parent: HTMLElement): SceneStatus {
  const box = document.createElement('div');
  box.className = 'scene-status';
  box.hidden = true;
  box.setAttribute('role', 'status');
  box.setAttribute('aria-live', 'polite');
  const ring = document.createElement('span');
  ring.className = 'scene-status-ring';
  ring.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.textContent = 'Rendering photos…';
  box.append(ring, text);
  parent.append(box);
  return { setShown: (shown) => { box.hidden = !shown; } };
}
