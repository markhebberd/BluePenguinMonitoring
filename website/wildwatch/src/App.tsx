import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchBoxTags, fetchBoxDetail, fetchOverview, fetchBirdDetail, fetchAllPenguins, updateRecord, createRecord, deleteRecord, fetchHistory, fetchServerStats, fetchDay, fetchReport } from './api/boxtags';
import { getSeasonStart, getSeasonLabel } from './config';
import { ColonyMap } from './components/ColonyMap';
import { BoxGrid } from './components/BoxGrid';
import { StatsPanel } from './components/StatsPanel';
import type { BoxTag } from './types';
import './App.css';

interface Scan { scan_id?:number; peng_num?:string|null; pit_id:string; sex:string|null; life_stage:string|null; chip_date:string|null; chipped_as_adult:number|null; }

function isChickAtDate(bird: any, dateStr: string): boolean {
  if (!bird || !bird.chip_date || bird.chipped_as_adult) return false;
  const chipTime = new Date(bird.chip_date).getTime();
  const obsTime = new Date(dateStr).getTime();
  return (obsTime - chipTime) < 90 * 86400000; // chick if chipped as chick and <3 months since chip
}
interface Observation {
  observation_id?:number;
  observation_time_utc:string; monitor_filename:string;
  adults:number; eggs:number; chicks:number;
  breeding_status:string|null; gate_status:string|null; notes:string;
  scans: Scan[];
  edit_count?:string|number;
}
interface ChippedHere { peng_num:string; pit_id:string; sex:string|null; life_stage:string|null; chipped_as_adult:number; chip_date:string; chip_by:string|null; chick_size_code?:string|null; }
interface BoxDetailData {
  location: { location_id:number; location_name:string; persistent_notes:string|null; pit_id:string|null; } | null;
  observations: Observation[];
  all_penguins?: any[];
  chipped_here?: ChippedHere[]; // deprecated, use all_penguins
}

const DAY = 86400000;
const BREEDING_OFFSETS = { hatch: 38, pg: 52, chip: 80, fledge: 87 };

/** C# GetEstimatedBreedingDates: find probable laid date from observation history.
 *  Walk backwards from most recent obs with eggs/chicks to find when offspring first appeared.
 *  Probable laid date = midpoint between last empty check and first egg check.
 *  If 2+ eggs at discovery, subtract 2 days (second egg laid ~2 days after first). */
function estimateLaidDate(observations: Observation[]): number | null {
  const sorted = [...observations].sort((a, b) => parseDate(a.observation_time_utc).getTime() - parseDate(b.observation_time_utc).getTime());
  const reversed = [...sorted].reverse();
  const mostRecent = reversed.find(o => o.eggs + o.chicks > 0);
  if (!mostRecent) return null;

  let whenOffspringFound = parseDate(mostRecent.observation_time_utc).getTime();
  const olderThanRecent = sorted.filter(o =>
    parseDate(o.observation_time_utc).getTime() < whenOffspringFound
  ).reverse();

  for (const older of olderThanRecent) {
    if (older.breeding_status === 'ABN' && older.eggs + older.chicks > 0) return null;
    if (older.eggs + older.chicks === 0) {
      if (older.breeding_status === 'ABN') return null;
      let adjustedFound = whenOffspringFound;
      if (mostRecent.eggs > 1) adjustedFound -= 2 * DAY;
      const whenNotFound = parseDate(older.observation_time_utc).getTime();
      const uncertainty = (adjustedFound - whenNotFound) / 2;
      return whenNotFound + Math.ceil(uncertainty / DAY) * DAY;
    }
    whenOffspringFound = parseDate(older.observation_time_utc).getTime();
  }
  return null;
}

function displayStatus(status: string|null, eggs: number, chicks: number): string|null {
  if (status === 'BR') {
    if (chicks > 0) return 'G';
    if (eggs > 0) return 'I';
    return 'NO';
  }
  return status;
}

const DARK_TEXT_STATUSES = new Set(['NO','UNL','POT','CON','I','']);

// Color progression: NO → UNL → POT → CON → BR → Guard → PG → Molting. Red = alert only.
const STATUS_COLORS: Record<string,string> = {
  NO:'#E0E0E0',       // gray
  UNL:'#FFF9C4',      // pale yellow
  POT:'#FFF176',      // yellow
  CON:'#FFD54F',      // amber
  BR:'#66BB6A',       // light green - breeding confirmed
  I:'#A5D6A7',        // lightest green - incubation
  G:'#4CAF50',        // mid green - guard
  PG:'#2E7D32',       // darkest green - post guard
  MOULT:'#42A5F5',    // blue - moulting
  ABN:'#F44336',      // red - alert
  DCM:'#795548',      // brown
  '':'#F5F5F5',
};

const STATUS_NAMES: Record<string,string> = {
  NO:'No', UNL:'Unlikely', POT:'Potential', CON:'Confident',
  I:'Incubation', G:'Guard', PG:'Post-guard', MOULT:'Moulting',
  DCM:'DCM',
};

function SeasonBar({ observations, seasonStart, seasonEnd, label, todayCutoff, onHighlight, onScrollTo }: {
  observations: Observation[]; seasonStart: Date; seasonEnd: Date; label: string; todayCutoff?: Date;
  onHighlight?: (obsDate: string | null) => void;
  onScrollTo?: (obsDate: string) => void;
}) {
  const totalMs = seasonEnd.getTime() - seasonStart.getTime();
  if (totalMs <= 0) return null;

  const sorted = [...observations]
    .filter(o => { const t = parseDate(o.observation_time_utc).getTime(); return t >= seasonStart.getTime() && t <= seasonEnd.getTime(); })
    .sort((a, b) => parseDate(a.observation_time_utc).getTime() - parseDate(b.observation_time_utc).getTime());

  // Also consider obs before this season to get the initial status
  const allSorted = [...observations].sort((a, b) => parseDate(a.observation_time_utc).getTime() - parseDate(b.observation_time_utc).getTime());

  // Build status changes from ALL observations (to carry forward pre-season status)
  // Derive status: I=Incubation (eggs, no chicks), G=Guard (chicks present)
  const changes: { time: number; status: string }[] = [];
  let runningStatus = '';
  for (const obs of allSorted) {
    let s = obs.breeding_status;
    // BR maps to incubation or guard based on egg/chick state
    if (s === 'BR') {
      s = obs.chicks > 0 ? 'G' : obs.eggs > 0 ? 'I' : null;
    }
    // Infer from egg/chick presence even without explicit status
    if (!s && obs.chicks > 0) {
      s = 'G';
    } else if (!s && obs.eggs > 0 && runningStatus !== 'I' && runningStatus !== 'G') {
      s = 'I';
    }
    // End when eggs+chicks drop to 0
    if ((runningStatus === 'G' || runningStatus === 'I') && obs.eggs === 0 && obs.chicks === 0 && !s) {
      runningStatus = '';
      changes.push({ time: parseDate(obs.observation_time_utc).getTime(), status: '' });
    } else if (s && s !== runningStatus) {
      runningStatus = s;
      changes.push({ time: parseDate(obs.observation_time_utc).getTime(), status: s });
    }
  }

  const dataEnd = todayCutoff ? Math.min(todayCutoff.getTime(), seasonEnd.getTime()) : seasonEnd.getTime();

  // Breeding milestones from probable laid date (C# algorithm)
  const probableLaidTime = estimateLaidDate(allSorted);
  const pgTime2 = probableLaidTime ? probableLaidTime + BREEDING_OFFSETS.pg * DAY : null;
  const fledgeTime = probableLaidTime ? probableLaidTime + BREEDING_OFFSETS.fledge * DAY : null;

  // Build segments: observer-set statuses first, then overlay calculated phases
  const segments: { startPct: number; endPct: number; status: string }[] = [];

  // Observer-set status segments
  for (let i = 0; i < changes.length; i++) {
    const segStart = Math.max(changes[i].time, seasonStart.getTime());
    let segEnd = (i + 1 < changes.length) ? Math.min(changes[i + 1].time, dataEnd) : dataEnd;
    // Truncate Guard at PG start (calculated)
    if (changes[i].status === 'G' && pgTime2 && pgTime2 < segEnd && pgTime2 > segStart) {
      segEnd = pgTime2;
    }
    if (segEnd <= seasonStart.getTime()) continue;
    if (segStart >= dataEnd) continue;
    if (!changes[i].status) continue; // skip empty status segments
    const startPct = ((segStart - seasonStart.getTime()) / totalMs) * 100;
    const endPct = ((segEnd - seasonStart.getTime()) / totalMs) * 100;
    segments.push({ startPct, endPct, status: changes[i].status });
  }

  // Add calculated PG phase after guard ends
  // Observer sets BR (displayed as G) from egg appearance. PG starts at +52d from laid date.
  // Don't add a separate Guard - the observer-set G covers it.
  if (probableLaidTime && pgTime2) {
    const addPhase = (start: number, end: number, status: string) => {
      const s = Math.max(start, seasonStart.getTime());
      const e = Math.min(end, dataEnd);
      if (e <= s) return;
      segments.push({ startPct: ((s - seasonStart.getTime()) / totalMs) * 100, endPct: ((e - seasonStart.getTime()) / totalMs) * 100, status });
    };
    if (pgTime2 < dataEnd) addPhase(pgTime2, fledgeTime!, 'PG');
    // Moulting only shown from biometric data, not calculated automatically
  }

  // Future portion (white) after today
  const futurePct = todayCutoff ? ((todayCutoff.getTime() - seasonStart.getTime()) / totalMs) * 100 : null;

  // Month labels for this season
  const months: { label: string; pct: number }[] = [];
  for (let m = 0; m < 13; m++) {
    const d = new Date(seasonStart);
    d.setMonth(d.getMonth() + m);
    d.setDate(1);
    if (d.getTime() >= seasonStart.getTime() && d.getTime() <= seasonEnd.getTime()) {
      months.push({ label: d.toLocaleDateString('en-NZ', { month: 'short' }), pct: ((d.getTime() - seasonStart.getTime()) / totalMs) * 100 });
    }
  }

  // Find first egg and first chick appearance in this season
  let firstEggTime: number | null = null;
  let firstChickTime: number | null = null;
  let prevEggs = 0;
  let prevChicks = 0;
  for (const o of sorted) {
    if (o.eggs > 0 && prevEggs === 0 && firstEggTime === null) {
      firstEggTime = parseDate(o.observation_time_utc).getTime();
    }
    if (o.chicks > 0 && prevChicks === 0 && firstChickTime === null) {
      firstChickTime = parseDate(o.observation_time_utc).getTime();
    }
    prevEggs = o.eggs;
    prevChicks = o.chicks;
  }
  const pgTime = firstEggTime ? firstEggTime + 52 * 24 * 60 * 60 * 1000 : null; // 52 days after first egg

  // Milestone markers for egg and chick first appearance
  const milestones: { pct: number; icon: string; label: string }[] = [];
  if (firstEggTime && firstEggTime >= seasonStart.getTime() && firstEggTime <= seasonEnd.getTime()) {
    milestones.push({ pct: ((firstEggTime - seasonStart.getTime()) / totalMs) * 100, icon: '\uD83E\uDD5A', label: 'First egg' });
  }
  if (firstChickTime && firstChickTime >= seasonStart.getTime() && firstChickTime <= seasonEnd.getTime()) {
    milestones.push({ pct: ((firstChickTime - seasonStart.getTime()) / totalMs) * 100, icon: '\uD83D\uDC23', label: 'First chick' });
  }

  // Classify each monitor as routine, significant, or warning
  type MarkerType = 'routine' | 'egg-appear' | 'chick-appear' | 'egg-gone' | 'chick-gone' | 'no-adult-warn';
  const markers: { pct: number; obs: typeof sorted[0]; type: MarkerType; icon: string; date: string }[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const o = sorted[i];
    const prev = i > 0 ? sorted[i - 1] : null;
    const t = parseDate(o.observation_time_utc).getTime();
    const pct = ((t - seasonStart.getTime()) / totalMs) * 100;

    // Detect significant events
    const eggsAppeared = prev !== null && prev.eggs === 0 && o.eggs > 0;
    const chicksAppeared = prev !== null && prev.chicks === 0 && o.chicks > 0;
    const eggsGone = prev !== null && prev.eggs > 0 && o.eggs === 0 && o.chicks <= prev.chicks;
    const chicksGone = prev !== null && prev.chicks > 0 && o.chicks === 0;
    const prePgNoAdults = pgTime !== null && t < pgTime && o.eggs + o.chicks > 0 && o.adults === 0;

    let type: MarkerType = 'routine';
    let icon = '';
    if (prePgNoAdults) { type = 'no-adult-warn'; icon = '⚠'; }
    else if (eggsGone || chicksGone) { type = eggsGone ? 'egg-gone' : 'chick-gone'; icon = '✕'; }
    else if (eggsAppeared) { type = 'egg-appear'; icon = '\uD83E\uDD5A'; }
    else if (chicksAppeared) { type = 'chick-appear'; icon = '\uD83D\uDC23'; }

    markers.push({ pct, obs: o, type, icon, date: o.observation_time_utc });
  }

  return (
    <div className="season-bar">
      <div className="season-bar-label">{label}</div>
      <div className="season-bar-content">
        <div className="status-bar-labels">
          {months.map((m, i) => <span key={i} className="month-label" style={{ left: `${m.pct}%` }}>{m.label}</span>)}
        </div>
        <div className="status-bar">
          {segments.map((seg, i) => (
            <div key={i} className="status-segment" style={{ left: `${seg.startPct}%`, width: `${seg.endPct - seg.startPct}%`, backgroundColor: STATUS_COLORS[seg.status] || STATUS_COLORS[''] }}
              title={STATUS_NAMES[seg.status] || 'No status'} />
          ))}
          {markers.map((m, i) => (
            m.type === 'routine' ? (
              <div key={i}
                className="status-marker-tick"
                style={{ left: `${m.pct}%` }}
                onMouseEnter={() => onHighlight?.(m.date)}
                onMouseLeave={() => onHighlight?.(null)}
                onClick={() => onScrollTo?.(m.date)}
                title={`${fmtDateTime(m.obs.observation_time_utc)}\n\uD83D\uDC27${m.obs.adults} \uD83E\uDD5A${m.obs.eggs} \uD83D\uDC23${m.obs.chicks}${m.obs.breeding_status ? ' ' + m.obs.breeding_status : ''}`}
              />
            ) : (
              <div key={i}
                className={`status-marker-event ${m.type}`}
                style={{ left: `${m.pct}%` }}
                onMouseEnter={() => onHighlight?.(m.date)}
                onMouseLeave={() => onHighlight?.(null)}
                onClick={() => onScrollTo?.(m.date)}
                title={`${fmtDateTime(m.obs.observation_time_utc)}\n\uD83D\uDC27${m.obs.adults} \uD83E\uDD5A${m.obs.eggs} \uD83D\uDC23${m.obs.chicks}${m.obs.breeding_status ? ' ' + m.obs.breeding_status : ''}${m.type === 'no-adult-warn' ? '\n⚠ No adults before post-guard!' : m.type.includes('gone') ? '\n✕ Disappeared' : ''}`}
              >{m.icon}</div>
            )
          ))}
          {/* milestones now shown as event markers */}
          {futurePct !== null && futurePct < 100 && (
            <div className="status-future" style={{ left: `${futurePct}%`, width: `${100 - futurePct}%` }} />
          )}
        </div>
      </div>
    </div>
  );
}

function BreedingStatusBar({ observations, onHighlight, onScrollTo }: { observations: Observation[]; onHighlight?: (date: string | null) => void; onScrollTo?: (date: string) => void }) {
  const now = new Date();
  const currentSeasonStart = getSeasonStart(now);
  void now; // currentSeasonEnd no longer needed - full year bar with todayCutoff

  // Previous season
  const prevSeasonEnd = new Date(currentSeasonStart);
  const prevSeasonStart = new Date(prevSeasonEnd);
  prevSeasonStart.setFullYear(prevSeasonStart.getFullYear() - 1);

  const prevLabel = getSeasonLabel(prevSeasonStart);
  const currentLabel = getSeasonLabel(now);

  // Current season bar runs full year (Apr 1 to Mar 31) but after today is white/empty
  const currentSeasonFullEnd = new Date(currentSeasonStart);
  currentSeasonFullEnd.setFullYear(currentSeasonFullEnd.getFullYear() + 1);

  const hasPrevData = observations.some(o => {
    const t = parseDate(o.observation_time_utc).getTime();
    return t >= prevSeasonStart.getTime() && t < prevSeasonEnd.getTime();
  });

  return (
    <div className="status-bar-wrap">
      <SeasonBar observations={observations} seasonStart={currentSeasonStart} seasonEnd={currentSeasonFullEnd} label={currentLabel} todayCutoff={now} onHighlight={onHighlight} onScrollTo={onScrollTo} />
      {hasPrevData && (
        <SeasonBar observations={observations} seasonStart={prevSeasonStart} seasonEnd={prevSeasonEnd} label={prevLabel} onHighlight={onHighlight} onScrollTo={onScrollTo} />
      )}
      <div className="status-bar-legend">
        {Object.entries(STATUS_NAMES).map(([k, v]) => (
          <span key={k}><i style={{ background: STATUS_COLORS[k] }} />{v}</span>
        ))}
      </div>
    </div>
  );
}



function isChickAtObsDate(chipDate?: string|null, chippedAsAdult?: number|null, observationDate?: string): boolean {
  if (chippedAsAdult || !chipDate) return false;
  return ((observationDate ? new Date(observationDate).getTime() : Date.now()) - new Date(chipDate).getTime()) < 90 * 86400000;
}

/** Sort scans: M first, F second, chicks/unknown last */
function scanSortMFC(a: any, b: any): number {
  const order = (s: any) => {
    const sex = (s.sex || '').toUpperCase();
    if (sex === 'M') return 0;
    if (sex === 'F') return 1;
    return 2;
  };
  return order(a) - order(b);
}

function penguinSexClass(sex: string|null|undefined, chipDate?: string|null, chippedAsAdult?: number|null, observationDate?: string): string {
  if (isChickAtObsDate(chipDate, chippedAsAdult, observationDate)) return 'chick';
  const s = (sex || '').toUpperCase();
  return s === 'F' ? 'f' : s === 'M' ? 'm' : '';
}

function penguinSexIcon(sex: string|null|undefined, chipDate?: string|null, chippedAsAdult?: number|null, observationDate?: string): string {
  if (isChickAtObsDate(chipDate, chippedAsAdult, observationDate)) return '\uD83D\uDC23';
  const s = (sex || '').toUpperCase();
  return s === 'F' ? '\u2640' : s === 'M' ? '\u2642' : '';
}

/** Navigate on click, allow ctrl+click to open in new tab */
function navClick(e: React.MouseEvent, action: () => void) {
  if (e.ctrlKey || e.metaKey || e.button === 1) return; // let browser handle new tab
  e.preventDefault();
  action();
}

function DateLink({ date, onDayClick }: { date: string; onDayClick?: (day: string) => void }) {
  const day = date.length > 10 ? toNzDateStr(date) : date;
  return <a className="date-link" href={`/day/${day}`} onClick={e => navClick(e, () => onDayClick?.(day))}>{formatDate(date)}</a>;
}

function PenguinMini({ scan, onClick, observationDate, navigateDirectly }: { scan: Scan | ChippedHere | any; onClick: () => void; observationDate?: string; navigateDirectly?: boolean }) {
  const sex = (scan.sex || '').toUpperCase();
  const cls = penguinSexClass(sex, scan.chip_date, scan.chipped_as_adult, observationDate);
  const icon = penguinSexIcon(sex, scan.chip_date, scan.chipped_as_adult, observationDate);
  const num = scan.peng_num ? `#${scan.peng_num}` : '';
  const chip = scan.pit_id ? scan.pit_id.slice(-8) : '';
  const wasChippedAsChick = !scan.chipped_as_adult;
  const isChickNow = isChickAtObsDate(scan.chip_date, scan.chipped_as_adult, observationDate);
  const unprovenAdult = wasChippedAsChick && !isChickNow && !sex && !observationDate;
  const chipCls = wasChippedAsChick ? 'chipped-chick' : '';
  const grayCls = unprovenAdult ? 'unproven' : '';
  const sizeCode = scan.chick_size_code || '';
  const href = scan.peng_num ? `/bird/${scan.peng_num}` : undefined;
  return (
    <a className={`scan clickable ${cls} ${chipCls} ${grayCls}`} href={href} onClick={navigateDirectly ? undefined : e => navClick(e, onClick)}>
      {num}{num && icon ? ' ' : ''}{icon && <span className="sex-icon">{icon}</span>}{sizeCode ? ` ${sizeCode} ` : (num || icon) && chip ? ' ' : ''}{chip}
    </a>
  );
}

function AllScannedBirds({ observations, onBirdClick, allPenguinsInBox }: { observations: Observation[]; onBirdClick: (tag:string)=>void; allPenguinsInBox?: any[] }) {
  // Group birds by season, track co-sightings during breeding window
  const seasonBirds = new Map<string, Map<string, Scan & { lastSeen: string; igCount: number; scanCount: number }>>();
  const seasonPairs = new Map<string, Map<string, number>>();

  // First pass: estimate laid date per season using C# algorithm
  const seasonLaidDate = new Map<string, number>();
  const seasonObs = new Map<string, Observation[]>();
  for (const obs of observations) {
    const label = getSeasonLabel(parseDate(obs.observation_time_utc));
    if (!seasonObs.has(label)) seasonObs.set(label, []);
    seasonObs.get(label)!.push(obs);
  }
  for (const [label, obs] of seasonObs) {
    const laid = estimateLaidDate(obs);
    if (laid) seasonLaidDate.set(label, laid);
  }

  for (const obs of observations) {
    const obsDate = parseDate(obs.observation_time_utc);
    const label = getSeasonLabel(obsDate);
    if (!seasonBirds.has(label)) seasonBirds.set(label, new Map());
    if (!seasonPairs.has(label)) seasonPairs.set(label, new Map());
    const birdMap = seasonBirds.get(label)!;
    const pairMap = seasonPairs.get(label)!;

    // Breeding window: 1 week before probable laid date to fledge (laid + 87 days)
    const laidDate = seasonLaidDate.get(label);
    const obsTime = obsDate.getTime();
    const inBreedingWindow = laidDate && obsTime >= (laidDate - 7 * DAY) && obsTime <= (laidDate + BREEDING_OFFSETS.fledge * DAY);

    for (const scan of obs.scans) {
      const key = scan.pit_id.slice(-8);
      const existing = birdMap.get(key);
      if (!existing) {
        birdMap.set(key, { ...scan, lastSeen: obs.observation_time_utc, igCount: inBreedingWindow ? 1 : 0, scanCount: 1 });
      } else {
        existing.scanCount++;
        if (inBreedingWindow) existing.igCount++;
        if (obs.observation_time_utc > existing.lastSeen) {
          existing.lastSeen = obs.observation_time_utc;
          existing.sex = scan.sex;
          existing.life_stage = scan.life_stage;
        }
      }
    }

    // Track individual M and F sightings during breeding window
    if (inBreedingWindow) {
      for (const scan of obs.scans) {
        const sex = (scan.sex || '').toUpperCase();
        if (sex === 'M' || sex === 'F') {
          const key = sex + '|' + scan.pit_id.slice(-8);
          pairMap.set(key, (pairMap.get(key) || 0) + 1);
        }
      }
    }
  }

  // Merge allPenguinsInBox (includes chipped birds not in scans)
  for (const p of (allPenguinsInBox || [])) {
    if (!p.chip_date || !p.pit_id) continue;
    const chipDate = parseDate(p.chip_date);
    const label = getSeasonLabel(chipDate);
    if (!seasonBirds.has(label)) seasonBirds.set(label, new Map());
    const birdMap = seasonBirds.get(label)!;
    const key = p.pit_id.slice(-8);
    if (!birdMap.has(key)) {
      const count = p.scan_count || (p.is_chipped_here ? 1 : 0);
      birdMap.set(key, { ...p, lastSeen: p.last_seen || p.chip_date, igCount: 0, scanCount: count });
    }
  }

  const seasons = Array.from(seasonBirds.entries())
    .sort((a, b) => b[0].localeCompare(a[0]));

  if (seasons.every(([, m]) => m.size === 0)) return null;

  return (
    <div className="all-birds">
      {seasons.map(([label, birdMap]) => {
        const birds = Array.from(birdMap.values());
        if (birds.length === 0) return null;

        // Find breeding pair: most-seen M and most-seen F during breeding window
        const pairMap = seasonPairs.get(label) || new Map();
        let breedingMale = '';
        let breedingFemale = '';
        let maxMale = 0;
        let maxFemale = 0;
        for (const [key, count] of pairMap.entries()) {
          const [sex, pit8] = key.split('|');
          if (sex === 'M' && count > maxMale) { maxMale = count; breedingMale = pit8; }
          if (sex === 'F' && count > maxFemale) { maxFemale = count; breedingFemale = pit8; }
        }

        // Sort: breeding M (0), breeding F (1), other M (2), other F (3), unsexed (4)
        // Within same group, sort by scan count descending
        const sorted = birds.sort((a, b) => {
          const aKey = a.pit_id.slice(-8);
          const bKey = b.pit_id.slice(-8);
          const aSex = (a.sex || '').toUpperCase();
          const bSex = (b.sex || '').toUpperCase();

          const aOrder = aKey === breedingMale ? 0 : aKey === breedingFemale ? 1 : aSex === 'M' ? 2 : aSex === 'F' ? 3 : 4;
          const bOrder = bKey === breedingMale ? 0 : bKey === breedingFemale ? 1 : bSex === 'M' ? 2 : bSex === 'F' ? 3 : 4;
          if (aOrder !== bOrder) return aOrder - bOrder;
          return b.scanCount - a.scanCount;
        });

        const pair = breedingMale && breedingFemale ? sorted.filter(b => {
          const k = b.pit_id.slice(-8);
          return k === breedingMale || k === breedingFemale;
        }) : [];
        const hasPair = pair.length === 2;
        // Chicks go inside breeding pair border only if pair exists
        const chicks = hasPair ? sorted.filter(b => {
          const k = b.pit_id.slice(-8);
          if (k === breedingMale || k === breedingFemale) return false;
          return !b.chipped_as_adult && b.chip_date;
        }) : [];
        const others = sorted.filter(b => {
          const k = b.pit_id.slice(-8);
          if (k === breedingMale || k === breedingFemale) return false;
          if (hasPair && !b.chipped_as_adult && b.chip_date) return false;
          return true;
        });

        return (
          <div key={label} className="season-birds">
            <div className="muted">{label}: {birds.length} bird{birds.length !== 1 ? 's' : ''}</div>
            <div className="bird-row">
              {pair.length === 2 && (
                <span className="breeding-pair">
                  {pair.map(b => (
                    <span key={b.pit_id.slice(-8)} className="bird-with-count">
                      <PenguinMini scan={b} onClick={() => onBirdClick(b.peng_num || b.pit_id)} />
                      <span className="scan-count">{b.scanCount}x</span>
                    </span>
                  ))}
                  {chicks.map(b => (
                    <span key={b.pit_id.slice(-8)} className="bird-with-count">
                      <PenguinMini scan={b} onClick={() => onBirdClick(b.peng_num || b.pit_id)} observationDate={b.lastSeen} />
                      <span className="scan-count">{b.scanCount}x</span>
                    </span>
                  ))}
                </span>
              )}
              {others.map(b => (
                <span key={b.pit_id.slice(-8)} className="bird-with-count">
                  <PenguinMini scan={b} onClick={() => onBirdClick(b.peng_num || b.pit_id)} />
                  <span className="scan-count">{b.scanCount}x</span>
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ObsCard({ obs, onBirdClick, onDayClick, highlight, scrollTo, token, canEdit, allPenguins, hideDate, onDataChange }: { obs: Observation; onBirdClick?: (tag:string)=>void; onDayClick?: (day:string)=>void; highlight?: boolean; scrollTo?: boolean; token?: string; canEdit?: boolean; allPenguins?: any[]; hideDate?: boolean; onDataChange?: ()=>void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [flashing, setFlashing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [editCount, setEditCount] = useState(parseInt(String(obs.edit_count || '0')) || 0);
  const trackEdit = (field: string) => async (val: any) => {
    const result = await saveObs(field)(val);
    if (result?.changed) setEditCount(c => c + 1);
    return result;
  };
  useEffect(() => {
    if (scrollTo && ref.current) {
      ref.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setFlashing(true);
      const timer = setTimeout(() => setFlashing(false), 1500);
      return () => clearTimeout(timer);
    }
  }, [highlight]);
  const obsId = obs.observation_id;
  const [localObs, setLocalObs] = useState(obs);
  const saveObs = (field: string) => async (val: any) => {
    if (!obsId) return;
    const oldVal = localObs[field as keyof typeof localObs] ?? '';
    if (String(oldVal) === String(val ?? '')) return { changed: 0 };
    const desc = `Change ${field} from "${oldVal}" to "${val ?? ''}"${obs.observation_time_utc ? ` (${formatDate(obs.observation_time_utc)})` : ''}`;
    const reason = prompt(`${desc}\n\nReason for change (optional):`);
    if (reason === null) return { changed: 0 }; // cancelled
    const result = await updateRecord(token || '', 'observations', obsId, {[field]: val}, reason || undefined);
    if (result?.changed) { setLocalObs((o: any) => ({...o, [field]: val})); onDataChange?.(); }
    return result;
  };
  const [editing, setEditing] = useState(false);
  const [birdSearch, setBirdSearch] = useState('');
  const [localScans, setLocalScans] = useState<Scan[]>(obs.scans);

  const filteredAdd = birdSearch.length > 0 && allPenguins
    ? allPenguins.filter((p: any) =>
        (p.peng_num === birdSearch || (p.pit_id && p.pit_id.includes(birdSearch)))
        && !localScans.some(s => s.pit_id === p.pit_id)
      ).slice(0, 8)
    : [];

  const addScan = async (p: any) => {
    if (!obsId || !token) return;
    const result = await createRecord(token, 'penguin_scans', {
      observation_id: obsId, pit_id: p.pit_id, scan_time_utc: obs.observation_time_utc
    });
    if (result?.id) {
      const newScan: Scan = { scan_id: result.id, peng_num: p.peng_num, pit_id: p.pit_id, sex: p.sex, life_stage: p.life_stage, chip_date: p.chip_date, chipped_as_adult: p.chipped_as_adult };
      setLocalScans([...localScans, newScan]);
      obs.scans.push(newScan);
      const isChick = isChickAtDate(p, obs.observation_time_utc);
      if (isChick) await trackEdit('chicks')(obs.chicks + 1);
      else await trackEdit('adults')(obs.adults + 1);
    }
    setBirdSearch('');
  };

  const removeScan = async (scan: Scan) => {
    if (!scan.scan_id || !token) return;
    await deleteRecord(token, 'penguin_scans', scan.scan_id);
    const updated = localScans.filter(s => s.scan_id !== scan.scan_id);
    setLocalScans(updated);
    obs.scans.splice(obs.scans.indexOf(scan), 1);
    const bird = allPenguins?.find((p: any) => p.pit_id === scan.pit_id);
    const isChick = isChickAtDate(bird || scan, obs.observation_time_utc);
    if (isChick) await trackEdit('chicks')(Math.max(0, obs.chicks - 1));
    else await trackEdit('adults')(Math.max(0, obs.adults - 1));
  };

  return (
    <div ref={ref} className={`obs-card ${flashing ? 'highlighted' : ''}`}>
      <div className="obs-top">
        {!hideDate && <span><b><DateLink date={obs.observation_time_utc} onDayClick={onDayClick} /></b> <span className="muted small">{obs.monitor_filename}</span></span>}
        <span className="obs-top-right">
          {canEdit && editCount > 0 && obsId && <span className="edit-badge clickable" onClick={() => setShowHistory(!showHistory)}>{editCount === 1 ? 'edited' : `${editCount} edits`}</span>}
          {canEdit && obsId && !editing && <button className="edit-btn" onClick={() => setEditing(true)}>Edit</button>}
          {editing && <>
            <button className="edit-btn" onClick={() => setEditing(false)}>Cancel</button>
            <button className="edit-btn done-btn" onClick={() => setEditing(false)}>Done</button>
            <button className="edit-btn" style={{background:'#F44336', color:'#fff'}} onClick={async () => {
              const reason = prompt(`Delete observation from ${formatDate(obs.observation_time_utc)}?\n\nReason for deletion (optional):`);
              if (reason === null) return;
              await deleteRecord(token || '', 'observations', obsId!, reason || undefined);
              onDataChange?.();
            }}>Delete</button>
          </>}
        </span>
      </div>
      {!editing ? (
        <>
          <div className="obs-nums">
            {localObs.adults === 0 && localObs.eggs === 0 && localObs.chicks === 0 && <span className="muted">Empty</span>}
            {localObs.adults > 0 && <span>{'\uD83D\uDC27'.repeat(Math.min(localObs.adults, 6))}</span>}
            {localObs.eggs > 0 && <span>{'\uD83E\uDD5A'.repeat(Math.min(localObs.eggs, 6))}</span>}
            {localObs.chicks > 0 && <span>{'\uD83D\uDC23'.repeat(Math.min(localObs.chicks, 6))}</span>}
            {(() => { const ds = displayStatus(localObs.breeding_status, localObs.eggs, localObs.chicks); return ds && <span className={`badge ${DARK_TEXT_STATUSES.has(ds)?'bordered':''}`} style={{background:STATUS_COLORS[ds]||'#ccc',color:DARK_TEXT_STATUSES.has(ds)?'#333':'#fff'}}>{ds}</span>; })()}
            {localObs.gate_status && <span className="gate">{localObs.gate_status}</span>}
          </div>
          {localObs.notes && <div className="obs-notes">{localObs.notes}</div>}
        </>
      ) : (
        <>
        <div className="obs-edit-row">
          <label>{'\uD83D\uDC27'}</label><EditableField value={localObs.adults} type="number" onSave={trackEdit('adults')} canEdit={true} />
          <label>{'\uD83E\uDD5A'}</label><EditableField value={localObs.eggs} type="number" onSave={trackEdit('eggs')} canEdit={true} />
          <label>{'\uD83D\uDC23'}</label><EditableField value={localObs.chicks} type="number" onSave={trackEdit('chicks')} canEdit={true} />
          <EditableField value={localObs.breeding_status || ''} type="select" options={['','CON','POT','UNL','NO','DCM','ABN']} onSave={trackEdit('breeding_status')} canEdit={true} />
          <EditableField value={localObs.gate_status || ''} type="select" options={['','Gate up','Regate']} onSave={trackEdit('gate_status')} canEdit={true} />
          <EditableField value={localObs.notes || ''} onSave={trackEdit('notes')} placeholder="notes" canEdit={true} />
        </div>
        <div className="obs-edit-birds">
          {localScans.map(s => (
            <span key={s.scan_id || s.pit_id} className="scan-removable">
              <PenguinMini scan={s} onClick={() => onBirdClick?.(s.peng_num || s.pit_id)} observationDate={obs.observation_time_utc} />
              <button className="remove-scan" onClick={() => removeScan(s)}>&times;</button>
            </span>
          ))}
          <div className="add-scan-search">
            <input className="ef-input" placeholder="Add penguin #..." value={birdSearch} onChange={e => setBirdSearch(e.target.value)} />
            {filteredAdd.length > 0 && (
              <div className="add-scan-results">
                {filteredAdd.map((p: any) => (
                  <div key={p.pit_id} className="add-scan-option" onClick={() => addScan(p)}>
                    <PenguinMini scan={p} onClick={() => addScan(p)} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        </>
      )}
      {!editing && obs.scans.length>0 && (
        <div className="scans">
          {[...obs.scans].sort(scanSortMFC).map((s,j) => (
            <PenguinMini key={j} scan={s} onClick={() => onBirdClick?.(s.peng_num || s.pit_id)} observationDate={obs.observation_time_utc} />
          ))}
        </div>
      )}
      {showHistory && token && obsId && <HistoryPanel token={token} table="observations" id={obsId} onClose={() => setShowHistory(false)} />}
    </div>
  );
}

function EditableField({ value, type, options, onSave, placeholder, canEdit }: {
  value: any; type?: 'text'|'number'|'select'|'date'; options?: string[];
  onSave: (val: any) => Promise<any>; placeholder?: string; canEdit?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value ?? ''));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const ref = useRef<HTMLInputElement|HTMLSelectElement>(null);

  useEffect(() => { if (editing && ref.current) ref.current.focus(); }, [editing]);
  useEffect(() => { setDraft(String(value ?? '')); }, [value]);

  const display = value !== null && value !== undefined && value !== '' ? String(value) : null;

  if (!canEdit) return <span className="ef-value">{display ?? <span className="muted">{placeholder || '-'}</span>}</span>;

  if (!editing) {
    return (
      <span className="ef-value clickable" onClick={() => setEditing(true)}>
        {display ?? <span className="muted">{placeholder || '-'}</span>}
        {saved && <span className="ef-saved">&#10003;</span>}
        <span className="ef-pencil">&#9998;</span>
      </span>
    );
  }

  const save = async () => {
    setSaving(true);
    const val = type === 'number' ? (draft === '' ? null : parseFloat(draft)) : (draft || null);
    await onSave(val);
    setSaving(false);
    setEditing(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const cancel = () => { setDraft(String(value ?? '')); setEditing(false); };

  if (type === 'select') {
    return (
      <select ref={ref as any} className="ef-input" value={draft} disabled={saving}
        onChange={e => { setDraft(e.target.value); }}
        onBlur={save} onKeyDown={e => { if (e.key === 'Escape') cancel(); }}>
        {(options || []).map(o => <option key={o} value={o}>{o || '(none)'}</option>)}
      </select>
    );
  }

  return (
    <input ref={ref as any} className="ef-input" type={type || 'text'} value={draft} disabled={saving}
      placeholder={placeholder}
      onChange={e => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); }} />
  );
}

function HistoryPanel({ token, table, id, onClose }: { token: string; table: string; id: number; onClose: () => void }) {
  const [entries, setEntries] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchHistory(token, table, id).then(d => { setEntries(Array.isArray(d) ? d : []); setLoading(false); });
  }, [token, table, id]);

  return (
    <div className="history-panel">
      <div className="history-header">
        <b>Change history</b>
        <button className="page-back" onClick={onClose}>&times;</button>
      </div>
      {loading ? <p className="muted">Loading...</p> : entries.length === 0 ? <p className="muted">No changes recorded</p> : (
        <div className="history-entries">
          {entries.map((e: any, i: number) => {
            const fields = typeof e.changed_fields === 'string' ? JSON.parse(e.changed_fields) : e.changed_fields;
            return (
              <div key={i} className="history-entry">
                <div className="history-meta">
                  <span className={`history-action ${e.action.toLowerCase()}`}>{e.action}</span>
                  <span className="muted">{e.observer_name}</span>
                  <span className="muted">{parseDate(e.change_timestamp).toLocaleString('en-NZ', {timeZone:'Pacific/Auckland'})}</span>
                </div>
                {e.action === 'UPDATE' && (
                  <div className="history-fields">
                    {Object.entries(fields).map(([k, v]: [string, any]) => (
                      <div key={k} className="history-field">
                        <span className="muted">{k}:</span> <s>{String(v.old ?? '')}</s> &rarr; {String(v.new ?? '')}
                      </div>
                    ))}
                  </div>
                )}
                {e.action === 'INSERT' && (e.table_name === 'penguin_scans' && e.penguin_info ? (
                  <div className="history-fields">
                    <PenguinMini scan={e.penguin_info} onClick={() => {}} /> added
                  </div>
                ) : <div className="history-fields muted">Record created</div>)}
                {e.action === 'DELETE' && (e.table_name === 'penguin_scans' && e.penguin_info ? (
                  <div className="history-fields">
                    <PenguinMini scan={e.penguin_info} onClick={() => {}} /> removed
                  </div>
                ) : <div className="history-fields muted">Record deleted</div>)}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function BirdPage({ data, onBirdClick, onBoxClick, onSightingClick, onDayClick, onNavigateToBird, token, canEdit }: { data: any; onBirdClick: (tag:string)=>void; onBoxClick: (box:string)=>void; onSightingClick: (box:string, date:string)=>void; onDayClick?: (day:string)=>void; onNavigateToBird?: (num:string)=>void; token?: string; canEdit?: boolean }) {
  const p = data.penguin;
  const sightings: any[] = data.sightings || [];
  const biometrics: any[] = data.biometrics || [];
  const partners: any[] = data.partners || [];
  const breedingStats: any[] = data.breeding_stats || [];

  const chips: any[] = p.chips || [];
  const activeChip = chips.find((c: any) => c.is_active == 1) || chips[0];

  const boxes = Array.from(new Set(sightings.map((s: any) => s.box)));
  const [showHistory, setShowHistory] = useState<{table:string;id:number}|null>(null);
  const [hasHistory, setHasHistory] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showBio, setShowBio] = useState(false);
  useEffect(() => {
    if (token && p.peng_num) {
      fetchHistory(token, 'penguins', p.peng_num).then(d => setHasHistory(Array.isArray(d) && d.length > 0));
    }
  }, [token, p.peng_num]);
  const savePenguin = (field: string) => async (val: any) => {
    const oldVal = p[field] ?? '';
    if (String(oldVal) === String(val ?? '')) return;
    const reason = prompt(`Change ${field} on penguin #${p.peng_num} from "${oldVal}" to "${val ?? ''}"?\n\nReason (optional):`);
    if (reason === null) return;
    return updateRecord(token || '', 'penguins', p.peng_num, {[field]: val}, reason || undefined);
  };
  const saveChip = (pitId: string, field: string) => async (val: any) => {
    const reason = prompt(`Change ${field} on chip ${pitId.slice(-8)}?\n\nReason (optional):`);
    if (reason === null) return;
    return updateRecord(token || '', 'penguin_chips', pitId, {[field]: val}, reason || undefined);
  };
  const saveBio = (bioId: number, field: string) => async (val: any) => {
    const reason = prompt(`Change ${field} on biometric record?\n\nReason (optional):`);
    if (reason === null) return;
    return updateRecord(token || '', 'penguin_biometric_data', bioId, {[field]: val}, reason || undefined);
  };


  return (
    <div className="bird-detail">
      <div className="bird-title-row">
        <span className="bird-title-peng">
          Penguin: <PenguinMini scan={{peng_num: p.peng_num, pit_id: activeChip?.pit_id, sex: p.sex, chip_date: activeChip?.chip_date, chipped_as_adult: p.chipped_as_adult, chick_size_code: p.chick_size_code}} onClick={() => onNavigateToBird?.(p.peng_num)} />
        </span>
        <span className="bird-title-actions">
          {canEdit && !editing && <button className="edit-btn" onClick={() => setEditing(true)}>Edit</button>}
          {editing && <><button className="edit-btn" onClick={() => setEditing(false)}>Cancel</button><button className="edit-btn done-btn" onClick={() => setEditing(false)}>Done</button></>}
          {canEdit && hasHistory && <button className="history-btn" onClick={() => setShowHistory({table:'penguins', id:p.peng_num})}>History</button>}
        </span>
      </div>

      {showHistory && token && <HistoryPanel token={token} table={showHistory.table} id={showHistory.id} onClose={() => setShowHistory(null)} />}

      {/* All penguin data */}
      <div className="bird-section">
        <table className="bird-table">
          <tbody>
            <tr><td className="muted">Sex</td><td>{!editing ? (p.sex || <span className="muted">-</span>) : <EditableField value={p.sex} type="select" options={['','M','F']} onSave={savePenguin('sex')} canEdit={true} />}</td></tr>
            <tr><td className="muted">Chipped as Chick</td><td>{p.chipped_as_adult ? 'No' : 'Yes'}</td></tr>
            <tr><td className="muted">Initial Chip Date</td><td>{chips.length > 0 && chips[0].chip_date ? <DateLink date={chips[0].chip_date} onDayClick={onDayClick} /> : <span className="muted">-</span>}</td></tr>
            <tr><td className="muted">Chick Size Code</td><td>{!editing ? (p.chick_size_code || <span className="muted">-</span>) : <EditableField value={p.chick_size_code} onSave={savePenguin('chick_size_code')} placeholder="-" canEdit={true} />}</td></tr>
            <tr><td className="muted">VID</td><td>{!editing ? (p.vid_for_scanner || <span className="muted">-</span>) : <EditableField value={p.vid_for_scanner} onSave={savePenguin('vid_for_scanner')} placeholder="-" canEdit={true} />}</td></tr>
            <tr><td className="muted">Notes</td><td>{!editing ? (p.kommentar || <span className="muted">-</span>) : <EditableField value={p.kommentar} onSave={savePenguin('kommentar')} placeholder="-" canEdit={true} />}</td></tr>
            {chips.map((c: any, i: number) => {
              const re = 'Re'.repeat(i);
              const prefix = i === 0 ? '' : re.toLowerCase();
              return (<Fragment key={`chip${i}`}>
              <tr><td className="muted">{prefix ? `${re}chip ` : ''}PIT ID</td><td>{c.pit_id}{!c.is_active && <span className="bird-badge" style={{background:'#FFCDD2', marginLeft:4}}>Retired</span>}</td></tr>
              <tr><td className="muted">{prefix ? `${re}chip ` : 'Chip '}Date</td><td>{!editing ? (c.chip_date ? <DateLink date={c.chip_date} onDayClick={onDayClick} /> : <span className="muted">-</span>) : <EditableField value={c.chip_date} type="date" onSave={saveChip(c.pit_id, 'chip_date')} placeholder="date" canEdit={true} />}</td></tr>
              <tr><td className="muted">{prefix ? `${re}chip ` : 'Chip '}Box</td><td>{!editing ? (c.chip_box ? <a className="clickable" href={`/box/${c.chip_box}`} onClick={e => navClick(e, () => onBoxClick(c.chip_box))}>{c.chip_box}</a> : <span className="muted">-</span>) : <EditableField value={c.chip_box} onSave={saveChip(c.pit_id, 'chip_box')} placeholder="box" canEdit={true} />}</td></tr>
              <tr><td className="muted">{prefix ? `${re}chipped ` : 'Chipped '}By</td><td>{!editing ? (c.chip_by || <span className="muted">-</span>) : <EditableField value={c.chip_by} onSave={saveChip(c.pit_id, 'chip_by')} placeholder="who" canEdit={true} />}</td></tr>
            </Fragment>);
            })}
            <tr><td className="muted">Last Known Life Stage</td><td>{!editing ? (p.life_stage || <span className="muted">-</span>) : <EditableField value={p.life_stage} type="select" options={['Adult','Chick','Returnee','Dead']} onSave={savePenguin('life_stage')} canEdit={true} />}</td></tr>
            {(() => {
              if (biometrics.length === 0) return null;
              // Build summary
              const sexCounts: Record<string,number> = {};
              const lastComment = biometrics.find((b: any) => b.notes)?.notes;
              const weights = biometrics.filter((b: any) => b.weight).map((b: any) => parseFloat(b.weight));
              biometrics.forEach((b: any) => { if (b.observed_sex) sexCounts[b.observed_sex] = (sexCounts[b.observed_sex] || 0) + 1; });
              const sexSummary = Object.entries(sexCounts).map(([s, n]) => `sexed ${s} ${n}x`).join(', ');
              const weightSummary = weights.length > 0 ? `${Math.min(...weights)}-${Math.max(...weights)}g (${weights.length}x)` : '';
              const summary = [sexSummary, weightSummary, lastComment ? `"${lastComment.slice(0, 40)}"` : ''].filter(Boolean).join(' · ');

              return (<>
              <tr><td className="muted">Biometrics</td><td className="clickable" onClick={() => setShowBio(!showBio)}>{summary} <span className="muted small">{biometrics.length} records {showBio ? '▲' : '▼'}</span></td></tr>
              {showBio && biometrics.map((b: any, i: number) => {
                const flags = [
                  b.is_moulting && 'Moulting', b.condition_underweight && 'Underweight',
                  b.condition_ticks && 'Ticks', b.condition_dead && 'Dead',
                  b.condition_dog_attacked && 'Dog Attacked', b.condition_attacked && 'Attacked',
                  b.disposition_aggressive && 'Aggressive', b.disposition_passive && 'Passive',
                ].filter(Boolean);
                return (<Fragment key={`bio${i}`}>
                <tr><td className="muted" colSpan={2} style={{fontWeight:600, paddingTop:4, fontSize:11}}>{b.observation_date || ''}</td></tr>
                {b.observed_sex && <tr><td className="muted">Sex</td><td>{b.observed_sex}</td></tr>}
                {b.weight && <tr><td className="muted">Weight</td><td>{!editing ? `${parseFloat(b.weight).toFixed(0)}g` : <><EditableField value={parseFloat(b.weight).toFixed(0)} type="number" onSave={saveBio(b.biometric_id, 'weight')} placeholder="weight" canEdit={true} /><span>g</span></>}</td></tr>}
                {b.right_flipper_length && <tr><td className="muted">Flipper</td><td>{!editing ? `${parseFloat(b.right_flipper_length).toFixed(0)}mm` : <><EditableField value={parseFloat(b.right_flipper_length).toFixed(0)} type="number" onSave={saveBio(b.biometric_id, 'right_flipper_length')} placeholder="mm" canEdit={true} /><span>mm</span></>}</td></tr>}
                {flags.length > 0 && <tr><td className="muted">Flags</td><td>{flags.join(', ')}</td></tr>}
                {b.notes && <tr><td className="muted">Note</td><td style={{fontSize:11}}>{b.notes}</td></tr>}
              </Fragment>);
              })}
              </>);
            })()}
          </tbody>
        </table>
      </div>

      {/* Breeding history by season */}
      {breedingStats.length > 0 && (
        <div className="bird-section">
          <h3>Breeding history</h3>
          {breedingStats.map((bs: any) => (
            <div key={bs.season} className="obs-card">
              <b>{bs.season}</b>
              <div className="obs-nums">
                <span>{bs.scans} scan{bs.scans!==1?'s':''}</span>
                <span>Box{bs.boxes.length>1?'es':''}: {bs.boxes.join(', ')}</span>
                {bs.max_eggs > 0 && <span>{'\uD83E\uDD5A'.repeat(Math.min(bs.max_eggs,4))}</span>}
                {bs.max_chicks > 0 && <span>{'\uD83D\uDC23'.repeat(Math.min(bs.max_chicks,4))}</span>}
                {bs.statuses.map((s:string) => <span key={s} className={`badge ${DARK_TEXT_STATUSES.has(s)?'bordered':''}`} style={{background:STATUS_COLORS[s]||'#ccc',color:DARK_TEXT_STATUSES.has(s)?'#333':'#fff'}}>{s}</span>)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Locations with sightings */}
      <div className="bird-section">
        <h3>Seen in {boxes.length} box{boxes.length !== 1 ? 'es' : ''}</h3>
        {boxes.map((b: string) => {
          const boxSightings = sightings.filter((s: any) => s.box === b);
          return (
            <div key={b} className="obs-card" style={{marginBottom:6}}>
              <div className="obs-top"><a className="clickable" href={`/box/${b}`} onClick={e => navClick(e, () => onBoxClick(b))}><b>Box {b}</b></a> <span className="muted">{boxSightings.length} visit{boxSightings.length !== 1 ? 's' : ''}</span></div>
              {boxSightings.map((sg: any, i: number) => (
                <div key={i} style={{marginBottom:3}}>
                  <div className="obs-nums" style={{fontSize:11}}>
                    <DateLink date={sg.date} onDayClick={onDayClick} />
                    {(sg.seen_with || []).map((sw: any) => (
                      <PenguinMini key={sw.peng_num} scan={sw} onClick={() => onBirdClick(sw.peng_num)} observationDate={sg.date} />
                    ))}
                    {(() => { const ds = displayStatus(sg.breeding_status, sg.eggs, sg.chicks); return ds && ds !== 'NO' && <span className={`badge ${DARK_TEXT_STATUSES.has(ds)?'bordered':''}`} style={{background:STATUS_COLORS[ds]||'#ccc',color:DARK_TEXT_STATUSES.has(ds)?'#333':'#fff'}}>{ds}</span>; })()}
                  </div>
                  {sg.notes && <div className="obs-notes">{sg.notes}</div>}
                </div>
              ))}
            </div>
          );
        })}
      </div>

      {/* Sighting history */}
      <div className="bird-section">
        <h3>Sighting history ({sightings.length})</h3>
        {sightings.map((s: any, i: number) => (
          <div key={i} className="obs-card">
            <div className="obs-top">
              <b><DateLink date={s.date} onDayClick={onDayClick} /></b>
              <a className="bird-chip clickable" href={`/box/${s.box}`} onClick={e => navClick(e, () => onBoxClick(s.box))}>Box {s.box}</a>
            </div>
            <div className="obs-nums">
              {s.adults === 0 && s.eggs === 0 && s.chicks === 0 && <span className="muted">Empty</span>}
              {s.adults > 0 && <span>{'\uD83D\uDC27'.repeat(Math.min(s.adults, 6))}</span>}
              {s.eggs > 0 && <span>{'\uD83E\uDD5A'.repeat(Math.min(s.eggs, 6))}</span>}
              {s.chicks > 0 && <span>{'\uD83D\uDC23'.repeat(Math.min(s.chicks, 6))}</span>}
              {(() => { const ds = displayStatus(s.breeding_status, s.eggs, s.chicks); return ds && <span className={`badge ${DARK_TEXT_STATUSES.has(ds)?'bordered':''}`} style={{background:STATUS_COLORS[ds]||'#ccc',color:DARK_TEXT_STATUSES.has(ds)?'#333':'#fff'}}>{ds}</span>; })()}
              {(s.seen_with || []).map((sw: any) => (
                <PenguinMini key={sw.peng_num} scan={sw} onClick={() => onBirdClick(sw.peng_num)} observationDate={s.date} />
              ))}
            </div>
            {s.notes && <div className="obs-notes">{s.notes}</div>}
          </div>
        ))}
      </div>


      {/* Partners */}
      {partners.length > 0 && (
        <div className="bird-section">
          <h3>Partners ({partners.length})</h3>
          <p className="muted">Birds scanned in the same box at the same time</p>
          {partners.map((pt: any) => (
            <div key={pt.peng_num} className="partner-card">
              <div className="partner-head">
                <PenguinMini scan={{peng_num: pt.peng_num, pit_id: pt.pit_id, sex: pt.sex, chipped_as_adult: pt.chipped_as_adult, chip_date: pt.chip_date}} onClick={() => onBirdClick(pt.peng_num)} />
                <span className="muted">{pt.sightings.length} shared sighting{pt.sightings.length !== 1 ? 's' : ''}</span>
              </div>
              <div className="partner-sightings">
                {pt.sightings.map((s: any, i: number) => (
                  <a key={i} className="partner-row clickable" href={`/box/${s.box}`} onClick={e => navClick(e, () => onSightingClick(s.box, s.date))}>
                    <DateLink date={s.date} onDayClick={onDayClick} />
                    <span className="bird-chip">Box {s.box}</span>
                    {s.eggs > 0 && <span>{'\uD83E\uDD5A'.repeat(Math.min(s.eggs, 4))}</span>}
                    {s.chicks > 0 && <span>{'\uD83D\uDC23'.repeat(Math.min(s.chicks, 4))}</span>}
                    {(() => { const ds = displayStatus(s.breeding_status, s.eggs, s.chicks); return ds && ds !== 'NO' && <span className={`badge ${DARK_TEXT_STATUSES.has(ds)?'bordered':''}`} style={{background:STATUS_COLORS[ds]||'#ccc',color:DARK_TEXT_STATUSES.has(ds)?'#333':'#fff'}}>{ds}</span>; })()}
                    {(s.also_seen || []).map((sw: any) => (
                      <PenguinMini key={sw.peng_num} scan={sw} onClick={() => onBirdClick(sw.peng_num)} observationDate={s.date} />
                    ))}
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PenguinSearch({ penguins, search, onSearchChange, onBirdClick }: {
  penguins: any[]; search: string; onSearchChange: (s:string)=>void; onBirdClick: (tag:string)=>void;
}) {
  const [open, setOpen] = useState(false);
  const filtered = useMemo(() => {
    if (search.length === 0) return { exact: [] as any[], pit: [] as any[] };
    const exact = penguins.filter(p => p.peng_num && p.peng_num === search);
    const pit = penguins.filter(p => p.pit_id && p.pit_id.includes(search) && !(p.peng_num && p.peng_num === search));
    return { exact, pit };
  }, [penguins, search]);

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      const first = filtered.exact[0] || filtered.pit[0];
      if (first) { onBirdClick(first.peng_num || first.pit_id); onSearchChange(''); setOpen(false); }
    } else if (e.key === 'Escape') { setOpen(false); }
  };

  return (
    <div className="penguin-search">
      <input
        type="text"
        placeholder="Search penguin"
        value={search}
        onChange={e => { onSearchChange(e.target.value.replace(/[^0-9A-Za-z]/g, '')); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 200)}
        onKeyDown={handleKey}
        className="penguin-search-input"
      />
      {open && (filtered.exact.length > 0 || filtered.pit.length > 0) && (
        <div className="penguin-results">
          {filtered.exact.map((p: any) => (
            <div key={p.peng_num} className={`penguin-result clickable ${penguinSexClass(p.sex, p.chip_date, p.chipped_as_adult)}`} onClick={() => { onBirdClick(p.peng_num); onSearchChange(''); }}>
              <span className="pr-tag"><PenguinMini scan={p} onClick={() => { onBirdClick(p.peng_num); onSearchChange(''); }} /></span>
              <span className="pr-meta">
                                                <span className="pr-stat">{p.total_scans} scan{p.total_scans>1?'s':''}</span>
              </span>
            </div>
          ))}
          {filtered.exact.length > 0 && filtered.pit.length > 0 && <div className="muted small" style={{padding:'2px 8px', borderTop:'1px solid #eee'}}>PIT ID matches:</div>}
          {filtered.pit.slice(0, 20).map((p: any) => (
            <div key={p.pit_id} className={`penguin-result clickable ${penguinSexClass(p.sex, p.chip_date, p.chipped_as_adult)}`} onClick={() => { onBirdClick(p.peng_num || p.pit_id); onSearchChange(''); }}>
              <span className="pr-tag"><PenguinMini scan={p} onClick={() => { onBirdClick(p.peng_num || p.pit_id); onSearchChange(''); }} /></span>
              <span className="pr-meta">
                                                <span className="pr-stat">{p.total_scans} scan{p.total_scans>1?'s':''}</span>
              </span>
            </div>
          ))}
          {filtered.pit.length > 20 && <div className="muted" style={{padding:'4px 8px'}}>+{filtered.pit.length - 20} more</div>}
        </div>
      )}
      {open && search.length > 0 && filtered.exact.length === 0 && filtered.pit.length === 0 && (
        <div className="penguin-results"><div className="muted" style={{padding:'8px'}}>No penguins match "{search}"</div></div>
      )}
    </div>
  );
}

/** Parse flexible date input into YYYY-MM-DD. Accepts d/m/yy, dd/mm/yyyy, d-m-yy, d m yy, yyyy-mm-dd, yy-m-d etc. */
function parseDateInput(input: string): string | null {
  const s = input.trim();
  if (!s) return null;

  // Split on /, -, space, or .
  const parts = s.split(/[\/\-\.\s]+/);
  if (parts.length !== 3) return null;

  let day: number, month: number, year: number;

  // Detect format: if first part is 4 digits, it's yyyy-mm-dd
  if (parts[0].length === 4) {
    year = parseInt(parts[0]); month = parseInt(parts[1]); day = parseInt(parts[2]);
  } else if (parts[2].length === 4) {
    // d/m/yyyy
    day = parseInt(parts[0]); month = parseInt(parts[1]); year = parseInt(parts[2]);
  } else {
    // Ambiguous short year: assume d/m/yy (NZ convention)
    day = parseInt(parts[0]); month = parseInt(parts[1]); year = parseInt(parts[2]);
    if (year < 100) year += 2000;
  }

  if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

function DateSearch({ dates, onDayClick, onFocusChange }: { dates: string[]; onDayClick: (day: string) => void; onFocusChange?: (focused: boolean, centerDate: string) => void }) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);

  const filtered = useMemo(() => {
    if (!search.trim()) return [];
    const parsed = parseDateInput(search);
    const MONTHS: Record<string, number> = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };

    return dates.filter(d => {
      const [yr, mo, dy] = d.split('-').map(Number);

      // Exact full date match
      if (parsed && d === parsed) return true;

      // Match against formatted display (e.g. "5 Sep 2025")
      const display = formatDate(d).toLowerCase();
      const terms = search.toLowerCase().trim();
      if (display.includes(terms)) return true;

      // Split input into parts
      const parts = search.split(/[\/\-\.\s]+/).filter(Boolean);

      if (parts.length === 1) {
        const p = parts[0].toLowerCase();
        const n = parseInt(p);
        // Single number: match day or month
        if (!isNaN(n)) {
          if (n === dy || n === mo) return true;
          // 2-digit year
          if (n >= 20 && n < 100 && n + 2000 === yr) return true;
          // 4-digit year
          if (n === yr) return true;
        }
        // Month name
        if (MONTHS[p.slice(0, 3)] === mo) return true;
      }

      if (parts.length === 2) {
        const [a, b] = parts.map(p => p.toLowerCase());
        const na = parseInt(a), nb = parseInt(b);

        // Resolve month names
        const ma = MONTHS[a.slice(0, 3)];
        const mb = MONTHS[b.slice(0, 3)];

        // year + month: "2025 12", "25 12", "25 dec"
        if (!isNaN(na) && (na >= 2000 || (na >= 20 && na < 100))) {
          const year = na >= 2000 ? na : na + 2000;
          if (year === yr) {
            if (!isNaN(nb) && nb === mo) return true;
            if (mb === mo) return true;
          }
        }
        // month + year: "12 2025", "dec 25"
        if (!isNaN(nb) && (nb >= 2000 || (nb >= 20 && nb < 100))) {
          const year = nb >= 2000 ? nb : nb + 2000;
          if (year === yr) {
            if (!isNaN(na) && na === mo) return true;
            if (ma === mo) return true;
          }
        }
        // d/m: "5/9", "28/12"
        if (!isNaN(na) && !isNaN(nb) && na <= 31 && nb <= 12) {
          if (na === dy && nb === mo) return true;
        }
        // month + day: "dec 28"
        if (ma && !isNaN(nb) && ma === mo && nb === dy) return true;
        // day + month: "28 dec"
        if (mb && !isNaN(na) && mb === mo && na === dy) return true;
      }

      if (parts.length === 3 && parsed) {
        return d.startsWith(parsed);
      }

      return false;
    }).slice(0, 12);
  }, [dates, search]);

  const go = (day: string) => {
    onDayClick(day);
    setSearch('');
    setOpen(false);
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (filtered.length > 0) {
        go(filtered[0]);
      } else {
        const parsed = parseDateInput(search);
        if (parsed) go(parsed);
      }
    } else if (e.key === 'Escape') {
      setSearch('');
      setOpen(false);
    }
  };

  const sorted = useMemo(() => [...dates].sort(), [dates]);
  const centerDate = filtered.length > 0 ? filtered[0] : sorted[sorted.length - 1] || '';

  useEffect(() => {
    onFocusChange?.(open, centerDate);
  }, [open, centerDate]);

  return (
    <div className="date-search">
      <input
        type="text"
        placeholder="Date"
        value={search}
        onChange={e => { setSearch(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 300)}
        onKeyDown={handleKey}
        className="date-search-input"
      />
      {open && filtered.length > 0 && (
        <div className="date-results">
          {filtered.map((d, i) => (
            <div key={d} className={`date-result clickable${i === 0 ? ' focused' : ''}`} onClick={() => go(d)}>
              {formatDate(d)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LoginScreen({ onLogin }: { onLogin: (token: string, name: string, observerId?: number | string, role?: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [isRegister, setIsRegister] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      if (isRegister) {
        const r = await fetch('/penguin-api/crud.php?action=register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, email, password })
        });
        const data = await r.json();
        if (data.success) {
          // Auto-login after register
          setIsRegister(false);
          setError('');
          const r2 = await fetch('/penguin-api/crud.php?action=login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
          });
          const d2 = await r2.json();
          if (d2.token) { if (d2.email) localStorage.setItem('ww_email', d2.email); onLogin(d2.token, d2.name, d2.observer_id, d2.role); }
          else setError('Registered but login failed');
        } else {
          setError(data.error || 'Registration failed');
        }
      } else {
        const r = await fetch('/penguin-api/crud.php?action=login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password })
        });
        const text = await r.text();
        try {
          const data = JSON.parse(text);
          if (data.token) { if (data.email) localStorage.setItem('ww_email', data.email); onLogin(data.token, data.name, data.observer_id, data.role); }
          else setError(data.error || 'Login failed');
        } catch {
          setError('Server returned unexpected response: ' + text.substring(0, 100));
        }
      }
    } catch (e: any) {
      setError('Connection failed: ' + (e.message || ''));
    }
    setSubmitting(false);
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>Wildwatch</h1>
        <p className="login-sub">Penguin Colony Monitoring</p>
        <form onSubmit={handleSubmit}>
          {isRegister && <input type="text" placeholder="Name" value={name} onChange={e => setName(e.target.value)} required />}
          <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} required />
          <div className="password-field">
            <input type={showPassword ? 'text' : 'password'} placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} required minLength={6} />
            <button type="button" className="toggle-pw" onClick={() => setShowPassword(!showPassword)}>{showPassword ? '\u{1F441}' : '\u{1F441}'}</button>
          </div>
          {error && <div className="login-error">{error}</div>}
          <button type="submit" disabled={submitting}>{submitting ? 'Please wait...' : isRegister ? 'Register' : 'Log in'}</button>
        </form>
      </div>
    </div>
  );
}

function parseDateFlex(input: string): string | null {
  // Parse dates in day-first formats. Year always required.
  // "11/2/25", "11-2-2025", "11 2 25", "26/7/25"
  // NEVER American format. Day is always first.
  const parts = input.trim().split(/[\s\/\-]+/);
  if (parts.length !== 3) return null;
  const day = parseInt(parts[0]);
  const month = parseInt(parts[1]);
  let year = parseInt(parts[2]);
  if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (year < 100) year += 2000;
  return `${year}-${String(month).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
}

function parseSeasonDate(input: string, _seasonYear: number): string | null {
  return parseDateFlex(input);
}

function DataEntryPage({ token, allPenguins, onBack }: { token: string; allPenguins: any[]; onBack: () => void }) {
  const [season, setSeason] = useState(getSeasonStart().getFullYear());
  const [box, setBox] = useState('');
  const [dateInput, setDateInput] = useState('');
  const [parsedDate, setParsedDate] = useState<string|null>(null);
  const [adults, setAdults] = useState(0);
  const [eggs, setEggs] = useState(0);
  const [chicks, setChicks] = useState(0);
  const [gateStatus, setGateStatus] = useState('');
  const [breedingStatus, setBreedingStatus] = useState('');
  const [notes, setNotes] = useState('');
  const [birdSearch, setBirdSearch] = useState('');
  const [dateMappings, setDateMappings] = useState<{date_number:number; actual_date:string}[]>([]);
  const [showDateEditor, setShowDateEditor] = useState(false);
  const [dateEditorText, setDateEditorText] = useState('');
  const [scannedBirds, setScannedBirds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [lastSavedObsId, setLastSavedObsId] = useState<number|null>(null);

  // Load date mappings for season
  useEffect(() => {
    if (season < 2020) return;
    fetch(`/penguin-api/dates.php?season=${season}`)
      .then(r => r.json())
      .then(d => setDateMappings(d))
      .catch(() => setDateMappings([]));
  }, [season]);

  useEffect(() => {
    // Try date number lookup first, then "d m" format
    const trimmed = dateInput.trim();
    const num = parseInt(trimmed);
    if (!isNaN(num) && trimmed === String(num)) {
      const mapping = dateMappings.find(m => m.date_number === num);
      if (mapping) { setParsedDate(mapping.actual_date); return; }
    }
    setParsedDate(parseSeasonDate(trimmed, season));
  }, [dateInput, season, dateMappings]);

  const filteredBirds = birdSearch.length > 0
    ? allPenguins.filter((p: any) => p.pit_id && (p.pit_id.includes(birdSearch) || (p.peng_num && p.peng_num === birdSearch)) && !p.pit_id.startsWith('LA900025') && !p.pit_id.startsWith('9130')).slice(0, 10)
    : [];
  const [searchIdx, setSearchIdx] = useState(-1);
  useEffect(() => { setSearchIdx(-1); }, [birdSearch]);

  const handleSearchKey = (e: React.KeyboardEvent) => {
    if (filteredBirds.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setSearchIdx(i => Math.min(i + 1, filteredBirds.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSearchIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter' && searchIdx >= 0) { e.preventDefault(); addBird(filteredBirds[searchIdx].pit_id); }
  };

  const addBird = (tag: string) => {
    const short = tag.slice(-8);
    if (scannedBirds.includes(short)) return;

    // Reject box tags
    if (tag.startsWith('LA900025') || tag.startsWith('9130') || short.startsWith('9130')) {
      setMessage('Box tag - not a penguin');
      return;
    }

    // Must be a known penguin
    const birdInfo = allPenguins.find((p: any) => p.pit_id.slice(-8) === short || p.pit_id === tag);
    if (!birdInfo) {
      setMessage(`Unknown penguin ${short} - not in database`);
      return;
    }
    if (parsedDate) {
      if (birdInfo.chip_date && parsedDate < birdInfo.chip_date) {
        if (!confirm(`WARNING: Observation date ${parsedDate} is before this penguin's chip date ${birdInfo.chip_date}. Continue?`)) return;
      }
      if (birdInfo.life_stage === 'Dead') {
        if (!confirm(`WARNING: ${short} is recorded as dead. Continue?`)) return;
      }
    }

    // Check for alerts
    const seenBirds = new Set<string>();
    for (const o of existingObs) {
      for (const s of (o.scans || [])) seenBirds.add(s.pit_id.slice(-8));
    }
    scannedBirds.forEach(b => seenBirds.add(b));
    const isNew = !seenBirds.has(short);

    // Red alert: only if the date being entered is AFTER eggs first appeared
    if (isNew && parsedDate) {
      const firstEggDate = existingObs
        .filter((o: any) => o.eggs > 0)
        .map((o: any) => o.observation_time_utc.slice(0, 10))
        .sort()[0];
      if (firstEggDate && parsedDate >= firstEggDate) {
        if (!confirm(`RED ALERT: ${short} has not been seen in this box before and eggs appeared on ${firstEggDate}. This observation is dated ${parsedDate}. Are you sure?`)) return;
      } else if (seenBirds.size >= 2) {
        if (!confirm(`WARNING: ${short} is a 3rd+ penguin in this box (${seenBirds.size} already seen). Are you sure?`)) return;
      }
    } else if (isNew && seenBirds.size >= 2) {
      if (!confirm(`WARNING: ${short} is a 3rd+ penguin in this box (${seenBirds.size} already seen). Are you sure?`)) return;
    }

    setScannedBirds([...scannedBirds, short]);
    setBirdSearch('');

    // Auto-increment adult or chick count: chick if chipped as chick and <3 months since chip
    if (parsedDate && birdInfo.chip_date && !birdInfo.chipped_as_adult) {
      const chipTime = new Date(birdInfo.chip_date).getTime();
      const obsTime = new Date(parsedDate).getTime();
      if ((obsTime - chipTime) < 90 * 86400000) setChicks(c => c + 1);
      else setAdults(a => a + 1);
    } else {
      setAdults(a => a + 1);
    }
  };

  const removeBird = (tag: string) => {
    const bird = allPenguins.find((p: any) => p.pit_id.slice(-8) === tag || p.pit_id === tag);
    if (bird && parsedDate && bird.chip_date && !bird.chipped_as_adult) {
      const chipTime = new Date(bird.chip_date).getTime();
      const obsTime = new Date(parsedDate).getTime();
      if ((obsTime - chipTime) < 90 * 86400000) setChicks(c => Math.max(0, c - 1));
      else setAdults(a => Math.max(0, a - 1));
    } else {
      setAdults(a => Math.max(0, a - 1));
    }
    setScannedBirds(scannedBirds.filter(b => b !== tag));
  };

  const handleSave = async () => {
    if (!box || !parsedDate) { setMessage('Box and valid date required'); return; }
    setSaving(true); setMessage('');

    try {
      // Find location_id for this box
      const dashRes = await fetch(`/penguin-api/dashboard.php?view=box&name=${encodeURIComponent(box)}&_=${Date.now()}`);
      const dashData = await dashRes.json();
      const locationId = dashData.location?.location_id;

      if (!locationId) { setMessage(`Box "${box}" not found in database (no location_id)`); setSaving(false); return; }

      const observerId = parseInt(localStorage.getItem('ww_observer_id') || '3');

      // Create observation
      const obsRes = await fetch('/penguin-api/crud.php?action=create&table=observations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          location_id: locationId,
          observer_id: observerId,
          observation_time_utc: parsedDate + ' 02:00:00',
          adults, eggs, chicks,
          breeding_status: breedingStatus || null,
          gate_status: gateStatus || null,
          notes,
          monitor_filename: `web-entry, ${localStorage.getItem('ww_email') || 'unknown'}`
        })
      });
      const obsData = await obsRes.json();

      if (!obsData.success) { setMessage('Failed: ' + (obsData.error || 'unknown')); setSaving(false); return; }

      // 3. Create penguin scans
      for (const birdId of scannedBirds) {
        const knownBird = allPenguins.find((p: any) => p.pit_id.slice(-8) === birdId || p.pit_id === birdId);
        if (!knownBird) {
          setMessage(`Unknown penguin ${birdId} - not in database`);
          continue;
        }
        await fetch('/penguin-api/crud.php?action=create&table=penguin_scans', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({
            observation_id: obsData.id,
            pit_id: knownBird.pit_id,
            scan_time_utc: parsedDate + ' 02:00:00'
          })
        });
      }

      setMessage(`Saved: Box ${box}, ${formatDate(parsedDate)}, ${scannedBirds.length} birds`);
      setLastSavedObsId(obsData.id);
      // Reset form
      setAdults(0); setEggs(0); setChicks(0); setGateStatus(''); setBreedingStatus('');
      setNotes(''); setScannedBirds([]); setDateInput('');
    } catch (e: any) {
      setMessage('Error: ' + e.message);
    }
    setSaving(false);
  };

  // Load all observations for this box (for status bar + season list)
  const [allBoxObs, setAllBoxObs] = useState<Observation[]>([]);
  useEffect(() => {
    if (!box) { setAllBoxObs([]); return; }
    fetch(`/penguin-api/dashboard.php?view=box&name=${encodeURIComponent(box)}`)
      .then(r => r.json())
      .then(d => setAllBoxObs(d.observations || []))
      .catch(() => setAllBoxObs([]));
  }, [box, saving]);

  const seasonStart = `${season}-04-01`;
  const seasonEnd = `${season + 1}-03-31`;
  const existingObs = allBoxObs.filter(o =>
    o.observation_time_utc >= seasonStart && o.observation_time_utc <= seasonEnd + ' 23:59:59'
  );

  return (
    <div className="entry-page">
      <div className="entry-header">
        <button className="back-btn" onClick={onBack}>&larr; Back</button>
        <h2>Enter Observation Data</h2>
      </div>

      {/* Persistent context: season + box */}
      <div className="entry-context">
        <div className="entry-row-group">
          <div className="entry-field">
            <label>Season</label>
            <select autoFocus value={season} onChange={e => setSeason(parseInt(e.target.value))} style={{width:'80px'}}>
              {Array.from({length: getSeasonStart().getFullYear() - 2000 - 20}, (_, i) => 21 + i).map(y => <option key={y} value={2000+y}>{y}</option>)}
            </select>
          </div>
          <div className="entry-field">
            <label>Box</label>
            <input type="text" value={box} onChange={e => setBox(e.target.value)} placeholder="e.g. 34" />
          </div>
        </div>
      </div>

      {/* Breeding status bar - always visible */}
      {box && allBoxObs.length > 0 && (
        <div className="entry-context">
          <BreedingStatusBar observations={allBoxObs} />
        </div>
      )}

      <div className="entry-split">
      {/* LEFT: date table + existing data */}
      <div className="entry-left">
      {/* Date mappings */}
      <div className="entry-context">
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'6px'}}>
          <span style={{fontSize:'13px', fontWeight:600, color:'#1a5276'}}>Date table (season {String(season).slice(-2)})</span>
          <button type="button" style={{padding:'4px 12px', background:'#1a5276', color:'#fff', border:'none', borderRadius:'4px', fontSize:'12px', cursor:'pointer'}} onClick={() => { setDateEditorText(dateMappings.map(m => {
                const d = m.actual_date;
                return `${m.date_number} ${formatDate(d)}`;
              }).join('\n')); setShowDateEditor(true); }}>
            {dateMappings.length > 0 ? 'Edit dates' : 'Set up dates'}
          </button>
        </div>
        {dateMappings.length > 0 ? (
          <div style={{display:'flex', flexWrap:'wrap', gap:'3px'}}>
            {dateMappings.map(m => (
              <span key={m.date_number} style={{background:'#e8ecef', padding:'3px 8px', borderRadius:'4px', fontSize:'12px', cursor:'pointer'}} onClick={() => setDateInput(String(m.date_number))}>
                <b>{m.date_number}</b> = {formatDate(m.actual_date)}
              </span>
            ))}
          </div>
        ) : (
          <p style={{fontSize:'12px', color:'#888', margin:0}}>No date mappings. Click "Edit dates" to define: 1 = 26/7/25, 2 = 3/8/25...</p>
        )}
        {showDateEditor && (
          <div style={{marginTop:'8px', padding:'8px', background:'#f8f9fa', borderRadius:'6px', border:'1px solid #ddd'}}>
            <p style={{fontSize:'11px',color:'#888',margin:'0 0 4px'}}>One per line: number d/m/yy (e.g. "1 26/7/25")</p>
            <textarea value={dateEditorText} onChange={e => setDateEditorText(e.target.value)} rows={10} style={{width:'100%',fontFamily:'monospace',fontSize:'13px',padding:'6px',border:'1px solid #ddd',borderRadius:'4px'}} />
            <div style={{fontSize:'11px',color:'#888',margin:'4px 0'}}>
              {dateEditorText.trim().split('\n').filter(l => l.trim()).map((l, i) => {
                const first = l.trim().split(/[\s]+/)[0];
                const rest = l.trim().slice(first.length).trim();
                const parsed = parseDateFlex(rest);
                const dd = parsed ? `${parseInt(parsed.slice(8))}/${parseInt(parsed.slice(5,7))}/${parsed.slice(2,4)}` : null;
                return <div key={i} style={{color: parsed ? '#4CAF50' : '#F44336'}}>{first} → {dd || 'invalid'}</div>;
              })}
            </div>
            <div style={{display:'flex', gap:'6px'}}>
              <button style={{flex:1,padding:'6px',background:'#1a5276',color:'#fff',border:'none',borderRadius:'4px',cursor:'pointer',fontSize:'12px'}} onClick={async () => {
                const lines = dateEditorText.trim().split('\n').filter(l => l.trim());
                const mappings = lines.map(l => {
                  const first = l.trim().split(/[\s]+/)[0];
                  const rest = l.trim().slice(first.length).trim();
                  const parsed = parseDateFlex(rest);
                  return { n: parseInt(first), date: parsed };
                }).filter(m => !isNaN(m.n) && m.date) as {n:number; date:string}[];
                await fetch(`/penguin-api/dates.php?season=${season}`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                  body: JSON.stringify(mappings)
                });
                setDateMappings(mappings.map(m => ({ date_number: m.n, actual_date: m.date })));
                setShowDateEditor(false);
              }}>Save</button>
              <button style={{flex:1,padding:'6px',background:'#fff',color:'#666',border:'1px solid #ddd',borderRadius:'4px',cursor:'pointer',fontSize:'12px'}} onClick={() => setShowDateEditor(false)}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      {/* Existing observations for this box+season */}
      {box && existingObs.length > 0 && (
        <div className="entry-existing">
          <h3>{existingObs.length} existing observation{existingObs.length !== 1 ? 's' : ''} for <a className="day-box-link" href={`/box/${box}`}> Box {box}</a> ({season})</h3>
          {existingObs.map((o: any, i: number) => (
            <div key={i} className="entry-existing-row">
              <DateLink date={o.observation_time_utc} onDayClick={(d) => { window.location.href = `/day/${d}`; }} />
              <span>{'\uD83D\uDC27'.repeat(o.adults)}{'\uD83E\uDD5A'.repeat(o.eggs)}{'\uD83D\uDC23'.repeat(o.chicks)}</span>
              {(() => { const ds = displayStatus(o.breeding_status, o.eggs, o.chicks); return ds && <span className={`badge ${DARK_TEXT_STATUSES.has(ds)?'bordered':''}`} style={{background:STATUS_COLORS[ds]||'#ccc',color:DARK_TEXT_STATUSES.has(ds)?'#333':'#fff'}}>{ds}</span>; })()}
              {o.gate_status && <span className="gate">{o.gate_status}</span>}
              {(o.scans || []).map((s: any, j: number) => (
                <PenguinMini key={j} scan={s} onClick={() => {}} observationDate={o.observation_time_utc} navigateDirectly />
              ))}
              {o.monitor_filename?.startsWith('web-entry') && o.observation_id && (
                <button className="remove-scan" style={{marginLeft:'auto'}} onClick={async () => {
                  const reason = prompt(`Delete observation from ${formatDate(o.observation_time_utc)}?\n\nReason (optional):`);
                  if (reason === null) return;
                  await deleteRecord(token, 'observations', o.observation_id, reason || undefined);
                  setAllBoxObs(prev => prev.filter(ob => ob.observation_id !== o.observation_id));
                }}>&times;</button>
              )}
              <span className="muted" style={{fontSize:10, marginLeft:4}}>{o.monitor_filename}</span>
            </div>
          ))}
        </div>
      )}

      </div>
      {/* RIGHT: New observation form */}
      <div className="entry-right">
      <div className="entry-form">
        <h3>New observation</h3>
        <div className="entry-row">
          <label>Date (# or d/m/yy)</label>
          <input type="text" value={dateInput} onChange={e => setDateInput(e.target.value)} placeholder={dateMappings.length > 0 ? `1-${dateMappings.length} or d/m/yy` : 'e.g. 11/2/26'} />
          {parsedDate && <span className="date-preview"><DateLink date={parsedDate} onDayClick={(d) => { window.location.href = `/day/${d}`; }} />{dateMappings.find(m => m.actual_date === parsedDate) ? ` (#${dateMappings.find(m => m.actual_date === parsedDate)!.date_number})` : ''}</span>}
          {dateInput && !parsedDate && <span className="date-preview date-invalid">Invalid{dateMappings.length > 0 ? ` (dates 1-${dateMappings.length} available)` : ' - no date table'}</span>}
        </div>

        {/* Previously seen in this box - sorted M by count, F by count */}
        {box && existingObs.length > 0 && (() => {
          const seenBirds = new Map<string, any & { count: number }>();
          for (const o of existingObs) {
            for (const s of (o.scans || [])) {
              const tag = s.pit_id.slice(-8);
              if (seenBirds.has(tag)) { seenBirds.get(tag)!.count++; }
              else seenBirds.set(tag, { ...s, count: 1 });
            }
          }
          const sorted = Array.from(seenBirds.entries()).sort(([,a], [,b]) => {
            const sexOrder = (s: any) => (s.sex || '').toUpperCase() === 'M' ? 0 : (s.sex || '').toUpperCase() === 'F' ? 1 : 2;
            const diff = sexOrder(a) - sexOrder(b);
            return diff !== 0 ? diff : b.count - a.count;
          });
          return sorted.length > 0 ? (
            <div className="entry-row">
              <label>Previously seen</label>
              <div className="bird-row">
                {sorted.map(([tag, scan]) => {
                  const already = scannedBirds.includes(tag);
                  return <span key={tag} className={`bird-with-count ${already ? 'added' : ''}`} style={{opacity: already ? 0.4 : 1}}>
                    <PenguinMini scan={scan} onClick={() => { if (!already) addBird(tag); }} />
                    <span className="scan-count">{scan.count}x</span>
                  </span>;
                })}
              </div>
            </div>
          ) : null;
        })()}

        <div className="entry-row">
          <label>Search by ID</label>
          <PenguinSearch penguins={allPenguins} search={birdSearch} onSearchChange={setBirdSearch} onBirdClick={(num) => {
            const bird = allPenguins.find((p: any) => p.peng_num === num || p.pit_id === num);
            if (bird) addBird(bird.pit_id.slice(-8));
            setBirdSearch('');
          }} />
        </div>

        <div className="entry-row">
          <label>Observed</label>
          <div className="entry-birds">
            {scannedBirds.map(b => {
              const bird = allPenguins.find((p: any) => p.pit_id.slice(-8) === b || p.pit_id === b);
              return <span key={b} className="scan-removable">
                {bird ? <PenguinMini scan={bird} onClick={() => removeBird(b)} /> : <span className="scan" onClick={() => removeBird(b)}>{b}</span>}
                <button className="remove-scan" onClick={() => removeBird(b)}>&times;</button>
              </span>;
            })}
            {scannedBirds.length === 0 && <span className="muted">Click birds above or search to add</span>}
          </div>
        </div>

        <div className="entry-row-group">
          <div className="entry-field">
            <label>Adults</label>
            <input type="number" min="0" value={adults} onChange={e => setAdults(parseInt(e.target.value)||0)} />
          </div>
          <div className="entry-field">
            <label>Eggs</label>
            <input type="number" min="0" value={eggs} onChange={e => setEggs(parseInt(e.target.value)||0)} />
          </div>
          <div className="entry-field">
            <label>Chicks</label>
            <input type="number" min="0" value={chicks} onChange={e => setChicks(parseInt(e.target.value)||0)} />
          </div>
        </div>

        <div className="entry-row-group">
          <div className="entry-field">
            <label>Gate</label>
            <select value={gateStatus} onChange={e => setGateStatus(e.target.value)}>
              <option value="">-</option>
              <option value="Gate up">Gate up</option>
              <option value="Regate">Regate</option>
            </select>
          </div>
          <div className="entry-field">
            <label>Status</label>
            <select value={breedingStatus} onChange={e => setBreedingStatus(e.target.value)}>
              <option value="">-</option>
              <option value="NO">No</option>
              <option value="UNL">Unlikely</option>
              <option value="POT">Potential</option>
              <option value="CON">Confident</option>
              <option value="ABN">Abandoned</option>
              <option value="DCM">DCM</option>
            </select>
          </div>
        </div>

        <div className="entry-row">
          <label>Notes</label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} />
        </div>

        {message && <div className={message.startsWith('Error') || message.startsWith('Failed') ? 'login-error' : 'entry-success'}>
          {message}
          {lastSavedObsId && !message.startsWith('Error') && !message.startsWith('Failed') && (
            <button style={{marginLeft:8, padding:'2px 10px', fontSize:'12px', background:'#F44336', color:'#fff', border:'none', borderRadius:'4px', cursor:'pointer'}} onClick={async () => {
              await deleteRecord(token, 'observations', lastSavedObsId, 'Undo - entry made in error');
              setMessage('Undone');
              setLastSavedObsId(null);
            }}>Undo</button>
          )}
        </div>}

        <button className="entry-save" onClick={handleSave} disabled={saving || !box || !parsedDate}>
          {saving ? 'Saving...' : 'Save observation'}
        </button>
      </div>
      </div>
      </div>

      {/* Date editor is now inline above */}
    </div>
  );
}

const SEASON_COLORS = ['#2196F3', '#4CAF50', '#FF9800', '#9C27B0', '#F44336', '#00BCD4', '#795548', '#607D8B'];

function EggArrivalChart() {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchReport('egg_arrival').then(d => { setData(Array.isArray(d) ? d : []); setLoading(false); });
  }, []);

  if (loading) return <div className="report-card"><p className="muted">Loading...</p></div>;
  if (data.length === 0) return <div className="report-card"><p className="muted">No egg data available</p></div>;

  // Chart dimensions
  const W = 800, H = 400, PAD = { top: 30, right: 120, bottom: 50, left: 50 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  // Find axis ranges
  const allDays = data.flatMap(s => s.data.map((d: any) => d.day));
  const minDay = Math.min(...allDays);
  const maxDay = Math.max(...allDays);
  const maxEggs = Math.max(...data.map(s => s.max_eggs));

  // X-axis: months relative to Apr 1
  const monthTicks = [
    { day: 61, label: 'Jun' }, { day: 92, label: 'Jul' }, { day: 122, label: 'Aug' },
    { day: 153, label: 'Sep' }, { day: 183, label: 'Oct' }, { day: 214, label: 'Nov' },
    { day: 245, label: 'Dec' }, { day: 276, label: 'Jan' }, { day: 306, label: 'Feb' },
  ].filter(t => t.day >= minDay - 10 && t.day <= maxDay + 10);

  const xRange = maxDay - minDay + 20;
  const xScale = (day: number) => PAD.left + ((day - minDay + 10) / xRange) * plotW;
  const yScale = (eggs: number) => PAD.top + plotH - (eggs / maxEggs) * plotH;

  return (
    <div className="report-card">
      <h3>Eggs in Colony</h3>
      <p className="muted">Total eggs across all boxes over each breeding season — shows laying, hatching, and loss</p>
      <svg viewBox={`0 0 ${W} ${H}`} className="report-chart">
        {/* Grid lines */}
        {[0.25, 0.5, 0.75, 1].map(frac => (
          <line key={frac} x1={PAD.left} x2={PAD.left + plotW} y1={yScale(maxEggs * frac)} y2={yScale(maxEggs * frac)} stroke="#e8ecef" strokeWidth="1" />
        ))}
        {/* Y axis labels */}
        {[0, 0.25, 0.5, 0.75, 1].map(frac => (
          <text key={frac} x={PAD.left - 8} y={yScale(maxEggs * frac) + 4} textAnchor="end" fontSize="11" fill="#888">{Math.round(maxEggs * frac)}</text>
        ))}
        {/* X axis month labels */}
        {monthTicks.map(t => (
          <Fragment key={t.day}>
            <line x1={xScale(t.day)} x2={xScale(t.day)} y1={PAD.top} y2={PAD.top + plotH} stroke="#f0f0f0" strokeWidth="1" />
            <text x={xScale(t.day)} y={PAD.top + plotH + 18} textAnchor="middle" fontSize="11" fill="#888">{t.label}</text>
          </Fragment>
        ))}
        {/* Lines per season */}
        {data.map((season, i) => {
          const color = SEASON_COLORS[i % SEASON_COLORS.length];
          const points = season.data.map((d: any) => `${xScale(d.day)},${yScale(d.eggs)}`).join(' ');
          // Find peak point for label
          const peak = season.data.reduce((best: any, d: any) => d.eggs > best.eggs ? d : best, season.data[0]);
          return (
            <Fragment key={season.season}>
              <polyline points={points} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" opacity="0.85" />
              {peak && (
                <text x={xScale(peak.day)} y={yScale(peak.eggs) - 8} textAnchor="middle" fontSize="10" fill={color} fontWeight="600">{season.season}</text>
              )}
            </Fragment>
          );
        })}
        {/* Axes */}
        <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={PAD.top + plotH} stroke="#ccc" strokeWidth="1" />
        <line x1={PAD.left} x2={PAD.left + plotW} y1={PAD.top + plotH} y2={PAD.top + plotH} stroke="#ccc" strokeWidth="1" />
        <text x={PAD.left + plotW / 2} y={H - 5} textAnchor="middle" fontSize="12" fill="#666">Month</text>
        <text x={14} y={PAD.top + plotH / 2} textAnchor="middle" fontSize="12" fill="#666" transform={`rotate(-90, 14, ${PAD.top + plotH / 2})`}>Total eggs</text>
      </svg>
    </div>
  );
}

function DayCalendar({ date, dates, onDayClick }: { date: string; dates: string[]; onDayClick: (day: string) => void }) {
  const dateSet = useMemo(() => new Set(dates), [dates]);

  // Group dates by month, show months around current date
  const current = new Date(date + 'T00:00:00');
  const currentMonth = current.getFullYear() * 12 + current.getMonth();

  // All months from first to last date (inclusive, no gaps)
  const allMonths = useMemo(() => {
    if (dates.length === 0) return [];
    const first = dates[0];
    const last = dates[dates.length - 1];
    const [fy, fm] = first.split('-').map(Number);
    const [ly, lm] = last.split('-').map(Number);
    const start = fy * 12 + (fm - 1);
    const end = ly * 12 + (lm - 1);
    const months: number[] = [];
    for (let m = start; m <= end; m++) months.push(m);
    return months;
  }, [dates]);

  const calRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (calRef.current) {
      const active = calRef.current.querySelector('.cal-day.active');
      if (active) active.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }, [date]);

  const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  return (
    <div className="day-calendar" ref={calRef}>
      {allMonths.map(monthKey => {
        const year = Math.floor(monthKey / 12);
        const month = monthKey % 12;
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const isCurrentMonth = monthKey === currentMonth;

        // Build weeks (Mon=0 ... Sun=6)
        const weeks: (number | null)[][] = [];
        let week: (number | null)[] = [];
        const firstDow = (new Date(year, month, 1).getDay() + 6) % 7; // Mon=0
        for (let i = 0; i < firstDow; i++) week.push(null);
        for (let day = 1; day <= daysInMonth; day++) {
          week.push(day);
          if (week.length === 7) { weeks.push(week); week = []; }
        }
        if (week.length > 0) { while (week.length < 7) week.push(null); weeks.push(week); }

        return (
          <div key={monthKey} className={`cal-month${isCurrentMonth ? ' current' : ''}`}>
            <div className="cal-month-label">{MONTH_NAMES[month]} {year}</div>
            <div className="cal-weeks">
              {weeks.map((w, wi) => (
                <div key={wi} className="cal-week">
                  {w.map((day, di) => {
                    if (day === null) return <span key={di} className="cal-day empty" />;
                    const d = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                    const hasData = dateSet.has(d);
                    const isActive = d === date;
                    return (
                      <span
                        key={di}
                        className={`cal-day${hasData ? ' has-data' : ''}${isActive ? ' active' : ''}`}
                        onClick={hasData ? () => onDayClick(d) : undefined}
                      >{day}</span>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DayView({ date, dates, onBoxClick, onBirdClick, onDayClick }: { date: string; dates: string[]; onBoxClick: (box: string) => void; onBirdClick: (num: string) => void; onDayClick: (day: string) => void }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetchDay(date).then(d => { setData(d); setLoading(false); });
  }, [date]);

  if (loading) return <div className="day-page"><p className="muted">Loading...</p></div>;
  if (!data || data.error) return <div className="day-page"><p className="muted">{data?.error || 'Failed to load'}</p></div>;

  // Find prev/next dates with data
  const sorted = [...dates].sort();
  const idx = sorted.indexOf(date);
  const prevStr = idx > 0 ? sorted[idx - 1] : (idx === -1 ? sorted.filter(d => d < date).pop() : null);
  const nextStr = idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1] : (idx === -1 ? sorted.find(d => d > date) : null);

  // Group observations and chippings by box
  const byBox: Record<string, { obs: any[]; chips: any[] }> = {};
  for (const obs of data.observations) {
    const box = obs.box_name;
    if (!byBox[box]) byBox[box] = { obs: [], chips: [] };
    byBox[box].obs.push(obs);
  }
  for (const c of data.chippings) {
    const box = c.chip_box || '?';
    if (!byBox[box]) byBox[box] = { obs: [], chips: [] };
    byBox[box].chips.push(c);
  }
  const sortedBoxes = Object.keys(byBox).sort((a, b) => {
    const na = parseInt(a), nb = parseInt(b);
    return (!isNaN(na) && !isNaN(nb)) ? na - nb : a.localeCompare(b);
  });

  const totalObs = data.observations.length;
  const totalChips = data.chippings.length;

  return (
    <div className="day-page">
      <DayCalendar date={date} dates={sorted} onDayClick={onDayClick} />

      {(totalObs > 0 || totalChips > 0) && (
        <div className="day-section">
          <h3>{formatDate(date)} — {sortedBoxes.length} boxes{totalChips > 0 ? `, ${totalChips} chipped` : ''}</h3>
          {sortedBoxes.map(box => (
            <div key={box} className="day-box-group">
              <div className="day-box-heading">
                <a className="day-box-link" href={`/box/${box}`} onClick={e => navClick(e, () => onBoxClick(box))}>Box {box}</a>
              </div>
              {byBox[box].obs.map((obs: any) => (
                <ObsCard key={obs.observation_id} obs={obs} onBirdClick={onBirdClick} onDayClick={onDayClick} hideDate />
              ))}
              {byBox[box].chips.length > 0 && (
                <div className="day-chips">
                  <span className="muted">Chipped:</span>
                  {byBox[box].chips.map((c: any) => (
                    <span key={c.pit_id} className="day-chip-entry">
                      <PenguinMini scan={c} onClick={() => onBirdClick(c.peng_num)} observationDate={date} />
                      {c.chip_by && <span className="muted">by {c.chip_by}</span>}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {totalObs === 0 && totalChips === 0 && (
        <p className="muted">No activity recorded on this date.</p>
      )}
    </div>
  );
}

function parseUrl(): { box?: string; bird?: string; enter?: boolean; admin?: boolean; reports?: boolean; day?: string } {
  const path = window.location.pathname;
  const boxMatch = path.match(/^\/box\/(.+)/);
  const birdMatch = path.match(/^\/bird\/(.+)/);
  const dayMatch = path.match(/^\/day\/(.+)/);
  return { box: boxMatch?.[1], bird: birdMatch?.[1], enter: path === '/enter', admin: path === '/admin', reports: path === '/reports', day: dayMatch?.[1] };
}

function App() {
  const [authToken, setAuthToken] = useState<string|null>(localStorage.getItem('ww_token'));
  const [userName, setUserName] = useState<string|null>(localStorage.getItem('ww_user'));
  const [userRole, setUserRole] = useState<string>(localStorage.getItem('ww_role') || 'viewer');

  const handleLogin = (token: string, name: string, observerId?: number | string, role?: string) => {
    localStorage.setItem('ww_token', token);
    localStorage.setItem('ww_user', name);
    localStorage.setItem('ww_role', role || 'viewer');
    if (observerId) localStorage.setItem('ww_observer_id', String(observerId));
    setAuthToken(token);
    setUserName(name);
    setUserRole(role || 'viewer');
  };

  const handleLogout = () => {
    localStorage.removeItem('ww_token');
    localStorage.removeItem('ww_user');
    localStorage.removeItem('ww_role');
    setAuthToken(null);
    setUserName(null);
    setUserRole('viewer');
  };

  // Refresh role from server on load (in case it changed since login)
  useEffect(() => {
    if (!authToken) return;
    fetch('/penguin-api/crud.php?action=me', { headers: { 'Authorization': `Bearer ${authToken}` } })
      .then(r => r.json())
      .then(d => {
        if (d.role && d.role !== userRole) {
          setUserRole(d.role);
          localStorage.setItem('ww_role', d.role);
        }
      })
      .catch(() => {});
  }, [authToken]);

  if (!authToken) {
    return <LoginScreen onLogin={handleLogin} />;
  }

  return <AuthenticatedApp token={authToken} userName={userName || ''} userRole={userRole} onLogout={handleLogout} />;
}

function ChangePasswordDialog({ token, onClose }: { token: string; onClose: () => void }) {
  const [current, setCurrent] = useState('');
  const [newPass, setNewPass] = useState('');
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true); setMsg('');
    try {
      const r = await fetch('/penguin-api/crud.php?action=change_password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ current_password: current, new_password: newPass })
      });
      const d = await r.json();
      if (d.success) { setMsg('success'); setCurrent(''); setNewPass(''); }
      else setMsg(d.error || 'Failed');
    } catch { setMsg('Connection failed'); }
    setSaving(false);
  };

  if (msg === 'success') {
    return (
      <div className="login-page" onClick={onClose}>
        <div className="login-card" onClick={e => e.stopPropagation()}>
          <h2>Password Changed</h2>
          <p style={{textAlign:'center', color:'#4CAF50', fontSize:'16px', margin:'20px 0'}}>Your password has been updated.</p>
          <button onClick={onClose}>Done</button>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page" onClick={onClose}>
      <div className="login-card" onClick={e => e.stopPropagation()}>
        <h2>Change Password</h2>
        <form onSubmit={handleSubmit}>
          <div className="password-field">
            <input type={showCurrent ? 'text' : 'password'} placeholder="Current password" value={current} onChange={e => setCurrent(e.target.value)} required />
            <button type="button" className="toggle-pw" onClick={() => setShowCurrent(!showCurrent)}>{'\u{1F441}'}</button>
          </div>
          <div className="password-field">
            <input type={showNew ? 'text' : 'password'} placeholder="New password (6+ chars)" value={newPass} onChange={e => setNewPass(e.target.value)} required minLength={6} />
            <button type="button" className="toggle-pw" onClick={() => setShowNew(!showNew)}>{'\u{1F441}'}</button>
          </div>
          {msg && <div className="login-error">{msg}</div>}
          <button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Change password'}</button>
        </form>
        <button className="toggle-auth" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

function CollapsibleSeason({ label, observations, onBirdClick, onDayClick, highlightObs, scrollToObs, token, canEdit, allPenguins, onDataChange }: any) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <div className="season-divider clickable" onClick={() => setExpanded(!expanded)}><hr/><span>{label} ({observations.length}) {expanded ? '▲' : '▼'}</span><hr/></div>
      {expanded && observations.map((o: any, i: number) => <ObsCard key={`${label}${i}`} obs={o} onBirdClick={onBirdClick} onDayClick={onDayClick} highlight={highlightObs !== null && o.observation_time_utc === highlightObs} scrollTo={scrollToObs !== null && o.observation_time_utc === scrollToObs} token={token} canEdit={canEdit} allPenguins={allPenguins} onDataChange={onDataChange} />)}
    </div>
  );
}

function AdminPanel({ token }: { token: string }) {
  const [users, setUsers] = useState<any[]>([]);
  const [syncResult, setSyncResult] = useState<any>(null);
  const [syncing, setSyncing] = useState(false);
  const [reimportResult, setReimportResult] = useState<any>(null);
  const [reimporting, setReimporting] = useState(false);
  const [sightingResult, setSightingResult] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [diskTest, setDiskTest] = useState<any>(null);
  const [diskTesting, setDiskTesting] = useState(false);
  const [serverDisk, setServerDisk] = useState<any>(null);

  useEffect(() => {
    fetch('/penguin-api/admin.php?action=users', { headers: { 'Authorization': `Bearer ${token}` } })
      .then(r => r.json()).then(d => { setUsers(Array.isArray(d) ? d : []); setLoading(false); })
      .catch(() => setLoading(false));
    fetch(`/penguin-api/server_stats.php?_=${Date.now()}`)
      .then(r => r.json()).then(d => setServerDisk(d)).catch(() => {});
  }, [token]);

  const updateUser = async (id: number, field: string, value: string) => {
    await fetch('/penguin-api/admin.php?action=update_user', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ observer_id: id, [field]: value })
    });
    setUsers(users.map(u => u.observer_id === id ? { ...u, [field]: value } : u));
  };

  const doSync = async (action: string) => {
    setSyncing(true); setSyncResult(null);
    try {
      const r = await fetch(`/penguin-api/admin.php?action=${action}`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}` }
      });
      const result = await r.json();
      result.dry_run = (action === 'trial_sync');
      setSyncResult(result);
    } catch (e: any) { setSyncResult({ error: e.message }); }
    setSyncing(false);
  };

  const doReimport = async (action: string) => {
    const isSighting = action.includes('sighting');
    setReimporting(true);
    if (isSighting) setSightingResult(null); else setReimportResult(null);
    try {
      const r = await fetch(`/penguin-api/admin.php?action=${action}`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${token}` }
      });
      const result = await r.json();
      result.dry_run = action.startsWith('trial_');
      if (isSighting) setSightingResult(result); else setReimportResult(result);
    } catch (e: any) {
      const err = { error: e.message };
      if (isSighting) setSightingResult(err); else setReimportResult(err);
    }
    setReimporting(false);
  };

  return (
    <div className="admin-panel">
      <div className="admin-header">
        <h2>Admin</h2>
      </div>

      <div className="admin-section">
        <h3>Users</h3>
        {loading ? <p className="muted">Loading...</p> : (
          <table className="bird-table" style={{width:'100%'}}>
            <thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead>
            <tbody>
              {users.map(u => (
                <tr key={u.observer_id}>
                  <td>{u.observer_name}</td>
                  <td>{u.email}</td>
                  <td>
                    <select value={u.role || 'viewer'} onChange={e => updateUser(u.observer_id, 'role', e.target.value)}>
                      <option value="viewer">Viewer</option>
                      <option value="editor">Editor</option>
                      <option value="admin">Admin</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="admin-section">
        <h3>Sync Monitors (TCP Server)</h3>
        <p className="muted">Pull latest from old TCP server (210.54.37.120)</p>
        <button className="edit-btn" onClick={() => doSync('trial_sync')} disabled={syncing}>
          {syncing ? 'Working...' : 'Trial'}
        </button>
        <button className="edit-btn" onClick={() => { if (confirm('DELETE all monitor-imported observations?')) doSync('wipe_monitors'); }} disabled={syncing} style={{marginLeft:6, background:'#F44336', color:'#fff'}}>
          {syncing ? 'Working...' : 'Wipe'}
        </button>
        <button className="edit-btn done-btn" onClick={() => doSync('sync_monitors')} disabled={syncing} style={{marginLeft:6}}>
          {syncing ? 'Working...' : 'Import'}
        </button>
        {syncResult && (
          <div style={{marginTop:8}}>
            {syncResult.error ? (
              <div style={{color:'#F44336'}}>{syncResult.error}</div>
            ) : (
              <>
                <div className="obs-card" style={{marginBottom:8, borderLeftColor: syncResult.dry_run ? '#FF9800' : '#4CAF50'}}>
                  {syncResult.dry_run && <div style={{color:'#FF9800', fontWeight:600, marginBottom:4}}>TRIAL RUN - no data changed</div>}
                  <b>Summary:</b> {syncResult.totals?.imported || 0} would import, {syncResult.totals?.already_imported || 0} already imported, {syncResult.totals?.deleted || 0} deleted, {syncResult.totals?.new_obs || 0} new obs, {syncResult.totals?.scans || 0} scans
                </div>
                {(syncResult.monitors || []).map((m: any, i: number) => (
                  <div key={i} className="obs-card" style={{marginBottom:4, opacity: m.status === 'already_imported' ? 0.5 : 1}}>
                    <div className="obs-top">
                      <b>{m.filename}</b>
                      <span className={`badge ${m.status === 'already_imported' || m.status === 'empty' ? 'bordered' : ''}`} style={{
                        background: m.status === 'deleted' ? '#F44336' : m.status === 'imported' ? '#4CAF50' : m.status === 'would_import' ? '#FF9800' : '#E0E0E0',
                        color: m.status === 'already_imported' || m.status === 'empty' ? '#333' : '#fff'
                      }}>{m.status === 'already_imported' ? 'exists' : m.status === 'would_import' ? 'new' : m.status}</span>
                    </div>
                    <div className="obs-nums" style={{fontSize:11}}>
                      <span>{m.date ? fmtDateTime(m.date) : ''}</span>
                      <span>{m.boxes_imported || 0}/{m.boxes} boxes</span>
                      {m.scans > 0 && <span>{m.scans} penguins</span>}
                      {m.adults > 0 && <span>{'\uD83D\uDC27'.repeat(Math.min(m.adults, 3))}{m.adults}</span>}
                      {m.eggs > 0 && <span>{'\uD83E\uDD5A'}{m.eggs}</span>}
                      {m.chicks > 0 && <span>{'\uD83D\uDC23'}{m.chicks}</span>}
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>

      <div className="admin-section">
        <h3>Import Sightings (Google Sheets)</h3>
        <p className="muted">Historical observations from the spreadsheet (2021-2024)</p>
        <button className="edit-btn" onClick={() => doReimport('trial_import_sightings')} disabled={reimporting}>
          {reimporting ? 'Working...' : 'Trial'}
        </button>
        <button className="edit-btn" onClick={() => { if (confirm('DELETE all sheet-imported observations?')) doReimport('wipe_sightings'); }} disabled={reimporting} style={{marginLeft:6, background:'#F44336', color:'#fff'}}>
          {reimporting ? 'Working...' : 'Wipe'}
        </button>
        <button className="edit-btn done-btn" onClick={() => doReimport('import_sightings')} disabled={reimporting} style={{marginLeft:6}}>
          {reimporting ? 'Working...' : 'Import'}
        </button>
        {sightingResult && (
          <div className="obs-card" style={{marginTop:8, borderLeftColor: sightingResult.dry_run ? '#FF9800' : '#4CAF50'}}>
            {sightingResult.error ? <div style={{color:'#F44336'}}>{sightingResult.error}</div> : <>
              {sightingResult.dry_run && <div style={{color:'#FF9800', fontWeight:600, marginBottom:4}}>TRIAL RUN - no data changed</div>}
              <div>CSV: {sightingResult.csv_rows} rows, {sightingResult.groups} groups</div>
              <div><b>New:</b> {sightingResult.stats?.observations || 0} observations, {sightingResult.stats?.scans || 0} scans, {sightingResult.stats?.biometrics || 0} biometrics{sightingResult.stats?.updated > 0 ? `, ${sightingResult.stats.updated} updated` : ''}</div>
              <div className="muted">{sightingResult.stats?.duplicates || 0} unchanged, {sightingResult.stats?.empty_skipped || 0} empty</div>
              {sightingResult.stats?.unknown_count > 0 && <div className="muted">{Object.keys(sightingResult.stats?.unknown_pits || {}).length} unknown PITs ({sightingResult.stats.unknown_count} occurrences)</div>}
              {Object.keys(sightingResult.stats?.unknown_pits || {}).length > 0 && <>
                <div style={{marginTop:4, fontWeight:600}}>Unknown PITs ({Object.keys(sightingResult.stats.unknown_pits).length}):</div>
                {Object.entries(sightingResult.stats.unknown_pits).sort((a: any, b: any) => b[1].count - a[1].count).map(([pit8, info]: [string, any]) => (
                  <div key={pit8} className="muted small">{pit8}: {info.count}x (first: {info.first_date} box {info.first_box}){info.close ? ` → ${info.close}` : ''}</div>
                ))}
              </>}
              {sightingResult.stats?.warnings?.length > 0 && <>
                <div style={{marginTop:4, fontWeight:600}}>Warnings ({sightingResult.stats.warnings.length}):</div>
                {sightingResult.stats.warnings.map((w: string, i: number) => <div key={i} className="muted small">{w}</div>)}
              </>}
            </>}
          </div>
        )}
      </div>

      <div className="admin-section">
        <h3>Reimport Penguins</h3>
        <p className="muted">Penguin reference data from Google Sheets (1004 birds)</p>
        <button className="edit-btn" onClick={() => doReimport('trial_reimport_penguins')} disabled={reimporting}>
          {reimporting ? 'Working...' : 'Trial'}
        </button>
        <button className="edit-btn" onClick={() => { if (confirm('DELETE all penguins, chips, scans and biometrics?')) doReimport('wipe_penguins'); }} disabled={reimporting} style={{marginLeft:6, background:'#F44336', color:'#fff'}}>
          {reimporting ? 'Working...' : 'Wipe'}
        </button>
        <button className="edit-btn done-btn" onClick={() => doReimport('import_penguins')} disabled={reimporting} style={{marginLeft:6}}>
          {reimporting ? 'Working...' : 'Import'}
        </button>
        {reimportResult && (
          <div className="obs-card" style={{marginTop:8, borderLeftColor: reimportResult.dry_run ? '#FF9800' : '#4CAF50'}}>
            {reimportResult.error ? (
              <div style={{color:'#F44336'}}>{reimportResult.error}</div>
            ) : (
              <>
                {reimportResult.dry_run && <div style={{color:'#FF9800', fontWeight:600, marginBottom:4}}>TRIAL RUN - no data changed</div>}
                <div>CSV rows: {reimportResult.csv_rows}</div>
                <div>Current DB: {reimportResult.previous?.penguins} penguins, {reimportResult.previous?.chips} chips</div>
                <div>Would create: {reimportResult.result?.penguins} penguins, {reimportResult.result?.chips} chips ({reimportResult.result?.rechips} rechips), {reimportResult.result?.skipped} skipped</div>
                {reimportResult.chip_date_issues?.length > 0 && <>
                  <div style={{marginTop:6, fontWeight:600}}>Chip date issues ({reimportResult.chip_date_issues.length}):</div>
                  {reimportResult.chip_date_issues.map((issue: any, i: number) => (
                    <div key={i} className="muted small" style={{color: issue.type === 'date_mismatch' ? '#F44336' : '#FF9800'}}>
                      {issue.type === 'date_mismatch' && `peng#${issue.peng_num} ${issue.pit_id.slice(-8)}: DB=${issue.db_date} Sheet=${issue.sheet_date}`}
                      {issue.type === 'in_db_not_sheet' && `peng#${issue.peng_num} ${issue.pit_id.slice(-8)}: in DB (${issue.db_date}) but NOT in sheet`}
                      {issue.type === 'in_sheet_not_db' && `peng#${issue.peng_num} ${issue.pit_id.slice(-8)}: in sheet (${issue.sheet_date}) but NOT in DB`}
                    </div>
                  ))}
                </>}
              </>
            )}
          </div>
        )}
      </div>

      <div className="admin-section">
        <h3>Disk Write Test</h3>
        {serverDisk && <p className="muted">Account: {serverDisk.files_mb} MB files + {serverDisk.db_mb} MB DB = {serverDisk.used_mb} MB / {serverDisk.quota_mb} MB ({serverDisk.pct}%) · {serverDisk.observations} observations · {serverDisk.penguins} penguins</p>}
        <div style={{display:'flex', gap:6, flexWrap:'wrap'}}>
          {[1, 10, 100, 1000, 5000].map(mb => (
            <button key={mb} className="edit-btn" disabled={diskTesting} onClick={() => {
              setDiskTesting(true);
              setDiskTest({ status: 'starting', target_mb: mb });
              let completed = false;
              const es = new EventSource(`/penguin-api/disk_check.php?mb=${mb}&token=${token}`);
              es.onmessage = (e) => {
                const d = JSON.parse(e.data);
                if (d.type === 'error') { completed = true; setDiskTest({ status: 'error', error: d.msg }); es.close(); setDiskTesting(false); }
                else if (d.type === 'start') { setDiskTest({ status: 'writing', target_mb: d.target_mb, server: d.server }); }
                else if (d.type === 'progress') { setDiskTest((prev: any) => ({ ...prev, status: 'writing', ...d })); }
                else if (d.type === 'done') { completed = true; setDiskTest({ status: d.status === 'OK' ? 'done' : 'failed', ...d }); es.close(); setDiskTesting(false); }
              };
              es.onerror = () => { if (!completed) { setDiskTest((prev: any) => ({ ...prev, status: 'error', error: 'Connection lost — test may still be running on server' })); } es.close(); setDiskTesting(false); };
            }}>{mb} MB</button>
          ))}
        </div>
        {diskTest && (
          <div className="obs-card" style={{marginTop:8}}>
            {diskTest.status === 'starting' && <div className="muted">Connecting...</div>}
            {diskTest.status === 'writing' && (
              <>
                <div style={{fontWeight:600}}>Writing {diskTest.target_mb} MB... {diskTest.pct || 0}%</div>
                <div style={{background:'#e8ecef', borderRadius:4, height:8, marginTop:4}}>
                  <div style={{background:'#2196F3', borderRadius:4, height:8, width:`${diskTest.pct || 0}%`, transition:'width 0.3s'}} />
                </div>
                <div className="muted" style={{marginTop:4}}>
                  {diskTest.written_mb || 0} MB written · {diskTest.speed_mbs || 0} MB/s · Free: {diskTest.disk_free_mb ?? '?'} MB
                </div>
              </>
            )}
            {diskTest.status === 'done' && (
              <>
                <div style={{color:'#4CAF50', fontWeight:600}}>OK — {diskTest.wrote_mb} MB in {diskTest.total_sec}s ({diskTest.speed_mbs} MB/s)</div>
                <div className="muted">Free before delete: {diskTest.disk_free_before_delete} MB · After: {diskTest.disk_free_after_delete} MB</div>
              </>
            )}
            {diskTest.status === 'failed' && (
              <div style={{color:'#F44336', fontWeight:600}}>FAILED: {diskTest.error}</div>
            )}
            {diskTest.status === 'error' && (
              <div style={{color:'#F44336', fontWeight:600}}>Error: {diskTest.error}</div>
            )}
            {diskTest.server && (
              <div className="muted" style={{marginTop:4, borderTop:'1px solid #e8ecef', paddingTop:4}}>
                Server: {diskTest.server.disk_free_mb} MB free · DB: {diskTest.server.db_mb} MB · {diskTest.server.observations} observations
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AuthenticatedApp({ token, userName, userRole, onLogout }: { token: string; userName: string; userRole: string; onLogout: () => void }) {
  const [showChangePassword, setShowChangePassword] = useState(false);
  const initial = parseUrl();
  const [boxTags, setBoxTags] = useState<Record<string, BoxTag>>({});
  const [stats, setStats] = useState<any>(null);
  const [selectedBox, setSelectedBox] = useState<string|null>(initial.box || null);
  const [boxDetail, setBoxDetail] = useState<BoxDetailData|null>(null);
  const [showDeleted, setShowDeleted] = useState(false);
  const [deletedObs, setDeletedObs] = useState<any[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedBird, setSelectedBird] = useState<string|null>(initial.bird || null);
  const [birdData, setBirdData] = useState<any>(null);
  const [birdLoading, setBirdLoading] = useState(false);
  const [highlightObs, setHighlightObs] = useState<string|null>(null);
  const [scrollToObs, setScrollToObs] = useState<string|null>(null);
  const [allPenguins, setAllPenguins] = useState<any[]>([]);
  const [penguinSearch, setPenguinSearch] = useState('');
  const [serverStats, setServerStats] = useState<any>(null);
  const [showEntry, setShowEntry] = useState(initial.enter || false);
  const [showAdmin, setShowAdmin] = useState(initial.admin || false);
  const [showReports, setShowReports] = useState(initial.reports || false);
  const [datePickerVisible, setDatePickerVisible] = useState(false);
  const [datePickerCenter, setDatePickerCenter] = useState('');
  const [selectedDay, setSelectedDay] = useState<string|null>(initial.day || null);
  const [scrollToBox, setScrollToBox] = useState<string|null>(null);
  const [previousBox, setPreviousBox] = useState<string|null>(null);

  // Sync state to URL
  useEffect(() => {
    let path = '/';
    if (showAdmin) path = '/admin';
    else if (showReports) path = '/reports';
    else if (showEntry) path = '/enter';
    else if (selectedDay) path = `/day/${selectedDay}`;
    else if (selectedBox) path = `/box/${selectedBox}`;
    else if (selectedBird) path = `/bird/${selectedBird}`;
    if (window.location.pathname !== path) {
      window.history.pushState(null, '', path);
    }
  }, [selectedBox, selectedBird, showEntry, showAdmin, showReports, selectedDay]);

  // Handle browser back/forward
  useEffect(() => {
    const onPopState = () => {
      const { box, bird, enter, admin: adm, reports, day } = parseUrl();
      setSelectedBox(box || null);
      setSelectedBird(bird || null);
      setShowEntry(enter || false);
      setShowAdmin(adm || false);
      setShowReports(reports || false);
      setSelectedDay(day || null);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const refreshStats = useCallback(() => {
    fetchOverview().then(ov => setStats(ov));
  }, []);

  useEffect(() => {
    Promise.all([fetchBoxTags(), fetchOverview(), fetchAllPenguins(), fetchServerStats()])
      .then(([tags, ov, pgs, ss]) => { setBoxTags(tags); setStats(ov); setAllPenguins(pgs); setServerStats(ss); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedBox) { setBoxDetail(null); setHighlightObs(null); refreshStats(); return; }
    setDetailLoading(true);
    fetchBoxDetail(selectedBox).then(d => {
      setBoxDetail(d);
      setDetailLoading(false);
      if (window.innerWidth < 900) { setSelectedBird(null); return; }

      // Auto-open first bird from breeding pair, or first bird in box
      const observations = d.observations || [];
      // Find breeding pair: M+F seen together during eggs/chicks
      const pairCounts = new Map<string, number>();
      for (const obs of observations) {
        if (obs.eggs > 0 || obs.chicks > 0) {
          const males = obs.scans.filter((s: any) => (s.sex || '').toUpperCase() === 'M');
          const females = obs.scans.filter((s: any) => (s.sex || '').toUpperCase() === 'F');
          for (const m of males) {
            for (const f of females) {
              const key = `${m.peng_num}|${f.peng_num}`;
              pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
            }
          }
        }
      }
      let bestPair = '';
      let bestCount = 0;
      for (const [key, count] of pairCounts) {
        if (count > bestCount) { bestCount = count; bestPair = key; }
      }
      if (bestPair) {
        setSelectedBird(bestPair.split('|')[0]);
      } else {
        // No breeding pair — pick first scanned bird
        for (const obs of observations) {
          if (obs.scans.length > 0) {
            setSelectedBird(obs.scans[0].peng_num || null);
            return;
          }
        }
        // No scans at all — try all_penguins
        if (d.all_penguins?.length > 0) {
          setSelectedBird(d.all_penguins[0].peng_num);
        } else {
          setSelectedBird(null);
        }
      }
    });
  }, [selectedBox]);

  useEffect(() => {
    if (!selectedBird) { setBirdData(null); return; }
    setBirdLoading(true);
    fetchBirdDetail(selectedBird).then(d => { setBirdData(d); setBirdLoading(false); });
  }, [selectedBird]);

  const openBird = (pengNum: string) => {
    if (window.innerWidth < 900 && selectedBox) {
      setPreviousBox(selectedBox);
      setSelectedBox(null);
    }
    setSelectedBird(pengNum);
  };

  const closeBird = () => {
    setSelectedBird(null);
  };

  // All box IDs from observations (not just RFID-tagged ones)
  const sortedBoxIds = useMemo(() => {
    const ids = new Set([...Object.keys(boxTags), ...Object.keys(stats?.box_info || {})]);
    return Array.from(ids).sort((a, b) => {
      const na = parseInt(a), nb = parseInt(b);
      return (!isNaN(na) && !isNaN(nb)) ? na - nb : a.localeCompare(b);
    });
  }, [boxTags]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!selectedBox || sortedBoxIds.length === 0) return;
    const idx = sortedBoxIds.indexOf(selectedBox);
    if (idx < 0) return;
    if (e.key === 'ArrowRight' && idx < sortedBoxIds.length - 1) {
      setSelectedBox(sortedBoxIds[idx + 1]);
    } else if (e.key === 'ArrowLeft' && idx > 0) {
      setSelectedBox(sortedBoxIds[idx - 1]);
    } else if (e.key === 'Escape') {
      setSelectedBox(null);
    }
  }, [selectedBox, sortedBoxIds]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  if (loading) return <div className="center"><div className="spinner"/><p>Loading colony data...</p></div>;

  // Password dialog renders on top of any page
  const passwordDialog = showChangePassword ? <ChangePasswordDialog token={token} onClose={() => setShowChangePassword(false)} /> : null;

  const goTo = (section: 'colony' | 'reports' | 'admin' | 'enter') => {
    setSelectedBox(null); setSelectedBird(null); setSelectedDay(null);
    setShowAdmin(section === 'admin');
    setShowReports(section === 'reports');
    setShowEntry(section === 'enter');
  };

  const goToDay = (day: string) => {
    setSelectedBox(null); setSelectedBird(null);
    setShowAdmin(false); setShowReports(false); setShowEntry(false);
    setSelectedDay(day);
  };

  const currentSection = showAdmin ? 'admin' : showReports ? 'reports' : 'colony';

  const siteNav = (
    <nav className="site-nav">
      <a className={currentSection === 'colony' ? 'active' : ''} href="/" onClick={e => navClick(e, () => goTo('colony'))}>Colony</a>
      <a className={currentSection === 'reports' ? 'active' : ''} href="/reports" onClick={e => navClick(e, () => goTo('reports'))}>Reports</a>
      {userRole === 'admin' && <a className={currentSection === 'admin' ? 'active' : ''} href="/admin" onClick={e => navClick(e, () => goTo('admin'))}>Admin</a>}
    </nav>
  );

  const fmtSize = (mb: number) => mb >= 1024 ? `${(mb/1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;

  const siteHeader = (
    <header>
      <h1 className="logo clickable" onClick={() => goTo('colony')}>Wildwatch</h1>
      {siteNav}
      {serverStats && <span className="header-stats">{fmtSize(serverStats.used_mb)} / {fmtSize(serverStats.quota_mb)} · server {serverStats.disk_free_gb} GB free</span>}
      <span className="header-user">
        {userName}
        <button className="logout-btn" onClick={() => setShowChangePassword(true)}>Password</button>
        <button className="logout-btn" onClick={onLogout}>Logout</button>
      </span>
    </header>
  );

  // Admin page
  if (showAdmin && userRole === 'admin') {
    return (
      <div className="app">
        {siteHeader}
        <AdminPanel token={token} />
        {passwordDialog}
      </div>
    );
  }

  if (showEntry && userRole !== 'viewer') {
    return (
      <div className="app">
        {siteHeader}
        <DataEntryPage token={token} allPenguins={allPenguins} onBack={() => goTo('colony')} />
        {passwordDialog}
      </div>
    );
  }

  // Reports page
  if (showReports) {
    return (
      <div className="app">
        {siteHeader}
        <div className="reports-page">
          <EggArrivalChart />
        </div>
        {passwordDialog}
      </div>
    );
  }

  // Daily view - everything that happened on a date
  if (selectedDay) {
    return (
      <div className="app">
        {siteHeader}
        <div className="colony-toolbar">
          <PenguinSearch penguins={allPenguins} search={penguinSearch} onSearchChange={setPenguinSearch} onBirdClick={openBird} />
          <input className="box-search-input" type="text" placeholder="Box #" onKeyDown={e => { if (e.key === 'Enter') { const v = (e.target as HTMLInputElement).value.trim(); if (v) { setSelectedDay(null); setSelectedBox(v); (e.target as HTMLInputElement).value = ''; } } }} />
          <DateSearch dates={stats?.observation_dates || []} onDayClick={goToDay} onFocusChange={(f, d) => { setDatePickerVisible(f); setDatePickerCenter(d); }} />
        </div>
        <DayView date={selectedDay} dates={stats?.observation_dates || []} onBoxClick={(box) => { setSelectedDay(null); setSelectedBox(box); }} onBirdClick={openBird} onDayClick={goToDay} />
        {passwordDialog}
      </div>
    );
  }

  // Bird page - replaces everything (only when no box is selected)
  if (selectedBird && !selectedBox) {
    return (
      <div className="app">
        {siteHeader}
        <div className="colony-toolbar">
          <PenguinSearch penguins={allPenguins} search={penguinSearch} onSearchChange={setPenguinSearch} onBirdClick={openBird} />
          <input className="box-search-input" type="text" placeholder="Box #" onKeyDown={e => { if (e.key === 'Enter') { const v = (e.target as HTMLInputElement).value.trim(); if (v) { setSelectedBird(null); setSelectedBox(v); (e.target as HTMLInputElement).value = ''; } } }} />
          <DateSearch dates={stats?.observation_dates || []} onDayClick={goToDay} onFocusChange={(f, d) => { setDatePickerVisible(f); setDatePickerCenter(d); }} />
        </div>
        <div className="bird-page">
          <div className="page-header">
            <a className="page-back" href={previousBox ? `/box/${previousBox}` : '/'} onClick={e => navClick(e, () => { closeBird(); if (previousBox) { setSelectedBox(previousBox); setPreviousBox(null); } })}>&larr; {previousBox ? `Box ${previousBox}` : 'Colony'}</a>
          </div>
          {birdLoading ? <p className="muted">Loading bird data...</p> : birdData?.penguin ? (
            <BirdPage data={birdData} onBirdClick={openBird} token={token} canEdit={userRole !== 'viewer'}
              onBoxClick={(box: string) => { closeBird(); setSelectedBox(box); }}
              onSightingClick={(box: string, date: string) => { closeBird(); setSelectedBox(box); setHighlightObs(date); setScrollToObs(date); }}
              onDayClick={goToDay} />
          ) : <p className="muted">Bird not found</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      {siteHeader}
      <div className="colony-toolbar">
        <PenguinSearch penguins={allPenguins} search={penguinSearch} onSearchChange={setPenguinSearch} onBirdClick={openBird} />
        <input className="box-search-input" type="text" placeholder="Box #" onKeyDown={e => { if (e.key === 'Enter') { const v = (e.target as HTMLInputElement).value.trim(); if (v) { setSelectedBird(null); setSelectedBox(v); (e.target as HTMLInputElement).value = ''; } } }} />
        <DateSearch dates={stats?.observation_dates || []} onDayClick={goToDay} onFocusChange={(f, d) => { setDatePickerVisible(f); setDatePickerCenter(d); }} />
        {userRole !== 'viewer' && <button className="toolbar-btn" onClick={() => goTo('enter')}>Enter data</button>}
        {stats && <span className="colony-stats">{stats.total_boxes} boxes &middot; {stats.season_observations} obs &middot; {stats.season_penguins} penguins this season</span>}
      </div>
      {datePickerVisible && datePickerCenter && (
        <DayCalendar date={datePickerCenter} dates={[...(stats?.observation_dates || [])].sort()} onDayClick={goToDay} />
      )}

      {!selectedBox && (
        <>
          <div className="top-row">
            <ColonyMap boxTags={boxTags} selectedBox={selectedBox} onBoxSelect={setSelectedBox} />
            <StatsPanel boxTags={boxTags} selectedBox={selectedBox} stats={stats} />
          </div>
        </>
      )}

      <div className={selectedBox ? 'split-view' : ''}>
        {/* Box grid - always visible */}
        <div className={selectedBox ? 'grid-sidebar' : 'grid-section'}>
          <BoxGrid boxTags={boxTags} selectedBox={selectedBox} onBoxSelect={setSelectedBox} boxInfo={stats?.box_info} scrollToBox={scrollToBox} />
        </div>

        {/* Box detail */}
        {selectedBox && (
        <div className="detail-area">
          {/* Header + status bar full width */}
          <div className="detail-full">
            <div className="page-header">
              <h2>Box {selectedBox}</h2>
              <a className="page-back" href="/" onClick={e => navClick(e, () => { setScrollToBox(selectedBox); setSelectedBox(null); })}>&larr; Overview</a>
            </div>
            {detailLoading ? <p className="muted">Loading...</p> : boxDetail ? (
              <>
                {boxDetail.location?.pit_id && <div className="tag-info">Tag: {boxDetail.location.pit_id.slice(-8)}</div>}
                {boxDetail.location && (
                  <div className="persistent-notes">
                    <EditableField value={boxDetail.location.persistent_notes || ''} onSave={(val) => updateRecord(token, 'observation_locations', boxDetail.location!.location_id, {persistent_notes: val})} placeholder="Box notes (persistent)" canEdit={userRole !== 'viewer'} />
                  </div>
                )}
                <BreedingStatusBar observations={boxDetail.observations} onHighlight={setHighlightObs} onScrollTo={(d) => { setHighlightObs(null); setScrollToObs(null); setTimeout(() => { setHighlightObs(d); setScrollToObs(d); }, 10); }} />
              </>
            ) : null}
          </div>

          {/* Split: observations+birds left, penguin detail right */}
          {!detailLoading && boxDetail && (
          <div className="detail-split">
            <div className="detail-obs">
                <AllScannedBirds observations={boxDetail.observations} onBirdClick={openBird} allPenguinsInBox={boxDetail.all_penguins} />
                {(() => {
                  const chipped = (boxDetail.all_penguins || []).filter((p: any) => p.is_chipped_here).sort((a: any, b: any) => (a.chip_date || '').localeCompare(b.chip_date || ''));
                  return chipped.length > 0 && (
                  <div className="chipped-here">
                    <div className="muted">Chipped in this box: {chipped.length}</div>
                    <div className="bird-row">
                      {chipped.map((c: any) => (
                        <span key={c.pit_id} className="bird-with-count">
                          <PenguinMini scan={c} onClick={() => openBird(c.peng_num)} observationDate={c.chip_date} />
                          <span className="scan-count">{c.chip_date ? getSeasonLabel(parseDate(c.chip_date)) : ''}{c.chip_by ? ` ${c.chip_by}` : ''}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                  );
                })()}
              {(() => {
                const thisSeasonStart = getSeasonStart().toISOString();
                const thisLabel = getSeasonLabel();
                const thisSeason = boxDetail.observations.filter(o => o.observation_time_utc >= thisSeasonStart);
                const prevObs = boxDetail.observations.filter(o => o.observation_time_utc < thisSeasonStart);

                // Group previous observations by season
                const prevSeasons = new Map<string, Observation[]>();
                for (const obs of prevObs) {
                  const label = getSeasonLabel(parseDate(obs.observation_time_utc));
                  if (!prevSeasons.has(label)) prevSeasons.set(label, []);
                  prevSeasons.get(label)!.push(obs);
                }
                const sortedPrev = Array.from(prevSeasons.entries()).sort((a, b) => b[0].localeCompare(a[0]));

                const deletedCount = (boxDetail as any)?.deleted_count || 0;
                return (<>
                  <h3 className="season-heading">{thisLabel} ({thisSeason.length})
                    {deletedCount > 0 && <span className="deleted-indicator clickable" onClick={async () => {
                      if (!showDeleted && deletedObs.length === 0) {
                        const r = await fetch(`/penguin-api/dashboard.php?view=box&name=${encodeURIComponent(selectedBox!)}&include_deleted=1&_=${Date.now()}`);
                        const d = await r.json();
                        setDeletedObs(d.deleted || []);
                      }
                      setShowDeleted(!showDeleted);
                    }}> · {deletedCount} deleted</span>}
                  </h3>
                  {thisSeason.length === 0 && <p className="muted">No observations this season</p>}
                  {thisSeason.map((obs,i) => <ObsCard key={`t${i}`} obs={obs} onBirdClick={openBird} onDayClick={goToDay} highlight={highlightObs !== null && obs.observation_time_utc === highlightObs} scrollTo={scrollToObs !== null && obs.observation_time_utc === scrollToObs} token={token} canEdit={userRole !== 'viewer'} allPenguins={allPenguins} onDataChange={refreshStats} />)}
                  {showDeleted && deletedObs.length > 0 && (
                    <div className="deleted-section">
                      {deletedObs.map((o: any) => (
                        <div key={o.observation_id} className="obs-card deleted-obs">
                          <div className="obs-top">
                            <span><s>{formatDate(o.observation_time_utc)}</s></span>
                            <span className="muted">{o.adults}A {o.eggs}E {o.chicks}C</span>
                            <span className="muted">deleted {o.deleted_at ? formatDate(o.deleted_at) : ''} by {o.deleted_by_name || '?'}</span>
                          </div>
                          {o.notes && <div className="obs-notes"><s>{o.notes}</s></div>}
                        </div>
                      ))}
                    </div>
                  )}
                  {sortedPrev.map(([label, obs]) => (
                    <CollapsibleSeason key={label} label={label} observations={obs} onBirdClick={openBird} onDayClick={goToDay} highlightObs={highlightObs} scrollToObs={scrollToObs} token={token} canEdit={userRole !== 'viewer'} allPenguins={allPenguins} onDataChange={refreshStats} />
                  ))}
                </>);
              })()}
            </div>
            <div className="detail-bird">
              {birdData?.penguin ? (
                <BirdPage data={birdData} onBirdClick={openBird} token={token} canEdit={userRole !== 'viewer'}
                  onBoxClick={(box: string) => { setSelectedBird(null); setSelectedBox(box); }}
                  onSightingClick={(box: string, date: string) => { setSelectedBird(null); setSelectedBox(box); setHighlightObs(date); setScrollToObs(date); }}
                  onDayClick={goToDay}
                  onNavigateToBird={(num: string) => { setSelectedBox(null); setSelectedBird(num); }} />
              ) : birdLoading ? <p className="muted">Loading bird...</p> : <p className="muted">Select a bird</p>}
            </div>
          </div>
          )}
        </div>
        )}
      </div>
      {passwordDialog}
    </div>
  );
}

function parseDate(d: string): Date {
  // MySQL "YYYY-MM-DD HH:MM:SS" → ISO format for reliable cross-browser parsing
  return new Date(d.includes('T') || d.includes('Z') ? d : d.replace(' ', 'T') + 'Z');
}
function formatDate(d:string) {
  return parseDate(d).toLocaleDateString('en-NZ',{day:'numeric',month:'short',year:'numeric',timeZone:'Pacific/Auckland'});
}
function fmtDateTime(d:string) { return formatDate(d); }
function fmtDateNZ(d:string) {
  return parseDate(d).toLocaleDateString('en-NZ',{day:'2-digit',month:'2-digit',year:'2-digit',timeZone:'Pacific/Auckland'});
}
/** Returns YYYY-MM-DD in NZ timezone for a datetime string */
function toNzDateStr(d: string): string {
  const nz = parseDate(d).toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' }); // en-CA gives YYYY-MM-DD
  return nz;
}

export default App;
