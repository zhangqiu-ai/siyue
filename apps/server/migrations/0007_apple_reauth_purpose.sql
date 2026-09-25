-- Apple reauth (link-identity) purpose for the existing login flow table.
-- Additive only: existing login rows keep the default purpose and never bind a session.
ALTER TABLE siyue.apple_login_flows
  ADD COLUMN purpose text NOT NULL DEFAULT 'login',
  ADD COLUMN action text,
  ADD COLUMN session_id uuid REFERENCES siyue.auth_sessions(id);
ALTER TABLE siyue.apple_login_flows ADD CONSTRAINT apple_login_flow_purpose
  CHECK (purpose IN ('login','reauth'));
ALTER TABLE siyue.apple_login_flows ADD CONSTRAINT apple_login_flow_action
  CHECK (action IS NULL OR action IN ('link-identity'));
-- A login flow must not carry a session/action binding; a reauth flow must bind both the
-- purpose-scoped action and the initiating session that will own the issued grant.
ALTER TABLE siyue.apple_login_flows ADD CONSTRAINT apple_login_flow_reauth_binding
  CHECK (
    (purpose='login' AND action IS NULL AND session_id IS NULL)
    OR (purpose='reauth' AND action IS NOT NULL AND action='link-identity' AND session_id IS NOT NULL)
  );
