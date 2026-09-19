#!/usr/bin/env bash
# Load the normalized Parquet into the local PostGIS container.
#
#   pipeline/normalize.sh       # first, to write data/frames.parquet
#   pipeline/load_postgis.sh
#
# Starts the container from docker-compose.yml if needed, recreates the tables, loads them,
# builds the indexes, creates the query functions (functions.sql), and checks the result. It replaces the frames tables on every run.
#
# Environment (defaults match docker-compose.yml):
#   DATA_DIR           default <repo>/data
#   POSTGRES_USER      default oblique
#   POSTGRES_PASSWORD  default oblique
#   POSTGRES_DB        default oblique
#   POSTGRES_PORT      default 5433
#
# DuckDB writes into staging tables through its postgres extension. The geometry travels as WKB
# bytea and is turned into a PostGIS geometry inside the database (insert.sql).

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${DATA_DIR:-$REPO/data}"
PGUSER="${POSTGRES_USER:-oblique}"
PGPASSWORD="${POSTGRES_PASSWORD:-oblique}"
PGDATABASE="${POSTGRES_DB:-oblique}"
PGPORT="${POSTGRES_PORT:-5433}"
SQL_DIR="$REPO/pipeline/postgis"

for f in "$DATA_DIR/frames.parquet" "$DATA_DIR/frames_duplicates.parquet"; do
  [ -e "$f" ] || { echo "missing $f (run pipeline/normalize.sh first)" >&2; exit 1; }
done
command -v docker >/dev/null || { echo "docker not found on PATH" >&2; exit 1; }
command -v duckdb >/dev/null || { echo "duckdb not found on PATH" >&2; exit 1; }

compose() { docker compose -f "$REPO/docker-compose.yml" "$@"; }
psql_() { compose exec -T postgis psql -v ON_ERROR_STOP=1 -q -U "$PGUSER" -d "$PGDATABASE" "$@"; }

echo "starting postgis..." >&2
compose up -d --wait postgis >&2

echo "creating tables..." >&2
psql_ -f - < "$SQL_DIR/schema.sql"

echo "staging through duckdb..." >&2
duckdb -bail <<EOF
INSTALL postgres; LOAD postgres;
ATTACH 'dbname=$PGDATABASE user=$PGUSER password=$PGPASSWORD host=127.0.0.1 port=$PGPORT' AS pg (TYPE postgres);
CREATE TABLE pg.public.frames_stage AS
  SELECT * EXCLUDE (xmin, ymin, xmax, ymax) FROM read_parquet('$DATA_DIR/frames.parquet');
CREATE TABLE pg.public.frames_duplicates_stage AS
  SELECT * FROM read_parquet('$DATA_DIR/frames_duplicates.parquet');
EOF

echo "building geometry..." >&2
psql_ -f - < "$SQL_DIR/insert.sql"

echo "building indexes..." >&2
psql_ -f - < "$SQL_DIR/indexes.sql"

echo "creating query functions..." >&2
psql_ -f - < "$SQL_DIR/functions.sql"
psql_ -f - < "$SQL_DIR/checks.sql"

echo "checking..." >&2
expected="$(duckdb -csv -noheader -c "SELECT count(*) FROM read_parquet('$DATA_DIR/frames.parquet')")"
expected_dup="$(duckdb -csv -noheader -c "SELECT count(*) FROM read_parquet('$DATA_DIR/frames_duplicates.parquet')")"
actual="$(psql_ -Atc "SELECT count(*) FROM frames")"
actual_dup="$(psql_ -Atc "SELECT count(*) FROM frames_duplicates")"
[ "$expected" = "$actual" ] || { echo "frames: parquet has $expected rows, postgis has $actual" >&2; exit 1; }
[ "$expected_dup" = "$actual_dup" ] || { echo "frames_duplicates: parquet has $expected_dup rows, postgis has $actual_dup" >&2; exit 1; }

psql_ <<'EOF'
SET client_min_messages = warning;  -- ST_IsValid prints a notice per invalid footprint
SELECT count(*) AS frames,
       count(*) FILTER (WHERE ST_SRID(geom) = 3089)   AS srid_3089,
       count(*) FILTER (WHERE NOT ST_IsValid(geom))   AS invalid_footprints,
       count(*) FILTER (WHERE ST_IsEmpty(geom))       AS empty_footprints
FROM frames;
EOF
echo "loaded $actual frames and $actual_dup duplicate copies" >&2
