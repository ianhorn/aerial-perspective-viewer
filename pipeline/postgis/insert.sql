-- Builds the real tables from the staging tables that load_postgis.sh wrote through DuckDB.
-- footprint_wkb arrives as bytea holding ISO WKB (POLYGON ZM). ST_Force3DZ drops the M value.

INSERT INTO frames (
    filename, season_key, year, season, fl, shot, camera, exposure_id, pass_id, shot_prefix, is_reflight,
    flight_date, flight_time_local, tz_label, ts_utc, x, y, z, omega, phi, kappa,
    look_azimuth_deg, track_heading_deg, kappa_err_deg, kappa_flag, dup_count,
    cam_name, cam_width_px, cam_height_px, cam_focal_mm, cam_ccd_res_u, cam_ppx_mm, cam_ppy_mm,
    cam_omega_dg, cam_phi_dg, cam_kappa_dg, geom)
SELECT
    filename, season_key, year, season, fl, shot, camera, exposure_id, pass_id, shot_prefix, is_reflight,
    flight_date, flight_time_local, tz_label, ts_utc, x, y, z, omega, phi, kappa,
    look_azimuth_deg, track_heading_deg, kappa_err_deg, kappa_flag, dup_count,
    cam_name, cam_width_px, cam_height_px, cam_focal_mm, cam_ccd_res_u, cam_ppx_mm, cam_ppy_mm,
    cam_omega_dg, cam_phi_dg, cam_kappa_dg,
    ST_Force3DZ(ST_SetSRID(ST_GeomFromWKB(footprint_wkb), 3089))
FROM frames_stage;

INSERT INTO frames_duplicates (
    filename, season_key, fid, dup_rank, dup_count, camera, fl, shot, exposure_id,
    x, y, z, omega, phi, kappa, geom)
SELECT
    filename, season_key, fid, dup_rank, dup_count, camera, fl, shot, exposure_id,
    x, y, z, omega, phi, kappa,
    ST_Force3DZ(ST_SetSRID(ST_GeomFromWKB(footprint_wkb), 3089))
FROM frames_duplicates_stage;

DROP TABLE frames_stage;
DROP TABLE frames_duplicates_stage;
