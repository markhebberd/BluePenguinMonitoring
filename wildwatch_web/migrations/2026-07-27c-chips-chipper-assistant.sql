-- penguin_chips: who chipped the bird, and who assisted — as users, not initials.
--
--   chipper_id   INT NULL FK -> users(id)   backfilled from chip_by via users.chip_acronym
--   assistant_id INT NULL FK -> users(id)   starts empty; there is no historical source for it
--
-- WHY NOW: chip_by is a 2-letter signature ("BS", "AL") with no owner. As of the acronym
-- cleanup every one of the 1054 chips maps to exactly one user:
--   BS 512 Britta Steude · AL 335 Angela Lees · LJ 74 Linda Jenkins · AM 55 Amy Mckenzie
--   JC 48 John Cochrane · LL 21 Larry Lumsdu · KS 7 Karen Saunders · HE 2 Henry Elso
-- (BS includes 26 rows that read "Britta" until 2026-07-27, normalised in the same pass.)
--
-- chip_by IS KEPT, deliberately:
--   * it is the provenance for this backfill — the derivation stays checkable, and reversible,
--     without consulting audit_log;
--   * it is read by day.php, dashboard.php, penguins.php, config.php, snapshot and the peng
--     panel, and the phone still writes it. Dropping it is a later step, once every reader
--     resolves the id instead.
-- The two must not drift: crud.php derives chipper_id from chip_by whenever a chipping is
-- created without an explicit id, so a phone that knows nothing about users still lands both.
--
-- ASSISTANT HAS NO HISTORICAL DATA. chip_by is single-valued in all 1054 rows — no separators,
-- ever — so nothing records who else was there. assistant_id is NULL for every existing chip
-- and is filled in going forward only. Nothing is inferred.
--
-- solo IS UNTOUCHED. The 18 rows flagged solo='Y' keep that flag and their own meaning;
-- assistant_id neither sets nor reads it. They are related but not the same statement, and
-- collapsing them would have turned "no assistant recorded" into "worked alone" for 1036 rows
-- where nobody actually said that.
--
-- ON DELETE: none, matching day_notes. A user who chipped a bird cannot be deleted while the
-- chip references them; deactivate (users.active = 0) instead. Ten of the fourteen acronym
-- holders are already inactive, which is exactly the intended shape — history keeps its author.

ALTER TABLE penguin_chips
  ADD COLUMN chipper_id   INT NULL AFTER chip_by,
  ADD COLUMN assistant_id INT NULL AFTER chipper_id,
  ADD CONSTRAINT fk_chips_chipper   FOREIGN KEY (chipper_id)   REFERENCES users (id),
  ADD CONSTRAINT fk_chips_assistant FOREIGN KEY (assistant_id) REFERENCES users (id);

-- Backfill runs through the audited gateway (wwAuditedUpdate), one audit_log row per chip, so
-- each attribution records what it was derived from and who ran it:
--
--   foreach (chips) wwAuditedUpdate($pdo, 'penguin_chips', $pit_id,
--       ['chipper_id' => $id], $actor, 'Backfill chipper from chip_by acronym');
--
-- Equivalent bulk form, for reference / a rebuild on a copy:
--   UPDATE penguin_chips c JOIN users u ON u.chip_acronym = c.chip_by SET c.chipper_id = u.id;

-- Verify (expect 1054 attributed, 0 missed, 0 assistants):
-- SELECT COUNT(*) total, COUNT(chipper_id) attributed, COUNT(assistant_id) assisted FROM penguin_chips;
-- SELECT c.chip_by, u.f_name, COUNT(*) n FROM penguin_chips c
--   JOIN users u ON u.id = c.chipper_id GROUP BY c.chip_by, u.f_name ORDER BY n DESC;
-- Any row whose text and id disagree (expect none):
-- SELECT c.pit_id, c.chip_by, u.chip_acronym FROM penguin_chips c
--   JOIN users u ON u.id = c.chipper_id WHERE u.chip_acronym <> c.chip_by;
