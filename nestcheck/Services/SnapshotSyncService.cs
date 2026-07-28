using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using PenguinMonitor.Models;

namespace PenguinMonitor.Services
{
    /// <summary>Incremental download: rows changed since the last watermark, applied to LocalDb.
    ///
    /// Replaces a full pull of a narrow slice (each box's latest observation, today's biometrics)
    /// with the feed the website's own cache runs on. That slice is why an edit or a delete made on
    /// the website never reached the phone unless it happened to land on a box's most recent row.
    ///
    /// Not yet wired into SyncWithServer — see SYNC-INCREMENTAL.md for the order of work.</summary>
    internal static class SnapshotSyncService
    {
        internal const string WILDWATCH_SNAPSHOT_URL = "https://wildwatch.co.nz/api/snapshot.php";
        private const string LOCAL_DB_FILENAME = "localDb.json";

        internal class ApplyResult
        {
            public bool Incremental;
            public int Observations, Scans, Biometrics, Penguins, Chips, Locations, DayNotes, Observers;
            public int Deleted;
            public string? Error;
            public HashSet<string> PayloadWarnings = new();
            public bool Ok => Error == null;
            public override string ToString() =>
                $"{(Incremental ? "incremental" : "full")}: {Observations} obs, {Scans} scans, {Biometrics} bio, "
              + $"{Penguins} birds, {Locations} boxes, {DayNotes} day notes, {Deleted} removed";
        }

        // ===== Persistence =====

        internal static LocalDb Load(Android.Content.Context context)
        {
            try
            {
                var path = Path.Combine(context.FilesDir?.AbsolutePath ?? "", LOCAL_DB_FILENAME);
                if (File.Exists(path))
                {
                    var db = JsonConvert.DeserializeObject<LocalDb>(File.ReadAllText(path));
                    // A cache built to a different shape is not repaired, it's refetched: guessing at
                    // what an older row meant is how a stale field survives a release.
                    if (db != null && db.Version == LocalDb.SchemaVersion) return db;
                }
            }
            catch (Exception ex) { System.Diagnostics.Debug.WriteLine($"LocalDb load: {ex.Message}"); }
            return new LocalDb { Version = LocalDb.SchemaVersion };
        }

        internal static void Save(Android.Content.Context context, LocalDb db)
        {
            try
            {
                var path = Path.Combine(context.FilesDir?.AbsolutePath ?? "", LOCAL_DB_FILENAME);
                var tmp = path + ".tmp";
                File.WriteAllText(tmp, JsonConvert.SerializeObject(db));
                try { if (File.Exists(path)) File.Copy(path, path + ".bak", true); } catch { }
                File.Move(tmp, path, true);
            }
            catch (Exception ex) { System.Diagnostics.Debug.WriteLine($"LocalDb save: {ex.Message}"); }
        }

        // ===== Fetch + apply =====

        /// <summary>Pull what changed and apply it. A payload that can't be read leaves the watermark
        /// where it was, so the same rows come again next sync rather than being lost.</summary>
        internal static async Task<ApplyResult> SyncAsync(HttpClient http, Android.Content.Context context,
            LocalDb db, string token, int colonyId)
        {
            var result = new ApplyResult { Incremental = !string.IsNullOrEmpty(db.Watermark) };
            try
            {
                var url = $"{WILDWATCH_SNAPSHOT_URL}?colony_id={colonyId}"
                        + (result.Incremental ? $"&since={Uri.EscapeDataString(db.Watermark)}" : "");
                var req = new HttpRequestMessage(HttpMethod.Get, url);
                req.Headers.Add("Authorization", $"Bearer {token}");
                var resp = await http.SendAsync(req);
                var body = await resp.Content.ReadAsStringAsync();
                if (!resp.IsSuccessStatusCode || string.IsNullOrWhiteSpace(body) || !body.TrimStart().StartsWith("{"))
                {
                    result.Error = $"Snapshot: HTTP {(int)resp.StatusCode}";
                    return result;
                }

                var payload = JObject.Parse(body);
                var snapshotTime = payload.Value<string>("snapshot_time");
                if (string.IsNullOrEmpty(snapshotTime))
                {
                    // Without a watermark to record, applying would mean either replaying every row
                    // next time or losing the ones in between. Neither is worth the rows on offer.
                    result.Error = "Snapshot: no snapshot_time in payload";
                    return result;
                }

                Apply(db, payload, result);

                // Only now, with the whole payload applied, does the watermark move.
                db.Watermark = snapshotTime;
                db.Version = LocalDb.SchemaVersion;
                Save(context, db);
                return result;
            }
            catch (Exception ex)
            {
                result.Error = ex.Message;
                return result;
            }
        }

        /// <summary>Apply one payload. Rows the server flags deleted are removed; a table sent in
        /// full (observers) replaces its store, which is how a removal reaches the phone for a table
        /// with no tombstone of its own.</summary>
        private static void Apply(LocalDb db, JObject payload, ApplyResult r)
        {
            r.Observations = Merge<LocalDb.ObsRow, int>(payload, "observations", db.Observations,
                row => row.observation_id, row => row.is_deleted != 0, r);
            r.Scans = Merge<LocalDb.ScanRow, int>(payload, "scans", db.Scans,
                row => row.scan_id, row => row.scan_deleted != 0, r);
            r.Biometrics = Merge<LocalDb.BioRow, int>(payload, "biometrics", db.Biometrics,
                row => row.biometric_id, row => row.is_deleted != 0, r);
            r.Penguins = Merge<LocalDb.PengRow, string>(payload, "penguins", db.Penguins,
                row => row.peng_num, _ => false, r);
            r.Chips = Merge<LocalDb.ChipRow, string>(payload, "chips", db.Chips,
                row => row.pit_id, _ => false, r);
            r.Locations = Merge<LocalDb.LocRow, int>(payload, "locations", db.Locations,
                row => row.location_id, _ => false, r);
            r.DayNotes = Merge<LocalDb.DayNoteRow, string>(payload, "day_notes", db.DayNotes,
                row => row.note_date, _ => false, r);

            // Observers ride every payload in full — replace wholesale, so a removed account goes.
            var observers = payload["observers"] as JArray;
            if (observers != null)
            {
                db.Observers.Clear();
                foreach (var o in observers)
                {
                    var id = o.Value<int?>("observer_id");
                    var name = o.Value<string>("observer_name");
                    if (id.HasValue && !string.IsNullOrEmpty(name)) db.Observers[id.Value] = name!;
                }
                r.Observers = db.Observers.Count;
            }

            // An observation that went takes its scans with it — the server sends the observation's
            // tombstone but not one per scan, and orphaned scans would keep showing birds in a box
            // whose visit no longer exists.
            foreach (var orphan in db.Scans.Where(kv => !db.Observations.ContainsKey(kv.Value.observation_id))
                                           .Select(kv => kv.Key).ToList())
            {
                db.Scans.Remove(orphan);
                r.Deleted++;
            }
        }

        /// <summary>Merge one table's rows into its store: upsert by key, remove where the row says
        /// it's deleted. Returns how many rows the payload carried.</summary>
        private static int Merge<TRow, TKey>(JObject payload, string key, Dictionary<TKey, TRow> store,
            Func<TRow, TKey> keyOf, Func<TRow, bool> isDeleted, ApplyResult r) where TKey : notnull
        {
            if (payload[key] is not JArray rows) return 0;
            int seen = 0;
            foreach (var token in rows)
            {
                TRow row;
                try { row = token.ToObject<TRow>()!; }
                catch (Exception ex)
                {
                    // One unreadable row costs that row, not the table — the same rule the rest of
                    // the sync now follows.
                    r.PayloadWarnings.Add($"{key}: {ex.Message}");
                    continue;
                }
                if (row == null) continue;
                seen++;
                var k = keyOf(row);
                if (isDeleted(row))
                {
                    if (store.Remove(k)) r.Deleted++;
                }
                else store[k] = row;
            }
            return seen;
        }
    }
}
