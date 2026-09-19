-- Indexes for the frames table, built after the bulk load.
--
--   frames_pkey             unique filename, and lookup by S3 key
--   frames_geom_gist        which frames cover a point or window (ST_Intersects, ST_Contains, <->)
--   frames_pass_shot        next/previous frame along a pass: WHERE pass_id = ? ORDER BY shot
--   frames_exposure         the five cameras of one exposure
--   frames_line_shot        all passes of a line: WHERE season_key = ? AND fl = ? ORDER BY shot

ALTER TABLE frames ADD PRIMARY KEY (filename);
CREATE INDEX frames_geom_gist    ON frames USING gist (geom);
CREATE INDEX frames_pass_shot    ON frames (pass_id, shot);
CREATE INDEX frames_exposure     ON frames (exposure_id);
CREATE INDEX frames_line_shot    ON frames (season_key, fl, shot);

ANALYZE frames;
ANALYZE frames_duplicates;
