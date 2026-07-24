-- Day notes: one free-text note per colony per monitoring day.
--
-- PURPOSE: what happened on a day's monitor, in a person's words — "Full monitor with Mark",
-- "App only, no bdot", "Gates checked, box 44 missing". Until now this lived in
-- observations.monitor_filename, repeated on every one of the day's ~143 rows, and it held an
-- import filename ("PenguinMonitor 20 May 26 FM Marian") rather than a note. One row per day
-- replaces ~143 copies of a filename with one editable sentence.
--
-- COLONY-SCOPED. Two colonies monitored on the same date are two independent days' work — NI's
-- "Britta's 1st NI Nestcheck monitor" and PT's "App only FM w Britta" both fell on 2026-07-03.
-- The unique key is (colony_id, note_date), so each colony owns its own note for a date.
--
-- note_date is an NZ calendar date, matching how the app and day.php bucket observations
-- (NZ day D = UTC (D-1)T12:00 .. DT12:00, fixed +12). It is deliberately NOT an FK to anything:
-- a note can precede its observations (a plan written the night before) and survives them all
-- being deleted and re-imported, which is exactly when you most want to know what the day was.
--
-- AUTHORSHIP AND HISTORY live in audit_log. day_notes is registered in WW_TABLE_KEYS, so every
-- write goes through wwAuditedInsert/Update/Delete and lands an audit_log row keyed by
-- (table_name='day_notes', record_id=day_note_id): INSERT carries the note, UPDATE the old =>
-- new text, DELETE the row as it was. There is no created_by column for the same reason
-- breeding_verifications has none — the log already answers who and when, and answers it for
-- every edit rather than only the first.
--
-- Blank is not a note: clearing the text deletes the row (see crud.php save_day_note), so
-- "no note for this day" has exactly one representation.

CREATE TABLE day_notes (
    day_note_id INT AUTO_INCREMENT PRIMARY KEY,
    colony_id   INT NOT NULL,
    note_date   DATE NOT NULL,            -- NZ calendar date
    note        VARCHAR(255) NOT NULL,    -- never blank; delete the row instead
    created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_colony_date (colony_id, note_date),
    KEY idx_note_date (note_date),
    CONSTRAINT chk_dn_note CHECK (CHAR_LENGTH(TRIM(note)) > 0),
    CONSTRAINT fk_dn_colony FOREIGN KEY (colony_id) REFERENCES colonies (colony_id)
);

-- Backfill from observations.monitor_filename is a separate, dry-runnable step because the
-- cleaning rules (strip the "PenguinMonitor" wrapper, the embedded date, the ".csv"; drop
-- machine provenance like "sheet-import-2021-04-07" and "web-entry, x@y") are more than SQL
-- should be asked to express, and because it writes through the audited gateway:
--
--   php migrations/2026-07-24c-day-notes-backfill.php            # preview, writes nothing
--   php migrations/2026-07-24c-day-notes-backfill.php --commit   # write
--
-- Only after that has been checked: migrations/2026-07-24d-drop-monitor-filename.sql

-- Verify:
-- SELECT c.colony_name, d.note_date, d.note FROM day_notes d
--   JOIN colonies c ON c.colony_id = d.colony_id ORDER BY d.note_date DESC LIMIT 20;
--
-- Edit history of one day's note:
-- SELECT action, changed_fields, observer_id, change_timestamp
--   FROM audit_log WHERE table_name = 'day_notes' AND record_id = ? ORDER BY change_timestamp;
