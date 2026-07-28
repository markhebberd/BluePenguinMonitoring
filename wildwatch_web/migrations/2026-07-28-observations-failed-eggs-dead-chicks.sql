-- End-of-life counts recorded ON the observation that saw them.
--
-- Detection infers a failure from the counts moving: an egg gone with no chick appearing is a
-- failed egg. That inference has a blind spot — a failure and a replacement inside the same
-- visit leave the count unchanged, so nothing is detected and there is currently no way for a
-- monitor to say what they saw. These two columns are that input: "one of these eggs is the
-- old failed one", "a chick died here".
--
-- Not required on every observation. Blank means "nothing to add", NOT zero failures — the
-- existing count-movement inference still stands on its own. They are only ever a monitor
-- reporting an end of life the counts cannot show.
--
-- Add the columns BEFORE deploying the code that selects them (snapshot.php via
-- snapshot_columns.php), or the SPA fails to load.
ALTER TABLE observations
  ADD COLUMN failed_eggs INT DEFAULT 0 AFTER fledged_unchipped,
  ADD COLUMN dead_chicks INT DEFAULT 0 AFTER failed_eggs;

-- Verify:
-- SHOW COLUMNS FROM observations LIKE '%_eggs';
-- SHOW COLUMNS FROM observations LIKE 'dead_chicks';
