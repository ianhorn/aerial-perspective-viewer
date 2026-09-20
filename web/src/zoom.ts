// The maths of zooming and panning a photo inside the photo pane. Kept apart from the drawing so it can be tested.
//
// The photo is described by its aspect ratio and positions in it are fractions: (u, v) run from (0, 0) at the top left
// of the photo to (1, 1) at the bottom right, whatever the size of the file or of the picture being drawn. The view is
// the zoom (1 shows the whole photo, filling as much of the stage as it can) and the point of the photo at the middle
// of the stage. The stage and the fitted photo are sizes in CSS pixels.

export interface Size { w: number; h: number }
export interface Point { x: number; y: number }
/** A position in the photo, as fractions of its width and height. */
export interface PhotoPoint { u: number; v: number }
export interface View { zoom: number; cx: number; cy: number }
export interface Region { u0: number; v0: number; u1: number; v1: number }

/** The whole photo, centred. */
export const FIT: View = { zoom: 1, cx: 0.5, cy: 0.5 };

/** The size of the whole photo when it is fitted into the stage (zoom 1). */
export function fitSize(stage: Size, aspect: number): Size {
  const w = Math.min(stage.w, stage.h * aspect);
  return { w, h: w / aspect };
}

/**
 * The most it can be zoomed: each pixel of the photo covering `maxDevicePxPerPhotoPx` device pixels (2 by default,
 * so a photo pixel is enlarged twice at most, past which it only gets blurrier). At least 1.
 */
export function maxZoom(fit: Size, fullWidth: number, pixelRatio: number, maxDevicePxPerPhotoPx = 2): number {
  return Math.max(1, (maxDevicePxPerPhotoPx * fullWidth) / (pixelRatio * fit.w));
}

/** Keep the zoom in range and the photo covering the stage: on an axis where the photo is smaller than the stage it is centred. */
export function clampView(view: View, stage: Size, fit: Size, maxZ: number): View {
  const zoom = Math.min(maxZ, Math.max(1, view.zoom));
  const axis = (centre: number, shown: number, room: number): number => {
    if (shown <= room) return 0.5;
    const half = room / (2 * shown);
    return Math.min(1 - half, Math.max(half, centre));
  };
  return { zoom, cx: axis(view.cx, fit.w * zoom, stage.w), cy: axis(view.cy, fit.h * zoom, stage.h) };
}

/** Where a point of the photo is on the stage. */
export function toScreen(view: View, p: PhotoPoint, stage: Size, fit: Size): Point {
  return { x: stage.w / 2 + (p.u - view.cx) * fit.w * view.zoom, y: stage.h / 2 + (p.v - view.cy) * fit.h * view.zoom };
}

/** The point of the photo at a place on the stage. */
export function toPhoto(view: View, s: Point, stage: Size, fit: Size): PhotoPoint {
  return { u: view.cx + (s.x - stage.w / 2) / (fit.w * view.zoom), v: view.cy + (s.y - stage.h / 2) / (fit.h * view.zoom) };
}

/** Zoom by `factor` about a place on the stage: the point of the photo under it stays under it (as far as the edges allow). */
export function zoomAt(view: View, factor: number, anchor: Point, stage: Size, fit: Size, maxZ: number): View {
  const p = toPhoto(view, anchor, stage, fit);
  const zoom = Math.min(maxZ, Math.max(1, view.zoom * factor));
  return clampView(
    { zoom, cx: p.u - (anchor.x - stage.w / 2) / (fit.w * zoom), cy: p.v - (anchor.y - stage.h / 2) / (fit.h * zoom) },
    stage, fit, maxZ,
  );
}

/** Drag the photo by (dx, dy) stage pixels: the centre moves the other way. */
export function panBy(view: View, dx: number, dy: number, stage: Size, fit: Size, maxZ: number): View {
  return clampView({ zoom: view.zoom, cx: view.cx - dx / (fit.w * view.zoom), cy: view.cy - dy / (fit.h * view.zoom) }, stage, fit, maxZ);
}

/** The part of the photo on the stage, grown by `margin` (a fraction of the view on each side) and clipped to the photo. */
export function visibleRegion(view: View, stage: Size, fit: Size, margin = 0): Region {
  const halfU = stage.w / (2 * fit.w * view.zoom), halfV = stage.h / (2 * fit.h * view.zoom);
  const grow = 1 + 2 * margin;
  return {
    u0: Math.max(0, view.cx - halfU * grow), v0: Math.max(0, view.cy - halfV * grow),
    u1: Math.min(1, view.cx + halfU * grow), v1: Math.min(1, view.cy + halfV * grow),
  };
}

/** Device pixels per pixel of the full-size photo at this zoom. */
export function deviceScale(view: View, fit: Size, fullWidth: number, pixelRatio: number): number {
  return (fit.w * view.zoom * pixelRatio) / fullWidth;
}

/** Whether region `inner` lies wholly inside region `outer`. */
export function contains(outer: Region, inner: Region): boolean {
  return outer.u0 <= inner.u0 && outer.v0 <= inner.v0 && outer.u1 >= inner.u1 && outer.v1 >= inner.v1;
}
