-- day_notes.recorder_id -> scribe_id: "recorder" renamed to "scribe" across NestCheck + wildwatch.
--
-- Same column, same nullable INT FK to users(id) — only the name changes. The CHECK (chk_dn_any)
-- and the FK (fk_dn_recorder) both reference the column, so they're dropped and re-added around
-- the rename. observer_id is untouched.
--
-- Deploy in lock-step with the matching sync.php / web / NestCheck release: the wire key
-- daily_recorder_id becomes daily_scribe_id and day_recorder becomes day_scribe at the same time.
-- Apply this migration BEFORE (or together with) the new API, so no code references the old name.

-- Done in discrete steps: dropping the FK + renaming the column + adding the new FK in one
-- ALTER trips MariaDB's FK formation (errno 150). The CHANGE COLUMN preserves every value; only
-- the leftover index (still named fk_dn_recorder after the rename) is dropped before the new FK.
ALTER TABLE day_notes DROP FOREIGN KEY fk_dn_recorder, DROP CONSTRAINT chk_dn_any;
ALTER TABLE day_notes CHANGE COLUMN recorder_id scribe_id INT NULL;
ALTER TABLE day_notes DROP INDEX fk_dn_recorder;
ALTER TABLE day_notes
  ADD CONSTRAINT fk_dn_scribe FOREIGN KEY (scribe_id) REFERENCES users (id),
  ADD CONSTRAINT chk_dn_any CHECK (
        CHAR_LENGTH(TRIM(COALESCE(note, ''))) > 0
     OR observer_id IS NOT NULL
     OR scribe_id IS NOT NULL);

-- Verify:
-- SHOW CREATE TABLE day_notes;
-- SELECT note_date, note, observer_id, scribe_id FROM day_notes ORDER BY note_date DESC LIMIT 5;
