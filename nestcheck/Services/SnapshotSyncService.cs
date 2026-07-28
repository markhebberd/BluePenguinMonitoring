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
            /// <summary>The colony's people, for the observer/scribe/chipper pickers. Carried whole
            /// on every payload, so this list is the phone's answer to a rename or a departure.</summary>
            public List<DataStorageService.SyncUser>? Users;
            /// <summary>This user as the server sees them — the signing acronym and permit id the
            /// phone stamps chippings with, kept current without a separate call.</summary>
            public MeRow? Me;

            public class MeRow
            {
                public int observer_id { get; set; }
                public string? name { get; set; }
                public string? chip_acronym { get; set; }
                public string? falcon_id { get; set; }
            }
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

        /// <summary>The body as text, gunzipped if it arrives gzipped.
        ///
        /// The full snapshot is compressed by the endpoint itself and labelled
        /// Content-Encoding: identity, so nothing between here and there unpacks it — the client has
        /// to. The incremental branch sends plain JSON. Sniffing the two magic bytes covers both
        /// without depending on which headers survive a proxy.</summary>
        private static async Task<string> ReadBodyAsync(HttpResponseMessage resp)
        {
            var bytes = await resp.Content.ReadAsByteArrayAsync();
            if (bytes.Length >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b)
            {
                using var input = new MemoryStream(bytes);
                using var gz = new System.IO.Compression.GZipStream(input, System.IO.Compression.CompressionMode.Decompress);
                using var reader = new StreamReader(gz, System.Text.Encoding.UTF8);
                return await reader.ReadToEndAsync();
            }
            return System.Text.Encoding.UTF8.GetString(bytes);
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
                if (!resp.IsSuccessStatusCode)
                {
                    result.Error = $"Snapshot: HTTP {(int)resp.StatusCode}";
                    return result;
                }
                var body = await ReadBodyAsync(resp);
                if (string.IsNullOrWhiteSpace(body) || !body.TrimStart().StartsWith("{"))
                {
                    result.Error = $"Snapshot: HTTP {(int)resp.StatusCode}, unreadable body";
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

        /// <summary>Rebuild the views the screens read from the row store. Nothing derived is stored
        /// twice: TodayBoxes and PreviousBoxes are a projection of LocalDb, so a row that changed or
        /// went away is reflected everywhere without a second place to keep in step.
        ///
        /// An unsent local edit is never overwritten — same rule as the old download, and the only
        /// reason a box may hold something the server hasn't got.</summary>
        internal static void DeriveViews(LocalDb db, ColonyState colonyState, DateTime nzToday,
            Func<DateTime, DateTime> toNz, Func<ColonyState, string, DateTime, bool> hasUnsentLocalEdit)
        {
            var byBox = new Dictionary<string, List<LocalDb.ObsRow>>();
            foreach (var o in db.Observations.Values)
            {
                var box = db.BoxNameFor(o.location_id);
                if (string.IsNullOrEmpty(box)) continue;   // a location the phone hasn't seen yet
                if (!byBox.TryGetValue(box, out var list)) byBox[box] = list = new List<LocalDb.ObsRow>();
                list.Add(o);
            }

            var todaySeen = new HashSet<string>();
            foreach (var kv in byBox)
            {
                var box = kv.Key;
                var ordered = kv.Value
                    .OrderByDescending(o => ParseUtc(o.observation_time_utc))
                    .ToList();
                var todayRow = ordered.FirstOrDefault(o => toNz(ParseUtc(o.observation_time_utc)).Date == nzToday);
                // The previous visit is the newest row from an earlier day — not "the second row",
                // which on a box visited twice in one day would show today's data as history.
                var prevRow = ordered.FirstOrDefault(o => toNz(ParseUtc(o.observation_time_utc)).Date < nzToday);

                if (todayRow != null && !hasUnsentLocalEdit(colonyState, box, nzToday))
                {
                    colonyState.TodayBoxes[box] = ToObservation(db, todayRow, box);
                    todaySeen.Add(box);
                }
                if (prevRow != null) colonyState.PreviousBoxes[box] = ToObservation(db, prevRow, box);
                else colonyState.PreviousBoxes.Remove(box);
            }

            // A box whose today row the server no longer has (deleted there, or never existed) drops
            // off today's board, unless the phone is holding work for it that hasn't been sent.
            foreach (var gone in colonyState.TodayBoxes.Keys
                         .Where(b => !todaySeen.Contains(b) && !hasUnsentLocalEdit(colonyState, b, nzToday))
                         .ToList())
                colonyState.TodayBoxes.Remove(gone);

            // Biometrics, keyed as the rest of the app keys them (bird + date), pending edits kept.
            foreach (var stale in colonyState.TodayBiometrics
                         .Where(kv => !kv.Value.IsPendingUpload).Select(kv => kv.Key).ToList())
                colonyState.TodayBiometrics.Remove(stale);
            foreach (var b in db.Biometrics.Values)
            {
                if (string.IsNullOrEmpty(b.peng_num) || string.IsNullOrEmpty(b.observation_date)) continue;
                var key = ColonyState.BiometricKey(b.peng_num!, b.observation_date!);
                if (colonyState.TodayBiometrics.ContainsKey(key)) continue;   // an unsent edit stands
                colonyState.TodayBiometrics[key] = new BiometricRecord
                {
                    PengNum = b.peng_num!, ObservationDate = b.observation_date!,
                    Weight = b.weight, FlipperLength = b.flipper_length, ObservedSex = b.observed_sex,
                    ConditionMoulting = b.is_moulting != 0, ConditionTicks = b.condition_ticks != 0,
                    Notes = b.notes, BiometricId = b.biometric_id, IsPendingUpload = false,
                };
            }
        }

        internal static DateTime ParseUtc(string? s) =>
            DateTime.TryParse(s, null, System.Globalization.DateTimeStyles.AssumeUniversal
                                     | System.Globalization.DateTimeStyles.AdjustToUniversal, out var t)
                ? t : DateTime.MinValue;

        private static BoxObservation ToObservation(LocalDb db, LocalDb.ObsRow o, string box)
        {
            var obs = BoxObservation.FromServerData(o.observation_id, o.location_id,
                o.observation_time_utc ?? "", o.adults, o.eggs, o.chicks,
                o.breeding_status, o.gate_status, o.notes ?? "", null,
                db.ObserverName(o.observer_id), o.failed_eggs, o.dead_chicks);
            obs.BoxName = box;
            foreach (var s in db.ScansOf(o.observation_id))
                obs.ScannedIds.Add(new ScanRecord { BirdId = s.pit_id ?? "", Timestamp = ParseUtc(o.observation_time_utc) });
            for (int n = 0; n < o.no_scan; n++)
                obs.ScannedIds.Add(new ScanRecord { BirdId = $"NOSCAN_{n + 1}", Timestamp = obs.WhenDataCollectedUtc });
            obs.IsPendingUpload = false;
            return obs;
        }

        /// <summary>The bird cache the scanner reads, rebuilt from the rows. Keyed by cleaned pit id,
        /// exactly as the old penguins.php path keyed it, so scanning is unchanged.</summary>
        internal static Dictionary<string, PenguinData> DeriveBirds(LocalDb db)
        {
            var birds = new Dictionary<string, PenguinData>();
            // Field-sex evidence, weighted as the server weighted it: a "probably" counts 2, a
            // "maybe" 1. Computed here because the phone now holds every biometric row, so the
            // tally is a local sum rather than two more columns to fetch and keep in step.
            var guessM = new Dictionary<string, int>();
            var guessF = new Dictionary<string, int>();
            foreach (var b in db.Biometrics.Values)
            {
                if (string.IsNullOrEmpty(b.peng_num)) continue;
                var s = (b.observed_sex ?? "").ToUpperInvariant();
                int m = s is "PM" or "M" ? 2 : s == "MM" ? 1 : 0;
                int f = s is "PF" or "F" ? 2 : s == "MF" ? 1 : 0;
                if (m > 0) guessM[b.peng_num!] = guessM.GetValueOrDefault(b.peng_num!) + m;
                if (f > 0) guessF[b.peng_num!] = guessF.GetValueOrDefault(b.peng_num!) + f;
            }
            foreach (var chip in db.Chips.Values)
            {
                if (string.IsNullOrEmpty(chip.pit_id) || chip.pit_id.Length < 8) continue;
                if (string.IsNullOrEmpty(chip.peng_num) || !db.Penguins.TryGetValue(chip.peng_num!, out var p)) continue;
                var clean = new string(chip.pit_id.Where(char.IsLetterOrDigit).ToArray()).ToUpper();
                var eight = clean.Length >= 8 ? clean.Substring(clean.Length - 8) : clean;
                if (eight.Length != 8) continue;

                var chipDate = DateTime.TryParse(chip.chip_date, out var cd) ? cd : DateTime.MinValue;
                LifeStage stage;
                if (p.is_dead == 1) stage = LifeStage.Dead;
                else if (p.chipped_as_adult == 1) stage = LifeStage.Adult;
                else if (chipDate > DateTime.MinValue && DateTime.UtcNow > chipDate.AddMonths(3)) stage = LifeStage.Returnee;
                else stage = LifeStage.Chick;

                // An active chip wins: a rechipped bird keeps one record, under the tag it wears now.
                if (birds.TryGetValue(clean, out var existing) && chip.is_active != 1 && !string.IsNullOrEmpty(existing.FullPitId))
                    continue;

                birds[clean] = new PenguinData
                {
                    FullPitId = chip.pit_id, ScannedId = eight, PengNum = p.peng_num,
                    LastKnownLifeStage = stage, Sex = p.sex ?? "", ChipDate = chipDate,
                    ChipAs = p.chipped_as_adult == 1 ? "Adult" : "", ChickSizeCode = p.chick_size_code ?? "",
                    HasAlert = p.alert == 1,
                };
            }
            return birds;
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
                var users = new List<DataStorageService.SyncUser>();
                foreach (var o in observers)
                {
                    var id = o.Value<int?>("observer_id");
                    var fname = o.Value<string>("observer_name");
                    if (!id.HasValue) continue;
                    var surname = o.Value<string>("surname");
                    var full = string.Join(" ", new[] { fname, surname }.Where(s => !string.IsNullOrWhiteSpace(s)));
                    if (!string.IsNullOrEmpty(full)) db.Observers[id.Value] = full;
                    // Only people who can actually be picked today: a departed or deactivated
                    // account still resolves a name above, but must not appear in a picker.
                    bool active = o.Value<int?>("active") == 1 || o.Value<bool?>("active") == true;
                    bool deleted = o.Value<int?>("deleted") == 1 || o.Value<bool?>("deleted") == true;
                    if (active && !deleted)
                        users.Add(new DataStorageService.SyncUser {
                            id = id.Value, name = full, f_name = fname, surname = surname,
                            chip_acronym = o.Value<string>("chip_acronym"), falcon_id = o.Value<string>("falcon_id"),
                        });
                }
                r.Observers = db.Observers.Count;
                r.Users = users;
            }

            if (payload["me"] is JObject me)
                r.Me = new ApplyResult.MeRow {
                    observer_id = me.Value<int?>("observer_id") ?? 0,
                    name = me.Value<string>("name"),
                    chip_acronym = me.Value<string>("chip_acronym"),
                    falcon_id = me.Value<string>("falcon_id"),
                };

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
