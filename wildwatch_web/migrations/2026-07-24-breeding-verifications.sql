-- Human-verified breeding truth: what a person confirms happened at a nest — the parents and
-- the outcome of one clutch.
--
-- PURPOSE: a saved ground-truth fixture. The breeding-detection algorithm evolves (see the
-- sightings/attendStart work in App.tsx); regression compares the new detector's pair/chicks/
-- outcome for each verified clutch against the human truth here and flags divergence.
--
-- ENTRY DATE & EDIT HISTORY live in audit_log. These tables are registered in WW_TABLE_KEYS, so
-- every write goes through wwAuditedInsert/Update/Delete and lands an audit_log row keyed by
-- (table_name, record_id): INSERT carries the full row, UPDATE the changed fields as old=>new,
-- DELETE the whole prior row. created_at is the entry date; per-half verified_at is when each
-- assertion was made; audit_log holds the rest.
--
-- One row per clutch, anchored to the attempt's FIRST observation with eggs — the observation
-- the client calls the clutch start (Clutch.startObsTime). It identifies the nest (via
-- observations.location_id) and the attempt together, so a box's two clutches in a season get
-- two rows. UNIQUE on the anchor: one verified answer per clutch, edited in place. location and
-- colony come from the observation join, keeping a single source of truth for each.
--
-- TWO INDEPENDENT HALVES. Who the parents were and what the attempt produced are separate
-- judgements, often made at different times by different people (the pair during guard, the
-- outcome at fledging). Each half carries its own verifier, timestamp and notes, and counts as
-- verified once its *_verified_by is set:
--
--   ADULTS   male_peng_num / female_peng_num   the parents (either may be NULL: one known
--                                              parent is still worth recording)
--            adults_verified_by / _at / _notes
--
--   CHICKS   breeding_verification_chicks      the chicks produced, one row per chipped chick
--            dead_eggs / dead_chicks           offspring lost, by stage
--            fledged_unchipped                 chicks that fledged without being chipped
--            chicks_verified_by / _at / _notes
--
-- Verifier state carries the meaning: NULL verifier = still to judge; verifier set with 0 counts
-- and no chick rows = verified as producing nothing. Read the counts once chicks_verified_by is set.
--
-- Referential integrity keeps every row anchored to live data:
--   observation_id     -> observations  (RESTRICT: the anchor observation stays while verified)
--   *_peng_num         -> penguins      (ON UPDATE CASCADE carries a colony-prefix renumber
--                                        through, matching penguin_chips/penguin_biometric_data;
--                                        DELETE RESTRICT keeps a cited parent or chick alive)
--   *_verified_by      -> observers     (every assertion attributes to a person)
--
-- A soft-deleted anchor (observations.is_deleted) stays visible to the FK, so a verification can
-- outlive its observation's soft delete; an integrity check re-anchors or clears those.

CREATE TABLE breeding_verifications (
    verification_id    INT AUTO_INCREMENT PRIMARY KEY,
    observation_id     INT NOT NULL,              -- first observation with eggs in the window

    -- ---- adults half ----
    -- peng_num columns are pinned to latin1_swedish_ci to match penguins.peng_num exactly.
    -- The legacy tables are latin1 while the database default is utf8mb4, and InnoDB refuses
    -- a foreign key whose charset/collation differs from the referenced column (errno 150).
    -- Only peng_num columns are pinned — notes stay utf8mb4 so they can hold macrons.
    male_peng_num      VARCHAR(20) CHARACTER SET latin1 COLLATE latin1_swedish_ci NULL,
    female_peng_num    VARCHAR(20) CHARACTER SET latin1 COLLATE latin1_swedish_ci NULL,
    adults_verified_by INT NULL,                  -- NULL = adults not yet verified
    adults_verified_at TIMESTAMP NULL DEFAULT NULL,
    adults_notes       VARCHAR(255) NULL,         -- why the verifier concluded this pair

    -- ---- chicks half ----
    dead_eggs          TINYINT UNSIGNED NOT NULL DEFAULT 0,
    dead_chicks        TINYINT UNSIGNED NOT NULL DEFAULT 0,
    fledged_unchipped  TINYINT UNSIGNED NOT NULL DEFAULT 0,
    chicks_verified_by INT NULL,                  -- NULL = outcome not yet verified
    chicks_verified_at TIMESTAMP NULL DEFAULT NULL,
    chicks_notes       VARCHAR(255) NULL,

    created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY uniq_clutch (observation_id),
    KEY idx_male (male_peng_num),
    KEY idx_female (female_peng_num),
    KEY idx_adults_by (adults_verified_by),
    KEY idx_chicks_by (chicks_verified_by),
    -- Distinct parents (male <> female) is enforced in the write endpoint: MariaDB reserves CHECK
    -- for columns free of a cascading FK (errno 1901), and the ON UPDATE CASCADE here wins the column.
    CONSTRAINT chk_bv_counts CHECK (dead_eggs <= 10 AND dead_chicks <= 10 AND fledged_unchipped <= 10),
    -- Each half's verifier and timestamp move together.
    CONSTRAINT chk_bv_adults_stamp CHECK ((adults_verified_by IS NULL) = (adults_verified_at IS NULL)),
    CONSTRAINT chk_bv_chicks_stamp CHECK ((chicks_verified_by IS NULL) = (chicks_verified_at IS NULL)),
    -- Every row has at least one verified half; clearing the last one deletes the row.
    CONSTRAINT chk_bv_verified_half CHECK (adults_verified_by IS NOT NULL OR chicks_verified_by IS NOT NULL),
    CONSTRAINT fk_bv_obs FOREIGN KEY (observation_id) REFERENCES observations (observation_id),
    CONSTRAINT fk_bv_male FOREIGN KEY (male_peng_num) REFERENCES penguins (peng_num) ON UPDATE CASCADE,
    CONSTRAINT fk_bv_female FOREIGN KEY (female_peng_num) REFERENCES penguins (peng_num) ON UPDATE CASCADE,
    CONSTRAINT fk_bv_adults_by FOREIGN KEY (adults_verified_by) REFERENCES observers (observer_id),
    CONSTRAINT fk_bv_chicks_by FOREIGN KEY (chicks_verified_by) REFERENCES observers (observer_id)
);

-- The chicks a verified attempt produced, part of the chicks half. A separate table because the
-- count is open-ended and because parentage is worth querying from the chick's side too.
-- DELETE RESTRICT makes clearing a verification's chicks an explicit, audited step per row —
-- the rule wwAuditedDeleteObservationChildren already follows for an observation's scans.
CREATE TABLE breeding_verification_chicks (
    id              INT AUTO_INCREMENT PRIMARY KEY,   -- surrogate key: the gateway writes by single PK
    verification_id INT NOT NULL,
    peng_num        VARCHAR(20) CHARACTER SET latin1 COLLATE latin1_swedish_ci NOT NULL,
    UNIQUE KEY uniq_verification_chick (verification_id, peng_num),
    KEY idx_chick (peng_num),
    CONSTRAINT fk_bvc_verification FOREIGN KEY (verification_id) REFERENCES breeding_verifications (verification_id),
    CONSTRAINT fk_bvc_peng FOREIGN KEY (peng_num) REFERENCES penguins (peng_num) ON UPDATE CASCADE
);

-- ============================================================================
-- Disagreement: a logged reason that a clutch's assignment looks wrong, kept beside the data. A
-- reviewer who agrees edits the verification (audited) and deletes the disagreement (audited).
--
-- Many per clutch, from different people. Anchored to the observation, so it applies to the
-- algorithm's raw assignment and to a saved verification alike. `subject` names the disputed half
-- (adults vs chicks); `reason` is mandatory. raised_by/at denormalise the audit_log INSERT so a
-- listing reads from this row alone.
CREATE TABLE breeding_verification_disagreements (
    disagreement_id INT AUTO_INCREMENT PRIMARY KEY,
    observation_id  INT NOT NULL,                 -- the clutch anchor, as in breeding_verifications
    subject         ENUM('adults','chicks') NOT NULL,
    reason          VARCHAR(500) NOT NULL,        -- why the assignment looks wrong; never blank
    raised_by       INT NOT NULL,
    raised_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_obs (observation_id),
    KEY idx_raised_by (raised_by),
    CONSTRAINT chk_bvd_reason CHECK (CHAR_LENGTH(TRIM(reason)) > 0),
    CONSTRAINT fk_bvd_obs FOREIGN KEY (observation_id) REFERENCES observations (observation_id),
    CONSTRAINT fk_bvd_by  FOREIGN KEY (raised_by) REFERENCES observers (observer_id)
);

-- Verify:
-- SELECT CONSTRAINT_NAME, UPDATE_RULE, DELETE_RULE FROM information_schema.REFERENTIAL_CONSTRAINTS
--   WHERE CONSTRAINT_SCHEMA = 'wildwatch_nestcheck' AND TABLE_NAME LIKE 'breeding_verification%';
-- Expect: peng_num FKs UPDATE_RULE = CASCADE, everything else NO ACTION/RESTRICT.
--
-- Clutches awaiting each kind of verification:
-- SELECT l.location_name, ob.observation_time_utc,
--        v.adults_verified_by IS NOT NULL AS adults_done,
--        v.chicks_verified_by IS NOT NULL AS chicks_done
--   FROM breeding_verifications v
--   JOIN observations ob ON ob.observation_id = v.observation_id
--   JOIN observation_locations l ON l.location_id = ob.location_id;
--
-- Disagreements to review, newest first:
-- SELECT l.location_name, d.subject, d.reason, o.observer_name AS raised_by, d.raised_at
--   FROM breeding_verification_disagreements d
--   JOIN observations ob ON ob.observation_id = d.observation_id
--   JOIN observation_locations l ON l.location_id = ob.location_id
--   JOIN observers o ON o.observer_id = d.raised_by
--  ORDER BY d.raised_at DESC;
--
-- Edit history of one verification (entry, every field change, deletion):
-- SELECT action, changed_fields, observer_id, change_timestamp
--   FROM audit_log WHERE table_name = 'breeding_verifications' AND record_id = ?
--  ORDER BY change_timestamp;
