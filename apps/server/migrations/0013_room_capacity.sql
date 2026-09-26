-- Family-room seat kernel for the SA-08 9.4 slice: the room object and its active device seats.
-- Additive only: no HTTP surface, no seed data, no change to existing rows or tables, and no edit to
-- the already-applied 0011/0012 files. Both tables are created while the migrator runs as siyue_owner,
-- so they inherit the schema default privileges (SELECT, INSERT, UPDATE, DELETE to siyue_app) declared
-- in provision/independent-database.sql; no extra GRANT is issued here and nothing grants TRUNCATE.
--
-- Scope is the seat-count kernel only (design 16.5, acceptance RTC-01/RTC-02): at most five sessions
-- are seated in one room, a seat belongs to the server's own auth_sessions row, and a sixth device is
-- refused instead of displacing one that is already seated. This migration deliberately models no RTC
-- credential, no invitation or membership authorization, no join right for any subject, and no
-- per-seat release or reconnect retention window: design 16.5 leaves fencing, reconnect tokens and the
-- seat reservation window to RTC validation, so they stay owner decisions instead of being guessed here.

CREATE TABLE siyue.rooms (
  id uuid PRIMARY KEY,
  -- The family the room belongs to. Recorded for later trusted-authorization wiring; this reference
  -- grants nobody a room, board or record capability by itself.
  family_id uuid NOT NULL REFERENCES siyue.families(id),
  -- The verified subject that opened the room; never a client-supplied identity.
  created_by_subject_id uuid NOT NULL REFERENCES siyue.subjects(id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','ended')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  CHECK (ended_at IS NULL OR ended_at >= created_at),
  -- Explicit end only, so "an ended room refuses new seats" is decided from durable state instead of
  -- a caller flag: an ended room always carries the instant it ended, and an open one never does.
  CHECK ((status = 'open' AND ended_at IS NULL) OR (status = 'ended' AND ended_at IS NOT NULL))
);
CREATE INDEX rooms_family ON siyue.rooms(family_id);

-- One row per claimed seat. `room_id` + `session_id` is the whole identity of a seat: no client
-- self-reported installation id is stored, so claiming the same installation from two real sessions
-- costs two seats and cannot dodge the five-seat bound.
CREATE TABLE siyue.room_seats (
  room_id uuid NOT NULL REFERENCES siyue.rooms(id),
  session_id uuid NOT NULL REFERENCES siyue.auth_sessions(id),
  -- Copied from the verified session at claim time, so an operator can see which subject held a seat
  -- without re-deriving it from a session that may be revoked later. Holding a seat is not a join
  -- right, and this row is not a credential: it authenticates nothing on its own.
  subject_id uuid NOT NULL REFERENCES siyue.subjects(id),
  -- Slots are numbered 1..5 and the check alone already refuses a sixth concurrent seat value.
  seat_index integer NOT NULL CHECK (seat_index BETWEEN 1 AND 5),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  -- Set when the room is ended; kept as history. A released seat is not reusable, because an ended
  -- room refuses every later claim.
  released_at timestamptz,
  CHECK (released_at IS NULL OR released_at >= claimed_at),
  -- At most one seat per session per room, so retrying one claim can never add a seat.
  PRIMARY KEY (room_id, session_id)
);
-- At most one live seat per slot, so at most five sessions are seated at once even if the service were
-- bypassed. Slots of released seats stay outside this index.
CREATE UNIQUE INDEX room_seats_active_slot ON siyue.room_seats(room_id, seat_index) WHERE released_at IS NULL;
-- "Which rooms is this session seated in" and revocation sweeps stay bounded.
CREATE INDEX room_seats_session ON siyue.room_seats(session_id);
