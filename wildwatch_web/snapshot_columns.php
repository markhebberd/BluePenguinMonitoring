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
 */

const SNAP_COLS_OBS  = 'o.observation_id, o.location_id, o.observation_time_utc, o.monitor_filename, o.adults, o.eggs, o.chicks, o.breeding_status, o.gate_status, o.notes, o.no_scan, o.fledged_unchipped, o.is_deleted';
const SNAP_COLS_SCAN = 'ps.scan_id, ps.observation_id, ps.pit_id, ps.is_deleted as scan_deleted';
const SNAP_COLS_PENG = 'peng_num, chipped_as_adult, sex, is_dead, death_date, vid_for_scanner, chick_size_code, notes';
const SNAP_COLS_CHIP = 'pit_id, peng_num, chip_date, is_active, chip_box, location_id, chip_by, solo';
const SNAP_COLS_LOC  = 'location_id, location_name, persistent_notes, watched, pit_id, latitude, longitude, accuracy';
const SNAP_COLS_BIO  = 'biometric_id, peng_num, observation_id, observation_date, sex, observed_sex, weight, flipper_length, body_length, beak_length, condition_healthy, condition_ticks, is_moulting, disposition_aggressive, disposition_passive, notes, is_deleted';

// Human-verified breeding truth (single table). Reviewer names come from the observer joins
// (oa/oc) so the client shows "accepted by <name>" without an observers table. chicks is a JSON
// array of peng_nums (prefix-stripped per element in getVerificationData). Alias v = breeding_verifications.
const SNAP_COLS_VER = 'v.verification_id, v.observation_id, v.adults_verdict, v.male_peng_num, v.female_peng_num, v.adults_reviewed_by, oa.observer_name AS adults_reviewed_by_name, v.adults_reviewed_at, v.adults_note, v.chicks_verdict, v.chicks, v.dead_eggs, v.dead_chicks, v.fledged_unchipped, v.chicks_reviewed_by, oc.observer_name AS chicks_reviewed_by_name, v.chicks_reviewed_at, v.chicks_note, v.created_at, v.updated_at';
