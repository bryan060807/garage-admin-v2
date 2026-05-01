-- TrackMaster least-privilege runtime role plan.
-- Review only. Do not apply without explicit approval.
-- Current runtime still uses role aibry against trackmaster_production.
--
-- Scope derived from TrackMaster API Postgres repositories:
-- - users: INSERT, SELECT
-- - sessions: INSERT, SELECT, UPDATE, DELETE
-- - presets: SELECT, INSERT, UPDATE, DELETE
-- - tracks: SELECT, INSERT, DELETE
--
-- Current schema uses UUID/text primary keys and no sequences, so sequence
-- grants are not required today. Keep the optional default-privilege block
-- commented unless a future migration introduces identity/serial sequences.

BEGIN;

-- Create the dedicated runtime role with a password supplied out of band.
-- CREATE ROLE trackmaster_app LOGIN PASSWORD '<set-out-of-band>';

GRANT CONNECT ON DATABASE trackmaster_production TO trackmaster_app;
GRANT USAGE ON SCHEMA public TO trackmaster_app;

GRANT SELECT, INSERT ON TABLE public.users TO trackmaster_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sessions TO trackmaster_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.presets TO trackmaster_app;
GRANT SELECT, INSERT, DELETE ON TABLE public.tracks TO trackmaster_app;

-- Optional future-proofing only. Leave commented until migrations justify it.
-- ALTER DEFAULT PRIVILEGES FOR ROLE aibry IN SCHEMA public
--   GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO trackmaster_app;
-- ALTER DEFAULT PRIVILEGES FOR ROLE aibry IN SCHEMA public
--   GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO trackmaster_app;

COMMIT;
