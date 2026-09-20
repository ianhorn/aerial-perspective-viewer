import type { FramePick } from './api.ts';
import { loadOverview, type Overview } from './cog.ts';
import type { FrameSummary } from './describe.ts';
import { LruCache } from './lru.ts';
import { createPhotoView, type OverlayPainter, type PhotoView, type PhotoViewState } from './photo-view.ts';

export interface PhotoPane {
  /** Show a photo, replacing whatever is there. A photo still loading is abandoned. */
  show(frame: FramePick, summary: FrameSummary): void;
  hide(): void;
  /** Shrink the pane to a thin tab at the side (or open it again). The photo keeps loading while tucked. */
  tuck(on: boolean): void;
  /** Paint over the photo on show and on every photo shown after it (a measurement), or take it off with null. */
  setOverlay(painter: OverlayPainter | null): void;
  /** Draw the overlay again, because what it shows has changed. */
  redraw(): void;
  /** While a measuring tool is on, a click on the photo goes to `onMeasure` and not to `onPick`. */
  setTooling(on: boolean): void;
}

export interface PhotoPaneOptions {
  /** Called after the pane appears or disappears, since that changes the size of the map beside it. */
  onVisibilityChange?: () => void;
  /** Called with each photo once it is decoded and shown, whether fetched or remembered. */
  onPhoto?: (filename: string, overview: Overview) => void;
  /** Called when the user clicks the photo: where in it (fractions of its width and height), for putting a dot on the map. */
  onPick?: (filename: string, u: number, v: number) => void;
  /** Called when the user clicks the photo while a measuring tool is on: where in it, as fractions of its width and height. */
  onMeasure?: (filename: string, u: number, v: number) => void;
  /** Called when Escape is pressed; return true when it was used (a measurement cleared), so that the pane stays open. */
  onEscape?: () => boolean;
  /** The measuring toolbar, shown between the pane's heading and the photo. */
  toolbar?: HTMLElement;
  /** The measuring readout, floated over the bottom left of the photo (it must not take room from the photo, or the photo moves). */
  readout?: HTMLElement;
  /** Called when a photo could not be loaded (the pane then offers "Try again"). */
  onFail?: (filename: string) => void;
  /** Replaces the loader, for tests. */
  load?: typeof loadOverview;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * The pane beside the map that shows the selected photo as it was taken. It fetches the smallest
 * overview of the photo that has enough pixels for the space, so most photos cost 0.5 to 3 MB, not 40.
 * Photos already seen are kept, so going back to one is instant.
 */
export function createPhotoPane(root: HTMLElement, options: PhotoPaneOptions = {}): PhotoPane {
  const load = options.load ?? loadOverview;
  const seen = new LruCache<string, Overview>(6);
  let request: AbortController | undefined;
  let showing: string | undefined;
  let photoView: PhotoView | undefined; // the zoomable picture of the photo on show
  let painter: OverlayPainter | null = null; // what is painted over each photo (a measurement)
  let tooling = false; // a measuring tool is on

  const title = el('h2');
  const facts = el('p', 'facts');
  const name = el('p', 'name'); // the photo's file name, which is its key in the data and in the bucket
  const notes = el('div', 'notes');
  const close = el('button', 'close', 'Close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close the photo');
  const tuckButton = el('button', 'tuck', 'Tuck ▸');
  tuckButton.type = 'button';
  tuckButton.setAttribute('aria-label', 'Tuck the photo to the side');
  const heading = el('div', 'heading');
  heading.append(title, facts, name, notes);
  const header = el('header');
  header.append(heading, tuckButton, close);
  // What shows in place of everything else while the pane is tucked.
  const tab = el('button', 'tab', '◂ Photo');
  tab.type = 'button';
  tab.setAttribute('aria-label', 'Open the photo');

  const stage = el('div', 'stage');
  const message = el('div', 'message');
  message.setAttribute('role', 'status');
  const info = el('span', 'info');
  const link = el('a', undefined, 'Open the full photo (about 40 MB)');
  link.target = '_blank';
  link.rel = 'noopener';
  const footer = el('footer');
  footer.append(info, link);
  root.replaceChildren(tab, header, ...(options.toolbar ? [options.toolbar] : []), stage, footer, ...(options.readout ? [options.readout] : []));

  const changed = (): void => options.onVisibilityChange?.();

  function hide(): void {
    request?.abort();
    photoView?.destroy();
    photoView = undefined;
    showing = undefined;
    if (root.hidden) return;
    root.hidden = true;
    changed();
  }
  function tuck(on: boolean): void {
    if (root.classList.contains('tucked') === on) return;
    root.classList.toggle('tucked', on);
    if (!root.hidden) changed();
  }
  tuckButton.addEventListener('click', () => tuck(true));
  tab.addEventListener('click', () => tuck(false));
  close.addEventListener('click', hide);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !root.hidden && !options.onEscape?.()) hide();
  });

  /** What the footer says: the preview's size, and once zoomed, the zoom and whether sharp detail has arrived. */
  function describeView(overview: Overview, state: PhotoViewState): string {
    const preview = `Preview at ${overview.width} × ${overview.height} px`;
    if (state.zoom <= 1.001) return preview;
    const detail = state.sharpness === 'sharp' ? 'sharp detail from the photo' : state.sharpness === 'loading' ? 'loading detail…' : 'preview pixels';
    return `${preview} · zoom ${state.zoom.toFixed(1)}× · ${detail}`;
  }

  function display(frame: FramePick, overview: Overview): void {
    // The picture is drawn from the overview on a canvas of its own: the overview's canvas is shared (the scene lays it on the map).
    photoView?.destroy();
    // The view reports its state while it is being made, before it is assigned here, so `view` may still be unset then.
    let view: PhotoView | undefined;
    view = photoView = createPhotoView({
      overview, url: frame.url,
      onState: (state) => { if (view === photoView) info.textContent = describeView(overview, state); },
      onPick: (u, v) => {
        if (tooling) return options.onMeasure?.(frame.filename, u, v);
        view?.setMarker({ u, v });
        options.onPick?.(frame.filename, u, v);
      },
    });
    view.setOverlay(painter);
    view.setTooling(tooling);
    view.canvas.setAttribute('role', 'img');
    view.canvas.setAttribute(
      'aria-label',
      `Photo from the ${frame.camera} camera, flown ${frame.flownUtc.slice(0, 10)}. Scroll or pinch to zoom, drag to move, 0 to fit.`,
    );
    stage.replaceChildren(view.element);
    info.textContent = describeView(overview, { zoom: 1, sharpness: 'preview', detailWidth: null });
    options.onPhoto?.(frame.filename, overview);
  }

  function fail(frame: FramePick, summary: FrameSummary): void {
    photoView?.destroy();
    photoView = undefined;
    const retry = el('button', 'retry', 'Try again');
    retry.type = 'button';
    retry.addEventListener('click', () => show(frame, summary));
    message.replaceChildren('The photo could not be loaded. ', retry);
    stage.replaceChildren(message);
    info.textContent = '';
  }

  function show(frame: FramePick, summary: FrameSummary): void {
    request?.abort();
    photoView?.destroy();
    photoView = undefined;
    showing = frame.filename;

    const wasHidden = root.hidden;
    root.hidden = false;
    title.textContent = summary.title;
    facts.textContent = summary.facts.join(' · ');
    name.textContent = frame.filename;
    notes.replaceChildren(...summary.notes.map((note) => el('p', 'note', note)));
    link.href = frame.url;
    if (wasHidden) changed();

    const cached = seen.get(frame.filename);
    if (cached) return display(frame, cached);

    message.replaceChildren('Loading photo…');
    stage.replaceChildren(message);
    info.textContent = '';
    const mine = (request = new AbortController());
    load(frame.url, {
      boxWidth: stage.clientWidth || 800,
      boxHeight: stage.clientHeight || 600,
      pixelRatio: window.devicePixelRatio || 1,
      signal: mine.signal,
    }).then((overview) => {
      seen.set(frame.filename, overview);
      if (showing === frame.filename && !mine.signal.aborted) display(frame, overview);
    }).catch((error: unknown) => {
      if (mine.signal.aborted || showing !== frame.filename) return; // a newer choice replaced this one
      console.error(error);
      fail(frame, summary);
      options.onFail?.(frame.filename);
    });
  }

  return {
    show, hide, tuck,
    setOverlay(next): void {
      painter = next;
      photoView?.setOverlay(next);
    },
    redraw: () => photoView?.redraw(),
    setTooling(on): void {
      tooling = on;
      photoView?.setTooling(on);
    },
  };
}
