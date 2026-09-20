// Web Mercator in world units: x and y from 0 to 1 across the whole world, y growing southward, the way a map
// lays out its picture. A map places an image by the world position of its corners and spreads it evenly between
// them there, so a picture made for that placing has to be sampled in these units, not in lon/lat.

const RAD = Math.PI / 180;

export function lonLatToWorld(lon: number, lat: number): [number, number] {
  const s = Math.sin(lat * RAD);
  return [(lon + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
}

export function worldToLonLat(x: number, y: number): [number, number] {
  return [x * 360 - 180, (360 / Math.PI) * Math.atan(Math.exp((0.5 - y) * 2 * Math.PI)) - 90];
}
