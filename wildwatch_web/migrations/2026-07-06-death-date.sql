-- Replace the penguins.is_dead bool with a death timestamp so the admin validation page
-- can flag scans dated AFTER a bird died (not just "scanned in the last year").
--
-- death_date is stored on the same UTC timeline as penguin_scans.scan_time_utc /
-- observations.observation_time_utc. A death recorded on an NZ calendar date is stamped at
-- 2pm NZ = 02:00 UTC (the app uses a fixed +12 NZ offset), so a same-day morning scan reads
-- as "before death" and an afternoon scan as "after death".
--
-- is_dead becomes a STORED generated column (death_date IS NOT NULL) so every existing reader
-- (nestcheck scanner sync, snapshot, dashboard, admin warnings, bird display) keeps working
-- unchanged, with death_date as the single source of truth.
--
-- Only two birds are currently dead: 717 and 284. They are seeded to 2pm NZ on their last
-- scan date so they stay dead through the migration; the exact dates are then corrected in
-- the bird editor.

ALTER TABLE penguins ADD COLUMN death_date DATETIME NULL AFTER is_dead;

-- Preserve the existing dead flag. Seed 2pm NZ on the bird's most recent (non-deleted) scan
-- date; fall back to 2pm NZ today if the bird has no scans, so no currently-dead bird is lost.
UPDATE penguins p
  SET p.death_date = COALESCE(
    (SELECT TIMESTAMP(DATE(CONVERT_TZ(MAX(o.observation_time_utc), '+00:00', '+12:00')), '02:00:00')
       FROM penguin_chips pc
       JOIN penguin_scans ps ON ps.pit_id = pc.pit_id AND (ps.is_deleted = FALSE OR ps.is_deleted IS NULL)
       JOIN observations o ON ps.observation_id = o.observation_id AND o.is_deleted = FALSE
      WHERE pc.peng_num = p.peng_num),
    TIMESTAMP(DATE(CONVERT_TZ(NOW(), '+00:00', '+12:00')), '02:00:00'))
  WHERE p.is_dead = 1;

-- Redefine is_dead as a generated column derived from death_date.
ALTER TABLE penguins DROP COLUMN is_dead;
ALTER TABLE penguins
  ADD COLUMN is_dead BOOLEAN GENERATED ALWAYS AS (death_date IS NOT NULL) STORED AFTER death_date;
