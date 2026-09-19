#!/usr/bin/env bash
# Normalize the vendor GeoPackages into Parquet with DuckDB.
#
#   pipeline/normalize.sh
#
# Reads    $GPKG_DIR/flight-information/KY_KYAPED_<season>_3IN_{ImageFrames,ImageFrameEO}.gpkg
# Writes   $OUT_DIR/frames.parquet             one row per unique frame (Filename)
#          $OUT_DIR/frames_duplicates.parquet  the extra copies of duplicated frames
#
# Environment:
#   GPKG_DIR  default <repo>/geopackages
#   OUT_DIR   default <repo>/data   (gitignored)
#
# The snap build of duckdb can only read and write under $HOME. Keep both directories there.
#
# Deliberately not read: flight-orientation/*EO.gpkg. Its Kappa is wrong on about 31% of
# exposures (see CLAUDE.md, "Two EO folders").
#
# The source is loaded with a single thread. Frames and EO rows are paired by row order, which
# equals the GeoPackage fid, and the SQL asserts that every pair has matching IDs.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GPKG_DIR="${GPKG_DIR:-$REPO/geopackages}"
OUT_DIR="${OUT_DIR:-$REPO/data}"
INFO_DIR="$GPKG_DIR/flight-information"

command -v duckdb >/dev/null || { echo "duckdb not found on PATH" >&2; exit 1; }
[ -d "$INFO_DIR" ] || { echo "missing $INFO_DIR (set GPKG_DIR)" >&2; exit 1; }
mkdir -p "$OUT_DIR"

seasons=()
for f in "$INFO_DIR"/KY_KYAPED_*_3IN_ImageFrames.gpkg; do
  [ -e "$f" ] || { echo "no ImageFrames GeoPackages in $INFO_DIR" >&2; exit 1; }
  s="$(basename "$f")"; s="${s#KY_KYAPED_}"; s="${s%_3IN_ImageFrames.gpkg}"
  [ -e "$INFO_DIR/KY_KYAPED_${s}_3IN_ImageFrameEO.gpkg" ] || { echo "missing EO file for $s" >&2; exit 1; }
  seasons+=("$s")
done
echo "seasons: ${seasons[*]}" >&2

stage() {
  echo "INSTALL spatial; INSTALL sqlite; LOAD spatial; LOAD sqlite;"
  echo "SET threads=1;"

  local i=0
  for s in "${seasons[@]}"; do
    echo "ATTACH '$INFO_DIR/KY_KYAPED_${s}_3IN_ImageFrameEO.gpkg' AS eo$i (TYPE sqlite, READ_ONLY);"
    i=$((i + 1))
  done

  echo "CREATE TABLE raw_frames AS"
  i=0
  for s in "${seasons[@]}"; do
    [ $i -eq 0 ] || echo "UNION ALL"
    echo "SELECT '$s' AS season_key, row_number() OVER () AS rn, Filename, FlightDate, FlightTime, TimeZone,"
    echo "       FL, ShotID, CameraID, Year, Season, S3URL, geom::BLOB AS footprint_wkb"
    echo "FROM ST_Read('$INFO_DIR/KY_KYAPED_${s}_3IN_ImageFrames.gpkg', keep_wkb=true)"
    i=$((i + 1))
  done
  echo ";"

  echo "CREATE TABLE raw_eo AS"
  i=0
  for s in "${seasons[@]}"; do
    [ $i -eq 0 ] || echo "UNION ALL"
    echo "SELECT '$s' AS season_key, fid, ID, X, Y, Z, Omega, Phi, Kappa, FlightDate AS eo_date, FlightTime AS eo_time,"
    echo "       CamName, CamWidthPx, CamHeighPx, CamFocalMm, CamCCDResU, CamPpxMm, CamPpyMm,"
    echo "       CamOmegaDg, CamPhiDg, CamKappaDg"
    echo "FROM eo$i.KY_KYAPED_${s}_3IN_ImageFrameEO"
    i=$((i + 1))
  done
  echo ";"

  echo "RESET threads;"
}

{ stage; sed "s|@OUT_DIR@|$OUT_DIR|g" "$REPO/pipeline/normalize.sql"; } | duckdb -bail
