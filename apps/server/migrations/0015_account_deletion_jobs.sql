-- Persistent account-deletion job (design 13.1/13.3, SA-07 slice). One row per accepted deletion
-- request: the durable record that a subject asked to be deleted, how far the two independent
-- cleanup dimensions have come, and the digest of the restricted receipt that reads only this job's
-- progress. Additive only: no HTTP surface, no seed data, no change to existing rows or tables, and
-- no edit to the already-applied 0001..0014 files, so their recorded checksums stay byte-identical.
-- The table is created while the migrator runs as siyue_owner, so it inherits the schema default
-- privileges (SELECT, INSERT, UPDATE, DELETE to siyue_app) declared in
-- provision/independent-database.sql; no extra GRANT is issued here and nothing grants TRUNCATE.
--
-- Deliberately absent from this table: any email, display name, provider credential or receipt
-- secret plaintext (design 13.3 keeps only a digest), and any anti-revival ledger. The ledger that
-- stops a restored backup from resurrecting a deleted account must be stored independently of the
-- restorable main database (design 13.4), so it is not a table in this schema and is not created
-- here; this migration only persists the job and its two cleanup dimensions.
CREATE TABLE siyue.account_deletion_jobs (
  id uuid PRIMARY KEY,
  -- The subject that requested deletion. Unique, so one account has at most one deletion job and a
  -- repeated insert is rejected instead of opening a second, concurrent deletion.
  subject_id uuid NOT NULL UNIQUE REFERENCES siyue.subjects(id),
  -- Cleanup state, not a claim that data is gone: `completed` is only reachable when the row below
  -- proves both dimensions finished.
  state text NOT NULL DEFAULT 'accepted' CHECK (state IN ('accepted','processing','needs_attention','completed')),
  requested_at timestamptz NOT NULL,
  -- `local_data_deleted` is design 13.3's internal name for data controlled by Siyue's server;
  -- it never claims that a phone, tablet or offline copy was erased. Provider revocation is separate.
  local_data_deleted boolean NOT NULL DEFAULT false,
  provider_revocation_pending boolean NOT NULL DEFAULT false,
  -- SHA-256 digest of the high-entropy restricted receipt secret: plaintext is returned exactly
  -- once and can never be read back from here. Unique, so one receipt identifies one job.
  receipt_secret_hash text NOT NULL UNIQUE CHECK (receipt_secret_hash ~ '^[0-9a-f]{64}$'),
  -- Receipt expires after the request; the service applies a bounded lifetime. An expired receipt
  -- stops reading this job's progress and grants nothing else (design 13.3).
  receipt_expires_at timestamptz NOT NULL CHECK (receipt_expires_at > requested_at),
  completed_at timestamptz,
  -- Bounded lowercase snake_case code the client may show, never a message, stack or server secret.
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- A job is only stamped complete when the local data is gone and nothing is still waiting on an
  -- external revocation: a half-finished job can never present itself as "all done".
  CHECK (completed_at IS NULL OR (local_data_deleted AND NOT provider_revocation_pending)),
  CHECK ((state = 'completed') = (completed_at IS NOT NULL)),
  CHECK (completed_at IS NULL OR completed_at >= requested_at)
);
-- Expired-receipt sweeps stay bounded without scanning the whole job table.
CREATE INDEX account_deletion_jobs_receipt_expires_at ON siyue.account_deletion_jobs(receipt_expires_at);
