# Nestcheck sync: moving to the incremental snapshot feed

Status: **in progress.** The local row store and the apply logic are written
(`Models/LocalDb.cs`, `Services/SnapshotSyncService.cs`) and are not yet wired into
`SyncWithServer` — the app still runs the old download path. Nothing here is live.

## Why

The old download is a full pull of a narrow slice: the **latest observation per box** (plus one
previous for boxes done today), **today's** biometrics, all birds, all locations, all users. Two
consequences, both real:

- Edit or delete anything on the website that isn't a box's latest observation or a biometric dated
  today and the phone never learns. There is no watermark and no tombstone, so a row outside the
  fetched slice can neither be updated nor removed locally.
- Every sync pulls ~92KB regardless. `events.php` only *triggers* the sync; it doesn't narrow it.

## What replaces it

`snapshot.php` — the feed the website's own cache already runs on — serves exactly what's needed:

| Feed key | Table | Tombstone |
|---|---|---|
| `observations` | observations (colony-scoped, `updated_at >= since`) | `is_deleted` |
| `scans` | penguin_scans of changed observations, or deleted since | `scan_deleted` |
| `penguins` | penguins (`updated_at >= since`) | `is_dead` / `death_date` (no row delete) |
| `chips` | penguin_chips created since, or of a changed bird | — |
| `locations` | observation_locations (`updated_at >= since`) | — |
| `biometrics` | penguin_biometric_data, via `audit_log` — **all dates**, not just today | `is_deleted` |
| `day_notes` | day_notes for the colony | — |
| `observers` | users, in FULL every time; client replaces wholesale | `deleted` flag |

`snapshot_time` comes back as the max `updated_at` across those tables rather than the server
clock, so a row written during the request isn't skipped. Store it; send it as `since` next time.

**No server change is needed.** The columns are already shared with `bird-detail.php` through
`snapshot_columns.php`.

## App shape

The app's caches are keyed by box name (`TodayBoxes`, `PreviousBoxes`) — a shape an incremental
feed can't be applied to, since a feed row identifies itself by id, not by which box's "latest" it
happens to be. So:

1. **`LocalDb`** — row stores keyed the way the server keys them: observations by
   `observation_id`, scans by `scan_id`, biometrics by `biometric_id`, penguins by `peng_num`,
   chips by `pit_id`, locations by `location_id`, day notes by `note_date`, plus the watermark.
   Persisted as one file. Tombstoned rows are **removed** on apply, so a delete propagates.
2. **Derive the views** — `TodayBoxes` / `PreviousBoxes` are rebuilt from `LocalDb` after each
   apply, so every screen keeps working unchanged. This is what makes the swap possible without
   rewriting the UI in the same release.
3. **The upload queue is untouched.** Pending observations, biometrics, queued birds, box notes,
   watched flags and day notes keep their existing paths — they already queue and retry. An unsent
   local edit always wins over a feed row for the same box+day (`HasUnsentLocalEdit`).

## Order of work

1. `LocalDb` + apply + derive, unwired. ← written, not yet wired
2. Wire the download half of `SyncWithServer` to it; keep the old endpoints for one release so a
   field failure can be compared against the previous behaviour.
3. Full pull on first run and whenever `LocalDb.SchemaVersion` changes; incremental after.
4. Retire `sync.php`'s download branch, `penguins.php` and the biometric `crud` list from the app.
   `sync.php`'s **upload** branch stays — it is the write path.
5. Extend `contract_check.php` to assert the snapshot payload against `LocalDb`'s expectations, so
   this feed is covered by the same deploy gate as the old one.

## Rules that must hold

- A row the feed marks deleted is removed locally; anything derived from it is rebuilt without it.
- A local edit that hasn't been uploaded is never overwritten by a feed row.
- The watermark advances **only** on a fully applied payload. A partial apply must not record it,
  or the skipped rows are skipped forever.
- Parse stays tolerant (`LenientParse`): one unreadable field costs that field, not the sync.
