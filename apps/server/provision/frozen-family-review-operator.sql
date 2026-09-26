\set ON_ERROR_STOP on
-- Designated review operator login for closing a frozen family review (design 13.2) -- one-time explicit
-- provisioning against an existing siyue database, never run from API startup. Values arrive through psql
-- environment variables, not shell arguments, and no value is echoed by this script.
--
-- Why a separate login at all: closing a review has no HTTP surface, and no request field may name an
-- operator. The identity is the database login the command connects as, so the review is reachable by
-- that identity and by nothing else. This script also refuses to designate the API's runtime role, which
-- the kernel refuses by name as well.
--
-- Privilege shape, which is the actual control:
--   * SELECT where the closure reads; INSERT only where it creates a row (a resolution, the recipient's
--     own consent and guardianship, one security event); UPDATE only on rows it writes or locks.
--   * No DELETE and no TRUNCATE anywhere, and no CREATE on the schema: the review path cannot delete or
--     rewrite another member's data, cannot drop a record, and cannot create objects.
--   * `siyue.subjects` is only ever locked and never written, so its grant is a single column.
--     PostgreSQL requires UPDATE privilege on a table to take a row lock (FOR SHARE and FOR UPDATE alike),
--     and `updated_at` is a column the closure neither reads nor writes. A subject's `kind`, `status`,
--     `display_name` and `credential_version` stay out of this login's reach, so the closure's own guards
--     cannot be rewritten by the login that reads them.
--   * `siyue.account_deletion_jobs` is read without a row lock, so it stays SELECT-only: deletion progress
--     cannot be forged from the review path.
--   * `siyue.family_review_resolutions` is created here, never rewritten or removed, and migration 0025
--     revokes the runtime role's INSERT/UPDATE/DELETE on it. Only a designated operator login can close a
--     review, and the row it writes is what records that the closure happened.
--
-- Environment (all required):
--   SIYUE_FROZEN_FAMILY_REVIEW_DATABASE          the existing siyue database to grant in
--   SIYUE_FROZEN_FAMILY_REVIEW_ENVIRONMENT       must match that database's own environment marker
--   SIYUE_FROZEN_FAMILY_REVIEW_OPERATOR_ROLE     exact login role name to create (never siyue_app)
--   SIYUE_FROZEN_FAMILY_REVIEW_OPERATOR_PASSWORD password for that login, at least 32 characters
\getenv database SIYUE_FROZEN_FAMILY_REVIEW_DATABASE
\getenv environment SIYUE_FROZEN_FAMILY_REVIEW_ENVIRONMENT
\getenv operator_role SIYUE_FROZEN_FAMILY_REVIEW_OPERATOR_ROLE
\getenv operator_password SIYUE_FROZEN_FAMILY_REVIEW_OPERATOR_PASSWORD
SELECT :'database' ~ '^siyue(_[a-z0-9_]+)?$'
  AND :'environment' IN ('development','test','staging','production')
  AND :'operator_role' ~ '^[a-z_][a-z0-9_]{0,62}$'
  AND :'operator_role' <> 'siyue_app'
  AND length(:'operator_password') >= 32 AS valid \gset
\if :valid
\else
  -- `\quit` takes no exit code (psql warns and exits 0), so reject the run with a real error: ON_ERROR_STOP
  -- then stops before any role or grant exists, with a non-zero status an unattended step cannot mistake
  -- for success.
  DO $$ BEGIN RAISE EXCEPTION 'frozen_family_review_provision_rejected: database, environment, operator role or password failed validation'; END $$;
\endif
-- The review records must exist (migration 0025 applied) and the database must be the environment the
-- operator will be told it is. Both are read-only checks, and a mismatch stops the run.
\connect :"database"
SELECT to_regclass('siyue.family_review_acceptances') IS NOT NULL
  AND to_regclass('siyue.family_review_resolutions') IS NOT NULL
  AND (SELECT environment FROM siyue.server_metadata WHERE singleton) = :'environment' AS ready \gset
\if :ready
\else
  DO $$ BEGIN RAISE EXCEPTION 'frozen_family_review_provision_rejected: review tables missing or the environment marker does not match'; END $$;
\endif
-- Everything from here is one transaction: the login, its grants and the self-check below commit together
-- or not at all. Creating a role and granting are transactional in PostgreSQL, and psql with ON_ERROR_STOP
-- exits non-zero on the first failure, so a self-check that finds a broader privilege leaves no role and no
-- grant behind instead of an over-granted login that has to be noticed by hand.
BEGIN;
-- Fail if the login already exists: this script never replaces a credential and never re-grants over an
-- existing login, so a partial or unexpected state is reported instead of being corrected silently.
CREATE ROLE :"operator_role" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'operator_password';
GRANT CONNECT ON DATABASE :"database" TO :"operator_role";
GRANT USAGE ON SCHEMA siyue TO :"operator_role";
-- Read-only for this login: the environment marker it checks, and the deletion job it reads without a lock.
GRANT SELECT ON siyue.server_metadata, siyue.account_deletion_jobs TO :"operator_role";
-- Read and written (or row-locked) by the closure, never inserted.
GRANT SELECT,UPDATE ON siyue.families, siyue.family_memberships, siyue.device_grants, siyue.auth_sessions,
  siyue.refresh_tokens, siyue.device_pairing_requests, siyue.family_invitations, siyue.rooms,
  siyue.room_invitations, siyue.room_seats, siyue.family_review_acceptances,
  siyue.account_deletion_family_reviews TO :"operator_role";
-- Rows the closure creates: its own resolution, the recipient's own consent and guardianship, and the
-- security event that records the closure.
GRANT SELECT,INSERT ON siyue.family_review_resolutions TO :"operator_role";
GRANT SELECT,INSERT,UPDATE ON siyue.consent_records, siyue.guardian_relationships TO :"operator_role";
GRANT INSERT ON siyue.security_events TO :"operator_role";
-- Locked for the subject state the closure validates, and never written: one column, for the row lock.
GRANT SELECT ON siyue.subjects TO :"operator_role";
GRANT UPDATE (updated_at) ON siyue.subjects TO :"operator_role";
-- Self-check. The grants above must not have produced a broader privilege than the closure uses, and the
-- row-lock privilege must be exactly the one column. A failure here aborts the run instead of leaving an
 -- over-granted login behind: the check runs inside the same transaction as the grants, so the abort rolls
 -- the role and every grant back (ON_ERROR_STOP stops psql and the open transaction is rolled back).
SELECT NOT has_table_privilege(:'operator_role','siyue.families','DELETE')
  AND NOT has_table_privilege(:'operator_role','siyue.families','TRUNCATE')
  AND NOT has_table_privilege(:'operator_role','siyue.family_review_resolutions','UPDATE')
  AND NOT has_table_privilege(:'operator_role','siyue.family_review_resolutions','DELETE')
  AND NOT has_table_privilege(:'operator_role','siyue.account_deletion_jobs','UPDATE')
  AND NOT has_table_privilege(:'operator_role','siyue.subjects','UPDATE')
  AND has_column_privilege(:'operator_role','siyue.subjects','updated_at','UPDATE')
  AND NOT has_column_privilege(:'operator_role','siyue.subjects','status','UPDATE')
  AND NOT has_column_privilege(:'operator_role','siyue.subjects','kind','UPDATE')
  AND has_table_privilege(:'operator_role','siyue.family_review_resolutions','INSERT')
  AND NOT has_schema_privilege(:'operator_role','siyue','CREATE') AS scoped \gset
\if :scoped
\else
  DO $$ BEGIN RAISE EXCEPTION 'frozen_family_review_provision_rejected: the operator login holds a privilege the closure does not use'; END $$;
\endif
COMMIT;
SELECT :'operator_role' AS provisioned_review_operator;
