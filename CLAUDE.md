# CLAUDE.md

Project context for Claude Code. Started from an earlier Claude Desktop session, then updated after inspecting the real data in `geopackages/`. Items marked **unverified** or **inferred** were not confirmed against documentation or a live system.

## What this is

A viewer for KYAPED (Kentucky) oblique aerial imagery. Imagery is served from S3 as COGs; frame metadata comes from the vendor's GeoPackages.

The repo's README title is `aerial-perspective-viewer` and the directory is `oblique-viewer`. The name is not settled.

## Repo hygiene

- Imagery, COGs, GeoPackages, and DB dumps must never be committed. `.gitignore` excludes these, including `geopackages/`. Don't `git add -A` blindly. Check `git status` first.
- Dev environment is WSL2 Ubuntu on Windows. ArcGIS Pro stays on the Windows side.
- Local tooling that works: `docker`, and the `duckdb` CLI (v1.1.3, a snap) with the `spatial` and `sqlite` extensions (`LOAD spatial; SELECT ... FROM ST_Read('file.gpkg')`). `ST_Read` takes one file, not a glob. The `sqlite` extension attaches a GeoPackage read-only and exposes `fid`, but it can't select the geometry column. Not installed: `ogrinfo`/`ogr2ogr`, `sqlite3`, GDAL or geopandas for Python.
- **The DuckDB snap can only read and write under `$HOME`.** Writing to `/tmp` fails, so keep data and output directories under home.
- `pipeline/normalize.sh` is saved in the repo (see Pipeline). The exploratory analysis behind the findings below was ad hoc DuckDB queries and is not saved.

## Data model (verified against `geopackages/`)

Four seasons (2022 S2, 2023 S1, 2023 S2, 2024 S1), 20 GeoPackages in two folders, all EPSG:3089 (NAD83 / Kentucky Single Zone, US survey feet). Schemas are identical across seasons.

Per season:

- **ImageFrames**: polygon ZM footprints. Z looks terrain-projected (**unverified**).
- **ImageFrameCentroids**: the same attributes as Frames, as points. Redundant.
- **ImageFrameEO**: 3D points with the exterior orientation and camera intrinsics. Also present in `flight-orientation/` with the same rows and identical positions, but **the Kappa values differ for about 31% of exposures in three of the four seasons** (see Two EO folders).
- **ImageFrameBoundary**: one polygon per season.

Columns:

- **Frames:** `Filename`, `FlightDate`, `FlightTime` (local), `TimeZone` (`EST (-5)`, `EDT (-4)`, `CST (-6)`, or `CDT (-5)`), `FL`, `ShotID`, `CameraID`, `Year`, `Season`, `S3URL`.
- **EO:** `ID`, `X`, `Y`, `Z` (State Plane feet), `Omega`, `Phi`, `Kappa`, `FlightDate`, `FlightTime` (UTC: it equals the Frames local time minus the `TimeZone` offset on every row, checked by the pipeline), `CamName`, `CamWidthPx`, `CamHeighPx`, `CamFocalMm`, `CamCCDResU`, `CamOmegaDg`, `CamPhiDg`, `CamKappaDg`, `CamPpxMm`, `CamPpyMm`.

Counts:

- 4,428,945 rows, or 4,384,880 unique frames. That is 876,976 exposures × 5 cameras (Color, Fwd, Bwd, Left, Right).
- There are 2,620 (season, `FL`) lines. The earlier "16-line sample" was probably all of 2022 Season 2.

### Keys

- **Primary key:** `Filename`, the prefixed key, e.g. `KY_KYAPED_2023_Season1_3IN/Bwd_0_40721.tif`. It equals the S3 key under `imagery/obliques/Phase3/`, and the EO `ID` is the same string without `.tif`.
- **URLs:** `S3URL` is that base plus `Filename` on every row. Store the base path once. `Phase3` is the only oblique collection. The bucket is in us-west-2, though the `S3URL` column uses the global endpoint.
- **`ShotID`:** it equals the basename without `.tif`. It is unique across seasons today, but don't use it as the key.
- **`FL`:** it repeats across seasons (67 values appear in more than one). Always use (season, `FL`).
- **Exposure key:** (season, `FL`, shot number). It groups exactly 5 cameras in 876,973 of 876,976 groups. In the other 3, one camera's image comes from a different day, apparently a per-camera replacement.
- **Two ShotID formats:** `Cam_FL_shot` (2022 S2, 2023 S1) and `Cam_YYYYMMDD_FL_shot` (2023 S2, 2024 S1; 674,755 rows). A parser has to handle both. Shot numbers aren't zero-padded, so sort them numerically.

### Duplicates

44,065 filenames appear exactly twice (2023 S1: 42,030; 2024 S1: 2,035).

- **The copies are not identical.** The Frames attributes match, but the centroid positions differ in all 44,065 cases (median offset 0.5 ft, max 60 ft). In the EO layer, all 44,065 duplicate `ID`s (42,030 in 2023 S1 and 2,035 in 2024 S1) differ in at least one value.
- **Size:** 8,813 exposures × 5 cameras (2023 S1: 8,406 exposures; 2024 S1: 407).
- **What differs in EO:** only X, Y, Z, Omega, Phi, and Kappa. Time, date, and all camera intrinsics are identical. Median differences are about 0.2 ft in X/Y, 0.24 ft in Z, and 0.002–0.003° in Omega/Phi. The 95th percentile is under 0.8 ft in X/Y and about 0.008° in angles. Maxima are 6.6 ft (X/Y), 11.5 ft (Z), and about 0.1° (Omega/Phi). A Kappa maximum of 359.999° is just a 0°/360° wraparound.
- **Layout:** in the GeoPackage the two copies are never adjacent. In 2023 S1 the second copy is a median of about 143,000 rows after the first, so it was appended in a later block.
- **Coverage:** they fall on 33 lines, 25 of them fully duplicated and 8 partly.
- **Likely cause (unverified):** the metadata says aerotriangulation ran across "approximately 50 sub blocks". Lines at block boundaries would appear in two blocks with slightly different solutions.
- **Which copy is right is unknown.** Nothing has been compared against neighbors for smoothness. For most pairs either copy is probably fine for a viewer (a judgment, not tested), but the worst pairs could shift the ground position by tens of feet. Don't just drop one without deciding.
- Until resolved, any track computation must use exactly one copy per `Filename`. Two copies of a Color frame create zero-length steps (about 0.5 ft apart) that make the heading undefined.

### Two EO folders

`flight-information/*EO.gpkg` and `flight-orientation/*EO.gpkg` hold the same rows (compared on IDs that are unique in both, so the duplicate frames are excluded) with identical positions, in all four seasons. They differ in Kappa on about 31% of exposures, in every season except 2022 S2:

| Season | Exposures compared | Kappa differs between folders |
|---|---|---|
| 2022 S2 | 7,339 | 0 (identical) |
| 2023 S1 | 411,454 | 136,924 (33.3%) |
| 2023 S2 | 64,719 | 21,023 (32.5%) |
| 2024 S1 | 384,652 | 113,928 (29.6%) |
| **Total** | 868,164 | **271,875 (about 31%)** |

- Only three cameras change: **Fwd by exactly 180°, Left and Right by exactly 90°.** Bwd, Color, Omega, Phi, and X/Y/Z never differ. This holds in every season with differences.
- Pass-level and direction findings were computed on 2023 S1 and 2024 S1 only. It is a per-pass property, not per-frame: of 3,133 passes, 1,146 differ on every exposure, 1,987 agree on every exposure, and none are mixed.
- It is **not related to flight direction** (same two seasons): 32.0% of northbound and 31.1% of southbound exposures differ.
- In `flight-information`, every exposure follows the same camera-to-camera Kappa relationship, and Kappa matches the ground track (see The heading problem).
- In `flight-orientation`, the differing exposures break that pattern: Fwd equals Bwd, and Left equals Right. Against the ground track, Fwd is off by about 178°, Left by −90°, and Right by +90°. This is true of essentially every differing exposure in all three seasons (2023 S1: 410,723 of 410,730 camera frames; 2023 S2: 63,069 of 63,069; 2024 S1: 341,781 of 341,781). Where the folders agree, only 9 of 821,889 are bad in 2023 S1 and none elsewhere. **`flight-orientation` is wrong on those exposures, and `flight-information` is right.**
- File modification dates are 2025-04-28 for `flight-information` and 2025-04-18 for `flight-orientation`. That fits `flight-orientation` being older, but they may be download dates (**unverified**).
- **Use `flight-information`.** This may explain the vendor viewer's direction problems, since about 37% of passes (in 2023 S1 and 2024 S1) have wrong Fwd/Left/Right Kappa in the other folder (speculation).

### Time

`FlightTime` in Frames is local time with a `TimeZone` label. Kentucky spans Eastern and Central time, and 599 lines contain more than one label. Convert to UTC on load (local time minus the offset in the label).

### Per-frame files on S3

- **`<basename>.tif`:** a COG with JPEG (YCbCr) compression and 512 px tiles. The sample `Bwd_0_40721.tif` is 10300×7700 px, 43 MB, with 3 internal overview levels. It **has no georeferencing** (the tiepoint is all zeros and there is no pixel scale). Position must come from the EO plus the DEM patch. Written by UltraMap. HTTP range requests work.
- **`<basename>.json`:** a small DEM patch. The keys are `cellSize`, `lowerLeftX`, `lowerLeftY`, `minimumValue`, `maximumValue`, `noDataValue`, and `value` (a rows × cols grid). The sample is 54 rows × 57 cols at a cell size of 50, with the lower-left corner in State Plane feet (5218765, 3480033), so about 2,850 × 2,700 ft, elevations 994–1426. Units (assumed feet) and row order (assumed top-down) are **unverified**, and I haven't checked the grid's coverage against a footprint.
- **The sample frame isn't in the layers.** `Bwd_0_40721` has `FL` 0, and no local layer contains any `FL=0` rows. Either the bucket holds images the layers don't list, or the layers are incomplete. Only this one file was tested.

## Project facts (from `metadata/KYSW_Obliques_KYAPED_Project_Metadata.xml`)

Vendor FGDC record from NV5 Geospatial, published 2025-07-17.

- **Acquisition:** Vexcel Osprey 3P and 4.1 cameras. One nadir camera plus four obliques at 45°. The metadata calls the obliques north/south/east/west. In the data they are Fwd/Bwd/Left/Right, so cardinal direction depends on flight direction.
- **Coverage:** 120 Kentucky counties plus 47 in neighboring states, about 41,349 sq mi. The metadata says 119 flight lines over 130 flight days, 2022-11-20 to 2024-04-07. The layers have 2,620 (season, `FL`) values and dates through 2024-04-13.
- **Imagery:** 3-inch GSD (0.217 ft average) at 5,883 ft above mean terrain. Non-orthorectified COGs, delivered to KyFromAbove and formatted for the vendor's Oblique Viewer.
- **Orientation:** nadir images are oriented to true north. Obliques are "horizon-up".
- **Overlap:** forward overlap averages 70% for nadir and 67% for oblique. Side overlap averages 46% for nadir and 40% for oblique.
- **Accuracy:** 0.674 ft RMSEr from 333 checkpoints. Far-oblique areas with GSD above 0.4 ft were excluded from that test, so far-field pixels are less reliable.
- **DEM:** the vendor used a DEM (KyFromAbove LiDAR plus NED) to project obliques in its viewer. The per-frame JSON patches look like that terrain.
- **EO source:** the metadata names the project's EO shapefiles as the source for omega/phi/kappa, coordinates, sensor dimensions, focal length, and CCD resolution.

## The heading problem: use Kappa from `flight-information`

The earlier session planned to derive each frame's heading from the Color-camera ground track plus fixed camera offsets, distrusting Kappa. Testing against the real data shows that **the oblique cameras' Kappa in `flight-information` already gives the direction.**

**Rule:** each oblique camera's compass look direction is `(−Kappa) mod 360`, in grid bearing degrees clockwise from grid north. Kappa is measured counter-clockwise, opposite to a compass bearing. The Color (nadir) camera is north-up, with Kappa about 0.

| Camera | Kappa = −(track heading) + | Look direction relative to the track (compass, clockwise) |
|--------|-----|------|
| Fwd    | 0°    | +0°   |
| Bwd    | 180°  | +180° |
| Left   | +90°  | −90°  |
| Right  | −90°  | +90°  |

**The earlier session's table (Left +90°, Right −90°) is correct only as Kappa offsets.** As compass bearings, Left is −90° and Right is +90°. Using it as compass offsets would pick the wrong side camera for "look north".

Validation (**all four seasons**, 867,000+ exposures with a computable ground-track heading): comparing each camera's Kappa with the Color ground-track heading plus offset, in `flight-information`:

| Season | Exposures | Median error | 99th percentile | Frames over 45° |
|---|---|---|---|---|
| 2022 S2 | 7,339 | 0.14–0.17° | ≤ 1.3° | 0 |
| 2023 S1 | 410,873 | 0.32–0.50° | 2.9–4.4° | 4–16 per camera |
| 2023 S2 | 64,719 | 0.23–0.36° | ≤ 1.8° | 0 |
| 2024 S1 | 384,645 | 0.25–0.41° | ≤ 2.7° | 0 |

- The sign convention `Kappa = −heading + offset` fits better than `+heading` in every season (mean error 0.18–0.77° vs 0.56–1.89°).
- Few frames are more than 10° off. The worst is 2023 S1 Left and Right, at about 330 of 410,873 (0.08%). Those were not examined, so it is unknown whether they are bad Kappa or an artifact of the heading estimate near turns.
- The exposures in passes where `flight-orientation` differs (see Two EO folders) are wrong there and should not be used.
- 2022 S2 has identical folders and the tightest agreement. The season-level differences in error are small.
- **A second check, independent of the ground track:** the bearing from each oblique camera's position to the centroid of its footprint (from the Frames layer), against `(−Kappa) mod 360`, over all 3.5M oblique frames in all four seasons: median error 0.30–0.38° per camera, 99th percentile 4.2–7.2°, and only 12 frames over 45° (all Right, 2023 S1). This includes the exposures where `flight-orientation` disagrees, so the footprints agree with `flight-information`. It is not fully independent, because footprints and Kappa come from the same aerotriangulation.

**Loader rule:** read Kappa only from `flight-information`, for every season, with one rule and no per-season handling. Add a **validation step** to the loader that compares Kappa with the ground-track heading and flags exposures more than about 10° off. That protects all four seasons and any data added later.

Caveats:

- **This is self-consistency.** Kappa and the ground track both come from the same aerotriangulation, so agreement is expected. It doesn't prove the images point where Kappa says. **Spot-check a few frames against a map**, including one from a pass where the folders differ.
- The test used State Plane positions, so Kappa matches **grid** bearings, not true north (see the grid north note below).

For "look north", choose the camera whose `(−Kappa) mod 360` is closest to north. No ground-track derivation, pass logic, or ordering is needed for the heading itself. Passes are still needed for next/previous-frame lookups and for choosing between a reflight and an original.

The ground-track heading below is kept as a **fallback and cross-check**, in case Kappa turns out to be unreliable elsewhere, and as the basis for the loader's validation step. The earlier session validated the track approach on 16 lines (probably all of 2022 S2): mean error about 0.3–0.9°, max about 6°.

### Ordering and reflights (findings from the data)

These matter for adjacency (next/previous frame along a pass), choosing reflights, and the fallback ground-track heading. They are not needed for the primary heading.

Sorting Color frames numerically by shot number gives 422 backward time steps in 353 of 2,620 lines. A backward step in the `LAG` window would give a reversed direction vector, which is a 180° heading error.

- **Time zones** explain 258 of the 422 (local clock jumps at the Eastern/Central boundary). UTC-normalizing leaves 164 in 161 lines.
- **Reflights explain the rest.** 637 lines were flown on more than one date, and reflights are common. 155 of the remaining 164 backward steps jump back by more than a day.
- **The shot-number prefix (`shot // 100000`) marks a pass, but a prefix above 0 does not mean reflight.** Within one date on one line the prefix is almost always constant (only 9 exceptions). All of 2022 S2 has prefixes 1–4 and no prefix 0 (one prefix per flight day, 4 lines each). In the later seasons, 198 full-length passes (median 353 exposures) have a prefix above 0 but are the first pass on their line, for example 2024 S1 `FL 9090`–`9094` (about 500 exposures each). An earlier version of this file said prefix 0 is the original pass and higher prefixes are later passes. That is wrong. The pipeline instead marks `is_reflight` when the prefix is larger than the smallest prefix on the same season and `FL` (inferred): 0 frames in 2022 S2, 75,810 in 2023 S1, 7,815 in 2023 S2, and 102,180 in 2024 S1 (about 4% of frames overall).
- **Original passes can also span days.** 393 of the 637 multi-date lines have one prefix, so they are one pass flown over adjacent days.
- **Reflights are often small and fill gaps.** Of 1,008 same-line date pairs, 620 have one side with 50 frames or fewer. One prefix-1 reflight (2023-03-29) bridges the gap between two original days on `FL 1029`.
- **Per-camera replacements exist.** In 3 exposures, some cameras come from a later day, e.g. `FL 1030` shot 101879 has Color, Fwd and Left from 2023-03-05 but Bwd and Right from 2023-03-29.

**Splitting into passes works.** A pass is (season, `FL`, `FlightDate`, prefix). Backward UTC time steps, ordering Color frames by shot number within each split:

| Split | Backward steps |
|---|---|
| (season, `FL`) | 164 |
| (season, `FL`, date) | 13 |
| (season, `FL`, prefix) | 81 |
| **(season, `FL`, date, prefix)** | **4** of about 882,000 steps |

There are 3,435 passes with a median of about 294 Color frames and a maximum of 876. Only 5 have a single frame, 6 have 3 or fewer, and 149 have 10 or fewer. (These counts include the duplicate Color frames, so they're slightly inflated.)

**The 4 leftovers are not ordering problems:**

- `FL 1057`, 2023-03-02: a timestamp glitch (shot 20836→20837, a normal 651 ft step, time back 31 s). Shot order is spatially correct, and time order is not.
- `FL 11178`, 2024-02-23: shot jumps 51435→74900, time back 3.2 h, position back 677 ft. Two segments in one pass.
- `FL 11192`, 2024-02-21: shot 47338→74357 with a 250,372 ft (about 47 mile) jump. Two distant segments share a line, date and prefix.
- `FL 3056`, 2023-03-01: a 6-frame pass with a shot jump 52218→91301. This is one of the 3 per-camera-replacement exposures, where the Color frame is from 03-01 and the other cameras are from 03-26.

**Discontinuity thresholds** (steps between consecutive Color frames within a pass):

- A step is a discontinuity if the shot number jumps by more than 5. That splits 995 steps and catches all 3 known jumps. 15 of those steps are spatially small (under 1,500 ft), so they may just be missing frames.
- `shot_gap > 1000` is more conservative: 19 splits, and it also catches all 3.
- A distance threshold alone (over 3,000 ft) splits 1,048 steps but catches only `FL 11192`.
- Normal consecutive frames (shot gap 1) are a median 689 ft apart, 95th percentile 877 ft, and 3–4 seconds apart.
- The time resolution is 1 second. Only 73 Color steps have truly equal timestamps. (An earlier claim of 8,886 was wrong. Those were the duplicate frames.)

Design implications:

- **Define a pass** as (season, `FL`, `FlightDate`, prefix), and compute the ground track within a pass only. The pipeline adds `pass_id`, `shot_prefix`, and a heuristic `is_reflight` flag (inferred, not from the vendor; see above). Keep both the originals and the reflights.
- **Order by shot number within a pass, not by time.** The `FL 1057` timestamp was wrong and its shot order was right. Use time only to split by date and convert time zones.
- **Split passes at discontinuities** (shot gap over 5, or over 1000 if a conservative rule is preferred). Frames beside a break should get a null or fallback heading. Otherwise a 47-mile jump would produce a wildly wrong direction.
- **Use one copy per `Filename`** before computing tracks (see Duplicates).
- **Don't assume a line's direction.** The "8 lines north, 8 south, alternating" pattern came from one complete season. Flight direction comes from Kappa per frame, not from the line.
- **Short passes** (1–2 Color frames) have no neighbor to compute a track from. That only matters for the fallback heading, since Kappa gives the heading per frame.
- **Which frame wins where several cover the same ground:** per the user, the reflight usually wins. That suggests a default rule of preferring the later pass (higher prefix, later date). The user said "usually", so there are exceptions, and none are identified yet. No per-frame quality or superseded flag has been found in the layers, so the rule can't be derived from the data alone.

**Grid north vs true north (unresolved):** the EO X/Y are confirmed State Plane feet, and Kappa agrees with grid bearings computed from them (median error about 0.3°). Kappa is therefore probably referenced to grid north. The Kentucky Single Zone central meridian is −85° and the state spans about −89.7° to −81.9°, so grid north and true north can differ by up to about ±3°. Whether the Kappa residual varies with easting (which would show a convergence effect) hasn't been checked. If "look north" needs true north, apply a convergence correction.

Planned indexes: a GiST spatial index on the footprint geometry, and an index on (`pass_id`, UTC time) for next/previous-along-pass lookups.

## Database

**Decision: PostGIS.** Run it locally or in a container for development, then migrate to RDS later. Docker runs in this WSL setup.

- Use the `geometry` type with GiST spatial indexes and `LAG`/`LEAD` window functions.
- SQL Server was considered and drafted (native `geometry`, `ogr2ogr` MSSQLSpatial driver), then dropped in favor of PostGIS. The user runs SQL Server elsewhere, but this project doesn't depend on it.

**Plan:** normalize once with DuckDB into Parquet, then load PostGIS from that as the serving layer. Both are built (see Pipeline). The move to RDS is not started. At this scale (about 4.4M rows) don't partition by flight line, since that gives 2,620 tiny files. If Parquet is published, partition by season or season plus a coarse spatial tile, sorted spatially within each file. A browser-only design (Parquet plus DuckDB-WASM, no backend) is possible if headings and adjacency are precomputed. Decide whether there is a backend.

## Pipeline

`pipeline/normalize.sh` runs `pipeline/normalize.sql` with DuckDB (about a minute, needs `duckdb` on the PATH and network on the first run to install extensions). It reads `$GPKG_DIR/flight-information/` (default `<repo>/geopackages`) and writes to `$OUT_DIR` (default `<repo>/data`, gitignored). Both must be under `$HOME` for the snap build of DuckDB. Seasons are discovered from the file names.

Outputs:

- **`frames.parquet`** (about 704 MB, 4,384,880 rows, one per unique `Filename`, 41 columns): the parsed keys (`exposure_id`, `pass_id`, `shot`, `fl`, `shot_prefix`), `is_reflight`, UTC time, the EO position and angles, `look_azimuth_deg`, `track_heading_deg`, `kappa_err_deg` and `kappa_flag`, the camera intrinsics, a footprint bounding box, and `footprint_wkb`.
- **`frames_duplicates.parquet`** (44,065 rows): the copies of duplicated frames that were not kept.

Decisions built in:

- Reads only `flight-information` EO, never `flight-orientation`.
- **Duplicates keep the copy with the lowest `fid`. This is arbitrary**, because which copy is right is still unknown. To prefer the other copy, order the `row_number()` by `fid DESC`.
- `look_azimuth_deg = (−Kappa) mod 360` for the four obliques, NULL for Color. `kappa_err_deg` compares it with the ground track plus the compass offsets (Fwd 0, Bwd 180, Left −90, Right +90). `kappa_flag` marks errors over 10°.
- The ground track uses the next Color frame in the pass (else the previous), valid when the shot number is 1–5 away and the distance is 300–3000 ft. 620 Color frames (0.07%) have no track and so no Kappa cross-check.
- The footprint stays as the vendor's ISO WKB (`POLYGON ZM`, M is 0). **This is not GeoParquet.** DuckDB 1.1.3 writes it as a plain BLOB column with no GeoParquet metadata. A newer DuckDB may write real GeoParquet (not tried).

Checks that stop the run: Frames row `k` and EO `fid` `k` are the same frame in every season (this is how duplicate copies are paired); `S3URL` equals the base path plus `Filename`; the `Filename` prefix matches its season; `ShotID` parses in both formats and matches `FL` and `CameraID`; local time plus `TimeZone` equals the EO time; `filename` is unique; every exposure has exactly five cameras; and kept plus set-aside rows equal the source rows.

Report on the last run: 36,695 / 2,099,300 / 323,595 / 1,925,290 frames for 2022 S2 / 2023 S1 / 2023 S2 / 2024 S1, 3,435 passes, and Kappa-vs-track median error 0.28° (Fwd, Bwd) and 0.44° (Left, Right), with 4, 4, 329, and 336 frames over 10°.

### PostGIS load

`pipeline/load_postgis.sh` loads the two Parquet files into a local PostGIS container (about 70–90 s). Run it after `normalize.sh`. It uses `docker-compose.yml` (service `postgis`, image `postgis/postgis:16-3.4`, container `oblique-postgis`, bound to `127.0.0.1:5433`, database, user and password `oblique`; dev credentials only, override with a gitignored `.env`), then:

1. `pipeline/postgis/schema.sql` recreates `frames` and `frames_duplicates`, so the load is safe to rerun.
2. DuckDB's `postgres` extension writes staging tables. The footprint travels as WKB `bytea`.
3. `pipeline/postgis/insert.sql` builds `geom geometry(PolygonZ, 3089)` with `ST_Force3DZ(ST_SetSRID(ST_GeomFromWKB(...), 3089))`, which drops the M value, and drops the staging tables.
4. `pipeline/postgis/indexes.sql` adds the primary key on `filename`, a GiST index on `geom`, and btrees on `(pass_id, shot)`, `exposure_id`, and `(season_key, fl, shot)`.
5. The script checks the row counts against the Parquet and reports SRID, invalid and empty footprints.

Result: 4,384,880 frames and 44,065 duplicate copies. The `frames` table is 3.1 GB, and the indexes total about 690 MB (the primary key is 297 MB, the GiST index 174 MB). Aggregate checksums (row count, passes, sums of x, kappa, footprint extents and Z, flag counts) match the Parquet.

Measured on the loaded data (warm cache):

- **Frames covering a point:** 0.3 ms with the GiST index (`ST_Intersects(geom, point)`). The test point in a 2023 S1 area was covered by **81 frames** (29 Color, 12–14 of each oblique). The viewer will need a rule for picking among them. None of that overlap was reflights.
- **Look north:** filter the covering frames to obliques and order by the angular distance of `look_azimuth_deg` from 0. Under 1 ms.
- **Next/previous frame in a pass:** about 0.1 ms with `(pass_id, shot)` and `camera = ...` as a filter. A `(pass_id, camera, shot)` index was faster (0.045 ms) but not worth 79 MB, so it was dropped.

**6 footprints are invalid (self-intersecting):** `Right_5359_40721` through `Right_5359_40726` in 2023 S1, about 130,000–220,000 sq ft each. They load fine, but geometry operations that need valid input may fail on them. The Z values of the footprints are the vendor's terrain-projected values, and I haven't checked them against the DEM.

## Status

- Built: the DuckDB normalization and the PostGIS schema and loader (`pipeline/`, `docker-compose.yml`). Not built: any tests beyond the pipeline's own checks, the RDS migration, and all app code (API, viewer, rendering).
- The earlier session drafted T-SQL files (`schema.sql`, `finalize.sql`, `docker-compose.yml`, `load.sh`, and a README) for SQL Server. **They are not in this repo and are superseded.** They were never run against a real SQL Server. At most they are a reference for the schema shape.
- Lessons worth keeping:
  - PostgreSQL lowercases unquoted identifiers, so handle the vendor's mixed-case column names on load
  - a load script should support both truncate-and-reload and append
  - the earlier design derived heading from the ground track per `FL`. Reflights contradict a per-line heading, and Kappa now gives a per-frame heading directly

## Open items

- Reflights usually win (per the user). What are the exceptions, and how would they be identified? Is there any vendor documentation? Should the viewer let users switch to the original frame?
- Which copy of the 44,065 duplicate frames is correct? The pipeline keeps the lowest `fid` by default. Test each copy's smoothness against its neighbors, and check the sub-block hypothesis. Ask the vendor if possible.
- Spot-check a handful of images visually against a map to confirm that `(−Kappa) mod 360` is the true look direction, including a frame from a pass where the two EO folders differ. The footprint-bearing check supports it but doesn't look at image content.
- Try a newer DuckDB for real GeoParquet output (only needed if the Parquet is published; the PostGIS load doesn't depend on it).
- How should the viewer choose among the many frames that cover a clicked point (81 in the one point tested)? Ideas: nearest to the frame center, the reflight-wins rule, and the look direction the user asked for.
- Decide on the 6 invalid footprints (leave, repair with `ST_MakeValid`, or exclude).
- Add a query layer: functions or views for point lookup, look-north, and next/previous, plus a check on how they behave at pass ends and discontinuities.
- Look at the roughly 330 Left/Right frames in 2023 S1 that are more than 10° off, and the 4–16 per camera that are more than 45° off. Are they bad Kappa or an artifact near turns?
- Check whether the Kappa residual varies with easting, to settle grid vs true north.
- Does the vendor viewer use `flight-orientation`, and would that explain its direction problem?
- Examine the 3 exposures with per-camera replacement (only `FL 3056` has been looked at).
- The JSON sidecars are terrain grids only, with no flight-line, pass, or direction information, so they can't replace the heading work. They may help with rendering and with checking footprint Z. Verify the units, row order, and coverage against a footprint, using a frame that is actually in the layers. Reading every sidecar is impractical (about 100 GB).
- Why is `Bwd_0_40721` (`FL 0`) in the bucket but not in the layers? Are there other such images?
- Rendering approach is undecided. Tile serving via titiler was floated.
- Frame-transition UX is undecided.
- The repo's final name is undecided.
- License: MIT, chosen by the author (a personal project for now, so the author sets the terms). If this later becomes agency work, check ownership before relicensing or accepting outside contributions. The imagery and metadata are NV5/KyFromAbove data and are not covered by this license.
