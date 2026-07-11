-- Migration: flip the two peng_num child FKs from RESTRICT to ON UPDATE CASCADE.
--
-- This makes renumbering a penguin a single statement:
--   UPDATE penguins SET peng_num = :new WHERE peng_num = :old
-- with penguin_chips and penguin_biometric_data following automatically, replacing the old
-- insert-new-parent / repoint-children / delete-old-parent dance in wwAuditedRenumberPenguin.
--
-- Deletes stay RESTRICT (the default) — accidental parent deletion must still be impossible;
-- delete_penguin removes children explicitly, one audited row at a time.

-- Drop and re-add as separate statements: MariaDB rejects DROP + ADD of a same-named FK
-- within one ALTER (errno 121, duplicate key).

ALTER TABLE penguin_chips DROP FOREIGN KEY fk_chips_peng;
ALTER TABLE penguin_chips ADD CONSTRAINT fk_chips_peng FOREIGN KEY (peng_num)
    REFERENCES penguins (peng_num) ON UPDATE CASCADE;

ALTER TABLE penguin_biometric_data DROP FOREIGN KEY fk_bio_peng;
ALTER TABLE penguin_biometric_data ADD CONSTRAINT fk_bio_peng FOREIGN KEY (peng_num)
    REFERENCES penguins (peng_num) ON UPDATE CASCADE;

-- Verify:
-- SELECT CONSTRAINT_NAME, UPDATE_RULE, DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS
--   WHERE CONSTRAINT_SCHEMA = 'wildwatch_nestcheck' AND REFERENCED_TABLE_NAME = 'penguins';
-- Expect UPDATE_RULE = CASCADE, DELETE_RULE = RESTRICT for both.
