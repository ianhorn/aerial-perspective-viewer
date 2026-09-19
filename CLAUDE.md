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

- **`<basename>.tif`:** a COG with JPEG (YCbCr) compression and 512 px tiles. The sample `Bwd_0_40721.tif` is 10300×7700 px, 43 MB, with 3 internal overview levels. It **has no georeferencing** (the tiepoint is all zeros and there is no pixel scale). Position must come from the EO plus the DEM patch. Written by UltraMap. HTTP range requests work, but see the transfer stalls under Reading a photo in the browser. The number of overview levels varies from photo to photo. The bucket reports the storage class `INTELLIGENT_TIERING`.
- **`<basename>.json`:** a small DEM patch. The keys are `cellSize`, `lowerLeftX`, `lowerLeftY`, `minimumValue`, `maximumValue`, `noDataValue`, and `value` (a rows × cols grid). The sample is 54 rows × 57 cols at a cell size of 50, with the lower-left corner in State Plane feet (5218765, 3480033), so about 2,850 × 2,700 ft, elevations 994–1426. **Units are feet and the rows run bottom-up** (row 0 is the lowest row, at `lowerLeftY`; verified against the statewide DEM, see The statewide DEM). The grid was compared with the DEM at cell centres; corner-registered cells were not tried, and on smooth ground the two would not be told apart. I haven't checked the grid's coverage against a footprint.
- **The sample frame isn't in the layers.** `Bwd_0_40721` has `FL` 0, and no local layer contains any `FL=0` rows. Either the bucket holds images the layers don't list, or the layers are incomplete. Only this one file was tested.

## Project facts (from `metadata/KYSW_Obliques_KYAPED_Project_Metadata.xml`)

Vendor FGDC record from NV5 Geospatial, published 2025-07-17.

- **Acquisition:** Vexcel Osprey 3P and 4.1 cameras. One nadir camera plus four obliques at 45°. The metadata calls the obliques north/south/east/west. In the data they are Fwd/Bwd/Left/Right, so cardinal direction depends on flight direction.
- **Coverage:** 120 Kentucky counties plus 47 in neighboring states, about 41,349 sq mi. The metadata says 119 flight lines over 130 flight days, 2022-11-20 to 2024-04-07. The layers have 2,620 (season, `FL`) values and dates through 2024-04-13.
- **Imagery:** 3-inch GSD (0.217 ft average) at 5,883 ft above mean terrain. Non-orthorectified COGs, delivered to KyFromAbove and formatted for the vendor's Oblique Viewer.
- **Orientation:** nadir images are oriented to true north. Obliques are "horizon-up".
- **The nadir (Color) camera is the same capture as the Phase 3 orthoimagery** (per the user; not checked against the imagery): the five cameras of an exposure fire at the same moment, and the Phase 3 orthoimagery is made from the nadir image, orthorectified and 4-band. The basemap the app uses (the Commonwealth Map) has Phase 3 cached at close zoom, so the nadir view is already on the map. **So the panel does not offer "Down".** The Color frames stay in the database and the API still answers `look=down`, so it can be brought back (`LOOKS` in `describe.ts`).
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

**Grid north vs true north (unresolved):** the EO X/Y are confirmed State Plane feet, and Kappa agrees with grid bearings computed from them (median error about 0.3°). Kappa is therefore probably referenced to grid north. The Kentucky Single Zone (a Lambert conformal conic; PostGIS's `proj4text` for SRID 3089 gives standard parallels 37°05'N and 38°40'N, origin 36°20'N, **central meridian −85.75°**; an earlier version of this file said −85°, which was wrong) meets the state's span of about −89.7° to −81.9°, so grid north and true north differ by up to about ±2.4° (the cone constant is about 0.61, times up to 3.95° from the meridian). Whether the Kappa residual varies with easting (which would show a convergence effect) hasn't been checked. If "look north" needs true north, apply a convergence correction.

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

Result: 4,384,880 frames and 44,065 duplicate copies. The `frames` table is 2.4 GB and its indexes are 0.7 GB (the primary key is 297 MB, the GiST index 174 MB), 3.1 GB in total. The whole database is 3.2 GB. Aggregate checksums (row count, passes, sums of x, kappa, footprint extents and Z, flag counts) match the Parquet.

Measured on the loaded data (warm cache):

- **Frames covering a point:** 0.3 ms with the GiST index (`ST_Intersects(geom, point)`). The test point in a 2023 S1 area was covered by **81 frames** (29 Color, 12–14 of each oblique). The viewer will need a rule for picking among them. None of that overlap was reflights.
- **Look north:** filter the covering frames to obliques and order by the angular distance of `look_azimuth_deg` from 0. Under 1 ms.
- **Next/previous frame in a pass:** about 0.1 ms with `(pass_id, shot)` and `camera = ...` as a filter. A `(pass_id, camera, shot)` index was faster (0.045 ms) but not worth 79 MB, so it was dropped.

**6 footprints are invalid (self-intersecting):** `Right_5359_40721` through `Right_5359_40726` in 2023 S1, about 130,000–220,000 sq ft each. They load fine, but geometry operations that need valid input may fail on them. The Z values of the footprints are the vendor's terrain-projected values, and I haven't checked them against the DEM.

### Query layer

`pipeline/postgis/functions.sql` (applied by `load_postgis.sh`, with assertions in `checks.sql` that fail the load) defines:

- **`frames_at_point(px, py, want_azimuth, az_tolerance=30, min_edge_frac=0.10, max_gsd_ft=0.40, lim=5)`** returns the frames covering a point (EPSG:3089 feet), best first, as `frame_pick` rows with the reasons: `pick`, `az_off_deg`, `az_ok`, `eligible`, `is_reflight`, `center_dist_ft`, `edge_frac`, `est_gsd_ft`. `want_azimuth` is the direction the camera **looks** (a "north" view is a camera looking north; the UI may want the opposite meaning). NULL means straight down, which returns Color frames only. A compass value returns obliques only.
- **`frames_at_lonlat(lon, lat, want_azimuth, lim)`** is the same for WGS84.
- **`frame_neighbors(filename, max_shot_gap=5, max_dist_ft=3000)`** returns the previous and next frame in shot order in the same pass and camera. It returns nothing across a discontinuity (the thresholds validated earlier) or at the end of a pass. It does not yet find frames on adjacent flight lines.

**The selection rule (proposed, not reviewed by a person):**

1. Candidates are frames whose footprint contains the point, filtered by camera as above.
2. Frames within `az_tolerance` of the requested direction rank first. If none are, the closest azimuth wins.
3. Eligible frames rank before ineligible ones. Eligible means the point is at least `min_edge_frac` of sqrt(footprint area) from every edge, and the estimated GSD at the point is at most 0.40 ft (the vendor's limit for reliable far-oblique pixels).
4. Reflights first (per the user, they usually win; `is_reflight` is inferred, see Ordering and reflights).
5. Then nearest to the frame center, then newest.

`est_gsd_ft` is slant range from the camera to the point times pixel size over focal length, with ground height taken as the mean of the footprint's lowest and highest Z. Averaged at footprint centroids it gives 0.22–0.24 ft against the vendor's stated 0.217 ft.

**Measured** (`pipeline/postgis/evaluate_selection.sql`, 2,000 random points inside Color footprints, four look directions each, warm cache):

- **Speed:** 8,000 top-pick calls took 0.95 s, about 0.12 ms each.
- **Result:** 99.2–99.6% of point/direction pairs get a good pick (within tolerance and eligible). 7–15 of 2,000 per direction get an azimuth fallback, and 0–1 are in tolerance but ineligible. None have no frame.
- **The fallbacks** are points where the nearest available look direction is about 90° off (median 89°). They are covered by about 1.3 passes on average, so they are line ends and coverage edges where that direction was not photographed. The function reports `az_ok = false` so the app can disable that direction.
- **Picks:** mean azimuth error 0.6° (Fwd, Bwd) and 1.2° (Left, Right), max 11.3°; median distance from the frame center 134 ft (Fwd, Bwd) and 274–285 ft (Left, Right); median estimated GSD 0.23 ft, 95th percentile 0.25 ft. About 5% of picks are reflights, against 4% of all frames.
- **Competition:** looking north, a point has on average 18 oblique candidates (max 67), of which about 3.7 are in tolerance and eligible. 4 of 300 points had none.
- **The edge margin barely matters** here: 99.0% good with no margin and 98.8% at 0.10–0.20.

**Not verified:** whether the chosen frame is actually the best-looking one (see the review harness below; nobody has rated the picks yet). Whether reflights are better than originals (the rule assumes it). The sample favors covered areas and overlap, so it says nothing about the boundary of the coverage. The function was only measured in PostGIS, and timings are warm-cache.

### Review harness

`python3 pipeline/review/build_review.py` builds `data/review/index.html` (gitignored) so a person can judge the rule by eye. It needs the local PostGIS, network access to the bucket, and Python with `Pillow` and `requests` (`pipeline/review/requirements.txt`; both were already installed system-wide). It takes about 40 s for the default 36 points and 108 images (10 MB). Open the page in a browser (from WSL: `explorer.exe data/review/index.html`).

- **Points:** 24 random, 6 where the rule picked a reflight over an eligible original, and 6 where no camera looks within the tolerance (`--n-random`, `--n-reflight`, `--n-fallback`, `--candidates`, `--seed`). The look direction cycles N, E, S, W.
- **Per point:** a sketch of the top candidates' footprints, camera positions and look directions, plus a thumbnail and the reasons for each pick. The page has rating buttons ("pick 1 is best", "pick N is better", "none are good"), a note field, a live summary, and a button that copies or downloads the ratings as JSON. Ratings persist in the browser only.
- **Thumbnails:** the script parses the COG's TIFF header, picks the smallest overview level that is at least 1200 px on the long side (`min_long_side` in `make_thumb`; there is no command-line flag for it), takes its JPEG tiles and the shared `JPEGTables`, and stitches them with Pillow, using one range request of about 650 KB. That gives 1287 px, or 1768 px for the 14144-px sensor. **An earlier version took the smallest level, and the number of overview levels differs from photo to photo, so many thumbnails were only 320–440 px on the long side** and this file wrongly said 1287. The 108 thumbnails were regenerated at the new sizes (delete `data/review/thumbs` to regenerate them). Decoded colors and tile joins were checked by eye. The full image is one click away.
- **Limits:** the photos are not georeferenced, so the page does not mark the point on the photo. The sketch is the only spatial cue. The script checks that the point lies inside every shown footprint and warns if not (no warnings on the default run).
- **No ratings have been collected yet.**

Facts seen while building it:

- **`Left` and `Right` images are portrait; `Fwd`, `Bwd` and `Color` are landscape.** Two sensor systems are in the data, which matches the metadata's "Osprey 3P and 4.1": 584,480 exposures per camera have obliques of 10300×7700 px (Color 13470×8670, focal 123 mm and 82 mm), and 292,496 have 14144×10560 (Color 20544×14016, focal 123.38 mm and 79.6 mm). A viewer layout has to handle both orientations and both sizes.

## Web app

`web/` is the browser app: Vite 8, TypeScript 7 and MapLibre GL JS 6 (versions as installed on 2026-09-19; the MapLibre 6 package is ESM-only, exports `Map` and the controls by name with no default export, and its CSS is `maplibre-gl/dist/maplibre-gl.css`).

```
cd web
npm install
npm run dev        # http://localhost:5173; /api is proxied to the API on 127.0.0.1:3001 (start it first: cd api && npm start), or to another address with API_TARGET=http://host:3001
npm run build      # typecheck, then a production build in web/dist (gitignored); about 1 MB of JavaScript, 281 KB gzipped, nearly all of it MapLibre, plus a 508 KB worker file
npm run preview    # serve web/dist, with the same /api proxy
npm test           # 61 unit tests: the wording logic, the COG reader, the photo cache, the camera model, the projection, the placement geometry and the thumbnail sizing (node:test, no browser)
```

**What exists:** a full-window map of Kentucky on the basemap with zoom and compass controls, a scale bar and an attribution. **Clicking the map** drops a pin and asks the API which photos cover the point. The panel then shows a direction selector (North, East, South, West; North is the default; there is no Down, see below) and up to five ranked photos. Each one says which way it looks, which camera, when it was flown, and roughly how many feet per pixel it resolves. Notes in amber explain caveats: the point is near the edge of the photo or the resolution is coarse there, the photo comes from a re-flight, or it looks away from the requested direction (worded differently when no photo qualifies). Choosing a photo, or changing direction, draws that photo's ground footprint and camera position on the map. A click outside the imagery says "No photos cover this point" and clears the footprint, and an API failure shows a plain message. A newer request cancels an older one, so a slow answer can't overwrite a fresh one. **The photo pane:** choosing a photo (the first one is chosen automatically) opens a dark pane to the right of the map that shows the photo as it was taken, with its heading, facts and caveats, a "Preview at W × H px" line, and a link to open the full photo (about 40 MB) in a new tab. The map narrows to make room. It shows a loading message, and a plain message with a Try again button if the photo cannot be fetched. Close (or Escape) hides it, and choosing another photo or making a new lookup reopens it; a lookup that finds nothing hides it. On a narrow screen (800 px or less) the pane goes under the map. Decoded photos are kept in a 6-photo cache, so going back to one is instant and costs no network. **Thumbnails and notes in the list.** Each row of the results list has a 96 × 72 px thumbnail of its photo, with the row number on it, loaded best first and two at a time after the list appears, and put into its row without redrawing the panel. Each thumbnail is the photo's smallest overview, shrunk to the size it is shown at (the canvas is kept at that size, 96 × 72 for a landscape photo and 54 × 72 for a portrait one, at a device pixel ratio of 1; the 1287 px overviews are about 5 MB decoded and 40 are kept, so they are not kept whole). They are kept for the session in a 40-photo cache, so changing the direction and back costs nothing. **When two or more photos in the list carry the "near the edge" note, each of those rows gets an orange asterisk after its facts and the note is shown once under the list; a single such photo keeps its own inline note** (the rule is `sharesEdgeNote` in `describe.ts`, tested). The other orange notes (looks away from the direction, re-flight) stay inline. The pane's header now shows the photo's file name (its key, `KY_KYAPED_..._3IN/Cam_FL_shot.tif`) in monospace, selectable in one click. **Tucking:** a Tuck button in the pane's header shrinks it to a thin tab at the right edge (under the map on a narrow screen), and the tab opens it again; the photo keeps loading while tucked. **The Scene button** (top right of the map, under the zoom controls) is described below. **Not there yet:** the point is not marked on the photo, the preview cannot be zoomed or panned, and the scene shows one photo, not a mosaic.

Source layout: `src/main.ts` wires the map to the panel, `api.ts` is the API client, `describe.ts` turns a ranked frame into words (the tested part), `panel.ts` draws the panel, `footprint.ts` owns the map layers for the chosen frame, `photo.ts` is the photo pane, `lru.ts` is its cache, `cog.ts` reads a photo's pixels from its COG (see Reading a photo), `camera.ts`, `lcc.ts` and `scene.ts` are the camera model, the EPSG:3089 projection and the placement geometry (see The camera model and the scene), `drape.ts` puts a photo on the map, `scene-control.ts` is the Scene button, `thumb.ts` sizes the list thumbnails, `warm.ts` wakes the TiTiler, and `config.ts` holds the basemap settings.

### The camera model and the scene (`camera.ts`, `lcc.ts`, `scene.ts`, `drape.ts`)

**The camera model** (`camera.ts`) maps between ground points and pixels of the full-size photo. It was found by searching conventions on 1,000 real frames and is exact to about 0.002 px against the vendor's footprint corners (median; max 0.005 px).

```
v = M (P - C)          M = Rz(-kappa) Ry(-phi) Rx(-omega)     angles in degrees; C = EO x,y,z; P = ground X,Y,Z (EPSG:3089 feet)
x = -f vx / vz + ppx   y = -f vy / vz + ppy                    mm from the sensor centre; the camera looks along -z
col = W/2 + x / pix    row = H/2 - y / pix                     pix = ccd_res_u / 1000 mm; no width/height swap
```

- **Footprint corners.** For every oblique camera, footprint vertices 1 to 4 are the picture's top-left, top-right, bottom-right and bottom-left corners (checked on Fwd, Bwd, Left and Right, both sensors). **Color's vertex order varies from frame to frame**, so use the projection, not the order. This settles the open question about which vertex is which.
- **Principal point.** `ppx` is 0 everywhere. `ppy` is 0 for Color, Fwd and Bwd and about 6.7 mm (6.75 mm on the 3P sensor, 6.68 mm on the 4.1) for Left and Right, so it must be included, with a plus sign; the wrong sign puts the photo 2,600 to 3,550 px off. The lens mounting angles (`cam_omega_dg`, `cam_phi_dg`, `cam_kappa_dg`) are zero on all 4,384,880 frames, so the model ignores them, and `createCamera` throws if it ever meets a non-zero one.
- **Tests** (`camera.test.ts`, `scene.test.ts`, `lcc.test.ts`; fixtures in `web/test/fixtures/frames.json` are frame metadata only, no imagery): 10 real frames, every camera on both sensors. Obliques' four footprint vertices land on the four picture corners within 0.05 px; Color's four vertices land on the four corners in any order; pixel to ground and back is exact; a point behind the camera gives null.
- **Checked against something independent.** The vendor's footprints and the EO come from the same aerotriangulation, so the 0.002 px agreement only shows self-consistency. The Phase 3 orthoimagery service is a separate source: `Bwd_7025_44168` (Louisville, around Cherokee Park and Bardstown Road; an earlier version of this file wrongly said Lexington) was warped onto flat ground at the footprint's mean height (515 ft) and compared with the orthoimagery for the same rectangle. The big-box store, the road along the park's edge, the sports field and the cemetery line up within a few pixels of a 640 px preview. In the app, on the same frame, an enlarged crop of the draped photo against the basemap shows the field and the large building at the top within about 5 screen pixels (about 35 ft at that zoom), but the curving road along the park's edge about 12 pixels (roughly 85 ft) off. That is more than the 30 ft of height spread in this footprint should explain (a flat-ground error is about 1 to 1.5 times the height error, so 30 to 45 ft), so part of it may be tree and building lean or something not yet understood; it was not investigated. **One frame, judged by eye, from a crop, not measured.** No frame from a pass where the two EO folders differ has been checked, so that open item is still open.
- **Terrain is the limit.** The drape treats the ground as flat at the mean of the footprint's four heights. A height error of dz moves a point sideways by about 1 to 1.5 dz. On 8 real oblique frames the corners were 4 to 40 ft from the vendor's terrain-projected corners where the footprint's height spread was 30 to 100 ft, and up to 116 to 218 ft where it was 215 to 365 ft. So in hills a flat drape is a couple of hundred feet off; the per-frame terrain patches are the way to correct that (their units and row order are still unverified).

**The statewide DEM** (`https://tiles.arcgis.com/tiles/ghsX9CKghMvyYjBU/arcgis/rest/services/Ky_DEM_KYAPED_Phase2_WM/ImageServer`, shared by the user): a hosted elevation tile layer, "KyFromAbove Phase2 Hosted Elevation Layer", made from the statewide two-foot DEM, copyright "KyFromAbove Program Partners". Checked on 2026-09-19:

- **What it is.** Web Mercator (`102100`), standard tile scheme, levels 0 to 23, 256 px tiles, F32, capabilities `Image,TilesOnly,Tilemap` (tiles only, no queries). The extent matches the project's bounding box (about −89.72 to −81.88 longitude, 36.45 to 39.16 latitude). Tiles are URLs of the form `.../ImageServer/tile/{z}/{y}/{x}` (row before column). The 2-foot source is about 0.6 m per pixel, level 18.
- **Format.** `image/lerc`, the **older LERC1** (`CntZImage` header), and **each tile is 257 × 257 pixels** (a one-pixel overlap), with no mask (a decoded tile had none). The `lerc` npm package (4.2.0) decoded them in Node.
- **Coverage.** Tiles returned 200 at levels 14 and 18 in Louisville, Lexington, Paducah, Pikeville, Bowling Green and Covington (12 of 12), with `Access-Control-Allow-Origin` echoing the requesting origin. Tile sizes were 13 to 66 KB.
- **Units: metres.** Multiply by 3.280833 for US survey feet.
- **It agrees with the vendor's per-frame patches.** For each of 6 frames, the patch was compared with the DEM at the same ground points (about 340 to 1,000 cells each, level 17, patch cell centres, patch read bottom-up). Four frames agree to an RMS of 0.5 to 1.7 ft (mean offset within 0.4 ft): `Bwd_7025_44168` 0.8, `Left_9090_400269` 0.5, `Left_2003_1710` 1.7, `Fwd_13019_1018` 0.7. `Bwd_1124_014490` (near −83.75, 38.41) has an RMS of 7.3 ft and a mean of +2.5 ft, with 15% of cells more than 10 ft off and the rest at 4.9 ft, which looks like a real difference between the two elevation sources there (not investigated). `Right_7157_4942`, on the Ohio River near Cincinnati, disagrees on 53% of cells: 243 of 1,026 sample points are **exactly 0 in the DEM** (the Ohio side of the river, outside Kentucky), and the river surface itself differs by about 15 ft (DEM 144.5 m = 474 ft against the patch's 457 to 460 ft). The rest of that frame agrees to 2.0 ft. Reading the patch top-down instead gave RMS errors of 23 to 240 ft on every frame, which is how the row order was settled.
- **So:** it is a finer, statewide, shared source that agrees with the vendor's terrain where both have data, but it has **no data outside Kentucky** (zeros) and the imagery covers 47 counties in neighbouring states, so the per-frame patch (or a rule to notice zeros) is needed there. Both are "Phase 2 vintage"; the sources differ by several feet in places.
- **Why it would help:** relief correction for the drape (the flat-ground error above), the ground height under a clicked point (needed to mark it on a photo), and, for a mosaic, one set of tiles serves every frame in view, where the sidecars cost one request per frame (each about 64 KB).

**The projection** (`lcc.ts`) converts EPSG:3089 feet to lon/lat and back in the browser (Lambert conformal conic, GRS80, the PostGIS parameters, NAD83 taken as WGS84 like the API). It agrees with PostGIS's `ST_Transform` to about 1 mm at most points and 6 mm at the far-east one (both implementations are self-consistent there; the imagery is accurate to about 0.67 ft, so the test allows 1 cm). The central meridian is −85.75°.

**The scene** is a first cut: one photo on the map. The **Scene** button drapes the selected photo on the map at the four ground corners of its picture (`photoCorners`, which projects the picture's corners onto flat ground) using MapLibre's image source, which warps the image with perspective, and turns the map so the top of the photo is up: `upBearing` is the true bearing on the ground from the middle of the picture's bottom edge to the middle of its top edge. That is the look direction as a *true* bearing; the vendor's look azimuth is a *grid* bearing, and in the unit tests the two differ by less than 3.5°. Turning the scene on tucks the photo pane; turning it off removes the drape and returns the map to north. Choosing another photo or direction replaces the drape and turns the map again. The drape uses the pane's overview, so it is soft when zoomed in.

**How it was checked:** a scratch browser script (in the session's scratch space, not in the repo) drove the real app in headless Chromium against the real API and bucket: no drape and a north-facing map before the scene; Tuck shrinks the pane to 35 px and the map grows by 694 px, the tab shows and the photo is kept, the tab reopens it; Scene tucks the pane and adds the drape layer; North gives bearing 0.75°, East 90.27°, South −178.79°; the drape is really drawn (hiding it changes the middle of the map by 25 out of 255 against a noise floor of 0; the basemap here is itself aerial imagery of the same ground, so the change is small by design); turning the scene off removes the drape and returns to bearing 0; no console errors. The first version of the drape check used a guessed threshold and failed at 10.9 against 12; the screenshots showed the drape was drawn (the basemap's street labels were covered), so the check was measuring the wrong thing, and it now compares against a measured noise floor. The earlier 20-step pane script and the production build still pass. Screenshots were looked at for North, East and South.

### Reading a photo in the browser (`web/src/cog.ts`)

`loadOverview(url, { boxWidth, boxHeight, pixelRatio })` fetches and decodes one photo into a canvas. It reads the COG's TIFF header by HTTP range request, picks the smallest overview level that has enough pixels for the space (`pickLevel`, with a byte budget), fetches that level's tiles, and puts the file's shared JPEG tables back in front of each 512 px tile (`tileJpeg`) so the browser's own decoder can decode it. The photos are not georeferenced, so it reads pixels only. Larger levels are about 2.7 MB (2575 px) and 11 MB (5150 px), and the full photo is about 41 MB. The CORS preflight for the `Range` header is allowed by the bucket, and `Content-Range` is not needed because the code works from the bytes.

- **Small pictures read only what they need.** `loadOverview` takes a `firstFetch` option, and `readHeader` reads that many bytes from the start and, if the TIFF directories run past them, reads again with four times as much up to 4 MiB (the default first read is still 1 MiB, which also brings the smallest overview). A photo's header was 8 to 24 KB on all 10 fixture photos, and its smallest overview is 60 to 550 KB, so the thumbnails start with 32 KB: five thumbnails plus the photo pane's own picture took **1.9 s and 1.8 to 2.1 MB in all** on the Louisville point, against **7.3 s and 8.9 MB** with the 1 MiB first read. The cost depends on the file: the smallest overview is 1287 × 962 px on photos with only 4 levels (370 to 550 KB; the 3P Fwd and Bwd fixtures) and 241 to 442 px on photos with 6 or 7 levels (60 to 100 KB). About two thirds of the oblique frames (2,337,920 of 3,507,904) are 3P-sensor frames, but the level count varies within a sensor, so a typical click's cost was not measured beyond the fixtures.
- **The number of overview levels differs from photo to photo,** so the smallest level is anywhere from about 240 to 1768 px on the long side, even within one season (2023 S1 alone has 321, 322, 442 and 1287). The level is chosen by pixels needed, never by position in the file.
- **Transfers from the bucket stall, so the fetching is chunked and hedged.** Measured from this WSL machine: a single 1 MiB range request stalls for 17–25 s after a normal first byte in roughly a quarter to a third of requests (3 of 12 in a control run made while testing the fix; 6 of 20 earlier), a stall that hits a photo on its first read as often as its second. Requests of 64 KB and 256 KB did not stall (none over 5 s in 12 requests of each). It is not cold-versus-warm, and it is not the MTU (full 1500-byte packets reach the bucket). The cause is unknown, and it has not been tried from Windows or another network, so it may be particular to this machine. **A later run did not reproduce it:** 36 single 1 MiB reads (24 from the state's bucket, 12 from an unrelated public bucket in the same region) and 6 loads made the way the app does (four 256 KB chunks in parallel) had no stalls at all, the slowest taking 1.6 s, and a Cloudflare control ran at 9–25 MB/s. The traffic left through the home ISP, so the VPN was off then; whether it was on during the runs that stalled is not known. The user reports that Proton limits this laptop to about 5 MB/s when connected, that Norton scans and quarantines a lot, and that the laptop seems throttled. A 5 MB/s cap does not explain stalls of about 50 KB/s. To separate the causes: rerun the same test with Proton on, and time the same request natively from Windows (PowerShell `curl.exe`) against WSL. The user's browser makes these requests from Windows, not WSL, so a stall that happens only inside WSL may not affect real use. `fetchBytes` therefore reads in 256 KB chunks, 6 at a time. A chunk still missing after 1.5 s is asked for again in parallel and the first answer wins, an attempt is abandoned after 8 s, and each chunk gets 3 attempts. On 32 fresh, never-touched photos, `loadOverview` took a median of 0.63 s and at most 1.8 s, with none over 6 s, while plain 1 MiB requests made in the same period stalled 3 of 12 times. That comparison can't say how many of the 32 would have stalled; the mechanism is covered by tests with a fake network that stalls. An earlier version that only timed out and retried at 5 s still took 4 s and 10.4 s on 2 of 10 photos, which is why it hedges.
- **Checked against a known-good decode:** 8 photos covering every thumbnail size (portrait and landscape, both sensors) were decoded in Chromium and compared with the Python decode of the same files. The dimensions match exactly, the mean color is within 0.22 of 255, and the grey-level correlation on a 48-column grid is at least 0.98. The remaining difference comes from the Python thumbnails being re-encoded at quality 85 and the two tools resizing differently.
- **Tests:** 26 unit tests in `web/test/cog.test.ts` (four of them for `readHeader`: one small read for a small header, growth by four times, giving up at 4 MiB, and other errors passing through). They cover synthetic TIFFs in both byte orders, truncated and malformed headers, level choice, the JPEG-table splice, and the fetching against a fake network that stalls, errors, returns short ranges and is cancelled. Writing them found two gaps that are now fixed: a directory with an empty tile list was accepted, and a range past the end of a small file (answered 416) was treated as an error.

**Gotcha: MapLibre 6 with Vite needs its worker told where it is.** MapLibre 6 works out where its worker file lives from the location of its own script. Vite pre-bundles that script in dev and bundles it into the app in a build, so the guess pointed at a file that did not exist (a 404 in dev; the production build did not contain the worker at all). Everything that needs the worker, GeoJSON sources included, silently never loaded, with no error in the console; raster tiles, which need no worker, kept working and hid the problem. The fix is in `main.ts`: `import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'` and `setWorkerUrl(workerUrl)` before creating the map, which makes Vite bundle the worker and emit it as a file. If the footprint layer ever disappears again, check that first. Also, `window.__map` is exposed for test scripts in dev, or in a build made with `VITE_EXPOSE_MAP=1`; it is off in normal builds.

**Basemap (chosen by the user, "to start out"):** the Commonwealth Map, `https://kygisserver.ky.gov/arcgis/rest/services/WGS84WM_Services/Ky_TCM_Base_WGS84WM/MapServer`, from the Kentucky Division of Geographic Information. It is used as a raster source with the URL `.../MapServer/tile/{z}/{y}/{x}` (ArcGIS puts the row before the column). Settings live in `web/src/config.ts`. Checked against the live service:

- A cached Web Mercator service, standard tile scheme, 256 px tiles. Mixed PNG (low zoom) and JPEG (high zoom), roughly 15–120 KB each.
- The metadata lists levels 0–23, but **the cache stops at level 20**: level 21 and above return 404. The map sets `maxzoom` 20 and lets MapLibre stretch the last level.
- Low zoom levels exist around the state, but **from about level 12 up every tile outside Kentucky is a 404.** The map is limited to the state's extent plus 0.6° so panning can't reach missing tiles.
- Open CORS: the response echoes whatever origin asks (tried localhost, example.com and another), so a deployed site can load the tiles.
- The service's own copyright text is "Kentucky Division of Geographic Information (DGI)", which the map shows as the attribution.
- Responses carry `Cache-Control: public, max-age=86400`. The service supports only the `Map` capability (no queries).
- Considered and not used: `.../Ky_Imagery_Phase3_3IN_WGS84WM/MapServer`, the orthoimagery from this same project. It is also a cached Web Mercator service with 256 px PNG tiles of about 50 KB, levels 0–21, open CORS, and an extent that matches the project's bounding box exactly (-89.72 to -81.88, 36.45 to 39.16). It answers 404 for every tile outside the project area, and its layers include Boundary, Footprint and Image. It publishes no copyright text. It could be added as a toggle later.

**How it was verified:** the build and typecheck pass, the 6 unit tests pass, and a 17-step script drove the real app in headless Chromium against the real API and database. It ran on the dev server and on a production bundle served by `vite preview`, and both passed with no console errors. The steps: the prompt before a click; a click on Louisville lists five photos; North is selected; the first photo looks north; a footprint and camera are in the map's data; **the clicked point is inside the drawn footprint; the footprint is actually rendered** (queried from the rendered layers); East lists east-looking photos and moves the footprint; choosing another photo moves it again; Down (since removed from the selector) listed straight-down photos; a click outside Kentucky says so and clears the footprint; and a simulated 503 shows the plain message. Screenshots were looked at. Playwright's browsers are already in `~/.cache/ms-playwright`. **The script lived in the session's scratch space and is not in the repo, so this is still a manual check, not an automated test.** The first version of the script only checked that the footprint was in the map's data, which is why it passed while nothing was drawn; only a screenshot showed the worker bug above.

**The photo pane was checked** with a 20-step script in headless Chromium against the real API, database and bucket (a scratch script, not in the repo). All 20 steps pass with no console errors: the pane is hidden before a click and appears on selection; the photo loads at a level with enough pixels for the pane and is a real picture (not blank or flat); the heading, full-photo link and size line are right; the map narrows and keeps working; East shows a different, portrait photo for the Left camera; choosing the second photo changes the picture; going back to a photo already seen took about 20 ms and made 0 bucket requests; Close, reopening and Escape work and the map gets its width back; a blocked network shows the message and Try again loads the photo once it is back; a click outside the imagery hides the pane; and on a 390 px wide screen the pane sits under the map. Screenshots were looked at; the photos are the real oblique views. Two of the failures along the way were mistakes in the script, and one was a real bug: on a narrow screen the pane grew to fit the photo's own height instead of taking 46% of the screen (fixed with `min-height: 0`).

**What the pane picks to fetch:** the smallest overview with enough pixels for the space (see Reading a photo), so the size varies: a 4.1-sensor Bwd photo came at 884 × 660 px into a 667 px wide pane, and a Left photo at 660 × 884. On a high-density screen it fetches a larger level, up to a 12 MB budget. There has been no test on a high-density screen.

**Problems seen in the screenshots, not fixed:** the results panel and the pane leave the map cramped. On a 1280 px screen the map is 613 px wide and the panel hides the clicked pin, and on a phone the panel covers nearly the whole map. The panel needs to collapse, or the list could move into the pane.

## API

`api/` is a small read-only JSON API over the local PostGIS: Fastify 5, `pg` 8, TypeScript 7. Node 24 runs the `.ts` files directly (native type stripping, so there is no build step; `erasableSyntaxOnly` keeps the code to syntax Node can strip). It holds almost no logic: it validates a request, calls one of the SQL functions, and shapes the rows into JSON. The selection rule stays in `pipeline/postgis/functions.sql`.

```
cd api
npm install
npm start          # 127.0.0.1:3001; `npm run dev` restarts on changes
npm test           # 15 tests against the real local PostGIS (not mocked); start it first with docker compose and load it with pipeline/load_postgis.sh
npm run typecheck
```

Configuration is by environment: `HOST`, `PORT` (3001), `IMAGE_BASE` (the regional `kyfromabove` bucket URL for `imagery/obliques/Phase3/`), `CACHE_SECONDS` (300), and the usual `PG*` variables, which default to the local container on port 5433 as the read-only role `viewer_ro`. The Vite dev server proxies `/api` to it.

| Request | Returns |
|---|---|
| `GET /api/frames?lon=&lat=&look=&limit=` | The ranked frames covering a point (`frames_at_lonlat`). `look` is `north`, `east`, `south`, `west`, `down` (the default, Color camera only), or a bearing in degrees (wrapped to 0–360). `limit` is 1–20, default 5. Each frame has its image URL and the reasons for its rank: `azOk`, `azOff`, `eligible`, `isReflight`, `centerDistFt`, `edgeFrac`, `estGsdFt`, `flownUtc`. Outside the imagery it returns an empty list, not an error |
| `GET /api/frames/{season}/{name}` | One frame in full: image and sidecar URLs, exterior orientation (position in EPSG:3089 feet and in lon/lat, and angles in degrees), the lens data under `sensor`, look azimuth and its ground-track check, and the footprint both as WGS84 GeoJSON and as `[x, y, z]` corners in EPSG:3089 feet |
| `GET /api/frames/{season}/{name}/neighbors` | The previous and next frame along the pass, same camera (`frame_neighbors`). A missing side is the end of a pass or a gap |
| `GET /api/health` | `{"status":"ok"}` when the database answers; 503 otherwise |

A frame is addressed by two path segments because its file name has one slash, for example `/api/frames/KY_KYAPED_2024_Season1_3IN/Bwd_7025_44168.tif`. Errors: 400 for bad input (`{"error":"bad_request","message":...}`), 404 for a frame that does not exist, and 503 `database_unavailable` when the database is down. Database details are never returned.

Design points:

- **Every value is a bound parameter,** and frame names must also match strict patterns before any query runs.
- **The database role is read-only.** `pipeline/postgis/roles.sql` creates `viewer_ro`. Its password comes from the psql variable `viewer_password`, which `load_postgis.sh` fills from the `VIEWER_PASSWORD` environment variable and which defaults to the dev password `viewer_ro`, like `oblique` in `docker-compose.yml`; use a real secret anywhere the database is reachable beyond this machine. The password change was checked by connecting from outside the container: inside it, the Postgres image trusts connections from `127.0.0.1`, so a login test there proves nothing about passwords. It has `SELECT` on `frames` and `frames_duplicates`, defaults to read-only transactions, and has a 5 s statement timeout. `load_postgis.sh` runs it after every load, because `schema.sql` drops the tables and that discards their grants. The reload was run and the tests passed afterward.
- **Responses carry `Cache-Control: public, max-age=300`** (`no-store` for health), because the data never changes.
- **Lon/lat only.** `frames_at_lonlat` converts WGS84 to EPSG:3089 and ignores the WGS84/NAD83 difference of about a metre.
- **Not done:** rate limiting, CORS (the app is same-origin through the proxy), any load test, and any deployment. There is no login, since everything served is public data.

**How it was checked:** the 15 tests cover input parsing, all four endpoints, validation and injection attempts, an outside-coverage point, the 503 path, and the API role's inability to write. One of them checks that the clicked point lies inside the returned WGS84 footprint. As a check on the tests, the coordinate transform was deliberately broken and exactly that test failed. The server was also run, and its endpoints were called through the Vite proxy.

## Status

- Built: the DuckDB normalization, the PostGIS schema and loader, the query layer with its selection rule (`pipeline/`, `docker-compose.yml`), the API in `api/`, and the map in `web/` that looks up and lists the photos covering a click and draws the chosen footprint. The photo pane shows the selected photo, using the COG reader in `web/src/cog.ts`, and can be tucked to the side. The camera model, the EPSG:3089 projection and a first scene (one photo draped on the map, map turned so it looks up) are built. Not built: a mosaic of several photos over the viewport, panning that swaps photos, terrain correction, resolution that follows the zoom, marking the point on the photo, an automated browser test (the checks were scratch scripts), and any hosting or migration.
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
- Review the proposed frame selection rule (see Query layer) using the review harness: is nearest-to-center the right quality measure, and does a reflight really beat an original? Should the UI let the user step to alternatives? Collect ratings on the default 36 points first.
- What does "look north" mean in the UI: a camera looking north, or a view from the north? `frames_at_point` takes the look direction.
- Adjacent flight lines: `frame_neighbors` only walks along one pass. Moving sideways across lines is not built.
- Decide on the 6 invalid footprints (leave, repair with `ST_MakeValid`, or exclude).
- Hosting for beta and production is deliberately deferred. Development stays on local PostGIS. Facts gathered: the existing viewer's `index.html` gets several million requests a month, and the S3 obliques prefix about 4 million hits a month; imagery is served from the public KyFromAbove bucket, which allows browser CORS range requests (its exposed headers do not include `Content-Range`, which some COG readers need; untested). The DB is 3.2 GB and the Parquet 0.7 GB. Because the data is static, a set of precomputed per-cell lookup files could replace a database at serve time (5,000 ft cells would be about 49,000 files, roughly 0.8 GB, about 15 KB for a typical lookup, estimated at about 70 bytes per frame). The candidate hosts are an existing production server (no extra cost if it has headroom, at about 10 million requests a month today, and one that hosts about 20 static pages), a dedicated server ($200–400 a month), or S3 with a CDN (a rough guess of $0–80 a month, unverified). No decision has been made.
- Look at the roughly 330 Left/Right frames in 2023 S1 that are more than 10° off, and the 4–16 per camera that are more than 45° off. Are they bad Kappa or an artifact near turns?
- Check whether the Kappa residual varies with easting, to settle grid vs true north.
- Does the vendor viewer use `flight-orientation`, and would that explain its direction problem?
- Examine the 3 exposures with per-camera replacement (only `FL 3056` has been looked at).
- The JSON sidecars are terrain grids only, with no flight-line, pass, or direction information, so they can't replace the heading work. Their units and row order are now settled (feet, bottom-up; see The statewide DEM), but their coverage against a footprint is still unchecked. Reading every sidecar is impractical (about 100 GB).
- **Terrain for the drape and the tools:** the state's hosted DEM tiles (see The statewide DEM) look like the better source, with the per-frame sidecar as the fallback outside Kentucky. Open decisions: add a LERC decoder (the `lerc` npm package, Apache-2.0, about 10 KB of JavaScript plus a 117 KB WebAssembly file, not yet added to the app), whether to warp the drape over a terrain mesh or sample heights per corner, and whether the state's service may be used at this volume (it is a hosted ArcGIS Online tile layer, so check its terms and limits).
- Why is `Bwd_0_40721` (`FL 0`) in the bucket but not in the layers? Are there other such images?
- Rendering approach is undecided. Tile serving via titiler was floated, but it does not suit these non-georeferenced photos. The likely route is reading the COGs in the browser by range request (the bucket allows CORS, but does not expose `Content-Range`; untested), with the ground-to-photo projection computed from the EO, the lens data and the per-frame terrain patch. That projection can be checked by projecting the photo's corners onto the footprint's vertices. It is the riskiest piece, and it is not started.
- **The goal for the scene is a mosaic, like the vendor's viewer:** at the closest zoom levels (the user recalls about three) the oblique photos are stitched and draped on the map, the look direction is always up, changing direction turns the map, and the user pans freely with photos swapping underneath. It is to be built into this app (a scene mode next to the click lookup and the photo pane), with the camera model, decoder and API shared. What exists is one photo draped (see The camera model and the scene). Planned order: a viewport endpoint that returns the frames to show (using the selection rule, and preferring one pass so seams stay few), draping several with a sensible order and seam handling, loading the COG overview that fits the zoom and only the tiles in view (native resolution is about 0.2 ft/px, roughly zoom 21, and the basemap stops at 20), terrain correction from the sidecar patches, and then tools (mark the clicked point on the photo, measure, step to a neighbour or another flight line). The map's bearing will need to be a chosen cardinal direction (true), with each photo turned a few degrees off it.
- **The state already runs a STAC API with no oblique collection.** The AWS open-data registry lists `https://spved5ihrl.execute-api.us-west-2.amazonaws.com/` (a stac-fastapi service titled "Kentucky From Above SpatioTemporal Asset Catalog"), plus a Catalog Explorer at `kygeonet.ky.gov/catalogexplorer`. It has 9 collections (DEM phases 1–3, point clouds phases 1–3, orthoimagery phases 1–3) and no obliques. It supports item search, CQL2 filtering, sorting and field selection, and its conformance list includes the transaction extension (whether it accepts writes is unknown). A point search takes about 0.3 s. Its orthoimagery items use the `projection`, `raster` and `eo` extensions, one item per 5,000 ft tile, with `data`, `metadata` and `thumbnail` assets and a CC-BY-4.0 collection license. **The user may build an oblique collection.** It would be one item per photo, with the UTC flight time, `view:azimuth`, `view:off_nadir` (45° or 0°), GSD, the COG and the terrain sidecar as assets, and the exterior orientation as extra properties. Before publishing: the azimuths are grid bearings and STAC expects true north (the convergence question is open), 4.4M items is much larger than the other collections, and the 44,065 duplicate frames need a decision. It would be one more output of the pipeline (items or stac-geoparquet). It would not replace this project's API for the viewer, because the selection rule is not expressible as a STAC search, unless the rule moves into the browser.
- The basemap is served by the state's GIS server, so every map view puts load on it (about 20–150 tiles of 15–120 KB each). The existing viewer gets several million page loads a month. Is that acceptable to the Division of Geographic Information, or should tiles be cached or proxied? Also confirm the attribution wording.
- **The TiTiler is the user's own deployment.** They deployed it with Development Seed's one-click AWS deployment of TiTiler-PgSTAC and configured it for this work, and say it is a **public API**. (Its address is currently kept out of this file and the repository, in the git-ignored `web/.env.local` as `VITE_TITILER_URL`, because I first took it for a private endpoint; whether to commit it is the user's call.) Checked with read-only requests: titiler 1.2.1, titiler-pgstac 2.1.0, rasterio 1.5.0, GDAL 3.12.1 on AWS API Gateway; `GET /healthz` answers `{"database_online": true, ...}` in about 0.4 s (it did not look asleep); CORS allows any origin; and it has 77 paths, all for items in its own STAC catalog (`/collections/{id}/items/{item}/preview/{w}x{h}.{format}`, `/collections/{id}/point/{lon},{lat}`, `/collections/{id}/bbox/...`, `/searches/...`), with **no plain `/cog` endpoint.** Its registered searches name only `dem-phase1`, `dem-phase2`, `dem-phase3` and `orthos-phase1`; eight guessed oblique collection names all answered 404 (it has no listing of collections, so this is not proof), and the state's STAC API had 9 collections and no obliques. **So it cannot make oblique thumbnails today:** the photos would have to be registered in its catalog first (an oblique collection, which the user controls and has considered), and they have no georeferencing, which broke the stock `/cog/preview` on a local TiTiler 2.3.0 (HTTP 500, `'NoneType' object has no attribute 'to_authority'` in `rio_tiler` `CRS_to_uri`; that container and image were removed). Whether TiTiler-PgSTAC's item preview fails the same way was not tested; if it does, the deployment being the user's own means a custom reader that supplies a coordinate system is possible. A server-side preview would cut a thumbnail from 60 to 550 KB to roughly 10 KB and could be cached by URL, but TiTiler crops by geographic bounds, so it could not crop around the clicked point.
- **The warm-up ping is built** (`web/src/warm.ts`): when the app opens, it sends one `GET {VITE_TITILER_URL}/healthz` (30 s limit) and ignores the result, so a service that sleeps between uses is starting by the time it is needed; nothing is sent if the address is not set, and any failure is swallowed. Nothing else in the app uses the service yet. The user expects to remove it later. Checked in a real browser: one `/healthz` request, answered 200, before any click; zero requests with the address empty; the app loads without errors when the service is blocked. Vite restarts the dev server by itself when `.env.local` changes.
- **The TiTiler's DEM point query is usable for the terrain question.** `GET /collections/dem-phase2/point/{lon},{lat}?assets=data` returned 508.857 at the Louisville test point (`dem-phase1`: 508.894), in **feet** (the state's source COGs, where the hosted ArcGIS tile layer is in metres); `dem-phase3` answered HTTP 204 (no data) there, so Phase 3 does not cover it. That fits the range of the hosted tile at that spot (154.6 to 160.7 m, 507 to 527 ft) and the vendor footprint heights (499 to 528 ft). Each query took 0.7 to 0.9 s, so it suits the height under one clicked point, not a terrain mesh. Without `assets=data` it answers HTTP 400.
- **The DEM is not one source.** Phase 2 has data at Louisville and Phase 3 does not, so which vintage covers a given frame varies by place (the photos are Phase 3 imagery). Not investigated.

- Frame-transition UX is undecided.
- Panel UX questions seen in the first working version: the list always shows five photos, so when fewer look the requested way the rest are fillers from other directions (marked in amber; should they be hidden when some qualify?). The results panel covers a large part of the map on a laptop screen and would cover most of a phone's; it needs to collapse. The selected direction and point are not in the URL, so a view cannot be shared or reloaded.
- Add the browser check to the repo as an automated test (Playwright as a dev dependency, against the API and database). It found the worker bug that no unit test or build check could.
- The repo's final name is undecided.
- License: MIT, chosen by the author (a personal project for now, so the author sets the terms). If this later becomes agency work, check ownership before relicensing or accepting outside contributions. The imagery and metadata are NV5/KyFromAbove data and are not covered by this license.
