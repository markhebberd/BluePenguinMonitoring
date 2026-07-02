-- Migration: penguins.colony_id — authoritative home-colony column
--
-- Follows 2026-07-02-colony-prefix-peng-num.sql (peng_num values are already
-- prefixed, e.g. PT706). The prefix stays in the PK for uniqueness across
-- colonies; colony_id becomes the source of truth for which colony a bird
-- belongs to (auto-numbering, lookups, future prefix renames).
--
-- Deploy order: run this BEFORE deploying the server code that reads it.
-- The column is backward-compatible with the currently-deployed code.

ALTER TABLE penguins ADD COLUMN colony_id INT NOT NULL DEFAULT 1 AFTER peng_num;

-- Backfill from the prefix. As of 2026-07-02 every bird is PT (colony 1) and
-- no Ngawhiti birds exist, so this is a no-op beyond the DEFAULT — the join
-- keeps it correct if that changes before the migration runs.
UPDATE penguins p
  JOIN colonies c ON c.colony_prefix IS NOT NULL AND c.colony_prefix <> ''
   AND p.peng_num LIKE CONCAT(c.colony_prefix, '%')
SET p.colony_id = c.colony_id;

ALTER TABLE penguins ADD INDEX idx_penguins_colony (colony_id);

-- Verify after running:
-- SELECT colony_id, COUNT(*) FROM penguins GROUP BY colony_id;               -- expect all in 1
-- SELECT COUNT(*) FROM penguins p JOIN colonies c ON p.colony_id = c.colony_id
--   WHERE p.peng_num NOT LIKE CONCAT(c.colony_prefix, '%');                   -- expect 0
