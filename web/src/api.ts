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

/** The part of a frame's detail that the map uses: where it stood and what it saw. */
export interface FrameDetail {
  filename: string;
  eo: { lon: number; lat: number };
  footprintLonLat: { type: 'Polygon'; coordinates: number[][][] };
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
