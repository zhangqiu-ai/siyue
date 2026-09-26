-- Widen the Apple reauth action whitelist from link-identity to the actions an Apple-only
-- account can prove without a password. Additive only: existing login rows and existing
-- link-identity reauth rows keep their meaning, and a reauth flow still binds the action and
-- the initiating session that will own the issued grant. Only the allowed action set changes.
ALTER TABLE siyue.apple_login_flows DROP CONSTRAINT apple_login_flow_action;
ALTER TABLE siyue.apple_login_flows ADD CONSTRAINT apple_login_flow_action
  CHECK (action IS NULL OR action IN ('link-identity','revoke-session','revoke-all-sessions'));
-- A login flow must not carry a session/action binding; a reauth flow must bind both the
-- purpose-scoped action and the initiating session that will own the issued grant.
ALTER TABLE siyue.apple_login_flows DROP CONSTRAINT apple_login_flow_reauth_binding;
ALTER TABLE siyue.apple_login_flows ADD CONSTRAINT apple_login_flow_reauth_binding
  CHECK (
    (purpose='login' AND action IS NULL AND session_id IS NULL)
    OR (purpose='reauth' AND action IS NOT NULL AND action IN ('link-identity','revoke-session','revoke-all-sessions') AND session_id IS NOT NULL)
  );
