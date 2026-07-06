-- Add the extra biometric fields that snapshot.php / snapshot_columns.php and the
-- biometrics editor (cache v10, commit d469719) expect but which were never migrated.
-- Without these columns snapshot.php's SELECT fails, so the SPA loads no data at all.
ALTER TABLE penguin_biometric_data
  ADD COLUMN sex                  VARCHAR(10)   DEFAULT NULL AFTER observed_sex,
  ADD COLUMN left_flipper_length  DECIMAL(5,2)  DEFAULT NULL AFTER right_flipper_length,
  ADD COLUMN body_length          DECIMAL(5,2)  DEFAULT NULL AFTER left_flipper_length,
  ADD COLUMN beak_length          DECIMAL(5,2)  DEFAULT NULL AFTER body_length,
  ADD COLUMN condition_healthy    TINYINT(1)    DEFAULT NULL AFTER condition_ticks;
