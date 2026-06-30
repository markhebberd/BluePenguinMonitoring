import React, { Fragment, Suspense, createContext, lazy, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { fetchBoxTags, fetchOverview, updateRecord, createRecord, deleteRecord, fetchHistory, fetchServerStats } from './api/boxtags';
import { syncDatabase, primeFromCache, queryAllLocations, queryDay, queryCarryForward, getDcmBoxes, queryPreviousObservations, getDateStats, startPolling, stopPolling } from './api/localdb';
import { useAllPenguins, useDateStats, useBoxDetail, useBirdDetail, useDayData, useEggArrival, useDistinctAdults, usePeakAdults, useChickReturn } from './api/useLocalDb';
import { getSeasonStart, getSeasonLabel } from './config';
import { ColonyMap } from './components/ColonyMap';
import { BoxGrid } from './components/BoxGrid';
import { StatsPanel } from './components/StatsPanel';
const DiskHistoryChart = lazy(() => import('./components/DiskHistoryChart'));
import type { BoxTag } from './types';
import './App.css';

interface Scan { scan_id?:number; peng_num?:string|null; pit_id:string; sex:string|null; life_stage:string|null; chip_date:string|null; chipped_as_adult:number|null; }

interface Observation {
  observation_id?:number;
  observation_time_utc:string; monitor_filename:string;
  adults:number; eggs:number; chicks:number;
  breeding_status:string|null; gate_status:string|null; notes:string;
  scans: Scan[];
  edit_count?:string|number;
}
interface ChippedHere { peng_num:string; pit_id:string; sex:string|null; life_stage:string|null; chipped_as_adult:number; chip_date:string; chip_by:string|null; chick_size_code?:string|null; }
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

// "Only changed" day-view filter fields (compare a day's observation to the box's previous one)
const CHANGED_FIELDS: { key: string; label: string }[] = [
  { key: 'status', label: 'Breeding status' },
  { key: 'adults', label: 'Adults' },
  { key: 'eggs', label: 'Eggs' },
  { key: 'chicks', label: 'Chicks' },
  { key: 'sum', label: 'Eggs+chicks' },
];
/** True if a day's observation differs from the box's previous observation in any selected field.
 *  Breeding status carries forward: a blank current status inherits the previous, so only a
 *  newly-recorded differing status counts. A missing previous is an empty baseline (0 / no status). */
function obsDiffersFromPrev(o: any, prev: any, fields: Set<string>): boolean {
  if (fields.has('status')) {
    const cur = (o.breeding_status || '').trim();
    const prevStatus = (prev?.breeding_status || '').trim();
    if (cur && cur !== prevStatus) return true;
  }
  if (fields.has('adults') && (o.adults || 0) !== (prev?.adults || 0)) return true;
  if (fields.has('eggs') && (o.eggs || 0) !== (prev?.eggs || 0)) return true;
  if (fields.has('chicks') && (o.chicks || 0) !== (prev?.chicks || 0)) return true;
  if (fields.has('sum') && ((o.eggs || 0) + (o.chicks || 0)) !== ((prev?.eggs || 0) + (prev?.chicks || 0))) return true;
  return false;
}

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
  DCM:'#BCAAA4',      // light brown
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

/** Field-observation sex + confidence, stored on biometrics.observed_sex as PM/MM/U/MF/PF.
 *  `short` = compact form for mini views (pM/mM/U/mF/pF); otherwise full words.
 *  Legacy M/F values (and anything unrecognised) fall back gracefully. */
const OBSERVED_SEX: Record<string, { short: string; full: string }> = {
  PM: { short: 'pM', full: 'Probably male' },
  MM: { short: 'mM', full: 'Maybe male' },
  U:  { short: 'U',  full: 'Unsure' },
  MF: { short: 'mF', full: 'Maybe female' },
  PF: { short: 'pF', full: 'Probably female' },
  M:  { short: 'M',  full: 'Male' },    // legacy
  F:  { short: 'F',  full: 'Female' },  // legacy
};
function observedSexLabel(code: string|null|undefined, short: boolean): string {
  if (!code) return '';
  const entry = OBSERVED_SEX[code.toUpperCase()];
  if (!entry) return code; // unknown \u2014 show raw
  return short ? entry.short : entry.full;
}

/** Navigate on click, allow ctrl+click to open in new tab */
function navClick(e: React.MouseEvent, action: () => void) {
  if (e.ctrlKey || e.metaKey || e.button === 1) return; // let browser handle new tab
  e.preventDefault();
  action();
}

function useDateTooltip() {
  const [tip, setTip] = useState<{ date: string; x: number; y: number } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = useCallback((date: string, e: React.MouseEvent) => {
    clearTimeout(timerRef.current);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    timerRef.current = setTimeout(() => setTip({ date, x: rect.left, y: rect.bottom + 4 }), 350);
  }, []);
  const hide = useCallback(() => { clearTimeout(timerRef.current); setTip(null); }, []);
  return { tip, show, hide };
}

const DateTooltipCtx = createContext<{ show: (date: string, e: React.MouseEvent) => void; hide: () => void; statsCache: Map<string, any> }>({ show: () => {}, hide: () => {}, statsCache: new Map() });

function computeDateStats(date: string) {
  const day = queryDay(date);
  const obs = day.observations || [];
  const boxes = new Set(obs.map((o: any) => o.box_name));
  const totalAdults = obs.reduce((s: number, o: any) => s + (o.adults || 0), 0);
  const totalEggs = obs.reduce((s: number, o: any) => s + (o.eggs || 0), 0);
  const totalChicks = obs.reduce((s: number, o: any) => s + (o.chicks || 0), 0);
  const allScans = obs.flatMap((o: any) => o.scans || []);
  const uniquePenguins = new Set(allScans.filter((s: any) => s.peng_num).map((s: any) => s.peng_num));
  const chippings = day.chippings || [];
  const nameCounts: Record<string, number> = {};
  for (const o of obs) { if (o.monitor_filename) nameCounts[o.monitor_filename] = (nameCounts[o.monitor_filename] || 0) + 1; }
  const topName = Object.entries(nameCounts).sort((a, b) => b[1] - a[1])[0];
  const label = topName && topName[1] > obs.length * 0.5 ? topName[0] : null;
  const allLocs = queryAllLocations();
  const dcmBoxes = getDcmBoxes(date);
  const requiredBoxes = allLocs.filter(l => !dcmBoxes.has(l.location_name)).map(l => l.location_name);
  const isFullMonitor = requiredBoxes.length > 0 && requiredBoxes.every(b => boxes.has(b));
  return { boxes: boxes.size, obs: obs.length, adults: totalAdults, eggs: totalEggs, chicks: totalChicks, penguins: uniquePenguins.size, chipped: chippings.length, label, isFullMonitor, totalLocations: allLocs.length };
}

function DateStatsLine({ stats, showDate, date }: { stats: any; showDate?: boolean; date?: string }) {
  const multiObs = stats.obs > stats.boxes;
  return (<>
    {showDate && date && <b>{formatDate(date)}</b>}
    {stats.isFullMonitor
      ? <span style={{color:'#2e7d32'}}> <b>Full Monitor</b> ({stats.boxes}/{stats.totalLocations})</span>
      : <span> {stats.boxes}/{stats.totalLocations} boxes</span>}
    {multiObs && <span>, {stats.obs} obs</span>}
    {stats.adults > 0 && <span> {'\uD83D\uDC27'}{stats.adults}</span>}
    {stats.eggs > 0 && <span> {'\uD83E\uDD5A'}{stats.eggs}</span>}
    {stats.chicks > 0 && <span> {'\uD83D\uDC23'}{stats.chicks}</span>}
    {stats.penguins > 0 && <span> {stats.penguins} scanned</span>}
    {stats.chipped > 0 && <span> {stats.chipped} chipped</span>}
    {stats.label && <span className="muted"> {stats.label}</span>}
  </>);
}

function DateTooltipPortal({ tip, statsCache }: { tip: { date: string; x: number; y: number } | null; statsCache: Map<string, any> }) {
  if (!tip) return null;
  const stats = statsCache.get(tip.date) || computeDateStats(tip.date);
  if (!stats) return null;
  const left = Math.min(tip.x, window.innerWidth - 260);
  const above = tip.y + 120 > window.innerHeight;
  const top = above ? tip.y - 128 : tip.y;
  return (
    <div className="date-tooltip" style={{ left, top }}>
      <div><DateStatsLine stats={stats} showDate date={tip.date} /></div>
    </div>
  );
}

function DateLink({ date, onDayClick }: { date: string; onDayClick?: (day: string) => void }) {
  const day = date.length > 10 ? toNzDateStr(date) : date;
  const { show, hide } = useContext(DateTooltipCtx);
  return <a className="date-link" href={`/day/${day}`} onClick={e => navClick(e, () => onDayClick?.(day))}
    onMouseEnter={e => show(day, e)} onMouseLeave={hide}>{formatDate(date)}</a>;
}

function PenguinMini({ scan, onClick, observationDate, navigateDirectly, currentStatus }: { scan: Scan | ChippedHere | any; onClick: () => void; observationDate?: string; navigateDirectly?: boolean; currentStatus?: boolean }) {
  const sex = (scan.sex || '').toUpperCase();
  const num = scan.peng_num ? `#${scan.peng_num}` : '';
  const chip = scan.pit_id ? scan.pit_id.slice(-8) : '';
  const wasChippedAsChick = !scan.chipped_as_adult;
  // currentStatus (bird-page header): a chick-chipped bird stays a chick (yellow) until it
  // has been scanned as an adult (hasReturned). Once an adult it shows its sex colour
  // (blue/pink) — or grey if unsexed — with the yellow "chipped as chick" inset.
  // Without currentStatus, life-stage is judged as at the given observation date.
  const stillChick = currentStatus
    ? (wasChippedAsChick && !scan.hasReturned)
    : isChickAtObsDate(scan.chip_date, scan.chipped_as_adult, observationDate);
  const cls = currentStatus
    ? (stillChick ? 'chick' : (sex === 'F' ? 'f' : sex === 'M' ? 'm' : ''))
    : penguinSexClass(sex, scan.chip_date, scan.chipped_as_adult, observationDate);
  const icon = currentStatus
    ? (stillChick ? '🐣' : (sex === 'F' ? '♀' : sex === 'M' ? '♂' : ''))
    : penguinSexIcon(sex, scan.chip_date, scan.chipped_as_adult, observationDate);
  const provenChickOrigin = wasChippedAsChick && !stillChick;
  const chipCls = currentStatus
    ? (provenChickOrigin && sex ? 'chipped-chick' : '')
    : (wasChippedAsChick ? 'chipped-chick' : '');
  const grayCls = currentStatus
    ? (provenChickOrigin && !sex ? 'unproven' : '')
    : (wasChippedAsChick && !stillChick && !sex && !observationDate ? 'unproven' : '');
  const obsNzDate = observationDate ? toNzDateStr(observationDate) : '';
  const chippedHereCls = scan.chip_date && obsNzDate && scan.chip_date.substring(0, 10) === obsNzDate ? 'chipped-here' : '';
  // Combined chick size code: LC + M → LCM, LC + no sex but returned → LCU, LC alone → LC
  const sc = scan.chick_size_code || '';
  const sizeLabel = sc ? (sex ? sc + sex.charAt(0) : (scan.hasReturned ? sc + 'U' : sc)) : '';
  const href = scan.peng_num ? `/bird/${scan.peng_num}` : undefined;
  return (
    <a className={`scan clickable ${cls} ${chipCls} ${grayCls} ${chippedHereCls}`} href={href} onClick={navigateDirectly ? undefined : e => navClick(e, onClick)}>
      {num}{num && icon ? ' ' : ''}{!sizeLabel && icon && <span className="sex-icon">{icon}</span>}{sizeLabel ? ` ${sizeLabel} ` : (num || icon) && chip ? ' ' : ''}{chip}
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

  // Merge allPenguinsInBox — only add birds chipped HERE to the chipping season
  // Birds chipped elsewhere will already appear from their scan data in the correct season
  for (const p of (allPenguinsInBox || [])) {
    if (!p.chip_date || !p.pit_id || !p.is_chipped_here) continue;
    const chipDate = parseDate(p.chip_date);
    const label = getSeasonLabel(chipDate);
    if (!seasonBirds.has(label)) seasonBirds.set(label, new Map());
    const birdMap = seasonBirds.get(label)!;
    const key = p.pit_id.slice(-8);
    if (!birdMap.has(key)) {
      birdMap.set(key, { ...p, lastSeen: p.last_seen || p.chip_date, igCount: 0, scanCount: p.scan_count || 1 });
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

        // For season context: a bird is a chick if chipped as chick during this season
        const seasonYear = parseInt(label);
        const seasonStart = new Date(seasonYear, 3, 1); // Apr 1
        const seasonEnd = new Date(seasonYear + 1, 3, 1); // next Apr 1
        const seasonObsDate = (b: any) => {
          if (!b.chipped_as_adult && b.chip_date) {
            const cd = new Date(b.chip_date);
            if (cd >= seasonStart && cd < seasonEnd) return b.chip_date; // chipped as chick this season → show as chick
          }
          return undefined;
        };

        return (
          <div key={label} className="season-birds">
            <div className="muted">{label}: {birds.length} bird{birds.length !== 1 ? 's' : ''}</div>
            <div className="bird-row">
              {pair.length === 2 && (
                <span className="breeding-pair">
                  {pair.map(b => (
                    <span key={b.pit_id.slice(-8)} className="bird-with-count">
                      <PenguinMini scan={b} onClick={() => onBirdClick(b.peng_num || b.pit_id)} observationDate={seasonObsDate(b)} />
                      <span className="scan-count">{b.scanCount}x</span>
                    </span>
                  ))}
                  {chicks.map(b => (
                    <span key={b.pit_id.slice(-8)} className="bird-with-count">
                      <PenguinMini scan={b} onClick={() => onBirdClick(b.peng_num || b.pit_id)} observationDate={seasonObsDate(b)} />
                      <span className="scan-count">{b.scanCount}x</span>
                    </span>
                  ))}
                </span>
              )}
              {others.map(b => (
                <span key={b.pit_id.slice(-8)} className="bird-with-count">
                  <PenguinMini scan={b} onClick={() => onBirdClick(b.peng_num || b.pit_id)} observationDate={seasonObsDate(b)} />
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
  const localObs = obs;
  const saveObs = (field: string) => async (val: any) => {
    if (!obsId) return;
    const oldVal = localObs[field as keyof typeof localObs] ?? '';
    if (String(oldVal) === String(val ?? '')) return { changed: 0 };
    const desc = `Change ${field} from "${oldVal}" to "${val ?? ''}"${obs.observation_time_utc ? ` (${formatDate(obs.observation_time_utc)})` : ''}`;
    const reason = prompt(`${desc}\n\nReason for change (optional):`);
    if (reason === null) return { changed: 0 }; // cancelled
    const result = await updateRecord(token || '', 'observations', obsId, {[field]: val}, reason || undefined);
    if (result?.changed) { onDataChange?.(); }
    return result;
  };
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [birdSearch, setBirdSearch] = useState('');
  const [localScans, setLocalScans] = useState<Scan[]>(obs.scans);
  useEffect(() => { setLocalScans(obs.scans); }, [obs.observation_id]);

  const filteredAdd = birdSearch.length > 0 && allPenguins
    ? allPenguins.filter((p: any) =>
        (p.peng_num === birdSearch || (p.pit_id && p.pit_id.includes(birdSearch)))
        && !localScans.some(s => s.pit_id === p.pit_id)
      ).slice(0, 8)
    : [];

  // Adding/removing a scan bumps the matching count: a bird that is a chick at the
  // observation date (chipped as a chick < 3 months prior) adjusts #chicks; an adult
  // (chipped as adult, or chipped > 3 months ago) adjusts #adults. Never goes below 0.
  const adjustCountForScan = async (scan: any, delta: number) => {
    if (!obsId || !token) return;
    const field = isChickAtObsDate(scan.chip_date, scan.chipped_as_adult, obs.observation_time_utc) ? 'chicks' : 'adults';
    const current = Number((localObs as any)[field] || 0);
    const next = Math.max(0, current + delta);
    if (next === current) return;
    await updateRecord(token, 'observations', obsId, { [field]: next },
      `${delta > 0 ? '+1' : '-1'} ${field} (penguin #${scan.peng_num || scan.pit_id} ${delta > 0 ? 'added' : 'removed'})`);
  };

  const addScan = async (p: any) => {
    if (!obsId || !token) return;
    if (localScans.some(s => s.pit_id === p.pit_id)) return;
    const result = await createRecord(token, 'penguin_scans', {
      observation_id: obsId, pit_id: p.pit_id, scan_time_utc: obs.observation_time_utc
    });
    if (result?.id) {
      const newScan: Scan = { scan_id: result.id, peng_num: p.peng_num, pit_id: p.pit_id, sex: p.sex, life_stage: p.life_stage, chip_date: p.chip_date, chipped_as_adult: p.chipped_as_adult };
      setLocalScans([...localScans, newScan]);
      await adjustCountForScan(p, 1);
    }
    setBirdSearch('');
    onDataChange?.();
  };

  const removeScan = async (scan: Scan) => {
    if (!scan.scan_id || !token) return;
    await deleteRecord(token, 'penguin_scans', scan.scan_id);
    setLocalScans(localScans.filter(s => s.scan_id !== scan.scan_id));
    await adjustCountForScan(scan, -1);
    onDataChange?.();
  };

  return (
    <div ref={ref} className={`obs-card ${flashing ? 'highlighted' : ''}`} style={deleting ? {opacity: 0.4, pointerEvents: 'none'} : undefined}>
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
              setEditing(false);
              setDeleting(true);
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
        <div className="obs-edit-birds">
          {[...localScans].sort(scanSortMFC).map(s => (
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
        <div className="obs-edit-row">
          <label>{'\uD83D\uDC27'}</label><EditableField value={localObs.adults} type="number" onSave={trackEdit('adults')} canEdit={true} inline narrow min={0} />
          <label>{'\uD83E\uDD5A'}</label><EditableField value={localObs.eggs} type="number" onSave={trackEdit('eggs')} canEdit={true} inline narrow min={0} />
          <label>{'\uD83D\uDC23'}</label><EditableField value={localObs.chicks} type="number" onSave={trackEdit('chicks')} canEdit={true} inline narrow min={0} />
          <EditableField value={localObs.breeding_status || ''} type="select" options={['','CON','POT','UNL','NO','DCM','ABN']} onSave={trackEdit('breeding_status')} canEdit={true} placeholder="Location status" />
          <EditableField value={localObs.gate_status || ''} type="select" options={['','Gate up','Regate']} onSave={trackEdit('gate_status')} canEdit={true} placeholder="Gate status" />
          <EditableField value={localObs.notes || ''} onSave={trackEdit('notes')} placeholder="notes" canEdit={true} inline multiline />
        </div>
        </>
      )}
      {!editing && (obs.scans.length>0 || obs.no_scan) && (
        <div className="scans">
          {[...obs.scans].sort(scanSortMFC).map((s,j) => (
            <PenguinMini key={j} scan={s} onClick={() => onBirdClick?.(s.peng_num || s.pit_id)} observationDate={obs.observation_time_utc} />
          ))}
          {obs.no_scan && <span className="scan no-scan">no scan</span>}
        </div>
      )}
      {showHistory && token && obsId && <HistoryPanel token={token} table="observations" id={obsId} onClose={() => setShowHistory(false)} />}
    </div>
  );
}

function EditableField({ value, type, options, onSave, placeholder, canEdit, inline, narrow, min, multiline }: {
  value: any; type?: 'text'|'number'|'select'|'date'; options?: string[];
  onSave: (val: any) => Promise<any>; placeholder?: string; canEdit?: boolean; inline?: boolean; narrow?: boolean; min?: number; multiline?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value ?? ''));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const ref = useRef<HTMLInputElement|HTMLSelectElement>(null);

  useEffect(() => { if (editing && ref.current) ref.current.focus(); }, [editing]);
  useEffect(() => { setDraft(String(value ?? '')); }, [value]);

  const display = value !== null && value !== undefined && value !== '' ? String(value) : null;
  const flash = () => { setSaved(true); setTimeout(() => setSaved(false), 2000); };

  // Selects always render as a live dropdown, so a blank value is obviously
  // settable (shows the placeholder, e.g. "Location status") rather than a "-".
  if (type === 'select') {
    if (!canEdit) return <span className="ef-value">{display ?? <span className="muted">{placeholder || '-'}</span>}</span>;
    const opts = options || [];
    const allOpts = draft && !opts.includes(draft) ? [draft, ...opts] : opts; // keep current value (e.g. BR) visible
    return (
      <select className={`ef-input${draft === '' ? ' ef-placeholder' : ''}`} value={draft} disabled={saving}
        onChange={async e => { const v = e.target.value; setDraft(v); setSaving(true); await onSave(v || null); setSaving(false); flash(); }}>
        {allOpts.map(o => <option key={o} value={o}>{o || (placeholder || '(none)')}</option>)}
      </select>
    );
  }

  if (!canEdit) return <span className="ef-value">{display ?? <span className="muted">{placeholder || '-'}</span>}</span>;

  const save = async () => {
    setSaving(true);
    let val = type === 'number' ? (draft === '' ? null : parseFloat(draft)) : (draft || null);
    if (type === 'number' && val !== null && min !== undefined && (val as number) < min) val = min;
    await onSave(val);
    setDraft(String(val ?? '')); // resync display to the (possibly clamped) saved value
    setSaving(false);
    setEditing(false);
    flash();
  };

  const cancel = () => { setDraft(String(value ?? '')); setEditing(false); };

  // Inline: a plain input shown directly (no click-to-reveal span / pencil icon),
  // used in the observation edit row where the card is already in edit mode.
  if (inline) {
    if (multiline) {
      return (
        <textarea ref={ref as any} className="ef-input ef-notes" value={draft} disabled={saving} rows={1}
          placeholder={placeholder}
          onChange={e => setDraft(e.target.value)}
          onBlur={() => { if (String(value ?? '') !== draft) save(); }}
          onKeyDown={e => { if (e.key === 'Escape') cancel(); }} />
      );
    }
    return (
      <input ref={ref as any} className={`ef-input${narrow ? ' ef-narrow' : ''}`} type={type || 'text'} value={draft} disabled={saving}
        placeholder={placeholder} min={min}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => { if (String(value ?? '') !== draft) save(); }}
        onKeyDown={e => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); if (e.key === 'Escape') cancel(); }} />
    );
  }

  if (!editing) {
    return (
      <span className="ef-value clickable" onClick={() => setEditing(true)}>
        {display ?? <span className="muted">{placeholder || '-'}</span>}
        {saved && <span className="ef-saved">&#10003;</span>}
        <span className="ef-pencil">&#9998;</span>
      </span>
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
                  {e.change_reason && <span className="muted" style={{fontStyle:'italic'}}>"{e.change_reason}"</span>}
                </div>
                {e.action === 'UPDATE' && (
                  <div className="history-fields">
                    {Object.entries(fields).map(([k, v]: [string, any]) => (
                      <div key={k} className="history-field">
                        <span className="muted">{k}:</span> {v && typeof v === 'object' && 'old' in v
                          ? <><s>{String(v.old ?? '')}</s> &rarr; {String(v.new ?? '')}</>
                          : <>{String(v ?? '')}</>}
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

function BirdPage({ data, onBirdClick, onBoxClick, onSightingClick, onDayClick, token, canEdit }: { data: any; onBirdClick: (tag:string)=>void; onBoxClick: (box:string)=>void; onSightingClick: (box:string, date:string)=>void; onDayClick?: (day:string)=>void; token?: string; canEdit?: boolean }) {
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
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
  const toggleSection = (key: string) => setExpandedSections(s => ({...s, [key]: !s[key]}));
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
          <PenguinMini scan={{peng_num: p.peng_num, pit_id: activeChip?.pit_id, sex: p.sex, chip_date: activeChip?.chip_date, chipped_as_adult: p.chipped_as_adult, chick_size_code: p.chick_size_code, hasReturned: p.hasReturned}} onClick={() => {}} currentStatus />
        </span>
        <span className="bird-title-actions">
          {canEdit && !editing && <button className="edit-btn" onClick={() => setEditing(true)}>Edit</button>}
          {editing && <><button className="edit-btn" onClick={() => setEditing(false)}>Cancel</button><button className="edit-btn done-btn" onClick={() => setEditing(false)}>Done</button></>}
          {canEdit && hasHistory && <button className="history-btn" onClick={() => setShowHistory({table:'penguins', id:p.peng_num})}>History</button>}
        </span>
      </div>

      {showHistory && token && <HistoryPanel token={token} table={showHistory.table} id={showHistory.id} onClose={() => setShowHistory(null)} />}

      {/* Last seen */}
      {sightings.length > 0 && (() => {
        const last = sightings[0];
        return <div className="bird-last-seen">Last seen <DateLink date={last.date} onDayClick={onDayClick} /> at <a className="clickable" href={`/box/${last.box}`} onClick={e => navClick(e, () => onBoxClick(last.box))}>{last.box}</a></div>;
      })()}

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
              const sexSummary = Object.entries(sexCounts).map(([s, n]) => `sexed ${observedSexLabel(s, true)} ${n}x`).join(', ');
              const weightSummary = weights.length > 0 ? `${Math.min(...weights)}-${Math.max(...weights)}g (${weights.length}x)` : '';
              const summary = [sexSummary, weightSummary, lastComment ? `"${lastComment.slice(0, 40)}"` : ''].filter(Boolean).join(' · ');

              return (<>
              <tr><td className="muted">Biometrics</td><td className="clickable" onClick={() => setShowBio(!showBio)}>{summary} <span className="muted small">{biometrics.length} records {showBio ? '▲' : '▼'}</span></td></tr>
              {showBio && biometrics.map((b: any, i: number) => {
                const flags = [
                  b.is_moulting && 'Moulting',
                  b.condition_ticks && 'Ticks', b.condition_dead && 'Dead',
                  b.disposition_aggressive && 'Aggressive', b.disposition_passive && 'Passive',
                ].filter(Boolean);
                return (<Fragment key={`bio${i}`}>
                <tr><td className="muted" colSpan={2} style={{fontWeight:600, paddingTop:4, fontSize:11}}>{b.observation_date || ''}</td></tr>
                {b.observed_sex && <tr><td className="muted">Sex</td><td>{observedSexLabel(b.observed_sex, false)}</td></tr>}
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

      {/* Sightings loading indicator */}
      {sightings.length === 0 && <p className="muted">Loading sighting history...</p>}

      {/* Breeding history by season */}
      {breedingStats.length > 0 && (
        <div className="bird-section">
          <h3 className="collapsible" onClick={() => toggleSection('breeding')}>{expandedSections.breeding ? '▾' : '▸'} Breeding history</h3>
          {expandedSections.breeding && breedingStats.map((bs: any) => (
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
      {sightings.length > 0 && <div className="bird-section">
        <h3 className="collapsible" onClick={() => toggleSection('boxes')}>{expandedSections.boxes ? '▾' : '▸'} Seen in {boxes.length} box{boxes.length !== 1 ? 'es' : ''}</h3>
        {expandedSections.boxes && boxes.map((b: string) => {
          const boxSightings = sightings.filter((s: any) => s.box === b);
          return (
            <div key={b} className="obs-card" style={{marginBottom:6}}>
              <div className="obs-top"><a className="clickable" href={`/box/${b}`} onClick={e => navClick(e, () => onBoxClick(b))}><b>Box {b}</b></a> <span className="muted">{boxSightings.length} visit{boxSightings.length !== 1 ? 's' : ''}</span></div>
              {boxSightings.map((sg: any, i: number) => (
                <div key={i} style={{marginBottom:3}}>
                  <div className="obs-nums" style={{fontSize:11}}>
                    <DateLink date={sg.date} onDayClick={onDayClick} />
                    {(sg.seen_with || []).length > 0 && <span className="muted">with</span>}
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
      </div>}

      {/* Sighting history */}
      {sightings.length > 0 && <div className="bird-section">
        <h3 className="collapsible" onClick={() => toggleSection('sightings')}>{expandedSections.sightings ? '▾' : '▸'} Sighting history ({sightings.length})</h3>
        {expandedSections.sightings && sightings.map((s: any, i: number) => (
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
              {(s.seen_with || []).length > 0 && <span className="muted">with</span>}
              {(s.seen_with || []).map((sw: any) => (
                <PenguinMini key={sw.peng_num} scan={sw} onClick={() => onBirdClick(sw.peng_num)} observationDate={s.date} />
              ))}
            </div>
            {s.notes && <div className="obs-notes">{s.notes}</div>}
          </div>
        ))}
      </div>}


      {/* Shared sightings */}
      {partners.length > 0 && (
        <div className="bird-section">
          <h3 className="collapsible" onClick={() => toggleSection('partners')}>{expandedSections.partners ? '▾' : '▸'} Shared sightings ({partners.length})</h3>
          {expandedSections.partners && <p className="muted">Birds scanned in the same box at the same time</p>}
          {expandedSections.partners && partners.map((pt: any) => (
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
    const s = search.toUpperCase();
    const exact = penguins.filter(p => p.peng_num && p.peng_num.toUpperCase() === s);
    const pit = penguins.filter(p => p.pit_id && p.pit_id.toUpperCase().includes(s) && !(p.peng_num && p.peng_num.toUpperCase() === s));
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
        placeholder="Penguin"
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
  const MONTHS: Record<string, number> = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
  const parseMonth = (p: string): number => {
    const n = parseInt(p);
    if (!isNaN(n)) return n;
    const lc = p.toLowerCase();
    for (const [name, num] of Object.entries(MONTHS)) { if (name.startsWith(lc) || lc.startsWith(name)) return num; }
    return NaN;
  };

  // Split on /, -, space, or .
  const parts = s.split(/[\/\-\.\s]+/);
  if (parts.length !== 3) return null;

  let day: number, month: number, year: number;

  // Detect format: if first part is 4 digits, it's yyyy-mm-dd
  if (parts[0].length === 4 && !isNaN(parseInt(parts[0]))) {
    year = parseInt(parts[0]); month = parseMonth(parts[1]); day = parseInt(parts[2]);
  } else if (parts[2].length === 4 && !isNaN(parseInt(parts[2]))) {
    // d/m/yyyy or d/mon/yyyy
    day = parseInt(parts[0]); month = parseMonth(parts[1]); year = parseInt(parts[2]);
  } else {
    // Ambiguous short year: assume d/m/yy or d/mon/yy
    day = parseInt(parts[0]); month = parseMonth(parts[1]); year = parseInt(parts[2]);
    if (!isNaN(year) && year < 100) year += 2000;
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
    const matchMonths = (s: string): number[] => {
      if (!s || s.length < 1) return [];
      const lc = s.toLowerCase();
      return Object.entries(MONTHS).filter(([name]) => name.startsWith(lc) || lc.startsWith(name)).map(([, num]) => num);
    };

    return dates.filter(d => {
      const [yr, mo, dy] = d.split('-').map(Number);

      // Exact full date match
      if (parsed && d === parsed) return true;

      // Match against formatted display (e.g. "5 Sep 2025") using word boundary
      const display = formatDate(d).toLowerCase();
      const terms = search.toLowerCase().trim();
      // Use regex word boundary so "2 may" doesn't match "12 may"
      try { if (new RegExp('\\b' + terms.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').test(display)) return true; } catch {}
      if (display === terms) return true;

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
        // Month name (partial: "j" matches jan/jun/jul)
        if (matchMonths(p).includes(mo)) return true;
      }

      if (parts.length === 2) {
        const [a, b] = parts.map(p => p.toLowerCase());
        const na = parseInt(a), nb = parseInt(b);

        // Resolve month names (partial match, may return multiple)
        const ma = matchMonths(a);
        const mb = matchMonths(b);

        // year + month: "2025 12", "25 12", "25 dec"
        if (!isNaN(na) && (na >= 2000 || (na >= 20 && na < 100))) {
          const year = na >= 2000 ? na : na + 2000;
          if (year === yr) {
            if (!isNaN(nb) && nb === mo) return true;
            if (mb.includes(mo)) return true;
          }
        }
        // month + year: "12 2025", "dec 25"
        if (!isNaN(nb) && (nb >= 2000 || (nb >= 20 && nb < 100))) {
          const year = nb >= 2000 ? nb : nb + 2000;
          if (year === yr) {
            if (!isNaN(na) && na === mo) return true;
            if (ma.includes(mo)) return true;
          }
        }
        // d/m: "5/9", "28/12"
        if (!isNaN(na) && !isNaN(nb) && na <= 31 && nb <= 12) {
          if (na === dy && nb === mo) return true;
        }
        // month + day: "dec 28"
        if (ma.length > 0 && !isNaN(nb) && ma.includes(mo) && nb === dy) return true;
        // day + month: "28 dec", "13 j"
        if (mb.length > 0 && !isNaN(na) && mb.includes(mo) && na === dy) return true;
      }

      if (parts.length === 3) {
        if (parsed) return d.startsWith(parsed);
        const [p0, p1, p2] = parts.map(p => p.toLowerCase());
        const n0 = parseInt(p0), n1 = parseInt(p1), n2 = parseInt(p2);
        const m1 = matchMonths(p1);

        // day month year: "20 f 2024", "20 feb 24"
        if (!isNaN(n0) && m1.length > 0) {
          const yearVal = !isNaN(n2) ? (n2 < 100 ? n2 + 2000 : n2) : null;
          if (yearVal && n0 === dy && m1.includes(mo) && yearVal === yr) return true;
        }
        // day month year: "20 2 2024" (numeric month)
        if (!isNaN(n0) && !isNaN(n1) && !isNaN(n2) && n0 <= 31 && n1 <= 12) {
          const yearVal = n2 < 100 ? n2 + 2000 : n2;
          if (n0 === dy && n1 === mo && yearVal === yr) return true;
        }
        // year month day: "2024 feb 20"
        if (!isNaN(n0) && m1.length > 0 && !isNaN(n2)) {
          const yearVal = n0 < 100 ? n0 + 2000 : n0;
          if (yearVal === yr && m1.includes(mo) && n2 === dy) return true;
        }
      }

      return false;
    }).sort((a, b) => {
      // Exact parse match first, then most recent
      if (parsed) {
        if (a === parsed) return -1;
        if (b === parsed) return 1;
      }
      return b.localeCompare(a);
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
        const r = await fetch('/api/crud.php?action=register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, email, password })
        });
        const data = await r.json();
        if (data.success) {
          // Auto-login after register
          setIsRegister(false);
          setError('');
          const r2 = await fetch('/api/crud.php?action=login', {
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
        const r = await fetch('/api/crud.php?action=login', {
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
    fetch(`/api/crud.php?action=season_fm_dates&season=${season}`, { headers: { 'Authorization': `Bearer ${token}` } })
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
      const dashRes = await fetch(`/api/dashboard.php?view=box&name=${encodeURIComponent(box)}&_=${Date.now()}`, { headers: { 'Authorization': `Bearer ${token}` } });
      const dashData = await dashRes.json();
      const locationId = dashData.location?.location_id;

      if (!locationId) { setMessage(`Box "${box}" not found in database (no location_id)`); setSaving(false); return; }

      const observerId = parseInt(localStorage.getItem('ww_observer_id') || '3');

      // Create observation
      const obsRes = await fetch('/api/crud.php?action=create&table=observations', {
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
        await fetch('/api/crud.php?action=create&table=penguin_scans', {
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
    fetch(`/api/dashboard.php?view=box&name=${encodeURIComponent(box)}`, { headers: { 'Authorization': `Bearer ${token}` } })
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
                await fetch(`/api/crud.php?action=season_fm_dates&season=${season}`, {
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

function DistinctAdultsChart() {
  const data = useDistinctAdults();

  if (data.length === 0) return <div className="report-card"><p className="muted">No scan data available</p></div>;

  const W = 800, H = 400, PAD = { top: 30, right: 30, bottom: 60, left: 55 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const maxCount = Math.max(...data.map((d: any) => d.count));
  const barW = Math.min(60, plotW / data.length - 4);
  const xScale = (i: number) => PAD.left + (i + 0.5) * (plotW / data.length);
  const yScale = (v: number) => PAD.top + plotH - (v / maxCount) * plotH;

  return (
    <div className="report-card">
      <h3>Distinct Adults Scanned per Season</h3>
      <p className="muted">Number of unique adult penguins scanned each breeding season (Apr–Mar)</p>
      <svg viewBox={`0 0 ${W} ${H}`} className="report-chart">
        {[0.25, 0.5, 0.75, 1].map(frac => (
          <line key={frac} x1={PAD.left} x2={PAD.left + plotW} y1={yScale(maxCount * frac)} y2={yScale(maxCount * frac)} stroke="#e8ecef" strokeWidth="1" />
        ))}
        {[0, 0.25, 0.5, 0.75, 1].map(frac => (
          <text key={frac} x={PAD.left - 8} y={yScale(maxCount * frac) + 4} textAnchor="end" fontSize="11" fill="#888">{Math.round(maxCount * frac)}</text>
        ))}
        {data.map((d: any, i: number) => (
          <Fragment key={d.season}>
            <rect x={xScale(i) - barW / 2} y={yScale(d.count)} width={barW} height={PAD.top + plotH - yScale(d.count)} fill="#2196F3" opacity="0.8" rx="3" />
            <text x={xScale(i)} y={yScale(d.count) - 6} textAnchor="middle" fontSize="11" fill="#333" fontWeight="600">{d.count}</text>
            <text x={xScale(i)} y={PAD.top + plotH + 16} textAnchor="middle" fontSize="10" fill="#666" transform={`rotate(-35, ${xScale(i)}, ${PAD.top + plotH + 16})`}>{d.season}</text>
          </Fragment>
        ))}
        <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={PAD.top + plotH} stroke="#ccc" strokeWidth="1" />
        <line x1={PAD.left} x2={PAD.left + plotW} y1={PAD.top + plotH} y2={PAD.top + plotH} stroke="#ccc" strokeWidth="1" />
        <text x={14} y={PAD.top + plotH / 2} textAnchor="middle" fontSize="12" fill="#666" transform={`rotate(-90, 14, ${PAD.top + plotH / 2})`}>Distinct adults</text>
      </svg>
    </div>
  );
}

function PeakAdultsChart() {
  const data = usePeakAdults();

  if (data.length === 0) return <div className="report-card"><p className="muted">No observation data available</p></div>;

  const W = 800, H = 400, PAD = { top: 30, right: 30, bottom: 70, left: 55 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const maxCount = Math.max(...data.map((d: any) => d.adults));
  const barW = Math.min(60, plotW / data.length - 4);
  const xScale = (i: number) => PAD.left + (i + 0.5) * (plotW / data.length);
  const yScale = (v: number) => PAD.top + plotH - (v / maxCount) * plotH;

  // YYYY-MM-DD → "12 Nov"
  const shortDate = (iso: string) => {
    const [, m, d] = iso.split('-');
    const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][parseInt(m, 10) - 1] || '';
    return `${parseInt(d, 10)} ${mon}`;
  };

  return (
    <div className="report-card">
      <h3>Most Adults on a Single Day per Season</h3>
      <p className="muted">Highest total adults present across the colony on any one day each breeding season (Apr–Mar)</p>
      <svg viewBox={`0 0 ${W} ${H}`} className="report-chart">
        {[0.25, 0.5, 0.75, 1].map(frac => (
          <line key={frac} x1={PAD.left} x2={PAD.left + plotW} y1={yScale(maxCount * frac)} y2={yScale(maxCount * frac)} stroke="#e8ecef" strokeWidth="1" />
        ))}
        {[0, 0.25, 0.5, 0.75, 1].map(frac => (
          <text key={frac} x={PAD.left - 8} y={yScale(maxCount * frac) + 4} textAnchor="end" fontSize="11" fill="#888">{Math.round(maxCount * frac)}</text>
        ))}
        {data.map((d: any, i: number) => (
          <Fragment key={d.season}>
            <rect x={xScale(i) - barW / 2} y={yScale(d.adults)} width={barW} height={PAD.top + plotH - yScale(d.adults)} fill="#FF9800" opacity="0.85" rx="3">
              <title>{`${d.season}: ${d.adults} adults on ${d.date}`}</title>
            </rect>
            <text x={xScale(i)} y={yScale(d.adults) - 6} textAnchor="middle" fontSize="11" fill="#333" fontWeight="600">{d.adults}</text>
            <text x={xScale(i)} y={PAD.top + plotH + 16} textAnchor="middle" fontSize="10" fill="#666">{d.season}</text>
            <text x={xScale(i)} y={PAD.top + plotH + 30} textAnchor="middle" fontSize="9" fill="#999">{shortDate(d.date)}</text>
          </Fragment>
        ))}
        <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={PAD.top + plotH} stroke="#ccc" strokeWidth="1" />
        <line x1={PAD.left} x2={PAD.left + plotW} y1={PAD.top + plotH} y2={PAD.top + plotH} stroke="#ccc" strokeWidth="1" />
        <text x={14} y={PAD.top + plotH / 2} textAnchor="middle" fontSize="12" fill="#666" transform={`rotate(-90, 14, ${PAD.top + plotH / 2})`}>Peak adults</text>
      </svg>
    </div>
  );
}

function EggArrivalChart() {
  const data = useEggArrival();

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

function ChickSexChart() {
  const allPenguins = useAllPenguins();

  const data = useMemo(() => {
    if (!allPenguins || allPenguins.length === 0) return null;
    const groups: Record<string, { M: number; F: number; U: number; total: number; returned: number }> = {
      LC: { M: 0, F: 0, U: 0, total: 0, returned: 0 },
      BC: { M: 0, F: 0, U: 0, total: 0, returned: 0 },
      SC: { M: 0, F: 0, U: 0, total: 0, returned: 0 },
    };
    for (const p of allPenguins) {
      if (p.chipped_as_adult) continue;
      const size = p.chick_size_code as string;
      if (!size || !(size in groups)) continue;
      const g = groups[size as keyof typeof groups];
      const sex = (p.sex || '').toUpperCase();
      const s = (sex === 'M' || sex === 'F' ? sex : 'U') as 'M' | 'F' | 'U';
      g[s]++;
      g.total++;
      if (p.hasReturned) g.returned++;
    }
    return groups;
  }, [allPenguins]);

  if (!data) return <div className="report-card"><p className="muted">No data available</p></div>;

  const sizes = ['BC', 'LC', 'SC'] as const;
  const sizeLabels: Record<string, string> = { LC: 'Little Chick', BC: 'Big Chick', SC: 'Single Chick' };
  const sexColors = { M: '#2196F3', F: '#E91E63' };
  const sexLabels: Record<string, string> = { M: 'Male', F: 'Female' };

  const W = 600, H = 320, PAD = { top: 30, right: 20, bottom: 60, left: 50 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const barGroupW = plotW / sizes.length;
  const barW = barGroupW * 0.3;

  const maxKnown = Math.max(...sizes.map(s => { const g = data[s]; return g ? g.M + g.F : 0; }));
  const maxTotal = maxKnown;
  const yScale = (v: number) => PAD.top + plotH - (maxTotal > 0 ? (v / maxTotal) * plotH : 0);

  return (
    <div className="report-card">
      <h3>Chick Size vs Sex</h3>
      <p className="muted">Sex distribution of penguins chipped as LC, BC, or SC chicks</p>
      <svg viewBox={`0 0 ${W} ${H}`} className="report-chart">
        {/* Grid lines */}
        {[0.25, 0.5, 0.75, 1].map(frac => (
          <line key={frac} x1={PAD.left} x2={PAD.left + plotW} y1={yScale(maxTotal * frac)} y2={yScale(maxTotal * frac)} stroke="#e8ecef" strokeWidth="1" />
        ))}
        {/* Y axis labels */}
        {[0, 0.25, 0.5, 0.75, 1].map(frac => (
          <text key={frac} x={PAD.left - 8} y={yScale(maxTotal * frac) + 4} textAnchor="end" fontSize="11" fill="#888">{Math.round(maxTotal * frac)}</text>
        ))}
        {/* Bars */}
        {sizes.map((size, gi) => {
          const g = data[size];
          if (!g) return null;
          const cx = PAD.left + barGroupW * gi + barGroupW / 2;
          const sexKeys = ['M', 'F'] as const;
          return (
            <Fragment key={size}>
              {sexKeys.map((sex, si) => {
                const count = g[sex] || 0;
                if (count === 0) return null;
                const x = cx - barW + si * barW;
                const barH = maxTotal > 0 ? (count / maxTotal) * plotH : 0;
                return (
                  <Fragment key={sex}>
                    <rect x={x} y={yScale(count)} width={barW - 2} height={barH} fill={sexColors[sex]} opacity="0.85" rx="2" />
                    <text x={x + (barW - 2) / 2} y={yScale(count) - 4} textAnchor="middle" fontSize="10" fill={sexColors[sex]} fontWeight="600">{count}</text>
                  </Fragment>
                );
              })}
              <text x={cx} y={PAD.top + plotH + 16} textAnchor="middle" fontSize="12" fill="#666" fontWeight="600">{sizeLabels[size]}</text>
              <text x={cx} y={PAD.top + plotH + 30} textAnchor="middle" fontSize="10" fill="#888">n={g.M + g.F}</text>
            </Fragment>
          );
        })}
        {/* Axes */}
        <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={PAD.top + plotH} stroke="#ccc" strokeWidth="1" />
        <line x1={PAD.left} x2={PAD.left + plotW} y1={PAD.top + plotH} y2={PAD.top + plotH} stroke="#ccc" strokeWidth="1" />
      </svg>
      {/* Legend */}
      <div style={{display:'flex', gap:'1.5em', justifyContent:'center', marginTop:'0.5em'}}>
        {(['M','F'] as const).map(sex => (
          <span key={sex} style={{display:'flex', alignItems:'center', gap:'0.3em', fontSize:'0.85em'}}>
            <span style={{width:12,height:12,borderRadius:2,background:sexColors[sex],display:'inline-block'}} />
            {sexLabels[sex]}
          </span>
        ))}
      </div>
      {/* Percentage table */}
      <table style={{margin:'1em auto', borderCollapse:'collapse', fontSize:'0.85em'}}>
        <thead>
          <tr style={{borderBottom:'1px solid #ddd'}}>
            <th style={{padding:'0.3em 1em', textAlign:'left'}}>Size</th>
            <th style={{padding:'0.3em 1em'}}>Total</th>
            <th style={{padding:'0.3em 1em'}}>Male</th>
            <th style={{padding:'0.3em 1em'}}>Female</th>
            <th style={{padding:'0.3em 1em'}}>% Male</th>
            <th style={{padding:'0.3em 1em'}}>% Female</th>
          </tr>
        </thead>
        <tbody>
          {sizes.map(size => {
            const g = data[size];
            if (!g) return null;
            const known = g.M + g.F;
            return (
              <tr key={size} style={{borderBottom:'1px solid #eee'}}>
                <td style={{padding:'0.3em 1em', fontWeight:600}}>{sizeLabels[size]}</td>
                <td style={{padding:'0.3em 1em', textAlign:'center'}}>{known}</td>
                <td style={{padding:'0.3em 1em', textAlign:'center', color:sexColors.M}}>{g.M}</td>
                <td style={{padding:'0.3em 1em', textAlign:'center', color:sexColors.F}}>{g.F}</td>
                <td style={{padding:'0.3em 1em', textAlign:'center'}}>{known > 0 ? (g.M / known * 100).toFixed(1) + '%' : '—'}</td>
                <td style={{padding:'0.3em 1em', textAlign:'center'}}>{known > 0 ? (g.F / known * 100).toFixed(1) + '%' : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ChickSexBothReturnedChart() {
  const allPenguins = useAllPenguins();

  const result = useMemo(() => {
    if (!allPenguins || allPenguins.length === 0) return null;
    // Get all chicks with BC/LC size codes
    const chicks = allPenguins.filter((p: any) => !p.chipped_as_adult && (p.chick_size_code === 'BC' || p.chick_size_code === 'LC') && p.chip_box && p.chip_date);

    // Group by nest (chip_box + chip_season)
    const nests = new Map<string, any[]>();
    for (const c of chicks) {
      const d = new Date(c.chip_date);
      const seasonYear = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
      const key = `${c.chip_box}|${seasonYear}`;
      if (!nests.has(key)) nests.set(key, []);
      nests.get(key)!.push(c);
    }

    const groups = { LC: { M: 0, F: 0, U: 0, total: 0 }, BC: { M: 0, F: 0, U: 0, total: 0 } };
    let pairs = 0;
    let bothReturnedTotal = 0;

    for (const nest of nests.values()) {
      const bc = nest.find((c: any) => c.chick_size_code === 'BC');
      const lc = nest.find((c: any) => c.chick_size_code === 'LC');
      if (!bc || !lc) continue;
      if (!bc.hasReturned || !lc.hasReturned) continue;

      bothReturnedTotal++;

      const bcSex = (bc.sex || '').toUpperCase();
      const lcSex = (lc.sex || '').toUpperCase();
      if (!((bcSex === 'M' && lcSex === 'F') || (bcSex === 'F' && lcSex === 'M'))) continue;

      pairs++;
      for (const c of [bc, lc]) {
        const size = c.chick_size_code as 'BC' | 'LC';
        const sex = (c.sex || '').toUpperCase();
        groups[size][sex as 'M' | 'F']++;
        groups[size].total++;
      }
    }

    return { groups, pairs, bothReturnedTotal };
  }, [allPenguins]);

  if (!result) return <div className="report-card"><h3>Chick Size vs Sex — One Male, One Female Returned</h3><p className="muted">No data available</p></div>;

  const { groups, pairs, bothReturnedTotal } = result;

  if (!pairs || pairs === 0) return (
    <div className="report-card">
      <h3>Chick Size vs Sex — One Male, One Female Returned</h3>
      <p className="muted">Waiting for the first pair of male/female chicks to both return to the colony. No nests yet where both the BC and LC returned and one was confirmed male, one female.</p>
      {bothReturnedTotal > 0 && <p className="muted">{bothReturnedTotal} nest{bothReturnedTotal !== 1 ? 's' : ''} where both chicks returned (any sex combination).</p>}
    </div>
  );
  const sizes = ['BC', 'LC'] as const;
  const sizeLabels: Record<string, string> = { LC: 'Little Chick', BC: 'Big Chick' };
  const sexColors = { M: '#2196F3', F: '#E91E63' };
  const sexLabels: Record<string, string> = { M: 'Male', F: 'Female' };

  const W = 500, H = 320, PAD = { top: 30, right: 20, bottom: 60, left: 50 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const barGroupW = plotW / sizes.length;
  const barW = barGroupW * 0.3;

  const maxVal = Math.max(...sizes.map(s => { const g = groups[s]; return g ? Math.max(g.M, g.F) : 0; }));
  const yScale = (v: number) => PAD.top + plotH - (maxVal > 0 ? (v / maxVal) * plotH : 0);

  return (
    <div className="report-card">
      <h3>Chick Size vs Sex — One Male, One Female Returned</h3>
      <p className="muted">From nests where both BC and LC returned and one was male, one female ({pairs} pairs)</p>
      <svg viewBox={`0 0 ${W} ${H}`} className="report-chart">
        {[0.25, 0.5, 0.75, 1].map(frac => (
          <line key={frac} x1={PAD.left} x2={PAD.left + plotW} y1={yScale(maxVal * frac)} y2={yScale(maxVal * frac)} stroke="#e8ecef" strokeWidth="1" />
        ))}
        {[0, 0.25, 0.5, 0.75, 1].map(frac => (
          <text key={frac} x={PAD.left - 8} y={yScale(maxVal * frac) + 4} textAnchor="end" fontSize="11" fill="#888">{Math.round(maxVal * frac)}</text>
        ))}
        {sizes.map((size, gi) => {
          const g = groups[size];
          if (!g) return null;
          const cx = PAD.left + barGroupW * gi + barGroupW / 2;
          const sexKeys = ['M', 'F'] as const;
          return (
            <Fragment key={size}>
              {sexKeys.map((sex, si) => {
                const count = g[sex] || 0;
                if (count === 0) return null;
                const x = cx - barW + si * barW;
                const barH = maxVal > 0 ? (count / maxVal) * plotH : 0;
                return (
                  <Fragment key={sex}>
                    <rect x={x} y={yScale(count)} width={barW - 2} height={barH} fill={sexColors[sex]} opacity="0.85" rx="2" />
                    <text x={x + (barW - 2) / 2} y={yScale(count) - 4} textAnchor="middle" fontSize="10" fill={sexColors[sex]} fontWeight="600">{count}</text>
                  </Fragment>
                );
              })}
              <text x={cx} y={PAD.top + plotH + 16} textAnchor="middle" fontSize="12" fill="#666" fontWeight="600">{sizeLabels[size]}</text>
              <text x={cx} y={PAD.top + plotH + 30} textAnchor="middle" fontSize="10" fill="#888">n={g.total}</text>
            </Fragment>
          );
        })}
        <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={PAD.top + plotH} stroke="#ccc" strokeWidth="1" />
        <line x1={PAD.left} x2={PAD.left + plotW} y1={PAD.top + plotH} y2={PAD.top + plotH} stroke="#ccc" strokeWidth="1" />
      </svg>
      <div style={{display:'flex', gap:'1.5em', justifyContent:'center', marginTop:'0.5em'}}>
        {(['M','F'] as const).map(sex => (
          <span key={sex} style={{display:'flex', alignItems:'center', gap:'0.3em', fontSize:'0.85em'}}>
            <span style={{width:12,height:12,borderRadius:2,background:sexColors[sex],display:'inline-block'}} />
            {sexLabels[sex]}
          </span>
        ))}
      </div>
      <table style={{margin:'1em auto', borderCollapse:'collapse', fontSize:'0.85em'}}>
        <thead>
          <tr style={{borderBottom:'1px solid #ddd'}}>
            <th style={{padding:'0.3em 1em', textAlign:'left'}}>Size</th>
            <th style={{padding:'0.3em 1em'}}>Total</th>
            <th style={{padding:'0.3em 1em'}}>Male</th>
            <th style={{padding:'0.3em 1em'}}>Female</th>
            <th style={{padding:'0.3em 1em'}}>% Male</th>
            <th style={{padding:'0.3em 1em'}}>% Female</th>
          </tr>
        </thead>
        <tbody>
          {sizes.map(size => {
            const g = groups[size];
            if (!g) return null;
            const known = g.M + g.F;
            return (
              <tr key={size} style={{borderBottom:'1px solid #eee'}}>
                <td style={{padding:'0.3em 1em', fontWeight:600}}>{sizeLabels[size]}</td>
                <td style={{padding:'0.3em 1em', textAlign:'center'}}>{known}</td>
                <td style={{padding:'0.3em 1em', textAlign:'center', color:sexColors.M}}>{g.M}</td>
                <td style={{padding:'0.3em 1em', textAlign:'center', color:sexColors.F}}>{g.F}</td>
                <td style={{padding:'0.3em 1em', textAlign:'center'}}>{known > 0 ? (g.M / known * 100).toFixed(1) + '%' : '—'}</td>
                <td style={{padding:'0.3em 1em', textAlign:'center'}}>{known > 0 ? (g.F / known * 100).toFixed(1) + '%' : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted" style={{marginTop:'0.5em'}}>Which sibling was male — the bigger or smaller chick?</p>
      {bothReturnedTotal > 0 && <p className="muted" style={{marginTop:'0.5em'}}>{bothReturnedTotal} nest{bothReturnedTotal !== 1 ? 's' : ''} total where both chicks returned from a single nest.</p>}
    </div>
  );
}

function ChickReturnChart() {
  const data = useChickReturn();

  if (!data || Object.keys(data.by_season || {}).length === 0) return <div className="report-card"><p className="muted">No data available</p></div>;

  const sizes = ['LC', 'BC', 'SC'] as const;
  const sizeLabels: Record<string, string> = { LC: 'Little Chick', BC: 'Big Chick', SC: 'Single Chick' };
  const sizeColors: Record<string, string> = { LC: '#4CAF50', BC: '#FF9800', SC: '#9C27B0' };
  const totals = data.totals;
  const bySeason = data.by_season;
  const seasons = Object.keys(bySeason).sort();

  // Bar chart: overall return rate per size
  const W = 500, H = 280, PAD = { top: 30, right: 20, bottom: 50, left: 50 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const barGroupW = plotW / sizes.length;
  const barW = barGroupW * 0.5;
  const maxPct = Math.max(...sizes.map(s => { const t = totals[s]; return t && t.chipped > 0 ? (t.returned / t.chipped) * 100 : 0; }));
  const yMax = Math.ceil(maxPct / 10) * 10 + 5; // round up to next 10 + a little headroom
  const yScale = (v: number) => PAD.top + plotH - (v / yMax) * plotH;
  const yTicks = Array.from({ length: Math.floor(yMax / 10) + 1 }, (_, i) => i * 10).filter(v => v <= yMax);

  return (
    <>
    <div className="report-card">
      <h3>Chick Return Rate by Size</h3>
      <p className="muted">Percentage of chicks that returned to the colony in a later season, by size at chipping</p>
      <svg viewBox={`0 0 ${W} ${H}`} className="report-chart">
        {/* Grid lines */}
        {yTicks.filter(v => v > 0).map(pct => (
          <line key={pct} x1={PAD.left} x2={PAD.left + plotW} y1={yScale(pct)} y2={yScale(pct)} stroke="#e8ecef" strokeWidth="1" />
        ))}
        {/* Y axis labels */}
        {yTicks.map(pct => (
          <text key={pct} x={PAD.left - 8} y={yScale(pct) + 4} textAnchor="end" fontSize="11" fill="#888">{pct}%</text>
        ))}
        {/* Bars */}
        {sizes.map((size, i) => {
          const t = totals[size];
          if (!t || t.chipped === 0) return null;
          const pct = (t.returned / t.chipped) * 100;
          const cx = PAD.left + barGroupW * i + barGroupW / 2;
          const x = cx - barW / 2;
          const barH = (pct / yMax) * plotH;
          return (
            <Fragment key={size}>
              <rect x={x} y={yScale(pct)} width={barW} height={barH} fill={sizeColors[size]} opacity="0.85" rx="2" />
              <text x={cx} y={yScale(pct) - 6} textAnchor="middle" fontSize="12" fill={sizeColors[size]} fontWeight="700">{pct.toFixed(1)}%</text>
              <text x={cx} y={PAD.top + plotH + 16} textAnchor="middle" fontSize="12" fill="#666" fontWeight="600">{sizeLabels[size]}</text>
              <text x={cx} y={PAD.top + plotH + 30} textAnchor="middle" fontSize="10" fill="#888">{t.returned}/{t.chipped}</text>
            </Fragment>
          );
        })}
        {/* Axes */}
        <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={PAD.top + plotH} stroke="#ccc" strokeWidth="1" />
        <line x1={PAD.left} x2={PAD.left + plotW} y1={PAD.top + plotH} y2={PAD.top + plotH} stroke="#ccc" strokeWidth="1" />
      </svg>
      {/* Average return age */}
      <div style={{display:'flex', gap:'2em', justifyContent:'center', margin:'0.8em 0', flexWrap:'wrap'}}>
        {sizes.map(size => {
          const t = totals[size];
          if (!t || !t.avg_return_age) return null;
          return (
            <div key={size} style={{textAlign:'center'}}>
              <div style={{fontSize:'1.4em', fontWeight:700, color:sizeColors[size]}}>{t.avg_return_age}y</div>
              <div style={{fontSize:'0.8em', color:'#888'}}>{sizeLabels[size]} avg return age</div>
              <div style={{fontSize:'0.75em', color:'#aaa'}}>median {t.median_return_age}y</div>
            </div>
          );
        })}
      </div>
      <p className="muted" style={{fontSize:'0.8em', textAlign:'center', margin:'0.5em 1em'}}>Chicks from the 2025/26 season are excluded as they haven't had a chance to return yet.</p>
      {/* Season breakdown table */}
      {seasons.length > 0 && (
        <table style={{margin:'1em auto', borderCollapse:'collapse', fontSize:'0.85em'}}>
          <thead>
            <tr style={{borderBottom:'1px solid #ddd'}}>
              <th style={{padding:'0.3em 0.8em', textAlign:'left'}}>Season</th>
              {sizes.map(s => (
                <th key={s} colSpan={2} style={{padding:'0.3em 0.8em', textAlign:'center', color: sizeColors[s]}}>{sizeLabels[s]}</th>
              ))}
              <th style={{padding:'0.3em 0.8em', textAlign:'center'}}>Total</th>
            </tr>
            <tr style={{borderBottom:'1px solid #eee'}}>
              <th></th>
              {sizes.map(s => (
                <Fragment key={s}>
                  <th style={{padding:'0.2em 0.5em', fontSize:'0.85em', color:'#888'}}>Return</th>
                  <th style={{padding:'0.2em 0.5em', fontSize:'0.85em', color:'#888'}}>Total</th>
                </Fragment>
              ))}
              <th style={{padding:'0.2em 0.5em', fontSize:'0.85em', color:'#888'}}>Chicks</th>
            </tr>
          </thead>
          <tbody>
            {seasons.map(season => (
              <tr key={season} style={{borderBottom:'1px solid #eee'}}>
                <td style={{padding:'0.3em 0.8em', fontWeight:600}}>{season}</td>
                {sizes.map(size => {
                  const g = bySeason[season]?.[size];
                  return (
                    <Fragment key={size}>
                      <td style={{padding:'0.3em 0.5em', textAlign:'center'}}>{g ? g.returned : '—'}</td>
                      <td style={{padding:'0.3em 0.5em', textAlign:'center', color:'#888'}}>{g ? g.chipped : '—'}</td>
                    </Fragment>
                  );
                })}
                <td style={{padding:'0.3em 0.5em', textAlign:'center', fontWeight:600}}>
                  {sizes.reduce((sum, size) => sum + (bySeason[season]?.[size]?.chipped || 0), 0)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>

      {/* Histogram: age at first return */}
      {data.points && data.points.length > 0 && (() => {
        const pts = (data.points as { size: string; age: number; peng_num: string }[]).filter(p => p.age > 0);
        if (pts.length === 0) return null;

        // Bucket into 1-month bins
        const ageMonths = pts.map(p => Math.round(p.age * 12));
        const maxMonth = Math.max(...ageMonths);
        const bins: number[] = Array(maxMonth + 1).fill(0);
        for (const m of ageMonths) bins[m]++;
        const maxCount = Math.max(...bins);

        const SW = 800, SH = 300, SP = { top: 30, right: 20, bottom: 45, left: 50 };
        const spW = SW - SP.left - SP.right;
        const spH = SH - SP.top - SP.bottom;
        const barW = spW / maxMonth;
        const xScale2 = (m: number) => SP.left + (m - 1) * barW;
        const yScale2 = (v: number) => SP.top + spH - (v / maxCount) * spH;

        return (
          <div className="report-card" style={{marginTop: '0.5em'}}>
            <h3>Age at First Return</h3>
            <p className="muted">How old penguins were when first scanned back at the colony (n={pts.length})</p>
            <svg viewBox={`0 0 ${SW} ${SH}`} className="report-chart">
              {/* X axis labels - every 6 months, with year lines */}
              {Array.from({ length: Math.floor(maxMonth / 6) + 1 }, (_, i) => (i + 1) * 6).filter(m => m <= maxMonth).map(m => (
                <Fragment key={m}>
                  <line x1={xScale2(m) + barW / 2} x2={xScale2(m) + barW / 2} y1={SP.top} y2={SP.top + spH} stroke={m % 12 === 0 ? '#d0d0d0' : '#ececec'} strokeWidth="1" />
                  <text x={xScale2(m) + barW / 2} y={SP.top + spH + 16} textAnchor="middle" fontSize="10" fill={m % 12 === 0 ? '#666' : '#999'} fontWeight={m % 12 === 0 ? '600' : '400'}>{m}m</text>
                </Fragment>
              ))}
              {/* Y grid */}
              {[0.25, 0.5, 0.75, 1].map(frac => (
                <line key={frac} x1={SP.left} x2={SP.left + spW} y1={yScale2(maxCount * frac)} y2={yScale2(maxCount * frac)} stroke="#e8ecef" strokeWidth="1" />
              ))}
              {/* Y axis labels */}
              {[0, 0.25, 0.5, 0.75, 1].map(frac => {
                const v = Math.round(maxCount * frac);
                return <text key={frac} x={SP.left - 8} y={yScale2(v) + 4} textAnchor="end" fontSize="11" fill="#888">{v}</text>;
              })}
              {/* Bars */}
              {bins.map((count, m) => {
                if (m === 0 || count === 0) return null;
                const barH = (count / maxCount) * spH;
                return (
                  <Fragment key={m}>
                    <rect x={xScale2(m)} y={yScale2(count)} width={Math.max(barW - 1, 1)} height={barH} fill="#2196F3" opacity="0.75" rx="1" />
                    {count >= 3 && <text x={xScale2(m) + barW / 2} y={yScale2(count) - 3} textAnchor="middle" fontSize="8" fill="#2196F3" fontWeight="600">{count}</text>}
                  </Fragment>
                );
              })}
              {/* Axes */}
              <line x1={SP.left} x2={SP.left} y1={SP.top} y2={SP.top + spH} stroke="#ccc" strokeWidth="1" />
              <line x1={SP.left} x2={SP.left + spW} y1={SP.top + spH} y2={SP.top + spH} stroke="#ccc" strokeWidth="1" />
              <text x={SP.left + spW / 2} y={SH - 2} textAnchor="middle" fontSize="12" fill="#666">Age at first return (months)</text>
            </svg>
          </div>
        );
      })()}
    </>
  );
}

function DayCalendar({ date, dates, onDayClick }: { date: string; dates: string[]; onDayClick: (day: string) => void }) {
  const { show: showTip, hide: hideTip, statsCache } = useContext(DateTooltipCtx);
  const dateSet = useMemo(() => new Set(dates), [dates]);
  const fullMonitorDates = useMemo(() => {
    const fm = new Set<string>();
    for (const d of dates) { const s = statsCache.get(d); if (s?.isFullMonitor) fm.add(d); }
    return fm;
  }, [dates, statsCache]);

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
      if (active) active.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'center' });
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
                        className={`cal-day${hasData ? ' has-data' : ''}${isActive ? ' active' : ''}${fullMonitorDates.has(d) ? ' full-monitor' : ''}`}
                        onClick={hasData ? () => onDayClick(d) : undefined}
                        onMouseEnter={hasData ? e => showTip(d, e) : undefined}
                        onMouseLeave={hasData ? hideTip : undefined}
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

function DayView({ date, dates, onBoxClick, onBirdClick: _onBirdClick, onDayClick, externalBird, token, canEdit, allPenguins }: { date: string; dates: string[]; onBoxClick: (box: string) => void; onBirdClick: (num: string) => void; onDayClick: (day: string) => void; externalBird?: string | null; token?: string; canEdit?: boolean; allPenguins?: any[] }) {
  const data = useDayData(date);
  const loading = !data;
  const [sideBird, setSideBird] = useState<string|null>(null);
  const sideBirdData = useBirdDetail(sideBird);
  const [expandedBox, setExpandedBox] = useState<string|null>(null);

  useEffect(() => {
    if (externalBird) setSideBird(externalBird);
  }, [externalBird]);

  const handleBirdClick = (num: string) => setSideBird(num);
  const [showCarryForward, setShowCarryForward] = useState(false);
  const [hideDcm, setHideDcm] = useState(false);
  // "Only changed" filter: show boxes whose observation differs from the previous one (before this day)
  const [changedExpanded, setChangedExpanded] = useState(false);
  const [changedFields, setChangedFields] = useState<Set<string>>(new Set());
  const toggleChangedField = (f: string) => setChangedFields(prev => {
    const next = new Set(prev);
    if (next.has(f)) next.delete(f); else next.add(f);
    return next;
  });

  if (loading) return <div className="day-page"><p className="muted">Loading...</p></div>;
  if (!data || data.error) return <div className="day-page"><p className="muted">{data?.error || 'Failed to load'}</p></div>;

  const sorted = [...dates].sort();

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

  const dayPageRef = useRef<HTMLDivElement>(null);
  const [calHidden, setCalHidden] = useState(false);

  return (
    <div className="day-page" ref={dayPageRef}>
      {!calHidden && (
        <div style={{position:'relative'}}>
          <DayCalendar date={date} dates={sorted} onDayClick={onDayClick} />
          <button onClick={() => setCalHidden(true)} className="cal-toggle" style={{position:'absolute', bottom:-10, right:16}} title="Hide calendar">
            <svg viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1,5 5,1 9,5" />
            </svg>
          </button>
        </div>
      )}
      {calHidden && (
        <button onClick={() => setCalHidden(false)} className="cal-toggle cal-toggle-collapsed" title="Show calendar">
          <svg viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="1,1 5,5 9,1" />
          </svg>
        </button>
      )}
      {(totalObs > 0 || totalChips > 0) && (
        <div className="day-section">
          <h3 className="day-header-row">
            <span className="day-stats"><DateStatsLine stats={getDateStats().get(date) || { boxes:0, obs:0, adults:0, eggs:0, chicks:0, penguins:0, chipped:0, label:null, isFullMonitor:false, totalLocations:0 }} showDate date={date} /></span>
            <button type="button" className={`day-changed-toggle${changedFields.size ? ' active' : ''}`} onClick={() => setChangedExpanded(v => !v)} title="Only show boxes whose observation differs from the previous one">
              Changed {changedExpanded ? '▴' : '▾'}
            </button>
            {changedExpanded && CHANGED_FIELDS.map(f => (
              <label key={f.key} className="day-cf-toggle">
                <input type="checkbox" checked={changedFields.has(f.key)} onChange={() => toggleChangedField(f.key)} /> {f.label}
              </label>
            ))}
            {changedExpanded && changedFields.size > 0 && (
              <button type="button" className="day-changed-clear" onClick={() => setChangedFields(new Set())}>clear</button>
            )}
            <span className="day-cf-toggles">
              <label className="day-cf-toggle"><input type="checkbox" checked={showCarryForward} onChange={e => {
                const v = e.target.checked;
                setShowCarryForward(v);
                if (v) setChangedFields(new Set()); else setHideDcm(false);
              }} /> Show all</label>
              {showCarryForward && (
                <label className="day-cf-toggle"><input type="checkbox" checked={hideDcm} onChange={e => setHideDcm(e.target.checked)} /> Hide DCM</label>
              )}
            </span>
          </h3>
          <div className="day-grid">
          {(() => {
            // DCM boxes for this date
            const dcmBoxes = hideDcm ? getDcmBoxes(date) : new Set<string>();
            // Build carry-forward data if enabled
            const observedBoxes = new Set(sortedBoxes);
            const cfData = showCarryForward ? queryCarryForward(date, observedBoxes) : [];
            const cfByBox: Record<string, any> = {};
            for (const cf of cfData) cfByBox[cf.box_name] = cf;

            // Merge all boxes: observed + carry-forward, filter out DCM if enabled
            let allBoxNames = (showCarryForward
              ? [...new Set([...sortedBoxes, ...cfData.map((c: any) => c.box_name)])]
              : [...sortedBoxes]
            ).filter(b => !dcmBoxes.has(b)).sort((a, b) => {
              const na = parseInt(a), nb = parseInt(b);
              return (!isNaN(na) && !isNaN(nb)) ? na - nb : a.localeCompare(b);
            });

            // "Only changed" filter: keep boxes observed today whose observation differs from the
            // box's previous observation (before today) in a selected field. Carry-forward-only
            // boxes have no new observation, so they're excluded while this filter is active.
            let hiddenByChange = 0;
            if (changedFields.size > 0) {
              const observedBefore = allBoxNames.filter(b => observedBoxes.has(b)).length;
              const prevByBox = queryPreviousObservations(date, [...observedBoxes]);
              allBoxNames = allBoxNames.filter(box => {
                if (!observedBoxes.has(box)) return false;
                const prev = prevByBox[box];
                return (byBox[box]?.obs || []).some((o: any) => obsDiffersFromPrev(o, prev, changedFields));
              });
              hiddenByChange = observedBefore - allBoxNames.length;
            }

            const rows = allBoxNames.map(box => {
              const cf = cfByBox[box];
              if (cf && !observedBoxes.has(box)) {
                // Carry-forward row (orange)
                const cfScans = (cf.scans || []).filter((s: any, i: number, arr: any[]) => s.peng_num && arr.findIndex((x: any) => x.peng_num === s.peng_num) === i)
                  .sort((a: any, b: any) => { const order: Record<string,number> = {M:0, F:1, BC:2, LC:3, SC:4}; const ka = (a.sex||'').toUpperCase(); const kb = (b.sex||'').toUpperCase(); const ca = a.chick_size_code || ''; const cb = b.chick_size_code || ''; return (order[ka] ?? order[ca] ?? 5) - (order[kb] ?? order[cb] ?? 5); });
                const cfDs = displayStatus(cf.breeding_status, cf.eggs, cf.chicks);
                return (
                  <div key={box} className="day-row day-row-cf">
                    <a className="day-box-link" href={`/box/${box}`} onClick={e => navClick(e, () => onBoxClick(box))}><b>Box {box}</b></a>
                    {cf.adults > 0 && <span>{'\uD83D\uDC27'.repeat(Math.min(cf.adults, 4))}</span>}
                    {cf.eggs > 0 && <span>{'\uD83E\uDD5A'.repeat(Math.min(cf.eggs, 4))}</span>}
                    {cf.chicks > 0 && <span>{'\uD83D\uDC23'.repeat(Math.min(cf.chicks, 4))}</span>}
                    {cfDs && cfDs !== 'NO' && <span className={`badge ${DARK_TEXT_STATUSES.has(cfDs)?'bordered':''}`} style={{background:STATUS_COLORS[cfDs]||'#ccc',color:DARK_TEXT_STATUSES.has(cfDs)?'#333':'#fff',fontSize:10,padding:'1px 5px'}}>{cfDs}</span>}
                    {cfScans.map((s: any) => <PenguinMini key={s.peng_num} scan={s} onClick={() => handleBirdClick(s.peng_num)} observationDate={cf.observation_time_utc} />)}
                    {cf.gate_status && <span>{cf.gate_status}</span>}
                    <span className="day-cf-date">{formatDate(cf.observation_time_utc)}</span>
                  </div>
                );
              }
              // Normal row(s) — show each observation separately
              const { obs, chips } = byBox[box];
              return (
              <div key={box}>
                {obs.map((o: any, oi: number) => {
                  // Keep duplicate scans visible — the same penguin scanned >1x in one observation is a
                  // data-entry error worth surfacing, not noise to hide.
                  const oScans = (o.scans || []).filter((s: any) => s.peng_num)
                    .sort((a: any, b: any) => { const order: Record<string,number> = {M:0, F:1, BC:2, LC:3, SC:4}; const ka = (a.sex||'').toUpperCase(); const kb = (b.sex||'').toUpperCase(); const ca = a.chick_size_code || ''; const cb = b.chick_size_code || ''; return (order[ka] ?? order[ca] ?? 5) - (order[kb] ?? order[cb] ?? 5); });
                  const scanCounts: Record<string, number> = {};
                  for (const s of oScans) scanCounts[s.peng_num] = (scanCounts[s.peng_num] || 0) + 1;
                  const hasDupScan = Object.values(scanCounts).some((n: number) => n > 1);
                  const oDs = displayStatus(o.breeding_status || '', o.eggs || 0, o.chicks || 0);
                  const isDup = obs.length > 1;
                  return (
                  <div key={o.observation_id || oi}>
                    <div className="day-row" onClick={() => setExpandedBox(expandedBox === `${box}-${oi}` ? null : `${box}-${oi}`)} style={{cursor:'pointer', borderLeft: isDup ? '3px solid #F44336' : undefined}}>
                      {oi === 0 && <a className="day-box-link" href={`/box/${box}`} onClick={e => { e.stopPropagation(); navClick(e, () => onBoxClick(box)); }}><b>Box {box}</b></a>}
                      {oi > 0 && <span className="day-box-link" style={{opacity:0.4}}>Box {box}</span>}
                      {(o.adults || 0) > 0 && <span>{'\uD83D\uDC27'.repeat(Math.min(o.adults, 4))}</span>}
                      {(o.eggs || 0) > 0 && <span>{'\uD83E\uDD5A'.repeat(Math.min(o.eggs, 4))}</span>}
                      {(o.chicks || 0) > 0 && <span>{'\uD83D\uDC23'.repeat(Math.min(o.chicks, 4))}</span>}
                      {oDs && oDs !== 'NO' && <span className={`badge ${DARK_TEXT_STATUSES.has(oDs)?'bordered':''}`} style={{background:STATUS_COLORS[oDs]||'#ccc',color:DARK_TEXT_STATUSES.has(oDs)?'#333':'#fff',fontSize:10,padding:'1px 5px'}}>{oDs}</span>}
                      {oScans.map((s: any, si: number) => (
                        <span key={s.scan_id || `${s.peng_num}-${si}`}
                          style={scanCounts[s.peng_num] > 1 ? {outline:'2px solid #F44336', borderRadius:3} : undefined}
                          title={scanCounts[s.peng_num] > 1 ? `Duplicate scan: #${s.peng_num} recorded ${scanCounts[s.peng_num]}× in this observation` : undefined}>
                          <PenguinMini scan={s} onClick={() => handleBirdClick(s.peng_num)} observationDate={date} />
                        </span>
                      ))}
                      {o.no_scan && <span className="scan no-scan">no scan</span>}
                      {oi === 0 && chips.map((c: any) => <span key={c.pit_id} style={{fontSize:10}}><PenguinMini scan={c} onClick={() => handleBirdClick(c.peng_num)} observationDate={date} /> chipped</span>)}
                      {o.gate_status && <span className="muted">{o.gate_status}</span>}
                      {isDup && <span style={{color:'#F44336', fontSize:10, fontWeight:600}}>⚠ dup</span>}
                      {hasDupScan && <span style={{color:'#F44336', fontSize:10, fontWeight:600}}>⚠ dup scan</span>}
                      {o.notes && <span className="day-note">{o.notes}</span>}
                    </div>
                    {expandedBox === `${box}-${oi}` && (
                      <ObsCard obs={o} onBirdClick={handleBirdClick} onDayClick={onDayClick} token={token} canEdit={canEdit} allPenguins={allPenguins} hideDate />
                    )}
                  </div>
                  );
                })}
              </div>
              );
            });

            return (<>
              {rows}
              {hiddenByChange > 0 && (
                <div className="day-hidden-note">{hiddenByChange} box{hiddenByChange === 1 ? '' : 'es'} hidden by change filter</div>
              )}
            </>);
          })()}
          </div>
        </div>
      )}

      {totalObs === 0 && totalChips === 0 && (
        <p className="muted">No activity recorded on this date.</p>
      )}

      {sideBird && sideBirdData?.penguin && (<>
        <div className="day-bird-backdrop" onClick={() => setSideBird(null)} />
        <div className="day-bird-panel">
          <BirdPage data={sideBirdData} onBirdClick={handleBirdClick}
            onBoxClick={(box: string) => onBoxClick(box)}
            onSightingClick={(box: string) => onBoxClick(box)}
            onDayClick={onDayClick}
            token={token} canEdit={canEdit} />
        </div>
      </>)}
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
    fetch('/api/crud.php?action=me', { headers: { 'Authorization': `Bearer ${authToken}` } })
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

  return <AuthenticatedAppWithTooltip token={authToken} userName={userName || ''} userRole={userRole} onLogout={handleLogout} />;
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
      const r = await fetch('/api/crud.php?action=change_password', {
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
      {expanded && observations.map((o: any, i: number) => <ObsCard key={o.observation_id || `${label}${i}`} obs={o} onBirdClick={onBirdClick} onDayClick={onDayClick} highlight={highlightObs !== null && o.observation_time_utc === highlightObs} scrollTo={scrollToObs !== null && o.observation_time_utc === scrollToObs} token={token} canEdit={canEdit} allPenguins={allPenguins} onDataChange={onDataChange} />)}
    </div>
  );
}

function ChangeDateGroup({ date, entries }: { date: string; entries: any[] }) {
  const [expanded, setExpanded] = useState(false);
  const dateLabel = new Date(date + 'T00:00:00').toLocaleDateString('en-NZ', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  return <div style={{marginBottom:4}}>
    <div className="clickable" style={{padding:'6px 10px', background:'#f5f5f5', borderRadius:6, fontWeight:600, fontSize:13, display:'flex', justifyContent:'space-between'}} onClick={() => setExpanded(!expanded)}>
      <span>{expanded ? '▾' : '▸'} {dateLabel}</span>
      <span className="muted">{entries.length} changes</span>
    </div>
    {expanded && <div style={{maxHeight:300, overflowY:'auto'}}>
      {entries.map((e: any, i: number) => {
        const fields = typeof e.changed_fields === 'string' ? (() => { try { return JSON.parse(e.changed_fields); } catch { return null; } })() : e.changed_fields;
        return (
          <div key={i} className="obs-card" style={{marginBottom:2, padding:'4px 10px', marginLeft:8}}>
            <div style={{display:'flex', gap:8, alignItems:'center', flexWrap:'wrap', fontSize:12}}>
              <span style={{background: e.action === 'DELETE' ? '#F44336' : e.action === 'INSERT' ? '#4CAF50' : '#2196F3', color:'#fff', fontSize:10, padding:'1px 6px', borderRadius:3}}>{e.action}</span>
              <span>{e.table_name}{e.box_name ? ` · Box ${e.box_name}` : ''} #{e.record_id}</span>
              <span className="muted">{e.observer_name || ''}</span>
              {e.change_reason && <span style={{fontStyle:'italic', color:'#666'}}>"{e.change_reason}"</span>}
            </div>
            {e.action === 'UPDATE' && fields && (
              <div style={{fontSize:11, marginTop:2}}>
                {Object.entries(fields).map(([k, v]: [string, any]) => (
                  <span key={k} className="muted" style={{marginRight:8}}>{k}: {v && typeof v === 'object' && 'old' in v ? <><s>{String(v.old ?? '')}</s> → {String(v.new ?? '')}</> : String(v ?? '')}</span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>}
  </div>;
}

function AdminPanel({ token, observationDates }: { token: string; observationDates?: string[] }) {
  const [users, setUsers] = useState<any[]>([]);
  const [syncResult, setSyncResult] = useState<any>(null);
  const [syncing, setSyncing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [diskTest, setDiskTest] = useState<any>(null);
  const [diskTesting, setDiskTesting] = useState(false);
  const [serverDisk, setServerDisk] = useState<any>(null);
  const [datePreview, setDatePreview] = useState<any>(null);
  const [recentChanges, setRecentChanges] = useState<any[]|null>(null);
  const [changesLoading, setChangesLoading] = useState(false);
  const [exporting, setExporting] = useState(false);

  const loadRecentChanges = async () => {
    setChangesLoading(true);
    const r = await fetch('/api/admin.php?action=recent_changes&days=7', { headers: { 'Authorization': `Bearer ${token}` } });
    setRecentChanges(await r.json());
    setChangesLoading(false);
  };

  const previewDate = async (date: string) => {
    setDatePreview({ loading: true, date });
    const r = await fetch(`/api/admin.php?action=preview_date&date=${date}`, { headers: { 'Authorization': `Bearer ${token}` } });
    const d = await r.json();
    if (d.error) { setDatePreview(null); alert(d.error); return; }
    setDatePreview(d);
  };

  useEffect(() => {
    fetch('/api/admin.php?action=users', { headers: { 'Authorization': `Bearer ${token}` } })
      .then(r => r.json()).then(d => { setUsers(Array.isArray(d) ? d : []); setLoading(false); })
      .catch(() => setLoading(false));
    fetch(`/api/server_stats.php?_=${Date.now()}`, { headers: { 'Authorization': `Bearer ${token}` } })
      .then(r => r.json()).then(d => setServerDisk(d)).catch(() => {});
  }, [token]);

  const updateUser = async (id: number, field: string, value: string) => {
    await fetch('/api/admin.php?action=update_user', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ observer_id: id, [field]: value })
    });
    setUsers(users.map(u => u.observer_id === id ? { ...u, [field]: value } : u));
  };



  return (
    <div className="admin-panel">
      <div className="admin-header">
        <h2>Admin</h2>
      </div>

      <div className="admin-section">
        <h3>Export</h3>
        <button className="action-btn" disabled={exporting} onClick={async () => {
          setExporting(true);
          try {
            const r = await fetch(`/api/admin.php?action=export_nestcheck_zip&token=${token}`);
            const blob = await r.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `nestcheck-export-${new Date().toISOString().slice(0,10)}.zip`;
            a.click();
            URL.revokeObjectURL(url);
          } catch (e: any) { alert('Export failed: ' + e.message); }
          setExporting(false);
        }}>{exporting ? 'Exporting...' : 'Export all days as Nestcheck ZIP'}</button>
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
        <h3>Last 7 days DB changes</h3>
        <button className="edit-btn" onClick={loadRecentChanges} disabled={changesLoading}>
          {changesLoading ? 'Loading...' : recentChanges ? 'Refresh' : 'Load'}
        </button>
        {recentChanges && (() => {
          const byDate = new Map<string, any[]>();
          for (const e of recentChanges) {
            const d = e.nz_date || 'Unknown';
            if (!byDate.has(d)) byDate.set(d, []);
            byDate.get(d)!.push(e);
          }
          return <div style={{marginTop:8}}>
            {Array.from(byDate.entries()).map(([date, entries]) => (
              <ChangeDateGroup key={date} date={date} entries={entries} />
            ))}
          </div>;
        })()}
      </div>

      <div className="admin-section">
        <h3>Delete Observations by Date</h3>
        <p className="muted">Preview and delete all observations from a specific date, then re-sync from server</p>
        <DateSearch dates={observationDates || []} onDayClick={previewDate} />
        {datePreview?.loading && <p className="muted" style={{marginTop:8}}>Loading {formatDate(datePreview.date)}...</p>}
        {datePreview && !datePreview.loading && (
          <div className="obs-card" style={{marginTop:8}}>
            <div style={{fontWeight:600, marginBottom:6}}>{formatDate(datePreview.date)}: {datePreview.totals.boxes} observations</div>
            <div className="muted" style={{marginBottom:6}}>
              {'🐧'.repeat(datePreview.totals.adults)} {'🥚'.repeat(datePreview.totals.eggs)} {'🐣'.repeat(datePreview.totals.chicks)}
              {datePreview.totals.without_breeding > 0 && <span style={{color:'#F44336'}}> · ⚠️ {datePreview.totals.without_breeding} missing breeding status</span>}
            </div>
            <div style={{maxHeight:200, overflowY:'auto', fontSize:12}}>
              {datePreview.observations.map((o: any) => (
                <div key={o.observation_id} style={{padding:'2px 0', borderBottom:'1px solid #f0f0f0'}}>
                  Box {o.box_name}: {'🐧'.repeat(o.adults)}{'🥚'.repeat(o.eggs)}{'🐣'.repeat(o.chicks)} {o.breeding_status || <span style={{color:'#F44336'}}>no status</span>} <span className="muted">{o.monitor_filename}</span>
                </div>
              ))}
            </div>
            <div style={{display:'flex', gap:6, marginTop:8}}>
              <button className="edit-btn" style={{background:'#F44336', color:'#fff'}} onClick={() => {
                const reason = prompt(`Delete all ${datePreview.totals.boxes} observations from ${formatDate(datePreview.date)}?\n\nReason (optional):`);
                if (reason === null) return;
                fetch('/api/admin.php?action=delete_date', {
                  method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                  body: JSON.stringify({ date: datePreview.date, _reason: reason })
                }).then(r => r.json()).then(d => {
                  if (d.success) { setDatePreview(null); alert(`Deleted ${d.deleted} observations. Run Sync to re-import.`); }
                  else alert(d.error || 'Failed');
                });
              }}>Delete {datePreview.totals.boxes} observations</button>
              <button className="edit-btn" onClick={() => setDatePreview(null)}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      <div className="admin-section">
        <h3>Sync Monitors (TCP Server)</h3>
        <p className="muted">Pull from TCP server (210.54.37.120). Query first, then import individual monitors.</p>
        <div>
          <button className="edit-btn" onClick={async () => {
            setSyncing(true); setSyncResult(null);
            try {
              const r = await fetch('/api/admin.php?action=query_server', { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
              setSyncResult(await r.json());
            } catch (e: any) { setSyncResult({ error: e.message }); }
            setSyncing(false);
          }} disabled={syncing}>
            {syncing ? 'Querying...' : 'Query Server'}
          </button>
        </div>
        {syncResult && (
          <div style={{marginTop:8}}>
            {syncResult.error ? (
              <div style={{color:'#F44336'}}>{syncResult.error}</div>
            ) : (
              <>
                <div className="muted" style={{marginBottom:6}}>{syncResult.monitors?.filter((m: any) => m.status !== 'deleted').length || 0} monitors on server</div>
                {(syncResult.monitors || []).filter((m: any) => m.status !== 'deleted').map((m: any, i: number) => (
                  <div key={i} className="obs-card" style={{marginBottom:4, opacity: m.status === 'exists' ? 0.6 : 1}}>
                    <div className="obs-top" style={{flexWrap:'wrap', gap:4}}>
                      <b>{m.filename}</b>
                      <span className="badge" style={{
                        background: m.status === 'deleted' ? '#F44336' : m.status === 'imported' ? '#4CAF50' : m.status === 'new' ? '#FF9800' : '#E0E0E0',
                        color: m.status === 'exists' || m.status === 'empty' ? '#333' : '#fff'
                      }}>{m.status === 'new' ? `${m.new} new` : m.status}</span>
                      {m.status === 'new' && (
                        <button className="edit-btn done-btn" style={{padding:'1px 8px', fontSize:11}} onClick={async () => {
                          const r = await fetch('/api/admin.php?action=import_monitor', {
                            method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                            body: JSON.stringify({ index: m.index })
                          });
                          const d = await r.json();
                          if (d.success) {
                            setSyncResult((prev: any) => ({...prev, monitors: prev.monitors.map((mon: any) => mon.index === m.index ? {...mon, status: 'imported', new: d.imported} : mon)}));
                          } else { alert(d.error || 'Import failed'); }
                        }}>Import</button>
                      )}
                    </div>
                    <div className="obs-nums" style={{fontSize:11}}>
                      <span>{m.date ? formatDate(m.date) : ''}</span>
                      <span>{m.boxes} boxes ({m.new || 0} new, {m.exists || 0} exist)</span>
                      {m.scans > 0 && <span>{m.scans} scanned</span>}
                      {m.adults > 0 && <span>🐧{m.adults}</span>}
                      {m.eggs > 0 && <span>🥚{m.eggs}</span>}
                      {m.chicks > 0 && <span>🐣{m.chicks}</span>}
                    </div>
                    {m.breeding_statuses && Object.keys(m.breeding_statuses).length > 0 && (
                      <div className="muted" style={{fontSize:10}}>{Object.entries(m.breeding_statuses).map(([k, v]) => `${k}:${v}`).join(' · ')}</div>
                    )}
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </div>

      <RegionsAndColonies token={token} />

      <ColonyAccess token={token} />

      <div className="admin-section">
        <h3>Data Security</h3>
        <RemovePenguin token={token} />
        <DuplicateObservations token={token} />
        <DuplicateScans token={token} />
        <SameGenderConflicts token={token} />
      </div>

      <Suspense fallback={<div className="admin-section"><p className="muted">Loading chart...</p></div>}>
        <DiskHistoryChart token={token} />
      </Suspense>

      <div className="admin-section">
        <h3>Disk Write Test</h3>
        {serverDisk && <p className="muted">Account: {serverDisk.files_mb} MB files + {serverDisk.db_mb} MB DB = {serverDisk.used_mb} MB / {serverDisk.quota_mb} MB ({serverDisk.pct}%) · {serverDisk.observations} observations · {serverDisk.penguins} penguins</p>}
        <div style={{display:'flex', gap:6, flexWrap:'wrap'}}>
          {[1, 10, 100, 1000, 5000].map(mb => (
            <button key={mb} className="edit-btn" disabled={diskTesting} onClick={() => {
              setDiskTesting(true);
              setDiskTest({ status: 'starting', target_mb: mb });
              let completed = false;
              const es = new EventSource(`/api/disk_check.php?mb=${mb}&token=${token}`);
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

function ColonyAccess({ token }: { token: string }) {
  const [colonies, setColonies] = useState<any[]|null>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [perms, setPerms] = useState<any[]>([]); // {colony_id, observer_id, role}
  const [colonyId, setColonyId] = useState<number|null>(null);
  const [loading, setLoading] = useState(false);
  const auth = { Authorization: `Bearer ${token}` };

  const load = async () => {
    setLoading(true);
    const [cr, ur, pr] = await Promise.all([
      fetch('/api/admin.php?action=colonies', { headers: auth }).then(r => r.json()),
      fetch('/api/admin.php?action=users', { headers: auth }).then(r => r.json()),
      fetch('/api/admin.php?action=colony_permissions', { headers: auth }).then(r => r.json()),
    ]);
    const cols = Array.isArray(cr) ? cr : [];
    setColonies(cols);
    setUsers(Array.isArray(ur) ? ur : []);
    setPerms(Array.isArray(pr) ? pr : []);
    if (cols.length && colonyId == null) setColonyId(Number(cols[0].colony_id));
    setLoading(false);
  };

  const roleFor = (observerId: number): string =>
    perms.find(p => Number(p.colony_id) === colonyId && Number(p.observer_id) === observerId)?.role || '';

  const setAccess = async (observerId: number, role: string) => {
    await fetch('/api/admin.php?action=save_colony_permission', {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ colony_id: colonyId, observer_id: observerId, role }),
    });
    setPerms(prev => {
      const rest = prev.filter(p => !(Number(p.colony_id) === colonyId && Number(p.observer_id) === observerId));
      return role ? [...rest, { colony_id: colonyId, observer_id: observerId, role }] : rest;
    });
  };

  return (
    <div className="admin-section">
      <h3>Colony access</h3>
      {!colonies && <button className="edit-btn" onClick={load} disabled={loading}>{loading ? 'Loading...' : 'Load'}</button>}
      {colonies && colonies.length === 0 && <p className="muted">No colonies.</p>}
      {colonies && colonies.length > 0 && (<>
        <p className="muted" style={{fontSize:12, marginBottom:8}}>Admins have full access to every colony automatically. Grant other users view/edit per colony here.</p>
        <label style={{fontSize:13}}>Colony:{' '}
          <select value={colonyId ?? ''} onChange={e => setColonyId(Number(e.target.value))}>
            {colonies.map((c:any) => <option key={c.colony_id} value={c.colony_id}>{c.colony_name}{c.region_name ? ` — ${c.region_name}` : ''}</option>)}
          </select>
        </label>
        <table className="bird-table" style={{width:'100%', marginTop:8}}>
          <thead><tr><th>User</th><th>Global role</th><th>Access to this colony</th></tr></thead>
          <tbody>
            {users.map((u:any) => (
              <tr key={u.observer_id}>
                <td>{u.observer_name}</td>
                <td className="muted">{u.role || 'viewer'}</td>
                <td>
                  {u.role === 'admin'
                    ? <span className="muted">all colonies (admin)</span>
                    : <select value={roleFor(Number(u.observer_id))} onChange={e => setAccess(Number(u.observer_id), e.target.value)}>
                        <option value="">No access</option>
                        <option value="view">View</option>
                        <option value="edit">Edit</option>
                      </select>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </>)}
    </div>
  );
}

function RegionsAndColonies({ token }: { token: string }) {
  const [regions, setRegions] = useState<any[]|null>(null);
  const [colonies, setColonies] = useState<any[]|null>(null);
  const [loading, setLoading] = useState(false);
  const [editRegion, setEditRegion] = useState<any|null>(null);
  const [editColony, setEditColony] = useState<any|null>(null);

  const load = async () => {
    setLoading(true);
    const [rr, cr] = await Promise.all([
      fetch('/api/admin.php?action=regions', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
      fetch('/api/admin.php?action=colonies', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json()),
    ]);
    setRegions(Array.isArray(rr) ? rr : []);
    setColonies(Array.isArray(cr) ? cr : []);
    setLoading(false);
  };

  const saveRegion = async (data: any) => {
    await fetch('/api/admin.php?action=save_region', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    setEditRegion(null);
    load();
  };

  const saveColony = async (data: any) => {
    await fetch('/api/admin.php?action=save_colony', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    setEditColony(null);
    load();
  };

  return (
    <div className="admin-section">
      <h3>Regions & Colonies</h3>
      {!regions && <button className="edit-btn" onClick={load} disabled={loading}>{loading ? 'Loading...' : 'Load'}</button>}

      {regions && (<>
        <h4 style={{color:'#1a5276', margin:'12px 0 6px'}}>Regions</h4>
        <table style={{fontSize:12, borderCollapse:'collapse', width:'100%', marginBottom:8}}>
          <thead><tr style={{borderBottom:'1px solid #ddd'}}><th style={{textAlign:'left'}}>Region</th><th>Colonies</th><th></th></tr></thead>
          <tbody>
            {regions.map((r: any) => (
              <tr key={r.region_id} style={{borderBottom:'1px solid #eee'}}>
                <td style={{padding:'4px 8px'}}>{r.region_name}</td>
                <td style={{padding:'4px 8px', textAlign:'center'}}>{r.colony_count}</td>
                <td><button className="edit-btn" onClick={() => setEditRegion({region_id: r.region_id, region_name: r.region_name})}>Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="edit-btn" onClick={() => setEditRegion({region_name: ''})}>+ Add region</button>

        {editRegion && (
          <div className="obs-card" style={{marginTop:8}}>
            <input type="text" defaultValue={editRegion.region_name} placeholder="Region name"
              style={{padding:'4px 8px', fontSize:13, border:'1px solid #ccc', borderRadius:4, width:'100%', marginBottom:6}}
              onChange={e => editRegion.region_name = e.target.value} />
            <div style={{display:'flex', gap:6}}>
              <button className="edit-btn" onClick={() => saveRegion(editRegion)}>Save</button>
              <button className="edit-btn" onClick={() => setEditRegion(null)}>Cancel</button>
            </div>
          </div>
        )}

        <h4 style={{color:'#1a5276', margin:'16px 0 6px'}}>Colonies</h4>
        <table style={{fontSize:12, borderCollapse:'collapse', width:'100%', marginBottom:8}}>
          <thead><tr style={{borderBottom:'1px solid #ddd'}}><th style={{textAlign:'left'}}>Colony</th><th style={{textAlign:'left'}}>Region</th><th style={{textAlign:'left'}}>Box sets</th><th></th></tr></thead>
          <tbody>
            {colonies!.map((c: any) => (
              <tr key={c.colony_id} style={{borderBottom:'1px solid #eee'}}>
                <td style={{padding:'4px 8px'}}>{c.colony_name}</td>
                <td style={{padding:'4px 8px'}} className="muted">{c.region_name}</td>
                <td style={{padding:'4px 8px', fontFamily:'monospace', fontSize:11}}>{c.location_sets_string}</td>
                <td><button className="edit-btn" onClick={() => setEditColony({colony_id: c.colony_id, colony_name: c.colony_name, region_id: c.region_id, location_sets_string: c.location_sets_string || ''})}>Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="edit-btn" onClick={() => setEditColony({colony_name: '', region_id: regions[0]?.region_id || 0, location_sets_string: ''})}>+ Add colony</button>

        {editColony && (
          <div className="obs-card" style={{marginTop:8}}>
            <input type="text" defaultValue={editColony.colony_name} placeholder="Colony name"
              style={{padding:'4px 8px', fontSize:13, border:'1px solid #ccc', borderRadius:4, width:'100%', marginBottom:6}}
              onChange={e => editColony.colony_name = e.target.value} />
            <select defaultValue={editColony.region_id} style={{padding:'4px 8px', fontSize:13, marginBottom:6, width:'100%'}}
              onChange={e => editColony.region_id = parseInt(e.target.value)}>
              {regions.map((r: any) => <option key={r.region_id} value={r.region_id}>{r.region_name}</option>)}
            </select>
            <input type="text" defaultValue={editColony.location_sets_string} placeholder="Box sets e.g. {1-150,AA-AC}"
              style={{padding:'4px 8px', fontSize:13, border:'1px solid #ccc', borderRadius:4, width:'100%', marginBottom:6, fontFamily:'monospace'}}
              onChange={e => editColony.location_sets_string = e.target.value} />
            <div style={{display:'flex', gap:6}}>
              <button className="edit-btn" onClick={() => saveColony(editColony)}>Save</button>
              <button className="edit-btn" onClick={() => setEditColony(null)}>Cancel</button>
            </div>
          </div>
        )}
      </>)}
    </div>
  );
}

function RemovePenguin({ token }: { token: string }) {
  const [pengNum, setPengNum] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string|null>(null);

  const search = async () => {
    const num = pengNum.trim().replace('#', '');
    if (!num) return;
    setLoading(true); setPreview(null); setResult(null);
    const r = await fetch(`/api/admin.php?action=preview_penguin_delete&peng_num=${num}`, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    if (d.error) { setResult(`Error: ${d.error}`); }
    else { setPreview(d); }
    setLoading(false);
  };

  const deletePenguin = async () => {
    if (!preview) return;
    const num = preview.penguin.peng_num;
    if (!confirm(`Permanently delete penguin #${num}?\n\nThis will remove:\n- ${preview.chips.length} chip record(s)\n- ${preview.scan_count} scan(s) from observations\n- All biometric data\n\nThis cannot be undone.`)) return;
    setLoading(true);
    const r = await fetch('/api/admin.php?action=delete_penguin', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ peng_num: num }),
    });
    const d = await r.json();
    if (d.success) {
      setResult(`Penguin #${num} deleted. ${d.scans_deleted} scans removed, ${d.chips_deleted} chips removed.`);
      setPreview(null); setPengNum('');
    } else {
      setResult(`Error: ${d.error}`);
    }
    setLoading(false);
  };

  return (
    <div style={{marginTop:16, padding:12, border:'1px solid #e8ecef', borderRadius:8}}>
      <h3 style={{margin:'0 0 8px'}}>Remove Penguin</h3>
      <div style={{display:'flex', gap:8, alignItems:'center', marginBottom:8}}>
        <input type="text" value={pengNum} onChange={e => setPengNum(e.target.value)} placeholder="Penguin #"
          onKeyDown={e => e.key === 'Enter' && search()}
          style={{padding:'4px 8px', fontSize:13, border:'1px solid #ccc', borderRadius:4, width:100}} />
        <button className="edit-btn" onClick={search} disabled={loading}>{loading ? '...' : 'Search'}</button>
      </div>

      {preview && (
        <div className="obs-card" style={{marginBottom:8}}>
          <table style={{fontSize:12, borderCollapse:'collapse', width:'100%'}}>
            <tbody>
              <tr><td style={{padding:'2px 8px', color:'#666'}}>Peng #</td><td style={{padding:'2px 8px', fontWeight:600}}>{preview.penguin.peng_num}</td></tr>
              <tr><td style={{padding:'2px 8px', color:'#666'}}>Sex</td><td style={{padding:'2px 8px'}}>{preview.penguin.sex || '—'}</td></tr>
              <tr><td style={{padding:'2px 8px', color:'#666'}}>Life stage</td><td style={{padding:'2px 8px'}}>{preview.penguin.life_stage || '—'}</td></tr>
              <tr><td style={{padding:'2px 8px', color:'#666'}}>Chipped as</td><td style={{padding:'2px 8px'}}>{preview.penguin.chipped_as_adult ? 'Adult' : 'Chick'}</td></tr>
            </tbody>
          </table>

          <h4 style={{margin:'8px 0 4px', fontSize:13}}>Chips ({preview.chips.length})</h4>
          {preview.chips.map((c: any, i: number) => (
            <div key={i} style={{fontSize:12, padding:'2px 8px', fontFamily:'monospace'}}>{c.pit_id} {c.is_active ? '(active)' : '(inactive)'} — chipped {c.chip_date || '?'}</div>
          ))}

          <h4 style={{margin:'8px 0 4px', fontSize:13}}>Scans ({preview.scan_count})</h4>
          {preview.scans.length === 0 ? <p className="muted" style={{fontSize:12, margin:0}}>No scans</p> : (
            <table style={{fontSize:11, borderCollapse:'collapse', width:'100%'}}>
              <thead><tr style={{borderBottom:'1px solid #ddd'}}><th style={{textAlign:'left'}}>Date</th><th style={{textAlign:'left'}}>Box</th></tr></thead>
              <tbody>{preview.scans.slice(0, 20).map((s: any, i: number) => (
                <tr key={i} style={{borderBottom:'1px solid #eee'}}>
                  <td style={{padding:'2px 8px'}}>{s.observation_time_utc?.substring(0, 10)}</td>
                  <td style={{padding:'2px 8px'}}><a className="clickable" href={`/box/${s.box_name}`}>Box {s.box_name}</a></td>
                </tr>
              ))}</tbody>
            </table>
          )}
          {preview.scans.length > 20 && <p className="muted" style={{fontSize:11}}>...and {preview.scans.length - 20} more</p>}

          {preview.biometrics.length > 0 && (
            <>
              <h4 style={{margin:'8px 0 4px', fontSize:13}}>Biometrics ({preview.biometrics.length})</h4>
              <p className="muted" style={{fontSize:11, margin:0}}>Will be soft-deleted</p>
            </>
          )}

          <button onClick={deletePenguin} disabled={loading}
            style={{marginTop:12, background:'#F44336', color:'#fff', border:'none', padding:'8px 20px', borderRadius:4, cursor:'pointer', fontWeight:600}}>
            Delete penguin #{preview.penguin.peng_num}
          </button>
        </div>
      )}

      {result && <p style={{color: result.startsWith('Error') ? '#F44336' : '#4CAF50', marginTop:8, fontSize:13}}>{result}</p>}
    </div>
  );
}

function DuplicateObservations({ token }: { token: string }) {
  const [duplicates, setDuplicates] = useState<any[]|null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<any>(null);

  const check = async () => {
    setLoading(true); setResult(null);
    const r = await fetch('/api/admin.php?action=duplicate_observations', { headers: { 'Authorization': `Bearer ${token}` } });
    const d = await r.json();
    setDuplicates(Array.isArray(d) ? d : []);
    setLoading(false);
  };

  const cleanup = async () => {
    if (!confirm(`Soft-delete duplicate observations from ${duplicates?.length} box/day groups? Keeps the most recent.`)) return;
    setLoading(true);
    const r = await fetch('/api/admin.php?action=cleanup_duplicate_observations', { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } });
    const d = await r.json();
    setResult(d);
    setDuplicates(null);
    setLoading(false);
  };

  return (
    <div style={{marginTop:16, padding:12, border:'1px solid #e8ecef', borderRadius:8}}>
      <h3 style={{margin:'0 0 8px'}}>Duplicate Observations</h3>
      <p className="muted" style={{margin:'0 0 8px'}}>Multiple non-deleted observations for the same box on the same day</p>
      <button onClick={check} disabled={loading} style={{marginRight:8}}>{loading ? 'Checking...' : 'Check'}</button>
      {duplicates && duplicates.length === 0 && <span style={{color:'#4CAF50'}}>No duplicates found</span>}
      {duplicates && duplicates.length > 0 && (<>
        <p style={{color:'#F44336', fontWeight:600}}>{duplicates.length} box/day groups with multiple observations:</p>
        <table style={{fontSize:12, borderCollapse:'collapse', width:'100%'}}>
          <thead><tr style={{borderBottom:'1px solid #ddd'}}><th>Date</th><th>Box</th><th>Count</th><th>By</th></tr></thead>
          <tbody>{duplicates.map((d: any, i: number) => (
            <tr key={i} style={{borderBottom:'1px solid #eee'}}>
              <td><a className="clickable" href={`/day/${d.obs_date}`}>{d.obs_date}</a></td>
              <td><a className="clickable" href={`/box/${d.box_name}`}>Box {d.box_name}</a></td>
              <td style={{color:'#F44336'}}>{d.cnt}x</td>
              <td className="muted">{d.observers}</td>
            </tr>
          ))}</tbody>
        </table>
        <button onClick={cleanup} disabled={loading} style={{marginTop:8, background:'#F44336', color:'#fff', border:'none', padding:'6px 16px', borderRadius:4, cursor:'pointer'}}>
          Keep most recent, soft-delete rest
        </button>
      </>)}
      {result && <p style={{color:'#4CAF50', marginTop:8}}>Soft-deleted {result.observations_deleted} duplicate observations from {result.duplicate_groups} groups</p>}
    </div>
  );
}

function DuplicateScans({ token }: { token: string }) {
  const [duplicates, setDuplicates] = useState<any[]|null>(null);
  const [loading, setLoading] = useState(false);

  const check = async () => {
    setLoading(true);
    const r = await fetch('/api/admin.php?action=duplicate_scans', { headers: { 'Authorization': `Bearer ${token}` } });
    const d = await r.json();
    setDuplicates(Array.isArray(d) ? d : []);
    setLoading(false);
  };

  return (
    <div style={{marginTop:16, padding:12, border:'1px solid #e8ecef', borderRadius:8}}>
      <h3 style={{margin:'0 0 8px'}}>Duplicate Scans</h3>
      <button onClick={check} disabled={loading} style={{marginRight:8}}>{loading ? 'Checking...' : 'Check for duplicates'}</button>
      {duplicates && duplicates.length === 0 && <span style={{color:'#4CAF50'}}>No duplicates found</span>}
      {duplicates && duplicates.length > 0 && (<>
        <p style={{color:'#F44336', fontWeight:600}}>{duplicates.length} duplicate groups found:</p>
        <table style={{fontSize:12, borderCollapse:'collapse', width:'100%'}}>
          <thead><tr style={{borderBottom:'1px solid #ddd'}}><th>Date</th><th>Box</th><th>Penguin</th><th>Count</th><th>Type</th></tr></thead>
          <tbody>{duplicates.map((d: any, i: number) => (
            <tr key={i} style={{borderBottom:'1px solid #eee'}}>
              <td><a className="clickable" href={`/day/${d.obs_date}`}>{d.obs_date}</a></td>
              <td><a className="clickable" href={`/box/${d.box_name}`}>Box {d.box_name}</a></td>
              <td>#{d.peng_num}</td>
              <td style={{color:'#F44336'}}>{d.cnt}x</td>
              <td className="muted">{d.dup_type === 'peng_num' ? 'multi-chip' : 'exact'}</td>
            </tr>
          ))}</tbody>
        </table>
        <p className="muted" style={{marginTop:8}}>Duplicate scans are kept on purpose — they flag data-entry errors. Review each from the box card for that date; they are also marked “⚠ dup scan” in the day view.</p>
      </>)}
    </div>
  );
}

function SameGenderConflicts({ token }: { token: string }) {
  const [conflicts, setConflicts] = useState<any[]|null>(null);
  const [loading, setLoading] = useState(false);

  const check = async () => {
    setLoading(true);
    const r = await fetch('/api/admin.php?action=same_gender_conflicts', { headers: { 'Authorization': `Bearer ${token}` } });
    const d = await r.json();
    setConflicts(Array.isArray(d) ? d : []);
    setLoading(false);
  };

  return (
    <div style={{marginTop:16, padding:12, border:'1px solid #e8ecef', borderRadius:8}}>
      <h3 style={{margin:'0 0 8px'}}>Same-Gender Conflicts</h3>
      <p className="muted" style={{margin:'0 0 8px'}}>Multiple penguins of the same sex scanned at the same box on the same day</p>
      <button onClick={check} disabled={loading} style={{marginRight:8}}>{loading ? 'Checking...' : 'Check'}</button>
      {conflicts && conflicts.length === 0 && <span style={{color:'#4CAF50'}}>No conflicts found</span>}
      {conflicts && conflicts.length > 0 && (<>
        <p style={{color:'#F44336', fontWeight:600}}>{conflicts.length} same-gender conflicts found:</p>
        <table style={{fontSize:12, borderCollapse:'collapse', width:'100%'}}>
          <thead><tr style={{borderBottom:'1px solid #ddd'}}><th>Date</th><th>Box</th><th>Sex</th><th>Count</th><th>Penguins</th></tr></thead>
          <tbody>{conflicts.map((d: any, i: number) => (
            <tr key={i} style={{borderBottom:'1px solid #eee'}}>
              <td><a className="clickable" href={`/day/${d.obs_date}`}>{d.obs_date}</a></td>
              <td><a className="clickable" href={`/box/${d.box_name}`}>Box {d.box_name}</a></td>
              <td>{d.sex === 'M' ? 'Male' : d.sex === 'F' ? 'Female' : d.sex}</td>
              <td style={{color:'#F44336'}}>{d.cnt}x</td>
              <td>{d.peng_nums?.split(',').map((n: string) => (
                <a key={n} className="clickable" href={`/penguin/${n.trim()}`} style={{marginRight:6}}>#{n.trim()}</a>
              ))}</td>
            </tr>
          ))}</tbody>
        </table>
        <p className="muted" style={{marginTop:8}}>May indicate a sex assignment error or a genuine multi-bird visit.</p>
      </>)}
    </div>
  );
}

function AuthenticatedApp({ token, userName, userRole, onLogout }: { token: string; userName: string; userRole: string; onLogout: () => void }) {
  const [showChangePassword, setShowChangePassword] = useState(false);
  const initial = parseUrl();
  const [boxTags, setBoxTags] = useState<Record<string, BoxTag>>({});
  const [stats, setStats] = useState<any>(null);
  const [selectedBox, setSelectedBox] = useState<string|null>(initial.box || null);
  // boxDetail from useBoxDetail hook
  const [showDeleted, setShowDeleted] = useState(false);
  const [deletedObs, setDeletedObs] = useState<any[]>([]);
  // false/false no longer needed — hooks return data synchronously
  const [loading, setLoading] = useState(true);
  const [selectedBird, setSelectedBird] = useState<string|null>(initial.bird || null);
  // birdData from useBirdDetail hook
  const [highlightObs, setHighlightObs] = useState<string|null>(null);
  const [scrollToObs, setScrollToObs] = useState<string|null>(null);
  const allPenguins = useAllPenguins();
  const [penguinSearch, setPenguinSearch] = useState('');
  const [serverStats, setServerStats] = useState<any>(null);
  const [showEntry, setShowEntry] = useState(initial.enter || false);
  const [showAdmin, setShowAdmin] = useState(initial.admin || false);
  const [showReports, setShowReports] = useState(initial.reports || false);
  const [showSettings, setShowSettings] = useState(false);
  const [datePickerVisible, setDatePickerVisible] = useState(false);
  const [datePickerCenter, setDatePickerCenter] = useState('');
  const [selectedDay, setSelectedDay] = useState<string|null>(initial.day || null);
  const [scrollToBox, setScrollToBox] = useState<string|null>(null);
  const [previousBox, setPreviousBox] = useState<string|null>(null);
  // Data hooks — reactive, re-render automatically when localdb syncs
  const [loadProgress, setLoadProgress] = useState('');
  const [loadPct, setLoadPct] = useState<number|null>(null);

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

  // Date stats are precomputed in localdb on sync — just read the cache
  const dateStatsCache = useDateStats();

  const dateTip = useDateTooltip();
  const dateTipCtx = useMemo(() => ({ ...dateTip, statsCache: dateStatsCache }), [dateTip, dateStatsCache]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuClosing, setMenuClosing] = useState(false);
  const [menuSide, setMenuSide] = useState<'left'|'right'>(() => (localStorage.getItem('ww_menu_side') as 'left'|'right') || 'right');
  const closeMenu = useCallback(() => {
    setMenuClosing(true);
    setTimeout(() => { setMenuOpen(false); setMenuClosing(false); }, 300);
  }, []);

  const lastLoadRef = useRef(0);
  const loadColony = useCallback(async () => {
    // Paint immediately from the cached snapshot if we have one — the network sync
    // and overview fetches below then refresh in the background. Only a first-ever
    // visit (no cache) keeps the spinner up for the full download.
    try {
      if (await primeFromCache()) setLoading(false);
    } catch (e) {
      console.warn('primeFromCache failed; falling back to full sync', e);
    }
    // A sync failure (e.g. flaky mobile network on resume) must NOT block the
    // box-grid fetches below, or the grid renders empty ("Nest Boxes (0)").
    try {
      await syncDatabase((msg, pct) => { setLoadProgress(msg); setLoadPct(pct ?? null); });
    } catch (e) {
      console.warn('syncDatabase failed; continuing with cached/API data', e);
    }
    try {
      const [tags, ov, ss] = await Promise.all([fetchBoxTags(), fetchOverview(), fetchServerStats()]);
      setBoxTags(tags); setStats(ov); setServerStats(ss);
    } catch (e) {
      console.warn('overview/tags fetch failed', e);
    } finally {
      setLoading(false);
      lastLoadRef.current = Date.now();
    }
  }, []);

  useEffect(() => {
    loadColony();
    startPolling(() => { fetchOverview().then(ov => setStats(ov)).catch(() => {}); });

    // Re-sync when the app is reopened/refocused (mobile PWA resume) or network
    // returns — Britta's "doesn't refresh on opening" was the lack of this.
    const resume = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastLoadRef.current > 15000) loadColony();
    };
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('focus', resume);
    window.addEventListener('online', resume);
    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('focus', resume);
      window.removeEventListener('online', resume);
    };
  }, [loadColony]);

  // Expired/invalid session → bounce to login (automates the log-out/in fix).
  useEffect(() => {
    const onExpired = () => onLogout();
    window.addEventListener('ww-auth-expired', onExpired);
    return () => window.removeEventListener('ww-auth-expired', onExpired);
  }, [onLogout]);

  const boxDetail = useBoxDetail(loading ? null : selectedBox);

  // Auto-select bird when box changes
  useEffect(() => {
    if (!selectedBox || !boxDetail) { setHighlightObs(null); return; }
    if (window.innerWidth < 900) { setSelectedBird(null); return; }
    const observations = boxDetail.observations || [];
    const pairCounts = new Map<string, number>();
    for (const obs of observations) {
      if (obs.eggs > 0 || obs.chicks > 0) {
        const males = obs.scans.filter((s: any) => (s.sex || '').toUpperCase() === 'M');
        const females = obs.scans.filter((s: any) => (s.sex || '').toUpperCase() === 'F');
        for (const m of males) for (const f of females) {
          const key = `${m.peng_num}|${f.peng_num}`;
          pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
        }
      }
    }
    let bestPair = '', bestCount = 0;
    for (const [key, count] of pairCounts) if (count > bestCount) { bestCount = count; bestPair = key; }
    if (bestPair) { setSelectedBird(bestPair.split('|')[0]); }
    else {
      for (const obs of observations) if (obs.scans.length > 0) { setSelectedBird(obs.scans[0].peng_num || null); return; }
      setSelectedBird(boxDetail.all_penguins?.[0]?.peng_num || null);
    }
  }, [selectedBox]);

  const birdData = useBirdDetail(loading ? null : selectedBird);

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
    const ids = new Set([...Object.keys(boxTags || {}), ...Object.keys(stats?.box_info || {})]);
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

  if (loading) return <div className="center loading-screen">
    {loadPct === null && <div className="spinner"/>}
    <p>{loadProgress || 'Loading colony data...'}</p>
    {loadPct !== null && <div className="progress-bar"><div className="progress-fill" style={{width: `${Math.round(loadPct * 100)}%`}}/></div>}
    <p className="muted" style={{fontSize:14, position:'absolute', bottom:16, right:16}}>Photo: Marty Melville</p>
  </div>;

  // Wrap any return with tooltip provider + portal
  const wrap = (content: React.ReactNode) => (
    <DateTooltipCtx.Provider value={dateTipCtx}>
      {content}
      <DateTooltipPortal tip={dateTip.tip} statsCache={dateStatsCache} />
    </DateTooltipCtx.Provider>
  );

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
      <span className="header-desktop">
        {siteNav}
        {serverStats && <span className="header-stats">{fmtSize(serverStats.used_mb)} / {fmtSize(serverStats.quota_mb)} · server {serverStats.disk_free_gb} GB free</span>}
        <span className="header-user">
          {userName}
          <button className="logout-btn" onClick={() => setShowChangePassword(true)}>Password</button>
          <button className="logout-btn" onClick={onLogout}>Logout</button>
        </span>
      </span>
      <button className={`hamburger hamburger-${menuSide}`} onClick={() => setMenuOpen(o => !o)}>{'\u2630'}</button>
      {menuOpen && <>
        <div className={`mobile-backdrop${menuClosing ? ' closing' : ''}`} onClick={() => closeMenu()} />
        <div className={`mobile-panel mobile-panel-${menuSide}${menuClosing ? ' closing' : ''}`}>
          <nav className="mobile-nav">
            <a className={currentSection === 'colony' ? 'active' : ''} href="/" onClick={e => navClick(e, () => { goTo('colony'); closeMenu(); })}>Colony</a>
          </nav>
          <div className="mobile-search-group">
            <label className="mobile-label">Penguin</label>
            <PenguinSearch penguins={allPenguins} search={penguinSearch} onSearchChange={setPenguinSearch} onBirdClick={(num) => { openBird(num); closeMenu(); }} />
          </div>
          <div className="mobile-search-group">
            <label className="mobile-label">Box</label>
            <input className="mobile-input" type="text" placeholder="Box number" onKeyDown={e => { if (e.key === 'Enter') { const v = (e.target as HTMLInputElement).value.replace(/#/g, '').trim(); if (v) { setSelectedBird(null); setSelectedDay(null); setSelectedBox(v); (e.target as HTMLInputElement).value = ''; closeMenu(); } } }} />
          </div>
          <div className="mobile-search-group">
            <label className="mobile-label">Date</label>
            <DateSearch dates={stats?.observation_dates || []} onDayClick={(d) => { goToDay(d); closeMenu(); }} onFocusChange={(f, d) => { setDatePickerVisible(f); setDatePickerCenter(d); }} />
            {(() => {
              const dates = (stats?.observation_dates || []).slice(0, 20).reverse();
              if (!dates.length) return null;
              const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
              return (
                <div ref={el => { if (el) el.scrollLeft = el.scrollWidth; }} style={{display:'flex', gap:4, overflowX:'auto', marginTop:6, paddingBottom:2}}>
                  {dates.map((d: string) => {
                    const ds = dateStatsCache.get(d);
                    const fm = ds?.isFullMonitor;
                    const [,m,day] = d.split('-');
                    const label = `${parseInt(day)} ${months[parseInt(m) - 1]}`;
                    return (
                      <span key={d} className="scan clickable" onClick={() => { goToDay(d); closeMenu(); }}
                        style={{fontSize:10, whiteSpace:'nowrap', background: fm ? '#c8e6c9' : '#e3f2fd', color: fm ? '#2e7d32' : '#1a5276', borderColor: fm ? '#81c784' : '#90caf9', display:'inline-flex', flexDirection:'column', alignItems:'center', gap:1, padding:'2px 5px', lineHeight:1.3}}>
                        <span style={{fontWeight:600}}>{label}</span>
                        {ds && <span style={{fontSize:8, opacity:0.8}}>
                          {'\uD83D\uDCE6'}{ds.boxes}{ds.penguins ? ` \uD83D\uDC27${ds.penguins}` : ''}{ds.eggs ? ` \uD83E\uDD5A${ds.eggs}` : ''}{ds.chicks ? ` \uD83D\uDC23${ds.chicks}` : ''}
                        </span>}
                      </span>
                    );
                  })}
                </div>
              );
            })()}
          </div>
          <nav className="mobile-nav">
            <a className={currentSection === 'reports' ? 'active' : ''} href="/reports" onClick={e => navClick(e, () => { goTo('reports'); closeMenu(); })}>Reports</a>
            {userRole === 'admin' && <a className={currentSection === 'admin' ? 'active' : ''} href="/admin" onClick={e => navClick(e, () => { goTo('admin'); closeMenu(); })}>Admin</a>}
            {userRole !== 'viewer' && <a className="mobile-nav-link" href="/enter" onClick={e => navClick(e, () => { goTo('enter'); closeMenu(); })}>Enter data</a>}
          </nav>
          <div style={{marginTop:'auto'}}>
            {serverStats && <div className="mobile-stats">{fmtSize(serverStats.used_mb)} / {fmtSize(serverStats.quota_mb)} · server {serverStats.disk_free_gb} GB free</div>}
            <div className="mobile-nav-user" style={{display:'flex', alignItems:'center', gap:12, padding:'8px 12px'}}>
              <span className="mobile-username" style={{padding:0, flex:1}}>{userName}</span>
              <button onClick={() => { setShowSettings(true); closeMenu(); }} style={{background:'none', border:'none', fontSize:20, cursor:'pointer', padding:4, color:'#666'}} title="Settings">{'\u2699'}</button>
              <button onClick={() => { onLogout(); }} style={{background:'none', border:'none', fontSize:18, cursor:'pointer', padding:4, color:'#999'}} title="Logout">{'\uD83D\uDEAA'}</button>
            </div>
          </div>
        </div>
      </>}
    </header>
  );

  // Settings page
  if (showSettings) {
    return wrap(
      <div className="app">
        {siteHeader}
        <div style={{maxWidth:400, margin:'0 auto', padding:'24px 20px'}}>
          <h2 style={{color:'#1a5276', margin:'0 0 20px'}}>Settings</h2>
          <div style={{marginBottom:20}}>
            <h3 style={{color:'#1a5276', margin:'0 0 8px'}}>Menu position</h3>
            <div style={{display:'flex', gap:8}}>
              {(['left', 'right'] as const).map(side => (
                <button key={side} className="edit-btn" style={menuSide === side ? {background:'#2196F3', color:'#fff', borderColor:'#2196F3'} : undefined}
                  onClick={() => { setMenuSide(side); localStorage.setItem('ww_menu_side', side); }}>
                  {side === 'left' ? 'Left' : 'Right'}
                </button>
              ))}
            </div>
          </div>
          <div style={{marginBottom:20}}>
            <h3 style={{color:'#1a5276', margin:'0 0 8px'}}>Password</h3>
            <button className="edit-btn" onClick={() => setShowChangePassword(true)}>Change password</button>
          </div>
          <button className="edit-btn" onClick={() => setShowSettings(false)} style={{marginTop:12}}>Back</button>
        </div>
        {passwordDialog}
      </div>
    );
  }

  // Admin page
  if (showAdmin && userRole === 'admin') {
    return wrap(
      <div className="app">
        {siteHeader}
        <AdminPanel token={token} observationDates={stats?.observation_dates} />
        {passwordDialog}
      </div>
    );
  }

  if (showEntry && userRole !== 'viewer') {
    return wrap(
      <div className="app">
        {siteHeader}
        <DataEntryPage token={token} allPenguins={allPenguins} onBack={() => goTo('colony')} />
        {passwordDialog}
      </div>
    );
  }

  // Reports page
  if (showReports) {
    return wrap(
      <div className="app">
        {siteHeader}
        <div className="reports-page">
          <DistinctAdultsChart />
          <PeakAdultsChart />
          <EggArrivalChart />
          <ChickReturnChart />
          <ChickSexChart />
          <ChickSexBothReturnedChart />
        </div>
        {passwordDialog}
      </div>
    );
  }

  // Daily view - everything that happened on a date
  if (selectedDay) {
    return wrap(
      <div className="app">
        {siteHeader}
        <div className="colony-toolbar">
          <PenguinSearch penguins={allPenguins} search={penguinSearch} onSearchChange={setPenguinSearch} onBirdClick={(num) => setSelectedBird(num)} />
          <input className="box-search-input" type="text" placeholder="Box" onKeyDown={e => { if (e.key === 'Enter') { const v = (e.target as HTMLInputElement).value.replace(/#/g, '').trim(); if (v) { setSelectedDay(null); setSelectedBox(v); (e.target as HTMLInputElement).value = ''; } } }} />
          <DateSearch dates={stats?.observation_dates || []} onDayClick={goToDay} onFocusChange={(f, d) => { setDatePickerVisible(f); setDatePickerCenter(d); }} />
        </div>
        <DayView date={selectedDay} dates={stats?.observation_dates || []} onBoxClick={(box) => { setSelectedDay(null); setSelectedBox(box); }} onBirdClick={openBird} onDayClick={goToDay} externalBird={selectedBird} token={token} canEdit={userRole !== 'viewer'} allPenguins={allPenguins} />
        {passwordDialog}
      </div>
    );
  }

  // Bird page - replaces everything (only when no box is selected)
  if (selectedBird && !selectedBox) {
    return wrap(
      <div className="app">
        {siteHeader}
        <div className="colony-toolbar">
          <PenguinSearch penguins={allPenguins} search={penguinSearch} onSearchChange={setPenguinSearch} onBirdClick={openBird} />
          <input className="box-search-input" type="text" placeholder="Box" onKeyDown={e => { if (e.key === 'Enter') { const v = (e.target as HTMLInputElement).value.replace(/#/g, '').trim(); if (v) { setSelectedBird(null); setSelectedBox(v); (e.target as HTMLInputElement).value = ''; } } }} />
          <DateSearch dates={stats?.observation_dates || []} onDayClick={goToDay} onFocusChange={(f, d) => { setDatePickerVisible(f); setDatePickerCenter(d); }} />
        </div>
        <div className="bird-page">
          <div className="page-header">
            <a className="page-back" href={previousBox ? `/box/${previousBox}` : '/'} onClick={e => navClick(e, () => { closeBird(); if (previousBox) { setSelectedBox(previousBox); setPreviousBox(null); } })}>&larr; {previousBox ? `Box ${previousBox}` : 'Colony'}</a>
          </div>
          {birdData?.penguin ? (
            <BirdPage data={birdData} onBirdClick={openBird} token={token} canEdit={userRole !== 'viewer'}
              onBoxClick={(box: string) => { closeBird(); setSelectedBox(box); }}
              onSightingClick={(box: string, date: string) => { closeBird(); setSelectedBox(box); setHighlightObs(date); setScrollToObs(date); }}
              onDayClick={goToDay} />
          ) : false ? (() => { const p = allPenguins.find((p: any) => p.peng_num === selectedBird || p.pit_id === selectedBird); return p ? <div style={{padding:'1em'}}><PenguinMini scan={p} onClick={() => {}} /><p className="muted">Loading bird data...</p></div> : <p className="muted">Loading bird data...</p>; })()
          : <p className="muted">Bird not found</p>}
        </div>
      </div>
    );
  }

  const sortedDates = [...(stats?.observation_dates || [])].sort();
  const latestDay = sortedDates[sortedDates.length - 1] || new Date().toLocaleDateString('en-CA', {timeZone:'Pacific/Auckland'});

  return wrap(
    <div className="app">
      {siteHeader}
      <div className="colony-toolbar">
        <PenguinSearch penguins={allPenguins} search={penguinSearch} onSearchChange={setPenguinSearch} onBirdClick={openBird} />
        <input className="box-search-input" type="text" placeholder="Box" onKeyDown={e => { if (e.key === 'Enter') { const v = (e.target as HTMLInputElement).value.replace(/#/g, '').trim(); if (v) { setSelectedBird(null); setSelectedBox(v); (e.target as HTMLInputElement).value = ''; } } }} />
        <DateSearch dates={stats?.observation_dates || []} onDayClick={goToDay} onFocusChange={(f, d) => { setDatePickerVisible(f); setDatePickerCenter(d); }} />
        {userRole !== 'viewer' && <button className="toolbar-btn" onClick={() => goTo('enter')}>Enter data</button>}
        {stats && <span className="colony-stats">{stats.total_boxes} boxes &middot; {stats.season_observations} obs &middot; {stats.season_penguins} penguins this season</span>}
      </div>
      {(datePickerVisible || (!selectedBox && !selectedBird && !selectedDay)) && (
        <DayCalendar date={datePickerCenter || latestDay} dates={sortedDates} onDayClick={goToDay} />
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
            {false ? <p className="muted">Loading...</p> : boxDetail ? (
              <>
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
          {!false && boxDetail && (
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
                const thisSeason = boxDetail.observations.filter((o: any) => o.observation_time_utc >= thisSeasonStart);
                const prevObs = boxDetail.observations.filter((o: any) => o.observation_time_utc < thisSeasonStart);

                // Group previous observations by season
                const prevSeasons = new Map<string, Observation[]>();
                for (const obs of prevObs) {
                  const label = getSeasonLabel(parseDate(obs.observation_time_utc));
                  if (!prevSeasons.has(label)) prevSeasons.set(label, []);
                  prevSeasons.get(label)!.push(obs);
                }
                const sortedPrev = Array.from(prevSeasons.entries()).sort((a, b) => b[0].localeCompare(a[0]));

                const deletedCount = (boxDetail as any)?.deleted_count || 0;

                // Merge deleted into date-sorted list when showing
                const mergedObs = showDeleted && deletedObs.length > 0
                  ? [...thisSeason.map((o: any) => ({...o, _deleted: false})), ...deletedObs.map((o: any) => ({...o, _deleted: true}))]
                    .sort((a, b) => b.observation_time_utc.localeCompare(a.observation_time_utc))
                  : thisSeason;

                return (<>
                  <h3 className="season-heading">{thisLabel} ({thisSeason.length})
                    {deletedCount > 0 && <span className="deleted-indicator clickable" onClick={async () => {
                      if (!showDeleted && deletedObs.length === 0) {
                        const r = await fetch(`/api/dashboard.php?view=box&name=${encodeURIComponent(selectedBox!)}&include_deleted=1&_=${Date.now()}`, { headers: { 'Authorization': `Bearer ${token}` } });
                        const d = await r.json();
                        setDeletedObs(d.deleted || []);
                      }
                      setShowDeleted(!showDeleted);
                    }}> · {showDeleted ? 'hide' : 'show'} {deletedCount} deleted</span>}
                  </h3>
                  {mergedObs.length === 0 && <p className="muted">No observations this season</p>}
                  {mergedObs.map((obs: any, i: number) => obs._deleted ? (
                    <div key={`del${obs.observation_id}`} className="obs-card deleted-obs">
                      <div className="obs-top">
                        <span><s><DateLink date={obs.observation_time_utc} onDayClick={goToDay} /></s></span>
                        <span className="muted">deleted {obs.deleted_at ? formatDate(obs.deleted_at) : ''} by {obs.deleted_by_name || '?'}{obs.delete_reason ? ` — ${obs.delete_reason}` : ''}</span>
                      </div>
                      <div className="obs-nums">
                        {obs.adults === 0 && obs.eggs === 0 && obs.chicks === 0 && <span className="muted">Empty</span>}
                        {obs.adults > 0 && <span>{'\uD83D\uDC27'.repeat(Math.min(obs.adults, 6))}</span>}
                        {obs.eggs > 0 && <span>{'\uD83E\uDD5A'.repeat(Math.min(obs.eggs, 6))}</span>}
                        {obs.chicks > 0 && <span>{'\uD83D\uDC23'.repeat(Math.min(obs.chicks, 6))}</span>}
                        {obs.breeding_status && <span className="badge bordered" style={{background:'#E0E0E0', color:'#333'}}>{obs.breeding_status}</span>}
                      </div>
                      {obs.notes && <div className="obs-notes"><s>{obs.notes}</s></div>}
                    </div>
                  ) : (
                    <ObsCard key={obs.observation_id || `t${i}`} obs={obs} onBirdClick={openBird} onDayClick={goToDay} highlight={highlightObs !== null && obs.observation_time_utc === highlightObs} scrollTo={scrollToObs !== null && obs.observation_time_utc === scrollToObs} token={token} canEdit={userRole !== 'viewer'} allPenguins={allPenguins} onDataChange={refreshStats} />
                  ))}
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
                  onDayClick={goToDay} />
              ) : false ? (() => { const p = allPenguins.find((p: any) => p.peng_num === selectedBird || p.pit_id === selectedBird); return p ? <div style={{padding:'1em'}}><PenguinMini scan={p} onClick={() => {}} /><p className="muted">Loading bird data...</p></div> : <p className="muted">Loading bird...</p>; })()
              : <p className="muted">Select a bird</p>}
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
/** Returns YYYY-MM-DD in NZ time for a datetime string.
 *  Fixed +12 (NZST), matching the bucketing in localdb so dates can't roll over. */
function toNzDateStr(d: string): string {
  return new Date(parseDate(d).getTime() + 12 * 3600000).toISOString().slice(0, 10);
}

function AuthenticatedAppWithTooltip(props: { token: string; userName: string; userRole: string; onLogout: () => void }) {
  return <AuthenticatedApp {...props} />;
}

export default App;
