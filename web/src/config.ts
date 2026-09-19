// Basemap: the Commonwealth Map (TCM), a cached Web Mercator map service from the Kentucky Division
// of Geographic Information.
// https://kygisserver.ky.gov/arcgis/rest/services/WGS84WM_Services/Ky_TCM_Base_WGS84WM/MapServer
//
// Checked against the service:
//  - standard XYZ scheme; the ArcGIS URL order is {z}/{y}/{x}
//  - 256 px tiles, mixed PNG (low zoom) and JPEG (high zoom)
//  - the metadata lists levels 0-23, but the cache stops at level 20: level 21 and above answer 404
//  - low zoom levels exist around Kentucky, but from about level 12 up every tile outside the state is a 404
//  - open CORS: the response echoes the requesting origin
export const BASEMAP = {
  tiles:
    'https://kygisserver.ky.gov/arcgis/rest/services/WGS84WM_Services/Ky_TCM_Base_WGS84WM/MapServer/tile/{z}/{y}/{x}',
  tileSize: 256,
  maxzoom: 20,
  // The service's own copyright text.
  attribution: 'Kentucky Division of Geographic Information (DGI)',
} as const;

// West, south, east, north in degrees: the service's full extent, about the state's outline.
export const KENTUCKY_BOUNDS: [number, number, number, number] = [-89.7044, 36.457, -81.8842, 39.152];

// How far the map may be panned. A margin around the state keeps it from drifting into areas
// where the high-zoom basemap tiles do not exist.
export const MAX_BOUNDS: [number, number, number, number] = [
  KENTUCKY_BOUNDS[0] - 0.6,
  KENTUCKY_BOUNDS[1] - 0.6,
  KENTUCKY_BOUNDS[2] + 0.6,
  KENTUCKY_BOUNDS[3] + 0.6,
];
