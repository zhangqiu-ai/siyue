-- Family foundation for the account/family spaces slice: the minimum tables the trusted family
-- repository needs. Additive only: no HTTP surface, no seed data and no change to existing rows.
-- Tables are created while the migrator runs as siyue_owner, so they inherit the schema default
-- privileges (SELECT, INSERT, UPDATE, DELETE to siyue_app) declared in
-- provision/independent-database.sql; no extra GRANT is issued here.
CREATE TABLE siyue.families (
  id uuid PRIMARY KEY,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','dissolved')),
  owner_subject_id uuid NOT NULL REFERENCES siyue.subjects(id),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE siyue.family_memberships (
  family_id uuid NOT NULL REFERENCES siyue.families(id),
  subject_id uuid NOT NULL REFERENCES siyue.subjects(id),
  role text NOT NULL CHECK (role IN ('owner','admin','member')),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (family_id, subject_id)
);
CREATE INDEX family_memberships_subject ON siyue.family_memberships(subject_id);
-- One active owner per family, not one family per adult: an adult may own several families, while a
-- family never reports two active owners. A transfer demotes the current owner before promoting the
-- next one in the same transaction, which is the order this index requires.
CREATE UNIQUE INDEX family_memberships_active_owner ON siyue.family_memberships(family_id) WHERE role = 'owner' AND active;
-- Idempotency record for the empty-body create. The key is caller-computed and scoped to one subject,
-- so replaying a key returns the family that key created and never another subject's family.
CREATE TABLE siyue.family_create_requests (
  subject_id uuid NOT NULL REFERENCES siyue.subjects(id),
  key_hash text NOT NULL CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  family_id uuid NOT NULL REFERENCES siyue.families(id),
  PRIMARY KEY (subject_id, key_hash)
);
