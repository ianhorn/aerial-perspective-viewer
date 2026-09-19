# CLAUDE.md

Project context for Claude Code. Started from an earlier Claude Desktop session, then updated after inspecting the real data in `geopackages/`. Items marked **unverified** or **inferred** were not confirmed against documentation or a live system.

## What this is

A viewer for KYAPED (Kentucky) oblique aerial imagery. Imagery is served from S3 as COGs; frame metadata comes from the vendor's GeoPackages.

The repo's README title is `aerial-perspective-viewer` and the directory is `oblique-viewer`. The name is not settled.

## Repo hygiene

- Imagery, COGs, GeoPackages, and DB dumps must never be committed. `.gitignore` excludes these, including `geopackages/`. Don't `git add -A` blindly. Check `git status` first.
- Dev environment is WSL2 Ubuntu on Windows. ArcGIS Pro stays on the Windows side.
- Local tooling that works: `docker`, and the `duckdb` CLI with the `spatial` extension (`LOAD spatial; SELECT ... FROM ST_Read('file.gpkg')`). `ST_Read` takes one file, not a glob. Not installed: `ogrinfo`/`ogr2ogr`, `sqlite3`, GDAL or geopandas for Python.
- The analysis so far was ad hoc DuckDB queries. None are saved in the repo.

## Data model (verified against `geopackages/`)

Four seasons (2022 S2, 2023 S1, 2023 S2, 2024 S1), 20 GeoPackages in two folders, all EPSG:3089 (NAD83 / Kentucky Single Zone, US survey feet). Schemas are identical across seasons.

Per season:

- **ImageFrames**: polygon ZM footprints. Z looks terrain-projected (**unverified**).
- **ImageFrameCentroids**: the same attributes as Frames, as points. Redundant.
- **ImageFrameEO**: 3D points with the exterior orientation and camera intrinsics. Also present in `flight-orientation/` with the same rows and identical positions, but **the Kappa values differ for about 31.5% of exposures** (see Two EO folders).
- **ImageFrameBoundary**: one polygon per season.

Columns:

- **Frames:** `Filename`, `FlightDate`, `FlightTime` (local), `TimeZone` (`EST (-5)`, `EDT (-4)`, `CST (-6)`, or `CDT (-5)`), `FL`, `ShotID`, `CameraID`, `Year`, `Season`, `S3URL`.
- **EO:** `ID`, `X`, `Y`, `Z` (State Plane feet), `Omega`, `Phi`, `Kappa`, `FlightDate`, `FlightTime` (looks like UTC, checked on one row), `CamName`, `CamWidthPx`, `CamHeighPx`, `CamFocalMm`, `CamCCDResU`, `CamOmegaDg`, `CamPhiDg`, `CamKappaDg`, `CamPpxMm`, `CamPpyMm`.

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

`flight-information/*EO.gpkg` and `flight-orientation/*EO.gpkg` hold the same rows (compared on 3,980,525 IDs that are unique in both) with identical positions. **Only 2023 S1 and 2024 S1 were compared. 2022 S2 and 2023 S2 were not.** They differ in Kappa for **250,852 exposures (about 31.5% of the 796,106 compared, on 752 of 2,383 lines)**:

- Only three cameras change: **Fwd by exactly 180°, Left and Right by exactly 90°.** Bwd, Color, Omega, Phi, and X/Y/Z never differ.
- It is a per-pass property, not per-frame: of 3,133 passes, 1,146 differ on every exposure, 1,987 agree on every exposure, and none are mixed.
- It is **not related to flight direction**: 32.0% of northbound and 31.1% of southbound exposures differ.
- In `flight-information`, every exposure follows the same camera-to-camera Kappa relationship, and Kappa matches the ground track (see The heading problem).
- In `flight-orientation`, the differing exposures break that pattern: Fwd equals Bwd, and Left equals Right. Against the ground track, Fwd is off by about 178°, Left by −90°, and Right by +90°. **`flight-orientation` is wrong on those exposures, and `flight-information` is right.**
- File modification dates are 2025-04-28 for `flight-information` and 2025-04-18 for `flight-orientation`. That fits `flight-orientation` being older, but they may be download dates (**unverified**).
- **Use `flight-information`.** This may explain the vendor viewer's direction problems, since about 37% of passes have wrong Fwd/Left/Right Kappa in the other folder (speculation).

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

Validation (2023 S1 and 2024 S1 only, 795,516 exposures; 2022 S2 and 2023 S2 were not tested): comparing each camera's Kappa with the Color ground-track heading plus offset, in `flight-information`:

- Median error is about 0.29° for Fwd and Bwd and 0.44–0.47° for Left and Right. The 99th percentile is 1.8–4.1°.
- Few frames are far off. Where the two folders agree, 3 Fwd, 3 Bwd, 328 Left, and 323 Right frames of 544,681 exceed 10°. Where they differ, 1, 1, 1, and 13 of 250,835 do.
- The sign convention `Kappa = −heading + offset` fits far better than `+heading` (mean error 0.47–0.71° vs 1.24–1.88°).
- Stable by season: median error 0.32–0.5° for 2023 S1 and 0.25–0.41° for 2024 S1.
- The 250,835 exposures in passes where `flight-orientation` differs (see Two EO folders) are wrong there and should not be used.

Caveats:

- **This is self-consistency.** Kappa and the ground track both come from the same aerotriangulation, so agreement is expected. It doesn't prove the images point where Kappa says. **Spot-check a few frames against a map**, including one from a pass where the folders differ.
- The test used State Plane positions, so Kappa matches **grid** bearings, not true north (see the grid north note below).
- The Kappa test didn't cover 2022 S2 or 2023 S2.

For "look north", choose the camera whose `(−Kappa) mod 360` is closest to north. No ground-track derivation, pass logic, or ordering is needed for the heading itself. Passes are still needed for next/previous-frame lookups and for choosing between a reflight and an original.

The ground-track heading below is kept as a **fallback and cross-check**, in case Kappa turns out to be unreliable in the untested seasons or elsewhere. The earlier session validated the track approach on 16 lines (probably all of 2022 S2): mean error about 0.3–0.9°, max about 6°.

### Ordering and reflights (findings from the data)

These matter for adjacency (next/previous frame along a pass), choosing reflights, and the fallback ground-track heading. They are not needed for the primary heading.

Sorting Color frames numerically by shot number gives 422 backward time steps in 353 of 2,620 lines. A backward step in the `LAG` window would give a reversed direction vector, which is a 180° heading error.

- **Time zones** explain 258 of the 422 (local clock jumps at the Eastern/Central boundary). UTC-normalizing leaves 164 in 161 lines.
- **Reflights explain the rest.** 637 lines were flown on more than one date, and reflights are common. 155 of the remaining 164 backward steps jump back by more than a day.
- **The shot-number prefix looks like a pass marker** (**inferred**): numbers under 100000 are the original pass (prefix 0), and 1xxxxx, 2xxxxx, 3xxxxx are later passes. Within one date on one line the prefix is almost always constant (only 9 exceptions). 110,602 Color frames on 455 lines have shot ≥ 100000.
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

- **Define a pass** as (season, `FL`, `FlightDate`, prefix), and compute the ground track within a pass only. Add `pass_id` and a heuristic `is_reflight` flag (inferred, not from the vendor). Keep both the originals and the reflights.
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

**Proposed, not decided:** normalize once with DuckDB into GeoParquet (resolve the duplicates, which differ, so this needs a decision first; parse both ShotID formats, join Frames with EO, drop Centroids, convert times to UTC, add `pass_id`, compute the look azimuth `(−Kappa) mod 360` from the `flight-information` EO), then load PostGIS from that as the serving layer. At this scale (about 4.4M rows) don't partition by flight line, since that gives 2,620 tiny files. If Parquet is published, partition by season or season plus a coarse spatial tile, sorted spatially within each file. A browser-only design (Parquet plus DuckDB-WASM, no backend) is possible if headings and adjacency are precomputed. Decide whether there is a backend.

## Status

- Nothing is built yet. No schema, no loader, no app code.
- The earlier session drafted T-SQL files (`schema.sql`, `finalize.sql`, `docker-compose.yml`, `load.sh`, and a README) for SQL Server. **They are not in this repo and are superseded.** They were never run against a real SQL Server. At most they are a reference for the schema shape.
- Lessons worth keeping:
  - PostgreSQL lowercases unquoted identifiers, so handle the vendor's mixed-case column names on load
  - a load script should support both truncate-and-reload and append
  - the earlier design derived heading from the ground track per `FL`. Reflights contradict a per-line heading, and Kappa now gives a per-frame heading directly

## Open items

- Reflights usually win (per the user). What are the exceptions, and how would they be identified? Is there any vendor documentation? Should the viewer let users switch to the original frame?
- Which copy of the 44,065 duplicate frames is correct? Test each copy's smoothness against its neighbors, and check the sub-block hypothesis. Ask the vendor if possible.
- Spot-check a handful of frames visually against a map to confirm that `(−Kappa) mod 360` is the true look direction, including a frame from a pass where the two EO folders differ.
- Repeat the Kappa-vs-track test and the folder comparison on 2022 S2 and 2023 S2 (both were left out).
- Check whether the Kappa residual varies with easting, to settle grid vs true north.
- Does the vendor viewer use `flight-orientation`, and would that explain its direction problem?
- Examine the 3 exposures with per-camera replacement (only `FL 3056` has been looked at).
- The JSON sidecars are terrain grids only, with no flight-line, pass, or direction information, so they can't replace the heading work. They may help with rendering and with checking footprint Z. Verify the units, row order, and coverage against a footprint, using a frame that is actually in the layers. Reading every sidecar is impractical (about 100 GB).
- Why is `Bwd_0_40721` (`FL 0`) in the bucket but not in the layers? Are there other such images?
- Rendering approach is undecided. Tile serving via titiler was floated.
- Frame-transition UX is undecided.
- The repo's final name is undecided.
- License: MIT, chosen by the author (a personal project for now, so the author sets the terms). If this later becomes agency work, check ownership before relicensing or accepting outside contributions. The imagery and metadata are NV5/KyFromAbove data and are not covered by this license.
