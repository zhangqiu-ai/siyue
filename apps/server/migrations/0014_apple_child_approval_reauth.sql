-- Widen the Apple reauth action whitelist by exactly one adult action: `approve-child-device`
-- (design 12.2 / 16.3), the reverification a guardian must pass before approving a child device.
-- Additive only: existing login rows and the existing link-identity / revoke-session /
-- revoke-all-sessions reauth rows keep their meaning, and a reauth flow still binds the action and
-- the initiating session that will own the issued grant. 0007 and 0008 stay byte-identical, so
-- their recorded checksums are untouched; this file only replaces the allowed action set, and
-- `siyue.reauth_grants.action` already admits every documented action, so no other table changes.
ALTER TABLE siyue.apple_login_flows DROP CONSTRAINT apple_login_flow_action;
ALTER TABLE siyue.apple_login_flows ADD CONSTRAINT apple_login_flow_action
  CHECK (action IS NULL OR action IN ('link-identity','revoke-session','revoke-all-sessions','approve-child-device'));
-- A login flow must not carry a session/action binding; a reauth flow must bind both the
-- purpose-scoped action and the initiating session that will own the issued grant.
ALTER TABLE siyue.apple_login_flows DROP CONSTRAINT apple_login_flow_reauth_binding;
ALTER TABLE siyue.apple_login_flows ADD CONSTRAINT apple_login_flow_reauth_binding
  CHECK (
    (purpose='login' AND action IS NULL AND session_id IS NULL)
    OR (purpose='reauth' AND action IS NOT NULL AND action IN ('link-identity','revoke-session','revoke-all-sessions','approve-child-device') AND session_id IS NOT NULL)
  );
