-- Collapse the breeding-verification store to ONE table.
--
-- The first cut (2026-07-24-breeding-verifications.sql) had three tables — a verification row,
-- a chick child table, and a disagreements table. This restructures to a single table:
--   * disagreements fold in as a per-half REJECT verdict + note (accept the data, or reject it
--     with a note — no separate objection table);
--   * the chipped-chick list becomes a JSON column instead of a child table.
--
-- ACCEPT / REJECT PER HALF. Each half (adults, offspring) is reviewed independently:
--   accepted → the algorithm's detected data was right; it's snapshotted here as the fixture and
--              as the drift baseline (green while the detector still reproduces it, red when not).
--   rejected → the detected data is wrong; the note says why (red).
-- A half with no verdict is still to review (grey on the card).
--
-- DRIFT ON RENUMBER. male/female stay FK columns with ON UPDATE CASCADE, so a renumber rewrites
-- them automatically. The chicks JSON has no FK, so the two gateway renumber functions
-- (wwAuditedRenumberPenguin, wwAuditedSwapPenguins in db_write.php) rewrite the peng_nums inside
-- it — the single place a peng_num ever changes. peng_nums are stored PREFIXED (e.g. 'PT926');
-- the snapshot strips the viewing colony's prefix, matching the penguins the client holds.
--
-- Empty tables (validation data cleared), so this drops and recreates rather than migrating rows.

DROP TABLE IF EXISTS breeding_verification_chicks;
DROP TABLE IF EXISTS breeding_verification_disagreements;
DROP TABLE IF EXISTS breeding_verifications;

CREATE TABLE breeding_verifications (
    verification_id     INT AUTO_INCREMENT PRIMARY KEY,
    observation_id      INT NOT NULL,              -- clutch anchor: the attempt's first-egg observation

    -- ---- adults half ----
    adults_verdict      ENUM('accepted','rejected') NULL,   -- NULL = not yet reviewed
    -- Snapshotted on accept (the detected pair). latin1_swedish_ci matches penguins.peng_num so the
    -- FKs form; notes stay utf8mb4 for macrons.
    male_peng_num       VARCHAR(20) CHARACTER SET latin1 COLLATE latin1_swedish_ci NULL,
    female_peng_num     VARCHAR(20) CHARACTER SET latin1 COLLATE latin1_swedish_ci NULL,
    adults_reviewed_by  INT NULL,
    adults_reviewed_at  TIMESTAMP NULL DEFAULT NULL,
    adults_note         VARCHAR(500) NULL,          -- required when rejected; optional on accept

    -- ---- offspring half ----
    chicks_verdict      ENUM('accepted','rejected') NULL,
    chicks              JSON NULL,                  -- snapshotted chipped-chick peng_nums (prefixed)
    dead_eggs           TINYINT UNSIGNED NOT NULL DEFAULT 0,
    dead_chicks         TINYINT UNSIGNED NOT NULL DEFAULT 0,
    fledged_unchipped   TINYINT UNSIGNED NOT NULL DEFAULT 0,
    chicks_reviewed_by  INT NULL,
    chicks_reviewed_at  TIMESTAMP NULL DEFAULT NULL,
    chicks_note         VARCHAR(500) NULL,

    created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY uniq_clutch (observation_id),
    KEY idx_male (male_peng_num),
    KEY idx_female (female_peng_num),
    KEY idx_adults_by (adults_reviewed_by),
    KEY idx_chicks_by (chicks_reviewed_by),
    CONSTRAINT chk_bv_counts CHECK (dead_eggs <= 10 AND dead_chicks <= 10 AND fledged_unchipped <= 10),
    -- Each half's verdict, reviewer and timestamp move together.
    CONSTRAINT chk_bv_adults_stamp CHECK ((adults_verdict IS NULL) = (adults_reviewed_by IS NULL)
                                      AND (adults_reviewed_by IS NULL) = (adults_reviewed_at IS NULL)),
    CONSTRAINT chk_bv_chicks_stamp CHECK ((chicks_verdict IS NULL) = (chicks_reviewed_by IS NULL)
                                      AND (chicks_reviewed_by IS NULL) = (chicks_reviewed_at IS NULL)),
    -- A rejection must say why.
    CONSTRAINT chk_bv_adults_reason CHECK (adults_verdict <> 'rejected'
                                      OR (adults_note IS NOT NULL AND CHAR_LENGTH(TRIM(adults_note)) > 0)),
    CONSTRAINT chk_bv_chicks_reason CHECK (chicks_verdict <> 'rejected'
                                      OR (chicks_note IS NOT NULL AND CHAR_LENGTH(TRIM(chicks_note)) > 0)),
    -- The row exists because a half was reviewed.
    CONSTRAINT chk_bv_reviewed CHECK (adults_verdict IS NOT NULL OR chicks_verdict IS NOT NULL),
    CONSTRAINT fk_bv_obs FOREIGN KEY (observation_id) REFERENCES observations (observation_id),
    CONSTRAINT fk_bv_male FOREIGN KEY (male_peng_num) REFERENCES penguins (peng_num) ON UPDATE CASCADE,
    CONSTRAINT fk_bv_female FOREIGN KEY (female_peng_num) REFERENCES penguins (peng_num) ON UPDATE CASCADE,
    CONSTRAINT fk_bv_adults_by FOREIGN KEY (adults_reviewed_by) REFERENCES observers (observer_id),
    CONSTRAINT fk_bv_chicks_by FOREIGN KEY (chicks_reviewed_by) REFERENCES observers (observer_id)
);

-- Verify:
-- SELECT CONSTRAINT_NAME, UPDATE_RULE, DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS
--   WHERE CONSTRAINT_SCHEMA = 'wildwatch_nestcheck' AND TABLE_NAME = 'breeding_verifications';
-- Expect: peng_num FKs UPDATE_RULE = CASCADE, everything else NO ACTION/RESTRICT.
