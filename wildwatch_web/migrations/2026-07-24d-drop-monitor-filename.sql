-- Drop observations.monitor_filename, now that day_notes holds the day's note.
--
-- RUN ONLY AFTER 2026-07-24c-day-notes-backfill.php has been run with --commit and the notes
-- have been eyeballed: this is the point of no return for the column.
--
-- What is lost: per-row import provenance — which file or sync each individual observation came
-- from. That mattered on a day where two imports covered different boxes (2026-06-29: 142 rows
-- "FM", 1 row "PenguinMonitor 260629 missing box"). The backfill keeps both labels in the day's
-- note, joined by " · ", so the day still says what happened; what it no longer says is which of
-- the 143 rows belonged to which import.
--
-- What is not lost: audit_log holds every observation's INSERT with monitor_filename inside
-- changed_fields, so the per-row value remains recoverable for any row ever written through the
-- gateway:
--   SELECT record_id, JSON_UNQUOTE(JSON_EXTRACT(changed_fields, '$.monitor_filename'))
--     FROM audit_log WHERE table_name = 'observations' AND action = 'INSERT';

ALTER TABLE observations DROP COLUMN monitor_filename;

-- Verify (expect zero rows):
-- SELECT COLUMN_NAME FROM information_schema.COLUMNS
--   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'observations' AND COLUMN_NAME = 'monitor_filename';
