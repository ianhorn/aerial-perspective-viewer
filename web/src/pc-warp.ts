// A fast way to turn many grid positions (EPSG:3089 feet) into Web Mercator, for millions of points. The exact conversion (a Lambert
// conic to longitude and latitude, then the Mercator formula) is done once at the corners of a lattice laid over the area, and every
// point is placed by bilinear interpolation between four corners: two multiplies and adds instead of a run of trigonometry. With the
// lattice 250 ft apart the interpolation is off by well under a millimetre (see the test). Web Mercator here is in map units, 0 to 1
// round the world, like MapLibre's. No DOM here.

import { gridToLonLat } from './lcc.ts';

const RAD = Math.PI / 180;

/** Longitude and latitude in degrees to Web Mercator units (x east, y south, 0 to 1 round the world), as MapLibre's `MercatorCoordinate`. */
export function lonLatToMercator(lon: number, lat: number): [number, number] {
  return [(lon + 180) / 360, 0.5 - Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2)) / (2 * Math.PI)];
}

/** How much a distance of one metre is in Web Mercator units at a latitude (the map is bigger away from the equator). */
export const metreInMercator = (lat: number): number => 1 / (40075016.686 * Math.cos(lat * RAD));

export class Warp {
  readonly x0: number;
  readonly y0: number;
  readonly cell: number;
  readonly cols: number;
  readonly rows: number;
  /** The lattice: for each corner, x then y, in Web Mercator units. */
  readonly mx: Float64Array;
  readonly my: Float64Array;

  /** `box` is [xmin, ymin, xmax, ymax] in grid feet; the lattice covers it and a little more. */
  constructor(box: readonly [number, number, number, number], cell = 250) {
    this.x0 = box[0] - cell;
    this.y0 = box[1] - cell;
    this.cell = cell;
    this.cols = Math.ceil((box[2] - box[0]) / cell) + 3;
    this.rows = Math.ceil((box[3] - box[1]) / cell) + 3;
    this.mx = new Float64Array(this.cols * this.rows);
    this.my = new Float64Array(this.cols * this.rows);
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const [lon, lat] = gridToLonLat(this.x0 + c * cell, this.y0 + r * cell);
        const [x, y] = lonLatToMercator(lon, lat);
        this.mx[r * this.cols + c] = x;
        this.my[r * this.cols + c] = y;
      }
    }
  }

  /** The Web Mercator position of a grid position inside the lattice's area, written into `out` at `at` and `at + 1`. */
  place(x: number, y: number, out: Float64Array, at = 0): void {
    const u = (x - this.x0) / this.cell, v = (y - this.y0) / this.cell;
    const c = Math.min(Math.max(Math.floor(u), 0), this.cols - 2), r = Math.min(Math.max(Math.floor(v), 0), this.rows - 2);
    const fu = u - c, fv = v - r;
    const i = r * this.cols + c, j = i + this.cols;
    const w00 = (1 - fu) * (1 - fv), w10 = fu * (1 - fv), w01 = (1 - fu) * fv, w11 = fu * fv;
    out[at] = this.mx[i]! * w00 + this.mx[i + 1]! * w10 + this.mx[j]! * w01 + this.mx[j + 1]! * w11;
    out[at + 1] = this.my[i]! * w00 + this.my[i + 1]! * w10 + this.my[j]! * w01 + this.my[j + 1]! * w11;
  }
}
