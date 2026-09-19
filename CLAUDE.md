# CLAUDE.md

Project context for Claude Code. Carried over from an earlier Claude Desktop session, so items marked **unverified** were not checked against a live system.

## What this is

A viewer for KYAPED (Kentucky) oblique aerial imagery. Imagery is served from S3 as COGs; frame metadata comes from the vendor's GeoPackages.

The repo's README title is `aerial-perspective-viewer` and the directory is `oblique-viewer`. The name is not settled.

## Repo hygiene

- Imagery, COGs, GeoPackages, and DB dumps must never be committed. The data lives on `D:\Data` on Windows, which is `/mnt/d/Data` from WSL. `.gitignore` excludes these. Don't `git add -A` blindly. Check `git status` first.
- Dev environment is WSL2 Ubuntu on Windows. ArcGIS Pro stays on the Windows side.

## Camera rig and data model

Five cameras per exposure: Color (nadir), Fwd, Bwd, Left, Right. A shot is identified by `ShotID`, and flights by `FL` (flight line). There are 16 flight lines in the sample data. They fly a racetrack pattern: 8 lines go about north and 8 about south, alternating.

Two source layers, loaded into two tables joined on shot ID:

- **`image_frames`**: footprint polygons plus `Filename`, `S3URL`, `ShotID`, `CameraID`, `FL`, flight date/time. This comes from the vendor's Frames layer.
- **`image_frame_eo`**: exterior orientation (X/Y/Z, Omega/Phi/Kappa) and camera intrinsics (`CamFocalMm`, `CamWidthPx`/`CamHeighPx`, `CamCCDResU`, and so on). Keyed on `ID`, which equals `Filename` minus the extension.

## Project facts (from `metadata/KYSW_Obliques_KYAPED_Project_Metadata.xml`)

Vendor FGDC record from NV5 Geospatial, published 2025-07-17. The XML is on disk but not committed yet.

- **Acquisition:** Vexcel Osprey 3P and 4.1 cameras. One nadir camera plus four obliques at 45°. The metadata calls the obliques north/south/east/west. In the data they are Fwd/Bwd/Left/Right, so cardinal direction depends on flight direction.
- **Coverage:** 120 Kentucky counties plus 47 in neighboring states, about 41,349 sq mi. There are 119 flight lines over 130 flight days, from 2022-11-20 to 2024-04-07. The 16 flight lines in the sample data are a subset.
- **Imagery:** 3-inch GSD (0.217 ft average) at 5,883 ft above mean terrain. Non-orthorectified COGs, delivered to KyFromAbove and formatted for the vendor's Oblique Viewer.
- **Orientation:** nadir images are oriented to true north. Obliques are "horizon-up".
- **Overlap:** forward overlap averages 70% for nadir and 67% for oblique. Side overlap averages 46% for nadir and 40% for oblique.
- **Accuracy:** 0.674 ft RMSEr from 333 checkpoints. Far-oblique areas with GSD above 0.4 ft were excluded from that test, so far-field pixels are less reliable.
- **Coordinate system:** NAD83 / Kentucky Single Zone (FIPS 1600), US survey feet. Probably EPSG:3089, **unverified**. Confirm with `ogrinfo`.
- **DEM:** the vendor used a DEM (KyFromAbove LiDAR plus NED) to project obliques in its viewer. Accurate ground positioning will need terrain.
- **EO source:** the metadata names the project's EO shapefiles as the source for omega/phi/kappa, coordinates, sensor dimensions, focal length, and CCD resolution.

## The heading problem (validated in Python, not in SQL)

Don't trust the nadir camera's own Kappa for compass direction. Derive it instead:

1. For each flight line (partition by `FL`, order by shot number), compute the **ground-track heading** from consecutive Color-camera positions (`LAG`/`LEAD`), using a circular mean.
2. Each frame's compass direction is that track heading plus a fixed per-camera offset:

   | Camera | Offset |
   |--------|--------|
   | Fwd    | +0°    |
   | Bwd    | +180°  |
   | Left   | +90°   |
   | Right  | −90°   |

Checked in Python against the real EO data for all 16 sample flight lines (of 119 in the full project): mean error about 0.3–0.9°, max about 6° (attributed to aircraft yaw wobble).

**Grid north vs true north (unresolved):** headings computed from State Plane positions are grid bearings. The Kentucky Single Zone central meridian is −85° and the state spans about −89.7° to −81.9°. The gap between grid north and true north can therefore reach about ±3°. Part of the 6° max error may be this convergence rather than yaw. This is a hypothesis. Also check whether the EO X/Y are State Plane feet or lat/lon. If the "look north" button needs true north, apply a convergence correction.

This derived heading is what the "look north" button and the frame-adjacency logic should query.

Planned indexes: a GiST spatial index on the footprint geometry, and an index on `(FL, shot number)` for next/previous-along-line lookups.

## Database

**Decision: PostGIS.** Run it locally or in a container for development, then migrate to RDS later.

- Use the `geometry` type with GiST spatial indexes and `LAG`/`LEAD` window functions. Load straight from the GeoPackages with GDAL `ogr2ogr` (PostgreSQL driver).
- SQL Server was considered and drafted (native `geometry`, `ogr2ogr` MSSQLSpatial driver), then dropped in favor of PostGIS. The user runs SQL Server elsewhere, but this project doesn't depend on it.

## Status

- Nothing is built yet. No schema, no loader, no app code.
- The earlier session drafted T-SQL files (`schema.sql`, `finalize.sql`, `docker-compose.yml`, `load.sh`, and a README) for SQL Server. **They are not in this repo and are now superseded.** They were never run against a real SQL Server. At most they are a reference for the schema shape and the heading view, which needs a fresh PostGIS version.
- Lessons from that draft worth keeping:
  - check that `ogr2ogr` preserves the vendor's column names and casing. PostgreSQL lowercases unquoted identifiers, so expect to handle this.
  - a load script should support both truncate-and-reload and append, for multi-season loads
  - tighten any spatial extent assumptions once real data is loaded

## Open items

- The JSON sidecar (`Bwd_2025_401340.json`) has not been examined. Get its field list or contents first.
- Rendering approach is undecided. Tile serving via titiler was floated.
- Frame-transition UX is undecided.
- Local data is in `geopackages/` (gitignored, about 3.6 GB), with `flight-information` and `flight-orientation` subfolders. Schemas not yet inspected.
- The repo's final name is undecided.
- License: MIT, chosen by the author (a personal project for now, so the author sets the terms). If this later becomes agency work, check ownership before relicensing or accepting outside contributions. The imagery and metadata are NV5/KyFromAbove data and are not covered by this license.
