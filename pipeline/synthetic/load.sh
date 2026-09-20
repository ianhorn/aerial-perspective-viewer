#!/usr/bin/env bash
# Load the small invented dataset (pipeline/synthetic/generate.ts) into a PostGIS database, then build the same
# indexes, query functions and read-only role as the real load, and run the SQL checks. It exists so the API's tests
# and checks.sql can run in CI, where the vendor's data (several GB, never committed) is not available.
#
#   PGHOST=... PGPORT=... PGUSER=... PGPASSWORD=... PGDATABASE=... pipeline/synthetic/load.sh
#
# THIS REPLACES the frames and frames_duplicates tables (schema.sql drops them). So it refuses to run against a
# database that already holds a real load: if `frames` has more than MAX_EXISTING_ROWS rows (the synthetic set has
# about 3,000), it stops before touching anything. Point it at an empty or scratch database only.
#
# Environment:
#   PSQL               the psql command, default `psql` (which reads the usual PG* variables). To use a container:
#                      PSQL="docker exec -i some-container psql -U oblique -d oblique_test"
#   VIEWER_PASSWORD    the API's read-only role password, default viewer_ro
#   MAX_EXISTING_ROWS  the guard, default 50000
#
# The database user must be able to create the postgis extension and roles (the container's superuser, in CI).

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SQL_DIR="$REPO/pipeline/postgis"
PSQL="${PSQL:-psql}"
MAX_EXISTING_ROWS="${MAX_EXISTING_ROWS:-50000}"
VIEWER_PASSWORD="${VIEWER_PASSWORD:-viewer_ro}"

# $PSQL is split into words on purpose, so it can be a command with arguments.
# shellcheck disable=SC2086
psql_() { $PSQL -v ON_ERROR_STOP=1 -q "$@"; }

# The guard comes first, before anything that drops a table.
# (two steps: Postgres resolves table names when it parses a query, so counting a table that does not exist fails)
existing=0
if [ -n "$(psql_ -At -c "SELECT to_regclass('public.frames')")" ]; then
  existing="$(psql_ -At -c "SELECT count(*) FROM public.frames")"
fi
if [ "$existing" -gt "$MAX_EXISTING_ROWS" ]; then
  echo "refusing to load: this database already has $existing rows in frames (limit $MAX_EXISTING_ROWS)." >&2
  echo "This script replaces the table with a tiny invented dataset. Use an empty or scratch database." >&2
  exit 1
fi

echo "creating tables..." >&2
psql_ -f - < "$SQL_DIR/schema.sql"

echo "generating and loading the synthetic frames..." >&2
node "$REPO/pipeline/synthetic/generate.ts" | psql_ -f -

echo "building indexes, functions and the read-only role..." >&2
psql_ -f - < "$SQL_DIR/indexes.sql"
psql_ -f - < "$SQL_DIR/functions.sql"
psql_ -v "viewer_password=$VIEWER_PASSWORD" -f - < "$SQL_DIR/roles.sql"

echo "running the query layer checks..." >&2
psql_ -f - < "$SQL_DIR/checks.sql"

echo "checking the data..." >&2
psql_ -At <<'EOF' | {
SET client_min_messages = warning;  -- ST_IsValid prints a notice per invalid footprint
SELECT count(*),
       count(*) FILTER (WHERE ST_SRID(geom) = 3089),
       count(*) FILTER (WHERE NOT ST_IsValid(geom) OR ST_IsEmpty(geom)),
       count(*) FILTER (WHERE camera = 'Color'),
       (SELECT count(*) FROM frames_duplicates)
FROM frames;
EOF
  IFS='|' read -r total srid bad color dups
  echo "loaded $total frames ($color Color), $dups duplicate copies; $srid in EPSG:3089, $bad invalid or empty footprints" >&2
  [ "$total" -gt 0 ] && [ "$srid" = "$total" ] && [ "$bad" = "0" ] && [ "$color" -ge 501 ] || {
    echo "the synthetic data is not what the tests expect" >&2
    exit 1
  }
}
