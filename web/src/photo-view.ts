// The photo in the photo pane, zoomable and pannable. It draws the photo's overview (the small picture the pane
// loads first) on a canvas that fills the stage, and when the user zooms in past what the overview can show it reads
// the tiles of the zoomed area from the photo's own file, at the resolution the zoom needs, and draws them over the
// overview: the same range-request reading the map's sharp layer uses, sharing its caches.
//
// The maths is in `zoom.ts`. Controls: the wheel (and a trackpad's pinch), dragging, two-finger pinch, a double-click
// or double-tap, the + / - / Fit buttons, and the keyboard (+ - 0 and the arrow keys).

import { levelsOf, loadRegion, planRegion, sharedTiles, type CogLevel, type Overview, type RegionPlan } from './cog.ts';
import {
  clampView, contains, deviceScale, fitSize, FIT, maxZoom, panBy, toPhoto, visibleRegion, zoomAt, type Point, type Region, type Size, type View,
} from './zoom.ts';

/** How sharp the picture is at the current zoom. */
export type Sharpness = 'preview' | 'loading' | 'sharp';

export interface PhotoViewState {
  /** 1 is the whole photo; 4 is four times as large. */
  zoom: number;
  sharpness: Sharpness;
  /** The size of the level the sharp detail came from, in pixels wide, when there is one. */
  detailWidth: number | null;
}

export interface PhotoViewOptions {
  overview: Overview;
  /** The photo's file, for reading detail. */
  url: string;
  /** Called whenever the zoom or the sharpness changes. */
  onState?: (state: PhotoViewState) => void;
  /** Called when the user clicks the photo (a click, not a drag): where in the photo, as fractions of its width and height. */
  onPick?: (u: number, v: number) => void;
  /** Replaces the readers, for tests. */
  levels?: typeof levelsOf;
  region?: typeof loadRegion;
}

export interface PhotoView {
  /** The element to put in the pane's stage: the canvas and its buttons. */
  readonly element: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  /** Show the whole photo again. */
  reset(): void;
  /** Mark a place in the photo (fractions of its width and height), or take the mark off with null. */
  setMarker(at: { u: number; v: number } | null): void;
  /** Stop everything and let go of the listeners. */
  destroy(): void;
}

/** The tiles the detail may cost: at full size a tile is about 130 KB. */
const DETAIL_TILES = 30;
/** How long the view has to be still before detail is read. */
const SETTLE_MS = 180;
const MARGIN = 0.25;
const BACKGROUND = '#0d0f11';

interface Detail { canvas: HTMLCanvasElement; region: Region; width: number }

export function createPhotoView(options: PhotoViewOptions): PhotoView {
  const { overview, url } = options;
  const readLevels = options.levels ?? levelsOf;
  const readRegion = options.region ?? loadRegion;
  const aspect = overview.width / overview.height;

  const element = document.createElement('div');
  element.className = 'photo-view';
  const canvas = document.createElement('canvas');
  canvas.className = 'photo-canvas';
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-roledescription', 'zoomable photo');
  canvas.dataset.zoom = '1';
  canvas.dataset.detail = 'preview';
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2D canvas context');

  const controls = document.createElement('div');
  controls.className = 'photo-zoom-controls';
  const button = (label: string, text: string, title: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.title = title;
    b.setAttribute('aria-label', label);
    return b;
  };
  const zoomIn = button('Zoom in', '+', 'Zoom in (+ or scroll)');
  const zoomOut = button('Zoom out', '−', 'Zoom out (− or scroll)');
  const fitButton = button('Show the whole photo', 'Fit', 'Show the whole photo (0 or double-click)');
  controls.append(zoomIn, zoomOut, fitButton);
  element.append(canvas, controls);

  let stage: Size = { w: 0, h: 0 };
  let ratio = window.devicePixelRatio || 1;
  let view: View = FIT;
  let levels: CogLevel[] | null = null;
  let fullWidth = overview.width * 16; // a guess until the file's header has been read (photos are 10,300 to 20,544 px)
  let detail: Detail | null = null;
  let sharpness: Sharpness = 'preview';
  let request: AbortController | undefined;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;
  let destroyed = false;
  let marker: { u: number; v: number } | null = null;

  const fit = (): Size => fitSize(stage, aspect);
  const limit = (): number => maxZoom(fit(), fullWidth, ratio);

  function announce(): void {
    canvas.dataset.zoom = view.zoom.toFixed(3);
    canvas.dataset.cx = view.cx.toFixed(4);
    canvas.dataset.cy = view.cy.toFixed(4);
    canvas.dataset.detail = sharpness;
    canvas.dataset.zoomed = String(view.zoom > 1.001);
    fitButton.disabled = view.zoom <= 1.001;
    zoomOut.disabled = view.zoom <= 1.001;
    zoomIn.disabled = view.zoom >= limit() - 1e-6;
    options.onState?.({ zoom: view.zoom, sharpness, detailWidth: detail ? detail.width : null });
  }

  function render(): void {
    frame = 0;
    if (destroyed || stage.w < 1 || stage.h < 1) return;
    const ctx = context!;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, stage.w, stage.h);
    const f = fit();
    const dw = f.w * view.zoom, dh = f.h * view.zoom;
    const x0 = stage.w / 2 - view.cx * dw, y0 = stage.h / 2 - view.cy * dh;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(overview.canvas, x0, y0, dw, dh);
    if (detail) {
      const r = detail.region;
      ctx.drawImage(detail.canvas, x0 + r.u0 * dw, y0 + r.v0 * dh, (r.u1 - r.u0) * dw, (r.v1 - r.v0) * dh);
    }
    if (marker) { // a dot with a ring, the same blue as the dot on the map
      const mx = x0 + marker.u * dw, my = y0 + marker.v * dh;
      ctx.beginPath();
      ctx.arc(mx, my, 13, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(30, 136, 229, 0.28)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(mx, my, 6.5, 0, Math.PI * 2);
      ctx.fillStyle = '#1e88e5';
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    }
  }
  const schedule = (): void => {
    if (!frame && !destroyed) frame = requestAnimationFrame(render);
  };

  function setView(next: View): void {
    const clamped = clampView(next, stage, fit(), limit());
    if (clamped.zoom === view.zoom && clamped.cx === view.cx && clamped.cy === view.cy) return;
    view = clamped;
    announce();
    schedule();
    settle();
  }

  /** Once the view has been still for a moment, read the detail it needs (or drop it if the overview is enough). */
  function settle(): void {
    clearTimeout(settleTimer);
    request?.abort();
    settleTimer = setTimeout(() => void loadDetail(), SETTLE_MS);
  }

  async function loadDetail(): Promise<void> {
    if (destroyed || stage.w < 1) return;
    const mine = (request = new AbortController());
    try {
      if (!levels) {
        levels = await readLevels(url, mine.signal);
        fullWidth = Math.max(...levels.map((l) => l.width));
        if (mine.signal.aborted) return;
        announce(); // the maximum zoom is now known
      }
      const f = fit();
      const need = deviceScale(view, f, fullWidth, ratio);
      if (overview.width / fullWidth >= need * 0.9) { // the overview already has the pixels this zoom shows
        if (detail || sharpness !== 'preview') { detail = null; sharpness = 'preview'; announce(); schedule(); }
        return;
      }
      const seen = visibleRegion(view, stage, f);
      if (detail && contains(detail.region, seen) && detail.width / fullWidth >= need * 0.9) { // what is drawn already does
        if (sharpness !== 'sharp') { sharpness = 'sharp'; announce(); }
        return;
      }
      sharpness = 'loading';
      announce();
      const wanted = visibleRegion(view, stage, f, MARGIN);
      const plan: RegionPlan | null = planRegion(
        levels, { x0: wanted.u0 * fullWidth, y0: wanted.v0 * (fullWidth / aspect), x1: wanted.u1 * fullWidth, y1: wanted.v1 * (fullWidth / aspect) },
        need, DETAIL_TILES,
      );
      if (!plan) return;
      const { canvas: piece } = await readRegion(url, plan, { signal: mine.signal, cache: sharedTiles });
      if (mine.signal.aborted || destroyed) return;
      const { level, rect } = plan;
      detail = {
        canvas: piece, width: level.width,
        region: { u0: rect.x / level.width, v0: rect.y / level.height, u1: (rect.x + rect.width) / level.width, v1: (rect.y + rect.height) / level.height },
      };
      sharpness = 'sharp';
      announce();
      schedule();
    } catch (error) {
      if (mine.signal.aborted || destroyed) return;
      console.error('no detail for the zoomed photo, keeping the preview', error);
      sharpness = 'preview';
      announce();
    }
  }

  // --- size ---
  function resize(): void {
    const w = element.clientWidth, h = element.clientHeight;
    ratio = window.devicePixelRatio || 1;
    if (Math.abs(w - stage.w) < 0.5 && Math.abs(h - stage.h) < 0.5 && canvas.width === Math.round(w * ratio)) return;
    stage = { w, h };
    canvas.width = Math.max(1, Math.round(w * ratio));
    canvas.height = Math.max(1, Math.round(h * ratio));
    view = clampView(view, stage, fit(), limit());
    announce();
    schedule();
    if (view.zoom > 1.001) settle();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(element);

  // --- pointer: drag to pan, two fingers to pinch, double-click to zoom ---
  const pointers = new Map<number, Point>();
  let press: { at: Point; moved: boolean; fingers: number } | null = null; // where a press began, to tell a click from a drag
  const CLICK_SLOP = 5; // pixels a press may move and still be a click
  const local = (event: { clientX: number; clientY: number }): Point => {
    const box = canvas.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };
  const distance = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
  const middle = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  canvas.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    try { canvas.setPointerCapture(event.pointerId); } catch { /* the pointer is already gone: drag without capture */ }
    pointers.set(event.pointerId, local(event));
    press = pointers.size === 1 ? { at: local(event), moved: false, fingers: 1 } : press && { ...press, fingers: 2 };
    canvas.dataset.dragging = 'true';
  });
  canvas.addEventListener('pointermove', (event) => {
    const before = pointers.get(event.pointerId);
    if (!before) return;
    const now = local(event);
    if (press && distance(now, press.at) > CLICK_SLOP) press.moved = true;
    if (pointers.size === 1) {
      setView(panBy(view, now.x - before.x, now.y - before.y, stage, fit(), limit()));
    } else if (pointers.size === 2) {
      const others = [...pointers.entries()].find(([id]) => id !== event.pointerId)![1];
      const oldMid = middle(before, others), newMid = middle(now, others);
      const factor = distance(now, others) / Math.max(1, distance(before, others));
      // spread or pinch about where the fingers were, then follow them as they move together
      setView(panBy(zoomAt(view, factor, oldMid, stage, fit(), limit()), newMid.x - oldMid.x, newMid.y - oldMid.y, stage, fit(), limit()));
    }
    pointers.set(event.pointerId, now);
  });
  const lift = (event: PointerEvent): void => {
    pointers.delete(event.pointerId);
    if (pointers.size === 0) {
      delete canvas.dataset.dragging;
      const p = press;
      press = null;
      if (p && event.type === 'pointerup' && !p.moved && p.fingers === 1 && stage.w > 0) { // a click: where in the photo?
        const at = toPhoto(view, local(event), stage, fit());
        if (at.u >= 0 && at.u <= 1 && at.v >= 0 && at.v <= 1) options.onPick?.(at.u, at.v);
      }
    }
  };
  canvas.addEventListener('pointerup', lift);
  canvas.addEventListener('pointercancel', lift);
  canvas.addEventListener('dblclick', (event) => {
    event.preventDefault();
    const at = local(event);
    setView(view.zoom > 1.05 ? FIT : zoomAt(view, Math.min(3, limit()), at, stage, fit(), limit()));
  });

  // --- wheel and trackpad pinch (a pinch arrives as a wheel event with ctrlKey) ---
  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const lines = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
    const factor = Math.exp(-event.deltaY * lines * (event.ctrlKey ? 0.01 : 0.0015));
    setView(zoomAt(view, factor, local(event), stage, fit(), limit()));
  }, { passive: false });

  // --- buttons and keys ---
  const centre = (): Point => ({ x: stage.w / 2, y: stage.h / 2 });
  zoomIn.addEventListener('click', () => setView(zoomAt(view, 1.6, centre(), stage, fit(), limit())));
  zoomOut.addEventListener('click', () => setView(zoomAt(view, 1 / 1.6, centre(), stage, fit(), limit())));
  fitButton.addEventListener('click', () => setView(FIT));
  canvas.addEventListener('keydown', (event) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const step = Math.min(stage.w, stage.h) * 0.2;
    const arrows: Record<string, [number, number]> = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (event.key === '+' || event.key === '=') setView(zoomAt(view, 1.6, centre(), stage, fit(), limit()));
    else if (event.key === '-' || event.key === '_') setView(zoomAt(view, 1 / 1.6, centre(), stage, fit(), limit()));
    else if (event.key === '0') setView(FIT);
    else if (arrows[event.key] && view.zoom > 1.001) setView(panBy(view, arrows[event.key]![0], arrows[event.key]![1], stage, fit(), limit()));
    else return;
    event.preventDefault();
  });

  announce();
  // Read the file's header at once, so the largest zoom is right and the first zoom does not wait for it.
  void readLevels(url).then((found) => {
    if (destroyed) return;
    levels = found;
    fullWidth = Math.max(...found.map((l) => l.width));
    announce();
  }).catch(() => { /* the first zoom tries again and reports it */ });

  return {
    element,
    canvas,
    reset: () => setView(FIT),
    setMarker(at): void {
      marker = at;
      if (at) canvas.dataset.marker = `${at.u.toFixed(4)},${at.v.toFixed(4)}`;
      else delete canvas.dataset.marker;
      schedule();
    },
    destroy(): void {
      destroyed = true;
      clearTimeout(settleTimer);
      request?.abort();
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      pointers.clear();
    },
  };
}
