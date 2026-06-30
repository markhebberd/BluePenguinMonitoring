-- "Dead" is an immutable state of the bird, not a daily observation.
-- Replace penguins.life_stage and penguin_biometric_data.condition_dead with penguins.is_dead.
-- Applied in production via migrate_dead_flag.php (?step=add then ?step=drop).

ALTER TABLE penguins ADD COLUMN is_dead BOOLEAN DEFAULT FALSE;
UPDATE penguins SET is_dead = TRUE WHERE life_stage = 'Dead';
UPDATE penguins p
  JOIN (SELECT DISTINCT peng_num FROM penguin_biometric_data WHERE condition_dead = 1 AND peng_num IS NOT NULL) d
    ON p.peng_num = d.peng_num
  SET p.is_dead = TRUE;

ALTER TABLE penguin_biometric_data DROP COLUMN condition_dead;
ALTER TABLE penguins DROP COLUMN life_stage;
