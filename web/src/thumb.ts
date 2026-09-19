// Thumbnails in the results list. A photo's smallest overview can be far bigger than a list row (1287 px
// wide, about 5 MB decoded), so each one is shrunk to the size it is shown at and the big canvas is dropped.

/** The size of a picture scaled down to fit in a box, keeping its shape. Never larger than the original. */
export function fitInside(width: number, height: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** A copy of a canvas shrunk to fit the box (in device pixels). */
export function shrink(source: HTMLCanvasElement, maxWidth: number, maxHeight: number): HTMLCanvasElement {
  const size = fitInside(source.width, source.height, maxWidth, maxHeight);
  const out = document.createElement('canvas');
  out.width = size.width;
  out.height = size.height;
  const context = out.getContext('2d');
  if (!context) throw new Error('no 2D canvas context');
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, size.width, size.height);
  return out;
}
