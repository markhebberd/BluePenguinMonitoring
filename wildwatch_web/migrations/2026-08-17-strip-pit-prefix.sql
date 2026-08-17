-- Migration: store a PIT tag as its 15 ISO digits, dropping the reader's two-letter prefix.
--
-- Every tag written before today was stored as "LA" + 15 digits, because the first scans we
-- recovered came off the reader that way. Those two letters are the reader's manufacturer code,
-- not part of the ISO number: they are not printed on the chip label, so anyone entering a tag
-- by hand had to invent them (issue #55). The digits are the identity; the prefix is transport.
--
-- Safe to run because every match in the codebase is already keyed on the last 8 digits
-- (ww_chipKey, sync.php's $chipLookup, the SPA's pit_id.slice(-8), nestcheck's DeriveBirds), so
-- no join, import or lookup changes meaning. Deploy the API first: ww_pit() normalizes every
-- write, so field apps that still send the "LA" form land the same row, and snapshot.php keeps
-- serving the old form to nestcheck builds that predate the change.
--
-- Run inside a transaction, after a backup. Check the two guards FIRST — both must return 0.

-- Guard 1: every tag is either already bare or a letter prefix on 15 digits. A row that is
-- neither is a data problem to look at by hand, not something to strip blindly.
-- Expect 0.
SELECT COUNT(*) AS unexpected_form FROM (
    SELECT pit_id FROM penguin_chips
    UNION ALL
    SELECT pit_id FROM observation_locations WHERE pit_id IS NOT NULL AND pit_id <> ''
) t WHERE pit_id NOT REGEXP '^[A-Za-z]*[0-9]{15}$';

-- Guard 2: stripping must not collide two chips onto one primary key (possible once the API is
-- live, since new chippings already store the bare form).
-- Expect 0.
SELECT COUNT(*) AS collisions FROM (
    SELECT REGEXP_REPLACE(pit_id, '^[A-Za-z]+', '') AS bare, COUNT(*) AS n
    FROM penguin_chips GROUP BY bare HAVING n > 1
) c;

START TRANSACTION;

-- penguin_scans.pit_id is an FK on penguin_chips.pit_id with no ON UPDATE rule, so the parent
-- cannot move while children point at it. Flip it to CASCADE — the same treatment peng_num got
-- in 2026-07-11-peng-num-on-update-cascade.sql — and the 14k scans follow the 1k chips in one
-- statement. DELETE stays RESTRICT: losing a bird's scans by accident must remain impossible.
-- (Separate statements: MariaDB rejects DROP + ADD of a same-named FK in one ALTER, errno 121.)
ALTER TABLE penguin_scans DROP FOREIGN KEY fk_scans_chip;
ALTER TABLE penguin_scans ADD CONSTRAINT fk_scans_chip FOREIGN KEY (pit_id)
    REFERENCES penguin_chips (pit_id) ON UPDATE CASCADE;

UPDATE penguin_chips
   SET pit_id = REGEXP_REPLACE(pit_id, '^[A-Za-z]+', '')
 WHERE pit_id REGEXP '^[A-Za-z]';

-- Box tags live in their own column with no FK, and carry the same prefix.
UPDATE observation_locations
   SET pit_id = REGEXP_REPLACE(pit_id, '^[A-Za-z]+', '')
 WHERE pit_id REGEXP '^[A-Za-z]';

-- audit_log.record_id is a chip's pit_id (WW_NATURAL_KEYS), and it is polymorphic — no FK, so
-- nothing cascades it. snapshot.php finds an edited chip by joining on it, so leaving it behind
-- would silently stop chip edits reaching the phones.
UPDATE audit_log
   SET record_id = REGEXP_REPLACE(record_id, '^[A-Za-z]+', '')
 WHERE table_name = 'penguin_chips' AND record_id REGEXP '^[A-Za-z]';

COMMIT;

-- changed_fields keeps whatever was written at the time, prefix and all. It is the record of what
-- happened, not a pointer, and crud.php's history view normalizes it on read (ww_pit).

-- Column widths stay as they are (chips/scans varchar(17), locations varchar(50)). A width of 15
-- would turn any straggling legacy write into a hard error out in a colony; ww_pit already
-- guarantees the stored form, and the integrity report flags anything that slips through.

-- Verify (all four expect 0):
-- SELECT COUNT(*) FROM penguin_chips         WHERE pit_id REGEXP '^[A-Za-z]';
-- SELECT COUNT(*) FROM penguin_scans         WHERE pit_id REGEXP '^[A-Za-z]';
-- SELECT COUNT(*) FROM observation_locations WHERE pit_id REGEXP '^[A-Za-z]';
-- SELECT COUNT(*) FROM audit_log WHERE table_name = 'penguin_chips' AND record_id REGEXP '^[A-Za-z]';
-- And that no scan was orphaned (expect 0):
-- SELECT COUNT(*) FROM penguin_scans ps LEFT JOIN penguin_chips pc ON ps.pit_id = pc.pit_id
--   WHERE ps.pit_id IS NOT NULL AND pc.pit_id IS NULL;
