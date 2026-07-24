<?php
/**
 * Shared SELECT column lists for the box/bird tables.
 *
 * snapshot.php (full sync -> IndexedDB, used by wildwatch + nestcheck sync) and
 * bird-detail.php (live, scoped fetch -> nestcheck bird-panel WebView) both build their
 * queries from these constants. Because both return identically-shaped rows, the client
 * assembly (queryBirdDetailInner / computeBoxFamilies) produces the identical panel whether
 * it runs over a full mem or a scoped mem. Change a column here and both stay in sync.
 *
 * Aliases (o. / ps.) match the joins used in both files. The incremental snapshot path adds
 * ', o.updated_at' to the observations list; nothing else differs.
 *
 * observer_id is the id only — names come from the snapshot's `observers` list (getObservers),
 * so a name isn't repeated on every one of a colony's tens of thousands of rows.
 */

const SNAP_COLS_OBS  = 'o.observation_id, o.location_id, o.observation_time_utc, o.adults, o.eggs, o.chicks, o.breeding_status, o.gate_status, o.notes, o.no_scan, o.fledged_unchipped, o.is_deleted, o.observer_id';
const SNAP_COLS_SCAN = 'ps.scan_id, ps.observation_id, ps.pit_id, ps.is_deleted as scan_deleted';
const SNAP_COLS_PENG = 'peng_num, chipped_as_adult, sex, is_dead, death_date, vid_for_scanner, chick_size_code, notes';
const SNAP_COLS_CHIP = 'pit_id, peng_num, chip_date, is_active, chip_box, location_id, chip_by, solo';
const SNAP_COLS_LOC  = 'location_id, location_name, persistent_notes, watched, pit_id, latitude, longitude, accuracy';
const SNAP_COLS_BIO  = 'biometric_id, peng_num, observation_id, observation_date, sex, observed_sex, weight, flipper_length, body_length, beak_length, condition_healthy, condition_ticks, is_moulting, disposition_aggressive, disposition_passive, notes, is_deleted';

// Human-verified breeding truth (single table). Reviewer names come from the observer joins
// (oa/oc) so the client shows "accepted by <name>" without an observers table. chicks is a JSON
// array of peng_nums (prefix-stripped per element in getVerificationData). Alias v = breeding_verifications.
// The day's note — one row per colony per NZ date. Alias d = day_notes. updated_at rides along
// so the client can tell an edited note from an unchanged one on an incremental snapshot.
const SNAP_COLS_DAYNOTE = 'd.day_note_id, d.note_date, d.note, d.updated_at';

const SNAP_COLS_VER = 'v.verification_id, v.observation_id, v.adults_verdict, v.male_peng_num, v.female_peng_num, v.adults_reviewed_by, oa.observer_name AS adults_reviewed_by_name, v.adults_reviewed_at, v.adults_note, v.chicks_verdict, v.chicks, v.dead_eggs, v.dead_chicks, v.fledged_unchipped, v.chicks_reviewed_by, oc.observer_name AS chicks_reviewed_by_name, v.chicks_reviewed_at, v.chicks_note, v.created_at, v.updated_at';

/** Every observer, id → name, so the client can name whoever recorded an observation from
 *  observations.observer_id alone — the id is on the row, the name is looked up once rather
 *  than repeated on tens of thousands of rows. A few dozen rows, and not colony-scoped (an
 *  observer works across colonies), so it rides every payload in FULL and the client replaces
 *  its store wholesale: that is how a rename or a removed account reaches the cache.
 *  Name only — no email, no hash. */
function getObservers($pdo) {
    return ['observers' => $pdo->query("SELECT observer_id, observer_name FROM observers ORDER BY observer_id")->fetchAll()];
}
