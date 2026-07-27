-- users.chip_acronym: the initials a person signs a chipping with.
--
-- penguin_chips.chip_by already holds these — BS (486 chippings), AL (335), LJ (74), AM (55),
-- JC (48), LL (21), KS (7), HE (2) — but as loose text with no owner, so nothing connects the
-- 486 birds chipped by "BS" to Britta Steude's user record. This column is the missing half.
--
-- UNIQUE, but NULLable: an acronym must identify exactly one person, while most users never
-- chip anything and have none. NULLs are distinct under a UNIQUE key, which is precisely what
-- allows any number of people with no acronym while still rejecting a second "BS".
--
-- Case: the table collates latin1_swedish_ci, so the key already treats 'bs' and 'BS' as the
-- same value. admin.php also uppercases on write, so the stored form is consistent.
--
-- NOT a foreign key from penguin_chips.chip_by, and this migration changes no chipping data.
-- Wiring chip_by to users is a separate step, and one to take carefully: 26 chippings are
-- recorded as "Britta" rather than "BS", so the existing text is not yet clean enough to
-- point a constraint at.

ALTER TABLE users ADD COLUMN chip_acronym VARCHAR(10) NULL AFTER falcon_id;
ALTER TABLE users ADD UNIQUE KEY uniq_user_chip_acronym (chip_acronym);

-- Verify:
-- SHOW CREATE TABLE users;
-- SELECT id, f_name, surname, chip_acronym FROM users ORDER BY id;
--
-- The acronyms in use, once people are given theirs — anything still unclaimed:
-- SELECT DISTINCT c.chip_by FROM penguin_chips c
--   LEFT JOIN users u ON u.chip_acronym = c.chip_by
--   WHERE c.chip_by IS NOT NULL AND c.chip_by <> '' AND u.id IS NULL;
