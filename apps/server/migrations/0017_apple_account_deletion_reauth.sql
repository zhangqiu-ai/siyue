-- An Apple-only adult must be able to reverify for account deletion without first creating an
-- email/password login. Extend only the action whitelist of the Apple reauth flow; the flow remains
-- bound to the current adult session, and sessions.consumeReauth enforces the same action at use.
-- Historical 0007/0008/0014 migrations stay unchanged so recorded checksums remain valid.
ALTER TABLE siyue.apple_login_flows DROP CONSTRAINT apple_login_flow_action;
ALTER TABLE siyue.apple_login_flows ADD CONSTRAINT apple_login_flow_action
  CHECK (action IS NULL OR action IN
    ('link-identity','revoke-session','revoke-all-sessions','approve-child-device','delete-account'));
ALTER TABLE siyue.apple_login_flows DROP CONSTRAINT apple_login_flow_reauth_binding;
ALTER TABLE siyue.apple_login_flows ADD CONSTRAINT apple_login_flow_reauth_binding
  CHECK (
    (purpose='login' AND action IS NULL AND session_id IS NULL)
    OR (purpose='reauth' AND action IS NOT NULL AND action IN
      ('link-identity','revoke-session','revoke-all-sessions','approve-child-device','delete-account')
      AND session_id IS NOT NULL)
  );
