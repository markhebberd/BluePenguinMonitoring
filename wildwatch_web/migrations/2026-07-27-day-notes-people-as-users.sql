-- day_notes.observer / .recorder: free text -> references to users.
--
-- Added earlier today as VARCHAR(100) because the person in the field often had no account.
-- Now that users is a people table (f_name + surname, active flag) rather than only a login
-- table, the day's observer and recorder are those people, so they become FKs. A rename in the
-- admin screen now reaches every day that person worked, instead of leaving stale strings.
--
-- EXISTING DATA IS DROPPED, as requested. Three rows carried names — 2026-07-26 (Britta/Marian),
-- 2026-07-23 (Mark/Florence), 2026-07-22 (Britta/Marian). All three keep their note; only the
-- two name columns go, so no row is left empty and chk_dn_any still holds for every row.
--
-- Nothing in the field is affected: the nestcheck UI that would have written these was never
-- built or released, so no installed app is sending the old free-text fields.
--
-- ON DELETE: none. A user who worked a day cannot be deleted while that day references them,
-- which is the same protection observations already get. Deactivate (users.active = 0) instead.

ALTER TABLE day_notes
  DROP CONSTRAINT chk_dn_any,
  DROP COLUMN observer,
  DROP COLUMN recorder,
  ADD COLUMN observer_id INT NULL AFTER note,
  ADD COLUMN recorder_id INT NULL AFTER observer_id,
  ADD CONSTRAINT chk_dn_any CHECK (
        CHAR_LENGTH(TRIM(COALESCE(note, ''))) > 0
     OR observer_id IS NOT NULL
     OR recorder_id IS NOT NULL),
  ADD CONSTRAINT fk_dn_observer FOREIGN KEY (observer_id) REFERENCES users (id),
  ADD CONSTRAINT fk_dn_recorder FOREIGN KEY (recorder_id) REFERENCES users (id);

-- Verify:
-- SHOW CREATE TABLE day_notes;
-- SELECT COUNT(*) FROM day_notes;                                  -- unchanged (89+)
-- SELECT note_date, note, observer_id, recorder_id FROM day_notes ORDER BY note_date DESC LIMIT 5;
