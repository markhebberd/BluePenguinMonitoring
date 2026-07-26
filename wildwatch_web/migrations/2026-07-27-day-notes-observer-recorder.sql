-- day_notes: who was out, alongside what happened.
--
-- observer = who was looking in the boxes; recorder = who was working the phone. On a two-person
-- round they are different people, and which is which matters when a count is later questioned.
-- Both are free text (a name as typed in the field), NOT observers.observer_id: the person
-- observing often has no login, and the login that uploads is already captured — observations
-- carry observer_id, and audit_log records who wrote every day_notes row.
--
-- WHY note BECOMES NULLABLE: until now the row's whole reason to exist was the note, so blank
-- text deleted it (crud.php save_day_note) and chk_dn_note enforced non-blank. A day can now be
-- worth a row for its people alone — "Britta observing, Mark recording", no note — so the
-- invariant moves from "note is non-blank" to "at least one of the three is non-blank".
-- chk_dn_any enforces that, and save_day_note deletes only when all three come back blank.
-- Existing rows all have a note, so none is affected.
--
-- All 89 existing rows keep their note and get NULL for both new columns: not knowing who was
-- out is the honest answer for a day recorded before the app asked.

ALTER TABLE day_notes
  ADD COLUMN observer VARCHAR(100) NULL AFTER note,
  ADD COLUMN recorder VARCHAR(100) NULL AFTER observer,
  MODIFY COLUMN note VARCHAR(255) NULL,
  DROP CONSTRAINT chk_dn_note,
  ADD CONSTRAINT chk_dn_any CHECK (
        CHAR_LENGTH(TRIM(COALESCE(note, ''))) > 0
     OR CHAR_LENGTH(TRIM(COALESCE(observer, ''))) > 0
     OR CHAR_LENGTH(TRIM(COALESCE(recorder, ''))) > 0);

-- Verify (expect observer + recorder present and nullable, note nullable, chk_dn_any listed):
-- SHOW CREATE TABLE day_notes;
-- SELECT COUNT(*) FROM day_notes WHERE note IS NULL OR TRIM(note) = '';   -- expect 0 right after
