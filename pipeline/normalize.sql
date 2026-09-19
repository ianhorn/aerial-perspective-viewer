-- Normalization of the vendor frame tables. Run through pipeline/normalize.sh, which first
-- loads raw_frames (ImageFrames) and raw_eo (ImageFrameEO), one row per source row.
-- raw_frames.rn is the row order in the GeoPackage, which equals fid. raw_eo.fid is the fid.
--
-- Every rule below is explained in CLAUDE.md. Checks fail the run (duckdb -bail).

-- ---------------------------------------------------------------------------------------------
-- Constants
-- ---------------------------------------------------------------------------------------------
-- S3 base for every frame. Phase3 is the only oblique collection.
CREATE MACRO s3_base() AS 'https://kyfromabove.s3.amazonaws.com/imagery/obliques/Phase3/';

-- Signed difference of two angles, in [-180, 180).
CREATE MACRO wrap(a) AS (((a % 360) + 540) % 360) - 180;

-- Fail the run when n is not zero.
CREATE MACRO must_be_zero(n, msg) AS
  CASE WHEN n = 0 THEN 0 ELSE error('CHECK FAILED: ' || msg || ' (' || n::VARCHAR || ' rows)') END;

-- ---------------------------------------------------------------------------------------------
-- 1. Integrity of the source
-- ---------------------------------------------------------------------------------------------
SELECT must_be_zero((SELECT count(*) FROM (
    SELECT season_key FROM raw_frames GROUP BY season_key
    EXCEPT SELECT season_key FROM raw_eo GROUP BY season_key)), 'season present in frames but not EO');

-- Frames and EO have the same number of rows per season.
SELECT must_be_zero((SELECT count(*) FROM (
    SELECT f.season_key FROM (SELECT season_key, count(*) n FROM raw_frames GROUP BY 1) f
    FULL JOIN (SELECT season_key, count(*) n FROM raw_eo GROUP BY 1) e USING (season_key)
    WHERE f.n IS DISTINCT FROM e.n)), 'frames and EO row counts differ');

-- Row k of Frames is the same frame as fid k of EO (this is how duplicate copies are paired).
SELECT must_be_zero((SELECT count(*) FROM raw_frames r JOIN raw_eo e ON e.season_key = r.season_key AND e.fid = r.rn
    WHERE e.ID IS DISTINCT FROM regexp_replace(r.Filename, '\.tif$', '')),
    'Frames row k and EO fid k are different frames');
SELECT must_be_zero((SELECT count(*) FROM raw_frames r LEFT JOIN raw_eo e ON e.season_key = r.season_key AND e.fid = r.rn
    WHERE e.fid IS NULL), 'Frames row without an EO row at the same fid');

SELECT must_be_zero((SELECT count(*) FROM raw_frames WHERE S3URL IS DISTINCT FROM s3_base() || Filename),
    'S3URL is not the base path plus Filename');
SELECT must_be_zero((SELECT count(*) FROM raw_frames
    WHERE NOT starts_with(Filename, 'KY_KYAPED_' || season_key || '_3IN/')), 'Filename not under its season folder');
SELECT must_be_zero((SELECT count(*) FROM raw_frames
    WHERE CameraID NOT IN ('Color', 'Fwd', 'Bwd', 'Left', 'Right')), 'unexpected CameraID');
-- ShotID is Cam_FL_shot or Cam_YYYYMMDD_FL_shot. The last two parts must be FL and a number.
SELECT must_be_zero((SELECT count(*) FROM raw_frames
    WHERE regexp_extract(ShotID, '_(\d+)_\d+$', 1) IS DISTINCT FROM FL
       OR TRY_CAST(regexp_extract(ShotID, '_(\d+)$', 1) AS BIGINT) IS NULL
       OR split_part(ShotID, '_', 1) IS DISTINCT FROM CameraID
       OR ShotID || '.tif' IS DISTINCT FROM regexp_replace(Filename, '^.*/', '')),
    'ShotID does not parse as Cam_[date_]FL_shot or does not match Filename/FL/CameraID');
SELECT must_be_zero((SELECT count(*) FROM raw_frames
    WHERE TRY_CAST(regexp_extract(TimeZone, '\((-?\d+)\)', 1) AS INT) IS NULL
       OR TRY_CAST(FlightTime AS TIME) IS NULL OR FlightDate IS NULL), 'FlightDate/FlightTime/TimeZone do not parse');

-- ---------------------------------------------------------------------------------------------
-- 2. One row per source row, with parsed keys and UTC time
-- ---------------------------------------------------------------------------------------------
CREATE TABLE f AS
WITH j AS (
  SELECT r.season_key, r.Year AS year, r.Season AS season, e.fid,
         r.Filename AS filename, r.CameraID AS camera, r.FL AS fl,
         TRY_CAST(regexp_extract(r.ShotID, '_(\d+)$', 1) AS BIGINT) AS shot,
         r.FlightDate AS flight_date, r.FlightTime AS flight_time_local, r.TimeZone AS tz_label,
         TRY_CAST(regexp_extract(r.TimeZone, '\((-?\d+)\)', 1) AS INT) AS tz_offset_h,
         e.eo_date::DATE + TRY_CAST(e.eo_time AS TIME) AS eo_ts,
         e.X AS x, e.Y AS y, e.Z AS z, e.Omega AS omega, e.Phi AS phi, e.Kappa AS kappa,
         e.CamName AS cam_name, e.CamWidthPx AS cam_width_px, e.CamHeighPx AS cam_height_px,
         e.CamFocalMm AS cam_focal_mm, e.CamCCDResU AS cam_ccd_res_u, e.CamPpxMm AS cam_ppx_mm, e.CamPpyMm AS cam_ppy_mm,
         e.CamOmegaDg AS cam_omega_dg, e.CamPhiDg AS cam_phi_dg, e.CamKappaDg AS cam_kappa_dg,
         r.footprint_wkb
  FROM raw_frames r JOIN raw_eo e ON e.season_key = r.season_key AND e.fid = r.rn
), t AS (
  SELECT *, (flight_date + TRY_CAST(flight_time_local AS TIME)) - to_hours(tz_offset_h) AS ts_utc FROM j
)
SELECT *,
       season_key || '/' || fl || '/' || shot::VARCHAR AS exposure_id,
       row_number() OVER (PARTITION BY filename ORDER BY fid) AS dup_rank,
       count(*)     OVER (PARTITION BY filename)              AS dup_count
FROM t;

-- The EO time is the local time converted to UTC, so ts_utc must agree with it.
SELECT must_be_zero((SELECT count(*) FROM f WHERE eo_ts IS DISTINCT FROM ts_utc),
    'Frames local time + TimeZone does not equal the EO time (UTC)');

-- ---------------------------------------------------------------------------------------------
-- 3. Duplicates
--    A frame that appears twice is kept once (the copy with the lowest fid) in frames, and
--    the other copies go to frames_duplicates. They are different solutions of the same frame,
--    not identical rows, and which one is right is undecided (CLAUDE.md, "Duplicates").
--    To prefer the second copy instead, order the row_number() in section 2 by fid DESC.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE p AS SELECT * FROM f WHERE dup_rank = 1;

-- ---------------------------------------------------------------------------------------------
-- 4. Passes and the ground track
--    A pass is (season, FL, FlightDate, shot-number prefix). The prefix is shot // 100000.
--    The prefix alone does not mean "reflight": all of 2022 S2 has prefixes 1-4 (one per day),
--    and many full-length lines in the later seasons have a prefix above 0 with no earlier pass.
--    So is_reflight (inferred, not from the vendor) means "the prefix is larger than the smallest
--    prefix on the same season and FL". Every camera of an exposure takes the pass of that
--    exposure's Color frame, so per-camera replacements stay with their exposure.
--    Ground track = direction to the next Color frame in the pass (else from the previous one),
--    used only to validate Kappa. A neighbor is valid if the shot number is 1..5 away and the
--    distance is 300..3000 ft; anything else is treated as a discontinuity, and gets no track.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE color AS
SELECT exposure_id, x, y, shot,
       season_key || '/' || fl || '/' || flight_date::VARCHAR || '/' || (shot // 100000)::VARCHAR AS pass_id
FROM p WHERE camera = 'Color';

CREATE TABLE track AS
WITH n AS (
  SELECT exposure_id, pass_id, x, y, shot,
         lead(x) OVER w AS nx, lead(y) OVER w AS ny, lead(shot) OVER w AS ns,
         lag(x)  OVER w AS px, lag(y)  OVER w AS py, lag(shot)  OVER w AS ps
  FROM color WINDOW w AS (PARTITION BY pass_id ORDER BY shot)
)
SELECT exposure_id, pass_id,
       CASE WHEN ns - shot BETWEEN 1 AND 5 AND sqrt((nx - x)^2 + (ny - y)^2) BETWEEN 300 AND 3000
              THEN (degrees(atan2(nx - x, ny - y)) + 360) % 360
            WHEN shot - ps BETWEEN 1 AND 5 AND sqrt((x - px)^2 + (y - py)^2) BETWEEN 300 AND 3000
              THEN (degrees(atan2(x - px, y - py)) + 360) % 360
       END AS track_heading_deg
FROM n;

-- ---------------------------------------------------------------------------------------------
-- 5. Final frame table
--    look_azimuth_deg: compass direction the oblique camera looks, in grid bearing degrees.
--    Kappa is counter-clockwise, so azimuth = (-Kappa) mod 360. Color is north-up, so it is NULL.
--    kappa_err_deg: look azimuth minus (track heading + fixed per-camera offset). Left is -90
--    and Right is +90 as compass bearings.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE frames AS
WITH a AS (
  SELECT p.*,
         coalesce(t.pass_id, p.season_key || '/' || p.fl || '/' || p.flight_date::VARCHAR || '/' || (p.shot // 100000)::VARCHAR) AS pass_id,
         t.track_heading_deg,
         p.shot // 100000 AS shot_prefix,
         min(p.shot // 100000) OVER (PARTITION BY p.season_key, p.fl) AS line_min_prefix,
         CASE WHEN p.camera <> 'Color' THEN ((-p.kappa % 360) + 360) % 360 END AS look_azimuth_deg,
         CASE p.camera WHEN 'Fwd' THEN 0 WHEN 'Bwd' THEN 180 WHEN 'Left' THEN -90 WHEN 'Right' THEN 90 END AS rel_offset
  FROM p LEFT JOIN track t USING (exposure_id)
), g AS (
  SELECT *, ST_GeomFromWKB(footprint_wkb) AS geom FROM a
)
SELECT filename, season_key, year, season, fl, shot, camera, exposure_id, pass_id,
       shot_prefix, shot_prefix > line_min_prefix AS is_reflight,
       flight_date, flight_time_local, tz_label, ts_utc,
       x, y, z, omega, phi, kappa,
       look_azimuth_deg, track_heading_deg,
       CASE WHEN look_azimuth_deg IS NOT NULL AND track_heading_deg IS NOT NULL
            THEN wrap(look_azimuth_deg - (track_heading_deg + rel_offset)) END AS kappa_err_deg,
       dup_count,
       cam_name, cam_width_px, cam_height_px, cam_focal_mm, cam_ccd_res_u, cam_ppx_mm, cam_ppy_mm,
       cam_omega_dg, cam_phi_dg, cam_kappa_dg,
       ST_XMin(geom) AS xmin, ST_YMin(geom) AS ymin, ST_XMax(geom) AS xmax, ST_YMax(geom) AS ymax,
       footprint_wkb
FROM g;

ALTER TABLE frames ADD COLUMN kappa_flag BOOLEAN;
UPDATE frames SET kappa_flag = abs(kappa_err_deg) > 10 WHERE kappa_err_deg IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- 6. Output checks
-- ---------------------------------------------------------------------------------------------
SELECT must_be_zero((SELECT count(*) - count(DISTINCT filename) FROM frames), 'filename is not unique in frames');
SELECT must_be_zero((SELECT (SELECT count(*) FROM frames) + (SELECT count(*) FROM f WHERE dup_rank > 1) - (SELECT count(*) FROM f)),
    'frames + duplicates does not add up to all source rows');
SELECT must_be_zero((SELECT count(*) FROM (SELECT exposure_id FROM frames GROUP BY 1 HAVING count(DISTINCT camera) <> 5)),
    'exposure without exactly five cameras');
SELECT must_be_zero((SELECT count(*) FROM frames WHERE xmin IS NULL OR footprint_wkb IS NULL), 'frame without a footprint');

-- ---------------------------------------------------------------------------------------------
-- 7. Write
-- ---------------------------------------------------------------------------------------------
COPY (SELECT * FROM frames ORDER BY season_key, pass_id, shot, camera)
  TO '@OUT_DIR@/frames.parquet' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 122880);

COPY (SELECT filename, season_key, fid, dup_rank, dup_count, camera, fl, shot, exposure_id,
             x, y, z, omega, phi, kappa, footprint_wkb
      FROM f WHERE dup_rank > 1 ORDER BY season_key, filename, fid)
  TO '@OUT_DIR@/frames_duplicates.parquet' (FORMAT PARQUET, COMPRESSION ZSTD);

-- ---------------------------------------------------------------------------------------------
-- 8. Report
-- ---------------------------------------------------------------------------------------------
SELECT season_key, count(*) AS frames, count(DISTINCT exposure_id) AS exposures, count(DISTINCT pass_id) AS passes,
       count(*) FILTER (WHERE is_reflight) AS reflight_frames, count(*) FILTER (WHERE dup_count > 1) AS frames_with_duplicate
FROM frames GROUP BY 1 ORDER BY 1;

SELECT count(*) AS kept_frames, (SELECT count(*) FROM f WHERE dup_rank > 1) AS duplicate_copies_set_aside, (SELECT count(*) FROM f) AS source_rows
FROM frames;

SELECT camera, count(*) AS with_track,
       round(median(abs(kappa_err_deg)), 2) AS median_abs_err, round(quantile_cont(abs(kappa_err_deg), 0.99), 2) AS p99_abs_err,
       count(*) FILTER (WHERE kappa_flag) AS flagged_over_10deg
FROM frames WHERE kappa_err_deg IS NOT NULL GROUP BY 1 ORDER BY 1;

SELECT count(*) FILTER (WHERE camera = 'Color' AND track_heading_deg IS NULL) AS color_frames_without_track FROM frames;
