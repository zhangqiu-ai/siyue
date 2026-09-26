-- Main-database record of which independent deletion-ledger state was applied before login was
-- opened (design 13.4). This row is deliberately in the restorable database: restoring an older
-- backup moves its sequence backwards while the independent ledger stays ahead. It contains only
-- ledger identity and sequence, never a subject, email, receipt, credential or user content.
--
-- No row is seeded by migration. A missing row means recovery has not been proved and must fail
-- closed until the runtime explicitly replays and records one. Existing main-database rows are not
-- rewritten; prior migrations and their checksums remain unchanged.
CREATE TABLE siyue.deletion_ledger_fence (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  ledger_instance_id uuid NOT NULL,
  ledger_format text NOT NULL CHECK (length(ledger_format) BETWEEN 1 AND 64),
  applied_sequence bigint NOT NULL CHECK (applied_sequence >= 0),
  applied_at timestamptz NOT NULL
);
