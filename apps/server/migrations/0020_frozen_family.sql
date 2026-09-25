-- A sole manager's account deletion can leave other members' shared family pending review.
-- Retain both existing states and rows; authorization still requires status='active'.
ALTER TABLE siyue.families DROP CONSTRAINT families_status_check;
ALTER TABLE siyue.families ADD CONSTRAINT families_status_check
  CHECK (status IN ('active','frozen','dissolved'));
