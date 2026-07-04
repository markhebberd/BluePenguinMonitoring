-- Per-colony list of locations excluded from Full Monitor detection.
-- Previously hardcoded client-side as ['0','AA','AB','AC'] (Tarakohe's non-nest
-- locations). Default preserves that behaviour for the existing colony.
ALTER TABLE colonies ADD COLUMN fm_excluded_boxes VARCHAR(255) NOT NULL DEFAULT '0,AA,AB,AC' AFTER location_sets_string;
