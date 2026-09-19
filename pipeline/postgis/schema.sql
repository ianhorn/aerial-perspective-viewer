-- PostGIS schema for the normalized frames (pipeline/normalize.sh). Recreates the tables, so it is
-- safe to rerun. Indexes are created after the bulk load, in indexes.sql.
--
-- Column names are lowercase, so nothing needs quoting.
-- geom is the vendor footprint (POLYGON ZM, M is always 0) with M dropped, in EPSG:3089
-- (NAD83 / Kentucky Single Zone, US survey feet). x, y, z are the camera position in the same CRS.

CREATE EXTENSION IF NOT EXISTS postgis;

DROP TABLE IF EXISTS frames;
DROP TABLE IF EXISTS frames_duplicates;
DROP TABLE IF EXISTS frames_stage;
DROP TABLE IF EXISTS frames_duplicates_stage;

CREATE TABLE frames (
    filename           text             NOT NULL,   -- S3 key under imagery/obliques/Phase3/, unique
    season_key         text             NOT NULL,   -- e.g. 2023_Season1
    year               integer          NOT NULL,
    season             integer          NOT NULL,
    fl                 text             NOT NULL,   -- flight line; repeats across seasons
    shot               bigint           NOT NULL,
    camera             text             NOT NULL,   -- Color, Fwd, Bwd, Left, Right
    exposure_id        text             NOT NULL,   -- season_key/fl/shot: the five cameras of one exposure
    pass_id            text             NOT NULL,   -- season_key/fl/flight_date/shot_prefix
    shot_prefix        bigint           NOT NULL,   -- shot / 100000
    is_reflight        boolean          NOT NULL,   -- inferred, not from the vendor
    flight_date        date             NOT NULL,   -- local date
    flight_time_local  text             NOT NULL,
    tz_label           text             NOT NULL,
    ts_utc             timestamp        NOT NULL,
    x                  double precision NOT NULL,
    y                  double precision NOT NULL,
    z                  double precision NOT NULL,
    omega              double precision NOT NULL,
    phi                double precision NOT NULL,
    kappa              double precision NOT NULL,
    look_azimuth_deg   double precision,            -- (-kappa) mod 360, grid bearing; NULL for Color
    track_heading_deg  double precision,            -- ground track of the Color frame, for validation
    kappa_err_deg      double precision,
    kappa_flag         boolean,                     -- |kappa_err_deg| > 10
    dup_count          integer          NOT NULL,   -- 2 if the source had two copies of this frame
    cam_name           text,
    cam_width_px       integer,
    cam_height_px      integer,
    cam_focal_mm       double precision,
    cam_ccd_res_u      double precision,
    cam_ppx_mm         double precision,
    cam_ppy_mm         double precision,
    cam_omega_dg       double precision,
    cam_phi_dg         double precision,
    cam_kappa_dg       double precision,
    geom               geometry(PolygonZ, 3089) NOT NULL
);

-- The copies of duplicated frames that were not kept in frames. Not indexed.
CREATE TABLE frames_duplicates (
    filename     text NOT NULL,
    season_key   text NOT NULL,
    fid          bigint NOT NULL,
    dup_rank     integer NOT NULL,
    dup_count    integer NOT NULL,
    camera       text NOT NULL,
    fl           text NOT NULL,
    shot         bigint NOT NULL,
    exposure_id  text NOT NULL,
    x double precision, y double precision, z double precision,
    omega double precision, phi double precision, kappa double precision,
    geom         geometry(PolygonZ, 3089) NOT NULL
);
