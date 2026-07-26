-- observers -> users: rename the table, rename its two identity columns, add surname.
--
--   observers.observer_id   -> users.id
--   observers.observer_name -> users.f_name
--   (new)                      users.surname VARCHAR(100) NULL
--
-- WHAT IS NOT RENAMED, DELIBERATELY:
--
-- 1. The FK columns in the ten referencing places — observations.observer_id, .deleted_by,
--    audit_log.observer_id, sessions.observer_id, password_resets.observer_id,
--    colony_permissions.observer_id, penguin_biometric_data.deleted_by,
--    breeding_verifications.adults_reviewed_by / .chicks_reviewed_by. They now point at
--    users.id but keep their own names. RENAME TABLE carries every FK across automatically.
--
-- 2. The API surface. Endpoints still publish observer_id and observer_name, produced by
--    aliasing in SQL (SELECT u.id AS observer_id, u.f_name AS observer_name). Installed
--    nestcheck builds in the field deserialise observer_name and cannot be updated in step
--    with the server, so renaming the JSON key would break every phone until it updated.
--
-- 3. The $observer['observer_id'] array shape inside the PHP. The session lookup aliases the
--    two columns, so the dozens of call sites reading $observer['observer_id'] keep working.
--
-- EXISTING NAMES ARE COPIED VERBATIM: f_name holds exactly what observer_name held
-- ('Mark H', 'Britta', 'API'), and surname is NULL for all 8 rows. Nothing is split or
-- guessed — 'Mark H' stays 'Mark H' until someone edits it in the admin screen. This also
-- keeps the UNIQUE key on the name valid: splitting would have produced two rows with
-- f_name = 'Mark' and required moving the key to (f_name, surname).
--
-- AUDIT LOG: rows written from here on record table_name = 'users'; everything before this
-- migration says 'observers'. Both refer to the same rows. A history query wanting the full
-- span needs: WHERE table_name IN ('users', 'observers').
--
-- SEQUENCING — a rename breaks running code the instant it lands, and this table is on the
-- auth path for every request. Run steps 1 and 2 together, deploy, then run step 3:

-- Step 1: rename.
ALTER TABLE observers RENAME TO users;
ALTER TABLE users
  CHANGE COLUMN observer_id id INT NOT NULL AUTO_INCREMENT,
  CHANGE COLUMN observer_name f_name VARCHAR(100) NOT NULL,
  ADD COLUMN surname VARCHAR(100) NULL AFTER f_name,
  RENAME INDEX observer_name TO f_name;

-- Step 2: a view under the old name, so the code still running (and any request in flight)
-- keeps working until the new release is live. Single-table, plain column aliases, so it is
-- updatable and insertable — the old INSERT/UPDATE paths work through it too.
CREATE OR REPLACE VIEW observers AS
  SELECT id AS observer_id, f_name AS observer_name, email, passphrase_hash,
         created_at, updated_at, role, api_key
  FROM users;

-- Step 3: AFTER the deploy is confirmed healthy — drop the shim.
-- DROP VIEW observers;

-- Verify:
-- SHOW CREATE TABLE users;
-- SELECT id, f_name, surname, email, role FROM users ORDER BY id;
-- SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
--   WHERE REFERENCED_TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = 'users';
