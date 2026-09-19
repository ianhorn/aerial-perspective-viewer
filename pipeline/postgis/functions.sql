-- Query layer: choosing frames for a point and walking along a pass. Recreates the objects, so it
-- is safe to rerun. Run after the tables and indexes exist (load_postgis.sh does this).
--
-- Coordinates are EPSG:3089 (feet) unless the function name says lonlat.
-- Azimuths are compass bearings in degrees clockwise from grid north, and describe the direction
-- the camera LOOKS (a "north" view is a camera that looks north).

DROP FUNCTION IF EXISTS frames_at_lonlat(double precision, double precision, double precision, integer);
DROP FUNCTION IF EXISTS frames_at_point(double precision, double precision, double precision, double precision, double precision, double precision, integer);
DROP FUNCTION IF EXISTS frame_neighbors(text, integer, double precision);
DROP FUNCTION IF EXISTS angle_diff(double precision, double precision);
DROP TYPE IF EXISTS frame_pick;
DROP TYPE IF EXISTS frame_neighbor;

-- Absolute difference between two bearings, in [0, 180].
CREATE FUNCTION angle_diff(a double precision, b double precision) RETURNS double precision
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT abs(((a - b + 540) - 360 * floor((a - b + 540) / 360)) - 180)
$$;

CREATE TYPE frame_pick AS (
    pick            integer,           -- 1 = the frame the rule chooses
    filename        text,
    camera          text,
    look_azimuth_deg double precision,
    az_off_deg      double precision,  -- distance of the look direction from the requested one
    az_ok           boolean,           -- within the tolerance
    eligible        boolean,           -- far enough from the edge, and fine enough resolution
    is_reflight     boolean,
    ts_utc          timestamp,
    pass_id         text,
    shot            bigint,
    center_dist_ft  double precision,  -- point to footprint centroid
    edge_frac       double precision,  -- point to footprint edge, as a fraction of sqrt(area)
    est_gsd_ft      double precision   -- estimated ground sample distance at the point
);

-- Frames that cover a point, best first.
--   want_azimuth   direction the camera should look; NULL means straight down (Color camera)
--   az_tolerance   degrees; frames outside it rank below every frame inside it
--   min_edge_frac  the point must be at least this fraction of sqrt(footprint area) from the edge
--   max_gsd_ft     the vendor's limit for reliable far-oblique pixels (0.4 ft)
-- Ranking: inside the azimuth tolerance, then (if none) the closest azimuth; eligible before
-- ineligible; reflights first (inferred, see CLAUDE.md); then nearest to the frame center;
-- then newest.
-- est_gsd_ft = slant range from camera to point * pixel size / focal length. The ground height is
-- taken as the mean of the footprint's lowest and highest Z. Averaged at footprint centroids it
-- reproduces the vendor's 0.217 ft average GSD to within about 5%.
CREATE FUNCTION frames_at_point(
    px double precision, py double precision,
    want_azimuth  double precision DEFAULT NULL,
    az_tolerance  double precision DEFAULT 30,
    min_edge_frac double precision DEFAULT 0.10,
    max_gsd_ft    double precision DEFAULT 0.40,
    lim           integer          DEFAULT 5)
RETURNS SETOF frame_pick
LANGUAGE sql STABLE PARALLEL SAFE AS $$
WITH pt AS MATERIALIZED (
    SELECT ST_SetSRID(ST_MakePoint(px, py), 3089) AS g
), c AS (
    SELECT f.filename, f.camera, f.look_azimuth_deg, f.is_reflight, f.ts_utc, f.pass_id, f.shot,
           CASE WHEN want_azimuth IS NULL THEN 0 ELSE angle_diff(f.look_azimuth_deg, want_azimuth) END AS az_off,
           ST_Distance(ST_Centroid(f.geom), pt.g) AS center_dist,
           ST_Distance(ST_Boundary(f.geom), pt.g) / NULLIF(sqrt(ST_Area(f.geom)), 0) AS edge_frac,
           sqrt((f.x - px)^2 + (f.y - py)^2 + (f.z - (ST_ZMin(f.geom) + ST_ZMax(f.geom)) / 2)^2)
             * f.cam_ccd_res_u * 1e-3 / f.cam_focal_mm AS gsd
    FROM frames f JOIN pt ON ST_Intersects(f.geom, pt.g)
    WHERE (want_azimuth IS NULL AND f.camera = 'Color')
       OR (want_azimuth IS NOT NULL AND f.camera <> 'Color')
), r AS (
    SELECT c.*, c.az_off <= az_tolerance AS az_ok,
           coalesce(c.edge_frac >= min_edge_frac AND c.gsd <= max_gsd_ft, false) AS eligible
    FROM c
)
SELECT (row_number() OVER (ORDER BY r.az_ok DESC, CASE WHEN r.az_ok THEN 0 ELSE r.az_off END,
                                    r.eligible DESC, r.is_reflight DESC, r.center_dist, r.ts_utc DESC, r.filename))::integer,
       r.filename, r.camera, r.look_azimuth_deg, r.az_off, r.az_ok, r.eligible, r.is_reflight,
       r.ts_utc, r.pass_id, r.shot, r.center_dist, r.edge_frac, r.gsd
FROM r
ORDER BY 1
LIMIT lim
$$;

-- The same for a WGS84 longitude and latitude (what a web map gives you).
CREATE FUNCTION frames_at_lonlat(
    lon double precision, lat double precision,
    want_azimuth double precision DEFAULT NULL,
    lim integer DEFAULT 5)
RETURNS SETOF frame_pick
LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT (frames_at_point(ST_X(p), ST_Y(p), want_azimuth, 30, 0.10, 0.40, lim)).*
    FROM (SELECT ST_Transform(ST_SetSRID(ST_MakePoint(lon, lat), 4326), 3089) AS p) t
$$;

CREATE TYPE frame_neighbor AS (
    direction text,             -- 'next' or 'prev' in shot order
    filename  text,
    shot      bigint,
    dist_ft   double precision  -- camera-to-camera distance
);

-- The frame before and after this one along its pass, same camera. Returns nothing for a side that
-- is the end of the pass or sits across a discontinuity: a shot number more than max_shot_gap away,
-- or a camera position more than max_dist_ft away (the thresholds validated in CLAUDE.md).
CREATE FUNCTION frame_neighbors(
    fname text,
    max_shot_gap integer          DEFAULT 5,
    max_dist_ft  double precision DEFAULT 3000)
RETURNS SETOF frame_neighbor
LANGUAGE sql STABLE PARALLEL SAFE AS $$
    WITH cur AS (SELECT pass_id, camera, shot, x, y FROM frames WHERE filename = fname)
    SELECT 'next', n.filename, n.shot, n.d
    FROM cur, LATERAL (SELECT f.filename, f.shot, sqrt((f.x - cur.x)^2 + (f.y - cur.y)^2) AS d
                       FROM frames f WHERE f.pass_id = cur.pass_id AND f.camera = cur.camera AND f.shot > cur.shot
                       ORDER BY f.shot LIMIT 1) n
    WHERE n.shot - cur.shot <= max_shot_gap AND n.d <= max_dist_ft
    UNION ALL
    SELECT 'prev', n.filename, n.shot, n.d
    FROM cur, LATERAL (SELECT f.filename, f.shot, sqrt((f.x - cur.x)^2 + (f.y - cur.y)^2) AS d
                       FROM frames f WHERE f.pass_id = cur.pass_id AND f.camera = cur.camera AND f.shot < cur.shot
                       ORDER BY f.shot DESC LIMIT 1) n
    WHERE cur.shot - n.shot <= max_shot_gap AND n.d <= max_dist_ft
$$;
