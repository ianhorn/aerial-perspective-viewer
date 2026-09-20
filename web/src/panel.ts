import type { FramePick, Look } from './api.ts';
import { describeFrame, LOOKS, NEAR_EDGE_NOTE, sharesEdgeNote } from './describe.ts';

export interface PanelState {
  point: { lng: number; lat: number } | null;
  look: Look;
  status: 'idle' | 'loading' | 'ready' | 'error';
  frames: FramePick[];
  selected: number;
  /** Small pictures of the listed photos, as they finish loading. A row without one shows an empty box. */
  thumbs?: { get(filename: string): HTMLCanvasElement | undefined };
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
  root.append(el('h1', undefined, 'Kentucky Aerial Perspective Viewer'));

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
  const summaries = state.frames.map((frame) => describeFrame(frame, state.look, anyInTolerance));
  // One photo near an edge keeps its own orange note. Several share it: an asterisk on each, the note once below.
  const sharedEdgeNote = sharesEdgeNote(summaries);
  state.frames.forEach((frame, index) => {
    const summary = summaries[index]!;
    const starred = sharedEdgeNote && summary.nearEdge;
    const button = el('button', 'frame');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(index === state.selected));
    button.addEventListener('click', () => handlers.onSelect(index));

    const body = el('span', 'body');
    const facts = el('span', 'facts', summary.facts.join(' · '));
    if (starred) facts.append(' ', star());
    body.append(el('strong', undefined, summary.title), facts);
    for (const note of summary.notes) {
      if (!(starred && note === NEAR_EDGE_NOTE)) body.append(el('span', 'note', note));
    }
    const thumb = el('span', 'thumb');
    thumb.dataset.filename = frame.filename;
    const ready = state.thumbs?.get(frame.filename);
    if (ready) thumb.append(ready);
    thumb.append(el('span', 'num', String(frame.pick)));
    button.append(thumb, body);

    const item = el('li');
    item.append(button);
    list.append(item);
  });
  root.append(list);
  if (sharedEdgeNote) {
    const footnote = el('p', 'footnote');
    footnote.append(star(), ' The point is near the edge of these photos, or the resolution is coarse there.');
    root.append(footnote);
  }
}

/** The asterisk that marks a row as covered by the note below the list. */
function star(): HTMLElement {
  const mark = el('span', 'star', '*');
  mark.setAttribute('role', 'img');
  mark.setAttribute('aria-label', 'see the note below the list');
  return mark;
}

/** Put a finished thumbnail into its row without redrawing the panel (a redraw would drop the keyboard focus). */
export function setThumb(root: HTMLElement, filename: string, canvas: HTMLCanvasElement): void {
  for (const thumb of root.querySelectorAll<HTMLElement>('.thumb')) {
    if (thumb.dataset.filename === filename) thumb.prepend(canvas);
  }
}
