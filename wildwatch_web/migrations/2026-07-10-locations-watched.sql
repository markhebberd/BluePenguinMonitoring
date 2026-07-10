-- Watched flag for observation locations.
ALTER TABLE observation_locations ADD COLUMN watched TINYINT(1) NOT NULL DEFAULT 0 AFTER persistent_notes;
