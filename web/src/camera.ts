// The camera model for one photo: where a ground point lands in the picture, and which ground a picture
// pixel sees. It is the pinhole model from the exterior orientation (EO) and the lens data, checked against
// 1,000 real frames (median 0.002 px against the vendor's footprint corners) and against the state's
// orthoimagery.
//
//   v = M (P - C)                 M = Rz(-kappa) Ry(-phi) Rx(-omega), angles in degrees
//   x = -f vx / vz + ppx          y = -f vy / vz + ppy        (mm from the sensor centre)
//   col = W/2 + x / pix           row = H/2 - y / pix         (pixel size in mm, from the CCD resolution)
//
// P is a ground point and C the camera position, both in EPSG:3089 feet. The camera looks along -z, so a
// point in front of it has vz < 0. The principal point offsets (ppx, ppy) are added with a plus sign.
// Everything is in the full-size photo's pixels; scale for an overview.

export interface Exterior {
  x: number;
  y: number;
  z: number;
  omega: number;
  phi: number;
  kappa: number;
}

export interface Lens {
  widthPx: number;
  heightPx: number;
  focalMm: number;
  ccdResUm: number;
  ppxMm: number;
  ppyMm: number;
  /** Lens mounting angles. Zero on every frame in the data, and the model does not apply them. */
  omegaDg?: number;
  phiDg?: number;
  kappaDg?: number;
}

export interface Camera {
  readonly widthPx: number;
  readonly heightPx: number;
  /** The camera position, in grid feet. */
  readonly position: readonly [number, number, number];
  /** Pixel `[col, row]` of a ground point, or null when the point is behind the camera. */
  groundToPixel(x: number, y: number, z: number): [number, number] | null;
  /** Grid `[x, y]` where the ray through a pixel meets the horizontal plane at height `z`, or null when it doesn't reach it. */
  pixelToGround(col: number, row: number, z: number): [number, number] | null;
}

type Matrix = readonly [number, number, number, number, number, number, number, number, number];

const RAD = Math.PI / 180;

const rotX = (a: number): Matrix => [1, 0, 0, 0, Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a)];
const rotY = (a: number): Matrix => [Math.cos(a), 0, Math.sin(a), 0, 1, 0, -Math.sin(a), 0, Math.cos(a)];
const rotZ = (a: number): Matrix => [Math.cos(a), -Math.sin(a), 0, Math.sin(a), Math.cos(a), 0, 0, 0, 1];

function multiply(a: Matrix, b: Matrix): Matrix {
  const out: number[] = [];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) out.push(a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!);
  }
  return out as unknown as Matrix;
}

export function createCamera(eo: Exterior, lens: Lens): Camera {
  if (lens.omegaDg || lens.phiDg || lens.kappaDg) {
    // Never seen: 0 of 4,384,880 frames. Better to stop than to draw a photo in the wrong place.
    throw new Error('lens mounting angles are not zero, and the camera model does not apply them');
  }
  const m = multiply(multiply(rotZ(-eo.kappa * RAD), rotY(-eo.phi * RAD)), rotX(-eo.omega * RAD));
  const { widthPx: w, heightPx: h, focalMm: f, ppxMm, ppyMm } = lens;
  const pix = lens.ccdResUm / 1000;

  return {
    widthPx: w,
    heightPx: h,
    position: [eo.x, eo.y, eo.z],
    groundToPixel(x, y, z) {
      const dx = x - eo.x;
      const dy = y - eo.y;
      const dz = z - eo.z;
      const vz = m[6] * dx + m[7] * dy + m[8] * dz;
      if (vz >= 0) return null;
      const vx = m[0] * dx + m[1] * dy + m[2] * dz;
      const vy = m[3] * dx + m[4] * dy + m[5] * dz;
      return [w / 2 + (-f * vx / vz + ppxMm) / pix, h / 2 - (-f * vy / vz + ppyMm) / pix];
    },
    pixelToGround(col, row, z) {
      // A vector in camera space along the ray, then back to the world with the transpose of M.
      const vx = (col - w / 2) * pix - ppxMm;
      const vy = (h / 2 - row) * pix - ppyMm;
      const vz = -f;
      const dx = m[0] * vx + m[3] * vy + m[6] * vz;
      const dy = m[1] * vx + m[4] * vy + m[7] * vz;
      const dz = m[2] * vx + m[5] * vy + m[8] * vz;
      const s = (z - eo.z) / dz;
      if (!(s > 0)) return null;
      return [eo.x + s * dx, eo.y + s * dy];
    },
  };
}
