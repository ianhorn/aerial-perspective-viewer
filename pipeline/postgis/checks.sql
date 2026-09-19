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

SELECT 'query layer checks passed' AS result;
