import { FRAMES_PER_LOOKUP, type FramePick, type Look } from './api.ts';
import { describeFrame, LOOKS, NEAR_EDGE_NOTE, sharesEdgeNote } from './describe.ts';

export interface PanelState {
  point: { lng: number; lat: number } | null;
  look: Look;
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** Every photo the lookup returned, best first. */
  frames: FramePick[];
  /** How many of them the list shows so far: it starts with a few and adds more as it is scrolled. */
  shown: number;
  /** How many more are added each time. */
  pageSize: number;
  selected: number;
  /** Small pictures of the listed photos, as they finish loading. A row without one shows an empty box. */
  thumbs?: { get(filename: string): HTMLCanvasElement | undefined };
}

export interface PanelHandlers {
  onLook(look: Look): void;
  onSelect(index: number): void;
  /** The end of the list has been scrolled near: show more photos. */
  onMore(): void;
  /** The pointer (or the keyboard) is on the card at this index, or has left it (null): for previewing its footprint. */
  onHover(index: number | null): void;
}

/**
 * Whether a panel has more photos to show and what to call when it should, kept beside the panel because the scroll
 * listener is added once and the state changes with every redraw.
 */
const growing = new WeakMap<HTMLElement, { more: boolean; onMore: () => void }>();
const listening = new WeakSet<HTMLElement>();
/** How close to the end of the panel (in pixels) the scrolling has to get before the next photos are added. */
const NEAR_END_PX = 160;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Rebuild the panel's contents from the state. It is small, so it is simpler to redraw than to patch; the scroll position
 * and the focused card are kept across the redraw, since it also happens as more photos are added while scrolling.
 */
export function renderPanel(root: HTMLElement, state: PanelState, handlers: PanelHandlers): void {
  const scrollTop = root.scrollTop;
  const focused = [...root.querySelectorAll<HTMLElement>('.frame')].indexOf(document.activeElement as HTMLElement);
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

  const visible = state.frames.slice(0, state.shown);
  const more = state.shown < state.frames.length;
  const status = el('p', 'status');
  status.setAttribute('role', 'status');
  if (state.status === 'loading') status.textContent = 'Looking up photos…';
  else if (state.status === 'error') status.textContent = 'The photo service did not answer. Try again in a moment.';
  else if (state.status === 'ready' && state.frames.length === 0) status.textContent = 'No photos cover this point.';
  else if (state.status === 'ready') {
    // The list is the best few photos, not all of them: at a busy place far more than the API's limit cover the point.
    const count = state.frames.length >= FRAMES_PER_LOOKUP ? `The ${state.frames.length} best photos cover this point` : `${state.frames.length} photos cover this point`;
    status.textContent = `${count}, best first.${more ? ' Scroll for more.' : ''}`;
  }
  root.append(status);

  const list = el('ol', 'frames');
  const anyInTolerance = state.frames.some((frame) => frame.azOk);
  const summaries = visible.map((frame) => describeFrame(frame, state.look, anyInTolerance));
  // One photo near an edge keeps its own orange note. Several share it: an asterisk on each, the note once below.
  const sharedEdgeNote = sharesEdgeNote(summaries);
  visible.forEach((frame, index) => {
    const summary = summaries[index]!;
    const starred = sharedEdgeNote && summary.nearEdge;
    const button = el('button', 'frame');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(index === state.selected));
    button.addEventListener('click', () => handlers.onSelect(index));
    // A preview of the photo's footprint on the map while the pointer (or the keyboard focus) is on its card.
    button.addEventListener('mouseenter', () => handlers.onHover(index));
    button.addEventListener('mouseleave', () => handlers.onHover(null));
    button.addEventListener('focus', () => handlers.onHover(index));
    button.addEventListener('blur', () => handlers.onHover(null));

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
  if (more) {
    // The end of the list. Scrolling near it adds the next few photos; the button does the same for a panel too short to scroll
    // (or for the keyboard), and says how many are left.
    const end = el('li', 'more');
    const left = state.frames.length - state.shown;
    const PAGE_SIZE = state.pageSize;
    const button = el('button', 'more-button', `Show ${Math.min(left, PAGE_SIZE)} more photo${Math.min(left, PAGE_SIZE) === 1 ? '' : 's'}`);
    button.type = 'button';
    button.addEventListener('click', () => handlers.onMore());
    end.append(button);
    list.append(end);
  }
  root.append(list);
  if (sharedEdgeNote) {
    const footnote = el('p', 'footnote');
    footnote.append(star(), ' The point is near the edge of these photos, or the resolution is coarse there.');
    root.append(footnote);
  }

  root.scrollTop = scrollTop;
  if (focused >= 0) root.querySelectorAll<HTMLElement>('.frame')[focused]?.focus({ preventScroll: true });

  // More photos are added when the user scrolls near the end. (Not before: the few photos the list begins with are meant to
  // be the first thing seen, so it never grows by itself.) A panel too tall to scroll has the button instead.
  growing.set(root, { more, onMore: handlers.onMore });
  if (!listening.has(root)) {
    listening.add(root);
    root.addEventListener('scroll', () => {
      const g = growing.get(root);
      if (g?.more && root.scrollHeight - root.scrollTop - root.clientHeight < NEAR_END_PX) g.onMore();
    }, { passive: true });
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
