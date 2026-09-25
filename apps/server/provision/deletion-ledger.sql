\set ON_ERROR_STOP on
-- Independent deletion anti-revival ledger (design 13.4) -- one-time explicit provisioning only,
-- never run from API startup. Values arrive through psql environment variables, not shell arguments.
--
-- Why its own role pair and its own database: design 13.4 requires the deletion marker to be kept
-- outside the database whose backup is restored. If the ledger lived in the main database, or used
-- its owner or the `siyue_app` runtime role, restoring an old backup would restore the ledger with
-- it and the deleted subject would come back. Nothing in this file touches the main database.
--
-- Privilege shape, which is the actual control:
--   * siyue_deletion_ledger_owner  NOLOGIN. Owns the schema, both tables and the three transition
--     functions; reachable only through SET ROLE by an operator or an explicit admin session.
--   * siyue_deletion_ledger_app    LOGIN. The runtime role. It may SELECT the ledger (a login check
--     must be able to read "may this subject sign in") and EXECUTE the three transitions. It has no
--     INSERT/UPDATE/DELETE/TRUNCATE on ledger.entries and no CREATE anywhere, so the runtime can
--     never forge, downgrade or remove the marker: `accepted` is immutable in the database, not by
--     application convention.
--   * CONNECT is revoked from PUBLIC and granted only to the app role, so the main `siyue_app` role
--     cannot reach the ledger database and this role cannot reach the main one.
--
-- Watermark and format version (design 13.4 truncation detection):
--   * `ledger.metadata.seq` is a monotonic watermark. It moves forward by exactly one inside the
--     transaction of every transition that actually changes a row, and that number is copied onto the
--     row the transition wrote. For an intact ledger the watermark therefore equals `max(seq)` over
--     `ledger.entries`. `entry_count` also equals the number of rows ever inserted, so removal of an
--     older row is visible even when the newest sequence survives. The adapter checks both values.
--     A later transition also checks both before writing, so it cannot heal a truncated ledger.
--   * The format marker is `siyue-deletion-ledger-v2`. v1 was the prototype without the watermark
--     columns. It is NOT upgraded or overwritten here: this script only ever provisions a database
--     that does not exist yet (CREATE ROLE / CREATE DATABASE fail first, and ON_ERROR_STOP aborts the
--     run before anything else happens), so an existing v1 ledger keeps every row it holds and the
--     adapter refuses to read it -- LEDGER_UNREADABLE, fail closed. Re-provisioning v1 as v2 is a
--     deliberate operator action; nothing in this repository drops or rewrites ledger data.
--   * `ledger.metadata.instance_id` is a random UUID minted when the ledger database is created and
--     never moved afterwards. It is the ledger instance identity a fence kept in the MAIN database
--     binds to, and it is what separates "the ledger I was bound to" from "a newly initialized, empty
--     ledger that carries the same format and environment and therefore has nothing to replay". The
--     adapter returns it from `highWater()`; the fence stores it next to the main database it protects.
--   * A v2 ledger that already has verified seq/entry_count but predates the identity column can
--     add the UUID without rewriting entries; the account fence must then bind it deliberately.
--     An earlier v2 prototype missing entry_count requires a stopped, reviewed backfill. A v1 ledger
--     has no historical per-transition sequence or entry count and needs a separately reviewed migration. This
--     provisioning script never changes an existing ledger.
\getenv database SIYUE_DELETION_LEDGER_DATABASE
\getenv environment SIYUE_DELETION_LEDGER_ENVIRONMENT
\getenv app_password SIYUE_DELETION_LEDGER_APP_PASSWORD
SELECT :'database' ~ '^siyue_deletion_ledger(_[a-z0-9_]+)?$'
  AND :'environment' IN ('development','test','staging','production')
  AND length(:'app_password') >= 32 AS valid \gset
\if :valid
\else
  -- `\quit` takes no exit code (psql warns and exits 0), so reject the run with a real error:
  -- ON_ERROR_STOP then makes psql stop before any role, database or table exists, with a non-zero
  -- status an unattended provisioning step cannot mistake for success.
  DO $$ BEGIN RAISE EXCEPTION 'deletion_ledger_provision_rejected: database name, environment or app password failed validation'; END $$;
\endif
-- Fail if the roles or the database already exist; never replace credentials or ownership.
CREATE ROLE siyue_deletion_ledger_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE siyue_deletion_ledger_app LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD :'app_password';
CREATE DATABASE :"database" OWNER siyue_deletion_ledger_owner;
REVOKE ALL ON DATABASE :"database" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"database" TO siyue_deletion_ledger_app;
\connect :database
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SET ROLE siyue_deletion_ledger_owner;
CREATE SCHEMA ledger AUTHORIZATION siyue_deletion_ledger_owner;
REVOKE ALL ON SCHEMA ledger FROM PUBLIC;
GRANT USAGE ON SCHEMA ledger TO siyue_deletion_ledger_app;

-- Format marker. A restore or a mis-pointed connection can reach a database that is not this ledger;
-- the adapter refuses to answer unless this value matches, so an unknown or emptied ledger can never
-- be mistaken for "nothing to replay". Only the owner (or an admin session) can change it.
CREATE TABLE ledger.metadata (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  format text NOT NULL CHECK (length(format) BETWEEN 1 AND 64),
  environment text NOT NULL CHECK (environment IN ('development','test','staging','production')),
  -- Ledger instance identity: random, minted once for this database, never moved, and readable by the
  -- runtime role so the main-database fence can bind to this exact ledger instance. The DEFAULT is what
  -- makes an additive `ADD COLUMN` on an existing metadata row safe: a row can never exist without one.
  instance_id uuid NOT NULL DEFAULT gen_random_uuid(),
  -- Monotonic watermark: the sequence number of the newest entry ever committed through a transition.
  -- It only ever moves forward, by one, in the same transaction as the row it describes.
  seq bigint NOT NULL DEFAULT 0 CHECK (seq >= 0),
  -- Number of distinct subjects ever inserted. Together with seq this detects removal of an older
  -- row even when the newest row and its sequence remain intact.
  entry_count bigint NOT NULL DEFAULT 0 CHECK (entry_count >= 0)
);
INSERT INTO ledger.metadata(singleton,format,environment) VALUES (true,'siyue-deletion-ledger-v2',:'environment');

-- The whole subject-visible record: a subject UUID, the current deletion intent UUID, the status and
-- the instants. Deliberately absent: email, display name, provider subject, device, receipt and any
-- content. The ledger answers one question -- may this subject sign in after a restore -- so it holds
-- nothing that would be worth leaking with it.
CREATE TABLE ledger.entries (
  subject_id uuid PRIMARY KEY,
  intent_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('prepared','accepted','cancelled')),
  prepared_at timestamptz NOT NULL,
  accepted_at timestamptz,
  cancelled_at timestamptz,
  -- Sequence of the transition that last wrote this row, allocated from `ledger.metadata.seq` in the
  -- same transaction as the write. UNIQUE so two rows can never claim the same position, and NOT NULL
  -- so a row that bypassed the watermark cannot exist. The newest row is the one the watermark points
  -- at; if that row disappears, the watermark no longer matches and the reads below refuse to answer.
  seq bigint NOT NULL UNIQUE CHECK (seq > 0),
  -- The instant column exists exactly for its own state; `accepted` never carries a cancel time and
  -- the reverse, so a half-rewritten row is refused instead of being read as a deletion marker.
  CHECK ((status = 'accepted') = (accepted_at IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK (accepted_at IS NULL OR accepted_at >= prepared_at),
  CHECK (cancelled_at IS NULL OR cancelled_at >= prepared_at)
);

-- Payload of one ledger row. Complete and camelCase on purpose: the adapter validates this exact
-- shape, so an extra column or a rewritten row cannot silently pass as a valid entry.
CREATE FUNCTION ledger.entry_payload(p_entry ledger.entries) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'subjectId', p_entry.subject_id,
    'intentId', p_entry.intent_id,
    'status', p_entry.status,
    'preparedAt', p_entry.prepared_at,
    'acceptedAt', p_entry.accepted_at,
    'cancelledAt', p_entry.cancelled_at)
$$;
REVOKE ALL ON FUNCTION ledger.entry_payload(ledger.entries) FROM PUBLIC;

-- advance_watermark: hands the next sequence number to a transition that is about to change a row.
-- It runs inside the caller's transaction, so the watermark and the row it is copied onto commit or
-- roll back together. Concurrent writers serialize on this single metadata row, then verify the
-- committed rows still match before allocating a sequence. It is deliberately NOT granted
-- to the runtime role: only the three transitions below may move the watermark.
CREATE FUNCTION ledger.advance_watermark() RETURNS bigint
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ledger, pg_catalog AS $$
DECLARE
  v_seq bigint;
  v_count bigint;
BEGIN
  -- Lock first, then read entries in a new statement. A writer that waited for another writer
  -- must check the rows committed by that writer before allocating the next sequence.
  SELECT seq, entry_count INTO v_seq, v_count FROM ledger.metadata WHERE singleton FOR UPDATE;
  IF v_seq IS NULL THEN
    -- No metadata row at all: this database cannot show that it is a ledger, so no transition may
    -- write a marker into it. Fail closed rather than insert a row with an unproven sequence.
    RAISE EXCEPTION 'deletion_ledger_watermark_missing' USING ERRCODE = '55000';
  END IF;
  IF v_seq IS DISTINCT FROM COALESCE((SELECT max(seq) FROM ledger.entries), 0)
    OR v_count IS DISTINCT FROM (SELECT count(*) FROM ledger.entries) THEN
    RAISE EXCEPTION 'deletion_ledger_watermark_mismatch' USING ERRCODE = '55000';
  END IF;
  UPDATE ledger.metadata SET seq = seq + 1 WHERE singleton RETURNING seq INTO v_seq;
  RETURN v_seq;
END $$;
REVOKE ALL ON FUNCTION ledger.advance_watermark() FROM PUBLIC;

-- prepare_intent: the durable "this subject asked to be deleted" record, written BEFORE the main
-- database transaction that starts the deletion. Outcomes: `prepared` (new intent, or this same
-- intent again -- `prepared_at` is never moved by a repeat), `accepted` (the subject is already
-- deleted and a later request never downgrades that), `intent_conflict` (a different intent is still
-- prepared, so two deletion attempts cannot silently overwrite each other).
-- The watermark advances exactly on the two outcomes that change a row (a new intent, or replacing a
-- cancelled one); an idempotent repeat or a conflict returns the row as it stands and moves nothing.
CREATE FUNCTION ledger.prepare_intent(p_subject_id uuid, p_intent_id uuid, p_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ledger, pg_catalog AS $$
DECLARE
  v_entry ledger.entries;
  v_seq bigint;
BEGIN
  IF p_subject_id IS NULL OR p_intent_id IS NULL OR p_at IS NULL THEN
    RAISE EXCEPTION 'deletion_ledger_invalid_request' USING ERRCODE = '22023';
  END IF;
  -- A subject with no row has nothing for SELECT FOR UPDATE to lock. Serialize its first prepare
  -- so a concurrent retry observes the committed row instead of surfacing a unique-key error.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_subject_id::text, 0));
  SELECT * INTO v_entry FROM ledger.entries WHERE subject_id = p_subject_id FOR UPDATE;
  IF NOT FOUND THEN
    v_seq := ledger.advance_watermark();
    INSERT INTO ledger.entries(subject_id, intent_id, status, prepared_at, seq)
      VALUES (p_subject_id, p_intent_id, 'prepared', p_at, v_seq) RETURNING * INTO v_entry;
    UPDATE ledger.metadata SET entry_count = entry_count + 1 WHERE singleton;
    RETURN jsonb_build_object('outcome','prepared','entry',ledger.entry_payload(v_entry));
  END IF;
  IF v_entry.status = 'accepted' THEN
    RETURN jsonb_build_object('outcome','accepted','entry',ledger.entry_payload(v_entry));
  END IF;
  IF v_entry.status = 'prepared' THEN
    RETURN jsonb_build_object('outcome',
      CASE WHEN v_entry.intent_id = p_intent_id THEN 'prepared' ELSE 'intent_conflict' END,
      'entry', ledger.entry_payload(v_entry));
  END IF;
  -- Only a cancelled intent may be replaced: the subject withdrew the earlier request, and a
  -- cancelled row is not a deletion marker for anyone.
  v_seq := ledger.advance_watermark();
  UPDATE ledger.entries SET intent_id = p_intent_id, status = 'prepared', prepared_at = p_at,
    accepted_at = NULL, cancelled_at = NULL, seq = v_seq
    WHERE subject_id = p_subject_id RETURNING * INTO v_entry;
  RETURN jsonb_build_object('outcome','prepared','entry',ledger.entry_payload(v_entry));
END $$;
REVOKE ALL ON FUNCTION ledger.prepare_intent(uuid, uuid, timestamptz) FROM PUBLIC;

-- mark_accepted: written only AFTER the main database transaction that accepted the deletion
-- committed. `accepted` is terminal here: no outcome of any function in this file returns an accepted
-- row to `prepared` or `cancelled`, so a restored backup can never clear the marker that blocks the
-- subject. A repeat with the same intent is a no-op, which makes the retry after an uncertain result
-- safe; a different intent is reported as `intent_conflict` instead of applying a stale acceptance.
-- The watermark advances only on the acceptance that actually happens: a retry that finds the row
-- already accepted returns it unchanged.
CREATE FUNCTION ledger.mark_accepted(p_subject_id uuid, p_intent_id uuid, p_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ledger, pg_catalog AS $$
DECLARE
  v_entry ledger.entries;
  v_seq bigint;
BEGIN
  IF p_subject_id IS NULL OR p_intent_id IS NULL OR p_at IS NULL THEN
    RAISE EXCEPTION 'deletion_ledger_invalid_request' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_entry FROM ledger.entries WHERE subject_id = p_subject_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome','not_prepared','entry',NULL);
  END IF;
  IF v_entry.status = 'accepted' THEN
    RETURN jsonb_build_object('outcome',
      CASE WHEN v_entry.intent_id = p_intent_id THEN 'accepted' ELSE 'intent_conflict' END,
      'entry', ledger.entry_payload(v_entry));
  END IF;
  IF v_entry.status <> 'prepared' THEN
    RETURN jsonb_build_object('outcome','not_prepared','entry',ledger.entry_payload(v_entry));
  END IF;
  IF v_entry.intent_id <> p_intent_id THEN
    RETURN jsonb_build_object('outcome','intent_conflict','entry',ledger.entry_payload(v_entry));
  END IF;
  IF p_at < v_entry.prepared_at THEN
    RAISE EXCEPTION 'deletion_ledger_invalid_time' USING ERRCODE = '22007';
  END IF;
  v_seq := ledger.advance_watermark();
  UPDATE ledger.entries SET status = 'accepted', accepted_at = p_at, seq = v_seq
    WHERE subject_id = p_subject_id RETURNING * INTO v_entry;
  RETURN jsonb_build_object('outcome','accepted','entry',ledger.entry_payload(v_entry));
END $$;
REVOKE ALL ON FUNCTION ledger.mark_accepted(uuid, uuid, timestamptz) FROM PUBLIC;

-- cancel_intent: the compensation for a main-database transaction that DEFINITELY rolled back, and
-- the subject withdrawing a request before it was accepted. It refuses an accepted row outright
-- (`accepted_immutable`), which is the invariant that stops application code -- or a restored backup
-- plus a well-meaning cleanup -- from un-blocking a deleted subject.
-- The watermark advances only on the cancellation that actually happens.
CREATE FUNCTION ledger.cancel_intent(p_subject_id uuid, p_intent_id uuid, p_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ledger, pg_catalog AS $$
DECLARE
  v_entry ledger.entries;
  v_seq bigint;
BEGIN
  IF p_subject_id IS NULL OR p_intent_id IS NULL OR p_at IS NULL THEN
    RAISE EXCEPTION 'deletion_ledger_invalid_request' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_entry FROM ledger.entries WHERE subject_id = p_subject_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome','not_prepared','entry',NULL);
  END IF;
  IF v_entry.status = 'accepted' THEN
    RETURN jsonb_build_object('outcome','accepted_immutable','entry',ledger.entry_payload(v_entry));
  END IF;
  IF v_entry.intent_id <> p_intent_id THEN
    RETURN jsonb_build_object('outcome','intent_conflict','entry',ledger.entry_payload(v_entry));
  END IF;
  IF v_entry.status = 'cancelled' THEN
    RETURN jsonb_build_object('outcome','cancelled','entry',ledger.entry_payload(v_entry));
  END IF;
  IF p_at < v_entry.prepared_at THEN
    RAISE EXCEPTION 'deletion_ledger_invalid_time' USING ERRCODE = '22007';
  END IF;
  v_seq := ledger.advance_watermark();
  UPDATE ledger.entries SET status = 'cancelled', cancelled_at = p_at, seq = v_seq
    WHERE subject_id = p_subject_id RETURNING * INTO v_entry;
  RETURN jsonb_build_object('outcome','cancelled','entry',ledger.entry_payload(v_entry));
END $$;
REVOKE ALL ON FUNCTION ledger.cancel_intent(uuid, uuid, timestamptz) FROM PUBLIC;

-- The runtime may read the ledger and call exactly these three transitions. No INSERT/UPDATE/DELETE
-- (let alone TRUNCATE) on ledger.entries, no DDL: an `accepted` marker cannot be forged, downgraded,
-- or deleted by the role the service runs as.
-- `ledger.advance_watermark()` is not granted either, so the runtime cannot move the watermark on its
-- own; only the three transitions above can, and only as part of a change they actually commit.
GRANT SELECT ON ledger.metadata, ledger.entries TO siyue_deletion_ledger_app;
GRANT EXECUTE ON FUNCTION ledger.prepare_intent(uuid, uuid, timestamptz),
  ledger.mark_accepted(uuid, uuid, timestamptz), ledger.cancel_intent(uuid, uuid, timestamptz)
  TO siyue_deletion_ledger_app;
RESET ROLE;
