import type pg from 'pg';

// All SQL lives here, every value is a bound parameter, and the selection rule itself stays in the
// database (pipeline/postgis/functions.sql). This module only shapes rows into JSON.

const round = (value: number | null, digits: number): number | null =>
  value === null || value === undefined ? null : Math.round(value * 10 ** digits) / 10 ** digits;

/** '2023-04-19 17:09:37' (a UTC timestamp without zone, as pg returns it) -> '2023-04-19T17:09:37Z'. */
const isoUtc = (value: string): string => `${value.replace(' ', 'T')}Z`;

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

interface PickRow {
  pick: number; filename: string; camera: string; look_azimuth_deg: number | null; az_off_deg: number | null;
  az_ok: boolean; eligible: boolean; is_reflight: boolean; ts_utc: string; pass_id: string; shot: number;
  center_dist_ft: number; edge_frac: number | null; est_gsd_ft: number | null;
}

export async function framesAtPoint(
  pool: pg.Pool, imageBase: string, lon: number, lat: number, azimuth: number | null, limit: number,
): Promise<FramePick[]> {
  // frames_at_lonlat takes WGS84 and applies the default tolerance, margin and resolution limit.
  const { rows } = await pool.query<PickRow>(
    'SELECT * FROM frames_at_lonlat($1::double precision, $2::double precision, $3::double precision, $4::integer)',
    [lon, lat, azimuth, limit],
  );
  return rows.map((r) => ({
    pick: r.pick,
    filename: r.filename,
    url: imageBase + r.filename,
    camera: r.camera,
    lookAzimuth: round(r.look_azimuth_deg, 1),
    azOff: round(r.az_off_deg, 1),
    azOk: r.az_ok,
    eligible: r.eligible,
    isReflight: r.is_reflight,
    flownUtc: isoUtc(r.ts_utc),
    passId: r.pass_id,
    shot: r.shot,
    centerDistFt: Math.round(r.center_dist_ft),
    edgeFrac: round(r.edge_frac, 2),
    estGsdFt: round(r.est_gsd_ft, 3),
  }));
}

export interface FrameDetail {
  filename: string;
  url: string;
  sidecarUrl: string;
  seasonKey: string;
  fl: string;
  shot: number;
  camera: string;
  exposureId: string;
  passId: string;
  shotPrefix: number;
  isReflight: boolean;
  flown: { localDate: string; localTime: string; timeZone: string; utc: string };
  /** Exterior orientation. Position is EPSG:3089 (Kentucky Single Zone, US survey feet). Angles are degrees. */
  eo: { x: number; y: number; z: number; omega: number; phi: number; kappa: number; lon: number; lat: number };
  lookAzimuth: number | null;
  trackHeading: number | null;
  kappaErr: number | null;
  kappaFlag: boolean | null;
  sensor: {
    name: string | null; widthPx: number | null; heightPx: number | null; focalMm: number | null; ccdResUm: number | null;
    ppxMm: number | null; ppyMm: number | null; omegaDg: number | null; phiDg: number | null; kappaDg: number | null;
  };
  /** The ground footprint as GeoJSON in WGS84 (for the map) ... */
  footprintLonLat: unknown;
  /** ... and as [x, y, z] corners in EPSG:3089 feet (for projecting into the photo). */
  footprint3089: number[][];
}

const DETAIL_SQL = `
  SELECT filename, season_key, fl, shot, camera, exposure_id, pass_id, shot_prefix, is_reflight,
         flight_date::text AS flight_date, flight_time_local, tz_label, ts_utc,
         x, y, z, omega, phi, kappa, look_azimuth_deg, track_heading_deg, kappa_err_deg, kappa_flag,
         cam_name, cam_width_px, cam_height_px, cam_focal_mm, cam_ccd_res_u, cam_ppx_mm, cam_ppy_mm,
         cam_omega_dg, cam_phi_dg, cam_kappa_dg,
         ST_X(ST_Transform(ST_SetSRID(ST_MakePoint(x, y), 3089), 4326)) AS cam_lon,
         ST_Y(ST_Transform(ST_SetSRID(ST_MakePoint(x, y), 3089), 4326)) AS cam_lat,
         ST_AsGeoJSON(ST_Transform(ST_Force2D(geom), 4326), 6)::json AS footprint_lonlat,
         (SELECT json_agg(json_build_array(ST_X(d.geom), ST_Y(d.geom), ST_Z(d.geom)) ORDER BY d.path)
            FROM ST_DumpPoints(geom) d) AS footprint_3089
  FROM frames WHERE filename = $1`;

export async function frameDetail(pool: pg.Pool, imageBase: string, filename: string): Promise<FrameDetail | null> {
  const { rows } = await pool.query(DETAIL_SQL, [filename]);
  const r = rows[0];
  if (!r) return null;
  return {
    filename: r.filename,
    url: imageBase + r.filename,
    sidecarUrl: imageBase + r.filename.replace(/\.tif$/, '.json'),
    seasonKey: r.season_key,
    fl: r.fl,
    shot: r.shot,
    camera: r.camera,
    exposureId: r.exposure_id,
    passId: r.pass_id,
    shotPrefix: r.shot_prefix,
    isReflight: r.is_reflight,
    flown: { localDate: r.flight_date, localTime: r.flight_time_local, timeZone: r.tz_label, utc: isoUtc(r.ts_utc) },
    eo: { x: r.x, y: r.y, z: r.z, omega: r.omega, phi: r.phi, kappa: r.kappa, lon: round(r.cam_lon, 6)!, lat: round(r.cam_lat, 6)! },
    lookAzimuth: round(r.look_azimuth_deg, 2),
    trackHeading: round(r.track_heading_deg, 2),
    kappaErr: round(r.kappa_err_deg, 2),
    kappaFlag: r.kappa_flag,
    sensor: {
      name: r.cam_name, widthPx: r.cam_width_px, heightPx: r.cam_height_px, focalMm: r.cam_focal_mm, ccdResUm: r.cam_ccd_res_u,
      ppxMm: r.cam_ppx_mm, ppyMm: r.cam_ppy_mm, omegaDg: r.cam_omega_dg, phiDg: r.cam_phi_dg, kappaDg: r.cam_kappa_dg,
    },
    footprintLonLat: r.footprint_lonlat,
    footprint3089: r.footprint_3089,
  };
}

export interface Neighbor {
  direction: 'next' | 'prev';
  filename: string;
  url: string;
  shot: number;
  distFt: number;
}

export async function frameNeighbors(pool: pg.Pool, imageBase: string, filename: string): Promise<Neighbor[]> {
  const { rows } = await pool.query<{ direction: 'next' | 'prev'; filename: string; shot: number; dist_ft: number }>(
    'SELECT direction, filename, shot, dist_ft FROM frame_neighbors($1)', [filename]);
  return rows.map((r) => ({
    direction: r.direction, filename: r.filename, url: imageBase + r.filename, shot: r.shot, distFt: Math.round(r.dist_ft),
  }));
}
