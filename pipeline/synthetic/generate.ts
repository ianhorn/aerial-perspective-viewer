// A small, invented set of oblique frames in the same shape as the real data, for testing without the vendor's
// GeoPackages (several GB, never committed). It prints SQL that fills the `frames` and `frames_duplicates` tables
// created by pipeline/postgis/schema.sql. It is deterministic: the same output every time.
//
//   node pipeline/synthetic/generate.ts | psql ...
//
// What it makes: ten parallel flight lines running north-south, 1,200 ft apart, alternately flown southbound and
// northbound, with 60 exposures each, 700 ft apart, over flat ground at 500 ft, from about 5,000 ft up. Every exposure
// has the five cameras (Color, Fwd, Bwd, Left, Right), 600 exposures and 3,000 frames in all, which is more than the
// 501 Color frames that checks.sql and the API tests expect. Line 7003 has a short second pass on a later date with a
// higher shot prefix (a re-flight), and one exposure has a duplicate copy. The angles follow the real conventions:
// an oblique looks 45 degrees down along `look = heading + offset` (Fwd 0, Bwd 180, Left -90, Right +90), kappa is
// minus the look direction, and the tilt is carried by omega or phi depending on which way the camera looks (read from
// real frames). Footprints are the photo's four corners projected onto the flat ground with the same camera model as
// the web app (web/src/camera.ts), in the vendor's vertex order (top-left, top-right, bottom-right, bottom-left).
//
// It checks its own work: every oblique's footprint must lie in the direction its kappa says, or it stops.

import { createCamera, type Lens } from '../../web/src/camera.ts';

// A repeatable pseudo-random source (mulberry32), so small imperfections are the same on every run.
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = random(20240319);
const noise = (amount: number): number => (rand() * 2 - 1) * amount;

const SEASON = { key: '2024_Season1', year: 2024, season: 1, folder: 'KY_KYAPED_2024_Season1_3IN' };
const GROUND = 500; // ft, flat
const X0 = 4_905_000, Y0 = 3_950_000; // EPSG:3089, feet: central Kentucky
const LINES = 10, PER_LINE = 60, LINE_GAP = 1200, SHOT_GAP = 700, HEIGHT = 5000;

type Camera = 'Color' | 'Fwd' | 'Bwd' | 'Left' | 'Right';
const CAMERAS: Camera[] = ['Color', 'Fwd', 'Bwd', 'Left', 'Right'];
// The look direction of each oblique relative to the direction of flight, in compass degrees.
const LOOK_OFFSET: Record<Exclude<Camera, 'Color'>, number> = { Fwd: 0, Bwd: 180, Left: -90, Right: 90 };

// The lenses of the newer sensor: the obliques are landscape for Fwd and Bwd and portrait for Left and Right (with the
// principal point 6.68 mm off in y), and the nadir camera is bigger.
const LENS: Record<Camera, Lens & { name: string }> = {
  Color: { name: 'Synthetic_Color', widthPx: 20544, heightPx: 14016, focalMm: 79.6, ccdResUm: 3.76, ppxMm: 0, ppyMm: 0 },
  Fwd: { name: 'Synthetic_Fwd', widthPx: 14144, heightPx: 10560, focalMm: 123.38, ccdResUm: 3.76, ppxMm: 0, ppyMm: 0 },
  Bwd: { name: 'Synthetic_Bwd', widthPx: 14144, heightPx: 10560, focalMm: 123.38, ccdResUm: 3.76, ppxMm: 0, ppyMm: 0 },
  Left: { name: 'Synthetic_Left', widthPx: 10560, heightPx: 14144, focalMm: 123.38, ccdResUm: 3.76, ppxMm: 0, ppyMm: 6.68 },
  Right: { name: 'Synthetic_Right', widthPx: 10560, heightPx: 14144, focalMm: 123.38, ccdResUm: 3.76, ppxMm: 0, ppyMm: 6.68 },
};

const wrap180 = (a: number): number => ((((a + 180) % 360) + 360) % 360) - 180; // (-180, 180]
const wrap360 = (a: number): number => ((a % 360) + 360) % 360;

/** The tilt of an oblique looking (about) north, east, south or west: omega or phi, as in the real frames. */
function tilt(look: number): { omega: number; phi: number } {
  switch (Math.round(wrap360(look) / 90) % 4) {
    case 0: return { omega: 45, phi: 0 };
    case 1: return { omega: 0, phi: -45 };
    case 2: return { omega: -45, phi: 0 };
    default: return { omega: 0, phi: 45 };
  }
}

interface Frame {
  filename: string; fl: string; shot: number; camera: Camera; exposure: string; pass: string; prefix: number; reflight: boolean;
  date: string; localTime: string; utc: string; x: number; y: number; z: number; omega: number; phi: number; kappa: number;
  look: number | null; track: number; kappaErr: number | null; kappaFlag: boolean | null; dup: number; ring: number[][];
}

const pad = (n: number): string => String(n).padStart(2, '0');
/** Local time (EDT, UTC-4) `seconds` after midnight, and the same instant in UTC. */
function times(date: string, seconds: number): { local: string; utc: string } {
  const clock = (s: number): string => `${pad(Math.floor(s / 3600) % 24)}:${pad(Math.floor(s / 60) % 60)}:${pad(Math.floor(s) % 60)}`;
  const utc = seconds + 4 * 3600;
  const day = utc >= 86400 ? new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10) + 1)).toISOString().slice(0, 10) : date;
  return { local: clock(seconds), utc: `${day} ${clock(utc)}` };
}

const frames: Frame[] = [];

/** One exposure: the five cameras at a place along a line, flying on `heading` (0 or 180 degrees). */
function exposure(fl: string, shot: number, date: string, seconds: number, x: number, y: number, headingBase: number): void {
  const heading = wrap360(headingBase + noise(0.4));
  const z = GROUND + HEIGHT + noise(15);
  const { local, utc } = times(date, seconds);
  const prefix = Math.floor(shot / 100000);
  for (const camera of CAMERAS) {
    const cx = x + noise(2), cy = y + noise(2);
    let omega: number, phi: number, kappa: number, look: number | null = null, err: number | null = null;
    if (camera === 'Color') {
      omega = noise(0.3); phi = noise(0.3); kappa = noise(2);
    } else {
      const wanted = wrap360(heading + LOOK_OFFSET[camera]);
      look = wrap360(wanted + noise(0.4)); // what kappa says; a little off the flight line's own direction, as in the data
      const t = tilt(look);
      omega = t.omega + noise(0.3); phi = t.phi + noise(0.3);
      kappa = wrap180(-look);
      err = wrap180(look - wanted);
    }
    const lens = LENS[camera];
    const cam = createCamera({ x: cx, y: cy, z, omega, phi, kappa }, lens);
    const w = lens.widthPx, h = lens.heightPx;
    const ring = [[0, 0], [w, 0], [w, h], [0, h]].map(([col, row]) => {
      const g = cam.pixelToGround(col!, row!, GROUND);
      if (!g) throw new Error(`${camera} ${fl}/${shot}: a corner does not reach the ground`);
      return [g[0], g[1], GROUND];
    });
    ring.push(ring[0]!);
    frames.push({
      filename: `${SEASON.folder}/${camera}_${fl}_${shot}.tif`, fl, shot, camera, exposure: `${SEASON.key}/${fl}/${shot}`,
      pass: `${SEASON.key}/${fl}/${date}/${prefix}`, prefix, reflight: false, date, localTime: local, utc, x: cx, y: cy, z, omega, phi, kappa,
      look, track: heading, kappaErr: err, kappaFlag: err === null ? null : Math.abs(err) > 10, dup: 1, ring: ring as number[][],
    });
  }
}

for (let i = 0; i < LINES; i++) {
  const fl = String(7001 + i);
  const southbound = i % 2 === 0;
  for (let j = 0; j < PER_LINE; j++) {
    // Southbound lines start at the north end. Shots are numbered in the order they were taken.
    const y = Y0 + (southbound ? PER_LINE - 1 - j : j) * SHOT_GAP;
    exposure(fl, 40000 + j, '2024-03-19', 12 * 3600 + i * 1200 + Math.round(j * 3.5), X0 + i * LINE_GAP, y, southbound ? 180 : 0);
  }
}
// A short re-flight of line 7003 on a later date: a second pass with a higher shot prefix, filling in part of the line.
{
  const i = 2;
  for (let j = 20; j < 30; j++) exposure('7003', 140000 + j, '2024-03-26', 13 * 3600 + Math.round((j - 20) * 3.5), X0 + i * LINE_GAP, Y0 + (PER_LINE - 1 - j) * SHOT_GAP, 180);
}

// A re-flight is a pass whose shot prefix is above the smallest one on the same season and line (as the real pipeline infers it).
const smallest = new Map<string, number>();
for (const f of frames) smallest.set(f.fl, Math.min(smallest.get(f.fl) ?? Infinity, f.prefix));
for (const f of frames) f.reflight = f.prefix > smallest.get(f.fl)!;

// One exposure that the source had two copies of: the copy that was kept is in `frames` (dup 2), the other in `frames_duplicates`.
const duplicated = frames.filter((f) => f.fl === '7005' && f.shot === 40030);
for (const f of duplicated) f.dup = 2;

// --- Checks on the generator itself -------------------------------------------------------------------------------
const filenames = new Set(frames.map((f) => f.filename));
if (filenames.size !== frames.length) throw new Error('duplicate file names');
for (const f of frames) {
  const cx = f.ring.slice(0, 4).reduce((s, p) => s + p[0]!, 0) / 4, cy = f.ring.slice(0, 4).reduce((s, p) => s + p[1]!, 0) / 4;
  if (f.look === null) {
    if (Math.hypot(cx - f.x, cy - f.y) > 60) throw new Error(`${f.filename}: a nadir footprint is not under the camera`);
    continue;
  }
  const bearing = wrap360((Math.atan2(cx - f.x, cy - f.y) * 180) / Math.PI);
  if (Math.abs(wrap180(bearing - f.look)) > 3) throw new Error(`${f.filename}: kappa says it looks ${f.look.toFixed(1)} but its footprint lies ${bearing.toFixed(1)} from the camera`);
  const away = Math.hypot(cx - f.x, cy - f.y);
  if (away < 3000 || away > 7000) throw new Error(`${f.filename}: footprint centre is ${away.toFixed(0)} ft away`);
}

// --- SQL --------------------------------------------------------------------------------------------------------------
const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const n = (v: number | null, d = 6): string => (v === null ? 'NULL' : v.toFixed(d));
const wkt = (ring: number[][]): string => `ST_GeomFromText('POLYGON Z ((${ring.map((p) => `${p[0]!.toFixed(3)} ${p[1]!.toFixed(3)} ${p[2]!.toFixed(3)}`).join(', ')}))', 3089)`;

const COLUMNS = `filename, season_key, year, season, fl, shot, camera, exposure_id, pass_id, shot_prefix, is_reflight,
    flight_date, flight_time_local, tz_label, ts_utc, x, y, z, omega, phi, kappa,
    look_azimuth_deg, track_heading_deg, kappa_err_deg, kappa_flag, dup_count,
    cam_name, cam_width_px, cam_height_px, cam_focal_mm, cam_ccd_res_u, cam_ppx_mm, cam_ppy_mm,
    cam_omega_dg, cam_phi_dg, cam_kappa_dg, geom`;

const rows = frames.map((f) => {
  const l = LENS[f.camera];
  return `(${q(f.filename)}, ${q(SEASON.key)}, ${SEASON.year}, ${SEASON.season}, ${q(f.fl)}, ${f.shot}, ${q(f.camera)}, ${q(f.exposure)}, ${q(f.pass)}, ${f.prefix}, ${f.reflight},
    ${q(f.date)}, ${q(f.localTime)}, 'EDT (-4)', ${q(f.utc)}, ${n(f.x, 4)}, ${n(f.y, 4)}, ${n(f.z, 4)}, ${n(f.omega)}, ${n(f.phi)}, ${n(f.kappa)},
    ${f.look === null ? 'NULL' : n(f.look)}, ${n(f.track, 4)}, ${n(f.kappaErr)}, ${f.kappaFlag === null ? 'NULL' : f.kappaFlag}, ${f.dup},
    ${q(l.name)}, ${l.widthPx}, ${l.heightPx}, ${l.focalMm}, ${l.ccdResUm}, ${l.ppxMm}, ${l.ppyMm}, 0, 0, 0, ${wkt(f.ring)})`;
});

console.log('-- Generated by pipeline/synthetic/generate.ts: invented data for tests, not the vendor\'s.');
console.log('BEGIN;');
for (let i = 0; i < rows.length; i += 250) console.log(`INSERT INTO frames (${COLUMNS}) VALUES\n${rows.slice(i, i + 250).join(',\n')};`);
const copies = duplicated.map((f, k) => `(${q(f.filename)}, ${q(SEASON.key)}, ${900000 + k}, 2, 2, ${q(f.camera)}, ${q(f.fl)}, ${f.shot}, ${q(f.exposure)}, ${n(f.x + 0.4, 4)}, ${n(f.y - 0.3, 4)}, ${n(f.z + 0.2, 4)}, ${n(f.omega)}, ${n(f.phi)}, ${n(f.kappa)}, ${wkt(f.ring)})`);
console.log(`INSERT INTO frames_duplicates (filename, season_key, fid, dup_rank, dup_count, camera, fl, shot, exposure_id, x, y, z, omega, phi, kappa, geom) VALUES\n${copies.join(',\n')};`);
console.log('COMMIT;');
console.error(`generated ${frames.length} frames (${frames.length / 5} exposures on ${LINES} lines, ${frames.filter((f) => f.reflight).length} re-flight frames), ${duplicated.length} duplicate copies`);
