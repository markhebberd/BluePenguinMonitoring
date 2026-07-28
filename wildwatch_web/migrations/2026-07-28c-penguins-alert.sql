-- Flag a bird so scanning it in the field raises an alert, the way an unsexed adult already
-- does (MainActivity's triggerAlertAsync). For birds that need a hand-on when they turn up:
-- one wanted for measurement, a rechip due, an injury to check.
--
-- Not a property of the bird's biology, so nothing derives it — a person sets it and a person
-- clears it. Default 0: silence unless someone asks for the noise.
--
-- Add the column BEFORE deploying the code that selects it (snapshot.php via
-- snapshot_columns.php), or the SPA fails to load.
ALTER TABLE penguins ADD COLUMN alert TINYINT(1) NOT NULL DEFAULT 0 AFTER chick_size_code;

-- Verify:
-- SHOW COLUMNS FROM penguins LIKE 'alert';
