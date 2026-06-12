/**
 * Client-side database cache.
 * Loads full snapshot on first visit, incremental syncs after.
 * Data lives in memory for instant queries; IndexedDB for persistence across reloads.
 */

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('ww_token');
  return token ? { 'Authorization': `Bearer ${token}` } : {};
}

const DB_NAME = 'wildwatch';
const DB_VERSION = 1;
const CACHE_VERSION = 2; // Bump to force all clients to full re-sync
const STORES = ['observations', 'scans', 'penguins', 'chips', 'locations', 'biometrics', 'meta'] as const;
type StoreNames = typeof STORES[number];

// ============ Store subscriptions ============

let storeVersion = 0;
const subscribers = new Set<() => void>();

function notifySubscribers() {
  storeVersion++;
  for (const cb of subscribers) cb();
}

export function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

export function getStoreVersion(): number {
  return storeVersion;
}

// ============ In-memory cache ============

interface MemCache {
  observations: any[];
  scans: any[];
  penguins: any[];
  chips: any[];
  locations: any[];
  biometrics: any[];
  // Pre-built indexes
  obsById: Map<number, any>;            // observation_id → observation
  obsByLocation: Map<number, any[]>;   // location_id → observations
  scansByObs: Map<number, any[]>;      // observation_id → scans
  chipByPit: Map<string, any>;         // pit_id → chip
  pengByNum: Map<string, any>;         // peng_num → penguin
  locByName: Map<string, any>;         // location_name → location
  locById: Map<number, any>;           // location_id → location
  chipsByPeng: Map<string, any[]>;     // peng_num → chips
  scansByPit: Map<string, any[]>;      // pit_id → scans
  bioByPeng: Map<string, any[]>;       // peng_num → biometrics
  // Precomputed date stats
  dateStats: Map<string, any>;         // NZ date string → stats
  observationDates: string[];          // sorted NZ dates with data
  obsByNzDate: Map<string, any[]>;     // NZ date string → observations
}

let mem: MemCache | null = null;

/** Convert UTC datetime string to NZ date string (YYYY-MM-DD) */
function utcToNzDate(utc: string): string {
  const d = new Date(utc.includes('T') || utc.includes('Z') ? utc : utc.replace(' ', 'T') + 'Z');
  return d.toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' }); // en-CA gives YYYY-MM-DD
}

/** Compute stats for a single NZ date from cache data */
function computeDateStatsFromCache(nzDate: string, c: MemCache): any {
  const obs = c.obsByNzDate.get(nzDate) || [];
  const boxes = new Set(obs.map((o: any) => c.locById.get(o.location_id)?.location_name).filter(Boolean));
  const totalAdults = obs.reduce((s: number, o: any) => s + (o.adults || 0), 0);
  const totalEggs = obs.reduce((s: number, o: any) => s + (o.eggs || 0), 0);
  const totalChicks = obs.reduce((s: number, o: any) => s + (o.chicks || 0), 0);
  const allScans = obs.flatMap((o: any) => c.scansByObs.get(o.observation_id) || []);
  const uniquePenguins = new Set(allScans.map((s: any) => c.chipByPit.get(s.pit_id)?.peng_num).filter(Boolean));
  // Chippings on this date
  const chippedCount = c.chips.filter((ch: any) => ch.chip_date === nzDate).length;
  // Most common monitor filename
  const nameCounts: Record<string, number> = {};
  for (const o of obs) { if (o.monitor_filename) nameCounts[o.monitor_filename] = (nameCounts[o.monitor_filename] || 0) + 1; }
  const topName = Object.entries(nameCounts).sort((a, b) => b[1] - a[1])[0];
  const label = topName && topName[1] > obs.length * 0.5 ? topName[0] : null;
  // Full monitor: a box not observed today is excused if its most recent breeding_status (before today) is DCM
  // Convert NZ date to UTC cutoff: end of NZ day = nzDate T12:00:00 UTC (covers both NZST+12 and NZDT+13)
  const utcCutoff = nzDate + ' 12:00:00';
  const EXCLUDED_BOXES = new Set(['AA', 'AB', 'AC']);
  const dcmBoxes = new Set<string>();
  for (const loc of c.locations) {
    if (EXCLUDED_BOXES.has(loc.location_name.toUpperCase())) continue; // not part of FM calculation
    if (boxes.has(loc.location_name)) continue; // observed today — doesn't matter if DCM
    const locObs = (c.obsByLocation.get(loc.location_id) || [])
      .filter((o: any) => !o.is_deleted && o.breeding_status && o.observation_time_utc < utcCutoff)
      .sort((a: any, b: any) => b.observation_time_utc.localeCompare(a.observation_time_utc));
    if (locObs.length > 0 && locObs[0].breeding_status === 'DCM') dcmBoxes.add(loc.location_name);
  }
  // Required = all locations that are not DCM. FM = all required boxes were observed.
  const missingBoxes = c.locations.filter(l => !EXCLUDED_BOXES.has(l.location_name.toUpperCase()) && !boxes.has(l.location_name) && !dcmBoxes.has(l.location_name));
  const isFullMonitor = missingBoxes.length === 0 && boxes.size > 0;
  return { boxes: boxes.size, obs: obs.length, adults: totalAdults, eggs: totalEggs, chicks: totalChicks, penguins: uniquePenguins.size, chipped: chippedCount, label, isFullMonitor, totalLocations: c.locations.length };
}

function buildDateStats(c: MemCache): void {
  c.obsByNzDate = new Map();
  c.dateStats = new Map();
  // Group observations by NZ date
  for (const o of c.observations) {
    if (o.is_deleted) continue;
    const nz = utcToNzDate(o.observation_time_utc);
    if (!c.obsByNzDate.has(nz)) c.obsByNzDate.set(nz, []);
    c.obsByNzDate.get(nz)!.push(o);
  }
  // Compute stats per date
  for (const [nz] of c.obsByNzDate) {
    c.dateStats.set(nz, computeDateStatsFromCache(nz, c));
  }
  c.observationDates = [...c.obsByNzDate.keys()].sort();
}

function buildIndexes(data: { observations: any[]; scans: any[]; penguins: any[]; chips: any[]; locations: any[]; biometrics: any[] }): MemCache {
  const cache: MemCache = {
    ...data,
    obsById: new Map(),
    obsByLocation: new Map(),
    scansByObs: new Map(),
    chipByPit: new Map(),
    pengByNum: new Map(),
    locByName: new Map(),
    locById: new Map(),
    chipsByPeng: new Map(),
    scansByPit: new Map(),
    bioByPeng: new Map(),
    dateStats: new Map(),
    observationDates: [],
    obsByNzDate: new Map(),
  };
  for (const l of data.locations) { cache.locByName.set(l.location_name, l); cache.locById.set(l.location_id, l); }
  for (const p of data.penguins) cache.pengByNum.set(p.peng_num, p);
  for (const c of data.chips) {
    cache.chipByPit.set(c.pit_id, c);
    if (!cache.chipsByPeng.has(c.peng_num)) cache.chipsByPeng.set(c.peng_num, []);
    cache.chipsByPeng.get(c.peng_num)!.push(c);
  }
  for (const o of data.observations) {
    cache.obsById.set(o.observation_id, o);
    if (!cache.obsByLocation.has(o.location_id)) cache.obsByLocation.set(o.location_id, []);
    cache.obsByLocation.get(o.location_id)!.push(o);
  }
  for (const s of data.scans) {
    if (!cache.scansByObs.has(s.observation_id)) cache.scansByObs.set(s.observation_id, []);
    cache.scansByObs.get(s.observation_id)!.push(s);
    if (!cache.scansByPit.has(s.pit_id)) cache.scansByPit.set(s.pit_id, []);
    cache.scansByPit.get(s.pit_id)!.push(s);
  }
  for (const b of data.biometrics) {
    if (!cache.bioByPeng.has(b.peng_num)) cache.bioByPeng.set(b.peng_num, []);
    cache.bioByPeng.get(b.peng_num)!.push(b);
  }
  // Compute hasReturned for chick-chipped penguins: scanned >90 days after chip date
  const CHICK_WINDOW = 90 * 86400000;
  for (const p of data.penguins) {
    if (p.chipped_as_adult) { p.hasReturned = false; continue; }
    const chips = cache.chipsByPeng.get(p.peng_num) || [];
    const chipDate = chips[0]?.chip_date;
    if (!chipDate) { p.hasReturned = false; continue; }
    const chipTime = new Date(chipDate).getTime();
    let returned = false;
    for (const chip of chips) {
      const scans = cache.scansByPit.get(chip.pit_id) || [];
      for (const s of scans) {
        const obs = cache.obsById.get(s.observation_id);
        if (obs && new Date(obs.observation_time_utc).getTime() > chipTime + CHICK_WINDOW) {
          returned = true; break;
        }
      }
      if (returned) break;
    }
    p.hasReturned = returned;
  }
  buildDateStats(cache);
  return cache;
}

// ============ IndexedDB helpers ============

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store)) {
          const keyPath = store === 'observations' ? 'observation_id'
            : store === 'scans' ? 'scan_id'
            : store === 'penguins' ? 'peng_num'
            : store === 'chips' ? 'pit_id'
            : store === 'locations' ? 'location_id'
            : store === 'biometrics' ? 'biometric_id'
            : 'key';
          db.createObjectStore(store, { keyPath });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putAll(db: IDBDatabase, storeName: StoreNames, rows: any[]): Promise<void> {
  if (rows.length === 0) return;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    for (const row of rows) store.put(row);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAll(db: IDBDatabase, storeName: StoreNames): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getMeta(db: IDBDatabase, key: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readonly');
    const req = tx.objectStore('meta').get(key);
    req.onsuccess = () => resolve(req.result?.value);
    req.onerror = () => reject(req.error);
  });
}

async function setMeta(db: IDBDatabase, key: string, value: any): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function clearAll(db: IDBDatabase): Promise<void> {
  for (const store of STORES) {
    if (store === 'meta') continue;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}

// ============ Sync ============

function applyEditCounts(observations: any[], editCounts: Record<string, number>): any[] {
  if (!editCounts) return observations;
  return observations.map(o => ({ ...o, edit_count: editCounts[o.observation_id] || 0 }));
}

/** Load all data from IndexedDB into memory */
async function loadMemFromIDB(): Promise<void> {
  const db = await openDB();
  const [observations, scans, penguins, chips, locations, biometrics] = await Promise.all([
    getAll(db, 'observations'), getAll(db, 'scans'), getAll(db, 'penguins'),
    getAll(db, 'chips'), getAll(db, 'locations'), getAll(db, 'biometrics'),
  ]);
  mem = buildIndexes({ observations, scans, penguins, chips, locations, biometrics });
  notifySubscribers();
}

/** Store snapshot data into both IndexedDB and memory */
async function storeSnapshot(data: any, full: boolean): Promise<void> {
  const db = await openDB();
  const observations = applyEditCounts(data.observations, data.edit_counts);

  if (full) {
    console.time('idb-clear');
    await clearAll(db);
    console.timeEnd('idb-clear');
    console.time('idb-write');
    await Promise.all([
      putAll(db, 'observations', observations),
      putAll(db, 'scans', data.scans),
      putAll(db, 'penguins', data.penguins),
      putAll(db, 'chips', data.chips),
      putAll(db, 'locations', data.locations),
      putAll(db, 'biometrics', data.biometrics),
    ]);
    console.timeEnd('idb-write');
    await setMeta(db, 'snapshot_time', data.snapshot_time);
    console.time('buildIndexes');
    mem = buildIndexes({
      observations, scans: data.scans, penguins: data.penguins,
      chips: data.chips, locations: data.locations, biometrics: data.biometrics,
    });
    console.timeEnd('buildIndexes');
    notifySubscribers();
  } else {
    // Incremental: merge into IDB, removing soft-deleted scans
    const activeScans = (data.scans || []).filter((s: any) => !s.scan_deleted);
    const deletedScanIds = (data.scans || []).filter((s: any) => s.scan_deleted).map((s: any) => s.scan_id);
    if (deletedScanIds.length > 0) {
      const tx = db.transaction('scans', 'readwrite');
      const store = tx.objectStore('scans');
      for (const id of deletedScanIds) store.delete(id);
      await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    }
    await Promise.all([
      putAll(db, 'observations', observations),
      putAll(db, 'scans', activeScans),
      putAll(db, 'penguins', data.penguins),
      putAll(db, 'chips', data.chips),
      putAll(db, 'locations', data.locations),
      putAll(db, 'biometrics', data.biometrics),
    ]);
    // Also update edit counts for observations already in IDB
    if (data.edit_counts && Object.keys(data.edit_counts).length > 0 && mem) {
      for (const o of mem.observations) {
        if (data.edit_counts[o.observation_id] !== undefined) {
          o.edit_count = data.edit_counts[o.observation_id];
        }
      }
    }
    await setMeta(db, 'snapshot_time', data.snapshot_time);
    // Rebuild memory from IDB (simplest way to merge)
    await loadMemFromIDB();
  }
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

async function fetchWithProgress(url: string, onProgress?: (pct: number, label: string) => void): Promise<any> {
  const resp = await fetch(url, { headers: authHeaders() });
  if (!resp.body) return resp.json();
  const total = parseInt(resp.headers.get('Content-Length') || '0', 10);
  const isGzip = resp.headers.get('Content-Type')?.includes('gzip');
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    const pct = total > 0 ? Math.min(received / total, 0.99) : 0;
    onProgress?.(pct, total > 0 ? `${fmtSize(received)} / ${fmtSize(total)}` : fmtSize(received));
  }
  onProgress?.(1, fmtSize(received));
  console.log(`snapshot: ${fmtSize(received)} downloaded${isGzip ? ' (gzipped)' : ''}`);
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) { merged.set(c, offset); offset += c.length; }
  // Decompress if server sent manual gzip
  if (isGzip) {
    console.time('decompress');
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(merged);
    writer.close();
    const decompressed = await new Response(ds.readable).text();
    console.timeEnd('decompress');
    console.log(`snapshot: ${fmtSize(decompressed.length)} decompressed`);
    return JSON.parse(decompressed);
  }
  return JSON.parse(new TextDecoder().decode(merged));
}

export async function syncDatabase(onProgress?: (msg: string, pct?: number) => void): Promise<void> {
  const db = await openDB();
  const cachedVersion = await getMeta(db, 'cache_version');
  if (cachedVersion !== CACHE_VERSION) {
    onProgress?.('Updating data format...');
    await resetDatabase();
    const freshDb = await openDB();
    await setMeta(freshDb, 'cache_version', CACHE_VERSION);
    // Fall through to full download below (lastSync will be null)
  }
  const lastSync = await getMeta(db, 'snapshot_time');

  if (lastSync) {
    // Load from IndexedDB into memory immediately (already up to date from last session)
    if (!mem) await loadMemFromIDB();

    // Then check for changes in background
    const resp = await fetch(`/api/snapshot.php?since=${encodeURIComponent(lastSync)}&_=${Date.now()}`, { headers: authHeaders() });
    const data = await resp.json();
    const hasChanges = data.observations?.length > 0 || data.scans?.length > 0 || data.penguins?.length > 0 || data.chips?.length > 0 || data.locations?.length > 0 || data.biometrics?.length > 0;
    if (hasChanges) {
      onProgress?.('Syncing changes...');
      await storeSnapshot(data, false);
    } else {
      await setMeta(await openDB(), 'snapshot_time', data.snapshot_time);
    }

    // Verify counts match server
    if (data._counts && mem) {
      const local: Record<string, number> = {
        observations: mem.observations.length, scans: mem.scans.length,
        penguins: mem.penguins.length, chips: mem.chips.length,
        locations: mem.locations.length, biometrics: mem.biometrics.length,
      };
      const mismatch = Object.keys(data._counts).some(k => data._counts[k] !== local[k]);
      if (mismatch) {
        console.warn('Sync count mismatch, doing full re-sync', { server: data._counts, local });
        onProgress?.('Data mismatch — reloading...');
        await resetDatabase();
        const full = await fetchWithProgress(`/api/snapshot.php?_=${Date.now()}`, (pct, label) => {
          onProgress?.(`Reloading colony data... ${label}`, pct);
        });
        await storeSnapshot(full, true);
        onProgress?.('Reload complete');
        return;
      }
    }
    onProgress?.('Sync complete');
  } else {
    onProgress?.('Downloading colony data...', 0);
    console.time('fetch+parse');
    const data = await fetchWithProgress(`/api/snapshot.php?_=${Date.now()}`, (pct, label) => {
      onProgress?.(`Downloading colony data... ${label}`, pct);
    });
    console.timeEnd('fetch+parse');
    onProgress?.('Storing data...', undefined);
    console.time('storeSnapshot');
    await storeSnapshot(data, true);
    console.timeEnd('storeSnapshot');
    onProgress?.(`Loaded ${data.observations.length} observations, ${data.penguins.length} penguins`);
  }
}

// Prevent concurrent syncs
let syncing = false;
let syncQueued = false;

export async function triggerSync(): Promise<void> {
  if (syncing) { syncQueued = true; return; }
  syncing = true;
  try {
    await syncDatabase();
  } finally {
    syncing = false;
    if (syncQueued) { syncQueued = false; triggerSync(); }
  }
}

// ============ Polling ============

let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastWatermark = '';

export function startPolling(onChanged: () => void, intervalMs = 30000): void {
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      const resp = await fetch(`/api/events.php?wm=${encodeURIComponent(lastWatermark)}&_=${Date.now()}`, { headers: authHeaders() });
      const data = await resp.json();
      if (data.wm) lastWatermark = data.wm;
      if (data.changed) {
        await triggerSync();
        onChanged();
      }
    } catch {}
  }, intervalMs);
  // Also fetch initial watermark
  fetch(`/api/events.php?_=${Date.now()}`, { headers: authHeaders() }).then(r => r.json()).then(d => { if (d.wm) lastWatermark = d.wm; }).catch(() => {});
}

export function stopPolling(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ============ Query functions (pure in-memory) ============

function enrichScan(s: any, c: MemCache) {
  const chip = c.chipByPit.get(s.pit_id);
  const peng = chip ? c.pengByNum.get(chip.peng_num) : null;
  return {
    observation_id: s.observation_id, scan_id: s.scan_id, pit_id: s.pit_id,
    peng_num: chip?.peng_num || null, sex: peng?.sex || null,
    life_stage: peng?.life_stage || null, chipped_as_adult: peng?.chipped_as_adult || 0,
    chick_size_code: peng?.chick_size_code || null, chip_date: chip?.chip_date || null,
    hasReturned: peng?.hasReturned || false,
  };
}

export function queryBoxDetailSync(boxName: string, includeDeleted?: boolean): any {
  return queryBoxDetailInner(boxName, includeDeleted);
}
export function queryBoxDetail(boxName: string, includeDeleted?: boolean): Promise<any> {
  return Promise.resolve(queryBoxDetailInner(boxName, includeDeleted));
}
function queryBoxDetailInner(boxName: string, includeDeleted?: boolean): any {
  if (!mem) return { location: null, observations: [], all_penguins: [], deleted_count: 0, deleted: [] };
  const c = mem;

  const location = c.locByName.get(boxName) || null;
  if (!location) return { location: null, observations: [], all_penguins: [], deleted_count: 0, deleted: [] };

  const boxObs = (c.obsByLocation.get(location.location_id) || [])
    .sort((a: any, b: any) => b.observation_time_utc.localeCompare(a.observation_time_utc));

  const active = boxObs.filter((o: any) => !o.is_deleted);
  const deleted = boxObs.filter((o: any) => o.is_deleted);

  const observations = active.map((o: any) => ({
    ...o,
    scans: (c.scansByObs.get(o.observation_id) || []).map((s: any) => enrichScan(s, c)),
  }));

  // All penguins seen in this box
  const seenPenguins = new Map<string, any>();
  for (const obs of observations) {
    for (const scan of obs.scans) {
      if (!scan.peng_num) continue;
      if (!seenPenguins.has(scan.peng_num)) {
        seenPenguins.set(scan.peng_num, {
          peng_num: scan.peng_num, pit_id: scan.pit_id, sex: scan.sex,
          life_stage: scan.life_stage, chipped_as_adult: scan.chipped_as_adult,
          chick_size_code: scan.chick_size_code, chip_date: scan.chip_date,
          hasReturned: scan.hasReturned || false,
          scan_count: 0, last_seen: obs.observation_time_utc, is_chipped_here: false,
        });
      }
      seenPenguins.get(scan.peng_num)!.scan_count++;
    }
  }
  // Birds chipped here
  for (const chip of c.chips) {
    if (chip.chip_box === boxName) {
      const peng = c.pengByNum.get(chip.peng_num);
      if (!seenPenguins.has(chip.peng_num)) {
        seenPenguins.set(chip.peng_num, {
          peng_num: chip.peng_num, pit_id: chip.pit_id, sex: peng?.sex || null,
          life_stage: peng?.life_stage || null, chipped_as_adult: peng?.chipped_as_adult || 0,
          chick_size_code: peng?.chick_size_code || null, chip_date: chip.chip_date,
          hasReturned: peng?.hasReturned || false,
          scan_count: 0, last_seen: chip.chip_date, is_chipped_here: true,
        });
      } else {
        seenPenguins.get(chip.peng_num)!.is_chipped_here = true;
      }
    }
  }

  return {
    location, observations,
    all_penguins: Array.from(seenPenguins.values()),
    deleted_count: deleted.length,
    deleted: includeDeleted ? deleted : [],
  };
}

export function queryBirdDetailSync(pengNum: string): any {
  return queryBirdDetailInner(pengNum);
}
export function queryBirdDetail(pengNum: string): Promise<any> {
  return Promise.resolve(queryBirdDetailInner(pengNum));
}
function queryBirdDetailInner(pengNum: string): any {
  if (!mem) return { error: 'not loaded' };
  const c = mem;

  const penguin = c.pengByNum.get(pengNum);
  if (!penguin) return { error: 'penguin not found' };

  const chips = (c.chipsByPeng.get(pengNum) || []).sort((a: any, b: any) => (a.chip_date || '').localeCompare(b.chip_date || ''));
  const result = { ...penguin, chips };

  const biometrics = (c.bioByPeng.get(pengNum) || []).sort((a: any, b: any) => (b.observation_date || '').localeCompare(a.observation_date || ''));

  // Find this penguin's scans via pit_ids
  const myPitIds = new Set(chips.map((ch: any) => ch.pit_id));
  const myScans: any[] = [];
  for (const pit of myPitIds) {
    const scans = c.scansByPit.get(pit);
    if (scans) myScans.push(...scans);
  }
  // Build sightings
  const sightingMap = new Map<string, any>();
  for (const scan of myScans) {
    const obs = c.obsById.get(scan.observation_id);
    if (!obs || obs.is_deleted) continue;
    const loc = c.locById.get(obs.location_id);
    if (!loc) continue;
    const date = obs.observation_time_utc;
    const box = loc.location_name;
    const key = `${pengNum}|${date}|${box}`;

    if (!sightingMap.has(key)) {
      // Co-scanned birds
      const coScans = (c.scansByObs.get(scan.observation_id) || [])
        .filter((s: any) => !myPitIds.has(s.pit_id))
        .map((s: any) => {
          const ch = c.chipByPit.get(s.pit_id);
          const p = ch ? c.pengByNum.get(ch.peng_num) : null;
          return { peng_num: ch?.peng_num, pit_id: s.pit_id, sex: p?.sex, chipped_as_adult: p?.chipped_as_adult, chip_date: ch?.chip_date, chick_size_code: p?.chick_size_code, hasReturned: p?.hasReturned || false };
        })
        .filter((s: any) => s.peng_num);

      sightingMap.set(key, {
        peng_num: pengNum, date, box, source: 'scan',
        adults: obs.adults || 0, eggs: obs.eggs || 0, chicks: obs.chicks || 0,
        breeding_status: obs.breeding_status, notes: obs.notes, seen_with: coScans,
      });
    }
  }

  // Chip events
  for (const chip of chips) {
    if (chip.chip_box && chip.chip_date) {
      const key = `${pengNum}|${chip.chip_date}|${chip.chip_box}`;
      if (!sightingMap.has(key)) {
        sightingMap.set(key, {
          peng_num: pengNum, date: chip.chip_date, box: chip.chip_box, source: 'chip',
          adults: 0, eggs: 0, chicks: 0, breeding_status: null,
          notes: 'Chipped by ' + (chip.chip_by || ''), seen_with: [],
        });
      }
    }
  }

  const sightings = Array.from(sightingMap.values()).sort((a, b) => b.date.localeCompare(a.date));

  // Partners
  const partnerMap = new Map<string, any>();
  for (const s of sightings) {
    for (const sw of s.seen_with) {
      if (!partnerMap.has(sw.peng_num)) partnerMap.set(sw.peng_num, { ...sw, sightings: [] });
      const others = s.seen_with.filter((o: any) => o.peng_num !== sw.peng_num);
      partnerMap.get(sw.peng_num)!.sightings.push({
        box: s.box, date: s.date, adults: s.adults, eggs: s.eggs, chicks: s.chicks,
        breeding_status: s.breeding_status, notes: s.notes, also_seen: others,
      });
    }
  }
  const partners = Array.from(partnerMap.values()).sort((a, b) => b.sightings.length - a.sightings.length);

  // Breeding stats
  const bsMap = new Map<string, any>();
  for (const s of sightings) {
    const d = new Date(s.date.includes('T') || s.date.includes('Z') ? s.date : s.date.replace(' ', 'T') + 'Z');
    const m = d.getUTCMonth() + 1;
    const y = d.getUTCFullYear();
    const seasonYear = m >= 4 ? y : y - 1;
    const season = `${seasonYear}/${String(seasonYear + 1).slice(-2)}`;
    if (!bsMap.has(season)) bsMap.set(season, { season, scans: 0, boxes: [] as string[], max_eggs: 0, max_chicks: 0, statuses: [] as string[] });
    const bs = bsMap.get(season)!;
    bs.scans++;
    if (!bs.boxes.includes(s.box)) bs.boxes.push(s.box);
    if (s.eggs > bs.max_eggs) bs.max_eggs = s.eggs;
    if (s.chicks > bs.max_chicks) bs.max_chicks = s.chicks;
    if (s.breeding_status && !bs.statuses.includes(s.breeding_status)) bs.statuses.push(s.breeding_status);
  }
  const breedingStats = Array.from(bsMap.values()).sort((a, b) => b.season.localeCompare(a.season));

  return { penguin: result, sightings, biometrics, partners, breeding_stats: breedingStats };
}

/** Get all penguins with active chip info (for search/PenguinMini) */
export function queryAllPenguins(): any[] {
  if (!mem) return [];
  const result: any[] = [];
  for (const p of mem.penguins) {
    const chips = mem.chipsByPeng.get(p.peng_num) || [];
    const active = chips.find((c: any) => c.is_active == 1) || chips[0];
    result.push({
      peng_num: p.peng_num, sex: p.sex, life_stage: p.life_stage,
      chipped_as_adult: p.chipped_as_adult, vid_for_scanner: p.vid_for_scanner,
      chick_size_code: p.chick_size_code, hasReturned: p.hasReturned || false,
      pit_id: active?.pit_id || null, chip_date: active?.chip_date || null,
    });
  }
  return result;
}

/** Get all observation locations */
export function queryAllLocations(): any[] {
  return mem?.locations || [];
}

/** Get precomputed date stats (instant) */
export function getDateStats(): Map<string, any> {
  return mem?.dateStats || new Map();
}

/** Get sorted list of NZ dates with observations */
export function getObservationDates(): string[] {
  return mem?.observationDates || [];
}

/** For boxes not observed on a given NZ date, get their most recent observation before that date */
export function queryCarryForward(nzDate: string, observedBoxes: Set<string>): any[] {
  if (!mem) return [];
  const c = mem;
  const utcCutoff = nzDate + ' 12:00:00';
  const results: any[] = [];
  for (const loc of c.locations) {
    if (observedBoxes.has(loc.location_name)) continue;
    // Find most recent non-deleted observation before this date
    const locObs = (c.obsByLocation.get(loc.location_id) || [])
      .filter((o: any) => !o.is_deleted && o.observation_time_utc < utcCutoff)
      .sort((a: any, b: any) => b.observation_time_utc.localeCompare(a.observation_time_utc));
    if (locObs.length === 0) continue;
    const latest = locObs[0];
    const scans = (c.scansByObs.get(latest.observation_id) || []).map((s: any) => enrichScan(s, c));
    results.push({
      box_name: loc.location_name,
      observation_time_utc: latest.observation_time_utc,
      adults: latest.adults || 0,
      eggs: latest.eggs || 0,
      chicks: latest.chicks || 0,
      breeding_status: latest.breeding_status,
      gate_status: latest.gate_status,
      notes: latest.notes,
      scans,
      carried_forward: true,
    });
  }
  return results;
}

/** Get boxes whose most recent breeding_status before a date is DCM */
export function getDcmBoxes(beforeNzDate: string): Set<string> {
  const dcm = new Set<string>();
  if (!mem) return dcm;
  const utcCutoff = beforeNzDate + ' 12:00:00';
  for (const loc of mem.locations) {
    const locObs = (mem.obsByLocation.get(loc.location_id) || [])
      .filter((o: any) => !o.is_deleted && o.breeding_status && o.observation_time_utc < utcCutoff)
      .sort((a: any, b: any) => b.observation_time_utc.localeCompare(a.observation_time_utc));
    if (locObs.length > 0 && locObs[0].breeding_status === 'DCM') {
      dcm.add(loc.location_name);
    }
  }
  return dcm;
}

/** Get observations for a NZ date (same logic as day.php) */
export function queryDay(date: string): any {
  if (!mem) return { date, observations: [], chippings: [] };
  const c = mem;

  // NZ date D covers UTC range: (D-1)T11:00:00 to DT12:00:00
  const d = new Date(date + 'T00:00:00Z');
  const utcStart = new Date(d.getTime() - 86400000 + 11 * 3600000).toISOString().replace('T', ' ').slice(0, 19);
  const utcEnd = new Date(d.getTime() + 12 * 3600000).toISOString().replace('T', ' ').slice(0, 19);

  const dayObs = c.observations
    .filter(o => !o.is_deleted && o.observation_time_utc >= utcStart && o.observation_time_utc < utcEnd)
    .sort((a: any, b: any) => {
      const locA = c.locById.get(a.location_id);
      const locB = c.locById.get(b.location_id);
      const numA = parseInt(locA?.location_name) || 999;
      const numB = parseInt(locB?.location_name) || 999;
      return numA - numB || a.observation_time_utc.localeCompare(b.observation_time_utc);
    });

  const observations = dayObs.map((o: any) => {
    const loc = c.locById.get(o.location_id);
    return {
      ...o,
      box_name: loc?.location_name || '',
      observer_name: null,
      scans: (c.scansByObs.get(o.observation_id) || []).map((s: any) => enrichScan(s, c)),
    };
  });

  // Chippings on this date
  const chippings = c.chips
    .filter((ch: any) => ch.chip_date === date)
    .map((ch: any) => {
      const p = c.pengByNum.get(ch.peng_num);
      return {
        pit_id: ch.pit_id, peng_num: ch.peng_num, chip_box: ch.chip_box, chip_by: ch.chip_by, chip_date: ch.chip_date,
        sex: p?.sex, chipped_as_adult: p?.chipped_as_adult, chick_size_code: p?.chick_size_code, hasReturned: p?.hasReturned || false,
      };
    })
    .sort((a: any, b: any) => (parseInt(a.chip_box) || 999) - (parseInt(b.chip_box) || 999));

  return { date, observations, chippings };
}

// ============ Lifecycle ============

export async function isLoaded(): Promise<boolean> {
  try {
    const db = await openDB();
    return !!(await getMeta(db, 'snapshot_time'));
  } catch { return false; }
}

export async function resetDatabase(): Promise<void> {
  mem = null;
  const db = await openDB();
  await clearAll(db);
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('meta', 'readwrite');
    tx.objectStore('meta').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
