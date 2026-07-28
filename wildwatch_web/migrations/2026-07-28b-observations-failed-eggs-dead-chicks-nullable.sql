-- Make the two end-of-life counts nullable, so blank and zero say different things.
--
--   NULL = nothing recorded here (the overwhelming majority of observations)
--   0    = a monitor looked and states nothing failed
--   n    = a monitor saw n fail on this visit
--
-- With a DEFAULT 0 the two were indistinguishable, and detection could never tell a checked
-- box from an unvisited question. Every existing row is a default written minutes ago by
-- 2026-07-28-observations-failed-eggs-dead-chicks.sql — no monitor has entered a value — so
-- the existing zeros are backfilled to NULL rather than read as claims nobody made.
ALTER TABLE observations
  MODIFY COLUMN failed_eggs INT NULL DEFAULT NULL,
  MODIFY COLUMN dead_chicks INT NULL DEFAULT NULL;

UPDATE observations SET failed_eggs = NULL WHERE failed_eggs = 0;
UPDATE observations SET dead_chicks = NULL WHERE dead_chicks = 0;

-- Verify:
-- SHOW COLUMNS FROM observations WHERE Field IN ('failed_eggs','dead_chicks');
-- SELECT COUNT(*) FROM observations WHERE failed_eggs IS NOT NULL OR dead_chicks IS NOT NULL;
