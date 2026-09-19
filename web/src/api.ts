// The frames API (api/). In development Vite proxies /api to it, so the browser stays on one origin.

export type Look = 'down' | 'north' | 'east' | 'south' | 'west';

export interface FramePick {
  pick: number;
  filename: string;
  url: string;
  camera: string;
  lookAzimuth: number | null;
  azOff: number | null;
  azOk: boolean;
  eligible: boolean;
  isReflight: boolean;
  flownUtc: string;
  passId: string;
  shot: number;
  centerDistFt: number;
  edgeFrac: number | null;
  estGsdFt: number | null;
}

export interface FramesResponse {
  query: { lon: number; lat: number; look: string; azimuth: number | null; limit: number };
  frames: FramePick[];
}

/** The part of a frame's detail that the map uses: where it stood, what it saw, and what it needs to place the photo. */
export interface FrameDetail {
  filename: string;
  camera: string;
  /** The direction the camera looks, a grid bearing in degrees. Null for the Color camera. */
  lookAzimuth: number | null;
  /** The aircraft's ground-track heading where it could be worked out (Color frames only), a grid bearing. */
  trackHeading: number | null;
  eo: { x: number; y: number; z: number; omega: number; phi: number; kappa: number; lon: number; lat: number };
  sensor: { widthPx: number; heightPx: number; focalMm: number; ccdResUm: number; ppxMm: number; ppyMm: number; omegaDg: number; phiDg: number; kappaDg: number };
  footprintLonLat: { type: 'Polygon'; coordinates: number[][][] };
  /** The vendor's footprint in EPSG:3089 feet: `[x, y, z]` corners, closed. */
  footprint3089: [number, number, number][];
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new ApiError(response.status, `${url} answered ${response.status}`);
  return (await response.json()) as T;
}

export function getFrames(lon: number, lat: number, look: Look, signal?: AbortSignal): Promise<FramesResponse> {
  const query = new URLSearchParams({ lon: String(lon), lat: String(lat), look, limit: '5' });
  return getJson<FramesResponse>(`/api/frames?${query}`, signal);
}

/** A frame is addressed by its season folder and file name, which the API takes as two path segments. */
export function getFrame(filename: string, signal?: AbortSignal): Promise<FrameDetail> {
  return getJson<FrameDetail>(`/api/frames/${filename}`, signal);
}

/** A frame chosen for a map view, with what is needed to lay it on the ground (see `/api/scene`). */
export interface SceneFrame {
  filename: string;
  url: string;
  camera: string;
  lookAzimuth: number | null;
  isReflight: boolean;
  flownUtc: string;
  wins: number;
  eo: { x: number; y: number; z: number; omega: number; phi: number; kappa: number };
  sensor: { widthPx: number; heightPx: number; focalMm: number; ccdResUm: number; ppxMm: number; ppyMm: number; omegaDg: number; phiDg: number; kappaDg: number };
  footprint3089: number[][];
}

export interface ViewBox { west: number; south: number; east: number; north: number }

/** The frames to show for a view seen from one direction, best first (an empty list where nothing looks that way). */
export async function getScene(box: ViewBox, look: Exclude<Look, 'down'>, signal?: AbortSignal): Promise<SceneFrame[]> {
  const query = new URLSearchParams({ west: String(box.west), south: String(box.south), east: String(box.east), north: String(box.north), look, limit: '6' });
  return (await getJson<{ frames: SceneFrame[] }>(`/api/scene?${query}`, signal)).frames;
}
