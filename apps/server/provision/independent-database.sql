\set ON_ERROR_STOP on
-- Explicit one-time provisioning only. Never run from API startup.
-- Environment variables are read by psql, not passed as shell arguments.
\getenv database SIYUE_PROVISION_DATABASE
\getenv environment SIYUE_ENVIRONMENT
\getenv app_password SIYUE_PROVISION_APP_PASSWORD
\getenv migrator_password SIYUE_PROVISION_MIGRATOR_PASSWORD
SELECT :'database' ~ '^siyue(_[a-z0-9_]+)?$'
  AND :'environment' IN ('development','test','staging','production')
  AND length(:'app_password') >= 32 AND length(:'migrator_password') >= 32
  AND :'app_password' <> :'migrator_password' AS valid \gset
\if :valid
\else
  \quit 1
\endif
-- Fail if roles/database already exist; do not replace credentials or ownership.
CREATE ROLE siyue_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE siyue_migrator LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'migrator_password';
CREATE ROLE siyue_app LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'app_password';
GRANT siyue_owner TO siyue_migrator WITH INHERIT FALSE;
CREATE DATABASE :"database" OWNER siyue_owner;
REVOKE ALL ON DATABASE :"database" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"database" TO siyue_app, siyue_migrator;
\connect :database
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SET ROLE siyue_owner;
CREATE SCHEMA siyue AUTHORIZATION siyue_owner;
GRANT USAGE ON SCHEMA siyue TO siyue_app, siyue_migrator;
ALTER DEFAULT PRIVILEGES IN SCHEMA siyue GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO siyue_app;
CREATE TABLE siyue.server_metadata (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  environment text NOT NULL CHECK (environment IN ('development','test','staging','production'))
);
INSERT INTO siyue.server_metadata(environment) VALUES (:'environment');
REVOKE ALL ON siyue.server_metadata FROM siyue_app;
GRANT SELECT ON siyue.server_metadata TO siyue_app, siyue_migrator;
RESET ROLE;
