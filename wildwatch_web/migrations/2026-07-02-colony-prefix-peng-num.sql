-- Migration: Add colony_prefix to colonies, prefix all peng_num values
--
-- This migration:
-- 1. Adds colony_prefix column to colonies
-- 2. Prefixes all existing peng_num with "PT" (Tarakohe)
-- 3. Updates peng_num in all referencing tables (penguin_chips, penguin_biometric_data)
--
-- REVIEW BEFORE RUNNING. This changes primary key values across multiple tables.

-- Step 1: Add colony_prefix to colonies
ALTER TABLE colonies ADD COLUMN colony_prefix VARCHAR(4) AFTER colony_name;
UPDATE colonies SET colony_prefix = 'PT' WHERE colony_id = 1;  -- Port Tarakohe
UPDATE colonies SET colony_prefix = 'NI' WHERE colony_id = 2;  -- Ngawhiti Island

-- Step 2: Widen peng_num columns if needed (currently VARCHAR(20), should be fine)
-- No change needed — "PT" + existing number still fits in VARCHAR(20)

-- Step 3: Disable FK checks for the bulk rename
SET FOREIGN_KEY_CHECKS = 0;

-- Step 4: Prefix peng_num in penguins (the source table)
UPDATE penguins SET peng_num = CONCAT('PT', peng_num) WHERE peng_num REGEXP '^[0-9]';

-- Step 5: Prefix peng_num in penguin_chips (FK to penguins.peng_num)
UPDATE penguin_chips SET peng_num = CONCAT('PT', peng_num) WHERE peng_num REGEXP '^[0-9]';

-- Step 6: Prefix peng_num in penguin_biometric_data (FK to penguins.peng_num)
UPDATE penguin_biometric_data SET peng_num = CONCAT('PT', peng_num) WHERE peng_num REGEXP '^[0-9]';

-- Step 7: Re-enable FK checks
SET FOREIGN_KEY_CHECKS = 1;

-- Step 8: Verify counts match
-- Run these after migration to confirm no orphans:
-- SELECT COUNT(*) FROM penguin_chips WHERE peng_num NOT IN (SELECT peng_num FROM penguins);
-- SELECT COUNT(*) FROM penguin_biometric_data WHERE peng_num NOT IN (SELECT peng_num FROM penguins);
-- SELECT COUNT(*) FROM penguins WHERE peng_num NOT LIKE 'PT%';
