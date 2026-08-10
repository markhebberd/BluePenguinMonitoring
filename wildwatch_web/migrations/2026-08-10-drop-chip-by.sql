-- Retire penguin_chips.chip_by.
--
-- chip_by duplicated the chipper as a hard-coded acronym string, but chipper_id (the FK to users)
-- is the source of truth and is fully populated — every chip points at a real chip user. All code
-- now derives the acronym from chipper_id (a correlated subquery in SNAP_COLS_CHIP; chip_acronym in
-- every list/day/box view), and the writers no longer store chip_by, so nothing reads this column.
--
-- Safe to drop — verified no information is lost (0 rows have chip_by set with no chipper_id):
--   SELECT SUM(chip_by IS NOT NULL AND chip_by <> '' AND chipper_id IS NULL) FROM penguin_chips;  -- 0
--   SELECT SUM(chip_by IS NOT NULL AND chip_by <> '' AND chipper_id IS NULL
--              AND chip_by NOT IN (SELECT chip_acronym FROM users WHERE chip_acronym IS NOT NULL))
--     FROM penguin_chips;  -- 0 (no orphans)
-- Values were also backed up to ~/chip_by_backup.tsv and remain recoverable from audit_log.
--
-- Apply the CODE change (deploy) first so nothing references the column, THEN run this.

ALTER TABLE penguin_chips DROP COLUMN chip_by;
