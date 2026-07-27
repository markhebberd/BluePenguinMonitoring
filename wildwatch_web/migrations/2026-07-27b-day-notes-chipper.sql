-- day_notes.chipper_id: who did the chipping that day.
--
-- observer = who looked in the boxes; recorder = who worked the phone; chipper = who fitted the
-- transponders. On a chipping round these can be three different people, and which is which
-- matters when a chip record is later questioned. Like observer/recorder it is an FK to users
-- (the active-user list nestcheck already picks from), not free text — a rename in the admin
-- screen reaches every day that person worked.
--
-- chk_dn_any grows a third arm so a day recorded solely for its chipper stays a valid row.
-- Existing rows are unaffected: every one already satisfies the constraint via note/observer/
-- recorder, and all get NULL chipper_id (not knowing who chipped is the honest answer for a day
-- recorded before the app asked).
--
-- ON DELETE: none, matching observer_id/recorder_id — a user who chipped on a day cannot be
-- deleted while that day references them. Deactivate (users.active = 0) instead.

ALTER TABLE day_notes
  DROP CONSTRAINT chk_dn_any,
  ADD COLUMN chipper_id INT NULL AFTER recorder_id,
  ADD CONSTRAINT chk_dn_any CHECK (
        CHAR_LENGTH(TRIM(COALESCE(note, ''))) > 0
     OR observer_id IS NOT NULL
     OR recorder_id IS NOT NULL
     OR chipper_id  IS NOT NULL),
  ADD CONSTRAINT fk_dn_chipper FOREIGN KEY (chipper_id) REFERENCES users (id);

-- Verify:
-- SHOW CREATE TABLE day_notes;                                              -- chipper_id + fk_dn_chipper + chk_dn_any (3 arms)
-- SELECT note_date, note, observer_id, recorder_id, chipper_id FROM day_notes ORDER BY note_date DESC LIMIT 5;
