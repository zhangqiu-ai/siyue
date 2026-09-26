-- Persistent Apple revocation outbox (design 13.3, SA-07 slice; Apple TN3194 "Handling account
-- deletions and revoking tokens for Sign in with Apple" requires the app to call the revoke endpoint
-- with the refresh token it obtained at sign-in). One row per Apple identity whose credential still
-- has to be revoked: the durable answer to "was Apple actually told?" that a deletion job's
-- provider_revocation_pending dimension reads. Additive only: one new table, no seed data, no change
-- to existing rows or tables, and no edit to the already-applied 0001..0015 files, so their recorded
-- checksums stay byte-identical. The table is created while the migrator runs as siyue_owner, so it
-- inherits the schema default privileges (SELECT, INSERT, UPDATE, DELETE to siyue_app) declared in
-- provision/independent-database.sql; no extra GRANT is issued here and nothing grants TRUNCATE.
--
-- Why its own table instead of a third `kind` in siyue.outbox_jobs: that table's CHECK admits only
-- the two mail kinds, its payload is a rendered message, and ordinary account flows cancel its rows
-- (modules/auth/email.ts, modules/auth/identity-unlink.ts). A revocation row is written inside the
-- deletion/unlink transaction and drained by its own worker, so it keeps its own queue, lease and
-- retention and can never be cancelled by cleanup meant for mail.
--
-- Deliberately absent from this table: any plaintext provider token (only the ciphertext the identity
-- store already sealed), any email, display name or provider subject, and any anti-revival ledger --
-- design 13.4 keeps that outside the restorable main database. Nothing here opens an HTTP route,
-- calls Apple, or deletes account data.

CREATE TABLE siyue.apple_revocation_outbox (
  id uuid PRIMARY KEY,
  -- The Apple identity whose provider token must be revoked. Unique, so one identity has at most one
  -- queued revocation and a repeated enqueue inside another transaction is a no-op instead of a
  -- second, concurrent attempt. The reference is deliberately not ON DELETE CASCADE: a revocation
  -- that is still queued must not be removed as a side effect of deleting the identity row it names,
  -- so that delete is refused instead (fail closed).
  identity_id uuid NOT NULL UNIQUE REFERENCES siyue.external_identities(id),
  -- Copied from the identity row at enqueue time. Revocation opens the seal under this identity id and
  -- namespace, so the pair stored here is what the AAD is derived from -- never re-derived later.
  provider_namespace text NOT NULL CHECK (length(provider_namespace) BETWEEN 1 AND 255),
  -- Exactly the credential the identity store sealed, never a plaintext token and never a second
  -- seal. NULL means the queue retains no credential material at all, which is required once the
  -- credential has no further use: a revoked or already-expired job.
  refresh_ciphertext text CHECK (refresh_ciphertext IS NULL OR length(refresh_ciphertext) BETWEEN 1 AND 32768),
  -- `pending` is claimable, `sending` holds a live or abandoned attempt lease, and the last three are
  -- terminal: `revoked` is the only one that means Apple confirmed, `needs_attention` and `expired`
  -- are deliberately not named success so a deletion stays provider_revocation_pending.
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','revoked','needs_attention','expired')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- Earliest instant this job may be attempted; a retry moves it forward, so it is also the claim
  -- ordering key. A terminal row keeps the instant it was settled, which drives nothing further.
  available_at timestamptz NOT NULL,
  -- End of the bounded revocation window. A claimable row is always still inside its window; a job
  -- claimed after the window closed is settled `expired` without any provider call, which is why a
  -- terminal row may carry a settlement instant before or after this bound.
  expires_at timestamptz NOT NULL,
  -- Attempt ownership. Set while an attempt is in flight and replaced when an abandoned lease is
  -- re-claimed, so the previous owner's settle matches no row and can only ever be a no-op.
  lease_id uuid,
  lease_until timestamptz,
  -- Bounded lowercase snake_case code in the same client-visible shape account_deletion_jobs uses:
  -- 'apple_*' is what the provider refused or failed to answer, and queue-local codes
  -- (revocation_window_expired, revocation_not_attempted, credential_unreadable) are the outbox's own
  -- bounded decision. Never a message, stack or provider text.
  last_error_code text CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- When the job reached a terminal state. Non-terminal jobs never carry one.
  settled_at timestamptz,
  -- Bounded retention of a terminal row; the store writes at least the end of the revocation window
  -- and at least the settlement plus its retention, so an unfinished `needs_attention` seal is never
  -- dropped while the outbox may still revoke it and no terminal row stays in the main database
  -- forever. NULL for every non-terminal job.
  retain_until timestamptz,
  -- The window is a real interval, and a job that may still be attempted is always inside it.
  CHECK (expires_at > created_at),
  CHECK (status IN ('revoked','needs_attention','expired') OR available_at < expires_at),
  -- Credential material exists exactly while the queue could still have to send it.
  CHECK ((status IN ('revoked','expired')) = (refresh_ciphertext IS NULL)),
  -- An attempt in flight always owns a lease, and only an attempt in flight does.
  CHECK ((status = 'sending') = (lease_id IS NOT NULL)),
  CHECK ((lease_id IS NULL) = (lease_until IS NULL)),
  -- Terminal states are exactly the settled and retained ones.
  CHECK ((status IN ('revoked','needs_attention','expired')) = (settled_at IS NOT NULL)),
  CHECK ((status IN ('revoked','needs_attention','expired')) = (retain_until IS NOT NULL)),
  CHECK (retain_until IS NULL OR retain_until > settled_at),
  -- A confirmed revocation has no error to report, while the two terminal states that are not success
  -- must carry the bounded code an operator or the deletion status can read.
  CHECK (status <> 'revoked' OR last_error_code IS NULL),
  CHECK (status NOT IN ('needs_attention','expired') OR last_error_code IS NOT NULL)
);
-- The claim scan stays bounded: the pending queue ordered by availability, and the abandoned leases a
-- re-claim takes over.
CREATE INDEX apple_revocation_outbox_claimable ON siyue.apple_revocation_outbox(available_at,id) WHERE status='pending';
CREATE INDEX apple_revocation_outbox_abandoned ON siyue.apple_revocation_outbox(lease_until,id) WHERE status='sending';
-- Retention sweeps delete only terminal rows that reached their bound.
CREATE INDEX apple_revocation_outbox_retain_until ON siyue.apple_revocation_outbox(retain_until) WHERE retain_until IS NOT NULL;
