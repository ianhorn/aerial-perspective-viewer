-- Read-only role for the API. Runs after every load, because schema.sql drops and recreates the
-- tables and that discards their grants. Safe to rerun.
--
-- viewer_ro / viewer_ro is a development credential, like oblique / oblique in docker-compose.yml.
-- Use a real secret anywhere the database is reachable beyond this machine.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'viewer_ro') THEN
        CREATE ROLE viewer_ro LOGIN PASSWORD 'viewer_ro';
    END IF;
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO viewer_ro', current_database());
END $$;

GRANT USAGE ON SCHEMA public TO viewer_ro;
GRANT SELECT ON frames, frames_duplicates TO viewer_ro;

-- Belt and braces: even a granted write would be refused, and no query runs longer than 5 s.
ALTER ROLE viewer_ro SET default_transaction_read_only = on;
ALTER ROLE viewer_ro SET statement_timeout = '5s';
