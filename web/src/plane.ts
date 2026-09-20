// The little aeroplane that marks where the camera was, drawn once onto a canvas and handed to the map as an
// image. It is drawn pointing up (north); the map turns it to the direction of flight. Made here, not loaded,
// so there is no file to fetch and it is ready before the first frame is shown.
//
// It is a Cessna 172 seen from above: a high, straight wing with rounded tips, a slim fuselage that narrows to the
// tail, a small tailplane, a windshield ahead of the wing, and the propeller's blur at the nose. The proportions
// follow the real aeroplane (wingspan 36 ft, length 27 ft, wing chord 5 ft, tailplane span 11 ft), squeezed a little
// so the wings fit the 64 unit drawing.

const VIEW = 64; // the drawing is laid out on a 64 by 64 grid
const RED = '#e53935'; // the footprint's colour
const RED_DARK = '#b71c1c';

// The fuselage: round cowling at the nose, a cabin that widens to the wing, then a long taper to the tail.
const FUSELAGE =
  'M32 9.5 Q35.2 9.5 35.6 12.5 L35.6 16.5 Q36.3 18.5 36.4 21 L36.4 30 Q36 36 34.2 42 L33.2 54.5 Q32.6 56 32 56 ' +
  'Q31.4 56 30.8 54.5 L29.8 42 Q28 36 27.6 30 L27.6 21 Q27.7 18.5 28.4 16.5 L28.4 12.5 Q28.8 9.5 32 9.5 Z';
// The wing sits on top of the cabin: straight, the same chord along most of its length, tapering and rounded at the tips.
const WINGS =
  'M32 21.5 L52 21.5 Q59.5 21.5 59.5 24.3 L59.5 26 Q59.5 28 57.5 28.2 L52 29.5 L12 29.5 L6.5 28.2 Q4.5 28 4.5 26 ' +
  'L4.5 24.3 Q4.5 21.5 12 21.5 Z';
// The tailplane, near the end of the fuselage.
const TAILPLANE =
  'M32 48.5 L38 48.5 Q41.8 48.5 41.8 50.5 L41.8 52.5 Q41.8 53.8 40.3 53.8 L23.7 53.8 Q22.2 53.8 22.2 52.5 ' +
  'L22.2 50.5 Q22.2 48.5 26 48.5 Z';
// The windshield, in front of the wing (the wing hides the rest of the cabin), and a small rear window behind it.
const WINDSHIELD = 'M28.6 17 Q32 15.6 35.4 17 L36 21.2 L28 21.2 Z';
const REAR_WINDOW = 'M28.6 30.2 L35.4 30.2 L34.6 33.6 L29.4 33.6 Z';

/** The plane as RGBA pixels, `size` pixels square, for `map.addImage`. Use a size of twice the size on screen. */
export function planeImage(size = 80): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2D canvas context');
  ctx.scale(size / VIEW, size / VIEW);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // The propeller's blur, in front of the nose.
  const propeller = (): void => {
    ctx.beginPath();
    ctx.moveTo(26.6, 8.7);
    ctx.lineTo(37.4, 8.7);
  };

  // A white outline first, so the plane reads on both dark trees and pale roads.
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 4;
  propeller();
  ctx.stroke();
  for (const path of [WINGS, TAILPLANE, FUSELAGE]) ctx.stroke(new Path2D(path));

  ctx.strokeStyle = 'rgba(38, 50, 56, 0.85)';
  ctx.lineWidth = 1.7;
  propeller();
  ctx.stroke();

  // Bottom to top: the fuselage, its windows, then the tailplane and the wing over it (the wing is high, over the cabin).
  ctx.fillStyle = RED;
  ctx.fill(new Path2D(FUSELAGE));
  ctx.fillStyle = '#d6ecff';
  ctx.fill(new Path2D(WINDSHIELD));
  ctx.fill(new Path2D(REAR_WINDOW));
  ctx.fillStyle = RED_DARK;
  ctx.fill(new Path2D(TAILPLANE));
  ctx.fill(new Path2D(WINGS));

  // Details: the spinner, the seams of the flaps and ailerons on the wing, and the fin along the tail.
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(32, 10.6, 1.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.lineWidth = 0.9;
  for (const x of [22.5, 41.5]) {
    ctx.beginPath();
    ctx.moveTo(x, 22.5);
    ctx.lineTo(x, 28.6);
    ctx.stroke();
  }
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(32, 36);
  ctx.lineTo(32, 55);
  ctx.stroke();

  return ctx.getImageData(0, 0, size, size);
}
