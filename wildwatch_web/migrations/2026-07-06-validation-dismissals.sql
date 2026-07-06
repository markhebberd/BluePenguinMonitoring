-- Per-colony "this integrity-check error was reviewed and is fine" dismissals.
-- Integrity checks are computed client-side from the colony cache; a dismissal
-- suppresses ONE specific flagged error so it drops out of the error list.
--   error_type    which check (e.g. 'improbable_counts', 'bird_two_boxes')
--   error_key     stable identity of the flagged item (peng_num|date, box|date, ...)
--   content_hash  fingerprint of the exact values that were approved. If the
--                 underlying data later changes, the hash no longer matches and
--                 the error re-surfaces for re-review (so a dismissal can never
--                 silently hide a newly-wrong value).
CREATE TABLE validation_dismissals (
    id            INT AUTO_INCREMENT PRIMARY KEY,
    colony_id     INT NOT NULL,
    error_type    VARCHAR(40)  NOT NULL,
    error_key     VARCHAR(255) NOT NULL,
    content_hash  VARCHAR(64)  NOT NULL,
    reason        VARCHAR(255) NULL,
    dismissed_by  INT NULL,
    dismissed_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_dismissal (colony_id, error_type, error_key),
    KEY idx_colony (colony_id)
);
