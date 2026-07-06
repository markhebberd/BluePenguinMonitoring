-- Consolidate the biometric flipper measurement into a single `flipper_length` column.
-- right_flipper_length held all historical data; left_flipper_length (added earlier the same
-- day) was unused. On production this ran expand-contract to avoid downtime: add + copy before
-- the matching SPA/PHP deploy, drop the old columns after. A fresh DB can run it in one pass.
ALTER TABLE penguin_biometric_data ADD COLUMN flipper_length DECIMAL(5,2) DEFAULT NULL AFTER weight;
UPDATE penguin_biometric_data SET flipper_length = right_flipper_length WHERE right_flipper_length IS NOT NULL;
ALTER TABLE penguin_biometric_data
  DROP COLUMN right_flipper_length,
  DROP COLUMN left_flipper_length;
