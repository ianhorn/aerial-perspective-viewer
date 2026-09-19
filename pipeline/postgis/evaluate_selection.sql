-- Evaluates the frame selection rule on random points. Read-only; run it by hand:
--   docker compose exec -T postgis psql -U oblique -d oblique < pipeline/postgis/evaluate_selection.sql
--
-- Points are the interior points of randomly chosen Color footprints (a fixed seed, so the run
-- repeats). That covers only places the imagery covers, and favors places with more overlap, so
-- it says nothing about the edges of the coverage area.

SET client_min_messages = warning;
SELECT setseed(0.42);

CREATE TEMP TABLE pts AS
SELECT row_number() OVER () AS id, ST_X(p) AS px, ST_Y(p) AS py
FROM (SELECT ST_PointOnSurface(geom) AS p FROM frames WHERE camera = 'Color' ORDER BY random() LIMIT 2000) t;

CREATE TEMP TABLE dirs AS SELECT unnest(ARRAY[0, 90, 180, 270]::double precision[]) AS az;

\timing on
CREATE TEMP TABLE picks AS
SELECT p.id, d.az, r.*
FROM pts p CROSS JOIN dirs d
LEFT JOIN LATERAL frames_at_point(p.px, p.py, d.az, 30, 0.10, 0.40, 1) r ON true;
\timing off

\echo
\echo '--- outcome of the top pick, per requested direction (2,000 points each) ---'
SELECT az AS look_az,
       count(*) FILTER (WHERE filename IS NULL)                            AS no_frame,
       count(*) FILTER (WHERE filename IS NOT NULL AND NOT az_ok)          AS az_fallback,
       count(*) FILTER (WHERE az_ok AND NOT eligible)                      AS in_tolerance_but_ineligible,
       count(*) FILTER (WHERE az_ok AND eligible)                          AS good,
       round(100.0 * count(*) FILTER (WHERE az_ok AND eligible) / count(*), 1) AS pct_good
FROM picks GROUP BY az ORDER BY az;

\echo
\echo '--- what the good picks look like ---'
SELECT camera, count(*) n,
       round(avg(az_off_deg)::numeric, 2) mean_az_off, round(max(az_off_deg)::numeric, 1) max_az_off,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY center_dist_ft))::numeric) median_center_ft,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY est_gsd_ft))::numeric, 3) median_gsd_ft,
       round((percentile_cont(0.95) WITHIN GROUP (ORDER BY est_gsd_ft))::numeric, 3) p95_gsd_ft,
       count(*) FILTER (WHERE is_reflight) reflight_picks
FROM picks WHERE az_ok AND eligible GROUP BY camera ORDER BY camera;

\echo
\echo '--- how many frames compete for a point (look north), and how many are eligible ---'
SELECT count(*) AS points,
       round(avg(n_cand)::numeric, 1) AS mean_candidates, max(n_cand) AS max_candidates,
       round(avg(n_ok)::numeric, 1) AS mean_in_tolerance_and_eligible,
       count(*) FILTER (WHERE n_ok = 0) AS points_with_none
FROM (SELECT p.id, count(*) AS n_cand, count(*) FILTER (WHERE r.az_ok AND r.eligible) AS n_ok
      FROM (SELECT * FROM pts LIMIT 300) p, LATERAL frames_at_point(p.px, p.py, 0, 30, 0.10, 0.40, 1000) r GROUP BY p.id) t;

\echo
\echo '--- effect of the edge margin: share of points with a good pick, by min_edge_frac (look north) ---'
SELECT m AS min_edge_frac,
       round(100.0 * count(*) FILTER (WHERE r.az_ok AND r.eligible) / count(*), 1) AS pct_good
FROM (SELECT unnest(ARRAY[0, 0.05, 0.10, 0.20]::double precision[]) AS m) ms
CROSS JOIN (SELECT * FROM pts LIMIT 500) p
LEFT JOIN LATERAL frames_at_point(p.px, p.py, 0, 30, ms.m, 0.40, 1) r ON true
GROUP BY m ORDER BY m;
