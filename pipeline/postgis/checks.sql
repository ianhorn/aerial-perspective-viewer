-- Assertions on the query layer. Raises an exception, which fails the load, when one breaks.
-- The test frames are picked deterministically from the data, not hard-coded.

DO $$
DECLARE
    px double precision; py double precision; lon double precision; lat double precision;
    az double precision; first frame_pick; n integer; cur text; ok boolean;
BEGIN
    SELECT ST_X(p), ST_Y(p), ST_X(ST_Transform(p, 4326)), ST_Y(ST_Transform(p, 4326)) INTO px, py, lon, lat
    FROM (SELECT ST_PointOnSurface(geom) AS p FROM frames WHERE camera = 'Color' ORDER BY filename OFFSET 500 LIMIT 1) t;
    IF px IS NULL THEN RAISE EXCEPTION 'CHECK FAILED: no test frame'; END IF;

    -- Looking down returns only Color frames, and at least one.
    SELECT count(*) INTO n FROM frames_at_point(px, py, NULL, 30, 0.10, 0.40, 100);
    IF n = 0 THEN RAISE EXCEPTION 'CHECK FAILED: nothing covers the test point'; END IF;
    SELECT count(*) INTO n FROM frames_at_point(px, py, NULL, 30, 0.10, 0.40, 100) WHERE camera <> 'Color';
    IF n > 0 THEN RAISE EXCEPTION 'CHECK FAILED: look-down returned an oblique camera'; END IF;

    FOREACH az IN ARRAY ARRAY[0, 90, 180, 270]::double precision[] LOOP
        -- A compass request returns only obliques.
        SELECT count(*) INTO n FROM frames_at_point(px, py, az, 30, 0.10, 0.40, 100) WHERE camera = 'Color';
        IF n > 0 THEN RAISE EXCEPTION 'CHECK FAILED: az % returned a Color frame', az; END IF;

        -- The first pick is at least as good as any other in each ranking tier.
        SELECT * INTO first FROM frames_at_point(px, py, az, 30, 0.10, 0.40, 1);
        IF first.filename IS NOT NULL THEN
            IF first.pick <> 1 THEN RAISE EXCEPTION 'CHECK FAILED: first row is not pick 1'; END IF;
            SELECT bool_or(az_ok) INTO ok FROM frames_at_point(px, py, az, 30, 0.10, 0.40, 100);
            IF ok AND NOT first.az_ok THEN RAISE EXCEPTION 'CHECK FAILED: az %: pick 1 is outside the tolerance while another frame is inside', az; END IF;
            SELECT bool_or(eligible) INTO ok FROM frames_at_point(px, py, az, 30, 0.10, 0.40, 100) WHERE az_ok;
            IF ok AND first.az_ok AND NOT first.eligible THEN RAISE EXCEPTION 'CHECK FAILED: az %: pick 1 is ineligible while another frame in the tolerance is eligible', az; END IF;
        END IF;
    END LOOP;

    -- The lon/lat wrapper agrees with the point function (same point, after a CRS round trip).
    SELECT filename INTO cur FROM frames_at_lonlat(lon, lat, 0, 1);
    IF cur IS NOT NULL AND NOT EXISTS (SELECT 1 FROM frames_at_point(px, py, 0, 30, 0.10, 0.40, 3) WHERE filename = cur) THEN
        RAISE EXCEPTION 'CHECK FAILED: frames_at_lonlat disagrees with frames_at_point';
    END IF;

    -- Neighbors: the first frame of a pass has no previous frame; every neighbor is in shot order.
    SELECT filename INTO cur FROM frames WHERE camera = 'Color' ORDER BY pass_id, shot LIMIT 1;
    IF EXISTS (SELECT 1 FROM frame_neighbors(cur) WHERE direction = 'prev') THEN
        RAISE EXCEPTION 'CHECK FAILED: the first frame of a pass has a previous frame';
    END IF;
    SELECT filename INTO cur FROM frames WHERE camera = 'Color' ORDER BY pass_id, shot OFFSET 100 LIMIT 1;
    IF EXISTS (SELECT 1 FROM frame_neighbors(cur) n JOIN frames f ON f.filename = cur
               WHERE (n.direction = 'next' AND n.shot <= f.shot) OR (n.direction = 'prev' AND n.shot >= f.shot)) THEN
        RAISE EXCEPTION 'CHECK FAILED: neighbors are out of shot order';
    END IF;
END $$;

-- frames_in_view is frames_at_point's ranking written set-based (for speed). For a view so small that every grid point is
-- the same point, its one winner must be the top pick of frames_at_lonlat, whenever that pick looks the wanted way.
DO $$
DECLARE
    r record; az double precision; a text; b text; k integer := 0; bad integer := 0;
BEGIN
    FOR r IN SELECT ST_X(ST_Transform(ST_PointOnSurface(geom), 4326)) AS lon, ST_Y(ST_Transform(ST_PointOnSurface(geom), 4326)) AS lat
             FROM (SELECT geom FROM frames WHERE camera IN ('Fwd', 'Left') ORDER BY md5(filename) LIMIT 400) t LOOP
        az := (ARRAY[0, 90, 180, 270])[1 + k % 4];
        k := k + 1;
        SELECT filename INTO a FROM frames_at_lonlat(r.lon, r.lat, az, 1) WHERE az_ok;
        SELECT filename INTO b FROM frames_in_view(r.lon - 1e-6, r.lat - 1e-6, r.lon + 1e-6, r.lat + 1e-6, az, 1, 5);
        IF a IS DISTINCT FROM b THEN bad := bad + 1; END IF;
    END LOOP;
    -- a point within a foot of a footprint edge could go either way, so allow a rare miss
    IF bad > 2 THEN RAISE EXCEPTION 'CHECK FAILED: frames_in_view disagrees with frames_at_lonlat at % of % points', bad, k; END IF;
    RAISE NOTICE 'frames_in_view agrees with frames_at_lonlat at % of % points', k - bad, k;
END $$;

SELECT 'query layer checks passed' AS result;
