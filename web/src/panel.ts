import type { FramePick, Look } from './api.ts';
import { describeFrame, LOOKS } from './describe.ts';

export interface PanelState {
  point: { lng: number; lat: number } | null;
  look: Look;
  status: 'idle' | 'loading' | 'ready' | 'error';
  frames: FramePick[];
  selected: number;
}

export interface PanelHandlers {
  onLook(look: Look): void;
  onSelect(index: number): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Rebuild the panel's contents from the state. It is small, so it is simpler to redraw than to patch. */
export function renderPanel(root: HTMLElement, state: PanelState, handlers: PanelHandlers): void {
  root.replaceChildren();
  root.append(el('h1', undefined, 'Oblique Viewer'));

  const where = el('p', 'where');
  if (state.point) {
    where.append('Selected ', Object.assign(el('span', 'coords'), { textContent: `${state.point.lat.toFixed(5)}, ${state.point.lng.toFixed(5)}` }));
  } else {
    where.textContent = 'Click the map to pick a location.';
  }
  root.append(where);
  if (!state.point) return;

  const group = el('div', 'looks');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', 'Direction the photo looks');
  for (const { id, label } of LOOKS) {
    const button = el('button', 'look', label);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(id === state.look));
    button.addEventListener('click', () => handlers.onLook(id));
    group.append(button);
  }
  root.append(group);

  const status = el('p', 'status');
  status.setAttribute('role', 'status');
  if (state.status === 'loading') status.textContent = 'Looking up photos…';
  else if (state.status === 'error') status.textContent = 'The photo service did not answer. Try again in a moment.';
  else if (state.status === 'ready' && state.frames.length === 0) status.textContent = 'No photos cover this point.';
  else if (state.status === 'ready') status.textContent = `${state.frames.length} photos cover this point, best first.`;
  root.append(status);

  const list = el('ol', 'frames');
  const anyInTolerance = state.frames.some((frame) => frame.azOk);
  state.frames.forEach((frame, index) => {
    const summary = describeFrame(frame, state.look, anyInTolerance);
    const button = el('button', 'frame');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(index === state.selected));
    button.addEventListener('click', () => handlers.onSelect(index));

    const body = el('span', 'body');
    body.append(el('strong', undefined, summary.title), el('span', 'facts', summary.facts.join(' · ')));
    for (const note of summary.notes) body.append(el('span', 'note', note));
    button.append(el('span', 'num', String(frame.pick)), body);

    const item = el('li');
    item.append(button);
    list.append(item);
  });
  root.append(list);
}
