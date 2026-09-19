# CLAUDE.md

Project context for Claude Code. Carried over from an earlier Claude Desktop session, so items marked **unverified** were not checked against a live system.

## What this is

A viewer for KYAPED (Kentucky) oblique aerial imagery, replacing the vendor's viewer. Imagery is served from S3 as COGs; frame metadata comes from the vendor's GeoPackages.

The repo's README title is `aerial-perspective-viewer` and the directory is `oblique-viewer`. The name is not settled.

## Repo hygiene

- Imagery, COGs, GeoPackages, and DB dumps must never be committed. The data lives on `D:\Data` on Windows, which is `/mnt/d/Data` from WSL. `.gitignore` excludes these. Don't `git add -A` blindly. Check `git status` first.
- Dev environment is WSL2 Ubuntu on Windows. ArcGIS Pro stays on the Windows side.

## Camera rig and data model

Five cameras per exposure: Color (nadir), Fwd, Bwd, Left, Right. A shot is identified by `ShotID`, and flights by `FL` (flight line). There are 16 flight lines in the sample data. They fly a racetrack pattern: 8 lines go about north and 8 about south, alternating.

Two source layers, loaded into two tables joined on shot ID:

- **`image_frames`**: footprint polygons plus `Filename`, `S3URL`, `ShotID`, `CameraID`, `FL`, flight date/time. This comes from the vendor's Frames layer.
- **`image_frame_eo`**: exterior orientation (X/Y/Z, Omega/Phi/Kappa) and camera intrinsics (`CamFocalMm`, `CamWidthPx`/`CamHeighPx`, `CamCCDResU`, and so on). Keyed on `ID`, which equals `Filename` minus the extension.

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

Checked in Python against the real EO data for all 16 flight lines: mean error about 0.3–0.9°, max about 6° (attributed to aircraft yaw wobble).

This derived heading is what the "look north" button and the frame-adjacency logic should query.

Planned indexes: a spatial index on the footprint geometry, and an index on `(FL, shot number)` for next/previous-along-line lookups.

## Database

- **Now:** SQL Server, using native `geometry`, spatial indexes, and `LAG`/`LEAD`. The user already runs it. Loading is meant to go through GDAL `ogr2ogr` (MSSQLSpatial driver) straight from the GeoPackages.
- **Fallback:** PostGIS. Everything above translates directly, and the user considered it for local dev and an eventual move to RDS. The choice is not final.

## Status

- The earlier session drafted `schema.sql`, `finalize.sql`, `docker-compose.yml`, `load.sh`, and a README. **They are not in this repo yet.** The user has to copy them over.
- That T-SQL was **never run against a real SQL Server**. It was only translated from the Python logic. Expect to fix it. Known assumptions:
  - the `ogr2ogr` MSSQLSpatial driver preserves the vendor's column names and casing (check with `SELECT TOP 5 * FROM dbo.stg_image_frames`)
  - the spatial index bounding box was a wide placeholder and needs tightening once data is loaded
  - `load.sh` did a truncate-and-reload on each run and needs an append mode for multi-season loads

## Open items

- The JSON sidecar (`Bwd_2025_401340.json`) has not been examined. Get its field list or contents first.
- Rendering approach is undecided. Tile serving via titiler was floated.
- Frame-transition UX is undecided.
- Where the EO data and GeoPackages live for local work: **unknown**.
- The repo's final name and license are undecided. Check whether this is agency work product before choosing a license. Private repo with no license is the default.
