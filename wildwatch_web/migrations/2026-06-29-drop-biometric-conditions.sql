-- Drop retired biometric condition columns (no longer recorded by any app).
-- Applied in production via migrate_drop_conditions.php.
ALTER TABLE penguin_biometric_data
    DROP COLUMN condition_underweight,
    DROP COLUMN condition_dog_attacked,
    DROP COLUMN condition_attacked;
