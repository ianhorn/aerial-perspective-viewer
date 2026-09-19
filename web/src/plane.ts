// The little aeroplane that marks where the camera was, drawn once onto a canvas and handed to the map as an
// image. It is drawn pointing up (north); the map turns it to the direction of flight. Made here, not loaded,
// so there is no file to fetch and it is ready before the first frame is shown.

const VIEW = 64; // the drawing is laid out on a 64 by 64 grid
const RED = '#e53935'; // the footprint's colour
const RED_DARK = '#b71c1c';

// Rounded, chunky shapes: a fat fuselage with a round nose, short swept wings, a small tail.
const FUSELAGE = 'M32 5 Q38.5 5 38.5 14 L38.5 51 Q38.5 60 32 60 Q25.5 60 25.5 51 L25.5 14 Q25.5 5 32 5 Z';
const WINGS = 'M32 21 L60 40 Q63 42.5 60 45 L32 38.5 L4 45 Q1 42.5 4 40 Z';
const TAIL = 'M32 46 L46 57 Q48.5 59.5 45.5 60.5 L32 56 L18.5 60.5 Q15.5 59.5 18 57 Z';

/** The plane as RGBA pixels, `size` pixels square, for `map.addImage`. Use a size of twice the size on screen. */
export function planeImage(size = 80): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2D canvas context');
  ctx.scale(size / VIEW, size / VIEW);
  ctx.lineJoin = 'round';

  // A white outline first, so the plane reads on both dark trees and pale roads.
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 5;
  for (const path of [WINGS, TAIL, FUSELAGE]) ctx.stroke(new Path2D(path));

  ctx.fillStyle = RED_DARK;
  ctx.fill(new Path2D(WINGS));
  ctx.fill(new Path2D(TAIL));
  ctx.fillStyle = RED;
  ctx.fill(new Path2D(FUSELAGE));

  // A pale cockpit window and a stripe down the back make it look friendly.
  ctx.fillStyle = '#d6ecff';
  ctx.beginPath();
  ctx.ellipse(32, 19, 4.2, 5.6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
  ctx.lineWidth = 1.6;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(32, 30);
  ctx.lineTo(32, 52);
  ctx.stroke();

  return ctx.getImageData(0, 0, size, size);
}
