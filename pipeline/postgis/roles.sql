-- Read-only role for the API. Runs after every load, because schema.sql drops and recreates the
-- tables and that discards their grants. Safe to rerun.
--
-- The password comes from the psql variable viewer_password (load_postgis.sh passes it from the
-- VIEWER_PASSWORD environment variable). It defaults to the development password viewer_ro, like
-- oblique / oblique in docker-compose.yml. Use a real secret anywhere the database is reachable
-- beyond this machine.

\if :{?viewer_password}
\else
\set viewer_password viewer_ro
\endif

SELECT format('CREATE ROLE viewer_ro LOGIN PASSWORD %L', :'viewer_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'viewer_ro') \gexec
SELECT format('ALTER ROLE viewer_ro PASSWORD %L', :'viewer_password') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO viewer_ro', current_database()) \gexec

GRANT USAGE ON SCHEMA public TO viewer_ro;
GRANT SELECT ON frames, frames_duplicates TO viewer_ro;

-- Belt and braces: even a granted write would be refused, and no query runs longer than 5 s.
ALTER ROLE viewer_ro SET default_transaction_read_only = on;
ALTER ROLE viewer_ro SET statement_timeout = '5s';
