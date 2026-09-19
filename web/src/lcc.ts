// EPSG:3089 (NAD83 / Kentucky Single Zone, US survey feet) to and from lon/lat, so the browser can place
// ground points computed from a camera model. It is a Lambert Conformal Conic with two standard parallels
// (Snyder, "Map Projections: A Working Manual", equations 15-1 to 15-11) on the GRS80 ellipsoid.
// The parameters are the ones PostGIS holds for SRID 3089. The difference between NAD83 and WGS84 (about a
// metre) is ignored, as it is in the API.

const A = 6378137; // GRS80 semi-major axis, metres
const F = 1 / 298.257222101;
const E = Math.sqrt(2 * F - F * F);
const FT_PER_M = 3937 / 1200; // US survey foot
const RAD = Math.PI / 180;

const LAT1 = 37.08333333333334 * RAD;
const LAT2 = 38.66666666666666 * RAD;
const LAT0 = 36.33333333333334 * RAD;
const LON0 = -85.75 * RAD;
const X0 = 1500000; // metres
const Y0 = 999999.9998983998;

const m = (phi: number): number => Math.cos(phi) / Math.sqrt(1 - E * E * Math.sin(phi) ** 2);
const t = (phi: number): number => {
  const s = E * Math.sin(phi);
  return Math.tan(Math.PI / 4 - phi / 2) / ((1 - s) / (1 + s)) ** (E / 2);
};

const N = (Math.log(m(LAT1)) - Math.log(m(LAT2))) / (Math.log(t(LAT1)) - Math.log(t(LAT2)));
const F_CONST = m(LAT1) / (N * t(LAT1) ** N);
const RHO0 = A * F_CONST * t(LAT0) ** N;

/** Grid coordinates (EPSG:3089, feet) to [lon, lat] in degrees. */
export function gridToLonLat(x: number, y: number): [number, number] {
  const dx = x / FT_PER_M - X0;
  const dy = RHO0 - (y / FT_PER_M - Y0);
  const rho = Math.hypot(dx, dy); // N is positive, so no sign to carry
  const tt = (rho / (A * F_CONST)) ** (1 / N);
  const theta = Math.atan2(dx, dy);
  let phi = Math.PI / 2 - 2 * Math.atan(tt);
  for (let i = 0; i < 8; i++) {
    const s = E * Math.sin(phi);
    const next = Math.PI / 2 - 2 * Math.atan(tt * ((1 - s) / (1 + s)) ** (E / 2));
    const done = Math.abs(next - phi) < 1e-13;
    phi = next;
    if (done) break;
  }
  return [(theta / N + LON0) / RAD, phi / RAD];
}

/** [lon, lat] in degrees to grid coordinates (EPSG:3089, feet). */
export function lonLatToGrid(lon: number, lat: number): [number, number] {
  const rho = A * F_CONST * t(lat * RAD) ** N;
  const theta = N * (lon * RAD - LON0);
  return [(X0 + rho * Math.sin(theta)) * FT_PER_M, (Y0 + RHO0 - rho * Math.cos(theta)) * FT_PER_M];
}
