import React, { Fragment, Suspense, createContext, lazy, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fetchBoxTags, fetchOverview, updateRecord, createRecord, deleteRecord, fetchHistory, fetchColonies } from './api/boxtags';
import { syncDatabase, triggerSync, primeFromCache, queryAllLocations, queryCarryForward, getDcmBoxes, prevNonIgnObs, queryPreviousObservations, getDateStats, computeDateStats, startPolling, stopPolling, getColonyId, setActiveColony, observedSexGuess, queryBoxDetailSync, splitDismissed, dismissError, undismissError } from './api/localdb';
import { useAllPenguins, useDateStats, useBoxDetail, useBirdDetail, useDayData, useEggArrival, useFirstEgg, useDistinctAdults, usePeakAdults, useChickReturn, useMissedScans, useAdultCountMismatches, useDbVersion, useBirdTwoBoxes, useScanBeforeChip, useDeadScanned, useImprobableCounts, useFutureObservations, useRetiredTagScans, useChicksNoScan, useDuplicateObservations, useDuplicateScans, useSameGenderConflicts } from './api/useLocalDb';
import { getSeasonStart, getSeasonLabel } from './config';
import { ColonyMap } from './components/ColonyMap';
import { BoxGrid } from './components/BoxGrid';
import { StatsPanel } from './components/StatsPanel';
// A code-split chunk can 404 after a new deploy (its hashed filename is gone), and nginx's
// SPA fallback then serves index.html (text/html) in its place — so the dynamic import fails
// with a MIME-type error. Reload once to pick up the fresh index + chunk hashes; a sessionStorage
// guard prevents a reload loop if the import genuinely can't be loaded.
function lazyWithReload<T extends React.ComponentType<any>>(factory: () => Promise<{ default: T }>) {
  return lazy(() => factory()
    .then(m => { sessionStorage.removeItem('ww_chunk_reload'); return m; })
    .catch((err: unknown) => {
      if (!sessionStorage.getItem('ww_chunk_reload')) {
        sessionStorage.setItem('ww_chunk_reload', '1');
        window.location.reload();
        return new Promise<{ default: T }>(() => {}); // never resolves; page is reloading
      }
      throw err;
    }));
}
const DiskHistoryChart = lazyWithReload(() => import('./components/DiskHistoryChart'));
import type { BoxTag } from './types';
import './App.css';

interface Scan { scan_id?:number; peng_num?:string|null; pit_id:string; sex:string|null; life_stage:string|null; chip_date:string|null; chipped_as_adult:number|null; }

interface Observation {
  observation_id?:number;
  observation_time_utc:string; monitor_filename:string;
  adults:number; eggs:number; chicks:number;
  breeding_status:string|null; gate_status:string|null; notes:string;
  no_scan?:number;
  fledged_unchipped?:number;
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
  const s = (status || '').trim();
  // Eggs/chicks in the box mean incubation/guard has started, whatever pre-breeding
  // assessment (NO/UNL/POT/CON/BR/blank) was last recorded. Explicit stage or alert
  // statuses (I, G, PG, MOULT, ABN, DCM) always display as stored.
  if (['BR', 'CON', 'POT', 'UNL', 'NO', ''].includes(s)) {
    if (chicks > 0) return 'G';
    if (eggs > 0) return 'I';
    if (s === 'BR') return 'NO';
  }
  return status;
}

/** Status badge for read-only views: an IGN observation shows the box's previous
 *  (pre-IGN) nest status instead, so ignoring a nest doesn't hide its real state.
 *  The editable ObsCard deliberately still shows IGN. `o` may be an observation or a
 *  sighting object (time in observation_time_utc or date). */
function displayStatusOrPrev(o: any, box?: string): string | null {
  if ((o.breeding_status || '').trim() === 'IGN') {
    const prev = box ? prevNonIgnObs(box, o.observation_time_utc || o.date) : null;
    return prev ? displayStatus(prev.breeding_status, prev.eggs || 0, prev.chicks || 0) : null;
  }
  return displayStatus(o.breeding_status, o.eggs, o.chicks);
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
  IGN:'#90A4AE',      // blue-grey - ignored (excused from Full Monitor)
  '':'#F5F5F5',
};

const STATUS_NAMES: Record<string,string> = {
  NO:'No', UNL:'Unlikely', POT:'Potential', CON:'Confident',
  I:'Incubation', G:'Guard', PG:'Post-guard', MOULT:'Moulting',
  DCM:'DCM', IGN:'Ignored',
};

// Observer-settable breeding statuses for the quick radial status picker on a locked
// observation. Order = ring position: CON at top (12 o'clock), then clockwise.
const STATUS_PICK_OPTIONS = ['CON','POT','UNL','NO','ABN','DCM','IGN'];

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

/** Colour key for the breeding status bars (No, Unlikely, Potential, …). */
function StatusLegend() {
  return (
    <div className="status-bar-legend">
      {Object.entries(STATUS_NAMES).map(([k, v]) => (
        <span key={k}><i style={{ background: STATUS_COLORS[k] }} />{v}</span>
      ))}
    </div>
  );
}

function BreedingStatusBar({ observations, onHighlight, onScrollTo, hideLegend }: { observations: Observation[]; onHighlight?: (date: string | null) => void; onScrollTo?: (date: string) => void; hideLegend?: boolean }) {
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
      {!hideLegend && <StatusLegend />}
    </div>
  );
}



function isChickAtObsDate(chipDate?: string|null, chippedAsAdult?: number|null, observationDate?: string): boolean {
  if (chippedAsAdult || !chipDate) return false;
  return ((observationDate ? new Date(observationDate).getTime() : Date.now()) - new Date(chipDate).getTime()) < 90 * 86400000;
}

/** One day after chipping — renders a chick-chipped bird in its chick-time context
 *  (pale yellow) without triggering the same-day chipped-here (green) styling. */
function chickContextDate(chipDate: string): string {
  return new Date(new Date(chipDate).getTime() + 86400000).toISOString().slice(0, 10);
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
  e.stopPropagation();
  action();
}

function useDateTooltip() {
  const [tip, setTip] = useState<{ date: string; x: number; y: number } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const autoHideRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = useCallback((date: string, e: React.MouseEvent) => {
    clearTimeout(timerRef.current);
    clearTimeout(autoHideRef.current);
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    timerRef.current = setTimeout(() => {
      setTip({ date, x: rect.left, y: rect.bottom + 4 });
      // Auto-dismiss after 5s even if the pointer stays on the day.
      autoHideRef.current = setTimeout(() => setTip(null), 5000);
    }, 350);
  }, []);
  const hide = useCallback(() => { clearTimeout(timerRef.current); clearTimeout(autoHideRef.current); setTip(null); }, []);
  return { tip, show, hide };
}

// registeredFmDates: NZ date (YYYY-MM-DD) -> the season + date-number it was registered as
// in the enter-date workflow. Used, alongside a computed full monitor, to flag FM dates green.
const DateTooltipCtx = createContext<{ show: (date: string, e: React.MouseEvent) => void; hide: () => void; statsCache: Map<string, any>; registeredFmDates: Map<string, { season: number; number: number; partial: boolean }> }>({ show: () => {}, hide: () => {}, statsCache: new Map(), registeredFmDates: new Map() });

function DateStatsLine({ stats, showDate, date }: { stats: any; showDate?: boolean; date?: string }) {
  const multiObs = stats.obs > stats.boxes;
  const { registeredFmDates } = useContext(DateTooltipCtx);
  const reg = date ? registeredFmDates.get(date.length > 10 ? toNzDateStr(date) : date) : undefined;
  // For a missed FM date, name the missing boxes when only a few, else just the count.
  const missing: string[] = stats.missingBoxes || [];
  const missedSuffix = missing.length > 0 && missing.length < 4 ? ` — missed "${missing.join(', ')}"` : ` — missed (${missing.length})`;
  return (<>
    {showDate && date && <b className="date-stats-date">{formatDate(date)}</b>}
    {reg?.partial
      ? <span style={{color:'#00796b'}}> <b>Partial Monitor</b> ({stats.boxes}/{stats.totalLocations})</span>
      : stats.isFullMonitor
      ? <span style={{color:'#2e7d32'}}> <b>Full Monitor</b> ({stats.boxes}/{stats.totalLocations})</span>
      : <span> {stats.boxes}/{stats.totalLocations} boxes</span>}
    {reg && (reg.partial
      ? <span style={{color:'#00796b'}}> <b>PM #{reg.number}</b> from {seasonRange(String(reg.season))}</span>
      : <span style={{color: stats.isFullMonitor ? '#2e7d32' : '#e65100'}}> <b>FM #{reg.number}</b> from {seasonRange(String(reg.season))}{stats.isFullMonitor ? '' : missedSuffix}</span>)}
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
  const { show, hide, statsCache, registeredFmDates } = useContext(DateTooltipCtx);
  const fm = registeredFmDates.get(day);
  const stats = statsCache.get(day);
  const complete = !!stats?.isFullMonitor; // full monitor = complete box set (same test as the calendar)
  // A Partial Monitor (PM) date is green on registration alone — it's a deliberate partial round,
  // so the full box-set check doesn't apply. Otherwise: orange for a registered FM date whose
  // observations are incomplete (data missing), green for a complete full monitor, plain otherwise.
  const cls = fm?.partial ? ' fm-pm' : fm && !complete ? ' fm-partial' : complete ? ' fm-date' : '';
  return <a className={`date-link${cls}`} href={`/day/${day}`} onClick={e => navClick(e, () => onDayClick?.(day))}
    onMouseEnter={e => show(day, e)} onMouseLeave={hide}>{formatDate(date)}{fm ? <span className="fm-tag"> ({fm.partial ? 'PM' : 'FM'} {fm.number})</span> : ''}</a>;
}

/** Peng_num of the bird whose peng panel is currently open (null when none). Lets a
 *  mini click detect "already selected" and toggle the highlight. */
let openPanelPengNum: string | null = null;

/** While a peng panel is open, every mini of its bird gets a subtle lifted (3D) look —
 *  except the panel's own header mini, which is the selection itself, not a reference.
 *  Done with an injected style rule keyed on data-peng rather than per-element classes,
 *  so minis (re)rendered anywhere on the page while the panel is open still pick it up.
 *  Re-clicking a mini of the already-open bird toggles the highlight off/on. */
let selectedPengStyle: HTMLStyleElement | null = null;
let selectedPengKeys: string[] = [];
let selectedPengHidden = false;
function applySelectedPengStyle() {
  if (!selectedPengStyle) selectedPengStyle = document.head.appendChild(document.createElement('style'));
  selectedPengStyle.textContent = selectedPengKeys.length === 0 || selectedPengHidden ? '' :
    selectedPengKeys.map(k => `.scan[data-peng="${CSS.escape(k)}"]:not(.bird-title-peng *)`).join(', ') +
    ' { position: relative; top: -2px; box-shadow: 2px 3px 5px rgba(0,0,0,.5); }';
}
function setSelectedPengMinis(keys: (string | null | undefined)[]) {
  selectedPengKeys = keys.filter(Boolean) as string[];
  selectedPengHidden = false;
  applySelectedPengStyle();
}
function toggleSelectedPengMinis() {
  selectedPengHidden = !selectedPengHidden;
  applySelectedPengStyle();
}

function PenguinMini({ scan, onClick, observationDate, navigateDirectly, currentStatus, title }: { scan: Scan | ChippedHere | any; onClick: () => void; observationDate?: string; navigateDirectly?: boolean; currentStatus?: boolean; title?: string }) {
  const sex = (scan.sex || '').toUpperCase();
  const num = scan.peng_num ? `#${scan.peng_num}` : '';
  const chip = scan.pit_id ? scan.pit_id.slice(-8) : '';
  const wasChippedAsChick = !scan.chipped_as_adult;
  // currentStatus (bird-page header): solid yellow only while the bird is actually
  // chick-aged (<90 days since chipping). Beyond that it renders as an adult — sex
  // colour if returned and sexed, grey "unproven" otherwise (including chick-chipped
  // birds never scanned again, e.g. lost at sea) — with the yellow chick-origin inset.
  // Without currentStatus, life-stage is judged as at the given observation date.
  const stillChick = currentStatus
    ? (wasChippedAsChick && !scan.hasReturned && isChickAtObsDate(scan.chip_date, scan.chipped_as_adult))
    : isChickAtObsDate(scan.chip_date, scan.chipped_as_adult, observationDate);
  const cls = currentStatus
    ? (stillChick ? 'chick' : (sex === 'F' ? 'f' : sex === 'M' ? 'm' : ''))
    : penguinSexClass(sex, scan.chip_date, scan.chipped_as_adult, observationDate);
  const icon = currentStatus
    ? (stillChick ? '🐣' : (sex === 'F' ? '♀' : sex === 'M' ? '♂' : ''))
    : penguinSexIcon(sex, scan.chip_date, scan.chipped_as_adult, observationDate);
  const chickOrigin = wasChippedAsChick && !stillChick;
  const chipCls = currentStatus
    ? (chickOrigin && sex ? 'chipped-chick' : '')
    : (wasChippedAsChick ? 'chipped-chick' : '');
  const grayCls = currentStatus
    ? (chickOrigin && !sex ? 'unproven' : '')
    : (wasChippedAsChick && !stillChick && !sex && !observationDate ? 'unproven' : '');
  const obsNzDate = observationDate ? toNzDateStr(observationDate) : '';
  const chippedHereCls = scan.chip_date && obsNzDate && scan.chip_date.substring(0, 10) === obsNzDate ? 'chipped-here' : '';
  // Combined chick size code: LC + M → LCM, LC + no sex but returned → LCU, LC alone → LC
  const sc = scan.chick_size_code || '';
  const sizeLabel = sc ? (sex ? sc + sex.charAt(0) : (scan.hasReturned ? sc + 'U' : sc)) : '';
  // Unsexed bird: surface biometric sex guesses (U = unconfirmed). A single guess merges
  // onto the size label with no count/space, sharing one U — "LCU"+M → "LCUM", "LC"+M → "LCUM".
  // Repeated guesses or guesses for both sexes use numbered tokens, most-guessed first,
  // hyphen-joined so the guess data reads as one unit — e.g. "BC-2UM", "1UM-1UF".
  const guess = sex ? { m: 0, f: 0 } : observedSexGuess(scan.peng_num);
  const guessSexes = [{ c: guess.m, s: 'M' }, { c: guess.f, s: 'F' }].filter(g => g.c > 0).sort((a, b) => b.c - a.c);
  let mid: string;
  if (guessSexes.length === 0) {
    mid = sizeLabel;
  } else if (guessSexes.length === 1 && guessSexes[0].c === 1) {
    mid = (sizeLabel.endsWith('U') ? sizeLabel : sizeLabel + 'U') + guessSexes[0].s;
  } else {
    // tokens carry their own U, so drop the size label's redundant returned-unsexed U ("BCU" → "BC")
    const base = sizeLabel.endsWith('U') ? sizeLabel.slice(0, -1) : sizeLabel;
    mid = [base, guessSexes.map(g => `${g.c}U${g.s}`).join('-')].filter(Boolean).join('-');
  }
  const href = scan.peng_num ? `/bird/${scan.peng_num}` : undefined;
  // Hovering a mini tied to a data entry shows that entry's NZ-local time. Use the first
  // timestamped source available — an explicit observationDate, or a timestamp carried on the
  // scan/sighting object — skipping bare YYYY-MM-DD dates; never overrides an explicit title.
  const timeSrc = [observationDate, scan.observation_time_utc, scan.date, scan.last_seen]
    .find((v: any) => typeof v === 'string' && v.length > 10);
  const nzTime = timeSrc
    ? parseDate(timeSrc).toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' })
    : undefined;
  return (
    <a className={`scan clickable ${cls} ${chipCls} ${grayCls} ${chippedHereCls}`} data-peng={scan.peng_num || chip || undefined} href={href} title={title || nzTime} onClick={navigateDirectly ? undefined : e => navClick(e, () => {
      onClick();
      // Re-clicking the bird already open in the panel won't remount it — toggle the highlight.
      if (scan.peng_num && scan.peng_num === openPanelPengNum) toggleSelectedPengMinis();
    })}>
      {num}{num && icon ? ' ' : ''}{!sizeLabel && icon && <span className="sex-icon">{icon}</span>}{mid ? ` ${mid} ` : (num || icon) && chip ? ' ' : ''}{chip}
    </a>
  );
}

/** One breeding attempt in a season. A clutch starts when eggs/chicks appear after
 *  an empty check, and its window ends at ABN, egg removal / offspring absence
 *  (implies death), or fledge (laid + 87d) — whichever comes first. A later egg
 *  appearance after an empty check is a SECOND clutch with its own family. */
interface Clutch {
  laid: number | null;      // estimated laid time; null when un-estimable
  laidUncertainty: number | null; // ± days on the laid estimate (half the empty→found gap)
  laidFailed: boolean;      // eggs already present at first check — data needs fixing
  start: number;            // first obs with offspring present (egg appearance)
  startObsTime: string;     // that first-offspring observation's UTC time (scroll target)
  end: number | null;       // obs that ended the attempt; null = still running
  windowStart: number;      // breeding window: egg appearance …
  windowEnd: number;        // … fledge (laid + 87d) or earlier failure
  guardEnd: number;         // end of guard (laid + 52d): parents stop attending after this
  maxEggs: number;
  maxChicks: number;
}

function segmentClutches(sObs: Observation[]): Clutch[] {
  const clutches: Clutch[] = [];
  let current: Clutch | null = null;
  // After an ABN close the doomed eggs may linger in later checks — require an
  // empty check before a new clutch can start.
  let awaitingEmpty = false;
  let prevEmpty: number | null = null;
  for (const o of sObs) {
    const t = parseDate(o.observation_time_utc).getTime();
    const off = (o.eggs || 0) + (o.chicks || 0);
    const abn = o.breeding_status === 'ABN';
    if (current) {
      if (off === 0) {
        current.end = t; current = null; prevEmpty = t; awaitingEmpty = false;
      } else {
        current.maxEggs = Math.max(current.maxEggs, o.eggs || 0);
        current.maxChicks = Math.max(current.maxChicks, o.chicks || 0);
        if (abn) { current.end = t; current = null; awaitingEmpty = true; }
      }
    } else if (off === 0) {
      prevEmpty = t; awaitingEmpty = false;
    } else if (!awaitingEmpty && ((o.eggs || 0) > 0 || clutches.length === 0)) {
      // A breeding attempt begins at laying, so only eggs start a new clutch. Chicks
      // appearing with no egg phase after a completed clutch is biologically impossible
      // — it's stale/carry-forward data, not a real second brood — so it's ignored.
      // Exception: the season's FIRST attempt may start on chicks (egg phase missed).
      // Laid estimate (C# midpoint): halfway between last empty check and discovery,
      // minus 2 days if 2+ eggs at discovery (second egg laid ~2 days after first)
      let laid: number | null = null, laidUncertainty: number | null = null;
      if (prevEmpty !== null && !abn) {
        const found = (o.eggs || 0) > 1 ? t - 2 * DAY : t;
        laid = prevEmpty + Math.ceil((found - prevEmpty) / 2 / DAY) * DAY;
        laidUncertainty = Math.floor((found - prevEmpty) / 2 / DAY); // matches reports.php uncertaintyDays
      }
      current = { laid, laidUncertainty, laidFailed: laid === null, start: t, startObsTime: o.observation_time_utc, end: null,
        windowStart: 0, windowEnd: 0, guardEnd: 0, maxEggs: o.eggs || 0, maxChicks: o.chicks || 0 };
      clutches.push(current);
      if (abn) { current.end = t; current = null; awaitingEmpty = true; }
    }
  }
  for (const c of clutches) {
    const anchor = c.laid ?? c.start; // fall back to first sighting when laid unknown
    c.windowStart = c.start;
    c.guardEnd = Math.min(c.end ?? Infinity, anchor + BREEDING_OFFSETS.pg * DAY);
    c.windowEnd = Math.min(c.end ?? Infinity, anchor + BREEDING_OFFSETS.fledge * DAY);
  }
  return clutches;
}

/** Detect the breeding pair for one clutch. Any bird scanned inside the clutch window
 *  is a candidate — a single sighting is better than nothing — but the scoring means a
 *  once-seen bird only wins a slot when no better-evidenced bird exists. A valid pair
 *  is one M + one F where at least one sex is confirmed — the other may come from
 *  majority biometric sex guesses (M+F, M+UF, F+UM; never UM+UF). Pairs actually
 *  scanned together in the same observation outrank pairs that merely share the
 *  window; ties break on combined sighting counts. Chip events at this box (already
 *  deduped against same-day scans) count as single sightings — a bird chipped at the
 *  nest attended it even when no observation was recorded that day. */
function detectClutchPair(c: Clutch, sObs: Observation[], birdMap: Map<string, any>, excluded: (b: any) => boolean, chipEvents: { key: string; t: number }[] = []): { male: string; female: string } | null {
  const counts = new Map<string, number>();
  const co = new Map<string, number>();
  // Parents attend the nest from courtship/nest-building through the end of guard:
  // scans up to ~30 days before laying count (e.g. a male seen only pre-egg is still
  // a parent), but after guard both feed at sea, so later scans are no evidence.
  const courtshipStart = (c.laid ?? c.windowStart) - 30 * DAY;
  for (const o of sObs) {
    const t = parseDate(o.observation_time_utc).getTime();
    if (t < courtshipStart || t > c.guardEnd) continue;
    const present = Array.from(new Set(o.scans.map((s: Scan) => s.pit_id.slice(-8))));
    for (const k of present) counts.set(k, (counts.get(k) || 0) + 1);
    for (let i = 0; i < present.length; i++) for (let j = i + 1; j < present.length; j++) {
      const key = [present[i], present[j]].sort().join('|');
      co.set(key, (co.get(key) || 0) + 1);
    }
  }
  for (const ev of chipEvents) {
    if (ev.t >= courtshipStart && ev.t <= c.guardEnd) counts.set(ev.key, (counts.get(ev.key) || 0) + 1);
  }
  const sexOf = (b: any): { sex: string; confirmed: boolean } | null => {
    const s = (b.sex || '').toUpperCase();
    if (s === 'M' || s === 'F') return { sex: s, confirmed: true };
    const g = observedSexGuess(b.peng_num);
    if (g.m > g.f) return { sex: 'M', confirmed: false };
    if (g.f > g.m) return { sex: 'F', confirmed: false };
    return null;
  };
  const cands = Array.from(counts.entries())
    .map(([key, n]) => ({ key, n, bird: birdMap.get(key) }))
    .filter(x => x.bird && !excluded(x.bird));
  let best: { male: string; female: string; score: number } | null = null;
  for (let i = 0; i < cands.length; i++) for (let j = i + 1; j < cands.length; j++) {
    const a = sexOf(cands[i].bird), b = sexOf(cands[j].bird);
    if (!a || !b || a.sex === b.sex || (!a.confirmed && !b.confirmed)) continue;
    const coN = co.get([cands[i].key, cands[j].key].sort().join('|')) || 0;
    const score = coN * 1000 + cands[i].n + cands[j].n;
    if (!best || score > best.score) {
      best = { male: a.sex === 'M' ? cands[i].key : cands[j].key, female: a.sex === 'F' ? cands[i].key : cands[j].key, score };
    }
  }
  if (best) return { male: best.male, female: best.female };
  // No full pair — fall back to the best-evidenced single bird in the window as a
  // lone parent. Sex needn't be known (it's a guess either way); slot it by whatever
  // sex signal exists, defaulting to the male slot. The family box shows just that
  // bird + the offspring.
  let solo: { key: string; sex: string; n: number } | null = null;
  for (const c of cands) {
    if (!solo || c.n > solo.n) solo = { key: c.key, sex: sexOf(c.bird)?.sex || '', n: c.n };
  }
  if (solo) return { male: solo.sex === 'F' ? '' : solo.key, female: solo.sex === 'F' ? solo.key : '' };
  return null;
}

/** Display sort rank by sex: M first, F second, unsexed last. An unsexed bird with a
 *  majority biometric sex guess (rendered as UM/UF) ranks with the confirmed sex. */
function sexSortOrder(b: any): number {
  const s = (b.sex || '').toUpperCase();
  if (s === 'M') return 0;
  if (s === 'F') return 1;
  const g = observedSexGuess(b.peng_num);
  if (g.m > g.f) return 0;
  if (g.f > g.m) return 1;
  return 2;
}

const ordinal = (n: number) => n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`;
/** Season label "2026" → "2026/27" (breeding season spans two calendar years). */
const seasonRange = (label: string) => `${label}/${String((parseInt(label) + 1) % 100).padStart(2, '0')}`;

const fmtMs = (ms: number) => new Date(ms).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', timeZone: 'Pacific/Auckland' });
/** Clutch still running: no terminating observation yet and predicted fledge not passed. */
const clutchActive = (c: { end: number | null; windowEnd: number }) => c.end === null && Date.now() <= c.windowEnd;
/** Breeding-window date range; an active window reads "6 Jul – current". */
const windowRange = (c: { windowStart: number; windowEnd: number; end: number | null }) =>
  `${fmtMs(c.windowStart)} – ${clutchActive(c) ? 'current' : fmtMs(c.windowEnd)}`;

/** Active window only: ALL upcoming stage dates predicted from the laid estimate — same
 *  offsets as the nestcheck Next Breeding Dates card. Hatch is shown only while the
 *  clutch is still in the egg phase; the chip window runs to fledge. */
/** Unchipped offspring in a family box. Once the clutch has ENDED these are final
 *  stages — egg that never hatched / chick never chipped — and get the red ✕. While
 *  the clutch is still active they're simply in progress, so no failure mark. */
function OffspringFinal({ kind, active }: { kind: 'egg' | 'chick'; active: boolean }) {
  const title = kind === 'egg'
    ? (active ? 'Egg in the nest' : 'Egg did not hatch')
    : (active ? 'Unchipped chick in the nest' : 'Chick was not chipped in the nest');
  return (
    <span className={`offspring-final${active ? '' : ' offspring-failed'}`} title={title}>
      {kind === 'egg' ? '🥚' : '🐣'}{!active && <span className="fail-x">{'✕'}</span>}
    </span>
  );
}

function ClutchPredictions({ clutch }: { clutch: Clutch }) {
  if (!clutchActive(clutch) || clutch.laid === null) return null;
  const d = (off: number) => fmtMs(clutch.laid! + off * DAY);
  const t = (off: number) => clutch.laid! + off * DAY;
  // laid estimates the first egg; the second is laid ~2 days later. Little penguins
  // almost always lay 2, so show both unless only a single egg was ever recorded.
  const twoEggs = (clutch.maxEggs || 2) >= 2;
  const parts = [
    { text: twoEggs ? `Laid ${d(0)} & ${d(2)}` : `Laid ${d(0)}`, t: t(0) },
    ...(clutch.maxChicks === 0 ? [{ text: `Hatch ${d(BREEDING_OFFSETS.hatch)}`, t: t(BREEDING_OFFSETS.hatch) }] : []),
    { text: `Guard ends ${d(BREEDING_OFFSETS.pg)}`, t: t(BREEDING_OFFSETS.pg) },
    { text: `Chip ${d(BREEDING_OFFSETS.chip)} – ${d(BREEDING_OFFSETS.fledge)}`, t: t(BREEDING_OFFSETS.chip) },
    { text: `Fledge ${d(BREEDING_OFFSETS.fledge)}`, t: t(BREEDING_OFFSETS.fledge) },
  ];
  const nextIdx = parts.findIndex(p => p.t >= Date.now()); // the stage coming up next
  const unc = clutch.laidUncertainty !== null && clutch.laidUncertainty > 0
    ? `± ${clutch.laidUncertainty} day${clutch.laidUncertainty !== 1 ? 's' : ''}` : '';
  return (
    <span className="clutch-predictions">
      {parts.map((p, i) => <span key={i}>{i > 0 ? ', ' : ''}{i === nextIdx ? <b>{p.text}</b> : p.text}</span>)}
      {unc ? `, ${unc}` : ''}
    </span>
  );
}


/** Per-box data-quality checks (mirrors the admin-page checks, scoped to one box's
 *  observations). All dates are NZ days. Returns human-readable detail lines so the
 *  season summary can list what's wrong. */
interface DataIssue { day: string; text: string }
function seasonDataIssues(obs: Observation[]) {
  const byDay = new Map<string, Observation[]>();
  for (const o of obs) {
    const day = toNzDateStr(o.observation_time_utc);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(o);
  }
  // Duplicate observations: 2+ non-deleted observations for this box on the same day
  const dupObs: DataIssue[] = [];
  for (const [day, list] of byDay) if (list.length > 1) dupObs.push({ day, text: `${day} — ${list.length} observations` });
  // Duplicate scans: within one observation, the same pit scanned 2+ times, or one
  // penguin scanned via 2+ different chips
  const dupScans: DataIssue[] = [];
  for (const o of obs) {
    const day = toNzDateStr(o.observation_time_utc);
    const pitCounts = new Map<string, number>();
    const pitPeng = new Map<string, string | null>();
    const pengPits = new Map<string, Set<string>>();
    for (const s of o.scans) {
      pitCounts.set(s.pit_id, (pitCounts.get(s.pit_id) || 0) + 1);
      pitPeng.set(s.pit_id, s.peng_num ?? null);
      if (s.peng_num) {
        if (!pengPits.has(s.peng_num)) pengPits.set(s.peng_num, new Set());
        pengPits.get(s.peng_num)!.add(s.pit_id);
      }
    }
    for (const [pit, n] of pitCounts) if (n > 1) {
      const peng = pitPeng.get(pit);
      dupScans.push({ day, text: `${day} — ${peng ? `#${peng}` : pit.slice(-8)} ×${n}` });
    }
    for (const [peng, pits] of pengPits) if (pits.size > 1) dupScans.push({ day, text: `${day} — #${peng} (${pits.size} chips)` });
  }
  // Same-gender conflicts: 2+ distinct penguins of the same sex on the same day
  const conflicts: DataIssue[] = [];
  for (const [day, list] of byDay) {
    const bySex = new Map<string, Set<string>>();
    for (const o of list) for (const s of o.scans) {
      const sex = (s.sex || '').toUpperCase();
      if ((sex === 'M' || sex === 'F') && s.peng_num) {
        if (!bySex.has(sex)) bySex.set(sex, new Set());
        bySex.get(sex)!.add(s.peng_num);
      }
    }
    for (const [sex, pengs] of bySex) if (pengs.size > 1) {
      conflicts.push({ day, text: `${day} — ${pengs.size} ${sex} (${Array.from(pengs).map(p => `#${p}`).join(', ')})` });
    }
  }
  return { dupObs, dupScans, conflicts };
}

interface BoxFamily {
  clutch: Clutch;
  male: string;      // pit8 of the male parent, '' if none detected
  female: string;    // pit8 of the female parent, '' if none detected
  parents: any[];    // parent bird objects (0-2)
  chicks: any[];     // this-season chicks chipped in the nest (bird objects)
  failedEggs: number;   // eggs that never became a chick (final stage), capped at 4
  plainChicks: number;  // unchipped chicks assumed to have died (final stage), capped at 4
  fledgedUnchipped: number; // unchipped chicks a monitor recorded as presumed fledged
}
interface BoxSeasonData {
  label: string;
  seasonYear: number;
  seasonStart: Date;
  seasonEnd: Date;
  seasonObs: Observation[];   // chronological
  birds: any[];               // sorted M/F/unsexed, scan-count desc
  birdMap: Map<string, any>;  // pit8 -> bird
  clutches: Clutch[];
  families: BoxFamily[];      // one per clutch; parents empty when no pair detected
  parentKeys: Set<string>;
  chickFamily: Map<string, number>; // chick pit8 -> family index
  isCurrent: boolean;
}

/** THE shared breeding-family detection for one box's observations: group by season,
 *  segment each season into clutches, detect each clutch's pair, assign this-season
 *  chicks, and tally offspring at their final life stage. Both the box breeding
 *  overview and the bird panel's family view consume this, so the detection algorithm
 *  lives in exactly one place — change it here and both views update. */
function computeBoxFamilies(observations: Observation[], allPenguinsInBox?: any[]): BoxSeasonData[] {
  const seasonBirds = new Map<string, Map<string, any>>();
  const seasonObsMap = new Map<string, Observation[]>();
  for (const obs of observations) {
    const label = getSeasonLabel(parseDate(obs.observation_time_utc));
    if (!seasonObsMap.has(label)) seasonObsMap.set(label, []);
    seasonObsMap.get(label)!.push(obs);
  }
  for (const obs of observations) {
    const label = getSeasonLabel(parseDate(obs.observation_time_utc));
    if (!seasonBirds.has(label)) seasonBirds.set(label, new Map());
    const birdMap = seasonBirds.get(label)!;
    for (const scan of obs.scans) {
      const key = scan.pit_id.slice(-8);
      const existing = birdMap.get(key);
      if (!existing) {
        birdMap.set(key, { ...scan, lastSeen: obs.observation_time_utc, scanCount: 1 });
      } else {
        existing.scanCount++;
        if (obs.observation_time_utc > existing.lastSeen) {
          existing.lastSeen = obs.observation_time_utc;
          existing.sex = scan.sex;
          existing.life_stage = scan.life_stage;
        }
      }
    }
  }
  // Merge allPenguinsInBox — only add birds chipped HERE to the chipping season.
  // Birds chipped elsewhere already appear from their scan data in the correct season.
  for (const p of (allPenguinsInBox || [])) {
    if (!p.chip_date || !p.pit_id || !p.is_chipped_here) continue;
    const label = getSeasonLabel(parseDate(p.chip_date));
    if (!seasonBirds.has(label)) seasonBirds.set(label, new Map());
    const birdMap = seasonBirds.get(label)!;
    const key = p.pit_id.slice(-8);
    if (!birdMap.has(key)) birdMap.set(key, { ...p, lastSeen: p.last_seen || p.chip_date, scanCount: p.scan_count || 1 });
  }
  // Always surface the current season, even with no sightings yet.
  const currentLabel = getSeasonLabel();
  if (!seasonBirds.has(currentLabel)) seasonBirds.set(currentLabel, new Map());
  // Surface every monitored season (has observations) even if no bird was ever scanned — the
  // overview shows it with "No breeding observed".
  for (const label of seasonObsMap.keys()) if (!seasonBirds.has(label)) seasonBirds.set(label, new Map());

  const seasons = Array.from(seasonBirds.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  const result: BoxSeasonData[] = [];
  for (const [label, birdMap] of seasons) {
    const seasonYear = parseInt(label);
    const seasonStart = new Date(seasonYear, 3, 1); // Apr 1
    const seasonEnd = new Date(seasonYear + 1, 3, 1); // next Apr 1
    // A bird counts as this season's chick only if chipped as a chick DURING this
    // season — a returning adult chick-chipped in an earlier season is a visitor.
    const chippedThisSeason = (b: any) => {
      if (b.chipped_as_adult || !b.chip_date) return false;
      const cd = new Date(b.chip_date);
      return cd >= seasonStart && cd < seasonEnd;
    };
    const sObsChrono = (seasonObsMap.get(label) || []).slice()
      .sort((a, b) => parseDate(a.observation_time_utc).getTime() - parseDate(b.observation_time_utc).getTime());
    const clutches = segmentClutches(sObsChrono);
    // Chippings at this box count as nest attendance for pair detection — e.g. an
    // adult chipped while guarding chicks is a parent even if never scanned in an
    // observation. Dedup: a bird chipped AND scanned here on the same NZ day is one
    // visit, so the chip event is dropped in favour of the scan.
    const scannedDays = new Map<string, Set<string>>();
    for (const o of sObsChrono) {
      const day = toNzDateStr(o.observation_time_utc);
      for (const s of o.scans) {
        const k = s.pit_id.slice(-8);
        if (!scannedDays.has(k)) scannedDays.set(k, new Set());
        scannedDays.get(k)!.add(day);
      }
    }
    const chipEvents: { key: string; t: number }[] = [];
    for (const p of (allPenguinsInBox || [])) {
      if (!p.is_chipped_here || !p.chip_date || !p.pit_id) continue;
      const cd = new Date(p.chip_date);
      if (cd < seasonStart || cd >= seasonEnd) continue;
      const key = p.pit_id.slice(-8);
      if (scannedDays.get(key)?.has(p.chip_date.slice(0, 10))) continue;
      chipEvents.push({ key, t: cd.getTime() });
    }
    const pairs = clutches.map(c => detectClutchPair(c, sObsChrono, birdMap, chippedThisSeason, chipEvents));
    const parentKeys = new Set<string>();
    for (const pair of pairs) if (pair) { if (pair.male) parentKeys.add(pair.male); if (pair.female) parentKeys.add(pair.female); }

    // Assign each season chick to the clutch whose window holds its chip date; chips
    // land at the end of an attempt, so otherwise default to the last detected family.
    const familyIdxs = pairs.map((p, i) => p ? i : -1).filter(i => i >= 0);
    const chickFamily = new Map<string, number>();
    for (const b of birdMap.values()) {
      const k = b.pit_id.slice(-8);
      if (!chippedThisSeason(b) || parentKeys.has(k)) continue;
      const ct = new Date(b.chip_date!).getTime();
      let fi = clutches.findIndex((c, i) => pairs[i] && ct >= c.windowStart && ct <= c.windowEnd);
      if (fi < 0 && familyIdxs.length > 0) fi = familyIdxs[familyIdxs.length - 1];
      if (fi >= 0) chickFamily.set(k, fi);
    }

    // Sort birds: M, F, unsexed (sex guesses count); within a group by scan count descending
    const birds = Array.from(birdMap.values()).sort((a, b) => {
      const diff = sexSortOrder(a) - sexSortOrder(b);
      if (diff !== 0) return diff;
      return b.scanCount - a.scanCount;
    });

    const families: BoxFamily[] = clutches.map((clutch, ci) => {
      const pair = pairs[ci];
      const male = pair?.male || '', female = pair?.female || '';
      const parents = pair ? [birdMap.get(male), birdMap.get(female)].filter(Boolean) : [];
      const chicks = birds.filter(b => chickFamily.get(b.pit_id.slice(-8)) === ci);
      // Offspring at FINAL life stage: egg that never hatched, chick never chipped.
      const failedEggs = Math.min(Math.max(0, clutch.maxEggs - clutch.maxChicks), 4);
      const unchipped = Math.max(0, Math.min(clutch.maxChicks, 4) - chicks.length);
      // Of the never-chipped chicks, those a monitor logged as presumed-fledged (summed
      // over this clutch's observations) render as fledged rather than assumed-died. Cap
      // at the unchipped count so an over-entry can't invent chicks.
      const fledgedUnchipped = Math.min(unchipped, sObsChrono.reduce((s, o) => {
        const t = parseDate(o.observation_time_utc).getTime();
        return (t >= clutch.start && t <= (clutch.end ?? Infinity)) ? s + (Number(o.fledged_unchipped) || 0) : s;
      }, 0));
      const plainChicks = unchipped - fledgedUnchipped;
      return { clutch, male, female, parents, chicks, failedEggs, plainChicks, fledgedUnchipped };
    });

    result.push({ label, seasonYear, seasonStart, seasonEnd, seasonObs: sObsChrono, birds, birdMap, clutches, families, parentKeys, chickFamily, isCurrent: label === currentLabel });
  }
  return result;
}

function SeasonBirdsSection({ label, birds, seasonStatus, statusLabel, latestObs,
  onSeasonClick, issueBadges, dayToObsTime, clutches, visitorBirds, visitorRow, aggSlots, renderClutch }: any) {
  return (
    <div className="season-birds">
      <div className="season-year">
        <div className={`season-yr${latestObs ? ' clickable' : ''}`}
          onClick={latestObs ? () => onSeasonClick?.(latestObs) : undefined}>
          {seasonRange(label)}
        </div>
        <div className="season-birdcount">{birds.length} bird{birds.length !== 1 ? 's' : ''}</div>
        <span className={`season-status st-${seasonStatus}`}><span className="ss-dot" />{statusLabel}</span>
      </div>
      <div className="season-content">
        {issueBadges.length > 0 && (
          <div className="season-issues">
            {issueBadges.map((b: any) => (
              <span key={b.key} className="issue-badge">
                {'\u26A0'} {b.detail.length} {b.label}{b.detail.length !== 1 ? 's' : ''}
                <span className="issue-tip">
                  {b.detail.map((d: any, i: number) => {
                    const t = dayToObsTime.get(d.day);
                    return (
                      <a key={i} className={`issue-row${t ? ' clickable' : ''}`} onClick={t ? () => onSeasonClick?.(t) : undefined}>{d.text}</a>
                    );
                  })}
                </span>
              </span>
            ))}
          </div>
        )}
        {clutches.length === 0 ? (
          visitorRow('Seen in box', visitorBirds.map((b: any) => ({ b, n: b.scanCount })))
        ) : (() => {
          const nodes: React.ReactNode[] = [];
          const post = visitorRow('Post-breeding', aggSlots([`g${clutches.length}`]));
          if (post) nodes.push(post);
          for (let ci = clutches.length - 1; ci >= 0; ci--) {
            nodes.push(renderClutch(ci));
            if (ci > 0) { const between = visitorRow(`Between ${ordinal(ci)} & ${ordinal(ci + 1)} clutch`, aggSlots([`g${ci}`])); if (between) nodes.push(between); }
          }
          const pre = visitorRow('Pre-breeding', aggSlots(['g0']));
          if (pre) nodes.push(pre);
          return nodes;
        })()}
      </div>
    </div>
  );
}

function AllScannedBirds({ observations, onBirdClick, allPenguinsInBox, onSeasonClick, children }: { observations: Observation[]; onBirdClick: (tag:string)=>void; allPenguinsInBox?: any[]; onSeasonClick?: (obsTime: string) => void; children?: React.ReactNode }) {
  const seasonData = computeBoxFamilies(observations, allPenguinsInBox);
  const isMobile = typeof window !== 'undefined' && window.innerWidth <= 700;
  const [prevExpanded, setPrevExpanded] = useState(false);
  const currentSeasons: React.ReactNode[] = [];
  const previousSeasons: React.ReactNode[] = [];

  seasonData.forEach(({ label, seasonStart, seasonEnd, seasonObs: sObsChrono, birds, clutches, families, parentKeys, chickFamily, isCurrent }) => {
        if (birds.length === 0 && sObsChrono.length === 0 && !isCurrent) return;
        const sorted = birds;

        // Every non-family sighting is placed in a slot by WHEN it happened: inside a
        // breeding window (`w<ci>`, shown as a visitor beside that family box) or in a
        // gap between/around windows (`g<gi>`, gi = index of the next window, so g0 is
        // before the first and g<n> is after the last). A bird seen across several
        // slots appears in each, its per-slot counts summing to its season visits.
        const slotCounts = new Map<string, Map<string, number>>();
        const bump = (k: string, slot: string, n: number) => {
          if (!slotCounts.has(k)) slotCounts.set(k, new Map());
          const m = slotCounts.get(k)!;
          m.set(slot, (m.get(slot) || 0) + n);
        };
        // Family-box birds (parents/chicks) get a count PER clutch window, keyed
        // `<ci>|<key>` — so a parent shared by both clutches shows its actual sightings
        // in each window, not the season total repeated on every row.
        const winCount = new Map<string, number>();
        const scannedDayKey = new Set<string>(); // `<key>|<nzDay>` — days a bird was actually scanned here
        for (const o of sObsChrono) {
          const t = parseDate(o.observation_time_utc).getTime();
          const oDay = toNzDateStr(o.observation_time_utc);
          let slot = '', wci = -1;
          for (let ci = 0; ci < clutches.length; ci++) {
            if (t >= clutches[ci].windowStart && t <= clutches[ci].windowEnd) { slot = `w${ci}`; wci = ci; break; }
          }
          if (!slot) { let gi = 0; while (gi < clutches.length && t >= clutches[gi].windowStart) gi++; slot = `g${gi}`; }
          const seen = new Set<string>();
          for (const s of o.scans) {
            const k = s.pit_id.slice(-8);
            scannedDayKey.add(`${k}|${oDay}`);
            if (seen.has(k)) continue; // one visit per observation
            seen.add(k);
            if (parentKeys.has(k) || chickFamily.has(k)) {
              if (wci >= 0) winCount.set(`${wci}|${k}`, (winCount.get(`${wci}|${k}`) || 0) + 1);
              continue;
            }
            bump(k, slot, 1);
          }
        }
        // A family bird (parent/chick) chipped in this box counts as one nest visit on its
        // chip day even if it was never scanned in an observation — otherwise a chick chipped
        // here but never scanned lands in its clutch window with a 0 count and no badge.
        // Deduped against a same-day scan so a bird scanned while being chipped isn't double-counted.
        for (const b of sorted) {
          const k = b.pit_id.slice(-8);
          if (!(parentKeys.has(k) || chickFamily.has(k))) continue;
          if (!b.is_chipped_here || !b.chip_date) continue;
          const day = String(b.chip_date).slice(0, 10);
          if (scannedDayKey.has(`${k}|${day}`)) continue;
          const t = parseDate(day + ' 00:00:00').getTime();
          const wci = clutches.findIndex(c => t >= c.windowStart && t <= c.windowEnd);
          if (wci >= 0) winCount.set(`${wci}|${k}`, (winCount.get(`${wci}|${k}`) || 0) + 1);
        }
        // Birds chipped here but never scanned have no observation to slot — place them
        // by chip date (their lastSeen) in the matching gap.
        for (const b of sorted) {
          const k = b.pit_id.slice(-8);
          if (parentKeys.has(k) || chickFamily.has(k) || slotCounts.has(k)) continue;
          const ls = b.lastSeen || '';
          const t = parseDate(ls.length > 10 ? ls : ls + ' 00:00:00').getTime();
          let gi = 0; while (gi < clutches.length && t >= clutches[gi].windowStart) gi++;
          bump(k, `g${gi}`, Math.max(1, b.scanCount || 0));
        }
        // Season context: a bird chipped as a chick during the listed season renders
        // as a chick (pale yellow) — we're looking at it during its chick time. The
        // context date is the day AFTER chipping so the same-day chipped-here (green)
        // styling never applies here. In later seasons the bird renders as an adult.
        const seasonObsDate = (b: any) => {
          if (!b.chipped_as_adult && b.chip_date) {
            const cd = new Date(b.chip_date);
            if (cd >= seasonStart && cd < seasonEnd) return chickContextDate(b.chip_date);
          }
          return undefined;
        };

        const birdWithCount = (b: any, count?: number) => {
          const n = count ?? b.scanCount;
          return (
            <span key={b.pit_id.slice(-8)} className="bird-with-count">
              <PenguinMini scan={b} onClick={() => onBirdClick(b.peng_num || b.pit_id)} observationDate={seasonObsDate(b)} />
              {n > 0 && <span className="scan-count">{n}x</span>}
            </span>
          );
        };

        // Newest observation in this season — the scroll/expand target for the matching
        // season section in the observation list lower on the page.
        const latestObs = sObsChrono.reduce((m, o) => o.observation_time_utc > m ? o.observation_time_utc : m, '');
        const issues = seasonDataIssues(sObsChrono);
        const issueBadges = [
          { key: 'dupobs', label: 'duplicate observation', detail: issues.dupObs },
          { key: 'conflict', label: 'same-sex conflict', detail: issues.conflicts },
          { key: 'dupscan', label: 'duplicate scan', detail: issues.dupScans },
        ].filter(b => b.detail.length > 0);
        // NZ day → newest observation that day, so an issue row can scroll to it.
        const dayToObsTime = new Map<string, string>();
        for (const o of sObsChrono) {
          const day = toNzDateStr(o.observation_time_utc);
          const prev = dayToObsTime.get(day);
          if (!prev || o.observation_time_utc > prev) dayToObsTime.set(day, o.observation_time_utc);
        }

        // Season outcome colour: grey = no eggs, green = a chipped chick, blue = eggs still active,
        // red = eggs but concluded with no chipped chick.
        const seasonHasChick = families.some((f: any) => f.chicks.length > 0);
        const seasonActive = families.some((f: any) => clutchActive(f.clutch));
        const seasonStatus = clutches.length === 0 ? 'none' : seasonHasChick ? 'bred' : seasonActive ? 'active' : 'fail';
        const statusLabel = seasonStatus === 'none' ? 'No breeding' : seasonStatus === 'bred' ? 'Bred' : seasonStatus === 'active' ? 'Active' : 'Failed';
        // Everything not part of a detected clutch is a visitor, shown once with its season total.
        const visitorBirds = sorted.filter((b: any) => { const k = b.pit_id.slice(-8); return !parentKeys.has(k) && !chickFamily.has(k); });
        // Visitors sit in gap slots by WHEN they were seen: g0 = before the first window (pre),
        // g<ci> = between clutch ci-1 and ci, g<n> = after the last window (post). Birds seen inside
        // a window show in that clutch's card. Rendered reverse-chronological (newest on top).
        const aggSlots = (slots: string[]) => sorted
          .map((b: any) => { const k = b.pit_id.slice(-8); let n = 0; for (const s of slots) n += slotCounts.get(k)?.get(s) || 0; return { b, n }; })
          .filter((x: any) => x.n > 0);
        const visitorRow = (label: string, list: { b: any; n: number }[]) => list.length > 0 ? (
          <div className="season-visitors" key={label}>
            <span className="visitors-lbl">{label}</span>
            <span className="visitors-list">{list.map(x => birdWithCount(x.b, x.n))}</span>
          </div>
        ) : null;
        const renderClutch = (ci: number) => {
          const { clutch, parents: pairBirds, chicks: famChicks, failedEggs, plainChicks, fledgedUnchipped } = families[ci];
          const active = clutchActive(clutch);
          // green = a chipped chick; blue = eggs still active; red = eggs, no chipped chick.
          const cardStatus = famChicks.length > 0 ? 'bred' : active ? 'active' : 'fail';
          const inNest = aggSlots([`w${ci}`]); // non-pair birds seen inside this window
          return (
            <div key={`cl${ci}`} className={`clutch-card ${cardStatus}`}>
              {clutches.length > 1 && (
                <div className={`clutch-label${clutch.startObsTime ? ' clickable' : ''}`}
                  title="Go to where the egg/chick was first detected"
                  onClick={clutch.startObsTime ? () => onSeasonClick?.(clutch.startObsTime) : undefined}>{ordinal(ci + 1)} clutch</div>
              )}
              {clutch.laidFailed && (
                <div className="season-issues">
                  <span className={`issue-badge${clutch.startObsTime ? ' clickable' : ''}`}
                    title="Go to where the egg/chick was first detected"
                    onClick={clutch.startObsTime ? () => onSeasonClick?.(clutch.startObsTime) : undefined}>⚠ laid date could not be estimated</span>
                </div>
              )}
              <div className="clutch-body">
                <span className="clutch-birds">
                  {pairBirds.map(b => birdWithCount(b, winCount.get(`${ci}|${b.pit_id.slice(-8)}`) || 0))}
                  {famChicks.map(b => {
                    const k = b.pit_id.slice(-8);
                    // A chick belongs to exactly one clutch, so credit its full box attendance
                    // to it rather than window-clipping — chicks are chipped/scanned around
                    // fledge, which lands at or past windowEnd and would otherwise show 0.
                    return birdWithCount(b, Math.max(b.scanCount || 0, winCount.get(`${ci}|${k}`) || 0));
                  })}
                  {Array.from({ length: failedEggs }).map((_, i) => <OffspringFinal key={`fe${i}`} kind="egg" active={active} />)}
                  {Array.from({ length: plainChicks }).map((_, i) => <OffspringFinal key={`pc${i}`} kind="chick" active={active} />)}
                  {Array.from({ length: fledgedUnchipped }).map((_, i) => (
                    <span key={`fu${i}`} className="scan chick offspring-fledged" title="Last sighting of unchipped chick, presumed fledged">Unchipped</span>
                  ))}
                </span>
                <span className="clutch-meta">
                  <ClutchPredictions clutch={clutch} />
                  <span className={`clutch-dates${clutch.startObsTime ? ' clickable' : ''}`}
                    title="Go to where the egg/chick was first detected"
                    onClick={clutch.startObsTime ? () => onSeasonClick?.(clutch.startObsTime) : undefined}>{windowRange(clutch)}</span>
                </span>
              </div>
              {inNest.length > 0 && (
                <div className="clutch-visitors"><span className="visitors-lbl">Also in nest</span><span className="visitors-list">{inNest.map(x => birdWithCount(x.b, x.n))}</span></div>
              )}
            </div>
          );
        };

        const node = (
          <SeasonBirdsSection key={label} label={label} birds={birds}
            seasonStatus={seasonStatus} statusLabel={statusLabel} latestObs={latestObs}
            onSeasonClick={onSeasonClick} issueBadges={issueBadges} dayToObsTime={dayToObsTime}
            clutches={clutches} visitorBirds={visitorBirds} visitorRow={visitorRow}
            aggSlots={aggSlots} renderClutch={renderClutch} />
        );
        if (isCurrent) currentSeasons.push(node);
        else previousSeasons.push(node);
      });

  const prevCount = previousSeasons.length;
  return (
    <div className="all-birds">
      {currentSeasons}
      {prevCount > 0 && isMobile ? (
        <>
          <div className="season-divider clickable" onClick={() => setPrevExpanded(!prevExpanded)}>
            <hr/><span>Previous seasons ({prevCount}) {prevExpanded ? '\u25B2' : '\u25BC'}</span><hr/>
          </div>
          {prevExpanded && <>{previousSeasons}{children}</>}
        </>
      ) : <>{previousSeasons}{children}</>}
    </div>
  );
}

function ObsCard({ obs, onBirdClick, onDayClick, highlight, scrollTo, token, canEdit, allPenguins, hideDate, onDataChange }: { obs: Observation; onBirdClick?: (tag:string)=>void; onDayClick?: (day:string)=>void; highlight?: boolean; scrollTo?: boolean; token?: string; canEdit?: boolean; allPenguins?: any[]; hideDate?: boolean; onDataChange?: ()=>void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [flashing, setFlashing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [editCount, setEditCount] = useState(parseInt(String(obs.edit_count || '0')) || 0);
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
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [birdSearch, setBirdSearch] = useState('');
  // Quick radial breeding-status picker on a locked (non-edit) observation — the only
  // field editable without entering edit mode. Writes the single field directly.
  const [statusPicker, setStatusPicker] = useState(false);
  const [pickerPos, setPickerPos] = useState<{x:number;y:number} | null>(null);
  const [statusOverride, setStatusOverride] = useState<string | null>(null);
  const effectiveStatus = statusOverride ?? localObs.breeding_status ?? '';
  useEffect(() => { setStatusOverride(null); }, [obs.breeding_status, obsId]);
  const pickStatus = async (val: string) => {
    setStatusPicker(false);
    if (val === (localObs.breeding_status || '')) return;
    setStatusOverride(val);
    if (obsId && token) {
      await updateRecord(token, 'observations', obsId, { breeding_status: val });
      setEditCount(c => c + 1);
      onDataChange?.();
    }
  };

  // Edit mode is a local DRAFT — nothing is written to the server until "Done"
  // (Cancel discards). This removes the silent last-write-wins where each field saved
  // live, letting a second editor's stale view clobber the first's data.
  type Draft = { adults:number; eggs:number; chicks:number; breeding_status:string; gate_status:string; notes:string; no_scan:number; fledged_unchipped:number };
  const [draft, setDraft] = useState<Draft|null>(null);
  const [draftScans, setDraftScans] = useState<Scan[]>([]);
  const setField = (f: keyof Draft, v: any) => setDraft(d => d ? { ...d, [f]: v } : d);
  const scanKey = (s: any) => String(s.scan_id ?? s.pit_id);

  const startEdit = () => {
    setDraft({
      adults: Number(obs.adults)||0, eggs: Number(obs.eggs)||0, chicks: Number(obs.chicks)||0,
      breeding_status: obs.breeding_status || '', gate_status: obs.gate_status || '',
      notes: obs.notes || '', no_scan: Number(obs.no_scan)||0, fledged_unchipped: Number(obs.fledged_unchipped)||0,
    });
    setDraftScans([...obs.scans]);
    setEditing(true);
  };
  const cancelEdit = () => { setEditing(false); setDraft(null); setDraftScans([]); setBirdSearch(''); };

  const filteredAdd = birdSearch.length > 0 && allPenguins
    ? allPenguins.filter((p: any) =>
        (p.peng_num === birdSearch || (p.pit_id && p.pit_id.includes(birdSearch)))
        && !draftScans.some(s => s.pit_id === p.pit_id)
      ).slice(0, 8)
    : [];

  // Adding/removing a penguin bumps the matching count in the draft (chick if chipped as
  // a chick < 3 months before this obs, else adult); it's all committed together on Done.
  const countField = (s: any): keyof Draft => isChickAtObsDate(s.chip_date, s.chipped_as_adult, obs.observation_time_utc) ? 'chicks' : 'adults';
  const draftAddScan = (p: any) => {
    if (!draft || draftScans.some(s => s.pit_id === p.pit_id)) return;
    const f = countField(p);
    setDraftScans([...draftScans, { peng_num: p.peng_num, pit_id: p.pit_id, sex: p.sex, life_stage: p.life_stage, chip_date: p.chip_date, chipped_as_adult: p.chipped_as_adult }]);
    setField(f, (Number(draft[f]) || 0) + 1);
    setBirdSearch('');
  };
  const draftRemoveScan = (scan: any) => {
    if (!draft) return;
    const f = countField(scan);
    setDraftScans(draftScans.filter(s => scanKey(s) !== scanKey(scan)));
    setField(f, Math.max(0, (Number(draft[f]) || 0) - 1));
  };
  // A "no scan" is an adult that was present but couldn't be scanned, so it counts
  // toward the adult total — add/remove it in step with the adult count.
  const draftAddNoScan = () => { if (draft) { setField('no_scan', (draft.no_scan || 0) + 1); setField('adults', (draft.adults || 0) + 1); } };
  const draftRemoveNoScan = () => { if (draft && (draft.no_scan || 0) > 0) { setField('no_scan', (draft.no_scan || 0) - 1); setField('adults', Math.max(0, (draft.adults || 0) - 1)); } };

  // Commit the whole draft on Done: one observations update for changed fields, plus
  // create/delete for added/removed scans. Nothing was written before this point.
  const commit = async () => {
    if (!obsId || !token || !draft) { cancelEdit(); return; }
    const fields: Record<string, any> = {};
    for (const f of ['adults','eggs','chicks','no_scan','fledged_unchipped'] as (keyof Draft)[]) if (Number((obs as any)[f]||0) !== Number(draft[f]||0)) fields[f] = Number(draft[f]||0);
    for (const f of ['breeding_status','gate_status','notes'] as (keyof Draft)[]) if (((obs as any)[f]||'') !== (draft[f]||'')) fields[f] = draft[f] || null;
    const draftKeys = new Set(draftScans.map(scanKey));
    const toAdd = draftScans.filter(s => !s.scan_id);
    const toRemove = obs.scans.filter((s: any) => s.scan_id && !draftKeys.has(scanKey(s)));
    const changed = Object.keys(fields).length + toAdd.length + toRemove.length;
    if (changed === 0) { cancelEdit(); return; }
    const reason = prompt(`Save ${changed} change${changed===1?'':'s'} to this observation?\n\nReason (optional):`);
    if (reason === null) return; // cancelled — stay in edit mode
    setEditing(false);
    try {
      if (Object.keys(fields).length > 0) await updateRecord(token, 'observations', obsId, fields, reason || undefined);
      for (const p of toAdd) await createRecord(token, 'penguin_scans', { observation_id: obsId, pit_id: p.pit_id, scan_time_utc: obs.observation_time_utc });
      for (const s of toRemove) await deleteRecord(token, 'penguin_scans', s.scan_id!);
      setEditCount(c => c + 1);
    } finally {
      setDraft(null); setDraftScans([]); setBirdSearch('');
      onDataChange?.();
    }
  };

  return (
    <div ref={ref} className={`obs-card ${flashing ? 'highlighted' : ''}${highlight ? ' obs-pinned' : ''}`} style={deleting ? {opacity: 0.4, pointerEvents: 'none'} : undefined}>
      <div className="obs-top">
        {!hideDate && <span><b><DateLink date={obs.observation_time_utc} onDayClick={onDayClick} /></b> <span className="muted small">{obs.monitor_filename}</span></span>}
        <span className="obs-top-right">
          {canEdit && editCount > 0 && obsId && <span className="edit-badge clickable" onClick={() => setShowHistory(!showHistory)}>{editCount === 1 ? 'edited' : `${editCount} edits`}</span>}
          {canEdit && obsId && !editing && <button className="edit-btn" onClick={startEdit}>Edit</button>}
          {editing && <>
            <button className="edit-btn" onClick={cancelEdit}>Cancel</button>
            <button className="edit-btn done-btn" onClick={commit}>Done</button>
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
            {(() => {
              const ds = displayStatus(effectiveStatus, localObs.eggs, localObs.chicks);
              const clickable = canEdit && !!obsId && !!token;
              return (
                <span className="status-anchor">
                  <span
                    className={`badge ${ds && DARK_TEXT_STATUSES.has(ds)?'bordered':''}${clickable?' clickable':''}`}
                    style={{background:STATUS_COLORS[ds||'']||'#ccc',color:ds && DARK_TEXT_STATUSES.has(ds)?'#333':'#fff'}}
                    onClick={clickable ? (e) => {
                      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      const m = 84; // keep the whole ring inside the viewport
                      const x = Math.min(Math.max(r.left + r.width / 2, m), window.innerWidth - m);
                      const y = Math.min(Math.max(r.top + r.height / 2, m), window.innerHeight - m);
                      setPickerPos({ x, y });
                      setStatusPicker(v => !v);
                    } : undefined}
                    title={clickable ? 'Change breeding status' : (STATUS_NAMES[ds||'']||undefined)}
                  >{ds || '\u2014'}</span>
                  {statusPicker && pickerPos && createPortal((
                    <>
                      <div className="status-picker-backdrop" onClick={() => setStatusPicker(false)} />
                      {/* Rendered viewport-fixed via portal so overflow-clipping ancestors and the
                          box grid's stacking context can't hide or crop the ring. */}
                      <div className="status-picker" style={{left:pickerPos.x, top:pickerPos.y}} onClick={e => e.stopPropagation()}>
                        {STATUS_PICK_OPTIONS.map((opt, i) => {
                          const n = STATUS_PICK_OPTIONS.length;
                          const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
                          const r = 56;
                          const x = Math.cos(angle) * r, y = Math.sin(angle) * r;
                          const isCur = opt === (effectiveStatus || '');
                          return (
                            <button key={opt} type="button"
                              className={`status-pick-item${DARK_TEXT_STATUSES.has(opt)?' bordered':''}${isCur?' current':''}`}
                              style={{transform:`translate(-50%,-50%) translate(${x}px, ${y}px)`, background:STATUS_COLORS[opt]||'#ccc', color:DARK_TEXT_STATUSES.has(opt)?'#333':'#fff'}}
                              title={STATUS_NAMES[opt]||opt} onClick={() => pickStatus(opt)}>{opt}</button>
                          );
                        })}
                      </div>
                    </>
                  ), document.body)}
                </span>
              );
            })()}
            {localObs.adults === 0 && localObs.eggs === 0 && localObs.chicks === 0 && <span className="muted">Empty</span>}
            {localObs.adults > 0 && <span>{'\uD83D\uDC27'.repeat(Math.min(localObs.adults, 6))}</span>}
            {localObs.eggs > 0 && <span>{'\uD83E\uDD5A'.repeat(Math.min(localObs.eggs, 6))}</span>}
            {localObs.chicks > 0 && <span>{'\uD83D\uDC23'.repeat(Math.min(localObs.chicks, 6))}</span>}
            {localObs.gate_status && <span className="gate">{localObs.gate_status}</span>}
            {[...obs.scans].sort(scanSortMFC).map((s,j) => (
              <PenguinMini key={j} scan={s} onClick={() => onBirdClick?.(s.peng_num || s.pit_id)} observationDate={obs.observation_time_utc} />
            ))}
            {Array.from({ length: Number(obs.no_scan) || 0 }).map((_, k) => (
              <span key={`ns${k}`} className="scan no-scan">No scan</span>
            ))}
          </div>
          {localObs.notes && <div className="obs-notes">{localObs.notes}</div>}
        </>
      ) : (
        <>
        <div className="obs-edit-birds">
          {[...draftScans].sort(scanSortMFC).map(s => (
            <span key={scanKey(s)} className="scan-removable">
              <PenguinMini scan={s} onClick={() => onBirdClick?.(s.peng_num || s.pit_id)} observationDate={obs.observation_time_utc} />
              <button className="remove-scan" onClick={() => draftRemoveScan(s)}>&times;</button>
            </span>
          ))}
          {Array.from({ length: draft?.no_scan || 0 }).map((_, k) => (
            <span key={`ns${k}`} className="scan-removable">
              <span className="scan no-scan">No scan</span>
              <button className="remove-scan" onClick={draftRemoveNoScan}>&times;</button>
            </span>
          ))}
          <div className="add-scan-search">
            <input className="ef-input" placeholder="Add penguin #..." value={birdSearch} onChange={e => setBirdSearch(e.target.value)} />
            {filteredAdd.length > 0 && (
              <div className="add-scan-results">
                {filteredAdd.map((p: any) => (
                  <div key={p.pit_id} className="add-scan-option" onClick={() => draftAddScan(p)}>
                    <PenguinMini scan={p} onClick={() => draftAddScan(p)} />
                  </div>
                ))}
              </div>
            )}
          </div>
          <button type="button" className="add-noscan-btn" onClick={draftAddNoScan}>Add no scan</button>
        </div>
        <div className="obs-edit-row">
          <label>{'\uD83D\uDC27'}</label><EditableField value={draft?.adults ?? 0} type="number" onSave={async v => { setField('adults', v == null ? 0 : v); }} canEdit={true} inline narrow min={0} />
          <label>{'\uD83E\uDD5A'}</label><EditableField value={draft?.eggs ?? 0} type="number" onSave={async v => { setField('eggs', v == null ? 0 : v); }} canEdit={true} inline narrow min={0} />
          <label>{'\uD83D\uDC23'}</label><EditableField value={draft?.chicks ?? 0} type="number" onSave={async v => { setField('chicks', v == null ? 0 : v); }} canEdit={true} inline narrow min={0} />
          <label title="Unchipped chicks presumed fledged">{'\uD83D\uDD4A'}</label><EditableField value={draft?.fledged_unchipped ?? 0} type="number" onSave={async v => { setField('fledged_unchipped', v == null ? 0 : v); }} canEdit={true} inline narrow min={0} />
          <EditableField value={draft?.breeding_status ?? ''} type="select" options={['','CON','POT','UNL','NO','DCM','ABN','IGN']} onSave={async v => { setField('breeding_status', v || ''); }} canEdit={true} placeholder="Nest status" />
          <EditableField value={draft?.gate_status ?? ''} type="select" options={['','Gate up','Regate']} onSave={async v => { setField('gate_status', v || ''); }} canEdit={true} placeholder="Gate status" />
          <EditableField value={draft?.notes ?? ''} onSave={async v => { setField('notes', v || ''); }} placeholder="notes" canEdit={true} inline multiline />
        </div>
        </>
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
  const focused = useRef(false);
  // The last value we committed via onSave. Guards against a single edit firing onSave
  // more than once — native date pickers emit several blur events, and each blur would
  // otherwise re-run onSave (and its reason prompt). Kept in sync with the prop.
  const lastSaved = useRef(String(value ?? ''));

  useEffect(() => { if (editing && ref.current) ref.current.focus(); }, [editing]);
  // Inline fields write through to the parent draft on every change (below), which
  // bumps `value`. Don't resync (and clobber the caret / an in-progress entry) while
  // the field is focused — only when the value changes from outside.
  useEffect(() => { if (!focused.current) { setDraft(String(value ?? '')); lastSaved.current = String(value ?? ''); } }, [value]);

  const display = value !== null && value !== undefined && value !== '' ? String(value) : null;
  const flash = () => { setSaved(true); setTimeout(() => setSaved(false), 2000); };

  // Selects always render as a live dropdown, so a blank value is obviously
  // settable (shows the placeholder, e.g. "Nest status") rather than a "-".
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
    if (saving) return;
    let val = type === 'number' ? (draft === '' ? null : parseFloat(draft)) : (draft || null);
    if (type === 'number' && val !== null && min !== undefined && (val as number) < min) val = min;
    const valStr = String(val ?? '');
    // Nothing actually changed since the last commit — close without re-saving (and
    // without re-prompting for a reason). This is what collapses a date field's repeat
    // blur events into a single save.
    if (valStr === lastSaved.current) { setEditing(false); return; }
    lastSaved.current = valStr; // set before awaiting so a concurrent blur is a no-op
    setSaving(true);
    await onSave(val);
    setDraft(valStr); // resync display to the (possibly clamped) saved value
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
          onFocus={() => { focused.current = true; }}
          onChange={e => { setDraft(e.target.value); onSave(e.target.value || null); }}
          onBlur={() => { focused.current = false; }}
          onKeyDown={e => { if (e.key === 'Escape') cancel(); }} />
      );
    }
    return (
      <input ref={ref as any} className={`ef-input${narrow ? ' ef-narrow' : ''}`} type={type || 'text'} value={draft} disabled={saving}
        placeholder={placeholder} min={min}
        onFocus={() => { focused.current = true; }}
        onChange={e => {
          const raw = e.target.value;
          setDraft(raw);
          let val: any = type === 'number' ? (raw === '' ? null : parseFloat(raw)) : (raw || null);
          if (type === 'number' && val !== null && min !== undefined && (val as number) < min) val = min;
          onSave(val);
        }}
        onBlur={() => { focused.current = false; setDraft(String(value ?? '')); }}
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

/** A chipping event shown as a sighting card: green left border (vs blue for
 *  observations), date + bird mini + "Chipped by X" — no adult/egg/chick counts,
 *  since a chipping isn't an observation and those values are unknown. Multiple birds
 *  chipped in the same box on the same day share one card (one row per bird). */
function ChipCard({ date, birds, chipBy, scan, box, onBoxClick, onBirdClick, onDayClick }: {
  date: string; birds?: any[]; chipBy?: string | null; scan?: any; box?: string;
  onBoxClick?: (box: string) => void; onBirdClick: (num: string) => void; onDayClick?: (day: string) => void;
}) {
  const list = (birds && birds.length) ? birds : [{ ...scan, chip_by: chipBy }];
  return (
    <div className="obs-card chip-card">
      <div className="obs-top">
        <span><b><DateLink date={date} onDayClick={onDayClick} /></b></span>
        {box && onBoxClick && <a className="bird-chip clickable" href={`/box/${box}`} onClick={e => navClick(e, () => onBoxClick(box))}>Box {box}</a>}
      </div>
      {/* Pass the chip day itself so each mini gets the green chipped-here styling —
          this card IS the chipping event. */}
      {list.map((b: any) => (
        <div className="obs-nums" key={b.pit_id}>
          <PenguinMini scan={b} onClick={() => onBirdClick(b.peng_num)} observationDate={date} />
          <span className="muted">{b.is_rechip ? `Rechipped by ${b.chip_by || '?'}` : `Chipped by ${b.chip_by || '?'}`}</span>
        </div>
      ))}
    </div>
  );
}

/** Collapse adjacent same-day chipping events into a single card carrying every bird
 *  chipped that day (each render site here is scoped to one box, so same chip_date ⇒
 *  same box). Input must already be time-sorted; chip events sit at `<day> 00:00:00`
 *  so same-day ones are contiguous. */
function mergeSameDayChips(items: any[]): any[] {
  const out: any[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it._chip) { out.push(it); continue; }
    const chipBirds = [it];
    while (i + 1 < items.length && items[i + 1]._chip && items[i + 1].chip_date === it.chip_date) {
      chipBirds.push(items[++i]);
    }
    out.push({ ...it, _chipBirds: chipBirds });
  }
  return out;
}

/**
 * Box detail body: "Breeding history" + "Observations". Extracted from the inline box view so
 * the full app and the embed (?embed=1 -> nestcheck box modal) render it from one place and
 * can't drift. Edit affordances (add-penguin, deleted toggle) are gated on canEdit / callbacks.
 */
function BoxPanel({ data, boxName, allPenguins, onBirdClick, onDayClick, highlightObs, scrollToObs, onScrollToObs, token, canEdit, onDataChange, showDeleted, deletedObs, onToggleDeleted, onAddPenguin }: {
  data: any; boxName: string; allPenguins: any[];
  onBirdClick: (tag: string) => void; onDayClick: (day: string) => void;
  highlightObs: string | null; scrollToObs: string | null; onScrollToObs: (date: string) => void;
  token?: string; canEdit?: boolean; onDataChange?: () => void;
  showDeleted?: boolean; deletedObs?: any[]; onToggleDeleted?: () => void; onAddPenguin?: (box: string) => void;
}) {
  const [curSeasonOpen, setCurSeasonOpen] = useState(true);
  // Re-open the current season if a link targets one of its observations.
  useEffect(() => {
    const target = scrollToObs || highlightObs;
    if (target && target >= getSeasonStart().toISOString()) setCurSeasonOpen(true);
  }, [scrollToObs, highlightObs]);
  return (
    <div className="detail-obs">
      <div className="obs-columns">
        <div className="obs-col obs-col-overview">
          <AllScannedBirds observations={data.observations} onBirdClick={onBirdClick} allPenguinsInBox={data.all_penguins}
            onSeasonClick={(t: string) => onScrollToObs(t)}>
            {(() => {
              const chipped = (data.all_penguins || []).filter((p: any) => p.is_chipped_here).sort((a: any, b: any) => (a.chip_date || '').localeCompare(b.chip_date || ''));
              if (chipped.length === 0 && !canEdit) return null;
              return (
                <div className="chipped-here">
                  <div className="muted">Chipped in this box: {chipped.length}</div>
                  <div className="bird-row">
                    {chipped.map((c: any) => {
                      const cur = allPenguins?.find((p: any) => p.peng_num === c.peng_num);
                      return (
                      <span key={c.pit_id} className="bird-with-count">
                        <PenguinMini scan={cur ? {...c, hasReturned: cur.hasReturned} : c} onClick={() => onBirdClick(c.peng_num)} observationDate={c.chip_date ? chickContextDate(c.chip_date) : undefined} />
                        <span className="scan-count">{c.chip_date ? getSeasonLabel(parseDate(c.chip_date)) : ''}{c.chip_by ? ` ${c.chip_by}` : ''}</span>
                      </span>
                      );
                    })}
                    {canEdit && onAddPenguin && <button className="add-penguin-btn" title="Add a penguin chipped in this box" onClick={() => onAddPenguin(boxName)}>+ 🐧</button>}
                  </div>
                </div>
              );
            })()}
          </AllScannedBirds>
        </div>
        <div className="obs-col obs-col-observations">
          {(() => {
            const thisSeasonStart = getSeasonStart().toISOString();
            const thisLabel = getSeasonLabel();
            // Chippings with no matching scan on the chip day become their own sighting card.
            const scannedPitsByDay = new Map<string, Set<string>>();
            for (const o of data.observations) {
              const day = toNzDateStr(o.observation_time_utc);
              if (!scannedPitsByDay.has(day)) scannedPitsByDay.set(day, new Set());
              for (const s of (o.scans || [])) if (s.pit_id) scannedPitsByDay.get(day)!.add(s.pit_id);
            }
            const chipEvents = (data.all_penguins || [])
              .filter((p: any) => p.is_chipped_here && p.chip_date)
              .filter((p: any) => !scannedPitsByDay.get(p.chip_date)?.has(p.pit_id))
              .map((p: any) => ({ ...p, _chip: true, observation_time_utc: `${p.chip_date} 00:00:00` }));
            const byTimeDesc = (a: any, b: any) => b.observation_time_utc.localeCompare(a.observation_time_utc);
            const thisSeason = [...data.observations, ...chipEvents].filter((o: any) => o.observation_time_utc >= thisSeasonStart).sort(byTimeDesc);
            const prevObs = [...data.observations, ...chipEvents].filter((o: any) => o.observation_time_utc < thisSeasonStart).sort(byTimeDesc);
            const prevSeasons = new Map<string, Observation[]>();
            for (const obs of prevObs) {
              const label = getSeasonLabel(parseDate(obs.observation_time_utc));
              if (!prevSeasons.has(label)) prevSeasons.set(label, []);
              prevSeasons.get(label)!.push(obs);
            }
            const sortedPrev = Array.from(prevSeasons.entries()).sort((a, b) => b[0].localeCompare(a[0]));
            const deletedCount = (data as any)?.deleted_count || 0;
            const mergedObs = showDeleted && (deletedObs?.length || 0) > 0
              ? [...thisSeason.map((o: any) => ({...o, _deleted: false})), ...(deletedObs || []).map((o: any) => ({...o, _deleted: true}))]
                .sort((a, b) => b.observation_time_utc.localeCompare(a.observation_time_utc))
              : thisSeason;
            return (<>
              <h3 className="season-heading clickable" onClick={() => setCurSeasonOpen(o => !o)}>{seasonRange(thisLabel)} ({thisSeason.length}) {curSeasonOpen ? '▲' : '▼'}
                {deletedCount > 0 && onToggleDeleted && <span className="deleted-indicator clickable" onClick={(e) => { e.stopPropagation(); onToggleDeleted(); }}> · {showDeleted ? 'hide' : 'show'} {deletedCount} deleted</span>}
              </h3>
              {curSeasonOpen && <>
              {mergedObs.length === 0 && <p className="muted">No observations this season</p>}
              {mergeSameDayChips(mergedObs).map((obs: any, i: number) => obs._deleted ? (
                <div key={`del${obs.observation_id}`} className="obs-card deleted-obs">
                  <div className="obs-top">
                    <span><s><DateLink date={obs.observation_time_utc} onDayClick={onDayClick} /></s></span>
                    <span className="muted">deleted {obs.deleted_at ? formatDate(obs.deleted_at) : ''} by {obs.deleted_by_name || '?'}{obs.delete_reason ? ` — ${obs.delete_reason}` : ''}</span>
                  </div>
                  <div className="obs-nums">
                    {obs.adults === 0 && obs.eggs === 0 && obs.chicks === 0 && <span className="muted">Empty</span>}
                    {obs.adults > 0 && <span>{'🐧'.repeat(Math.min(obs.adults, 6))}</span>}
                    {obs.eggs > 0 && <span>{'🥚'.repeat(Math.min(obs.eggs, 6))}</span>}
                    {obs.chicks > 0 && <span>{'🐣'.repeat(Math.min(obs.chicks, 6))}</span>}
                    {obs.breeding_status && <span className="badge bordered" style={{background:'#E0E0E0', color:'#333'}}>{obs.breeding_status}</span>}
                  </div>
                  {obs.notes && <div className="obs-notes"><s>{obs.notes}</s></div>}
                </div>
              ) : obs._chip ? (
                <ChipCard key={`chip${obs.pit_id}`} date={obs.chip_date} birds={obs._chipBirds} onBirdClick={onBirdClick} onDayClick={onDayClick} />
              ) : (
                <ObsCard key={obs.observation_id || `t${i}`} obs={obs} onBirdClick={onBirdClick} onDayClick={onDayClick} highlight={highlightObs !== null && obs.observation_time_utc === highlightObs} scrollTo={scrollToObs !== null && obs.observation_time_utc === scrollToObs} token={token} canEdit={canEdit} allPenguins={allPenguins} onDataChange={onDataChange} />
              ))}
              </>}
              {sortedPrev.map(([label, obs]) => (
                <CollapsibleSeason key={label} label={label} observations={obs} onBirdClick={onBirdClick} onDayClick={onDayClick} highlightObs={highlightObs} scrollToObs={scrollToObs} token={token} canEdit={canEdit} allPenguins={allPenguins} onDataChange={onDataChange} />
              ))}
            </>);
          })()}
        </div>
      </div>
    </div>
  );
}

// Biometrics for a bird: summary line that expands to per-record view/edit, an add form,
// and a "removed" section (soft-deleted records) with restore. Renders table rows for bird-table.
function BiometricsEditor({ pengNum, biometrics, deleted, token, canEdit, editing }: {
  pengNum: string; biometrics: any[]; deleted: any[]; token?: string; canEdit: boolean; editing: boolean;
}) {
  const [showBio, setShowBio] = useState(false);
  const [showRemoved, setShowRemoved] = useState(false);
  const [adding, setAdding] = useState(false);
  // Every biometric field the DB carries, so nothing is hidden.
  const MEASURES: [string, string, string][] = [['weight', 'Weight', 'g'], ['flipper_length', 'Flipper', 'mm'], ['body_length', 'Body', 'mm'], ['beak_length', 'Beak', 'mm']];
  const FLAGS: [string, string][] = [['is_moulting', 'Moulting'], ['condition_ticks', 'Ticks'], ['condition_healthy', 'Healthy'], ['disposition_aggressive', 'Aggressive'], ['disposition_passive', 'Passive']];
  const emptyForm: any = { observation_date: toNzDateStr(new Date().toISOString()), observed_sex: '', sex: '', notes: '' };
  MEASURES.forEach(([k]) => emptyForm[k] = '');
  FLAGS.forEach(([k]) => emptyForm[k] = false);
  const [form, setForm] = useState<any>(emptyForm);
  const [busy, setBusy] = useState(false);
  const SEX_OPTS = ['', 'PM', 'MM', 'U', 'MF', 'PF'];
  const setF = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));

  if (biometrics.length === 0 && deleted.length === 0 && !editing) return null;

  const saveField = (id: number, field: string) => async (val: any) => {
    if (token) return updateRecord(token, 'penguin_biometric_data', id, { [field]: val === '' ? null : val });
  };
  const toggle = async (b: any, field: string, val: boolean) => { if (token) await updateRecord(token, 'penguin_biometric_data', b.biometric_id, { [field]: val ? 1 : 0 }); };
  const remove = async (b: any) => { if (token && confirm('Remove this biometric record?')) await deleteRecord(token, 'penguin_biometric_data', b.biometric_id); };
  const restore = async (b: any) => { if (token) await updateRecord(token, 'penguin_biometric_data', b.biometric_id, { is_deleted: 0 }); };
  const submitAdd = async () => {
    if (!token || busy) return;
    if (!form.observation_date) { alert('Date is required'); return; }
    setBusy(true);
    const rec: any = { peng_num: pengNum, observation_date: form.observation_date, observed_sex: form.observed_sex || null, sex: form.sex || null, notes: form.notes.trim() || null };
    MEASURES.forEach(([k]) => { if (String(form[k]).trim() !== '') rec[k] = parseFloat(form[k]); });
    FLAGS.forEach(([k]) => { rec[k] = form[k] ? 1 : 0; });
    await createRecord(token, 'penguin_biometric_data', rec);
    setBusy(false); setAdding(false); setForm(emptyForm);
  };

  const sexCounts: Record<string, number> = {};
  const lastComment = biometrics.find((b: any) => b.notes)?.notes;
  const weights = biometrics.filter((b: any) => b.weight).map((b: any) => parseFloat(b.weight));
  const flippers = biometrics.filter((b: any) => b.flipper_length).map((b: any) => parseFloat(b.flipper_length));
  biometrics.forEach((b: any) => { if (b.observed_sex) sexCounts[b.observed_sex] = (sexCounts[b.observed_sex] || 0) + 1; });
  const sexSummary = Object.entries(sexCounts).map(([s, n]) => `sexed ${observedSexLabel(s, true)} ${n}x`).join(', ');
  const range = (vals: number[], unit: string) => { if (!vals.length) return ''; const lo = Math.round(Math.min(...vals)), hi = Math.round(Math.max(...vals)); return `${lo === hi ? lo : `${lo}-${hi}`}${unit}${vals.length > 1 ? ` (${vals.length}x)` : ''}`; };
  const summary = [sexSummary, range(weights, 'g'), range(flippers, 'mm'), lastComment ? `"${lastComment.slice(0, 40)}"` : ''].filter(Boolean).join(' · ');

  const record = (b: any, i: number, removed: boolean) => {
    const flags = FLAGS.filter(([k]) => b[k]).map(([, label]) => label);
    const ed = editing && !removed;
    return (<Fragment key={`${removed ? 'del' : 'bio'}${b.biometric_id ?? i}`}>
      <tr><td className="muted" colSpan={2} style={{ fontWeight: 600, paddingTop: 4, fontSize: 11 }}>
        {ed ? <EditableField value={b.observation_date} type="date" onSave={saveField(b.biometric_id, 'observation_date')} canEdit={true} /> : (b.observation_date || '')}
        {removed && <span className="bird-badge" style={{ background: '#FFCDD2', marginLeft: 6 }}>removed</span>}
        {removed && canEdit && <button className="edit-btn" style={{ marginLeft: 8 }} onClick={() => restore(b)}>Restore</button>}
        {ed && <button className="edit-btn" style={{ marginLeft: 8 }} onClick={() => remove(b)}>Remove</button>}
      </td></tr>
      <tr><td className="muted">Sex</td><td>{ed ? <EditableField value={b.observed_sex} type="select" options={SEX_OPTS} onSave={saveField(b.biometric_id, 'observed_sex')} canEdit={true} placeholder="-" /> : (observedSexLabel(b.observed_sex, false) || <span className="muted">-</span>)}</td></tr>
      {(ed || b.sex) && <tr><td className="muted">Sex (legacy)</td><td>{ed ? <EditableField value={b.sex} onSave={saveField(b.biometric_id, 'sex')} placeholder="-" canEdit={true} /> : b.sex}</td></tr>}
      {MEASURES.map(([k, label, unit]) => (
        (ed || b[k]) ? <tr key={k}><td className="muted">{label}</td><td>{ed ? <><EditableField value={b[k] ? parseFloat(b[k]).toFixed(0) : ''} type="number" onSave={saveField(b.biometric_id, k)} placeholder={unit} canEdit={true} /><span>{unit}</span></> : (b[k] ? `${parseFloat(b[k]).toFixed(0)}${unit}` : <span className="muted">-</span>)}</td></tr> : null
      ))}
      {ed
        ? <tr><td className="muted">Flags</td><td>{FLAGS.map(([k, label]) => <label key={k} style={{ marginRight: 8 }}><input type="checkbox" checked={!!b[k]} onChange={e => toggle(b, k, e.target.checked)} /> {label}</label>)}</td></tr>
        : (flags.length > 0 ? <tr><td className="muted">Flags</td><td>{flags.join(', ')}</td></tr> : null)}
      <tr><td className="muted">Note</td><td style={{ fontSize: 11 }}>{ed ? <EditableField value={b.notes} onSave={saveField(b.biometric_id, 'notes')} placeholder="-" canEdit={true} multiline /> : (b.notes || <span className="muted">-</span>)}</td></tr>
    </Fragment>);
  };

  return (<>
    <tr><td className="muted">Biometrics</td><td className="clickable" onClick={() => setShowBio(!showBio)}>{summary || <span className="muted">-</span>} <span className="muted small">{biometrics.length} records {showBio ? '▲' : '▼'}</span></td></tr>
    {showBio && <>
      {biometrics.map((b, i) => record(b, i, false))}
      {editing && !adding && <tr><td></td><td><button className="edit-btn" onClick={() => setAdding(true)}>+ Add biometric</button></td></tr>}
      {editing && adding && <>
        <tr><td className="muted" colSpan={2} style={{ fontWeight: 600, paddingTop: 6, fontSize: 11 }}>New biometric</td></tr>
        <tr><td className="muted">Date</td><td><input type="date" value={form.observation_date} onChange={e => setF('observation_date', e.target.value)} /></td></tr>
        <tr><td className="muted">Sex</td><td><select value={form.observed_sex} onChange={e => setF('observed_sex', e.target.value)}>{SEX_OPTS.map(s => <option key={s} value={s}>{s ? observedSexLabel(s, false) : '-'}</option>)}</select></td></tr>
        {MEASURES.map(([k, label, unit]) => <tr key={k}><td className="muted">{label}</td><td><input type="number" value={form[k]} onChange={e => setF(k, e.target.value)} placeholder={unit} style={{ width: 80 }} /> {unit}</td></tr>)}
        <tr><td className="muted">Flags</td><td>{FLAGS.map(([k, label]) => <label key={k} style={{ marginRight: 8 }}><input type="checkbox" checked={form[k]} onChange={e => setF(k, e.target.checked)} /> {label}</label>)}</td></tr>
        <tr><td className="muted">Note</td><td><input type="text" value={form.notes} onChange={e => setF('notes', e.target.value)} placeholder="-" /></td></tr>
        <tr><td></td><td><button className="edit-btn done-btn" disabled={busy} onClick={submitAdd}>{busy ? 'Saving…' : 'Save'}</button> <button className="edit-btn" onClick={() => { setAdding(false); setForm(emptyForm); }}>Cancel</button></td></tr>
      </>}
      {deleted.length > 0 && <tr><td></td><td className="clickable muted small" onClick={() => setShowRemoved(!showRemoved)}>{deleted.length} removed {showRemoved ? '▲' : '▼'}</td></tr>}
      {showRemoved && deleted.map((b, i) => record(b, i, true))}
    </>}
  </>);
}

function BirdPage({ data, onBirdClick, onBoxClick, onSightingClick, onDayClick, token, canEdit, onClose }: { data: any; onBirdClick: (tag:string)=>void; onBoxClick: (box:string)=>void; onSightingClick: (box:string, date:string)=>void; onDayClick?: (day:string)=>void; token?: string; canEdit?: boolean; onClose?: () => void }) {
  const p = data.penguin;
  const sightings: any[] = data.sightings || [];
  const biometrics: any[] = data.biometrics || [];
  const partners: any[] = data.partners || [];

  const chips: any[] = p.chips || [];
  const activeChip = chips.find((c: any) => c.is_active == 1) || chips[0];

  const boxes = Array.from(new Set(sightings.map((s: any) => s.box)));

  // When the panel opens or switches bird, subtly lift every mini of this bird on the
  // page so the user sees at a glance where it's referenced, for as long as it's open.
  useEffect(() => {
    openPanelPengNum = p.peng_num || null;
    setSelectedPengMinis([p.peng_num, ...chips.map((c: any) => (c.pit_id || '').slice(-8))]);
    return () => { openPanelPengNum = null; setSelectedPengMinis([]); };
  }, [p.peng_num]);

  // Peng-centric breeding family: run the SAME nest family detection (computeBoxFamilies)
  // over every box this bird was seen/chipped in, then keep the clutches where this bird
  // was a parent (→ partner + offspring) or a chick (→ parents + siblings). Recomputed
  // from `data`, which changes identity whenever the cache updates.
  const { pengFamilies, boxWindows, breedingSeasons } = useMemo(() => {
    const myPits = new Set<string>(chips.map((c: any) => (c.pit_id || '').slice(-8)).filter(Boolean));
    const boxNames = new Set<string>();
    for (const s of sightings) if (s.box) boxNames.add(s.box);
    for (const c of chips) if (c.chip_box) boxNames.add(c.chip_box);
    const isMine = (b: any) => myPits.has((b.pit_id || '').slice(-8));
    type Entry = { season: string; seasonYear: number; box: string; role: 'parent' | 'chick'; fam: BoxFamily; partner?: any; parents: any[]; siblings: any[]; clutchIndex: number; clutchCount: number };
    const entries: Entry[] = [];
    // Per box: every clutch's breeding window, so a shared sighting can be flagged as
    // falling inside a breeding window (and get the black-box treatment).
    const boxWindows = new Map<string, { windowStart: number; windowEnd: number; startObsTime: string; fam: BoxFamily }[]>();
    for (const box of boxNames) {
      const bd = queryBoxDetailSync(box);
      if (!bd?.observations?.length) continue;
      const wins: { windowStart: number; windowEnd: number; startObsTime: string; fam: BoxFamily }[] = [];
      for (const sd of computeBoxFamilies(bd.observations, bd.all_penguins)) {
        const clutchCount = sd.families.length;
        sd.families.forEach((fam, ci) => {
          const c = fam.clutch;
          wins.push({ windowStart: c.windowStart, windowEnd: c.windowEnd, startObsTime: c.startObsTime, fam });
          const asParent = (fam.male && myPits.has(fam.male)) || (fam.female && myPits.has(fam.female));
          const asChick = fam.chicks.some(isMine);
          if (asParent) {
            entries.push({ season: sd.label, seasonYear: sd.seasonYear, box, role: 'parent', fam,
              partner: fam.parents.find(b => !isMine(b)), parents: fam.parents, siblings: [], clutchIndex: ci, clutchCount });
          } else if (asChick) {
            entries.push({ season: sd.label, seasonYear: sd.seasonYear, box, role: 'chick', fam,
              parents: fam.parents, siblings: fam.chicks.filter(b => !isMine(b)), clutchIndex: ci, clutchCount });
          }
        });
      }
      boxWindows.set(box, wins);
    }
    entries.sort((a, b) => b.seasonYear - a.seasonYear || a.box.localeCompare(b.box));
    // Season timeline (newest first): every year between the bird's first and last breeding
    // entry, so seasons it wasn't part of a pair render an explicit "No breeding" row.
    const bySeasonYear = new Map<number, Entry[]>();
    for (const e of entries) { if (!bySeasonYear.has(e.seasonYear)) bySeasonYear.set(e.seasonYear, []); bySeasonYear.get(e.seasonYear)!.push(e); }
    const breedingSeasons: { seasonYear: number; entries: Entry[] }[] = [];
    if (entries.length > 0) {
      const yrs = entries.map(e => e.seasonYear);
      for (let y = Math.max(...yrs); y >= Math.min(...yrs); y--) breedingSeasons.push({ seasonYear: y, entries: bySeasonYear.get(y) || [] });
    }
    return { pengFamilies: entries, boxWindows, breedingSeasons };
  }, [data]);
  // The breeding window (if any) containing a shared sighting, plus its NZ date range.
  const windowFor = (box: string, dateStr: string) => {
    const t = parseDate(dateStr).getTime();
    return (boxWindows.get(box) || []).find(w => t >= w.windowStart && t <= w.windowEnd) || null;
  };
  const [showHistory, setShowHistory] = useState<{table:string;id:number}|null>(null);
  const [hasHistory, setHasHistory] = useState(false);
  const [editing, setEditing] = useState(false);
  const [copiedPit, setCopiedPit] = useState(false);
  const copyPit = (v: string) => { navigator.clipboard?.writeText(v); setCopiedPit(true); setTimeout(() => setCopiedPit(false), 1500); };
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


  return (
    <div className="bird-detail">
      <div className="bird-title-row">
        <span className="bird-title-peng">
          <PenguinMini scan={{peng_num: p.peng_num, pit_id: activeChip?.pit_id, sex: p.sex, chip_date: activeChip?.chip_date, chipped_as_adult: p.chipped_as_adult, chick_size_code: p.chick_size_code, hasReturned: p.hasReturned}} onClick={() => activeChip?.pit_id && copyPit(activeChip.pit_id.slice(-8))} title={activeChip?.pit_id ? (copiedPit ? 'Copied chip ID' : `Copy chip ID (${activeChip.pit_id.slice(-8)})`) : undefined} currentStatus />
        </span>
        <span className="bird-title-actions">
          <span className="bird-action-stack">
            {canEdit && !editing && <button className="edit-btn" onClick={() => setEditing(true)}>Edit</button>}
            {editing && <span className="edit-btns"><button className="edit-btn" onClick={() => setEditing(false)}>Cancel</button><button className="edit-btn done-btn" onClick={() => setEditing(false)}>Done</button></span>}
            {canEdit && hasHistory && <button className="history-btn" onClick={() => setShowHistory({table:'penguins', id:p.peng_num})}>History</button>}
          </span>
          {onClose && <button className="day-bird-close" onClick={onClose} title="Close" aria-label="Close">×</button>}
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
            {/* Summary view is trimmed — sex / chipped-as-chick / chick-size / pit id all
                already read off the mini above. Everything shows again under Edit. */}
            {editing && <tr><td className="muted">Sex</td><td><EditableField value={p.sex} type="select" options={['','M','F']} onSave={savePenguin('sex')} canEdit={true} /></td></tr>}
            {editing && <tr><td className="muted">Chipped as Chick</td><td>{p.chipped_as_adult ? 'No' : 'Yes'}</td></tr>}
            {editing && <tr><td className="muted">Chick Size Code</td><td><EditableField value={p.chick_size_code} onSave={savePenguin('chick_size_code')} placeholder="-" canEdit={true} /></td></tr>}
            <tr><td className="muted">VID</td><td>{!editing ? (p.vid_for_scanner || <span className="muted">-</span>) : <EditableField value={p.vid_for_scanner} onSave={savePenguin('vid_for_scanner')} placeholder="-" canEdit={true} />}</td></tr>
            {chips.map((c: any, i: number) => {
              const re = 'Re'.repeat(i);
              const prefix = i === 0 ? '' : re.toLowerCase();
              // Collapsed: one consolidated line per chip — "date in: box by: chipper".
              // The initial chip is "Chip Info"; each rechip gets its own "Rechip Info" line.
              if (!editing) {
                return (
                  <tr key={`chip${i}`}><td className="muted">{i === 0 ? 'Chip Info' : `${re}chip Info`}</td><td>
                    {c.chip_date ? <DateLink date={c.chip_date} onDayClick={onDayClick} /> : <span className="muted">-</span>}
                    {c.chip_box && <> <span className="muted">in:</span> <a className="clickable" href={`/box/${c.chip_box}`} onClick={e => navClick(e, () => onBoxClick(c.chip_box))}>{c.chip_box}</a></>}
                    {c.chip_by && <> <span className="muted">by:</span> {c.chip_by}</>}
                  </td></tr>
                );
              }
              return (<Fragment key={`chip${i}`}>
              <tr><td className="muted">{prefix ? `${re}chip ` : ''}PIT ID</td><td>{c.pit_id}{!c.is_active && <span className="bird-badge" style={{background:'#FFCDD2', marginLeft:4}}>Retired</span>}</td></tr>
              <tr><td className="muted">{prefix ? `${re}chip ` : 'Chip '}Date</td><td><EditableField value={c.chip_date} type="date" onSave={saveChip(c.pit_id, 'chip_date')} placeholder="date" canEdit={true} /></td></tr>
              <tr><td className="muted">{prefix ? `${re}chip ` : 'Chip '}Box</td><td><EditableField value={c.chip_box} onSave={saveChip(c.pit_id, 'chip_box')} placeholder="box" canEdit={true} /></td></tr>
              <tr><td className="muted">{prefix ? `${re}chipped ` : 'Chipped '}By</td><td><EditableField value={c.chip_by} onSave={saveChip(c.pit_id, 'chip_by')} placeholder="who" canEdit={true} /></td></tr>
            </Fragment>);
            })}
            {(editing || !!p.death_date) && <tr><td className="muted">Dead</td><td>{!editing
              ? <>Dead{p.death_date && <> <span className="muted">({p.death_date.slice(0, 10)})</span></>}</>
              // A death is stamped at 2pm NZ (02:00 UTC) on the chosen date; clearing the field marks the bird alive.
              : <EditableField value={p.death_date ? p.death_date.slice(0, 10) : ''} type="date"
                  onSave={(v: any) => savePenguin('death_date')(v ? `${v} 02:00:00` : null)} placeholder="death date" canEdit={true} />}</td></tr>}
            {(editing || !!p.notes) && <tr><td className="muted">Notes</td><td>{!editing ? p.notes : <EditableField value={p.notes} onSave={savePenguin('notes')} placeholder="-" canEdit={true} />}</td></tr>}
            <BiometricsEditor pengNum={p.peng_num} biometrics={biometrics} deleted={data.biometrics_deleted || []} token={token} canEdit={!!canEdit} editing={editing} />
          </tbody>
        </table>
      </div>

      {/* Sightings loading indicator */}
      {sightings.length === 0 && <p className="muted">Loading sighting history...</p>}

      {/* Breeding family — this bird's role in each detected nest family, from the same
          detection (computeBoxFamilies) the box breeding overview uses, rendered in the
          same year-spine + outcome-card layout as the box view. */}
      {pengFamilies.length > 0 && (
        <div className="bird-section">
          <h3 className="collapsible" onClick={() => toggleSection('breeding')}>{expandedSections.breeding ? '▾' : '▸'} Breeding history ({pengFamilies.length})</h3>
          {expandedSections.breeding && <div className="all-birds">
            {breedingSeasons.map(season => {
              const hasChick = season.entries.some(e => e.fam.chicks.length > 0);
              const anyActive = season.entries.some(e => clutchActive(e.fam.clutch));
              const st = season.entries.length === 0 ? 'none' : hasChick ? 'bred' : anyActive ? 'active' : 'fail';
              const stLabel = st === 'none' ? 'No breeding' : st === 'bred' ? 'Bred' : st === 'active' ? 'Active' : 'Failed';
              return (
                <div key={season.seasonYear} className="season-birds">
                  <div className="season-year">
                    <div className="season-yr">{seasonRange(String(season.seasonYear))}</div>
                    <span className={`season-status st-${st}`}><span className="ss-dot" />{stLabel}</span>
                  </div>
                  <div className="season-content">
                    {season.entries.map((e) => {
                      const offspringDate = (b: any) => b.chip_date ? chickContextDate(b.chip_date) : undefined;
                      const c = e.fam.clutch;
                      const active = clutchActive(c);
                      const cardStatus = e.fam.chicks.length > 0 ? 'bred' : active ? 'active' : 'fail';
                      return (
                        <div key={`${e.seasonYear}-${e.box}-${e.clutchIndex}`} className={`clutch-card ${cardStatus}`}>
                          <div className="clutch-box-row">
                            {e.role === 'parent' ? (<>
                              <span className="muted">with</span>
                              {e.partner
                                ? <PenguinMini scan={e.partner} onClick={() => onBirdClick(e.partner.peng_num || e.partner.pit_id)} />
                                : <span className="muted">partner not identified</span>}
                            </>) : (<>
                              <span className="muted">parents</span>
                              {e.parents.length > 0
                                ? [...e.parents].sort((x: any, y: any) => (x?.sex === 'M' ? 0 : x?.sex === 'F' ? 2 : 1) - (y?.sex === 'M' ? 0 : y?.sex === 'F' ? 2 : 1)).map((pt: any) => <PenguinMini key={pt.pit_id} scan={pt} onClick={() => onBirdClick(pt.peng_num || pt.pit_id)} />)
                                : <span className="muted">not identified</span>}
                            </>)}
                            <span className="muted">in</span>
                            <a className="bird-chip clickable" href={`/box/${e.box}`} onClick={ev => navClick(ev, () => onBoxClick(e.box))}>Box {e.box}</a>
                            {e.clutchCount > 1 && <span className="clutch-label">{ordinal(e.clutchIndex + 1)} clutch</span>}
                          </div>
                          {c.laidFailed && (
                            <div className="season-issues">
                              <span className={`issue-badge${c.startObsTime ? ' clickable' : ''}`}
                                title="Go to where the egg/chick was first detected"
                                onClick={c.startObsTime ? () => onSightingClick(e.box, c.startObsTime) : undefined}>⚠ laid date could not be estimated</span>
                            </div>
                          )}
                          <div className="clutch-body">
                            <span className="clutch-birds">
                              {e.role === 'parent' ? (<>
                                {e.fam.chicks.map((ck: any) => (
                                  <PenguinMini key={ck.pit_id} scan={ck} onClick={() => onBirdClick(ck.peng_num || ck.pit_id)} observationDate={offspringDate(ck)} />
                                ))}
                                {Array.from({ length: e.fam.failedEggs }).map((_, j) => (
                                  <OffspringFinal key={`fe${j}`} kind="egg" active={active} />
                                ))}
                                {Array.from({ length: e.fam.plainChicks }).map((_, j) => (
                                  <OffspringFinal key={`pc${j}`} kind="chick" active={active} />
                                ))}
                                {Array.from({ length: e.fam.fledgedUnchipped }).map((_, j) => (
                                  <span key={`fu${j}`} className="scan chick offspring-fledged" title="Last sighting of unchipped chick, presumed fledged">Unchipped</span>
                                ))}
                              </>) : e.siblings.length > 0 && <>
                                <span className="muted">siblings</span>
                                {e.siblings.map((sb: any) => (
                                  <PenguinMini key={sb.pit_id} scan={sb} onClick={() => onBirdClick(sb.peng_num || sb.pit_id)} observationDate={offspringDate(sb)} />
                                ))}
                              </>}
                            </span>
                            <span className="clutch-meta">
                              <ClutchPredictions clutch={c} />
                              <span className={`clutch-dates${c.startObsTime ? ' clickable' : ''}`}
                                title="Go to where the eggs/chicks first appeared"
                                onClick={c.startObsTime ? () => onSightingClick(e.box, c.startObsTime) : undefined}>{windowRange(c)}</span>
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>}
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
                    <DateLink date={sg.date} onDayClick={() => onSightingClick(b, sg.date)} />
                    {((sg.seen_with || []).length > 0 || (sg.no_scan || 0) > 0) && <span className="muted">with</span>}
                    {(sg.seen_with || []).map((sw: any) => (
                      <PenguinMini key={sw.peng_num} scan={sw} onClick={() => onBirdClick(sw.peng_num)} observationDate={sg.date} />
                    ))}
                    {Array.from({ length: sg.no_scan || 0 }).map((_, k) => (
                      <span key={`ns${k}`} className="scan no-scan">No scan</span>
                    ))}
                    {(() => { const ds = displayStatusOrPrev(sg, sg.box); return ds && ds !== 'NO' && <span className={`badge ${DARK_TEXT_STATUSES.has(ds)?'bordered':''}`} style={{background:STATUS_COLORS[ds]||'#ccc',color:DARK_TEXT_STATUSES.has(ds)?'#333':'#fff'}}>{ds}</span>; })()}
                  </div>
                  {sg.notes && <div className="obs-notes">{sg.notes}</div>}
                </div>
              ))}
            </div>
          );
        })}
      </div>}

      {/* Shared sightings — split by season; sightings inside a breeding window sit in a
          black box tagged with the window dates. "No scan" birds group as one stand-in. */}
      {partners.length > 0 && (
        <div className="bird-section">
          <h3 className="collapsible" onClick={() => toggleSection('partners')}>{expandedSections.partners ? '▾' : '▸'} Shared sightings ({partners.length})</h3>
          {expandedSections.partners && <p className="muted">Birds seen in the same box at the same time &middot; "No scan" = unscanned birds present</p>}
          {expandedSections.partners && partners.map((pt: any, pi: number) => {
            const partnerRow = (s: any, i: number) => (
              <a key={i} className="partner-row clickable" href={`/box/${s.box}`} onClick={e => navClick(e, () => onSightingClick(s.box, s.date))}>
                <DateLink date={s.date} onDayClick={onDayClick} />
                <span className="bird-chip">Box {s.box}</span>
                {s.eggs > 0 && <span>{'🥚'.repeat(Math.min(s.eggs, 4))}</span>}
                {s.chicks > 0 && <span>{'🐣'.repeat(Math.min(s.chicks, 4))}</span>}
                {(() => { const ds = displayStatusOrPrev(s, s.box); return ds && ds !== 'NO' && <span className={`badge ${DARK_TEXT_STATUSES.has(ds)?'bordered':''}`} style={{background:STATUS_COLORS[ds]||'#ccc',color:DARK_TEXT_STATUSES.has(ds)?'#333':'#fff'}}>{ds}</span>; })()}
                {(s.also_seen || []).map((sw: any) => (
                  <PenguinMini key={sw.peng_num} scan={sw} onClick={() => onBirdClick(sw.peng_num)} observationDate={s.date} />
                ))}
              </a>
            );
            const bySeason = new Map<string, any[]>();
            for (const s of pt.sightings) {
              const label = getSeasonLabel(parseDate(s.date));
              if (!bySeason.has(label)) bySeason.set(label, []);
              bySeason.get(label)!.push(s);
            }
            const seasonList = Array.from(bySeason.entries()).sort((a, b) => b[0].localeCompare(a[0]));
            return (
              <div key={pi} className="partner-card">
                <div className="partner-head">
                  <span className="muted">{pt.sightings.length} shared sighting{pt.sightings.length !== 1 ? 's' : ''} with</span>
                  {pt.is_no_scan
                    ? <span className="scan no-scan">No scan</span>
                    : <PenguinMini scan={{peng_num: pt.peng_num, pit_id: pt.pit_id, sex: pt.sex, chipped_as_adult: pt.chipped_as_adult, chip_date: pt.chip_date}} onClick={() => onBirdClick(pt.peng_num)} observationDate={pt.sightings[0]?.date} />}
                </div>
                {seasonList.map(([label, seasonSightings]) => {
                  const windowGroups = new Map<string, { win: any; rows: any[] }>();
                  const loose: any[] = [];
                  for (const s of seasonSightings) {
                    const win = windowFor(s.box, s.date);
                    if (win) {
                      const gkey = `${s.box}|${win.windowStart}`;
                      if (!windowGroups.has(gkey)) windowGroups.set(gkey, { win, rows: [] });
                      windowGroups.get(gkey)!.rows.push(s);
                    } else loose.push(s);
                  }
                  const groups = Array.from(windowGroups.values()).sort((a, b) => b.win.windowStart - a.win.windowStart);
                  return (
                    <div key={label} className="partner-season">
                      <div className="partner-season-label">{seasonRange(label)}</div>
                      {groups.map((g, gi) => {
                        const fam = g.win.fam;
                        return (
                        <div key={`w${gi}`} className="partner-window-box">
                          <div className="partner-window-head">
                            {/* Offspring at their final life stage: chipped chick →
                                PenguinMini, chick never chipped → red-✕ 🐣, egg that
                                never hatched → red-✕ egg. */}
                            <span className="partner-window-offspring">
                              {fam.chicks.map((ck: any) => (
                                <PenguinMini key={ck.pit_id} scan={ck} onClick={() => onBirdClick(ck.peng_num || ck.pit_id)} observationDate={ck.chip_date ? chickContextDate(ck.chip_date) : undefined} />
                              ))}
                              {Array.from({ length: fam.plainChicks }).map((_, j) => (
                                <OffspringFinal key={`pc${j}`} kind="chick" active={clutchActive(fam.clutch)} />
                              ))}
                              {Array.from({ length: fam.failedEggs }).map((_, j) => (
                                <OffspringFinal key={`fe${j}`} kind="egg" active={clutchActive(fam.clutch)} />
                              ))}
                            </span>
                            <a className="partner-window-dates clickable" href={`/box/${g.rows[0].box}`}
                              title="Go to the nest at the start of the breeding window"
                              onClick={ev => navClick(ev, () => onSightingClick(g.rows[0].box, g.win.startObsTime))}>
                              {windowRange(fam.clutch)}
                            </a>
                          </div>
                          <ClutchPredictions clutch={fam.clutch} />
                          <div className="partner-sightings">{g.rows.map(partnerRow)}</div>
                        </div>
                        );
                      })}
                      {loose.length > 0 && <div className="partner-sightings">{loose.map(partnerRow)}</div>}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}


      {/* Sighting history */}
      {sightings.length > 0 && <div className="bird-section">
        <h3 className="collapsible" onClick={() => toggleSection('sightings')}>{expandedSections.sightings ? '▾' : '▸'} Sighting history ({sightings.length})</h3>
        {expandedSections.sightings && sightings.map((s: any, i: number) => s.source === 'chip' ? (
          <ChipCard key={i} date={s.date} box={s.box} onBoxClick={onBoxClick} onDayClick={onDayClick} onBirdClick={onBirdClick}
            chipBy={s.chip_by}
            scan={{ peng_num: p.peng_num, pit_id: s.pit_id || activeChip?.pit_id, sex: p.sex, chip_date: s.date, chipped_as_adult: p.chipped_as_adult, chick_size_code: p.chick_size_code, chip_by: s.chip_by, is_rechip: s.is_rechip }} />
        ) : (
          <div key={i} className="obs-card">
            <div className="obs-top">
              <b><DateLink date={s.date} onDayClick={() => onSightingClick(s.box, s.date)} /></b>
              <a className="bird-chip clickable" href={`/box/${s.box}`} onClick={e => navClick(e, () => onSightingClick(s.box, s.date))}>Box {s.box}</a>
            </div>
            <div className="obs-nums">
              {s.adults === 0 && s.eggs === 0 && s.chicks === 0 && <span className="muted">Empty</span>}
              {s.adults > 0 && <span>{'\uD83D\uDC27'.repeat(Math.min(s.adults, 6))}</span>}
              {s.eggs > 0 && <span>{'\uD83E\uDD5A'.repeat(Math.min(s.eggs, 6))}</span>}
              {s.chicks > 0 && <span>{'\uD83D\uDC23'.repeat(Math.min(s.chicks, 6))}</span>}
              {(() => { const ds = displayStatusOrPrev(s, s.box); return ds && <span className={`badge ${DARK_TEXT_STATUSES.has(ds)?'bordered':''}`} style={{background:STATUS_COLORS[ds]||'#ccc',color:DARK_TEXT_STATUSES.has(ds)?'#333':'#fff'}}>{ds}</span>; })()}
              {((s.seen_with || []).length > 0 || (s.no_scan || 0) > 0) && <span className="muted">with</span>}
              {(s.seen_with || []).map((sw: any) => (
                <PenguinMini key={sw.peng_num} scan={sw} onClick={() => onBirdClick(sw.peng_num)} observationDate={s.date} />
              ))}
              {Array.from({ length: s.no_scan || 0 }).map((_, k) => (
                <span key={`ns${k}`} className="scan no-scan">No scan</span>
              ))}
            </div>
            {s.notes && <div className="obs-notes">{s.notes}</div>}
          </div>
        ))}
      </div>}
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
  const { registeredFmDates } = useContext(DateTooltipCtx);

  const filtered = useMemo(() => {
    if (!search.trim()) return [];

    // FM query against the book lookup tables: "FM3" / "FM 3" lists every season's Full
    // Monitor #3; adding a season year ("FM 3 24", "FM 24 3", "FM 2024 3", "FM 3 2024")
    // narrows to that single monitor. A token ≥ 20 reads as a year, the other as the number.
    const fmQ = search.trim().match(/^fm[\s\/\-\.]*(\d{1,4})(?:[\s\/\-\.]+(\d{1,4}))?$/i);
    if (fmQ) {
      const a = parseInt(fmQ[1]);
      const b = fmQ[2] !== undefined ? parseInt(fmQ[2]) : null;
      const toYear = (n: number) => n >= 2000 ? n : (n >= 20 && n < 100 ? n + 2000 : null);
      const hits: string[] = [];
      for (const [day, fm] of registeredFmDates) {
        const ok = b === null
          ? fm.number === a
          : (toYear(a) === fm.season && fm.number === b) || (toYear(b) === fm.season && fm.number === a);
        if (ok) hits.push(day);
      }
      return hits.sort((x, y) => y.localeCompare(x)).slice(0, 12);
    }

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
  }, [dates, search, registeredFmDates]);

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
          {filtered.map((d, i) => {
            const fm = registeredFmDates.get(d);
            return (
              <div key={d} className={`date-result clickable${i === 0 ? ' focused' : ''}`} onClick={() => go(d)}>
                {formatDate(d)}{fm ? <span className="fm-tag"> (FM {fm.number})</span> : null}
              </div>
            );
          })}
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
  const [isForgot, setIsForgot] = useState(false);
  const [forgotMsg, setForgotMsg] = useState('');

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setForgotMsg('');
    setSubmitting(true);
    try {
      const r = await fetch('/api/crud.php?action=request_password_reset', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      const d = await r.json();
      setForgotMsg(d.message || 'If that email has an account, a reset link has been sent.');
    } catch (e: any) {
      setError('Connection failed: ' + (e.message || ''));
    }
    setSubmitting(false);
  };

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
    <div className="login-page login-bg">
      <div className="login-card">
        <h1>Wildwatch</h1>
        <p className="login-sub">Penguin Colony Monitoring</p>
        {isForgot ? (
          <form onSubmit={handleForgot}>
            <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus />
            {error && <div className="login-error">{error}</div>}
            {forgotMsg && <div className="login-info">{forgotMsg}</div>}
            <button type="submit" disabled={submitting}>{submitting ? 'Please wait...' : 'Email me a reset link'}</button>
            <p className="login-alt"><a className="clickable" onClick={() => { setIsForgot(false); setForgotMsg(''); setError(''); }}>Back to log in</a></p>
          </form>
        ) : (
        <form onSubmit={handleSubmit}>
          {isRegister && <input type="text" placeholder="Name" value={name} onChange={e => setName(e.target.value)} required />}
          <input type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} required />
          <div className="password-field">
            <input type={showPassword ? 'text' : 'password'} placeholder="Password" value={password} onChange={e => setPassword(e.target.value)} required minLength={6} />
            <button type="button" className="toggle-pw" onClick={() => setShowPassword(!showPassword)}>{showPassword ? '\u{1F441}' : '\u{1F441}'}</button>
          </div>
          {error && <div className="login-error">{error}</div>}
          <button type="submit" disabled={submitting}>{submitting ? 'Please wait...' : isRegister ? 'Register' : 'Log in'}</button>
          <p className="login-alt"><a className="clickable" onClick={() => { setIsForgot(true); setError(''); }}>Forgot password?</a></p>
        </form>
        )}
      </div>
      <p className="login-credit">Photo: Marty Melville</p>
    </div>
  );
}

/** Set-password screen for emailed links (/?setpw=TOKEN) — covers both new-user
 *  invites and forgot-password resets. On success the API returns a session, so the
 *  user lands straight in the app. */
function SetPasswordScreen({ setpwToken, onLogin }: { setpwToken: string; onLogin: (token: string, name: string, observerId?: number | string, role?: string) => void }) {
  const [checking, setChecking] = useState(true);
  const [who, setWho] = useState<{ observer_name: string; purpose: string } | null>(null);
  const [error, setError] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch('/api/crud.php?action=check_reset_token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: setpwToken })
    }).then(r => r.json()).then(d => {
      if (d.valid) setWho(d); else setError(d.error || 'This link is invalid or has expired.');
      setChecking(false);
    }).catch(() => { setError('Connection failed'); setChecking(false); });
  }, [setpwToken]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (pw.length < 6) { setError('Password must be at least 6 characters'); return; }
    if (pw !== pw2) { setError('Passwords do not match'); return; }
    setSubmitting(true);
    try {
      const r = await fetch('/api/crud.php?action=reset_password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: setpwToken, password: pw })
      });
      const d = await r.json();
      if (d.token) {
        if (d.email) localStorage.setItem('ww_email', d.email);
        window.history.replaceState({}, '', '/'); // drop the one-time token from the URL
        onLogin(d.token, d.name, d.observer_id, d.role);
      } else setError(d.error || 'Failed to set password');
    } catch (e: any) { setError('Connection failed: ' + (e.message || '')); }
    setSubmitting(false);
  };

  return (
    <div className="login-page login-bg">
      <div className="login-card">
        <h1>Wildwatch</h1>
        {checking ? <p className="login-sub">Checking link…</p> : who ? (
          <>
            <p className="login-sub">{who.purpose === 'invite' ? `Welcome, ${who.observer_name} — choose a password for your account.` : `Hi ${who.observer_name} — set a new password.`}</p>
            <form onSubmit={submit}>
              <div className="password-field">
                <input type={showPassword ? 'text' : 'password'} placeholder="New password" value={pw} onChange={e => setPw(e.target.value)} required minLength={6} autoFocus />
                <button type="button" className="toggle-pw" onClick={() => setShowPassword(!showPassword)}>{'\u{1F441}'}</button>
              </div>
              <input type={showPassword ? 'text' : 'password'} placeholder="Repeat password" value={pw2} onChange={e => setPw2(e.target.value)} required minLength={6} />
              {error && <div className="login-error">{error}</div>}
              <button type="submit" disabled={submitting}>{submitting ? 'Please wait...' : 'Set password & log in'}</button>
            </form>
          </>
        ) : (
          <>
            <p className="login-sub">Set password</p>
            <div className="login-error">{error}</div>
            <p className="login-alt"><a className="clickable" onClick={() => { window.location.href = '/'; }}>Go to log in</a></p>
          </>
        )}
      </div>
      <p className="login-credit">Photo: Marty Melville</p>
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
  // Remember the selected season across nav-away/back (page unmounts when leaving /enter)
  const [season, setSeason] = useState(() => {
    const saved = parseInt(sessionStorage.getItem('ww_entry_season') || '', 10);
    return Number.isFinite(saved) ? saved : getSeasonStart().getFullYear();
  });
  useEffect(() => { sessionStorage.setItem('ww_entry_season', String(season)); }, [season]);
  const [box, setBox] = useState('');
  // The text field edits boxInput only; box (which drives all data loads) commits on Enter
  // or via the steppers — so typing "100" never loads box 1 and 10 along the way.
  const [boxInput, setBoxInput] = useState('');
  const [dateInput, setDateInput] = useState('');
  const [parsedDate, setParsedDate] = useState<string|null>(null);
  const [adults, setAdults] = useState(0);
  const [eggs, setEggs] = useState(0);
  const [chicks, setChicks] = useState(0);
  const [noScan, setNoScan] = useState(0);
  const [gateStatus, setGateStatus] = useState('');
  const [breedingStatus, setBreedingStatus] = useState('');
  const [notes, setNotes] = useState('');
  const [birdSearch, setBirdSearch] = useState('');
  const [dateMappings, setDateMappings] = useState<{date_number:number; actual_date:string; partial_monitor?:number}[]>([]);
  const [prevSeasonMappings, setPrevSeasonMappings] = useState<{date_number:number; actual_date:string; partial_monitor?:number}[]>([]);
  const [nextSeasonMappings, setNextSeasonMappings] = useState<{date_number:number; actual_date:string; partial_monitor?:number}[]>([]);
  const [showDateEditor, setShowDateEditor] = useState(false);
  const [dateEditorText, setDateEditorText] = useState('');
  const [scannedBirds, setScannedBirds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [lastSavedObsId, setLastSavedObsId] = useState<number|null>(null);
  // Set when a save was blocked by an existing observation on the same date — renders a link to it
  const [dupObs, setDupObs] = useState<{box:string; time:string}|null>(null);
  // Right-side full-height bird dock — opened by clicking a PenguinMini in the existing rows
  const [sideBird, setSideBird] = useState<string|null>(null);
  const sideBirdData = useBirdDetail(sideBird);

  // Load date mappings for season
  useEffect(() => {
    if (season < 2020) return;
    fetch(`/api/crud.php?action=season_fm_dates&season=${season}`, { headers: { 'Authorization': `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setDateMappings(Array.isArray(d) ? d : []))
      .catch(() => setDateMappings([]));
    // The previous season's date table often runs on into this season's calendar range
    // (observers keep numbering past 1 Apr); surface those trailing dates here too.
    fetch(`/api/crud.php?action=season_fm_dates&season=${season - 1}`, { headers: { 'Authorization': `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setPrevSeasonMappings(Array.isArray(d) ? d : []))
      .catch(() => setPrevSeasonMappings([]));
    // The next season's book can start before 1 Apr (like this one); its early dates land in
    // this season's widened window too, so surface them as cross-season dates as well.
    fetch(`/api/crud.php?action=season_fm_dates&season=${season + 1}`, { headers: { 'Authorization': `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setNextSeasonMappings(Array.isArray(d) ? d : []))
      .catch(() => setNextSeasonMappings([]));
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
      if (birdInfo.is_dead) {
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
      } else if (scannedBirds.length >= 2) {
        if (!confirm(`WARNING: ${short} is a 3rd+ penguin in this observation (${scannedBirds.length} already added). Are you sure?`)) return;
      }
    } else if (isNew && scannedBirds.length >= 2) {
      if (!confirm(`WARNING: ${short} is a 3rd+ penguin in this observation (${scannedBirds.length} already added). Are you sure?`)) return;
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

  const handleSave = async (gateOverride?: string) => {
    if (!box || !parsedDate) { setMessage('Box and valid date required'); return; }
    // Never save a duplicate — one observation per box per date
    const dup = allBoxObs.find((o: any) => toNzDateStr(o.observation_time_utc) === parsedDate);
    if (dup) { setDupObs({ box, time: dup.observation_time_utc }); return; }
    setSaving(true); setMessage(''); setDupObs(null);

    try {
      // Find location_id for this box — in the ACTIVE colony (so we never write to the wrong one)
      const dashRes = await fetch(`/api/dashboard.php?view=box&name=${encodeURIComponent(box)}&colony_id=${getColonyId()}&_=${Date.now()}`, { headers: { 'Authorization': `Bearer ${token}` } });
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
          adults, eggs, chicks, no_scan: noScan,
          breeding_status: breedingStatus || null,
          gate_status: (gateOverride ?? gateStatus) || null,
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
      // Reset form (keep the date so the next observation can reuse it)
      setAdults(0); setEggs(0); setChicks(0); setNoScan(0); setGateStatus(''); setBreedingStatus('');
      setNotes(''); setScannedBirds([]);
    } catch (e: any) {
      setMessage('Error: ' + e.message);
    }
    setSaving(false);
  };

  // Load all observations for this box (for status bar + season list)
  const [allBoxObs, setAllBoxObs] = useState<Observation[]>([]);
  const [boxPenguins, setBoxPenguins] = useState<any[]>([]);
  useEffect(() => {
    if (!box) { setAllBoxObs([]); setBoxPenguins([]); return; }
    let stale = false; // ignore out-of-order responses when the box changes again
    fetch(`/api/dashboard.php?view=box&name=${encodeURIComponent(box)}&colony_id=${getColonyId()}&_=${Date.now()}`, { headers: { 'Authorization': `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => { if (!stale) { setAllBoxObs(d.observations || []); setBoxPenguins(d.all_penguins || []); } })
      .catch(() => { if (!stale) { setAllBoxObs([]); setBoxPenguins([]); } });
    return () => { stale = true; };
  }, [box, saving]);

  const wwStart = `${season}-04-01`;
  const wwEnd = `${season + 1}-03-31`;
  // The "book" season is this season's FM date table; observers' old books can start it well
  // before 1 Apr (e.g. Dec of the prior year). Show the union of the book span and the wildwatch
  // Apr–Mar season: earliest of (book start, ww start) … latest of (book finish, ww finish).
  const bookDates = dateMappings.map(m => m.actual_date).filter(Boolean).sort();
  const bookStart = bookDates[0];
  const bookEnd = bookDates[bookDates.length - 1];
  const seasonStart = bookStart && bookStart < wwStart ? bookStart : wwStart;
  const seasonEnd = bookEnd && bookEnd > wwEnd ? bookEnd : wwEnd;
  // Dates from the neighbouring book seasons (prev/next) that fall inside this widened window and
  // aren't part of this book's own table — surfaced as pale-yellow "before/after" dates.
  const thisDateSet = new Set(dateMappings.map(m => m.actual_date));
  const crossSeasonDates = [
    ...prevSeasonMappings.map(m => ({ ...m, _season: season - 1 })),
    ...nextSeasonMappings.map(m => ({ ...m, _season: season + 1 })),
  ].filter(m => m.actual_date >= seasonStart && m.actual_date <= seasonEnd && !thisDateSet.has(m.actual_date))
   .sort((a, b) => a.actual_date.localeCompare(b.actual_date));
  const crossDateSet = new Set(crossSeasonDates.map(m => m.actual_date));
  // Earlier (prev-season) dates sit above the table, later (next-season) dates below it.
  const crossBefore = crossSeasonDates.filter(m => m._season < season);
  const crossAfter = crossSeasonDates.filter(m => m._season > season);
  const toDmy = (d: string) => `${parseInt(d.slice(8, 10))}/${parseInt(d.slice(5, 7))}/${d.slice(2, 4)}`;
  // Left/right date arrows: all registered FM dates in this book's window (this season plus
  // the neighbouring-season dates already surfaced), sorted, so the picker can step to the
  // previous/next FM date. Setting a this-season date uses its number; cross-season uses d/m/y.
  const fmStepDates = [
    ...dateMappings.map(m => ({ date: m.actual_date, num: m.date_number, thisSeason: true })),
    ...crossSeasonDates.map(m => ({ date: m.actual_date, num: m.date_number, thisSeason: false })),
  ].filter(x => x.date).sort((a, b) => a.date.localeCompare(b.date));
  const stepFm = (dir: number) => {
    if (!fmStepDates.length) return;
    const cur = parsedDate || '';
    const idx = fmStepDates.findIndex(x => x.date === cur);
    const target = idx !== -1
      ? fmStepDates[Math.min(fmStepDates.length - 1, Math.max(0, idx + dir))]
      : dir > 0 ? (fmStepDates.find(x => x.date > cur) ?? fmStepDates[fmStepDates.length - 1])
                : ([...fmStepDates].reverse().find(x => x.date < cur) ?? fmStepDates[0]);
    if (target) setDateInput(target.thisSeason ? String(target.num) : toDmy(target.date));
  };
  const existingObs = allBoxObs.filter(o =>
    o.observation_time_utc >= seasonStart && o.observation_time_utc <= seasonEnd + ' 23:59:59'
  );

  // Chippings in this box+season, unless the bird is already visible as a scan in
  // one of the box's observations on the chip day (same rule as the box view).
  const entryScannedByDay = new Map<string, Set<string>>();
  for (const o of allBoxObs) {
    const day = toNzDateStr(o.observation_time_utc);
    if (!entryScannedByDay.has(day)) entryScannedByDay.set(day, new Set());
    for (const s of ((o as any).scans || [])) if (s.pit_id) entryScannedByDay.get(day)!.add(s.pit_id);
  }
  const entryChips = boxPenguins
    .filter((p: any) => p.is_chipped_here && p.chip_date && p.chip_date >= seasonStart && p.chip_date <= seasonEnd)
    .filter((p: any) => !entryScannedByDay.get(p.chip_date)?.has(p.pit_id))
    .map((p: any) => ({ ...p, _chip: true, observation_time_utc: `${p.chip_date} 00:00:00` }));
  const entryRows = [...existingObs.map((o: any) => o), ...entryChips]
    .sort((a: any, b: any) => b.observation_time_utc.localeCompare(a.observation_time_utc));
  const todayNz = toNzDateStr(new Date().toISOString()); // highlight an observation dated today (NZ)

  return (
    <div className={`entry-page${sideBird && sideBirdData?.penguin ? ' entry-page-docked' : ''}`}>
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
          <div className="entry-field" style={{flex:'0 0 auto'}}>
            <label style={{textAlign:'center'}}>Box</label>
            <div style={{display:'flex', gap:4, alignItems:'center'}}>
              {(() => {
                // mem.locations has no defined order (no ORDER BY + incremental sync appends),
                // so natural-sort for sane ‹ › stepping (1, 2, … 99, 100, 103)
                const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
                const boxNames = [...new Set(queryAllLocations().map((l: any) => String(l.location_name).trim()))].sort(cmp);
                const commitBox = (name: string) => { setBoxInput(name); setBox(name); };
                const stepBox = (dir: number) => {
                  if (!boxNames.length) return;
                  const cur = box.trim();
                  let i = boxNames.indexOf(cur);
                  if (i < 0) {
                    // Current box not in the local list (empty/stale cache) — step from where it would sort
                    const at = boxNames.findIndex(n => cmp(cur, n) < 0);
                    i = (at < 0 ? boxNames.length : at) - (dir > 0 ? 1 : 0);
                  }
                  commitBox(boxNames[Math.min(boxNames.length - 1, Math.max(0, i + dir))]);
                };
                return <>
                  <button className="entry-box-nav" title="Previous box" onClick={() => stepBox(-1)}>‹</button>
                  <input type="text" value={boxInput} onChange={e => setBoxInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') commitBox(boxInput.trim()); }}
                    onBlur={() => commitBox(boxInput.trim())}
                    style={{width:'56px'}} />
                  <button className="entry-box-nav" title="Next box" onClick={() => stepBox(1)}>›</button>
                </>;
              })()}
            </div>
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
          <button type="button" style={{padding:'4px 12px', background:'#1a5276', color:'#fff', border:'none', borderRadius:'4px', fontSize:'12px', cursor:'pointer'}} onClick={() => { setDateEditorText(dateMappings.map(m =>
                // Seed as dd/mm/yyyy — the format the editor parses back, so lines
                // round-trip. A display format (month name) reads back as invalid.
                // A trailing " PM" marks a Partial Monitor date and round-trips too.
                `${m.date_number} ${m.actual_date.slice(8, 10)}/${m.actual_date.slice(5, 7)}/${m.actual_date.slice(0, 4)}${m.partial_monitor ? ' PM' : ''}`
              ).join('\n')); setShowDateEditor(true); }}>
            {dateMappings.length > 0 ? 'Edit dates' : 'Set up dates'}
          </button>
        </div>
        {crossBefore.length > 0 && (
          <div style={{marginBottom:'6px', paddingBottom:'6px', borderBottom:'1px dashed #ffb74d'}}>
            <div style={{fontSize:'11px', color:'#a15c00', marginBottom:'3px'}}>Earlier, from the previous season's table:</div>
            <div style={{display:'flex', flexWrap:'wrap', gap:'3px'}}>
              {crossBefore.map(m => (
                <span key={`x${m._season}-${m.date_number}`} title={`Season ${String(m._season).slice(-2)} #${m.date_number}`} style={{background:'#fff3e0', border:'1px solid #ffcc80', padding:'3px 8px', borderRadius:'4px', fontSize:'12px', cursor:'pointer'}} onClick={() => setDateInput(toDmy(m.actual_date))}>
                  <b>S{String(m._season).slice(-2)}·{m.date_number}</b> = {formatDate(m.actual_date)}
                </span>
              ))}
            </div>
          </div>
        )}
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
        {crossAfter.length > 0 && (
          <div style={{marginTop:'6px', paddingTop:'6px', borderTop:'1px dashed #ffb74d'}}>
            <div style={{fontSize:'11px', color:'#a15c00', marginBottom:'3px'}}>Later, from the next season's table:</div>
            <div style={{display:'flex', flexWrap:'wrap', gap:'3px'}}>
              {crossAfter.map(m => (
                <span key={`x${m._season}-${m.date_number}`} title={`Season ${String(m._season).slice(-2)} #${m.date_number}`} style={{background:'#fff3e0', border:'1px solid #ffcc80', padding:'3px 8px', borderRadius:'4px', fontSize:'12px', cursor:'pointer'}} onClick={() => setDateInput(toDmy(m.actual_date))}>
                  <b>S{String(m._season).slice(-2)}·{m.date_number}</b> = {formatDate(m.actual_date)}
                </span>
              ))}
            </div>
          </div>
        )}
        {showDateEditor && (
          <div style={{marginTop:'8px', padding:'8px', background:'#f8f9fa', borderRadius:'6px', border:'1px solid #ddd'}}>
            <p style={{fontSize:'11px',color:'#888',margin:'0 0 4px'}}>One per line: number d/m/yy (e.g. "1 26/7/25"). Add " PM" for a Partial Monitor date (green, no full box-set check).</p>
            <textarea value={dateEditorText} onChange={e => setDateEditorText(e.target.value)} rows={10} style={{width:'100%',fontFamily:'monospace',fontSize:'13px',padding:'6px',border:'1px solid #ddd',borderRadius:'4px'}} />
            <div style={{fontSize:'11px',color:'#888',margin:'4px 0'}}>
              {dateEditorText.trim().split('\n').filter(l => l.trim()).map((l, i) => {
                const first = l.trim().split(/[\s]+/)[0];
                let rest = l.trim().slice(first.length).trim();
                const partial = /\bPM\b\s*$/i.test(rest);
                if (partial) rest = rest.replace(/\s*PM\s*$/i, '').trim();
                const parsed = parseDateFlex(rest);
                const dd = parsed ? `${parsed.slice(8, 10)}/${parsed.slice(5, 7)}/${parsed.slice(0, 4)}` : null;
                return <div key={i} style={{color: parsed ? '#4CAF50' : '#F44336'}}>{first} → {dd || 'invalid'}{partial && parsed ? ' · Partial Monitor' : ''}</div>;
              })}
            </div>
            <div style={{display:'flex', gap:'6px'}}>
              <button style={{flex:1,padding:'6px',background:'#1a5276',color:'#fff',border:'none',borderRadius:'4px',cursor:'pointer',fontSize:'12px'}} onClick={async () => {
                const lines = dateEditorText.trim().split('\n').filter(l => l.trim());
                const mappings = lines.map(l => {
                  const first = l.trim().split(/[\s]+/)[0];
                  let rest = l.trim().slice(first.length).trim();
                  const partial = /\bPM\b\s*$/i.test(rest);
                  if (partial) rest = rest.replace(/\s*PM\s*$/i, '').trim();
                  const parsed = parseDateFlex(rest);
                  return { n: parseInt(first), date: parsed, partial };
                }).filter(m => !isNaN(m.n) && m.date) as {n:number; date:string; partial:boolean}[];
                await fetch(`/api/crud.php?action=season_fm_dates&season=${season}`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                  body: JSON.stringify(mappings)
                });
                setDateMappings(mappings.map(m => ({ date_number: m.n, actual_date: m.date, partial_monitor: m.partial ? 1 : 0 })));
                setShowDateEditor(false);
              }}>Save</button>
              <button style={{flex:1,padding:'6px',background:'#fff',color:'#666',border:'1px solid #ddd',borderRadius:'4px',cursor:'pointer',fontSize:'12px'}} onClick={() => setShowDateEditor(false)}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      {/* Existing observations + chippings for this box+season */}
      {box && entryRows.length > 0 && (
        <div className="entry-existing">
          <h3>{existingObs.length} existing observation{existingObs.length !== 1 ? 's' : ''}{entryChips.length > 0 ? ` + ${entryChips.length} chipping${entryChips.length !== 1 ? 's' : ''}` : ''} for <a className="day-box-link" href={`/box/${box}`}> Box {box}</a> ({season})</h3>
          {entryRows.map((o: any, i: number) => o._chip ? (
            <div key={`chip${o.pit_id}`} className="entry-existing-row entry-chip-row" style={crossDateSet.has(String(o.chip_date).slice(0, 10)) ? {background:'#FEFCE8', borderRadius:4} : undefined}>
              <DateLink date={o.chip_date} onDayClick={(d) => { window.location.href = `/?day=${encodeURIComponent(d)}&box=${encodeURIComponent(box)}`; }} />
              <PenguinMini scan={o} onClick={() => o.peng_num && setSideBird(o.peng_num)} observationDate={o.chip_date} />
              <span className="muted">Chipped by {o.chip_by || '?'}</span>
            </div>
          ) : (
            <div key={i} className="entry-existing-row" style={
              toNzDateStr(o.observation_time_utc) === todayNz ? {background:'#FFF9C4', boxShadow:'inset 0 0 0 2px #FDD835', borderRadius:4}
              : crossDateSet.has(toNzDateStr(o.observation_time_utc)) ? {background:'#FEFCE8', borderRadius:4}
              : undefined}>
              <DateLink date={o.observation_time_utc} onDayClick={(d) => { window.location.href = `/?day=${encodeURIComponent(d)}&box=${encodeURIComponent(box)}`; }} />
              <span>{'\uD83D\uDC27'.repeat(o.adults)}{'\uD83E\uDD5A'.repeat(o.eggs)}{'\uD83D\uDC23'.repeat(o.chicks)}</span>
              {(() => { const ds = displayStatusOrPrev(o, box); return ds && <span className={`badge ${DARK_TEXT_STATUSES.has(ds)?'bordered':''}`} style={{background:STATUS_COLORS[ds]||'#ccc',color:DARK_TEXT_STATUSES.has(ds)?'#333':'#fff'}}>{ds}</span>; })()}
              {o.gate_status && <span className="gate">{o.gate_status}</span>}
              {[...(o.scans || [])].sort((a: any, b: any) => {
                // Male, female, BC, (SC,) LC; unsexed non-chick adults last
                const rank = (s: any) => ({ BC: 2, SC: 3, LC: 4 } as any)[s.chick_size_code]
                  ?? ({ M: 0, F: 1 } as any)[(s.sex || '').toUpperCase()] ?? 5;
                return rank(a) - rank(b);
              }).map((s: any, j: number) => (
                <PenguinMini key={j} scan={s} onClick={() => s.peng_num && setSideBird(s.peng_num)} observationDate={o.observation_time_utc} />
              ))}
              {Array.from({ length: Number(o.no_scan) || 0 }).map((_, k) => (
                <span key={`ns${k}`} className="scan no-scan">No scan</span>
              ))}
              {o.notes && <span className="muted" style={{fontStyle:'italic', fontSize:12}}>"{o.notes}"</span>}
              <span style={{marginLeft:'auto', display:'flex', alignItems:'center', gap:6}}>
                {o.monitor_filename?.startsWith('web-entry') && o.observation_id && (
                  <button className="remove-scan" onClick={async () => {
                    const reason = prompt(`Delete observation from ${formatDate(o.observation_time_utc)}?\n\nReason (optional):`);
                    if (reason === null) return;
                    await deleteRecord(token, 'observations', o.observation_id, reason || undefined);
                    setAllBoxObs(prev => prev.filter(ob => ob.observation_id !== o.observation_id));
                  }}>&times;</button>
                )}
                <span className="muted" style={{fontSize:10}}>{o.monitor_filename}</span>
                <a className="day-box-link" style={{whiteSpace:'nowrap'}} href={`/?box=${encodeURIComponent(box)}&obs=${encodeURIComponent(o.observation_time_utc)}`}>to observation →</a>
              </span>
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
          <div style={{display:'flex', alignItems:'center', gap:4}}>
            <button type="button" className="entry-box-nav" title="Previous FM date" disabled={fmStepDates.length === 0} onClick={() => stepFm(-1)}>‹</button>
            <input type="text" value={dateInput} onChange={e => setDateInput(e.target.value)} placeholder={dateMappings.length > 0 ? `1-${dateMappings.length} or d/m/yy` : 'e.g. 11/2/26'} style={{flex:1, minWidth:0}} />
            <button type="button" className="entry-box-nav" title="Next FM date" disabled={fmStepDates.length === 0} onClick={() => stepFm(1)}>›</button>
          </div>
          {parsedDate && <span className="date-preview"><DateLink date={parsedDate} onDayClick={(d) => { window.location.href = `/day/${d}`; }} />{dateMappings.find(m => m.actual_date === parsedDate) ? ` (#${dateMappings.find(m => m.actual_date === parsedDate)!.date_number})` : ''}</span>}
          {dateInput && !parsedDate && <span className="date-preview date-invalid">Invalid{dateMappings.length > 0 ? ` (dates 1-${dateMappings.length} available)` : ' - no date table'}</span>}
          {parsedDate && box && (() => {
            const dup = allBoxObs.find((o: any) => toNzDateStr(o.observation_time_utc) === parsedDate);
            return dup ? (
              <span className="date-preview date-dup">⚠ Box {box} already has data on this date — <a className="day-box-link" href={`/?box=${encodeURIComponent(box)}&obs=${encodeURIComponent(dup.observation_time_utc)}`} target="_blank" rel="noopener">edit →</a></span>
            ) : null;
          })()}
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
            const diff = sexSortOrder(a) - sexSortOrder(b);
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
          <div style={{display:'flex', gap:'8px', alignItems:'center'}}>
            <div style={{flex:1, minWidth:0}}>
              <PenguinSearch penguins={allPenguins} search={birdSearch} onSearchChange={setBirdSearch} onBirdClick={(num) => {
                const bird = allPenguins.find((p: any) => p.peng_num === num || p.pit_id === num);
                if (bird) addBird(bird.pit_id.slice(-8));
                setBirdSearch('');
              }} />
            </div>
            <button type="button" className="add-noscan-btn" onClick={() => { setNoScan(n => n + 1); setAdults(a => a + 1); }}>+ No scan</button>
          </div>
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
            {scannedBirds.length === 0 && noScan === 0 && <span className="muted">Click birds above or search to add</span>}
            {Array.from({ length: noScan }).map((_, k) => (
              <span key={`ns${k}`} className="scan-removable">
                <span className="scan no-scan">No scan</span>
                <button className="remove-scan" onClick={() => { setNoScan(n => n - 1); setAdults(a => Math.max(0, a - 1)); }}>&times;</button>
              </span>
            ))}
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
            {/* Like the app: picking a gate status completes the box — auto-save if valid */}
            <select value={gateStatus} onChange={e => {
              const v = e.target.value;
              setGateStatus(v);
              if ((v === 'Gate up' || v === 'Regate') && box && parsedDate && !saving) handleSave(v);
            }}>
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
              <option value="IGN">Ignored</option>
            </select>
          </div>
        </div>

        <div className="entry-row">
          <label>Notes</label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} />
        </div>

        {dupObs && createPortal(
          <div className="dup-modal-backdrop" onClick={() => setDupObs(null)}>
            <div className="dup-modal" onClick={e => e.stopPropagation()}>
              <h3>Data not saved</h3>
              <p>Duplicate found — Box {dupObs.box} already has an observation on {formatDate(dupObs.time)}.</p>
              <a className="day-box-link" href={`/?box=${encodeURIComponent(dupObs.box)}&obs=${encodeURIComponent(dupObs.time)}`}>view existing observation →</a>
              <button className="entry-save" style={{marginTop:12}} onClick={() => setDupObs(null)}>OK</button>
            </div>
          </div>, document.body)}
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

        <button className="entry-save" onClick={() => handleSave()} disabled={saving || !box || !parsedDate}>
          {saving ? 'Saving...' : 'Save observation'}
        </button>
      </div>
      </div>
      </div>

      {sideBird && sideBirdData?.penguin && (
        <div className="day-bird-dock entry-bird-dock">
          <BirdPage data={sideBirdData} onBirdClick={(num: string) => setSideBird(num)}
            onBoxClick={(b: string) => { setBoxInput(b); setBox(b); }}
            onSightingClick={(b: string) => { setBoxInput(b); setBox(b); }}
            onDayClick={(d: string) => { window.location.href = `/?day=${encodeURIComponent(d)}${box ? `&box=${encodeURIComponent(box)}` : ''}`; }}
            onClose={() => setSideBird(null)}
            token={token} canEdit={false} />
        </div>
      )}

      {/* Date editor is now inline above */}
    </div>
  );
}

const SEASON_COLORS = ['#2196F3', '#4CAF50', '#FF9800', '#9C27B0', '#F44336', '#00BCD4', '#795548', '#607D8B'];

/** Unsexed penguins ranked by how many biometric sex guesses they have — surfaces birds
 *  worth confirming. Tie-break by female-leaning count then peng_num. */
// ===== Penguin groups by box use =====
// Bipartite penguin↔box graph built from every scan. Three grouping methods:
//   strict    — connected components of the raw graph (a single shared sighting joins groups)
//   threshold — drop boxes that are a small share of a bird's sightings, then components
//   louvain   — modularity communities on the penguin co-occurrence projection

function unionFind(n: number) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => parent[x] === x ? x : (parent[x] = find(parent[x]));
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  return { find, union };
}

// Louvain modularity clustering on a weighted undirected graph (adjacency map).
// Returns node -> community label.
function louvainCommunities(adj: Map<string, Map<string, number>>): Map<string, string> {
  let mapping = new Map<string, string>([...adj.keys()].map(k => [k, k]));
  let graph = adj;
  for (let level = 0; level < 8; level++) {
    const nodes = [...graph.keys()];
    const k = new Map(nodes.map(n => [n, [...(graph.get(n) || new Map()).values()].reduce((a, b) => a + b, 0)]));
    const m2 = nodes.reduce((a, n) => a + (k.get(n) || 0), 0); // 2m
    if (m2 === 0) break;
    const comm = new Map(nodes.map(n => [n, n]));
    const commTot = new Map(nodes.map(n => [n, k.get(n) || 0]));
    let movedAny = false;
    for (let pass = 0; pass < 20; pass++) {
      let moved = false;
      for (const n of nodes) {
        const cur = comm.get(n)!;
        const ki = k.get(n) || 0;
        commTot.set(cur, (commTot.get(cur) || 0) - ki);
        const links = new Map<string, number>();
        for (const [nb, w] of graph.get(n) || []) {
          if (nb === n) continue;
          const c = comm.get(nb)!;
          links.set(c, (links.get(c) || 0) + w);
        }
        let best = cur;
        let bestGain = (links.get(cur) || 0) - ((commTot.get(cur) || 0) * ki) / m2;
        for (const [c, w] of links) {
          if (c === cur) continue;
          const gain = w - ((commTot.get(c) || 0) * ki) / m2;
          if (gain > bestGain + 1e-12) { bestGain = gain; best = c; }
        }
        comm.set(n, best);
        commTot.set(best, (commTot.get(best) || 0) + ki);
        if (best !== cur) moved = true;
      }
      if (!moved) break;
      movedAny = true;
    }
    if (!movedAny) break;
    mapping = new Map([...mapping].map(([orig, sn]) => [orig, comm.get(sn)!]));
    const agg = new Map<string, Map<string, number>>();
    for (const [a, nbs] of graph) {
      const ca = comm.get(a)!;
      let row = agg.get(ca);
      if (!row) { row = new Map(); agg.set(ca, row); }
      for (const [b, w] of nbs) {
        const cb = comm.get(b)!;
        row.set(cb, (row.get(cb) || 0) + w);
      }
    }
    if (agg.size === graph.size) break;
    graph = agg;
  }
  return mapping;
}

function PenguinGroupsReport({ onOpenBird }: { onOpenBird: (num: string) => void }) {
  const v = useDbVersion();
  const [method, setMethod] = useState<'strict'|'threshold'|'louvain'>('threshold');
  const [minShare, setMinShare] = useState(10);

  // peng_num -> box -> sighting count, plus a representative scan per bird for PenguinMini.
  const base = useMemo(() => {
    const counts = new Map<string, Map<string, number>>();
    const birdInfo = new Map<string, any>();
    for (const loc of queryAllLocations()) {
      const box = String(loc.location_name).trim();
      const bd = queryBoxDetailSync(box);
      for (const o of bd?.observations || []) {
        for (const s of o.scans || []) {
          if (!s.peng_num) continue;
          let m = counts.get(s.peng_num);
          if (!m) { m = new Map(); counts.set(s.peng_num, m); }
          m.set(box, (m.get(box) || 0) + 1);
          if (!birdInfo.has(s.peng_num)) birdInfo.set(s.peng_num, s);
        }
      }
    }
    return { counts, birdInfo };
  }, [v]);

  const result = useMemo(() => {
    const { counts } = base;
    const birds = [...counts.keys()];
    let groupsBirds: string[][];

    if (method === 'louvain') {
      // Penguin projection: w_ab = Σ_box (ca·cb)/d_box — co-occurrence discounted by busy boxes.
      const boxBirds = new Map<string, [string, number][]>();
      for (const [num, m] of counts) for (const [box, c] of m) {
        let l = boxBirds.get(box);
        if (!l) { l = []; boxBirds.set(box, l); }
        l.push([num, c]);
      }
      const adj = new Map<string, Map<string, number>>(birds.map(b => [b, new Map()]));
      for (const [, list] of boxBirds) {
        const db = list.reduce((a, [, c]) => a + c, 0);
        for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
          const w = (list[i][1] * list[j][1]) / db;
          const a = list[i][0], b = list[j][0];
          adj.get(a)!.set(b, (adj.get(a)!.get(b) || 0) + w);
          adj.get(b)!.set(a, (adj.get(b)!.get(a) || 0) + w);
        }
      }
      const comm = louvainCommunities(adj);
      const byComm = new Map<string, string[]>();
      for (const b of birds) {
        const c = comm.get(b) || b;
        let l = byComm.get(c);
        if (!l) { l = []; byComm.set(c, l); }
        l.push(b);
      }
      groupsBirds = [...byComm.values()];
    } else {
      // strict / threshold: union-find across birds + boxes on kept edges.
      const birdIdx = new Map(birds.map((b, i) => [b, i]));
      const boxIdx = new Map<string, number>();
      for (const m of counts.values()) for (const box of m.keys())
        if (!boxIdx.has(box)) boxIdx.set(box, birds.length + boxIdx.size);
      const uf = unionFind(birds.length + boxIdx.size);
      for (const [num, m] of counts) {
        const total = [...m.values()].reduce((a, b) => a + b, 0);
        for (const [box, c] of m) {
          if (method === 'threshold' && !(c >= 2 && c / total >= minShare / 100)) continue;
          uf.union(birdIdx.get(num)!, boxIdx.get(box)!);
        }
      }
      const byRoot = new Map<number, string[]>();
      for (const b of birds) {
        const r = uf.find(birdIdx.get(b)!);
        let l = byRoot.get(r);
        if (!l) { l = []; byRoot.set(r, l); }
        l.push(b);
      }
      groupsBirds = [...byRoot.values()];
    }

    // Shared post-processing: each box is "owned" by the group with the most sightings in
    // it; a group's exclusivity = share of its birds' sightings that fall in its own boxes.
    const groupOf = new Map<string, number>();
    groupsBirds.forEach((ms, i) => ms.forEach(b => groupOf.set(b, i)));
    const boxGroup = new Map<string, Map<number, number>>();
    for (const [num, m] of counts) {
      const g = groupOf.get(num)!;
      for (const [box, c] of m) {
        let bg = boxGroup.get(box);
        if (!bg) { bg = new Map(); boxGroup.set(box, bg); }
        bg.set(g, (bg.get(g) || 0) + c);
      }
    }
    const owner = new Map<string, number>();
    for (const [box, bg] of boxGroup) {
      let bestG = -1, bestC = -1;
      for (const [g, c] of bg) if (c > bestC) { bestC = c; bestG = g; }
      owner.set(box, bestG);
    }
    const cmp = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
    const rows = groupsBirds.map((members, i) => {
      const boxes: { box: string; c: number }[] = [];
      for (const [box, o] of owner) if (o === i) boxes.push({ box, c: boxGroup.get(box)!.get(i) || 0 });
      boxes.sort((a, b) => b.c - a.c || cmp(a.box, b.box));
      let total = 0, inOwn = 0;
      for (const b of members) for (const [box, c] of counts.get(b)!) {
        total += c;
        if (owner.get(box) === i) inOwn += c;
      }
      return { members: [...members].sort(cmp), boxes, purity: total ? inOwn / total : 0 };
    }).filter(r => r.members.length >= 2)
      .sort((a, b) => b.members.length - a.members.length);
    const singles = birds.length - rows.reduce((a, r) => a + r.members.length, 0);
    return { rows, singles, totalBirds: birds.length };
  }, [base, method, minShare]);

  const methodBlurb = method === 'strict'
    ? 'Connected components of the raw penguin↔box graph — a single shared sighting links two groups, so expect large merged clusters.'
    : method === 'threshold'
    ? `Boxes making up less than ${minShare}% of a bird's sightings (or seen under twice) are ignored, then connected components — groups split where links are only casual visits.`
    : 'Louvain modularity communities on penguin co-occurrence (shared-box sightings, discounted in busy boxes) — finds mostly-exclusive groups even when box use overlaps.';

  return (
    <div className="report-card">
      <h3>Penguin groups by box use</h3>
      <p className="muted">Mutually exclusive groups of penguins based on which boxes they are usually seen in ({result.totalBirds} birds with scans)</p>
      <div className="group-method-row">
        <button className={method === 'strict' ? 'active' : ''} onClick={() => setMethod('strict')}>Strict components</button>
        <button className={method === 'threshold' ? 'active' : ''} onClick={() => setMethod('threshold')}>Usual boxes</button>
        <button className={method === 'louvain' ? 'active' : ''} onClick={() => setMethod('louvain')}>Communities</button>
        {method === 'threshold' && (
          <label className="group-share-slider">
            min share
            <input type="range" min={0} max={50} step={5} value={minShare} onChange={e => setMinShare(parseInt(e.target.value, 10))} />
            {minShare}%
          </label>
        )}
      </div>
      <p className="muted">{methodBlurb}</p>
      {result.rows.length === 0 ? <p className="muted">No groups found</p> : (
        <table className="guess-rank-table rank-table">
          <thead><tr><th>#</th><th>Penguins</th><th>Boxes</th><th>Excl.</th></tr></thead>
          <tbody>
            {result.rows.map((r, i) => (
              <tr key={i}>
                <td>{r.members.length}</td>
                <td>
                  <div className="group-members">
                    {r.members.map(num => (
                      <PenguinMini key={num} scan={base.birdInfo.get(num)} onClick={() => onOpenBird(num)} />
                    ))}
                  </div>
                </td>
                <td>
                  {r.boxes.slice(0, 15).map((b, j) => (
                    <Fragment key={b.box}>
                      {j > 0 && ', '}
                      <a className="clickable" href={`/box/${b.box}`}><strong>{b.box}</strong></a>
                    </Fragment>
                  ))}
                  {r.boxes.length > 15 && <span className="muted"> +{r.boxes.length - 15} more</span>}
                </td>
                <td>{Math.round(r.purity * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {result.singles > 0 && <p className="muted">{result.singles} bird{result.singles === 1 ? '' : 's'} in single-bird groups not shown</p>}
    </div>
  );
}

function MissedScansReport() {
  const boxes = useMissedScans();

  return (
    <div className="report-card">
      <h3>Possible unchipped penguins — last 30 days</h3>
      <p className="muted">Boxes where adults were recorded present but fewer were scanned, ranked by how often it happened ({boxes.length} boxes). Chipped 30d = birds chipped in that box in the same window.</p>
      {boxes.length === 0 ? <p className="muted">No missed scans in the last 30 days</p> : (
        <table className="guess-rank-table">
          <thead><tr><th>Box</th><th>Missed</th><th>Chipped 30d</th><th>Days</th></tr></thead>
          <tbody>
            {boxes.map((b: any) => (
              <tr key={b.box}>
                <td><a className="clickable" href={`/box/${b.box}`}><strong>{b.box}</strong></a></td>
                <td>{b.missed.length} of {b.observedDays} visit{b.observedDays === 1 ? '' : 's'}</td>
                <td>{b.chipped || ''}</td>
                <td>
                  {b.missed.map((m: any, i: number) => (
                    <Fragment key={m.date}>
                      {i > 0 && ', '}
                      <a className="clickable" href={`/day/${m.date}`}>{m.date.slice(5)}</a>
                      <span className="muted"> ({m.scanned}/{m.adults})</span>
                    </Fragment>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AdultCountMismatchReport({ onOpen }: { onOpen: (box: string, time: string) => void }) {
  const { total, rows } = useAdultCountMismatches();
  const [mode, setMode] = useState<'top' | 'day' | 'all'>('top');
  const recentDay = rows[0]?.date;
  const shown = mode === 'all' ? rows
    : mode === 'day' ? rows.filter((r: any) => r.date === recentDay)
    : rows.slice(0, 3);
  return (
    <div className="report-card">
      <h3>Adult count vs scans mismatch</h3>
      <p className="muted">Observations where the recorded adult count doesn't match scanned adults + "no scan" markers. Newest first.</p>
      {rows.length === 0 ? <p className="muted">No mismatches found</p> : (<>
        <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
          {(([['top', 'Show 3'], ['day', `Most recent day${recentDay ? ` (${recentDay})` : ''}`], ['all', `Show all (${total})`]]) as const).map(([m, label]) => (
            <button key={m} className="edit-btn" style={{ opacity: mode === m ? 1 : 0.55 }} onClick={() => setMode(m)}>{label}</button>
          ))}
        </div>
        <table className="guess-rank-table">
          <thead><tr><th>Date</th><th>Box</th><th>Adults</th><th>Scanned + no-scan</th></tr></thead>
          <tbody>
            {shown.map((r: any, i: number) => (
              <tr key={i} className="clickable" onClick={() => onOpen(r.box, r.time)} title="Go to this observation">
                <td>{r.date}</td>
                <td><strong>{r.box}</strong></td>
                <td>{r.adults}</td>
                <td>{r.adultScans + r.noScan} <span className="muted">({r.adultScans} scanned + {r.noScan} no-scan)</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>Showing {shown.length} of {total}</p>
      </>)}
    </div>
  );
}

function TopChickParentsReport({ onOpenBird }: { onOpenBird: (num: string) => void }) {
  const v = useDbVersion();
  const rows = useMemo(() => {
    // Tally distinct chipped chicks per detected parent across every box (same nest-family
    // detection the box overview / bird panel use).
    const byParent = new Map<string, { bird: any; chicks: Set<string> }>();
    for (const loc of queryAllLocations()) {
      const bd = queryBoxDetailSync(loc.location_name);
      if (!bd?.observations?.length) continue;
      for (const sd of computeBoxFamilies(bd.observations, bd.all_penguins)) {
        for (const fam of sd.families) {
          const chickNums = fam.chicks.map((ck: any) => ck.peng_num).filter(Boolean);
          if (chickNums.length === 0) continue;
          for (const parent of fam.parents) {
            if (!parent.peng_num) continue;
            let e = byParent.get(parent.peng_num);
            if (!e) { e = { bird: parent, chicks: new Set() }; byParent.set(parent.peng_num, e); }
            for (const n of chickNums) e.chicks.add(n);
          }
        }
      }
    }
    return Array.from(byParent.values())
      .map(e => ({ bird: e.bird, count: e.chicks.size }))
      .sort((a, b) => b.count - a.count || (parseInt(a.bird.peng_num) || 0) - (parseInt(b.bird.peng_num) || 0))
      .slice(0, 10);
  }, [v]);

  return (
    <div className="report-card">
      <h3>Most chipped chicks raised</h3>
      <p className="muted">Penguins ranked by distinct chipped chicks from nests where they were a detected parent (top 10)</p>
      {rows.length === 0 ? <p className="muted">No data available</p> : (
        <table className="guess-rank-table rank-table">
          <thead><tr><th>#</th><th>Penguin</th><th>Chipped chicks</th></tr></thead>
          <tbody>
            {rows.map((r: any, i: number) => (
              <tr key={r.bird.peng_num}>
                <td>{i + 1}</td>
                <td><PenguinMini scan={r.bird} onClick={() => onOpenBird(r.bird.peng_num)} /></td>
                <td><strong>{r.count}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function UnproductiveParentsReport({ onOpenBird }: { onOpenBird: (num: string) => void }) {
  const v = useDbVersion();
  const rows = useMemo(() => {
    // Same nest-family detection as Top chick parents, but counting breeding windows:
    // clutches where the bird was a detected parent AND at least one egg appeared.
    const byParent = new Map<string, { bird: any; windows: number; chicks: Set<string> }>();
    for (const loc of queryAllLocations()) {
      const bd = queryBoxDetailSync(loc.location_name);
      if (!bd?.observations?.length) continue;
      for (const sd of computeBoxFamilies(bd.observations, bd.all_penguins)) {
        for (const fam of sd.families) {
          if (fam.parents.length === 0 || fam.clutch.maxEggs < 1) continue;
          for (const parent of fam.parents) {
            if (!parent.peng_num) continue;
            let e = byParent.get(parent.peng_num);
            if (!e) { e = { bird: parent, windows: 0, chicks: new Set() }; byParent.set(parent.peng_num, e); }
            e.windows++;
            for (const ck of fam.chicks) if (ck.peng_num) e.chicks.add(ck.peng_num);
          }
        }
      }
    }
    return Array.from(byParent.values())
      .map(e => ({ bird: e.bird, windows: e.windows, chipped: e.chicks.size }))
      .filter(r => r.windows >= 2)
      .sort((a, b) => a.chipped - b.chipped || b.windows - a.windows || (parseInt(a.bird.peng_num) || 0) - (parseInt(b.bird.peng_num) || 0))
      .slice(0, 25);
  }, [v]);

  return (
    <div className="report-card">
      <h3>Chronically unproductive parents</h3>
      <p className="muted">Birds detected as part of a breeding pair in windows where at least one egg appeared, ranked by fewest chipped chicks then most windows (min 2 windows, top 25)</p>
      {rows.length === 0 ? <p className="muted">No data available</p> : (
        <table className="guess-rank-table count-cols">
          <thead><tr><th>Penguin</th><th>Egg windows</th><th>Chipped chicks</th></tr></thead>
          <tbody>
            {rows.map((r: any) => (
              <tr key={r.bird.peng_num}>
                <td><PenguinMini scan={r.bird} onClick={() => onOpenBird(r.bird.peng_num)} /></td>
                <td>{r.windows}</td>
                <td><strong>{r.chipped}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function UnsexedByGuessesReport() {
  const allPenguins = useAllPenguins();
  const rows = useMemo(() => (allPenguins || [])
    .filter((p: any) => !(p.sex || '').trim())
    .map((p: any) => { const g = observedSexGuess(p.peng_num); return { p, m: g.m, f: g.f, total: g.m + g.f }; })
    .filter((r: any) => r.total > 0)
    .sort((a: any, b: any) => b.total - a.total || b.f - a.f || (parseInt(a.p.peng_num) || 0) - (parseInt(b.p.peng_num) || 0)),
  [allPenguins]);

  return (
    <div className="report-card">
      <h3>Unsexed penguins by sex guesses</h3>
      <p className="muted">Birds with no assigned sex, ordered by number of biometric sex guesses ({rows.length})</p>
      {rows.length === 0 ? <p className="muted">No data available</p> : (
        <table className="guess-rank-table count-cols">
          <thead><tr><th>Penguin</th><th>Guesses</th><th>{'♂'}</th><th>{'♀'}</th></tr></thead>
          <tbody>
            {rows.map((r: any) => (
              <tr key={r.p.peng_num}>
                <td><PenguinMini scan={r.p} onClick={() => {}} navigateDirectly /></td>
                <td>{r.total}</td>
                <td>{r.m || ''}</td>
                <td>{r.f || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

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

function PeakAdultsChart({ onDayClick }: { onDayClick?: (day: string) => void }) {
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
            <text x={xScale(i)} y={PAD.top + plotH + 30} textAnchor="middle" fontSize="9"
              fill={onDayClick ? '#1565c0' : '#999'}
              style={onDayClick ? { cursor: 'pointer', textDecoration: 'underline' } : undefined}
              onClick={onDayClick ? () => onDayClick(d.date) : undefined}>{shortDate(d.date)}</text>
          </Fragment>
        ))}
        <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={PAD.top + plotH} stroke="#ccc" strokeWidth="1" />
        <line x1={PAD.left} x2={PAD.left + plotW} y1={PAD.top + plotH} y2={PAD.top + plotH} stroke="#ccc" strokeWidth="1" />
        <text x={14} y={PAD.top + plotH / 2} textAnchor="middle" fontSize="12" fill="#666" transform={`rotate(-90, 14, ${PAD.top + plotH / 2})`}>Peak adults</text>
      </svg>
    </div>
  );
}

/** First egg recorded in the colony each breeding season, with the box it appeared in. */
function FirstEggReport({ onDayClick }: { onDayClick?: (day: string) => void }) {
  const rows = useFirstEgg();
  if (rows.length === 0) return <div className="report-card"><p className="muted">No egg data available</p></div>;
  const fmt = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
  return (
    <div className="report-card">
      <h3>First Egg Each Season</h3>
      <p className="muted">The earliest egg recorded anywhere in the colony each breeding season (Apr–Mar), newest first</p>
      <table className="guess-rank-table mini-list-table">
        <thead><tr><th>Season</th><th>First egg</th><th>Boxes</th></tr></thead>
        <tbody>
          {rows.map((r: any) => (
            <tr key={r.season}>
              <td style={{ fontWeight: 600 }}>{r.season}</td>
              <td>{onDayClick
                ? <span className="clickable" style={{ color: '#1565c0', textDecoration: 'underline' }} onClick={() => onDayClick(r.date)}>{fmt(r.date)}</span>
                : fmt(r.date)}</td>
              <td>{r.boxes.map((b: any, i: number) => (
                <Fragment key={b.box}>{i > 0 ? ', ' : ''}<a className="day-box-link" href={`/?box=${encodeURIComponent(b.box)}&obs=${encodeURIComponent(b.obs_time)}`}>Box {b.box}</a></Fragment>
              ))}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
        return <AgeHistogramCard title="Age at First Return" blurb={`How old penguins were when first scanned back at the colony (n=${pts.length})`} xLabel="Age at first return (months)" months={pts.map(p => Math.round(p.age * 12))} color="#2196F3" />;
      })()}
      <BreedingAgeHistograms />
    </>
  );
}

/** Month-binned age histogram in a report card — same chart for first return / first egg / first offspring. */
function AgeHistogramCard({ title, blurb, xLabel, months, color }: { title: string; blurb: string; xLabel: string; months: number[]; color: string }) {
  if (months.length === 0) return null;
  const maxMonth = Math.max(...months);
  const minMonth = Math.min(...months);
  // Don't waste the axis on the empty 0..first-bar range — start just below the first bar
  // (the age labels stay on 6-month gridlines).
  const startMonth = Math.max(0, minMonth - 2);
  const bins: number[] = Array(maxMonth + 1).fill(0);
  for (const m of months) bins[m]++;
  const maxCount = Math.max(...bins);

  const SW = 800, SH = 300, SP = { top: 30, right: 20, bottom: 45, left: 50 };
  const spW = SW - SP.left - SP.right;
  const spH = SH - SP.top - SP.bottom;
  const barW = spW / Math.max(1, maxMonth - startMonth);
  const xScale2 = (m: number) => SP.left + (m - startMonth - 1) * barW;
  const yScale2 = (v: number) => SP.top + spH - (v / maxCount) * spH;

  return (
    <div className="report-card" style={{marginTop: '0.5em'}}>
      <h3>{title}</h3>
      <p className="muted">{blurb}</p>
      <svg viewBox={`0 0 ${SW} ${SH}`} className="report-chart">
        {/* X axis labels - every 6 months, with year lines */}
        {Array.from({ length: Math.floor(maxMonth / 6) + 1 }, (_, i) => (i + 1) * 6).filter(m => m > startMonth && m <= maxMonth).map(m => (
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
              <rect x={xScale2(m)} y={yScale2(count)} width={Math.max(barW - 1, 1)} height={barH} fill={color} opacity="0.75" rx="1" />
              {count >= 3 && <text x={xScale2(m) + barW / 2} y={yScale2(count) - 3} textAnchor="middle" fontSize="8" fill={color} fontWeight="600">{count}</text>}
            </Fragment>
          );
        })}
        {/* Axes */}
        <line x1={SP.left} x2={SP.left} y1={SP.top} y2={SP.top + spH} stroke="#ccc" strokeWidth="1" />
        <line x1={SP.left} x2={SP.left + spW} y1={SP.top + spH} y2={SP.top + spH} stroke="#ccc" strokeWidth="1" />
        <text x={SP.left + spW / 2} y={SH - 2} textAnchor="middle" fontSize="12" fill="#666">{xLabel}</text>
      </svg>
    </div>
  );
}

/** Ages (from chip date, so ~a month or two under true age) at which chick-chipped birds
 *  first joined a breeding pair whose clutch produced an egg, and first had a chick
 *  chipped — from the shared computeBoxFamilies detection. */
function BreedingAgeHistograms() {
  const v = useDbVersion();
  const { eggMonths, chickMonths } = useMemo(() => {
    const firstEgg = new Map<string, number>();
    const firstChick = new Map<string, number>();
    for (const loc of queryAllLocations()) {
      const bd = queryBoxDetailSync(loc.location_name);
      if (!bd?.observations?.length) continue;
      for (const sd of computeBoxFamilies(bd.observations, bd.all_penguins)) {
        for (const fam of sd.families) {
          for (const parent of fam.parents) {
            if (parent.chipped_as_adult || !parent.chip_date) continue; // age only known for chick-chipped birds
            const key = parent.pit_id ? parent.pit_id.slice(-8) : parent.peng_num;
            if (!key) continue;
            const born = parseDate(parent.chip_date).getTime();
            const mo = (t: number) => Math.round((t - born) / (1000 * 60 * 60 * 24 * 30.44));
            // Both graphs read the SAME breeding windows the box view computes (segmentClutches via
            // computeBoxFamilies) — nothing about the window is recomputed here.
            const chipDates = fam.chicks.map((ck: any) => ck.chip_date).filter(Boolean).map((d: string) => parseDate(d).getTime());
            const producedChick = chipDates.length > 0;                 // window produced a chipped chick
            const producedEgg = fam.clutch.maxEggs >= 1 || producedChick; // …and any chick implies an egg
            // Graph 1: age when this window produced an egg (its estimated laid date).
            if (producedEgg) {
              const t = fam.clutch.laid ?? fam.clutch.windowStart;
              if (t) { const m = mo(t); if (m > 0 && (!firstEgg.has(key) || m < firstEgg.get(key)!)) firstEgg.set(key, m); }
            }
            // Graph 2: age when this window produced its first chipped chick — a strict subset of
            // graph 1 (a chick can't exist without an egg), trailing it by the egg→chip interval.
            if (producedChick) {
              const m = mo(Math.min(...chipDates));
              if (m > 0 && (!firstChick.has(key) || m < firstChick.get(key)!)) firstChick.set(key, m);
            }
          }
        }
      }
    }
    return { eggMonths: Array.from(firstEgg.values()), chickMonths: Array.from(firstChick.values()) };
  }, [v]);

  return (
    <>
      <AgeHistogramCard title="Age at First Egg" blurb={`Age of chick-chipped birds the first time they were a parent in a breeding window that produced an egg — using the box view's breeding-window detection (n=${eggMonths.length}, from chip date)`} xLabel="Age at first egg (months)" months={eggMonths} color="#E91E63" />
      <AgeHistogramCard title="Age at First Chipped Offspring" blurb={`Age of chick-chipped birds the first time a breeding window they parented produced a chipped chick — a subset of the first-egg birds (n=${chickMonths.length}, from chip date)`} xLabel="Age at first chipped offspring (months)" months={chickMonths} color="#4CAF50" />
    </>
  );
}

/** Single age histogram with quarterly (3-month) buckets, reusable for chick/adult split.
 *  `quarters` array contains ages in quarter-year units (0 = 0–3 months, 1 = 3–6 months, etc). */
function AgeBarChart({ quarters, color, xLabel, hideFirst }: { quarters: number[]; color: string; xLabel: string; hideFirst?: boolean }) {
  if (quarters.length === 0) return <p className="muted">No data</p>;
  const filtered = hideFirst ? quarters.filter(q => q > 0) : quarters;
  if (filtered.length === 0) return <p className="muted">No data</p>;
  const maxQ = Math.max(...filtered, 3);
  const bins: number[] = Array(maxQ + 1).fill(0);
  for (const q of filtered) bins[q]++;
  const maxCount = Math.max(...bins);

  const W = 700, H = 260, PAD = { top: 25, right: 20, bottom: 45, left: 50 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const barW = Math.max(plotW / (maxQ + 1) - 1, 3);
  const xScale = (q: number) => PAD.left + q * (plotW / (maxQ + 1));
  const yScale = (v: number) => PAD.top + plotH - (v / maxCount) * plotH;
  const yTicks = Array.from({ length: 5 }, (_, i) => Math.round(maxCount * (i + 1) / 5)).filter((v, i, a) => a.indexOf(v) === i);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="report-chart">
      {yTicks.map(v => (
        <Fragment key={v}>
          <line x1={PAD.left} x2={PAD.left + plotW} y1={yScale(v)} y2={yScale(v)} stroke="#e8ecef" strokeWidth="1" />
          <text x={PAD.left - 8} y={yScale(v) + 4} textAnchor="end" fontSize="11" fill="#888">{v}</text>
        </Fragment>
      ))}
      {bins.map((count, q) => {
        if (count === 0) return null;
        const x = xScale(q) + (plotW / (maxQ + 1) - barW) / 2;
        const barH = (count / maxCount) * plotH;
        return (
          <Fragment key={q}>
            <rect x={x} y={yScale(count)} width={barW} height={barH} fill={color} opacity="0.85" rx="1" />
            {count >= 3 && barW >= 8 && <text x={x + barW / 2} y={yScale(count) - 3} textAnchor="middle" fontSize="8" fill="#666" fontWeight="600">{count}</text>}
          </Fragment>
        );
      })}
      {/* Label every whole year */}
      {bins.map((_, q) => (
        q % 4 === 0 ? <text key={q} x={xScale(q) + plotW / (maxQ + 1) / 2} y={PAD.top + plotH + 16} textAnchor="middle" fontSize="10" fill="#666" fontWeight={q % 4 === 0 ? '600' : '400'}>{q / 4}y</text> : null
      ))}
      <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={PAD.top + plotH} stroke="#ccc" strokeWidth="1" />
      <line x1={PAD.left} x2={PAD.left + plotW} y1={PAD.top + plotH} y2={PAD.top + plotH} stroke="#ccc" strokeWidth="1" />
      <text x={PAD.left + plotW / 2} y={H - 2} textAnchor="middle" fontSize="12" fill="#666">{xLabel}</text>
    </svg>
  );
}

/** Age distribution: two separate charts for chick-chipped and adult-chipped penguins. */
function PenguinAgeCharts() {
  const v = useDbVersion();
  const allPenguins = useAllPenguins();
  const data = useMemo(() => {
    const firstSeen = new Map<string, number>();
    const lastSeen = new Map<string, number>();
    for (const loc of queryAllLocations()) {
      const bd = queryBoxDetailSync(loc.location_name);
      if (!bd?.observations?.length) continue;
      for (const obs of bd.observations) {
        const t = parseDate(obs.observation_time_utc).getTime();
        for (const s of obs.scans || []) {
          if (!s.peng_num) continue;
          const prev = firstSeen.get(s.peng_num);
          if (prev === undefined || t < prev) firstSeen.set(s.peng_num, t);
          const prevL = lastSeen.get(s.peng_num);
          if (prevL === undefined || t > prevL) lastSeen.set(s.peng_num, t);
        }
      }
    }
    const adultChipped = new Set(allPenguins.filter((p: any) => p.chipped_as_adult).map((p: any) => p.peng_num));
    const chickQs: number[] = [];
    const adultQs: number[] = [];
    for (const [num, first] of firstSeen) {
      const last = lastSeen.get(num)!;
      if (last <= first) continue;
      const quarters = Math.floor((last - first) / (1000 * 60 * 60 * 24 * 365.25 / 4));
      if (adultChipped.has(num)) adultQs.push(quarters);
      else chickQs.push(quarters);
    }
    return { chickQs, adultQs };
  }, [v, allPenguins]);

  const { chickQs, adultQs } = data;
  if (chickQs.length + adultQs.length === 0) return <div className="report-card"><h3>Penguin ages</h3><p className="muted">No data available</p></div>;

  return (
    <>
      <div className="report-card">
        <h3>Chick-chipped penguin ages</h3>
        <p className="muted">Time between earliest and most recent scan for penguins chipped as chicks (n={chickQs.length})</p>
        <AgeBarChart quarters={chickQs} color="#DAA520" xLabel="Time between first and last scan" hideFirst />
      </div>
      <div className="report-card">
        <h3>Adult-chipped penguin ages</h3>
        <p className="muted">Time between earliest and most recent scan for penguins chipped as adults (n={adultQs.length})</p>
        <AgeBarChart quarters={adultQs} color="#2196F3" xLabel="Time between first and last scan" />
      </div>
    </>
  );
}

/** Survival curve from the first-season adult cohort.
 *  Birds chipped in season 1 were a cross-section of ages; annual attrition from that
 *  cohort gives mortality rate → predicted expected lifespan. */
function SurvivalPredictionReport() {
  const v = useDbVersion();
  const allPenguins = useAllPenguins();
  const chickReturn = useChickReturn();
  const result = useMemo(() => {
    // Find the earliest season any adult-chipped bird was scanned in.
    const birdSeasons = new Map<string, Set<string>>();
    const adultChipped = new Set(allPenguins.filter((p: any) => p.chipped_as_adult).map((p: any) => p.peng_num));
    let allSeasons = new Set<string>();
    for (const loc of queryAllLocations()) {
      const bd = queryBoxDetailSync(loc.location_name);
      if (!bd?.observations?.length) continue;
      for (const obs of bd.observations) {
        const season = getSeasonLabel(parseDate(obs.observation_time_utc));
        allSeasons.add(season);
        for (const s of obs.scans || []) {
          if (!s.peng_num || !adultChipped.has(s.peng_num)) continue;
          let ss = birdSeasons.get(s.peng_num);
          if (!ss) { ss = new Set(); birdSeasons.set(s.peng_num, ss); }
          ss.add(season);
        }
      }
    }
    const sortedSeasons = Array.from(allSeasons).sort();
    if (sortedSeasons.length < 3) return null;
    const firstSeason = sortedSeasons[0];
    // Cohort: adult-chipped birds scanned in the first season
    const cohort = Array.from(birdSeasons.entries())
      .filter(([, ss]) => ss.has(firstSeason))
      .map(([num, ss]) => ({ num, seasons: ss }));
    if (cohort.length < 5) return null;

    // For each subsequent season, how many of the cohort were still seen
    const curve: { season: string; alive: number; pct: number }[] = [];
    for (const season of sortedSeasons) {
      const alive = cohort.filter(b => b.seasons.has(season)).length;
      curve.push({ season, alive, pct: alive / cohort.length * 100 });
    }

    return { cohort: cohort.length, firstSeason, curve, sortedSeasons };
  }, [v, allPenguins]);

  // Backtest slider: fit the model on only the first N observed seasons (2021–22, 2021–23, …),
  // while the full observed curve stays on the chart — so a prediction made with less history
  // can be judged against what actually happened since. null = use all observed seasons.
  const [fitCount, setFitCount] = useState<number | null>(null);
  const effFitCount = result ? Math.max(2, Math.min(fitCount ?? result.curve.length, result.curve.length)) : 0;

  const fit = useMemo(() => {
    if (!result) return null;
    const curveFit = result.curve.slice(0, effFitCount);

    // First principles survival model:
    // S(t) = max(0, 100 - b*t - d*(1 - e^(-k*t)))
    //   - Starts at 100% (t=0: 100 - 0 - 0 = 100)
    //   - b = steady linear attrition (% lost per season for established adults)
    //   - d = total early excess mortality (% that die young, saturating over time)
    //   - k = rate at which early mortality plays out
    //
    // For large t: S(t) ≈ (100 - d) - b*t, a line with intercept (100-d) and slope -b.
    // So fit a line to the stable portion to get b and d, then estimate k from early residuals.

    const stableStart = Math.min(2, curveFit.length - 2);
    const stablePts = curveFit.slice(stableStart).map((c, i) => ({ x: i + stableStart, y: c.pct }));
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (const p of stablePts) { sumX += p.x; sumY += p.y; sumXY += p.x * p.y; sumX2 += p.x * p.x; }
    const n = stablePts.length;
    const lateSlope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const lateIntercept = (sumY - lateSlope * sumX) / n;

    // b = steady loss rate, d = early excess mortality
    const b = -lateSlope; // positive: % lost per season
    const d = Math.max(0, 100 - lateIntercept); // gap between 100% and where the linear extrapolates to at t=0

    // Estimate k from early data: at t=1, S(1) = 100 - b - d*(1-e^(-k))
    // So d*(1-e^(-k)) = 100 - b - S(1), giving e^(-k) = 1 - (100-b-S(1))/d
    let k = 1.0;
    if (d > 0 && curveFit.length >= 2) {
      const earlyLoss = 100 - b - curveFit[1].pct; // how much was lost by season 1 beyond linear
      const ratio = earlyLoss / d;
      if (ratio > 0 && ratio < 1) {
        k = -Math.log(1 - ratio);
      }
    }

    const model = (t: number) => Math.max(0, 100 - b * t - d * (1 - Math.exp(-k * t)));

    // Season at which model hits zero (search forward)
    let zeroAt: number | null = null;
    for (let t = 0; t < 50; t += 0.1) {
      if (model(t) <= 0) { zeroAt = t; break; }
    }
    // Median residency: when model crosses 50%
    let medianAt: number | null = null;
    for (let t = 0; t < 50; t += 0.1) {
      if (model(t) <= 50) { medianAt = t; break; }
    }

    return { b, d, k, model, zeroAt, medianAt };
  }, [result, effFitCount]);

  if (!result || !fit) return null;

  const { cohort, firstSeason, curve } = result;
  const { b, d, k, model, zeroAt } = fit;

  // Extend prediction into future until model reaches zero
  const futureSeasons: string[] = [];
  const lastSeasonYear = parseInt(result.sortedSeasons[result.sortedSeasons.length - 1]);
  for (let y = lastSeasonYear + 1; ; y++) {
    const t = curve.length + futureSeasons.length;
    if (model(t) <= 0) { futureSeasons.push(String(y)); break; }
    futureSeasons.push(String(y));
    if (futureSeasons.length > 30) break;
  }
  const totalPoints = curve.length + futureSeasons.length;

  // Draw survival curve
  const W = 600, H = 280, PAD = { top: 30, right: 20, bottom: 55, left: 55 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const xScale = (i: number) => PAD.left + (i / (totalPoints - 1)) * plotW;
  const yScale = (pct: number) => PAD.top + plotH - (pct / 100) * plotH;

  // All x-axis labels (observed + future)
  const allLabels = [...curve.map(c => c.season), ...futureSeasons];

  return (
    <div className="report-card">
      <h3>Adult residency (first-season cohort)</h3>
      <p className="muted">Survival curve of {cohort} adult-chipped birds from the first monitoring season ({firstSeason}) — annual attrition predicts median time an adult remains in the colony</p>
      <div style={{display:'flex', alignItems:'center', gap:10, justifyContent:'center', margin:'0.2em 0 0.5em', flexWrap:'wrap'}}>
        <span style={{fontSize:'0.8em', color:'#888'}}>Predictor data:</span>
        <input type="range" min={2} max={curve.length} step={1} value={effFitCount}
          onChange={e => { const n = parseInt(e.target.value); setFitCount(n >= curve.length ? null : n); }}
          style={{width:180}} title="How many observed seasons the model is fitted on — hollow points are held out, so you can see how an earlier prediction compares with what actually happened" />
        <span style={{fontSize:'0.8em', fontWeight:600, color: effFitCount < curve.length ? '#FF9800' : '#888'}}>
          {firstSeason}–{curve[effFitCount - 1].season}{effFitCount === curve.length ? ' (all data)' : ` (${curve.length - effFitCount} season${curve.length - effFitCount !== 1 ? 's' : ''} held out)`}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="report-chart">
        {[25, 50, 75, 100].map(pct => (
          <Fragment key={pct}>
            <line x1={PAD.left} x2={PAD.left + plotW} y1={yScale(pct)} y2={yScale(pct)} stroke="#e8ecef" strokeWidth="1" />
            <text x={PAD.left - 8} y={yScale(pct) + 4} textAnchor="end" fontSize="11" fill="#888">{pct}%</text>
          </Fragment>
        ))}
        {/* Boundary between observed and predicted */}
        <line x1={xScale(curve.length - 1)} x2={xScale(curve.length - 1)} y1={PAD.top} y2={PAD.top + plotH} stroke="#ddd" strokeWidth="1" strokeDasharray="3,3" />
        {/* Backtest cutoff: model fitted only on data left of this line */}
        {effFitCount < curve.length && (
          <line x1={xScale(effFitCount - 1)} x2={xScale(effFitCount - 1)} y1={PAD.top} y2={PAD.top + plotH} stroke="#FF9800" strokeWidth="1.5" strokeDasharray="4,3" />
        )}
        {/* Actual curve */}
        <polyline
          points={curve.map((c, i) => `${xScale(i)},${yScale(c.pct)}`).join(' ')}
          fill="none" stroke="#2196F3" strokeWidth="2.5"
        />
        {/* Combined model: linear + exponential early mortality */}
        <polyline
          points={Array.from({ length: totalPoints }, (_, i) => `${xScale(i)},${yScale(model(i))}`).join(' ')}
          fill="none" stroke="#f44336" strokeWidth="1.5" strokeDasharray="4,3" opacity="0.7"
        />
        {/* Data points — hollow beyond the fit cutoff (held out from the predictor) */}
        {curve.map((c, i) => (
          <circle key={i} cx={xScale(i)} cy={yScale(c.pct)} r="3"
            fill={i < effFitCount ? '#2196F3' : '#fff'} stroke="#2196F3" strokeWidth={i < effFitCount ? 0 : 1.5} />
        ))}
        {/* X axis labels */}
        {allLabels.map((label, i) => (
          i % 2 === 0 || totalPoints <= 12 ? <text key={i} x={xScale(i)} y={PAD.top + plotH + 16} textAnchor="middle" fontSize="9" fill={i >= curve.length ? '#bbb' : '#666'} transform={`rotate(-30, ${xScale(i)}, ${PAD.top + plotH + 16})`}>{label}</text> : null
        ))}
        <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={PAD.top + plotH} stroke="#ccc" strokeWidth="1" />
        <line x1={PAD.left} x2={PAD.left + plotW} y1={PAD.top + plotH} y2={PAD.top + plotH} stroke="#ccc" strokeWidth="1" />
      </svg>
      <div style={{display:'flex', gap:'2em', justifyContent:'center', margin:'0.8em 0', flexWrap:'wrap'}}>
        <div style={{textAlign:'center'}}>
          <div style={{fontSize:'1.4em', fontWeight:700, color:'#f44336'}}>{b.toFixed(1)}%</div>
          <div style={{fontSize:'0.8em', color:'#888'}}>Lost per season (steady)</div>
        </div>
        <div style={{textAlign:'center'}}>
          <div style={{fontSize:'1.4em', fontWeight:700, color:'#FF9800'}}>{d.toFixed(0)}%</div>
          <div style={{fontSize:'0.8em', color:'#888'}}>Early excess mortality</div>
        </div>
        {zeroAt && (() => {
          const decayLifespan = (100 - d) / b;
          // Mean age at first return across all size classes
          const returnTotals = chickReturn?.totals;
          const allAges = returnTotals ? ['LC','BC','SC'].flatMap((s: string) => {
            const t = returnTotals[s];
            return t?.avg_return_age ? [{ age: t.avg_return_age, n: t.returned }] : [];
          }) : [];
          const meanReturnAge = allAges.length > 0
            ? allAges.reduce((s, a) => s + a.age * a.n, 0) / allAges.reduce((s, a) => s + a.n, 0)
            : null;
          const totalLifespan = meanReturnAge ? decayLifespan + meanReturnAge : null;
          return (
            <div style={{textAlign:'center'}}>
              <div style={{fontSize:'1.4em', fontWeight:700, color:'#4CAF50'}}>{totalLifespan ? totalLifespan.toFixed(1) : decayLifespan.toFixed(1)} years</div>
              <div style={{fontSize:'0.8em', color:'#888'}}>Predicted age at last scan</div>
              <div style={{fontSize:'0.7em', color:'#aaa'}}>{meanReturnAge ? `${meanReturnAge.toFixed(1)}y return age + ${decayLifespan.toFixed(1)}y adult residency` : `${decayLifespan.toFixed(1)}y adult residency`}</div>
            </div>
          );
        })()}
      </div>
      <div style={{display:'flex', gap:'1.5em', justifyContent:'center', fontSize:'0.85em', margin:'0.3em 0'}}>
        <span><span style={{display:'inline-block', width:16, height:3, backgroundColor:'#2196F3', verticalAlign:'middle', marginRight:4}}></span> Observed</span>
        {effFitCount < curve.length && <span><span style={{display:'inline-block', width:9, height:9, borderRadius:'50%', border:'1.5px solid #2196F3', verticalAlign:'middle', marginRight:4}}></span> Held out of fit</span>}
        <span><span style={{display:'inline-block', width:16, height:3, backgroundColor:'#f44336', verticalAlign:'middle', marginRight:4, borderTop:'1.5px dashed #f44336'}}></span> S(t) = 100 − {b.toFixed(1)}t − {d.toFixed(0)}(1 − e<sup style={{fontSize:'0.75em'}}>−{k.toFixed(1)}t</sup>)</span>
      </div>
    </div>
  );
}

/** Pair bond duration: how many consecutive seasons the same two adults share a box. */
function PairBondReport({ onOpenBird }: { onOpenBird: (num: string) => void }) {
  const v = useDbVersion();
  const rows = useMemo(() => {
    // For each box+season, find the detected breeding pair. Then track consecutive seasons
    // the same pair appears together at ANY box.
    const pairSeasons = new Map<string, { a: any; b: any; seasons: Set<string>; boxes: Set<string> }>();
    for (const loc of queryAllLocations()) {
      const bd = queryBoxDetailSync(loc.location_name);
      if (!bd?.observations?.length) continue;
      for (const sd of computeBoxFamilies(bd.observations, bd.all_penguins)) {
        for (const fam of sd.families) {
          if (fam.parents.length < 2) continue;
          const nums = fam.parents.map((p: any) => p.peng_num).filter(Boolean).sort();
          if (nums.length < 2) continue;
          const key = nums[0] + '+' + nums[1];
          let e = pairSeasons.get(key);
          if (!e) { e = { a: fam.parents.find((p: any) => p.peng_num === nums[0]), b: fam.parents.find((p: any) => p.peng_num === nums[1]), seasons: new Set(), boxes: new Set() }; pairSeasons.set(key, e); }
          e.seasons.add(sd.label);
          e.boxes.add(String(loc.location_name).trim());
        }
      }
    }
    // Compute max consecutive run of seasons
    return Array.from(pairSeasons.values())
      .map(e => {
        const sorted = Array.from(e.seasons).map(Number).sort((a, b) => a - b);
        let maxRun = 1, run = 1;
        for (let i = 1; i < sorted.length; i++) {
          if (sorted[i] === sorted[i - 1] + 1) { run++; if (run > maxRun) maxRun = run; }
          else run = 1;
        }
        return { a: e.a, b: e.b, totalSeasons: sorted.length, consecutive: maxRun, boxes: Array.from(e.boxes).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) };
      })
      .filter(r => r.totalSeasons >= 2)
      .sort((a, b) => b.consecutive - a.consecutive || b.totalSeasons - a.totalSeasons)
      .slice(0, 25);
  }, [v]);

  return (
    <div className="report-card">
      <h3>Pair bond duration</h3>
      <p className="muted">Breeding pairs detected together in multiple seasons, ranked by longest consecutive run (min 2 seasons, top 25)</p>
      {rows.length === 0 ? <p className="muted">No data available</p> : (
        <table className="guess-rank-table mini-list-table">
          <thead><tr><th>Pair</th><th>Consecutive</th><th>Total seasons</th><th>Boxes</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>
                  <div className="group-members">
                    {[r.a, r.b].sort((x, y) => (x?.sex === 'M' ? 0 : x?.sex === 'F' ? 2 : 1) - (y?.sex === 'M' ? 0 : y?.sex === 'F' ? 2 : 1)).map((p, k) => (
                      <PenguinMini key={k} scan={p} onClick={() => onOpenBird(p.peng_num)} />
                    ))}
                  </div>
                </td>
                <td><strong>{r.consecutive}</strong></td>
                <td>{r.totalSeasons}</td>
                <td>{r.boxes.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Non-breeding "floaters": birds scanned at multiple boxes but never detected as a breeding parent. */
function FloaterReport({ onOpenBird }: { onOpenBird: (num: string) => void }) {
  const v = useDbVersion();
  const rows = useMemo(() => {
    const parentNums = new Set<string>();
    const birdBoxes = new Map<string, { info: any; boxes: Map<string, number>; totalScans: number }>();
    for (const loc of queryAllLocations()) {
      const box = String(loc.location_name).trim();
      const bd = queryBoxDetailSync(box);
      if (!bd?.observations?.length) continue;
      // Collect parents
      for (const sd of computeBoxFamilies(bd.observations, bd.all_penguins)) {
        for (const fam of sd.families) {
          for (const p of fam.parents) if (p.peng_num) parentNums.add(p.peng_num);
        }
      }
      // Collect scan counts per box
      for (const obs of bd.observations) {
        for (const s of obs.scans || []) {
          if (!s.peng_num) continue;
          let e = birdBoxes.get(s.peng_num);
          if (!e) { e = { info: s, boxes: new Map(), totalScans: 0 }; birdBoxes.set(s.peng_num, e); }
          e.boxes.set(box, (e.boxes.get(box) || 0) + 1);
          e.totalScans++;
        }
      }
    }
    // Only adults (chipped_as_adult or >90 days since chip), scanned at 2+ boxes, never a parent
    return Array.from(birdBoxes.entries())
      .filter(([num, e]) => {
        if (parentNums.has(num)) return false;
        if (e.boxes.size < 2) return false;
        const info = e.info;
        if (info.chipped_as_adult) return true;
        if (info.chip_date) {
          const daysSinceChip = (Date.now() - parseDate(info.chip_date).getTime()) / (1000 * 60 * 60 * 24);
          return daysSinceChip > 90;
        }
        return false;
      })
      .map(([, e]) => ({
        bird: e.info,
        boxCount: e.boxes.size,
        totalScans: e.totalScans,
        boxes: Array.from(e.boxes.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([b, c]) => `${b} (${c})`),
      }))
      .sort((a, b) => b.boxCount - a.boxCount || b.totalScans - a.totalScans)
      .slice(0, 25);
  }, [v]);

  return (
    <div className="report-card">
      <h3>Possible floaters</h3>
      <p className="muted">Adult birds scanned at 2+ boxes but never detected as a breeding parent — possible non-breeding floaters (top 25)</p>
      {rows.length === 0 ? <p className="muted">No data available</p> : (
        <table className="guess-rank-table mini-list-table">
          <thead><tr><th>Penguin</th><th>Boxes</th><th>Scans</th><th>Seen at</th></tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td><PenguinMini scan={r.bird} onClick={() => onOpenBird(r.bird.peng_num)} /></td>
                <td><strong>{r.boxCount}</strong></td>
                <td>{r.totalScans}</td>
                <td style={{fontSize:'0.85em'}}>{r.boxes.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function DayCalendar({ date, dates, onDayClick }: { date: string; dates: string[]; onDayClick: (day: string) => void }) {
  const { show: showTip, hide: hideTip, statsCache, registeredFmDates } = useContext(DateTooltipCtx);
  const dateSet = useMemo(() => new Set(dates), [dates]);
  // Partial Monitor dates: registered as PM in the enter-date workflow. Teal, and always
  // teal — they're a deliberate partial round, so they never read as full (green) or missed
  // (orange) regardless of how many boxes were observed.
  const partialMonitorDates = useMemo(() => {
    const s = new Set<string>();
    for (const [d, r] of registeredFmDates) { if (r.partial) s.add(d); }
    return s;
  }, [registeredFmDates]);
  const fullMonitorDates = useMemo(() => {
    const fm = new Set<string>();
    for (const d of dates) { const s = statsCache.get(d); if (s?.isFullMonitor && !partialMonitorDates.has(d)) fm.add(d); }
    return fm;
  }, [dates, statsCache, partialMonitorDates]);
  // Dates registered as FM in the enter-date workflow but not achieved (missing
  // observations) — flagged red so a skipped monitor day is obvious. PM dates are excluded.
  const missedFmDates = useMemo(() => {
    const s = new Set<string>();
    for (const d of registeredFmDates.keys()) { if (!statsCache.get(d)?.isFullMonitor && !partialMonitorDates.has(d)) s.add(d); }
    return s;
  }, [registeredFmDates, statsCache, partialMonitorDates]);

  // Group dates by month, show months around current date. With no date (e.g. a brand-new
  // colony with no observations) fall back to today so the calendar still renders.
  const valid = date && !isNaN(new Date(date + 'T00:00:00').getTime());
  const current = valid ? new Date(date + 'T00:00:00') : new Date();
  const currentMonth = current.getFullYear() * 12 + current.getMonth();

  // All months from first to last date (inclusive, no gaps)
  const allMonths = useMemo(() => {
    if (dates.length === 0) { const t = new Date(); return [t.getFullYear() * 12 + t.getMonth()]; } // empty colony → at least the current month
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
  // Key the centring effect on stable primitives, not the `dates` array identity: callers
  // often rebuild `dates` every render (e.g. `[...x].sort()`), so depending on the array
  // itself re-fired this on unrelated re-renders — a date tooltip appearing — yanking the
  // horizontal scroll. Length + first/last capture the only change that matters (data loaded).
  const datesKey = dates.length ? `${dates.length}:${dates[0]}:${dates[dates.length - 1]}` : '';
  useEffect(() => {
    // Defer to the next frame so the scroll runs after the calendar (and its flex
    // parent) have laid out — otherwise the active day can be centred against a
    // stale width and the calendar opens scrolled to the wrong place.
    const raf = requestAnimationFrame(() => {
      // Centre the active day's month, not the day itself — switching days within a
      // month then leaves the calendar still, instead of jerking to re-centre each day.
      const target = calRef.current?.querySelector('.cal-month.current') || calRef.current?.querySelector('.cal-day.active');
      if (target) target.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'center' });
    });
    return () => cancelAnimationFrame(raf);
  }, [currentMonth, datesKey]);

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
                    const isMissedFm = missedFmDates.has(d);
                    const isPartialFm = partialMonitorDates.has(d);
                    // A missed or partial-monitor FM date is interactive even with no observations,
                    // so its cell can be hovered/opened to see the registered FM/PM detail.
                    const interactive = hasData || isMissedFm || isPartialFm;
                    return (
                      <span
                        key={di}
                        className={`cal-day${hasData ? ' has-data' : ''}${isActive ? ' active' : ''}${isPartialFm ? ' pm-monitor' : fullMonitorDates.has(d) ? ' full-monitor' : ''}${isMissedFm ? ' fm-missed' : ''}`}
                        onClick={interactive ? () => onDayClick(d) : undefined}
                        onMouseEnter={interactive ? e => showTip(d, e) : undefined}
                        onMouseLeave={interactive ? hideTip : undefined}
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

function DayView({ date, dates, highlightBox, onBoxClick, onBirdClick: _onBirdClick, onDayClick, externalBird, token, canEdit, allPenguins: _allPenguins, peekCalendar }: { date: string; dates: string[]; highlightBox?: string | null; onBoxClick: (box: string, date?: string) => void; onBirdClick: (num: string) => void; onDayClick: (day: string) => void; externalBird?: string | null; token?: string; canEdit?: boolean; allPenguins?: any[]; peekCalendar?: boolean }) {
  const data = useDayData(date);
  const loading = !data;
  const [sideBird, setSideBird] = useState<string|null>(null);
  const sideBirdData = useBirdDetail(sideBird);
  // Stable identity so DayCalendar's centre-on-mount effect (keyed on `dates`) doesn't
  // re-fire on unrelated re-renders — e.g. a date tooltip appearing — and yank the
  // calendar's horizontal scroll to the current month.
  const sorted = useMemo(() => [...dates].sort(), [dates]);

  useEffect(() => {
    if (externalBird) setSideBird(externalBird);
  }, [externalBird]);

  const handleBirdClick = (num: string) => setSideBird(num);
  // Day-view filters persist across days/sessions so a chosen view sticks as you navigate.
  const readChangedFields = (): string[] => { try { const a = JSON.parse(localStorage.getItem('ww_day_changed') || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
  const [showCarryForward, setShowCarryForward] = useState(() => localStorage.getItem('ww_day_showall') === '1');
  const [hideDcm, setHideDcm] = useState(() => localStorage.getItem('ww_day_hidedcm') === '1');
  // "Only changed" filter: show boxes whose observation differs from the previous one (before this day)
  const [changedFields, setChangedFields] = useState<Set<string>>(() => new Set(readChangedFields()));
  // Expand the Changed section on load when any changed filter is already active.
  const [changedExpanded, setChangedExpanded] = useState(() => readChangedFields().length > 0);
  const toggleChangedField = (f: string) => setChangedFields(prev => {
    const next = new Set(prev);
    if (next.has(f)) next.delete(f); else next.add(f);
    return next;
  });
  useEffect(() => { localStorage.setItem('ww_day_showall', showCarryForward ? '1' : '0'); }, [showCarryForward]);
  useEffect(() => { localStorage.setItem('ww_day_hidedcm', hideDcm ? '1' : '0'); }, [hideDcm]);
  useEffect(() => { localStorage.setItem('ww_day_changed', JSON.stringify([...changedFields])); }, [changedFields]);

  if (loading) return <div className="day-page"><p className="muted">Loading...</p></div>;
  if (!data || data.error) return <div className="day-page"><p className="muted">{data?.error || 'Failed to load'}</p></div>;


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

  // When the peng detail dock is open, the collapsed "show calendar" button sits to the
  // LEFT of it (at the dock's left edge) rather than over it. The dock is variable width,
  // so measure it and offset the fixed button by that width.
  const docked = !!(sideBird && sideBirdData?.penguin);
  const dockRef = useRef<HTMLDivElement>(null);
  const [calRight, setCalRight] = useState(16);
  useLayoutEffect(() => {
    const update = () => setCalRight(docked && dockRef.current ? dockRef.current.offsetWidth + 16 : 16);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [docked, sideBirdData]);

  // When arriving from a box's date link, centre that box's row up-front (before paint,
  // so it doesn't jerk into place after the user has started scrolling) and highlight it.
  useLayoutEffect(() => {
    if (!highlightBox || !data) return;
    const el = dayPageRef.current?.querySelector(`[data-daybox="${(window.CSS && CSS.escape) ? CSS.escape(highlightBox) : highlightBox}"]`);
    if (el) (el as HTMLElement).scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'center' });
  }, [highlightBox, data]);

  return (
    <div className={`day-page${sideBird && sideBirdData?.penguin ? ' day-page-docked' : ''}`} ref={dayPageRef}>
      <div className="day-main">
      {(!calHidden || peekCalendar) && (
        <div style={{position:'relative'}}>
          <DayCalendar date={date} dates={sorted} onDayClick={onDayClick} />
          <button onClick={() => setCalHidden(true)} className="cal-toggle" style={{position:'absolute', bottom:-10, right:16}} title="Hide calendar">
            <svg viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="1,5 5,1 9,5" />
            </svg>
          </button>
        </div>
      )}
      {calHidden && !peekCalendar && (
        <button onClick={() => setCalHidden(false)} className="cal-toggle cal-toggle-collapsed" style={{ right: calRight }} title="Show calendar">
          <svg viewBox="0 0 10 6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="1,1 5,5 9,1" />
          </svg>
        </button>
      )}
      {(totalObs > 0 || totalChips > 0) && (
        <div className="day-section">
          <h3 className="day-header-row">
            <span className="day-stats"><DateStatsLine stats={{ ...(getDateStats().get(date) || { boxes:0, obs:0, adults:0, eggs:0, chicks:0, penguins:0, label:null, isFullMonitor:false, totalLocations:0 }), chipped: totalChips }} showDate date={date} /></span>
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
                const cfDs = displayStatusOrPrev(cf, box);
                return (
                  <div key={box} data-daybox={box} className={`day-row day-row-cf${box === highlightBox ? ' day-box-highlight' : ''}`}
                    onClick={() => onBoxClick(box, cf.observation_time_utc)} style={{cursor:'pointer'}}>
                    <a className="day-box-link" href={`/box/${box}`} onClick={e => navClick(e, () => onBoxClick(box, cf.observation_time_utc))}><b>Box {box}</b></a>
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
              // A bird chipped here today may also appear in today's scans — the scan
              // mini already renders it (with the green chipped-here treatment), so
              // only show chip minis for birds not scanned in this box today.
              const scannedPits = new Set(obs.flatMap((o: any) => (o.scans || []).map((s: any) => s.pit_id)));
              const chipMinis = chips.filter((c: any) => !c.pit_id || !scannedPits.has(c.pit_id));
              // Chipping-only box (no observation today): show each chipped penguin as a green
              // mini labelled "Chipped in Box x". Boxes observed today show the chip mini inline
              // on their observation row instead (handled below), so they aren't repeated here.
              if (obs.length === 0 && chips.length > 0) {
                return (
                  <div key={box} data-daybox={box} className={`day-row${box === highlightBox ? ' day-box-highlight' : ''}`}>
                    {chips.map((c: any) => (
                      <span key={c.pit_id} className="day-chip-item">
                        <PenguinMini scan={c} onClick={() => handleBirdClick(c.peng_num)} observationDate={date} />
                        <span className="muted"> Chipped in Box {box}</span>
                      </span>
                    ))}
                  </div>
                );
              }
              return (
              <div key={box} data-daybox={box} className={box === highlightBox ? 'day-box-highlight' : undefined}>
                {obs.map((o: any, oi: number) => {
                  // Keep duplicate scans visible — the same penguin scanned >1x in one observation is a
                  // data-entry error worth surfacing, not noise to hide.
                  const oScans = (o.scans || []).filter((s: any) => s.peng_num)
                    .sort((a: any, b: any) => { const order: Record<string,number> = {M:0, F:1, BC:2, LC:3, SC:4}; const ka = (a.sex||'').toUpperCase(); const kb = (b.sex||'').toUpperCase(); const ca = a.chick_size_code || ''; const cb = b.chick_size_code || ''; return (order[ka] ?? order[ca] ?? 5) - (order[kb] ?? order[cb] ?? 5); });
                  const scanCounts: Record<string, number> = {};
                  for (const s of oScans) scanCounts[s.peng_num] = (scanCounts[s.peng_num] || 0) + 1;
                  const hasDupScan = Object.values(scanCounts).some((n: number) => n > 1);
                  const oDs = displayStatusOrPrev(o, box);
                  const isDup = obs.length > 1;
                  return (
                  <div key={o.observation_id || oi}>
                    <div className="day-row" onClick={() => onBoxClick(box, o.observation_time_utc)} style={{cursor:'pointer', borderLeft: isDup ? '3px solid #F44336' : undefined}}>
                      {oi === 0 && <a className="day-box-link" href={`/box/${box}`} onClick={e => navClick(e, () => onBoxClick(box, o.observation_time_utc))}><b>Box {box}</b></a>}
                      {oi > 0 && <span className="day-box-link" style={{opacity:0.4}}>Box {box}</span>}
                      {(o.adults || 0) > 0 && <span>{'\uD83D\uDC27'.repeat(Math.min(o.adults, 4))}</span>}
                      {(o.eggs || 0) > 0 && <span>{'\uD83E\uDD5A'.repeat(Math.min(o.eggs, 4))}</span>}
                      {(o.chicks || 0) > 0 && <span>{'\uD83D\uDC23'.repeat(Math.min(o.chicks, 4))}</span>}
                      {oDs && oDs !== 'NO' && <span className={`badge ${DARK_TEXT_STATUSES.has(oDs)?'bordered':''}`} style={{background:STATUS_COLORS[oDs]||'#ccc',color:DARK_TEXT_STATUSES.has(oDs)?'#333':'#fff',fontSize:10,padding:'1px 5px'}}>{oDs}</span>}
                      {oScans.map((s: any, si: number) => (
                        <span key={s.scan_id || `${s.peng_num}-${si}`}
                          style={scanCounts[s.peng_num] > 1 ? {outline:'2px solid #F44336', borderRadius:3} : undefined}
                          title={scanCounts[s.peng_num] > 1 ? `Duplicate scan: #${s.peng_num} recorded ${scanCounts[s.peng_num]}× in this observation` : undefined}>
                          <PenguinMini scan={s} onClick={() => handleBirdClick(s.peng_num)} observationDate={o.observation_time_utc} />
                        </span>
                      ))}
                      {Array.from({ length: Number(o.no_scan) || 0 }).map((_, k) => (
                        <span key={`ns${k}`} className="scan no-scan">No scan</span>
                      ))}
                      {oi === 0 && chipMinis.map((c: any) => (
                        <PenguinMini key={c.pit_id} scan={c} onClick={() => handleBirdClick(c.peng_num)} observationDate={o.observation_time_utc} />
                      ))}
                      {o.gate_status && <span className="muted">{o.gate_status}</span>}
                      {isDup && <span style={{color:'#F44336', fontSize:10, fontWeight:600}}>⚠ dup</span>}
                      {hasDupScan && <span style={{color:'#F44336', fontSize:10, fontWeight:600}}>⚠ dup scan</span>}
                      {o.notes && <span className="day-note">{o.notes}</span>}
                    </div>
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
      </div>

      {sideBird && sideBirdData?.penguin && (
        <div className="day-bird-dock" ref={dockRef}>
          <BirdPage data={sideBirdData} onBirdClick={handleBirdClick}
            onBoxClick={(box: string) => onBoxClick(box)}
            onSightingClick={(box: string, d: string) => onBoxClick(box, d)}
            onDayClick={onDayClick} onClose={() => setSideBird(null)}
            token={token} canEdit={canEdit} />
        </div>
      )}
    </div>
  );
}

function parseUrl(): { box?: string; bird?: string; enter?: boolean; admin?: boolean; reports?: boolean; day?: string; obs?: string } {
  // Query-param form (current): box and bird are independent so a bird panel can
  // stay open across box changes and survive refresh/back — e.g. /?box=12&bird=PM1234.
  // obs (observation time) is a click-only anchor that deep-links to one observation.
  const q = new URLSearchParams(window.location.search);
  if (Array.from(q.keys()).length > 0) {
    return {
      box: q.get('box') || undefined,
      bird: q.get('bird') || undefined,
      day: q.get('day') || undefined,
      obs: q.get('obs') || undefined,
      enter: q.has('enter'),
      admin: q.has('admin'),
      reports: q.has('reports'),
    };
  }
  // Legacy path form — old bookmarks and cmd+click on path-style hrefs still resolve.
  const path = window.location.pathname;
  const boxMatch = path.match(/^\/box\/(.+)/);
  const birdMatch = path.match(/^\/bird\/(.+)/);
  const dayMatch = path.match(/^\/day\/(.+)/);
  return { box: boxMatch?.[1], bird: birdMatch?.[1], enter: path === '/enter', admin: path === '/admin', reports: path === '/reports', day: dayMatch?.[1] };
}

/**
 * Chrome-less panel for embedding (nestcheck WebView modal). Renders ONLY the bird OR box
 * panel. Syncs the whole colony into the SAME per-colony IndexedDB the browser uses
 * (primeFromCache for instant paint + offline, then syncDatabase), so after the first sync
 * every panel — and every bird/box link tapped inside it — is an instant, offline-capable
 * local query. Reuses the same BirdPage / BoxPanel / computeBoxFamilies as the full app.
 *
 * URL: /bird/<peng>?embed=1&colony_id=<n>  or  /box/<name>?embed=1&colony_id=<n>
 * Token: window.__WW_TOKEN__ (injected by host), or ?token=, or the stored web token.
 *
 * Host JS bridge (for a persistent pre-warmed WebView):
 *   window.wwShow(kind, id)  — render a bird/box without reloading the page
 *   window.wwSetColony(n)    — switch + re-sync colony in the background
 */
export function EmbeddedPanel() {
  const params = new URLSearchParams(window.location.search);
  const initialKind: 'box'|'bird' = /\/box\//.test(window.location.pathname) ? 'box' : 'bird';
  const initialId = decodeURIComponent(
    window.location.pathname.match(/\/(?:box|bird)\/([^/?#]+)/)?.[1]
    || params.get('peng') || params.get('peng_num') || params.get('box') || '');
  const token = (window as any).__WW_TOKEN__ || params.get('token') || localStorage.getItem('ww_token') || '';

  const [colonyId, setEmbedColony] = useState<number>(parseInt(params.get('colony_id') || '1', 10) || 1);
  const [view, setView] = useState<{ kind: 'box'|'bird'; id: string }>({ kind: initialKind, id: initialId });
  const [status, setStatus] = useState<'loading'|'ready'|'error'>('loading');
  const [errMsg, setErrMsg] = useState('');
  const [progress, setProgress] = useState('');
  const [highlightObs, setHighlightObs] = useState<string|null>(null);
  const [scrollToObs, setScrollToObs] = useState<string|null>(null);

  const birdData = useBirdDetail(status === 'ready' && view.kind === 'bird' ? view.id : null);
  const boxData = useBoxDetail(status === 'ready' && view.kind === 'box' ? view.id : null);
  const allPenguins = useAllPenguins();

  // Sync the colony once into its own IndexedDB. primeFromCache paints instantly from a prior
  // sync (and lets the panel work fully offline); syncDatabase refreshes in the background.
  // Re-runs only on colony change (setActiveColony clears mem + swaps DB).
  useEffect(() => {
    let cancelled = false;
    if (token) localStorage.setItem('ww_token', token); // so snapshot.php / fetchHistory authenticate
    setActiveColony(colonyId, `1-${colonyId}`);          // this colony's cache (region is irrelevant to the sync)
    setStatus('loading'); setProgress('');
    (async () => {
      let primed = false;
      try { primed = await primeFromCache(); if (!cancelled && primed) setStatus('ready'); }
      catch { /* fall through to full sync */ }
      try {
        await syncDatabase((msg) => { if (!cancelled) setProgress(msg); });
        if (!cancelled) setStatus('ready');
      } catch (e) {
        if (!cancelled && !primed) { setStatus('error'); setErrMsg(String((e as any)?.message || e)); }
      }
      // Same 30s change-poll as the full app (events.php watermark -> triggerSync). The
      // store-version bump re-renders any open panel; no extra onChanged work needed.
      if (!cancelled) startPolling(() => {});
    })();
    return () => { cancelled = true; stopPolling(); };
  }, [colonyId, token]);

  // Navigation is instant — the whole colony is in mem, so no fetch per bird/box.
  // A view-history stack backs the host app's ◀/▶ buttons (window.wwBack/wwForward).
  const histRef = useRef<{ stack: { kind: 'box'|'bird'; id: string }[]; idx: number }>(
    { stack: initialId ? [{ kind: initialKind, id: initialId }] : [], idx: initialId ? 0 : -1 });
  // The host app watches document.title (WebChromeClient.onReceivedTitle) to
  // show/hide its ◀/▶ buttons — there's no other JS→native channel here.
  const updateNavTitle = () => {
    const h = histRef.current;
    document.title = `wwnav:${h.idx > 0 ? 1 : 0}:${h.idx < h.stack.length - 1 ? 1 : 0}`;
  };
  const navTo = (v: { kind: 'box'|'bird'; id: string }) => {
    const h = histRef.current;
    h.stack = h.stack.slice(0, h.idx + 1);
    h.stack.push(v);
    h.idx = h.stack.length - 1;
    setHighlightObs(null); setScrollToObs(null); setView(v);
    updateNavTitle();
  };
  const goBird = (num: string) => { if (num) navTo({ kind: 'bird', id: num }); };
  const goBox = (box: string) => { if (box) navTo({ kind: 'box', id: box }); };
  const scrollObs = (t: string) => { setHighlightObs(null); setScrollToObs(null); setTimeout(() => { setHighlightObs(t); setScrollToObs(t); }, 10); };

  // Tell the host app when the colony sync has finished (it watches document.title) —
  // drives the "Web view" line in nestcheck's sync modal.
  useEffect(() => { if (status === 'ready') document.title = `wwready:${Date.now()}`; }, [status]);

  // JS bridge for a persistent host WebView: render a new bird/box or switch colony
  // without a page reload (see EMBED-FULLSYNC-PLAN.md Phase 2).
  useEffect(() => {
    (window as any).wwShow = (kind: 'box'|'bird', id: string) => {
      if (!id) return;
      // Host is opening a fresh panel — start a new history session so ◀ only
      // appears once the user has navigated within the panel.
      const v = { kind: kind === 'box' ? 'box' : 'bird', id: String(id) } as const;
      histRef.current = { stack: [v], idx: 0 };
      setHighlightObs(null); setScrollToObs(null); setView(v);
      updateNavTitle();
    };
    (window as any).wwSetColony = (n: number) => {
      const c = parseInt(String(n), 10);
      if (c > 0) setEmbedColony(c);
    };
    const step = (dir: number) => {
      const h = histRef.current;
      const i = h.idx + dir;
      if (i < 0 || i >= h.stack.length) return false;
      h.idx = i;
      setHighlightObs(null); setScrollToObs(null); setView(h.stack[i]);
      updateNavTitle();
      return true;
    };
    (window as any).wwBack = () => step(-1);
    (window as any).wwForward = () => step(1);
    updateNavTitle();
    return () => { delete (window as any).wwShow; delete (window as any).wwSetColony; delete (window as any).wwBack; delete (window as any).wwForward; };
  }, []);

  if (status === 'error') return <div className="embed-state embed-error">Couldn't load colony data<div className="muted" style={{marginTop:6, fontSize:12}}>{errMsg}</div></div>;
  if (status !== 'ready') return <div className="embed-state">Syncing colony…<div className="muted" style={{marginTop:6, fontSize:12}}>{progress}</div></div>;

  if (view.kind === 'box') {
    if (!boxData?.location) return <div className="embed-state embed-error">Box {view.id} not found</div>;
    return (
      <div className="embed-box">
        <div className="page-header"><div className="box-header-left"><h2>Box {view.id}</h2><StatusLegend /></div></div>
        <BreedingStatusBar observations={boxData.observations} hideLegend onHighlight={setHighlightObs} onScrollTo={scrollObs} />
        <div className="detail-split">
          <BoxPanel data={boxData} boxName={view.id} allPenguins={allPenguins}
            onBirdClick={goBird} onDayClick={() => {}}
            highlightObs={highlightObs} scrollToObs={scrollToObs} onScrollToObs={scrollObs}
            token={token} canEdit={false} />
        </div>
      </div>
    );
  }

  if (!birdData?.penguin) return <div className="embed-state embed-error">Bird {view.id} not found</div>;
  return (
    <div className="embed-bird">
      <BirdPage data={birdData} onBirdClick={goBird} onBoxClick={goBox} onSightingClick={(box: string) => goBox(box)} onDayClick={undefined} token={token} canEdit={false} />
    </div>
  );
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

  // Emailed set-password link (invite or forgot-password) — takes over even when a
  // session exists, since the link may be for a different account on this device.
  const setpwToken = new URLSearchParams(window.location.search).get('setpw');
  if (setpwToken) {
    return <SetPasswordScreen setpwToken={setpwToken} onLogin={handleLogin} />;
  }

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

/** Add a new penguin chipped in a given box: creates the penguin, its chip (17-char PIT),
 *  and a biometric record (matching nestcheck's biometric fields). */
function AddPenguinDialog({ token, chipBox, defaultChipBy, allPenguins, onClose, onAdded }: {
  token: string; chipBox: string; defaultChipBy: string; allPenguins: any[];
  onClose: () => void; onAdded: (pengNum: string) => void;
}) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Pacific/Auckland' });
  const [date, setDate] = useState(today);
  const [pit, setPit] = useState('');
  const [box, setBox] = useState(chipBox);
  const [chipBy, setChipBy] = useState(defaultChipBy);
  const [isAdult, setIsAdult] = useState(true);
  const [chickSize, setChickSize] = useState('');
  const [weight, setWeight] = useState('');
  const [flipper, setFlipper] = useState('');
  const [observedSex, setObservedSex] = useState('');
  const [moulting, setMoulting] = useState(false);
  const [ticks, setTicks] = useState(false);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const pitNorm = pit.toUpperCase().trim();
  const pitValid = /^[A-Z]{2}\d{15}$/.test(pitNorm);
  const dup = pitValid ? allPenguins.find((p: any) => (p.pit_id || '').toUpperCase() === pitNorm) : null;
  // Predict the peng_num the server will assign (MAX + 1) for the title.
  const nextPengNum = useMemo(() => allPenguins.reduce((m: number, p: any) => Math.max(m, parseInt(p.peng_num) || 0), 0) + 1, [allPenguins]);

  const save = async () => {
    setError('');
    if (!date) { setError('Date required'); return; }
    if (!pitValid) { setError('PIT id must be 2 letters followed by 15 digits (17 chars)'); return; }
    if (dup) { setError(`PIT already assigned to #${dup.peng_num}`); return; }
    if (!box.trim()) { setError('Chip box required'); return; }
    if (!chipBy.trim()) { setError('Chipped by is required'); return; }
    if (!isAdult && !chickSize) { setError('Select chick size (LC / BC / SC)'); return; }
    setSaving(true);
    try {
      const pengRes = await createRecord(token, 'penguins', {
        chipped_as_adult: isAdult ? 1 : 0, chick_size_code: isAdult ? null : chickSize,
      });
      if (!pengRes.success) { setError('Penguin: ' + (pengRes.error || 'failed')); setSaving(false); return; }
      const pengNum = pengRes.peng_num;

      const chipLoc = queryAllLocations().find((l: any) => String(l.location_name) === box.trim());
      const chipRes = await createRecord(token, 'penguin_chips', {
        pit_id: pitNorm, peng_num: pengNum, chip_date: date,
        chip_box: box.trim(), location_id: chipLoc?.location_id ?? null, chip_by: chipBy.trim() || null, is_active: 1,
      });
      if (!chipRes.success) { setError('Chip: ' + (chipRes.error || 'failed') + ` (penguin #${pengNum} was created)`); setSaving(false); return; }

      const bio: Record<string, any> = {
        peng_num: pengNum, observation_date: date,
        observed_sex: observedSex || null,
        is_moulting: moulting ? 1 : 0, condition_ticks: ticks ? 1 : 0,
        notes: notes.trim() || null,
      };
      if (weight.trim()) bio.weight = parseFloat(weight);
      if (flipper.trim()) bio.flipper_length = parseFloat(flipper);
      await createRecord(token, 'penguin_biometric_data', bio);

      onAdded(pengNum);
    } catch (e: any) {
      setError('Error: ' + e.message);
      setSaving(false);
    }
  };

  return (
    <div className="login-page" onClick={onClose}>
      <div className="login-card add-penguin-card" onClick={e => e.stopPropagation()}>
        <h2>Enter penguin #{nextPengNum} · Box {chipBox}</h2>
        <div className="app-row">
          <div className="app-field"><label className="req">Date</label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)} /></div>
          <div className="app-field"><label className="req">Chip box</label>
            <input type="text" value={box} onChange={e => setBox(e.target.value)} /></div>
        </div>
        <div className="app-field"><label className="req">PIT id (2 letters + 15 digits)</label>
          <input type="text" value={pit} maxLength={17} placeholder="LA956000016349556" autoFocus
            style={{ fontFamily: 'monospace', borderColor: pit && !pitValid ? '#c0392b' : undefined }}
            onChange={e => setPit(e.target.value.toUpperCase())} /></div>
        {pit && !pitValid && <div className="app-pit-error">Must be 2 letters then 15 digits (17 chars)</div>}
        {dup && <div className="app-pit-error">Already assigned to #{dup.peng_num}</div>}
        <div className="app-row">
          <div className="app-field"><label className="req">Life stage</label>
            <div className="app-toggle">
              <button type="button" className={isAdult ? 'active' : ''} onClick={() => setIsAdult(true)}>Adult</button>
              <button type="button" className={!isAdult ? 'active' : ''} onClick={() => setIsAdult(false)}>Chick</button>
            </div></div>
          <div className="app-field"><label className="req">Chipped by</label>
            <input type="text" value={chipBy} onChange={e => setChipBy(e.target.value)} placeholder="initials"
              style={{ borderColor: !chipBy.trim() ? '#c0392b' : undefined }} /></div>
        </div>
        {!isAdult && (
          <div className="app-field"><label>Chick size</label>
            <div className="app-toggle">
              {[['LC', 'Little'], ['BC', 'Big'], ['SC', 'Single']].map(([code, label]) => (
                <button key={code} type="button" className={chickSize === code ? 'active' : ''} onClick={() => setChickSize(chickSize === code ? '' : code)}>{code} · {label}</button>
              ))}
            </div></div>
        )}
        <div className="app-row">
          <div className="app-field"><label>Weight (g)</label>
            <input type="number" value={weight} onChange={e => setWeight(e.target.value)} placeholder="—" /></div>
          <div className="app-field"><label>Flipper (mm)</label>
            <input type="number" value={flipper} onChange={e => setFlipper(e.target.value)} placeholder="—" /></div>
        </div>
        <div className="app-field"><label>Sex guess</label>
          <select value={observedSex} onChange={e => setObservedSex(e.target.value)}>
            <option value="">—</option>
            <option value="PM">Probably male</option>
            <option value="MM">Maybe male</option>
            <option value="U">Unsure</option>
            <option value="MF">Maybe female</option>
            <option value="PF">Probably female</option>
          </select></div>
        <div className="app-checks">
          <label><input type="checkbox" checked={moulting} onChange={e => setMoulting(e.target.checked)} /> Moulting</label>
          <label><input type="checkbox" checked={ticks} onChange={e => setTicks(e.target.checked)} /> Ticks</label>
        </div>
        <div className="app-field"><label>Notes</label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} /></div>
        {error && <div className="login-error">{error}</div>}
        <div className="app-actions">
          <button type="button" className="ghost-btn" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="button" onClick={save} disabled={saving || !pitValid || !!dup || !chipBy.trim() || (!isAdult && !chickSize)}>{saving ? 'Saving…' : 'Add penguin'}</button>
        </div>
      </div>
    </div>
  );
}

function CollapsibleSeason({ label, observations, onBirdClick, onDayClick, highlightObs, scrollToObs, token, canEdit, allPenguins, onDataChange }: any) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const target = scrollToObs || highlightObs;
    if (target && observations.some((o: any) => o.observation_time_utc === target)) setExpanded(true);
  }, [scrollToObs, highlightObs]);
  return (
    <div>
      <div className="season-divider clickable" onClick={() => setExpanded(!expanded)}><hr/><span>{seasonRange(label)} ({observations.length}) {expanded ? '▲' : '▼'}</span><hr/></div>
      {expanded && mergeSameDayChips(observations).map((o: any, i: number) => o._chip
        ? <ChipCard key={`chip${o.pit_id}`} date={o.chip_date} birds={o._chipBirds} onBirdClick={onBirdClick} onDayClick={onDayClick} />
        : <ObsCard key={o.observation_id || `${label}${i}`} obs={o} onBirdClick={onBirdClick} onDayClick={onDayClick} highlight={highlightObs !== null && o.observation_time_utc === highlightObs} scrollTo={scrollToObs !== null && o.observation_time_utc === scrollToObs} token={token} canEdit={canEdit} allPenguins={allPenguins} onDataChange={onDataChange} />)}
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
              <span style={{background: e.action === 'DELETE' ? '#F44336' : e.action === 'INSERT' ? '#4CAF50' : e.action === 'IMPORT' ? '#00897b' : '#2196F3', color:'#fff', fontSize:10, padding:'1px 6px', borderRadius:3}}>{e.action}</span>
              <span>{e.table_name === '__sql_console' ? 'SQL console' : e.table_name === '__import' ? (fields?.filename || 'Import') : e.table_name === 'date_mappings' ? `Date table · season ${String(e.record_id).slice(-2)}` : `${e.table_name}${e.box_name ? ` · Box ${e.box_name}` : ''} #${e.record_id}`}</span>
              <span className="muted">{e.observer_name || ''}</span>
              {e.change_reason && <span style={{fontStyle:'italic', color:'#666'}}>"{e.change_reason}"</span>}
            </div>
            {e.table_name === '__sql_console' && fields?.sql && (
              <div style={{fontSize:11, marginTop:2, fontFamily:'monospace', color:'#555', whiteSpace:'pre-wrap', wordBreak:'break-word'}}>{fields.sql}</div>
            )}
            {e.table_name === '__import' && fields && (
              <div className="muted" style={{fontSize:11, marginTop:2}}>
                {fields.observations} observation{fields.observations !== 1 ? 's' : ''}
                {fields.scans ? `, ${fields.scans} scan${fields.scans !== 1 ? 's' : ''}` : ''}
                {fields.biometrics ? `, ${fields.biometrics} biometric${fields.biometrics !== 1 ? 's' : ''}` : ''}
                {fields.colony ? ` · ${fields.colony}` : ''}
              </div>
            )}
            {/* Date-table edits store old/new as arrays of date rows — render a per-number diff, not [object Object]. */}
            {e.action === 'UPDATE' && e.table_name === 'date_mappings' && fields && (() => {
              const norm = (r: any) => ({ n: Number(r.n ?? r.date_number), date: String(r.date ?? r.actual_date ?? '').slice(0, 10), pm: !!(r.partial ?? Number(r.partial_monitor)) });
              const oldRows: any[] = Array.isArray(fields.old) ? fields.old.map(norm) : [];
              const newRows: any[] = Array.isArray(fields.new) ? fields.new.map(norm) : [];
              const oldByN = new Map(oldRows.map(r => [r.n, r]));
              const newByN = new Map(newRows.map(r => [r.n, r]));
              const fmt = (r: any) => r ? `${r.date.slice(8, 10)}/${r.date.slice(5, 7)}/${r.date.slice(0, 4)}${r.pm ? ' PM' : ''}` : '—';
              const nums = Array.from(new Set([...oldByN.keys(), ...newByN.keys()])).sort((a, b) => a - b);
              const changes = nums.map(n => ({ n, o: oldByN.get(n), nw: newByN.get(n) }))
                .filter(c => !c.o || !c.nw || c.o.date !== c.nw.date || c.o.pm !== c.nw.pm);
              return <div style={{fontSize:11, marginTop:2}}>
                <span className="muted">{oldRows.length} → {newRows.length} dates{changes.length === 0 ? ' · no per-date changes' : ''}</span>
                {changes.length > 0 && <div style={{marginTop:2}}>
                  {changes.map(c => (
                    <span key={c.n} className="muted" style={{marginRight:8}}>#{c.n}: {c.o && c.nw ? <><s>{fmt(c.o)}</s> → {fmt(c.nw)}</> : c.nw ? <>+ {fmt(c.nw)}</> : <>− {fmt(c.o)}</>}</span>
                  ))}
                </div>}
              </div>;
            })()}
            {e.action === 'UPDATE' && e.table_name !== 'date_mappings' && fields && (
              <div style={{fontSize:11, marginTop:2}}>
                {Object.entries(fields).map(([k, v]: [string, any]) => (
                  <span key={k} className="muted" style={{marginRight:8}}>{k}: {v && typeof v === 'object' && 'old' in v ? <><s>{String(v.old ?? '')}</s> → {String(v.new ?? '')}</> : String(v ?? '')}</span>
                ))}
              </div>
            )}
            {/* INSERTs store the whole new row — show its meaningful fields (drop the ids/plumbing). */}
            {e.action === 'INSERT' && fields && e.table_name !== '__sql_console' && (
              <div style={{fontSize:11, marginTop:2}}>
                {Object.entries(fields)
                  .filter(([k, v]: [string, any]) => !['location_id','observer_id','colony_id','monitor_filename','is_deleted','observation_id','scan_id','biometric_id'].includes(k) && v !== null && v !== '' )
                  .map(([k, v]: [string, any]) => (
                    <span key={k} className="muted" style={{marginRight:8}}>{k}: {String(typeof v === 'string' && /^\d{4}-\d\d-\d\d[ T]/.test(v) ? v.slice(0, 16).replace('T', ' ') : v)}</span>
                  ))}
              </div>
            )}
          </div>
        );
      })}
    </div>}
  </div>;
}

/** Reports page body: the report cards grouped into tabs (mirrors AdminPanel's tab bar).
 *  The active tab is persisted to the URL's ?tab= param, just like the admin page. */
function ReportsPage({ onOpenBird, onDayClick }: { onOpenBird: (num: string) => void; onDayClick: (day: string) => void }) {
  const REPORT_TABS = ['colony', 'breeding', 'population', 'social', 'quality'] as const;
  type ReportTab = typeof REPORT_TABS[number];
  const [tab, setTab] = useState<ReportTab>(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    return (REPORT_TABS as readonly string[]).includes(t || '') ? (t as ReportTab) : 'colony';
  });
  const selectTab = (id: ReportTab) => {
    setTab(id);
    const u = new URL(window.location.href);
    if (id === 'colony') u.searchParams.delete('tab'); else u.searchParams.set('tab', id);
    window.history.replaceState(null, '', u.pathname + u.search);
  };

  return (
    <>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', margin: '0 0 16px', borderBottom: '1px solid #ddd' }}>
        {(([['colony', 'Colony'], ['breeding', 'Breeding & chicks'], ['population', 'Population'], ['social', 'Pairs & groups'], ['quality', 'Data quality']]) as const).map(([id, label]) => (
          <button key={id} onClick={() => selectTab(id)}
            style={{ padding: '8px 14px', border: 'none', borderBottom: tab === id ? '2px solid #1a6b8f' : '2px solid transparent',
              background: 'none', cursor: 'pointer', fontWeight: tab === id ? 600 : 400, color: tab === id ? '#1a6b8f' : '#555', fontSize: 14, marginBottom: -1 }}>
            {label}
          </button>
        ))}
      </div>

      <div style={{ display: tab === 'colony' ? undefined : 'none' }}>
        <DistinctAdultsChart />
        <PeakAdultsChart onDayClick={onDayClick} />
        <FirstEggReport onDayClick={onDayClick} />
        <EggArrivalChart />
      </div>

      <div style={{ display: tab === 'breeding' ? undefined : 'none' }}>
        <ChickReturnChart />
        <ChickSexChart />
        <ChickSexBothReturnedChart />
        <TopChickParentsReport onOpenBird={onOpenBird} />
        <UnproductiveParentsReport onOpenBird={onOpenBird} />
      </div>

      <div style={{ display: tab === 'population' ? undefined : 'none' }}>
        <PenguinAgeCharts />
        <SurvivalPredictionReport />
      </div>

      <div style={{ display: tab === 'social' ? undefined : 'none' }}>
        <PairBondReport onOpenBird={onOpenBird} />
        <FloaterReport onOpenBird={onOpenBird} />
        <PenguinGroupsReport onOpenBird={onOpenBird} />
      </div>

      <div style={{ display: tab === 'quality' ? undefined : 'none' }}>
        <MissedScansReport />
        <UnsexedByGuessesReport />
      </div>
    </>
  );
}

function AdminPanel({ token, observationDates }: { token: string; observationDates?: string[] }) {
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [diskTest, setDiskTest] = useState<any>(null);
  const [diskTesting, setDiskTesting] = useState(false);
  const [serverDisk, setServerDisk] = useState<any>(null);
  const [datePreview, setDatePreview] = useState<any>(null);
  const [recentChanges, setRecentChanges] = useState<any[]|null>(null);
  const [changesLoading, setChangesLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const dbVersion = useDbVersion(); // bumps whenever the local DB (IndexedDB) syncs
  // FM completeness: every incomplete registered book FM day up to today, in the order
  // the book tables list them, with the number of box observations still needed for it
  // to count as a full monitor. Grouped by season, oldest season first.
  const { registeredFmDates } = useContext(DateTooltipCtx);
  const fmCompleteness = useMemo(() => {
    const today = toNzDateStr(new Date().toISOString());
    const bySeason = new Map<number, { day: string; number: number; missing: number; boxes: string[] }[]>();
    let total = 0;
    for (const [day, fm] of registeredFmDates) {
      if (day > today) continue;
      if (fm.partial) continue; // Partial Monitor days are deliberately incomplete — not actionable
      const st = computeDateStats(day);
      if (!st) continue;
      if (st.isFullMonitor) continue; // complete days aren't actionable — hide them
      const boxes: string[] = st.missingBoxes || [];
      // Group by the Apr 1 – Mar 31 season the date actually falls in, not the book's
      // season_year label (a book can number dates past 1 Apr into the next season).
      const seasonYear = Number(day.slice(0, 4)) - (Number(day.slice(5, 7)) >= 4 ? 0 : 1);
      if (!bySeason.has(seasonYear)) bySeason.set(seasonYear, []);
      bySeason.get(seasonYear)!.push({ day, number: fm.number, missing: boxes.length, boxes });
      total++;
    }
    const seasons = Array.from(bySeason.entries()).sort((a, b) => a[0] - b[0]);
    return { seasons, total };
  }, [registeredFmDates, dbVersion]);
  const ADMIN_TABS = ['io', 'validation', 'users', 'database', 'system'] as const;
  type AdminTab = typeof ADMIN_TABS[number];
  const [adminTab, setAdminTab] = useState<AdminTab>(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    return (ADMIN_TABS as readonly string[]).includes(t || '') ? (t as AdminTab) : 'io';
  });
  const selectTab = (id: AdminTab) => {
    setAdminTab(id);
    const u = new URL(window.location.href);
    if (id === 'io') u.searchParams.delete('tab'); else u.searchParams.set('tab', id);
    window.history.replaceState(null, '', u.pathname + u.search);
  };

  // --- Monitor CSV import (two-phase: analyze -> confirm -> commit) ---
  const [impFile, setImpFile] = useState<string>('');        // filename
  const [impCsv, setImpCsv] = useState<string>('');          // raw CSV text
  const [impColony, setImpColony] = useState<number>(getColonyId());
  const [impAnalysis, setImpAnalysis] = useState<any>(null);
  const [impAnalyzing, setImpAnalyzing] = useState(false);
  const [impCommitting, setImpCommitting] = useState(false);
  // Override: import rows that conflict with same-day existing data as second observations.
  const [impConflicts, setImpConflicts] = useState(false);
  const [impResult, setImpResult] = useState<any>(null);
  const [impError, setImpError] = useState('');
  const [impRowFilter, setImpRowFilter] = useState<'issues' | 'all'>('issues');
  // Bird panel docked on the right of the admin screen (opened from #peng cells / import minis).
  const [adminBird, setAdminBird] = useState<string|null>(null);
  const adminBirdData = useBirdDetail(adminBird);
  useEffect(() => { _adminOpenBird = setAdminBird; return () => { if (_adminOpenBird === setAdminBird) _adminOpenBird = null; }; }, []);
  const allPengsForMini = useAllPenguins();
  const pengByNumMini = useMemo(() => {
    const m = new Map<string, any>();
    for (const p of (allPengsForMini || [])) m.set(String(p.peng_num), p);
    return m;
  }, [allPengsForMini]);

  // Data-integrity checks — computed locally from the colony cache (instant).
  const iBirdTwoBoxes = useBirdTwoBoxes();
  const iScanBeforeChip = useScanBeforeChip();
  const iDeadScanned = useDeadScanned();
  const iImprobable = useImprobableCounts();
  const iFuture = useFutureObservations();
  const iRetired = useRetiredTagScans();
  const iChicksNoScan = useChicksNoScan();
  const iDupObs = useDuplicateObservations();
  const iDupScans = useDuplicateScans();
  const iSameGender = useSameGenderConflicts();

  const impReset = () => { setImpAnalysis(null); setImpResult(null); setImpError(''); setImpConflicts(false); };

  // Analyze immediately (from args, since state updates are async on file pick / colony change).
  const impAnalyze = async (csv = impCsv, filename = impFile, colony = impColony) => {
    if (!csv.trim()) { setImpError('Choose a CSV file first'); return; }
    setImpAnalyzing(true); setImpError(''); setImpResult(null); setImpAnalysis(null);
    try {
      const r = await fetch('/api/admin.php?action=import_csv_analyze', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ csv, filename, colony_id: colony }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
      setImpAnalysis(d);
      setImpRowFilter('issues');   // problems first; toggle to all rows if wanted
    } catch (e: any) { setImpError(e.message || 'Analysis failed'); }
    setImpAnalyzing(false);
  };

  const impPickFile = async (f: File | null) => {
    impReset();
    if (!f) { setImpFile(''); setImpCsv(''); return; }
    const text = await f.text();
    setImpFile(f.name); setImpCsv(text);
    impAnalyze(text, f.name, impColony);   // analyze on selection — no button
  };

  const impCommit = async () => {
    if (!impAnalysis || impCommitting) return;
    setImpCommitting(true); setImpError('');
    try {
      const r = await fetch('/api/admin.php?action=import_csv_commit', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ csv: impCsv, filename: impFile, colony_id: impColony, import_conflicts: impConflicts }),
      });
      const d = await r.json();
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`);
      setImpResult(d);
      setImpAnalysis(null);
      // If we imported into the colony currently being viewed, pull the new rows into the cache.
      if (impColony === getColonyId()) triggerSync();
    } catch (e: any) { setImpError(e.message || 'Import failed'); }
    setImpCommitting(false);
  };

  // Read-only DB browser + SQL console. Available to all admins (enforced server-side too).
  const canSql = localStorage.getItem('ww_role') === 'admin';
  const PAGE = 10000;
  const qId = (name: string) => '`' + String(name).replace(/`/g, '``') + '`';   // backtick-quote an identifier

  // Low-level: run one read-only statement, return the result JSON or throw.
  const execSql = async (sql: string) => {
    const r = await fetch('/api/admin.php?action=sql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ sql }),
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    return d;
  };

  // --- Schema tree state ---
  const [tables, setTables] = useState<string[] | null>(null);
  const [expandedCols, setExpandedCols] = useState<Record<string, any[]>>({});   // table -> columns (SHOW COLUMNS rows)
  const [selTable, setSelTable] = useState<string | null>(null);
  const [tableData, setTableData] = useState<any>(null);
  const [tableCount, setTableCount] = useState<number>(0);
  const [page, setPage] = useState(0);
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'ASC' | 'DESC'>('ASC');
  const [browseErr, setBrowseErr] = useState('');
  const [browseLoading, setBrowseLoading] = useState(false);

  const loadTables = async () => {
    setBrowseErr('');
    try {
      const d = await execSql("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name");
      setTables(d.rows.map((r: any) => r.t ?? r.TABLE_NAME ?? Object.values(r)[0]));
    } catch (e: any) { setBrowseErr(e.message); setTables([]); }
  };

  const toggleCols = async (table: string) => {
    if (expandedCols[table]) { const { [table]: _, ...rest } = expandedCols; setExpandedCols(rest); return; }
    try {
      const d = await execSql(`SHOW COLUMNS FROM ${qId(table)}`);
      setExpandedCols(prev => ({ ...prev, [table]: d.rows }));
    } catch (e: any) { setBrowseErr(e.message); }
  };

  // Fetch one page. Sorting/paging re-query server-side (ORDER BY is applied to the
  // whole table, not just the loaded page). recount only on a fresh table selection.
  const loadPage = async (table: string, toPage: number, sCol: string | null, sDir: 'ASC' | 'DESC', recount: boolean) => {
    setSelTable(table); setPage(toPage); setSortCol(sCol); setSortDir(sDir);
    setBrowseErr(''); setBrowseLoading(true);
    try {
      if (recount) {
        const c = await execSql(`SELECT COUNT(*) AS n FROM ${qId(table)}`);
        setTableCount(Number(c.rows[0]?.n ?? 0));
      }
      const orderBy = sCol ? ` ORDER BY ${qId(sCol)} ${sDir}` : '';
      const d = await execSql(`SELECT * FROM ${qId(table)}${orderBy} LIMIT ${PAGE} OFFSET ${toPage * PAGE}`);
      setTableData(d);
    } catch (e: any) { setBrowseErr(e.message); setTableData(null); }
    setBrowseLoading(false);
  };

  const openTable = (table: string) => loadPage(table, 0, null, 'ASC', true);        // fresh selection: reset sort
  const gotoPage = (p: number) => { if (selTable) loadPage(selTable, p, sortCol, sortDir, false); };
  const sortBy = (col: string) => {
    if (!selTable) return;
    const dir: 'ASC' | 'DESC' = sortCol === col && sortDir === 'ASC' ? 'DESC' : 'ASC';
    loadPage(selTable, 0, col, dir, false);                                          // re-sort from page 0
  };

  useEffect(() => { if (canSql && tables === null) loadTables(); }, [canSql]);

  // --- Free-form SQL console state ---
  const [sqlText, setSqlText] = useState('');
  const [sqlResult, setSqlResult] = useState<any>(null);
  const [sqlError, setSqlError] = useState('');
  const [sqlRunning, setSqlRunning] = useState(false);

  const runSql = async () => {
    if (!sqlText.trim() || sqlRunning) return;
    setSqlRunning(true); setSqlError('');
    try { setSqlResult(await execSql(sqlText)); }
    catch (e: any) { setSqlError(e.message); setSqlResult(null); }
    setSqlRunning(false);
  };

  const copyCsv = (res: any) => {
    const esc = (v: any) => v === null || v === undefined ? ''
      : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
    const lines = [res.columns.join(','), ...res.rows.map((row: any) => res.columns.map((c: string) => esc(row[c])).join(','))];
    navigator.clipboard.writeText(lines.join('\n'));
  };

  // Shared read-only results grid. Pass `sort` (browser only) to make headers clickable —
  // sorting re-queries the whole table server-side rather than sorting the current page.
  const resultGrid = (res: any, sort?: { col: string | null; dir: 'ASC' | 'DESC'; onSort: (c: string) => void }) => (
    <div style={{ overflow: 'auto', maxHeight: 460, border: '1px solid #ddd' }}>
      <table style={{ fontSize: 12, fontFamily: 'monospace', borderCollapse: 'collapse' }}>
        <thead><tr>{res.columns.map((c: string) => (
          <th key={c} onClick={sort ? () => sort.onSort(c) : undefined}
            title={sort ? 'Sort by this column' : undefined}
            style={{ position: 'sticky', top: 0, background: '#f5f5f5', padding: '4px 8px', textAlign: 'left', borderBottom: '1px solid #ccc', whiteSpace: 'nowrap', cursor: sort ? 'pointer' : 'default', userSelect: 'none' }}>
            {c}{sort && sort.col === c ? (sort.dir === 'ASC' ? ' ▲' : ' ▼') : ''}
          </th>
        ))}</tr></thead>
        <tbody>
          {res.rows.map((row: any, i: number) => (
            <tr key={i}>{res.columns.map((c: string) => (
              <td key={c} style={{ padding: '3px 8px', borderBottom: '1px solid #eee', whiteSpace: 'nowrap', maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis' }} title={row[c] === null ? 'NULL' : String(row[c])}>
                {row[c] === null ? <span className="muted">NULL</span> : String(row[c])}
              </td>
            ))}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  const loadRecentChanges = async () => {
    setChangesLoading(true);
    const r = await fetch('/api/admin.php?action=recent_changes&days=7', { headers: { 'Authorization': `Bearer ${token}` } });
    setRecentChanges(await r.json());
    setChangesLoading(false);
  };
  // Auto-load, and re-fetch whenever the local DB syncs (a sync means the server data — and so
  // the audit log — has changed).
  useEffect(() => { loadRecentChanges(); }, [dbVersion]);

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
    fetch('/api/admin.php?action=colonies', { headers: { 'Authorization': `Bearer ${token}` } })
      .then(r => r.json()).then(d => setColonies(Array.isArray(d) ? d : [])).catch(() => {});
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

  const [colonies, setColonies] = useState<any[]>([]);
  const emptyNewUser = { observer_name: '', email: '', role: 'viewer', password: '' };
  const [newUser, setNewUser] = useState(emptyNewUser);
  const [newUserColonies, setNewUserColonies] = useState<Record<string, string>>({}); // colony_id -> 'view' | 'edit'
  const [addUserErr, setAddUserErr] = useState('');
  const [addUserOk, setAddUserOk] = useState('');
  const [addingUser, setAddingUser] = useState(false);
  const createUser = async () => {
    setAddUserErr(''); setAddUserOk('');
    const inviting = !newUser.password && !!newUser.email.trim();
    if (!newUser.observer_name.trim() || (!newUser.password && !inviting)) { setAddUserErr('Name plus a password — or an email to send an invite — are required'); return; }
    if (newUser.password && newUser.password.length < 6) { setAddUserErr('Password must be at least 6 characters'); return; }
    setAddingUser(true);
    try {
      const r = await fetch('/api/admin.php?action=create_user', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ observer_name: newUser.observer_name, email: newUser.email, role: newUser.role, password: newUser.password }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      // Optionally grant access to one or more colonies (skipped for Admins — they see all).
      if (newUser.role !== 'admin') {
        const grants = Object.entries(newUserColonies).filter(([, role]) => role === 'view' || role === 'edit');
        await Promise.all(grants.map(([cid, role]) => fetch('/api/admin.php?action=save_colony_permission', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ colony_id: Number(cid), observer_id: d.observer_id, role }),
        })));
      }
      setUsers([...users, d]);
      setNewUser(emptyNewUser); setNewUserColonies({});
      if (d.invited) setAddUserOk(d.email_sent ? `✓ Invite emailed to ${d.email}` : `Created, but the invite email failed — use "Email link" to retry`);
    } catch (e: any) { setAddUserErr(e.message || 'Failed to add user'); }
    setAddingUser(false);
  };

  // Email a set-password link (invite resend / forgot-password on the user's behalf)
  const [sendingResetFor, setSendingResetFor] = useState<number | null>(null);
  const [sendResetMsg, setSendResetMsg] = useState('');
  const sendResetEmail = async (u: any) => {
    setSendResetMsg('');
    setSendingResetFor(u.observer_id);
    try {
      const r = await fetch('/api/admin.php?action=send_reset', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ observer_id: u.observer_id }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setSendResetMsg(`✓ Set-password link emailed to ${d.email} (${u.observer_name})`);
    } catch (e: any) { setSendResetMsg(`${u.observer_name}: ${e.message || 'failed to send email'}`); }
    setSendingResetFor(null);
  };

  // 12-char password, avoiding visually ambiguous chars (0/O/1/l/I) for easy dictation.
  const genPassword = (len = 12) => {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    const a = new Uint32Array(len); crypto.getRandomValues(a);
    return Array.from(a, n => chars[n % chars.length]).join('');
  };
  const [resetFor, setResetFor] = useState<any | null>(null);
  const [resetPw, setResetPw] = useState('');
  const [resetMsg, setResetMsg] = useState('');
  const [resetting, setResetting] = useState(false);
  const resetPassword = async () => {
    if (!resetFor) return;
    setResetMsg('');
    if (resetPw.length < 6) { setResetMsg('Password must be at least 6 characters'); return; }
    setResetting(true);
    try {
      const r = await fetch('/api/admin.php?action=reset_password', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ observer_id: resetFor.observer_id, password: resetPw }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
      setResetMsg(`✓ Password for ${resetFor.observer_name} set to:  ${resetPw}`);
    } catch (e: any) { setResetMsg(e.message || 'Failed to reset password'); }
    setResetting(false);
  };



  return (
    <>
    <div className={`admin-panel${adminBird && adminBirdData?.penguin ? ' admin-page-docked' : ''}`}>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', margin: '0 0 16px', borderBottom: '1px solid #ddd' }}>
        {(([['io', 'Import & export'], ['validation', 'Data validation'], ['users', 'Users & colonies'], ['database', 'Database'], ['system', 'System']]) as const).map(([id, label]) => (
          <button key={id} onClick={() => selectTab(id)}
            style={{ padding: '8px 14px', border: 'none', borderBottom: adminTab === id ? '2px solid #1a6b8f' : '2px solid transparent',
              background: 'none', cursor: 'pointer', fontWeight: adminTab === id ? 600 : 400, color: adminTab === id ? '#1a6b8f' : '#555', fontSize: 14, marginBottom: -1 }}>
            {label}
          </button>
        ))}
      </div>

      <div className="admin-section" style={{ display: adminTab === 'io' ? undefined : 'none' }}>
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

      <div className="admin-section" style={{ display: adminTab === 'io' ? undefined : 'none' }}>
        <h3>Import monitor CSV</h3>
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
          Columns: <code>Date, Box, Adults, Eggs, Chicks, Bird-1…, No scan, Notes</code>. Dates must be year-first (<code>YYYY-MM-DD</code>); other formats are skipped.
          “Decom” in Adults imports as a DCM observation. Bird cells are chip numbers; unmatched chips are reported, not created.
          Problematic rows are flagged for review (e.g. <strong>Adults ≠ birds listed + No scan</strong>, unmatched chips) but still import once you accept.
          Only rows that can’t become an observation — unknown box, unreadable date/number, or an existing duplicate — are skipped.
          Rows import as observations attributed to you. Nothing is written until you confirm.
        </p>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
          <label style={{ fontSize: 13 }}>Colony:{' '}
            <select value={impColony} onChange={e => { const cid = Number(e.target.value); setImpColony(cid); if (impCsv) impAnalyze(impCsv, impFile, cid); else impReset(); }}>
              {colonies.length === 0 && <option value={impColony}>Colony {impColony}</option>}
              {colonies.map((c: any) => (
                <option key={c.colony_id} value={c.colony_id}>{c.region_name} · {c.colony_name}</option>
              ))}
            </select>
          </label>
          <input type="file" accept=".csv,text/csv" onChange={e => impPickFile(e.target.files?.[0] ?? null)} />
          {impAnalyzing && <span className="muted" style={{ fontSize: 12 }}>Analyzing…</span>}
          {impFile && !impAnalyzing && <span className="muted" style={{ fontSize: 12 }}>{impFile}</span>}
        </div>

        {impError && <p style={{ color: '#c0392b', fontSize: 13, whiteSpace: 'pre-wrap' }}>{impError}</p>}

        {impResult && (
          <div style={{ border: '1px solid #b7e0b7', background: '#f2fbf2', borderRadius: 6, padding: 12, fontSize: 13 }}>
            <strong>✓ Imported into {impResult.colony_name}.</strong>{' '}
            {impResult.imported} observation(s), {impResult.scans} scan(s){impResult.biometrics ? `, ${impResult.biometrics} biometric(s)` : ''} written.
            {impResult.skipped_duplicates > 0 && <> {impResult.skipped_duplicates} duplicate row(s) skipped.</>}
            {impResult.imported_conflicts > 0 && <> <span style={{ color: '#d35400' }}>{impResult.imported_conflicts} conflicting row(s) imported as second observations.</span></>}
            {impResult.skipped_conflicts > 0 && <> {impResult.skipped_conflicts} conflicting row(s) skipped.</>}
            {impResult.skipped_errors > 0 && <> {impResult.skipped_errors} error row(s) skipped.</>}
            {impResult.unmatched_chips?.length > 0 && (
              <div style={{ marginTop: 6 }}>
                <span className="muted">Unmatched chips (no scan written): </span>
                {impResult.unmatched_chips.map((u: any) => `${u.chip}×${u.count}`).join(', ')}
              </div>
            )}
          </div>
        )}

        {impAnalysis && (() => {
          const t = impAnalysis.totals;
          const tiles: [string, any, string?][] = [
            ['Rows', t.rows], ['Will import', t.importable, '#1a7a1a'],
            ['Flagged', t.flagged, t.flagged ? '#8a6d3b' : undefined],
            ['Duplicates (skip)', t.duplicates, t.duplicates ? '#b8860b' : undefined],
            ['Conflicts', t.conflicts || 0, t.conflicts ? '#c0392b' : undefined],
            ['Errors (skip)', t.error_rows, t.error_rows ? '#c0392b' : undefined],
            ['Boxes', t.boxes], ['Not in sheet', t.boxes_missing, t.boxes_missing ? '#8a6d3b' : undefined], ['Decom→DCM', t.decom],
            ['Adults', t.adults], ['Eggs', t.eggs], ['Chicks', t.chicks], ['No-scan', t.no_scan],
            ['Biometrics', t.biometrics, t.biometrics ? '#1a7a1a' : undefined],
            ['No-scans created', t.noscan_confirm, t.noscan_confirm ? '#8a6d3b' : undefined],
            ['Scans matched', t.scans_matched, '#1a7a1a'],
            ['Chips unresolved', t.scans_unmatched, t.scans_unmatched ? '#c0392b' : undefined],
          ];
          const rows = impAnalysis.rows || [];
          const shown = impRowFilter === 'issues'
            ? rows.filter((r: any) => r.status !== 'ok' || r.warnings?.length)
            : rows;
          const conflictCount = t.conflicts || 0;
          const willImport = t.importable + (impConflicts ? conflictCount : 0);
          const canImport = willImport > 0 && !impCommitting;
          return (
            <div style={{ border: '1px solid #ddd', borderRadius: 6, padding: 12 }}>
              <div style={{ fontSize: 13, marginBottom: 8 }}>
                <strong>{impAnalysis.filename}</strong> → {impAnalysis.colony_name}
                {impAnalysis.date_min && <span className="muted"> · {impAnalysis.date_min}{impAnalysis.date_max !== impAnalysis.date_min ? ` – ${impAnalysis.date_max}` : ''}</span>}
              </div>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
                {tiles.map(([label, val, color]) => (
                  <div key={label} style={{ border: '1px solid #eee', borderRadius: 4, padding: '6px 10px', minWidth: 78 }}>
                    <div style={{ fontSize: 18, fontWeight: 600, color: color || '#222' }}>{val}</div>
                    <div className="muted" style={{ fontSize: 11 }}>{label}</div>
                  </div>
                ))}
              </div>

              {impAnalysis.file_flags?.length > 0 && impAnalysis.file_flags.map((f: string, i: number) => (
                <p key={i} style={{ color: '#8a6d3b', fontSize: 13, margin: '2px 0' }}>⚑ {f}</p>
              ))}

              {impAnalysis.coverage_missing?.length > 0 && (
                <details style={{ marginBottom: 8 }}>
                  <summary style={{ cursor: 'pointer', fontSize: 13 }}>{impAnalysis.coverage_missing.length} colony box(es) not in this sheet</summary>
                  <div style={{ fontSize: 12, marginTop: 6, maxHeight: 120, overflow: 'auto' }}>{impAnalysis.coverage_missing.join(', ')}</div>
                </details>
              )}

              {impAnalysis.unknown_boxes?.length > 0 && (
                <p style={{ color: '#c0392b', fontSize: 13 }}>
                  <strong>Unknown boxes</strong> (rows skipped — not locations in this colony): {impAnalysis.unknown_boxes.join(', ')}
                </p>
              )}

              {impAnalysis.unmatched_chips?.length > 0 && (
                <details style={{ marginBottom: 8 }} open>
                  <summary style={{ cursor: 'pointer', fontSize: 13 }}>
                    <strong>{impAnalysis.unmatched_chips.length} unmatched chip(s)</strong> — scans skipped, add these birds first if wanted
                  </summary>
                  <div style={{ fontSize: 12, fontFamily: 'monospace', marginTop: 6, maxHeight: 140, overflow: 'auto' }}>
                    {impAnalysis.unmatched_chips.map((u: any) => (
                      <div key={u.chip}>{u.chip} · ×{u.count} · box {u.boxes.join(', ')} · <span style={{ color: '#c0392b' }}>{u.reason}</span>{u.suggest ? <span style={{ color: '#1a7a1a' }}> → maybe #{u.suggest}</span> : ''}</div>
                    ))}
                  </div>
                </details>
              )}

              <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}>
                <span className="muted" style={{ fontSize: 12 }}>Show:</span>
                <button className="action-btn" style={{ opacity: impRowFilter === 'issues' ? 1 : 0.6 }} onClick={() => setImpRowFilter('issues')}>Issues only</button>
                <button className="action-btn" style={{ opacity: impRowFilter === 'all' ? 1 : 0.6 }} onClick={() => setImpRowFilter('all')}>All rows</button>
                <span className="muted" style={{ fontSize: 12 }}>{shown.length} shown</span>
              </div>

              <div style={{ overflow: 'auto', maxHeight: 380, border: '1px solid #eee' }}>
                <table style={{ fontSize: 12, borderCollapse: 'collapse', width: '100%' }}>
                  <thead><tr>{['Line', 'Box', 'Date', 'A', 'E', 'C', 'NS', 'Bio', 'Status', 'Scans', 'Notes'].map(h => (
                    <th key={h} style={{ position: 'sticky', top: 0, background: '#f5f5f5', padding: '3px 6px', textAlign: 'left', borderBottom: '1px solid #ccc', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}</tr></thead>
                  <tbody>
                    {shown.map((r: any) => {
                      const bg = r.status === 'error' ? '#fdecea' : r.status === 'conflict' ? '#ffe9d6' : r.status === 'duplicate' ? '#fff6e0' : r.warnings?.length ? '#fffbe6' : 'transparent';
                      // Click a row (incl. errors) to investigate: the box anchored at this row's own
                      // date/observation, or — if the box is unknown — the whole day.
                      const invHref = r.location_id
                        ? `/?box=${encodeURIComponent(r.box)}${(r.obs_time || r.prev_obs) ? `&obs=${encodeURIComponent(r.obs_time || r.prev_obs)}` : ''}`
                        : (r.date ? `/?day=${encodeURIComponent(r.date)}` : null);
                      const openBox = invHref ? () => window.open(invHref, '_blank') : undefined;
                      return (
                        <tr key={r.line} style={{ background: bg, cursor: openBox ? 'pointer' : 'default' }}
                          onClick={openBox}
                          title={openBox ? (r.prev_obs ? `Open box ${r.box} — previous observation (${String(r.prev_obs).slice(0, 10)})` : `Open box ${r.box} (no earlier observation)`) : undefined}>
                          <td style={{ padding: '2px 6px' }}>{r.line}</td>
                          <td style={{ padding: '2px 6px' }}>{r.box}</td>
                          <td style={{ padding: '2px 6px', whiteSpace: 'nowrap' }}>{r.date || '—'}</td>
                          <td style={{ padding: '2px 6px' }}>{r.is_decom ? 'Decom' : r.adults}</td>
                          <td style={{ padding: '2px 6px' }}>{r.eggs}</td>
                          <td style={{ padding: '2px 6px' }}>{r.chicks}</td>
                          <td style={{ padding: '2px 6px' }}>{r.no_scan}{r.confirm_no_scan ? <span style={{ color: '#8a6d3b' }}> ?</span> : ''}</td>
                          <td style={{ padding: '2px 6px', color: '#1a7a1a' }}>{r.bios?.length ? r.bios.map((b: any) => b.observed_sex).join(',') : ''}</td>
                          <td style={{ padding: '2px 6px', whiteSpace: 'nowrap' }}>
                            {r.status === 'error' ? <span style={{ color: '#c0392b' }}>error</span>
                              : r.status === 'conflict' ? <span style={{ color: '#d35400', fontWeight: 600 }}>conflict{impConflicts ? ' → import' : ''}</span>
                              : r.status === 'duplicate' ? <span style={{ color: '#b8860b' }}>duplicate</span>
                              : r.warnings?.length ? <span style={{ color: '#8a6d3b' }}>flag</span>
                              : r.breeding_status === 'DCM' ? <span style={{ color: '#8a6d3b' }}>DCM</span>
                              : <span style={{ color: '#1a7a1a' }}>ok</span>}
                          </td>
                          <td style={{ padding: '2px 6px' }}>
                            {r.scans?.length ? `${r.scans.length}✓` : ''}
                            {r.unmatched?.length ? <span style={{ color: '#c0392b' }}> {r.unmatched.length}✗</span> : ''}
                          </td>
                          <td style={{ padding: '2px 6px', color: '#c0392b' }}>
                            {(r.errors || []).join('; ')}
                            {r.conflict ? <span style={{ color: '#d35400' }}>{r.errors?.length ? ' · ' : ''}{r.conflict}</span> : ''}
                            {r.warnings?.length ? <span style={{ color: '#8a6d3b' }}>{(r.errors?.length || r.conflict) ? ' · ' : ''}{r.warnings.join('; ')}</span> : ''}
                            {r.notes ? <span className="muted" style={{ fontStyle: 'italic' }}>{(r.errors?.length || r.warnings?.length) ? ' · ' : ''}“{r.notes}”</span> : ''}
                            {r.mini_pengs?.length > 0 && (
                              <span onClick={e => e.stopPropagation()} style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', marginLeft: 6, verticalAlign: 'middle' }}>
                                {r.mini_pengs.map((pn: string) => {
                                  const p = pengByNumMini.get(String(pn));
                                  if (!p) return <span key={pn} className="muted" style={{ fontSize: 11 }}>#{pn}</span>;
                                  return <PenguinMini key={pn}
                                    scan={{ peng_num: p.peng_num, pit_id: p.pit_id, sex: p.sex, chip_date: p.chip_date, chipped_as_adult: p.chipped_as_adult, chick_size_code: p.chick_size_code, hasReturned: p.hasReturned }}
                                    onClick={() => setAdminBird(String(pn))} observationDate={r.date} />;
                                })}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {conflictCount > 0 && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, fontSize: 13, color: '#d35400' }}>
                  <input type="checkbox" checked={impConflicts} onChange={e => setImpConflicts(e.target.checked)} />
                  Import {conflictCount} conflicting row(s) anyway — each becomes a second observation for that box+day
                </label>
              )}
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12 }}>
                <button className="action-btn" disabled={!canImport}
                  style={{ background: canImport ? '#1a7a1a' : undefined, color: canImport ? '#fff' : undefined }}
                  onClick={impCommit}>
                  {impCommitting ? 'Importing…' : `Confirm import of ${willImport} observation(s)`}
                </button>
                <button className="action-btn" disabled={impCommitting} onClick={impReset}>Cancel</button>
                {t.error_rows > 0 && <span className="muted" style={{ fontSize: 12 }}>{t.error_rows} error row(s) will be skipped.</span>}
                {conflictCount > 0 && !impConflicts && <span className="muted" style={{ fontSize: 12 }}>{conflictCount} conflicting row(s) will be skipped.</span>}
              </div>
            </div>
          );
        })()}
      </div>

      <div className="admin-section" style={{ display: adminTab === 'io' ? undefined : 'none' }}>
        <h3>FM completeness{fmCompleteness.total > 0 ? `, ${fmCompleteness.total} missing` : ''}</h3>
        <p className="muted">Incomplete registered book FM days and how many box observations each still needs to be a complete full monitor</p>
        {fmCompleteness.total === 0 ? <p className="muted">All registered FM days are complete</p> : (<>
          {fmCompleteness.seasons.map(([season, rows]) => (
            <div key={season} style={{ marginBottom: 10 }}>
              <div className="season-title">{seasonRange(String(season))} · {rows.length} missing</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2 }}>
                {rows.map(r => (
                  <a key={r.day} href={`/day/${r.day}`} style={{ fontSize: 12, display: 'flex', gap: 8, alignItems: 'baseline', textDecoration: 'none', color: 'inherit' }}>
                    <span className="date-link" style={{ minWidth: 90 }}>{formatDate(r.day)}</span>
                    <span className="fm-tag" style={{ minWidth: 46 }}>(FM {r.number})</span>
                    <span style={{ color: '#E65100' }}>{r.missing} more needed{r.missing < 5
                      ? `, box${r.missing !== 1 ? 'es' : ''} ${r.boxes.join(', ')}` : ''}</span>
                  </a>
                ))}
              </div>
            </div>
          ))}
        </>)}
      </div>

      {canSql && (
      <div className="admin-section" style={{ display: adminTab === 'database' ? undefined : 'none', width: '100vw', position: 'relative', left: '50%', right: '50%', marginLeft: '-50vw', marginRight: '-50vw', padding: '0 24px', boxSizing: 'border-box' }}>
        <h3>Database <span className="muted" style={{ fontSize: 12, fontWeight: 'normal' }}>· read-only</span></h3>
        {browseErr && <p style={{ color: '#c0392b', fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap' }}>{browseErr}</p>}
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          {/* Schema tree */}
          <div style={{ flex: '0 0 240px', border: '1px solid #ddd', borderRadius: 4, maxHeight: 520, overflow: 'auto', fontSize: 13 }}>
            <div style={{ padding: '6px 8px', fontWeight: 600, borderBottom: '1px solid #eee', background: '#fafafa' }}>
              wildwatch_nestcheck {tables && <span className="muted" style={{ fontWeight: 400 }}>· {tables.length}</span>}
            </div>
            {tables === null ? <div className="muted" style={{ padding: 8 }}>Loading…</div> : tables.map(t => (
              <div key={t}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 6px', cursor: 'pointer', background: selTable === t ? '#e8f0fe' : undefined }}>
                  <span onClick={() => toggleCols(t)} style={{ width: 14, textAlign: 'center', color: '#888', userSelect: 'none' }}>{expandedCols[t] ? '▾' : '▸'}</span>
                  <span onClick={() => openTable(t)} style={{ flex: 1, fontFamily: 'monospace', fontWeight: selTable === t ? 600 : 400 }}>{t}</span>
                </div>
                {expandedCols[t] && (
                  <div style={{ paddingLeft: 24, paddingBottom: 4 }}>
                    {expandedCols[t].map((c: any) => (
                      <div key={c.Field} style={{ fontFamily: 'monospace', fontSize: 11, color: '#555', padding: '1px 0' }}>
                        {c.Key === 'PRI' ? '🔑 ' : ''}{c.Field} <span className="muted">{c.Type}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          {/* Data grid for the selected table */}
          <div style={{ flex: '1 1 420px', minWidth: 0 }}>
            {!selTable ? <p className="muted">Select a table to view its rows.</p> : (
              <>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
                  <strong style={{ fontFamily: 'monospace' }}>{selTable}</strong>
                  <span className="muted" style={{ fontSize: 12 }}>{tableCount.toLocaleString()} row{tableCount === 1 ? '' : 's'}</span>
                  {tableCount > PAGE && (
                    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                      <button className="action-btn" disabled={page === 0 || browseLoading} onClick={() => gotoPage(page - 1)}>‹ Prev</button>
                      <span className="muted" style={{ fontSize: 12 }}>
                        {(page * PAGE + 1).toLocaleString()}–{Math.min((page + 1) * PAGE, tableCount).toLocaleString()}
                      </span>
                      <button className="action-btn" disabled={(page + 1) * PAGE >= tableCount || browseLoading} onClick={() => gotoPage(page + 1)}>Next ›</button>
                    </span>
                  )}
                  {tableData && tableData.rowCount > 0 && <button className="action-btn" onClick={() => copyCsv(tableData)}>Copy CSV</button>}
                </div>
                {browseLoading ? <p className="muted">Loading…</p>
                  : tableData && tableData.columns.length > 0 ? resultGrid(tableData, { col: sortCol, dir: sortDir, onSort: sortBy })
                  : <p className="muted">Empty table.</p>}
              </>
            )}
          </div>
        </div>

        {/* Free-form SQL console */}
        <details style={{ marginTop: 16 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600 }}>SQL console</summary>
          <textarea
            value={sqlText}
            onChange={e => setSqlText(e.target.value)}
            onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); runSql(); } }}
            placeholder="SELECT * FROM penguins LIMIT 20"
            spellCheck={false}
            style={{ width: '100%', minHeight: 90, fontFamily: 'monospace', fontSize: 13, padding: 8, boxSizing: 'border-box', marginTop: 8 }}
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
            <button className="action-btn" disabled={sqlRunning} onClick={runSql}>{sqlRunning ? 'Running…' : 'Run (⌘/Ctrl+Enter)'}</button>
            {sqlResult && !sqlError && (
              <>
                <span className="muted" style={{ fontSize: 12 }}>
                  {sqlResult.rowCount} row{sqlResult.rowCount === 1 ? '' : 's'}{sqlResult.truncated ? ' (capped at 1000)' : ''} · {sqlResult.ms} ms
                </span>
                {sqlResult.rowCount > 0 && <button className="action-btn" onClick={() => copyCsv(sqlResult)}>Copy CSV</button>}
              </>
            )}
          </div>
          {sqlError && <p style={{ color: '#c0392b', fontFamily: 'monospace', fontSize: 12, marginTop: 8, whiteSpace: 'pre-wrap' }}>{sqlError}</p>}
          {sqlResult && !sqlError && sqlResult.columns.length > 0 && <div style={{ marginTop: 8 }}>{resultGrid(sqlResult)}</div>}
          {sqlResult && !sqlError && sqlResult.columns.length === 0 && <p className="muted" style={{ marginTop: 8 }}>Query ran; no rows returned.</p>}
        </details>
      </div>
      )}

      <div className="admin-section" style={{ display: adminTab === 'users' ? undefined : 'none' }}>
        <h3>Users</h3>
        {loading ? <p className="muted">Loading...</p> : (
          <table className="bird-table" style={{width:'100%'}}>
            <thead><tr><th>Name</th><th>Email</th><th>Role</th><th></th></tr></thead>
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
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="edit-btn" onClick={() => { setResetFor(u); setResetPw(genPassword()); setResetMsg(''); }}>Reset password</button>
                    {u.email && <button className="edit-btn" style={{ marginLeft: 6 }} disabled={sendingResetFor === u.observer_id}
                      title={`Email ${u.email} a link to set their own password`}
                      onClick={() => sendResetEmail(u)}>{sendingResetFor === u.observer_id ? 'Sending…' : 'Email link'}</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {sendResetMsg && <div style={{ marginTop: 8, fontSize: 13, color: sendResetMsg.startsWith('✓') ? '#2e7d32' : '#c0392b' }}>{sendResetMsg}</div>}
        {resetFor && (
          <div style={{ marginTop: 12, padding: 10, border: '1px solid #ddd', borderRadius: 6, background: '#fafafa' }}>
            <b>Reset password for {resetFor.observer_name}</b>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 8 }}>
              <input type="text" value={resetPw} onChange={e => setResetPw(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') resetPassword(); }} style={{ padding: '5px 8px', fontFamily: 'monospace', minWidth: 180 }} />
              <button className="edit-btn" type="button" onClick={() => setResetPw(genPassword())}>Generate</button>
              <button className="edit-btn" onClick={resetPassword} disabled={resetting}>{resetting ? 'Setting…' : 'Set password'}</button>
              <button className="edit-btn" onClick={() => { setResetFor(null); setResetPw(''); setResetMsg(''); }}>Close</button>
            </div>
            {resetMsg && <div style={{ marginTop: 6, fontSize: 13, fontFamily: resetMsg.startsWith('✓') ? 'monospace' : undefined, color: resetMsg.startsWith('✓') ? '#2e7d32' : '#c0392b' }}>{resetMsg}</div>}
          </div>
        )}
        <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <input type="text" placeholder="Name" value={newUser.observer_name} onChange={e => setNewUser({ ...newUser, observer_name: e.target.value })} style={{ padding: '5px 8px' }} />
          <input type="email" placeholder="Email (optional)" value={newUser.email} onChange={e => setNewUser({ ...newUser, email: e.target.value })} style={{ padding: '5px 8px' }} />
          <select value={newUser.role} onChange={e => setNewUser({ ...newUser, role: e.target.value })} style={{ padding: '5px 8px' }}>
            <option value="viewer">Viewer</option>
            <option value="editor">Editor</option>
            <option value="admin">Admin</option>
          </select>
          <input type="text" placeholder="Password (blank = email invite)" value={newUser.password} onChange={e => setNewUser({ ...newUser, password: e.target.value })} onKeyDown={e => { if (e.key === 'Enter') createUser(); }} style={{ padding: '5px 8px', fontFamily: 'monospace', minWidth: 200 }} />
          <button className="edit-btn" type="button" onClick={() => setNewUser({ ...newUser, password: genPassword() })}>Generate</button>
          <button className="edit-btn" onClick={createUser} disabled={addingUser}>{addingUser ? 'Adding…' : (!newUser.password && newUser.email.trim()) ? 'Add & send invite' : 'Add user'}</button>
          {addUserErr && <span style={{ color: '#c0392b', fontSize: 13 }}>{addUserErr}</span>}
          {addUserOk && <span style={{ color: addUserOk.startsWith('✓') ? '#2e7d32' : '#c0392b', fontSize: 13 }}>{addUserOk}</span>}
        </div>
        {newUser.role !== 'admin' && colonies.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Colony access — grant one or more:</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {colonies.map((c: any) => (
                <label key={c.colony_id} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid #ddd', borderRadius: 4, padding: '3px 8px', fontSize: 13 }}>
                  {c.colony_name}{c.region_name ? ` — ${c.region_name}` : ''}
                  <select value={newUserColonies[c.colony_id] || ''} onChange={e => setNewUserColonies({ ...newUserColonies, [c.colony_id]: e.target.value })} style={{ padding: '2px 4px' }}>
                    <option value="">No access</option>
                    <option value="view">View</option>
                    <option value="edit">Edit</option>
                  </select>
                </label>
              ))}
            </div>
          </div>
        )}
        <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>With a password, new users can log in immediately. Leave the password blank (email required) to send an invite from no-reply@wildwatch.co.nz — the user sets their own password via a 7-day link. Non-Admins see nothing until granted colony access — set it per colony above, or manage it later under Colony access.</p>
      </div>

      <div className="admin-section" style={{ display: adminTab === 'io' ? undefined : 'none' }}>
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

      <div className="admin-section" style={{ display: adminTab === 'io' ? undefined : 'none' }}>
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

      <div style={{ display: adminTab === 'users' ? undefined : 'none' }}>
        <RegionsAndColonies token={token} />
        <ColonyAccess token={token} />
      </div>

      <div className="admin-section" style={{ display: adminTab === 'io' ? undefined : 'none' }}>
        <RemovePenguin token={token} />
      </div>

      <div className="admin-section" style={{ display: adminTab === 'validation' ? undefined : 'none' }}>
        <h3>Data integrity</h3>
        <AdultCountMismatchReport onOpen={(box, time) => { window.location.href = `/?box=${encodeURIComponent(box)}&obs=${encodeURIComponent(time)}`; }} />
        <IntegrityCheck rows={iDupObs} errorType="duplicate_observations" title="Duplicate observations"
          desc="More than one observation for a box on the same day." empty="No duplicate observations"
          columns={[{ key: 'obs_date', label: 'Date', render: dayCell }, { key: 'box_name', label: 'Box', render: boxCell }, { key: 'cnt', label: 'Count' }, { key: 'monitors', label: 'Monitors' }]} />
        <IntegrityCheck rows={iDupScans} errorType="duplicate_scans" title="Duplicate scans"
          desc="The same bird scanned more than once in one observation — kept as evidence of a data-entry error." empty="No duplicate scans"
          columns={[{ key: 'obs_date', label: 'Date', render: dayCell }, { key: 'box_name', label: 'Box', render: boxCell }, { key: 'peng_num', label: 'Penguin', render: pengCell }, { key: 'cnt', label: 'Count' }, { key: 'dup_type', label: 'Type' }]} />
        <IntegrityCheck rows={iSameGender} errorType="same_gender_conflicts" title="Same-gender conflicts"
          desc="Two+ penguins of the same sex scanned at one box on one day — a sex-assignment error or a genuine multi-bird visit." empty="No same-gender conflicts"
          columns={[{ key: 'obs_date', label: 'Date', render: dayCell }, { key: 'box_name', label: 'Box', render: boxCell }, { key: 'sex', label: 'Sex', render: (v: string) => v === 'M' ? 'Male' : v === 'F' ? 'Female' : v }, { key: 'cnt', label: 'Count' }, { key: 'peng_nums', label: 'Penguins', render: (v: string) => (v || '').split(',').map((n: string, i: number) => <Fragment key={i}>{i > 0 ? ' ' : ''}{pengCell(n.trim())}</Fragment>) }]} />
        <IntegrityCheck rows={iBirdTwoBoxes} errorType="bird_two_boxes" title="Bird in two boxes same day"
          desc="A penguin scanned at two different boxes on one day — can't be two places at once." empty="No birds in two boxes"
          columns={[{ key: 'obs_date', label: 'Date', render: dayCell }, { key: 'peng_num', label: 'Penguin', render: pengCell }, { key: 'boxes', label: 'Boxes', render: boxesCell }, { key: 'box_count', label: '#' }]} />
        <IntegrityCheck rows={iScanBeforeChip} errorType="scan_before_chip" title="Scan before chip date"
          desc="A scan dated before the bird's chip was fitted — impossible." empty="No pre-chip scans"
          columns={[{ key: 'obs_date', label: 'Scan date', render: dayCell }, { key: 'chip_date', label: 'Chip date' }, { key: 'box_name', label: 'Box', render: boxCell }, { key: 'peng_num', label: 'Penguin', render: pengCell }]} />
        <IntegrityCheck rows={iDeadScanned} errorType="dead_scanned" title="Dead birds still scanned"
          desc="Birds scanned after their recorded death date — the death date or the scan is wrong." empty="No dead birds scanned after death"
          columns={[{ key: 'death_date', label: 'Died' }, { key: 'last_scan', label: 'Last scan', render: dayCell }, { key: 'peng_num', label: 'Penguin', render: pengCell }, { key: 'scan_count', label: 'Scans' }]} />
        <IntegrityCheck rows={iImprobable} errorType="improbable_counts" title="Improbable counts"
          desc="Adults > 2, or eggs + chicks > 2 — unusual for a little-penguin box." empty="No improbable counts"
          columns={[{ key: 'obs_date', label: 'Date', render: dayCell }, { key: 'box_name', label: 'Box', render: boxCell },
            { key: 'adults', label: 'Adults', render: (v: any) => Number(v) > 2 ? redNum(v) : v },
            { key: 'eggs', label: 'Eggs', render: (v: any, r: any) => (Number(r.eggs) + Number(r.chicks) > 3 && Number(v) > 0) ? redNum(v) : v },
            { key: 'chicks', label: 'Chicks', render: (v: any, r: any) => (Number(r.eggs) + Number(r.chicks) > 3 && Number(v) > 0) ? redNum(v) : v }]} />
        <IntegrityCheck rows={iFuture} errorType="future_observations" title="Future-dated observations"
          desc="Observations dated after today (NZ) — almost always a typo." empty="No future-dated observations"
          columns={[{ key: 'obs_date', label: 'Date', render: dayCell }, { key: 'box_name', label: 'Box', render: boxCell }, { key: 'monitor', label: 'Monitor' }]} />
        <IntegrityCheck rows={iRetired} errorType="retired_tag_scans" title="Retired-tag scans"
          desc="Scanned via an old (inactive) chip after the bird was rechipped." empty="No retired-tag scans"
          columns={[{ key: 'obs_date', label: 'Date', render: dayCell }, { key: 'box_name', label: 'Box', render: boxCell }, { key: 'peng_num', label: 'Penguin', render: pengCell }, { key: 'pit_id', label: 'Tag', render: (v: string) => String(v || '').slice(-8) }, { key: 'active_chip_date', label: 'Rechipped' }]} />
        <IntegrityCheck rows={iChicksNoScan} errorType="chicks_no_scan" title="Chicks present but not scanned"
          desc="Chicks chipped in a box, then chicks recorded there within a month but no scans on that visit — a likely missed scan." empty="No unscanned-chick visits"
          columns={[{ key: 'obs_date', label: 'Date', render: dayCell }, { key: 'box_name', label: 'Box', render: boxCell }, { key: 'chicks', label: 'Chicks' }, { key: 'chicks_chipped', label: 'Chipped ≤1mo before' }]} />

        <h3 style={{ marginTop: 28 }}>Flipper-length import (6 Jul 2026)</h3>
        <p className="muted" style={{ margin: '0 0 8px', fontSize: 12 }}>
          Flipper lengths from the chip spreadsheet were added to each bird's chip-day biometric (999 imported;
          680 chip-day biometrics created where none existed). These two lists record the birds that need a human eye.
        </p>
        <IntegrityCheck rows={FLIPPER_IMPORT_MISSING} title="Missing flipper length"
          desc="Birds in the chip spreadsheet with no flipper measurement recorded — there was nothing to import." empty="None"
          columns={[{ key: 'peng_num', label: 'Penguin', render: pengCell }, { key: 'chip_date', label: 'Chip date' }, { key: 'chip_weight', label: 'Chip weight (g)' }]} />
        <IntegrityCheck rows={FLIPPER_IMPORT_WEIGHT_DIFFS} title="Chip-weight discrepancies"
          desc="The spreadsheet's chip weight disagreed with the weight already stored on the chip-day biometric. The existing database weight was kept and the flipper length was still added — worth reconciling by hand." empty="None"
          columns={[{ key: 'peng_num', label: 'Penguin', render: pengCell }, { key: 'chip_date', label: 'Chip date' }, { key: 'sheet_weight', label: 'Sheet (g)' }, { key: 'db_weight', label: 'Kept in DB (g)' }, { key: 'flipper', label: 'Flipper added (mm)' }]} />
      </div>

      <div style={{ display: adminTab === 'system' ? undefined : 'none' }}>
        <BackupsPanel token={token} />
        <DayMoveMigrationPanel token={token} fromDate="2024-05-08" toDate="2024-04-08" />
        <DayMoveMigrationPanel token={token} fromDate="2023-10-10" toDate="2023-10-09" />
        <Suspense fallback={<div className="admin-section"><p className="muted">Loading chart...</p></div>}>
          <DiskHistoryChart token={token} />
        </Suspense>
      </div>

      <div className="admin-section" style={{ display: adminTab === 'system' ? undefined : 'none' }}>
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
    {adminBird && adminBirdData?.penguin && (
      <div className="day-bird-dock entry-bird-dock">
        <BirdPage data={adminBirdData} onBirdClick={(num: string) => setAdminBird(num)}
          onBoxClick={(box: string) => window.open(`/box/${box}`, '_blank')}
          onSightingClick={(box: string, date: string) => window.open(`/?box=${encodeURIComponent(box)}&obs=${encodeURIComponent(date)}`, '_blank')}
          onDayClick={(d: string) => window.open(`/?day=${encodeURIComponent(d)}`, '_blank')}
          onClose={() => setAdminBird(null)}
          token={token} canEdit={localStorage.getItem('ww_role') !== 'viewer'} />
      </div>
    )}
    </>
  );
}

/** Admin → System: one-time migration moving everything recorded on one NZ day to
 *  another, all timestamps set to 2pm NZ (02:00 UTC NZST, the death_date convention).
 *  Runs entirely through the audited CRUD API with the logged-in session, so every
 *  change lands in audit_log under this user with a change_reason. Remove each panel
 *  once its migration has been applied. */
function DayMoveMigrationPanel({ token, fromDate, toDate }: { token: string; fromDate: string; toDate: string }) {
  const FROM_DATE = fromDate, TO_DATE = toDate;
  const TO_DATETIME_UTC = `${toDate} 02:00:00`;
  const nice = (d: string) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const REASON = `One-time migration: data recorded on ${nice(FROM_DATE)} moved to ${nice(TO_DATE)}`;
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);

  const api = async (path: string, body?: any) => {
    const r = await fetch(`/api/crud.php?${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok || data.error) throw new Error(`${path}: ${data.error || r.status}`);
    return data;
  };

  const run = async (apply: boolean) => {
    if (apply && !confirm(`Move all data on ${nice(FROM_DATE)} to ${nice(TO_DATE)} (2pm NZ)? This writes to the database.`)) return;
    setRunning(true);
    const lines: string[] = [];
    const add = (s: string) => { lines.push(s); setLog([...lines]); };
    try {
      add(apply ? 'APPLYING — writing changes…' : 'Dry run — nothing written.');

      const observations = await api(`action=list&table=observations&nz_date=${FROM_DATE}`);
      if (observations.length >= 5000) throw new Error('Result truncated at 5000 rows — aborting');

      const existingOnTarget = await api(`action=list&table=observations&nz_date=${TO_DATE}`);
      if (existingOnTarget.length > 0) {
        add(`NOTE: ${TO_DATE} already has ${existingOnTarget.length} observation(s); moved rows will join them.`);
        const clash = new Set(existingOnTarget.map((o: any) => o.location_id));
        const dup = observations.filter((o: any) => clash.has(o.location_id));
        if (dup.length) add(`WARNING: ${dup.length} moved observation(s) share a box with an existing ${TO_DATE} observation: ids ${dup.map((o: any) => o.observation_id).join(', ')}`);
      }

      add(`Observations on ${FROM_DATE}: ${observations.length}`);
      let scanCount = 0;
      for (const obs of observations) {
        if (toNzDateStr(obs.observation_time_utc) !== FROM_DATE)
          throw new Error(`Observation ${obs.observation_id} not on ${FROM_DATE}: ${obs.observation_time_utc}`);
        const flags = obs.is_deleted && Number(obs.is_deleted) ? ' [soft-deleted]' : '';
        add(`  obs ${obs.observation_id} (loc ${obs.location_id})${flags}: ${obs.observation_time_utc} -> ${TO_DATETIME_UTC}`);
        if (apply) await api(`action=update&table=observations&id=${obs.observation_id}`, { observation_time_utc: TO_DATETIME_UTC, _reason: REASON });

        const scans = await api(`action=list&table=penguin_scans&observation_id=${obs.observation_id}`);
        for (const scan of scans) {
          add(`    scan ${scan.scan_id}: ${scan.scan_time_utc} -> ${TO_DATETIME_UTC}`);
          if (apply) await api(`action=update&table=penguin_scans&id=${scan.scan_id}`, { scan_time_utc: TO_DATETIME_UTC, _reason: REASON });
          scanCount++;
        }
      }

      // Only biometric rows belonging to a moved observation follow it; anything else
      // dated 8 May (no observation link, or linked elsewhere) is flagged, not moved.
      const movedObsIds = new Set(observations.map((o: any) => o.observation_id));
      const biometrics = await api(`action=list&table=penguin_biometric_data&observation_date=${FROM_DATE}`);
      const [linked, orphaned] = [
        biometrics.filter((b: any) => movedObsIds.has(b.observation_id)),
        biometrics.filter((b: any) => !movedObsIds.has(b.observation_id)),
      ];
      add(`Biometric rows dated ${FROM_DATE}: ${biometrics.length} (${linked.length} linked to moved observations)`);
      for (const bio of linked) {
        add(`  biometric ${bio.biometric_id} (obs ${bio.observation_id}): ${FROM_DATE} -> ${TO_DATE}`);
        if (apply) await api(`action=update&table=penguin_biometric_data&id=${bio.biometric_id}`, { observation_date: TO_DATE, _reason: REASON });
      }
      for (const bio of orphaned) {
        add(`  SKIPPED biometric ${bio.biometric_id} (obs ${bio.observation_id ?? 'none'}): not linked to a moved observation`);
      }

      const fmDates = await api('action=all_fm_dates');
      const hit = fmDates.find((d: any) => String(d.actual_date).slice(0, 10) === FROM_DATE);
      if (hit) {
        add(`FM date mapping: season ${hit.season_year} day ${hit.date_number} is ${FROM_DATE} -> ${TO_DATE}`);
        if (apply) {
          const season = await api(`action=season_fm_dates&season=${hit.season_year}`);
          const rows = season.map((r: any) => ({
            n: r.date_number,
            date: String(r.actual_date).slice(0, 10) === FROM_DATE ? TO_DATE : String(r.actual_date).slice(0, 10),
          })).sort((a: any, b: any) => a.date.localeCompare(b.date)).map((r: any, i: number) => ({ n: i + 1, date: r.date }));
          await api(`action=season_fm_dates&season=${hit.season_year}`, rows);
        }
      } else {
        add(`No FM date mapping registered for ${FROM_DATE}.`);
      }

      add(`${apply ? 'Done' : 'Dry run complete'}: ${observations.length} observations, ${scanCount} scans, ${linked.length} biometric rows${orphaned.length ? ` (${orphaned.length} skipped)` : ''}${hit ? ', 1 FM date mapping' : ''}.`);
    } catch (e: any) {
      add(`FAILED: ${e.message}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="admin-section">
      <h3>One-time migration: {nice(FROM_DATE)} → {nice(TO_DATE)}</h3>
      <p className="muted">Moves all observations, scans and biometrics recorded on {nice(FROM_DATE)} to {nice(TO_DATE)}, timestamps set to 2pm NZ. Audited under your login. Dry run first.</p>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="edit-btn" disabled={running} onClick={() => run(false)}>Dry run</button>
        <button className="edit-btn" disabled={running} style={{ background: '#c62828', color: '#fff' }} onClick={() => run(true)}>Apply</button>
      </div>
      {log.length > 0 && (
        <pre style={{ marginTop: 8, maxHeight: 300, overflow: 'auto', background: '#f7f9fa', border: '1px solid #e8ecef', borderRadius: 4, padding: 8, fontSize: 12 }}>
          {log.join('\n')}
        </pre>
      )}
    </div>
  );
}

/** Admin → System: backup inventory. Local = the dated dumps the nightly job stages on
 *  this server (kept 14 days) — listed live. Remote = devian, verified LIVE on every
 *  load via a restricted ssh listing; the status.json snapshot from the last run is
 *  only the fallback when the live check fails. */
function BackupsPanel({ token }: { token: string }) {
  const [data, setData] = useState<any | null>(null);
  const [err, setErr] = useState('');
  const load = () => {
    setErr('');
    fetch('/api/admin.php?action=backups', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(d => d.error ? setErr(d.error) : setData(d))
      .catch(e => setErr(String(e.message || e)));
  };
  useEffect(load, [token]);
  const fmtBytes = (b: number) => b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`;
  const s = data?.status;
  const remote = data?.remote; // live ssh listing of devian, run server-side on every load
  // Newest local dump per database (names are <db>_<YYYYMMDD>.sql.gz, list arrives newest-first)
  const newestLocal = new Map<string, any>();
  for (const f of (data?.local || [])) {
    const m = f.name.match(/^(.+)_(\d{8})\.sql\.gz$/);
    if (m && !newestLocal.has(m[1])) newestLocal.set(m[1], { ...f, day: `${m[2].slice(0,4)}-${m[2].slice(4,6)}-${m[2].slice(6)}` });
  }
  // Newest verified remote daily/monthly per database, from the live listing
  const remoteLatest = new Map<string, { daily?: any; monthly?: any }>();
  if (remote?.ok) for (const f of remote.files) {
    const m = f.name.match(/^(.+)_\d{6,8}\.sql\.gz$/);
    if (!m) continue;
    const e: any = remoteLatest.get(m[1]) || {};
    const k = f.kind as 'daily' | 'monthly';
    if (!e[k] || f.name > e[k].name) e[k] = f;
    remoteLatest.set(m[1], e);
  }
  const stateLabel = s?.state === 'success' ? <span style={{color:'#2e7d32', fontWeight:600}}>✓ OK</span>
    : s?.state === 'failed' ? <span style={{color:'#c0392b', fontWeight:600}}>✗ FAILED: {s.error}</span>
    : s?.state === 'running' ? <span style={{color:'#a15c00', fontWeight:600}}>⏳ running — {s.phase}</span>
    : <span className="muted">unknown</span>;
  const remoteCell = (live: any, snapshot: string | undefined) =>
    live ? <>{live.name} <span className="muted">({fmtBytes(live.bytes)})</span></>
    : snapshot ? <>{snapshot} <span style={{color:'#a15c00'}}>(unverified — from last run)</span></>
    : <span className="muted">—</span>;
  return (
    <div className="admin-section">
      <h3>Backups <button className="edit-btn" style={{marginLeft:8}} onClick={load}>Refresh</button></h3>
      {err && <p style={{color:'#c0392b'}}>{err}</p>}
      {!data && !err && <p className="muted">Loading...</p>}
      {data && (
        <>
          <p style={{marginBottom:4}}>Nightly offsite job: {stateLabel}
            {s?.last_success_at && <span className="muted"> · last success {formatDate(s.last_success_at)}</span>}
          </p>
          <p style={{marginBottom:8}}>Offsite (devian): {remote?.ok
            ? <span style={{color:'#2e7d32', fontWeight:600}}>✓ verified just now — {remote.files.length} file{remote.files.length !== 1 ? 's' : ''} present</span>
            : <span style={{color:'#c0392b', fontWeight:600}}>✗ live check failed ({remote?.error || 'no response'}) — showing last-run snapshot</span>}
          </p>
          <table className="bird-table" style={{marginBottom:6}}>
            <thead><tr><th>Database</th><th>Local (this server, 14 days)</th><th>Remote daily (devian)</th><th>Remote monthly (devian)</th></tr></thead>
            <tbody>
              {Array.from(new Set([...newestLocal.keys(), ...remoteLatest.keys(), ...Object.keys(s?.offsite_latest || {})])).sort().map(db => {
                const l = newestLocal.get(db);
                const r = remoteLatest.get(db);
                const snap = s?.offsite_latest?.[db];
                return (
                  <tr key={db}>
                    <td>{db}</td>
                    <td>{l ? <>{l.day} <span className="muted">({fmtBytes(l.bytes)})</span></> : <span className="muted">—</span>}</td>
                    <td>{remoteCell(r?.daily, snap?.daily)}</td>
                    <td>{remoteCell(r?.monthly, snap?.monthly)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="muted" style={{fontSize:12}}>
            {data.local.length} staged dump{data.local.length !== 1 ? 's' : ''} on this server
            {remote?.ok
              ? <> · devian holds {remote.files.filter((f: any) => f.kind === 'daily').length} dailies + {remote.files.filter((f: any) => f.kind === 'monthly').length} monthlies (verified live)</>
              : s?.offsite && <> · devian held {s.offsite.daily_count} dailies + {s.offsite.monthly_count} monthlies at last run</>}
            {s?.offsite?.media && <> · media mirror {s.offsite.media}</>}
          </p>
        </>
      )}
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
  useEffect(() => { load(); }, []); // auto-load

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

// Base-26 helpers for alpha box ranges (AA, AB, AC...). A=1.
function alphaToNum(s: string): number { let n = 0; for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n; }
function numToAlpha(n: number, len: number): string { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s.padStart(len, 'A'); }

/** Expand a colony's box-sets string into box names. Handles {} wrappers, comma-separated
 *  tokens, and A-B ranges that are numeric (1-150), prefixed (N1-N6), or alpha (AA-AC). */
function expandLocationSets(str: string): string[] {
  const out: string[] = [];
  for (let token of (str || '').replace(/[{}]/g, ' ').split(',')) {
    token = token.trim();
    if (!token) continue;
    const dash = token.indexOf('-');
    if (dash > 0 && dash < token.length - 1) {
      const a = token.slice(0, dash).trim(), b = token.slice(dash + 1).trim();
      const ma = a.match(/^(.*?)(\d+)$/), mb = b.match(/^(.*?)(\d+)$/);
      if (ma && mb && ma[1] === mb[1]) { // prefixed/numeric: N1-N6, 1-150
        const start = parseInt(ma[2], 10), end = parseInt(mb[2], 10);
        if (start <= end && end - start < 1000) { for (let i = start; i <= end; i++) out.push(ma[1] + i); continue; }
      } else if (a.length === b.length && /^[A-Za-z]+$/.test(a) && /^[A-Za-z]+$/.test(b)) { // alpha: AA-AC
        const an = alphaToNum(a), bn = alphaToNum(b);
        if (an <= bn && bn - an < 1000) { for (let i = an; i <= bn; i++) out.push(numToAlpha(i, a.length)); continue; }
      }
    }
    out.push(token);
  }
  return [...new Set(out)];
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
  useEffect(() => { load(); }, []); // auto-load

  const saveRegion = async (data: any) => {
    await fetch('/api/admin.php?action=save_region', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    setEditRegion(null);
    load();
  };

  const saveColony = async (data: any) => {
    const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const res = await fetch('/api/admin.php?action=save_colony', { method: 'POST', headers: auth, body: JSON.stringify(data) });
    const saved = await res.json().catch(() => ({}));
    const colonyId = data.colony_id || saved.colony_id;
    // Offer to materialise the box-sets string into boxes — but only the ones that don't exist yet.
    const boxes = expandLocationSets(data.location_sets_string || '');
    if (colonyId && boxes.length > 0) {
      const existing = await fetch(`/api/admin.php?action=colony_box_names&colony_id=${colonyId}`, { headers: auth }).then(r => r.json()).catch(() => []);
      const have = new Set((Array.isArray(existing) ? existing : []).map(String));
      const missing = boxes.filter(b => !have.has(String(b)));
      if (missing.length > 0) {
        const preview = missing.slice(0, 20).join(', ') + (missing.length > 20 ? ` … (+${missing.length - 20} more)` : '');
        if (confirm(`Create ${missing.length} new box${missing.length === 1 ? '' : 'es'} for these sets?\n\n${preview}`)) {
          const cr = await fetch('/api/admin.php?action=create_colony_boxes', { method: 'POST', headers: auth, body: JSON.stringify({ colony_id: colonyId, box_names: missing }) });
          const cd = await cr.json().catch(() => ({}));
          if (cd.success) alert(`Created ${cd.created} box${cd.created === 1 ? '' : 'es'}.`);
          else alert('Failed to create boxes: ' + (cd.error || 'unknown error'));
        }
      }
    }
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
          <thead><tr style={{borderBottom:'1px solid #ddd'}}><th style={{textAlign:'left'}}>Colony</th><th style={{textAlign:'left'}}>Region</th><th style={{textAlign:'left'}}>Box sets</th><th style={{textAlign:'left'}}>FM-excluded</th><th></th></tr></thead>
          <tbody>
            {colonies!.map((c: any) => (
              <tr key={c.colony_id} style={{borderBottom:'1px solid #eee'}}>
                <td style={{padding:'4px 8px'}}>{c.colony_name}</td>
                <td style={{padding:'4px 8px'}} className="muted">{c.region_name}</td>
                <td style={{padding:'4px 8px', fontFamily:'monospace', fontSize:11}}>{c.location_sets_string}</td>
                <td style={{padding:'4px 8px', fontFamily:'monospace', fontSize:11}}>{c.fm_excluded_boxes}</td>
                <td><button className="edit-btn" onClick={() => setEditColony({colony_id: c.colony_id, colony_name: c.colony_name, region_id: c.region_id, location_sets_string: c.location_sets_string || '', fm_excluded_boxes: c.fm_excluded_boxes ?? ''})}>Edit</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button className="edit-btn" onClick={() => setEditColony({colony_name: '', region_id: regions[0]?.region_id || 0, location_sets_string: '', fm_excluded_boxes: '0,AA,AB,AC'})}>+ Add colony</button>

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
            <label style={{fontSize:11, color:'#888', display:'block', marginBottom:2}}>Excluded from Full Monitor (comma-separated)</label>
            <input type="text" defaultValue={editColony.fm_excluded_boxes} placeholder="e.g. 0,AA,AB,AC"
              style={{padding:'4px 8px', fontSize:13, border:'1px solid #ccc', borderRadius:4, width:'100%', marginBottom:6, fontFamily:'monospace'}}
              onChange={e => editColony.fm_excluded_boxes = e.target.value} />
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
    <div>
      <h3>Remove Penguin</h3>
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
              <tr><td style={{padding:'2px 8px', color:'#666'}}>Status</td><td style={{padding:'2px 8px'}}>{preview.penguin.death_date ? `Dead (${preview.penguin.death_date.slice(0, 10)})` : 'Alive'}</td></tr>
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

// Presentational integrity check: renders rows (computed locally) — 5 by default + "show all".
function IntegrityCheck({ title, desc, rows, empty, columns, errorType }: {
  title: string; desc?: string; rows: any[]; empty?: string;
  columns: { key: string; label: string; render?: (v: any, row: any) => React.ReactNode }[];
  errorType?: string;   // when set, rows can be marked "valid" (reviewed & dismissed)
}) {
  const [showAll, setShowAll] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const { active, dismissed } = errorType ? splitDismissed(errorType, rows) : { active: rows, dismissed: [] as any[] };
  const shown = showAll ? active : active.slice(0, 5);

  const doDismiss = async (row: any) => {
    if (!errorType) return;
    const reason = window.prompt(`Mark this "${title}" item as reviewed & valid?\n\nOptional note (why it's fine):`, '');
    if (reason === null) return; // cancelled
    setBusy(true);
    try { await dismissError(errorType, row, reason.trim()); }
    catch (e: any) { alert(e?.message || 'Could not dismiss'); }
    finally { setBusy(false); }
  };
  const doRestore = async (row: any) => {
    if (!errorType) return;
    setBusy(true);
    try { await undismissError(errorType, row); }
    catch (e: any) { alert(e?.message || 'Could not restore'); }
    finally { setBusy(false); }
  };
  const cellNav = (row: any) => row._href ? () => { window.location.href = row._href; } : undefined;

  return (
    <div style={{ marginTop: 16, padding: 12, border: '1px solid #e8ecef', borderRadius: 8 }}>
      <h3 style={{ margin: '0 0 4px' }}>{title}</h3>
      {desc && <p className="muted" style={{ margin: '0 0 8px', fontSize: 12 }}>{desc}</p>}
      {active.length === 0 ? <span style={{ color: '#4CAF50' }}>{empty || 'None found'}</span> : (<>
        <p style={{ color: '#F44336', fontWeight: 600, margin: '4px 0' }}>{active.length} found{active.length > 5 && !showAll ? ' (showing 5)' : ''}:</p>
        <table style={{ fontSize: 12, borderCollapse: 'collapse', width: '100%' }}>
          <thead><tr style={{ borderBottom: '1px solid #ddd' }}>{columns.map(c => <th key={c.key} style={{ textAlign: 'left', padding: '2px 6px' }}>{c.label}</th>)}{errorType && <th></th>}</tr></thead>
          <tbody>{shown.map((row: any, i: number) => (
            <tr key={i} style={{ borderBottom: '1px solid #eee' }}>
              {columns.map(c => <td key={c.key} style={{ padding: '2px 6px', cursor: row._href ? 'pointer' : 'default' }}
                onClick={cellNav(row)} title={row._href ? 'Go to the observation' : undefined}>{c.render ? c.render(row[c.key], row) : row[c.key]}</td>)}
              {errorType && <td style={{ padding: '2px 6px', whiteSpace: 'nowrap' }}>
                <button className="edit-btn" disabled={busy} onClick={() => doDismiss(row)} title="Reviewed — mark valid and hide from this list">✓ Valid</button>
              </td>}
            </tr>
          ))}</tbody>
        </table>
        {active.length > 5 && <button className="edit-btn" style={{ marginTop: 6 }} onClick={() => setShowAll(s => !s)}>{showAll ? 'Show fewer' : `Show all (${active.length})`}</button>}
      </>)}
      {errorType && dismissed.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <button className="edit-btn" onClick={() => setShowDismissed(s => !s)}>{showDismissed ? 'Hide' : 'Show'} {dismissed.length} dismissed</button>
          {showDismissed && (
            <table style={{ fontSize: 12, borderCollapse: 'collapse', width: '100%', marginTop: 6, opacity: 0.65 }}>
              <thead><tr style={{ borderBottom: '1px solid #ddd' }}>{columns.map(c => <th key={c.key} style={{ textAlign: 'left', padding: '2px 6px' }}>{c.label}</th>)}<th style={{ textAlign: 'left', padding: '2px 6px' }}>Reviewed by</th><th></th></tr></thead>
              <tbody>{dismissed.map((row: any, i: number) => (
                <tr key={i} style={{ borderBottom: '1px solid #eee' }}>
                  {columns.map(c => <td key={c.key} style={{ padding: '2px 6px', cursor: row._href ? 'pointer' : 'default' }}
                    onClick={cellNav(row)}>{c.render ? c.render(row[c.key], row) : row[c.key]}</td>)}
                  <td style={{ padding: '2px 6px', fontSize: 11, color: '#666' }} title={row._dismissal?.dismissed_at || ''}>
                    {row._dismissal?.dismissed_by_name || '—'}{row._dismissal?.reason ? `: ${row._dismissal.reason}` : ''}
                  </td>
                  <td style={{ padding: '2px 6px', whiteSpace: 'nowrap' }}>
                    <button className="edit-btn" disabled={busy} onClick={() => doRestore(row)} title="Move back to the error list">Restore</button>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

// Cell renderers for integrity tables — clickable box/day/penguin links. stopPropagation so a
// styled plain text (not links) so a click anywhere in the row triggers the row's navigation
// (its _href → the exact observation/date, highlighted) rather than a naked /day or /box.
const dayCell = (d: string) => d ? <span className="clickable">{d}</span> : '';
const boxCell = (b: string) => b ? <span className="clickable">Box {b}</span> : '';
// The mounted AdminPanel registers its bird-dock opener here so #peng cells in the integrity
// tables open the panel on the right (stopPropagation so the row's own nav doesn't also fire).
let _adminOpenBird: ((n: string) => void) | null = null;
const pengCell = (n: string) => n
  ? <span className="clickable" onClick={e => { if (_adminOpenBird && n) { e.stopPropagation(); _adminOpenBird(String(n)); } }}>#{n}</span>
  : '';
const redNum = (v: any) => <span style={{ color: '#F44336', fontWeight: 600 }}>{v}</span>;
const boxesCell = (csv: string) => (csv || '').split(',').map((b: string, i: number) => (
  <Fragment key={i}>{i > 0 ? ', ' : ''}<span className="clickable">{b.trim()}</span></Fragment>
));

// One-off record of exceptions from the 6 Jul 2026 flipper-length import (chip spreadsheet).
// The source sheet isn't in the app and the weight comparison can't be recomputed live, so the
// birds needing manual attention are recorded here rather than derived from the cache.
const FLIPPER_IMPORT_MISSING = [
  { peng_num: 'PT372', chip_date: '2022-10-13', chip_weight: 1190 },
  { peng_num: 'PT937', chip_date: '2025-10-28', chip_weight: 970 },
];
const FLIPPER_IMPORT_WEIGHT_DIFFS = [
  { peng_num: 'PT215', chip_date: '2021-09-21', sheet_weight: 890, db_weight: 910, flipper: 115 },
  { peng_num: 'PT214', chip_date: '2021-09-21', sheet_weight: 910, db_weight: 890, flipper: 112 },
  { peng_num: 'PT518', chip_date: '2023-06-27', sheet_weight: 940, db_weight: 960, flipper: 120 },
  { peng_num: 'PT328', chip_date: '2022-04-11', sheet_weight: 1100, db_weight: 1110, flipper: 123 },
  { peng_num: 'PT339', chip_date: '2022-05-03', sheet_weight: 1100, db_weight: 1350, flipper: 120 },
  { peng_num: 'PT338', chip_date: '2022-05-03', sheet_weight: 1010, db_weight: 1180, flipper: 111 },
  { peng_num: 'PT344', chip_date: '2022-06-15', sheet_weight: 960, db_weight: 860, flipper: 113 },
  { peng_num: 'PT247', chip_date: '2021-10-19', sheet_weight: 800, db_weight: 880, flipper: 110 },
  { peng_num: 'PT646', chip_date: '2023-11-15', sheet_weight: 980, db_weight: 920, flipper: 109 },
];

function AuthenticatedApp({ token, userName, userRole, onLogout }: { token: string; userName: string; userRole: string; onLogout: () => void }) {
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [addPenguinBox, setAddPenguinBox] = useState<string | null>(null);
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
  // A bird opened without a box (deep link ?bird=, search, admin) adopts its most-recently-
  // seen box so it renders in the box+bird split (panel docked on the right) instead of a
  // wide, centred, lone page. Cleared once the box is adopted; wide screens only.
  const [dockBirdToBox, setDockBirdToBox] = useState<boolean>(!!(initial.bird && !initial.box));
  // birdData from useBirdDetail hook
  const [highlightObs, setHighlightObs] = useState<string|null>(null);
  const [scrollToObs, setScrollToObs] = useState<string|null>(null);
  // Click-only deep-link anchor for a single observation. Unlike highlight/scroll (which
  // are hover-driven and transient) this persists into the URL as ?obs=, scoped to its box.
  const [obsAnchor, setObsAnchor] = useState<{box:string;time:string}|null>(initial.box && initial.obs ? { box: initial.box, time: initial.obs } : null);
  const [dayBox, setDayBox] = useState<string|null>(initial.day && initial.box ? initial.box : null); // box to centre+highlight in day view
  const allPenguins = useAllPenguins();
  const [penguinSearch, setPenguinSearch] = useState('');
  const [colonies, setColonies] = useState<any[]>([]);
  const [colonyId, setColonyIdState] = useState<number>(getColonyId());
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

  // Sync state to URL. Admin/reports/enter/day are standalone full-screen modes, so
  // they own the URL exclusively. box + bird compose — both are serialized together so
  // an open bird panel is preserved across box changes, refresh, and back/forward.
  useEffect(() => {
    let path = '/';
    if (showAdmin) { const t = new URLSearchParams(window.location.search).get('tab'); path = '/?admin=1' + (t ? `&tab=${t}` : ''); }
    else if (showReports) { const t = new URLSearchParams(window.location.search).get('tab'); path = '/?reports=1' + (t ? `&tab=${t}` : ''); }
    else if (showEntry) path = '/?enter=1';
    else if (selectedDay) path = `/?day=${encodeURIComponent(selectedDay)}${dayBox ? `&box=${encodeURIComponent(dayBox)}` : ''}`;
    else {
      const q = new URLSearchParams();
      if (selectedBox) q.set('box', selectedBox);
      if (selectedBird) q.set('bird', selectedBird);
      // Only carry the obs anchor while its own box is showing — never leak it onto another box.
      if (selectedBox && obsAnchor && obsAnchor.box === selectedBox) q.set('obs', obsAnchor.time);
      const s = q.toString();
      path = s ? `/?${s}` : '/';
    }
    if (window.location.pathname + window.location.search !== path) {
      window.history.pushState(null, '', path);
    }
  }, [selectedBox, selectedBird, showEntry, showAdmin, showReports, selectedDay, obsAnchor, dayBox]);

  // Handle browser back/forward
  useEffect(() => {
    const onPopState = () => {
      const { box, bird, obs, enter, admin: adm, reports, day } = parseUrl();
      // Back/forward lands on a fresh view — drop cross-view scroll targets. The obs anchor
      // is restored below; the box-load effect re-scrolls to it once the box data is ready.
      setHighlightObs(null); setScrollToObs(null); setDayBox(day && box ? box : null);
      setObsAnchor(box && obs ? { box, time: obs } : null);
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

  // FM dates registered in the enter-date workflow (all seasons), keyed by NZ date.
  const [registeredFmDates, setRegisteredFmDates] = useState<Map<string, { season: number; number: number; partial: boolean }>>(new Map());
  useEffect(() => {
    if (!token) return;
    fetch('/api/crud.php?action=all_fm_dates', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(rows => {
        const m = new Map<string, { season: number; number: number; partial: boolean }>();
        if (Array.isArray(rows)) for (const r of rows) if (r.actual_date) m.set(r.actual_date, { season: Number(r.season_year), number: Number(r.date_number), partial: !!Number(r.partial_monitor) });
        setRegisteredFmDates(m);
      })
      .catch(() => {});
  }, [token]);

  const dateTip = useDateTooltip();
  const dateTipCtx = useMemo(() => ({ ...dateTip, statsCache: dateStatsCache, registeredFmDates }), [dateTip, dateStatsCache, registeredFmDates]);
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
      const [tags, ov, cols] = await Promise.all([fetchBoxTags(), fetchOverview(), fetchColonies()]);
      setBoxTags(tags); setStats(ov);
      if (Array.isArray(cols) && cols.length > 0) setColonies(cols);
    } catch (e) {
      console.warn('overview/tags fetch failed', e);
    } finally {
      setLoading(false);
      lastLoadRef.current = Date.now();
    }
  }, []);

  // Switch the active colony: persist it (every colony-scoped fetch reads it), reset the
  // view to the new colony's overview, and reload — syncDatabase resets + re-syncs the cache.
  const switchColony = useCallback(async (id: number) => {
    if (id === getColonyId()) return;
    // Each colony has its own cache, keyed by "<region>-<colony>" so they never overlap.
    const c = colonies.find((x: any) => Number(x.colony_id) === id);
    setActiveColony(id, `${c?.region_id ?? 1}-${id}`);
    setColonyIdState(id);
    setSelectedBox(null); setSelectedBird(null); setSelectedDay(null);
    setShowAdmin(false); setShowReports(false); setShowEntry(false);
    window.history.pushState({}, '', '/');
    setLoading(true); setLoadProgress('Loading colony…'); setLoadPct(null);
    await loadColony();
  }, [loadColony, colonies]);

  useEffect(() => {
    loadColony(); // also fetches colonies via fetchColonies()
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

  // Leaving box view drops the transient highlight. Box + bird otherwise coexist — the
  // peng panel rides along across box changes (grid/map, arrows); only the box search
  // inputs reset it explicitly at their call sites.
  useEffect(() => {
    if (!selectedBox) setHighlightObs(null);
  }, [selectedBox]);

  // A box's obs anchor only makes sense for that box — drop a stale anchor when the box changes.
  useEffect(() => {
    if (obsAnchor && obsAnchor.box !== selectedBox) setObsAnchor(null);
  }, [selectedBox, obsAnchor]);

  // Deep-link / back-forward restore: once the anchored box's data is loaded, scroll to and
  // highlight the observation. Guarded so a background data refresh doesn't re-scroll.
  const lastRestoredObs = useRef<string|null>(null);
  useEffect(() => {
    if (!selectedBox || !boxDetail || !obsAnchor || obsAnchor.box !== selectedBox) return;
    const key = `${selectedBox}|${obsAnchor.time}`;
    if (lastRestoredObs.current === key) return;
    lastRestoredObs.current = key;
    setHighlightObs(obsAnchor.time);
    setScrollToObs(obsAnchor.time);
  }, [boxDetail, selectedBox, obsAnchor]);

  const birdData = useBirdDetail(loading ? null : selectedBird);
  // Reports page: clicking a bird docks a peng panel on the right instead of leaving.
  const [reportsBird, setReportsBird] = useState<string|null>(null);
  const reportsBirdData = useBirdDetail(reportsBird);

  const openBird = (pengNum: string) => {
    if (window.innerWidth < 900 && selectedBox) {
      setPreviousBox(selectedBox);
      setSelectedBox(null);
    }
    if (!selectedBox) setDockBirdToBox(true); // opened standalone -> dock beside its recent box
    setSelectedBird(pengNum);
  };

  // Adopt the bird's most-recently-seen box (sightings are newest-first) so a standalone bird
  // opens as the box+bird split with the panel docked right. Wide screens only — on narrow the
  // full-width bird page is fine.
  useEffect(() => {
    if (!dockBirdToBox || !selectedBird || selectedBox) return;
    if (window.innerWidth < 900) { setDockBirdToBox(false); return; }
    const box = birdData?.sightings?.[0]?.box;
    if (box) { setSelectedBox(box); setDockBirdToBox(false); }
  }, [dockBirdToBox, selectedBird, selectedBox, birdData]);

  const closeBird = () => {
    setSelectedBird(null);
  };

  // Navigate to a box from inside the bird panel. Desktop keeps the bird panel open
  // (it rides along in the split view); narrow screens can't show both, so we land on
  // the box and dismiss the bird. `date`, when given, highlights that observation.
  const goToBoxFromBird = (box: string, date?: string) => {
    setHighlightObs(null); setScrollToObs(null);
    if (window.innerWidth < 900) { setSelectedBird(null); setPreviousBox(null); }
    setObsAnchor(date ? { box, time: date } : null);
    setSelectedBox(box);
    if (date) setTimeout(() => { setHighlightObs(date); setScrollToObs(date); }, 10);
  };

  // Box navigation (grid, map): the docked peng panel rides along. Narrow screens
  // can't show box + bird side by side, so there the bird is dismissed.
  const openBox = (box: string) => {
    if (window.innerWidth < 900) setSelectedBird(null);
    setPreviousBox(null);
    setSelectedBox(box);
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
    // Don't hijack arrow/Escape keys while typing in a field — they move the cursor / cancel the edit.
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    // Day view: left/right step to the previous/next date that has an observation.
    if (selectedDay) {
      const ds = [...(stats?.observation_dates || [])].sort();
      const di = ds.indexOf(selectedDay);
      // Day → day: the box-highlight came from a specific box's date link — it
      // doesn't apply to a different day, so drop it.
      if (e.key === 'ArrowRight' && di >= 0 && di < ds.length - 1) { e.preventDefault(); setDayBox(null); setSelectedDay(ds[di + 1]); }
      else if (e.key === 'ArrowLeft' && di > 0) { e.preventDefault(); setDayBox(null); setSelectedDay(ds[di - 1]); }
      else if (e.key === 'Escape') { setSelectedDay(null); }
      return;
    }
    if (!selectedBox || sortedBoxIds.length === 0) return;
    const idx = sortedBoxIds.indexOf(selectedBox);
    if (idx < 0) return;
    // Box → box: the date-scroll came from a day view link into the old box — it
    // doesn't apply to a different box, so drop it.
    if (e.key === 'ArrowRight' && idx < sortedBoxIds.length - 1) {
      setHighlightObs(null); setScrollToObs(null);
      setSelectedBox(sortedBoxIds[idx + 1]);
    } else if (e.key === 'ArrowLeft' && idx > 0) {
      setHighlightObs(null); setScrollToObs(null);
      setSelectedBox(sortedBoxIds[idx - 1]);
    } else if (e.key === 'Escape') {
      setSelectedBox(null);
    }
  }, [selectedBox, selectedDay, sortedBoxIds, stats]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // While the day overlay is open, lock body scroll so the view underneath doesn't show a
  // second scrollbar or scroll behind it.
  useEffect(() => {
    if (!selectedDay) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [selectedDay]);

  if (loading) return <div className="center loading-screen">
    {loadPct === null && <div className="spinner"/>}
    <p>{loadProgress || 'Loading colony data...'}</p>
    {loadPct !== null && <div className="progress-bar"><div className="progress-fill" style={{width: `${Math.round(loadPct * 100)}%`}}/></div>}
    <p className="muted" style={{fontSize:14, position:'absolute', bottom:16, right:16}}>Photo: Marty Melville</p>
  </div>;

  // Password dialog renders on top of any page
  const passwordDialog = showChangePassword ? <ChangePasswordDialog token={token} onClose={() => setShowChangePassword(false)} /> : null;

  const goTo = (section: 'colony' | 'reports' | 'admin' | 'enter') => {
    // Drop any ?tab from the previous section so admin/reports don't inherit each other's tab.
    { const u = new URL(window.location.href); u.searchParams.delete('tab'); window.history.replaceState(null, '', u.pathname + u.search); }
    setSelectedBox(null); setSelectedBird(null); setSelectedDay(null);
    setShowAdmin(section === 'admin');
    setShowReports(section === 'reports');
    setShowEntry(section === 'enter');
  };

  const goToDay = (day: string, box?: string) => {
    // Day view is an overlay: keep the box + bird panel underneath so dismissing the day
    // (Escape / back / returning to the box) restores exactly where you were.
    setShowAdmin(false); setShowReports(false); setShowEntry(false);
    setDayBox(box ?? null);
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

  // Colony <option>s, grouped by region with <optgroup> once there's more than one region.
  const colonyOptionEls = (() => {
    const byRegion: Record<string, any[]> = {};
    for (const c of colonies) (byRegion[c.region_name || ''] ||= []).push(c);
    const regions = Object.keys(byRegion);
    const opts = (list: any[]) => list.map((c: any) => <option key={c.colony_id} value={c.colony_id}>{c.colony_name}</option>);
    return regions.length > 1 ? regions.map(r => <optgroup key={r} label={r}>{opts(byRegion[r])}</optgroup>) : opts(colonies);
  })();

  const siteHeader = (
    <header>
      <h1 className="logo clickable" onClick={() => goTo('colony')}>Wildwatch</h1>
      <span className="header-desktop">
        {siteNav}
        {colonies.length > 1 && (
          <select className="colony-select" value={colonyId} onChange={e => switchColony(Number(e.target.value))} title="Switch colony">
            {colonyOptionEls}
          </select>
        )}
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
          {colonies.length > 1 && (
            <div className="mobile-search-group">
              <label className="mobile-label">Colony</label>
              <select className="colony-select" value={colonyId} onChange={e => { switchColony(Number(e.target.value)); closeMenu(); }}>
                {colonyOptionEls}
              </select>
            </div>
          )}
          <div className="mobile-search-group">
            <label className="mobile-label">Penguin</label>
            <PenguinSearch penguins={allPenguins} search={penguinSearch} onSearchChange={setPenguinSearch} onBirdClick={(num) => { openBird(num); closeMenu(); }} />
          </div>
          <div className="mobile-search-group">
            <label className="mobile-label">Box</label>
            <input className="mobile-input" type="text" placeholder="Box number" onKeyDown={e => { if (e.key === 'Enter') { const v = (e.target as HTMLInputElement).value.replace(/#/g, '').trim(); if (v) { setSelectedBird(null); setSelectedDay(null); setHighlightObs(null); setScrollToObs(null); setSelectedBox(v); (e.target as HTMLInputElement).value = ''; closeMenu(); } } }} />
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
                    const pm = registeredFmDates.get(d)?.partial;
                    const fm = ds?.isFullMonitor && !pm;
                    const [,m,day] = d.split('-');
                    const label = `${parseInt(day)} ${months[parseInt(m) - 1]}`;
                    return (
                      <span key={d} className="scan clickable" onClick={() => { goToDay(d); closeMenu(); }}
                        style={{fontSize:10, whiteSpace:'nowrap', background: pm ? '#b2dfdb' : fm ? '#c8e6c9' : '#e3f2fd', color: pm ? '#00695c' : fm ? '#2e7d32' : '#1a5276', borderColor: pm ? '#4db6ac' : fm ? '#81c784' : '#90caf9', display:'inline-flex', flexDirection:'column', alignItems:'center', gap:1, padding:'2px 5px', lineHeight:1.3}}>
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

  // Day view is a full-screen overlay (not an early return) so the box + bird panel beneath
  // it stay mounted — their scroll position and expanded sections survive the detour. Dialogs
  // (z-index ≥ 900) still layer above it; Escape / browser-back clear selectedDay to dismiss.
  const dayOverlay = (selectedDay && !showAdmin && !showReports && !showEntry && !showSettings) ? (
    <div className="app day-overlay">
      {siteHeader}
      <div className="colony-toolbar">
        <PenguinSearch penguins={allPenguins} search={penguinSearch} onSearchChange={setPenguinSearch} onBirdClick={(num) => setSelectedBird(num)} />
        <input className="box-search-input" type="text" placeholder="Box" onKeyDown={e => { if (e.key === 'Enter') { const v = (e.target as HTMLInputElement).value.replace(/#/g, '').trim(); if (v) { setSelectedDay(null); setHighlightObs(null); setScrollToObs(null); setSelectedBox(v); (e.target as HTMLInputElement).value = ''; } } }} />
        <DateSearch dates={stats?.observation_dates || []} onDayClick={goToDay} onFocusChange={(f, d) => { setDatePickerVisible(f); setDatePickerCenter(d); }} />
        {userRole !== 'viewer' && <button className="toolbar-btn" onClick={() => goTo('enter')}>Enter data</button>}
      </div>
      <DayView date={selectedDay} dates={stats?.observation_dates || []} highlightBox={dayBox} onBoxClick={(box, date) => { setSelectedDay(null); if (window.innerWidth < 900) setSelectedBird(null); setObsAnchor(date ? { box, time: date } : null); setSelectedBox(box); if (date) { setHighlightObs(null); setScrollToObs(null); setTimeout(() => { setHighlightObs(date); setScrollToObs(date); }, 10); } else { setHighlightObs(null); setScrollToObs(null); } }} onBirdClick={openBird} onDayClick={goToDay} externalBird={selectedBird} token={token} canEdit={userRole !== 'viewer'} allPenguins={allPenguins} peekCalendar={datePickerVisible} />
    </div>
  ) : null;

  // Wrap any return with tooltip provider + portal, plus the day-view overlay on top.
  const wrap = (content: React.ReactNode) => (
    <DateTooltipCtx.Provider value={dateTipCtx}>
      {content}
      {dayOverlay}
      <DateTooltipPortal tip={dateTip.tip} statsCache={dateStatsCache} />
    </DateTooltipCtx.Provider>
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
        <div className={`reports-page${reportsBird && reportsBirdData?.penguin ? ' reports-page-docked' : ''}`}>
          <ReportsPage onOpenBird={setReportsBird}
            onDayClick={(d: string) => { setShowReports(false); goToDay(d); }} />
        </div>
        {reportsBird && reportsBirdData?.penguin && (
          <div className="day-bird-dock entry-bird-dock">
            <BirdPage data={reportsBirdData} onBirdClick={(num: string) => setReportsBird(num)}
              onBoxClick={(box: string) => { setShowReports(false); openBox(box); }}
              onSightingClick={(box: string, date: string) => { setShowReports(false); goToBoxFromBird(box, date); }}
              onDayClick={(d: string) => { setShowReports(false); goToDay(d); }}
              onClose={() => setReportsBird(null)}
              token={token} canEdit={userRole !== 'viewer'} />
          </div>
        )}
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
          <input className="box-search-input" type="text" placeholder="Box" onKeyDown={e => { if (e.key === 'Enter') { const v = (e.target as HTMLInputElement).value.replace(/#/g, '').trim(); if (v) { setSelectedBird(null); setHighlightObs(null); setScrollToObs(null); setSelectedBox(v); (e.target as HTMLInputElement).value = ''; } } }} />
          <DateSearch dates={stats?.observation_dates || []} onDayClick={goToDay} onFocusChange={(f, d) => { setDatePickerVisible(f); setDatePickerCenter(d); }} />
          {userRole !== 'viewer' && <button className="toolbar-btn" onClick={() => goTo('enter')}>Enter data</button>}
        </div>
        <div className="bird-page">
          <div className="page-header">
            <a className="page-back" href={previousBox ? `/box/${previousBox}` : '/'} onClick={e => navClick(e, () => { closeBird(); if (previousBox) { setHighlightObs(null); setScrollToObs(null); setSelectedBox(previousBox); setPreviousBox(null); } })}>&larr; {previousBox ? `Box ${previousBox}` : 'Colony'}</a>
          </div>
          {birdData?.penguin ? (
            <BirdPage data={birdData} onBirdClick={openBird} token={token} canEdit={userRole !== 'viewer'}
              onBoxClick={(box: string) => goToBoxFromBird(box)}
              onSightingClick={(box: string, date: string) => goToBoxFromBird(box, date)}
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
        <input className="box-search-input" type="text" placeholder="Box" onKeyDown={e => { if (e.key === 'Enter') { const v = (e.target as HTMLInputElement).value.replace(/#/g, '').trim(); if (v) { setSelectedBird(null); setHighlightObs(null); setScrollToObs(null); setSelectedBox(v); (e.target as HTMLInputElement).value = ''; } } }} />
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
            <ColonyMap boxTags={boxTags} selectedBox={selectedBox} onBoxSelect={openBox} />
            <StatsPanel boxTags={boxTags} selectedBox={selectedBox} stats={stats} />
          </div>
        </>
      )}

      <div className={selectedBox ? 'split-view' : ''}>
        {/* Box grid - always visible */}
        <div className={selectedBox ? 'grid-sidebar' : 'grid-section'}>
          <BoxGrid boxTags={boxTags} selectedBox={selectedBox} onBoxSelect={openBox} boxInfo={stats?.box_info} scrollToBox={scrollToBox} boxNames={queryAllLocations().map((l: any) => l.location_name)} />
        </div>

        {/* Box detail */}
        {selectedBox && (
        <div className="detail-area">
          {/* Header + status bar full width */}
          <div className="detail-full">
            <div className="page-header">
              <div className="box-header-left">
                <h2>Box {selectedBox}</h2>
                {boxDetail?.location && (
                  <div className="persistent-notes">
                    <EditableField value={boxDetail.location.persistent_notes || ''} onSave={(val) => updateRecord(token, 'observation_locations', boxDetail.location!.location_id, {persistent_notes: val})} placeholder="Box notes (persistent)" canEdit={userRole !== 'viewer'} />
                  </div>
                )}
                {boxDetail && <StatusLegend />}
              </div>
              <a className="page-back" href="/" onClick={e => navClick(e, () => { setScrollToBox(selectedBox); setSelectedBox(null); })}>&larr; Overview</a>
            </div>
            {false ? <p className="muted">Loading...</p> : boxDetail ? (
              <BreedingStatusBar observations={boxDetail.observations} hideLegend onHighlight={setHighlightObs} onScrollTo={(d) => { if (selectedBox) setObsAnchor({ box: selectedBox, time: d }); setHighlightObs(null); setScrollToObs(null); setTimeout(() => { setHighlightObs(d); setScrollToObs(d); }, 10); }} />
            ) : null}
          </div>

          {/* Split: observations+birds left, penguin detail right */}
          {!false && boxDetail && (
          <div className="detail-split">
            <BoxPanel
              data={boxDetail}
              boxName={selectedBox}
              allPenguins={allPenguins}
              onBirdClick={openBird}
              onDayClick={(day: string) => goToDay(day, selectedBox || undefined)}
              highlightObs={highlightObs}
              scrollToObs={scrollToObs}
              onScrollToObs={(t: string) => { setHighlightObs(null); setScrollToObs(null); setTimeout(() => { setHighlightObs(t); setScrollToObs(t); }, 10); }}
              token={token}
              canEdit={userRole !== 'viewer'}
              onDataChange={refreshStats}
              showDeleted={showDeleted}
              deletedObs={deletedObs}
              onToggleDeleted={async () => {
                if (!showDeleted && deletedObs.length === 0) {
                  const r = await fetch(`/api/dashboard.php?view=box&name=${encodeURIComponent(selectedBox!)}&include_deleted=1&colony_id=${getColonyId()}&_=${Date.now()}`, { headers: { 'Authorization': `Bearer ${token}` } });
                  const d = await r.json();
                  setDeletedObs(d.deleted || []);
                }
                setShowDeleted(!showDeleted);
              }}
              onAddPenguin={(box: string) => setAddPenguinBox(box)}
            />
            {selectedBird && (
            <div className="detail-bird">
              {birdData?.penguin ? (
                <BirdPage data={birdData} onBirdClick={openBird} token={token} canEdit={userRole !== 'viewer'} onClose={() => setSelectedBird(null)}
                  onBoxClick={(box: string) => goToBoxFromBird(box)}
                  onSightingClick={(box: string, date: string) => goToBoxFromBird(box, date)}
                  onDayClick={goToDay} />
              ) : <p className="muted">Loading bird...</p>}
            </div>
            )}
          </div>
          )}
        </div>
        )}
      </div>
      {passwordDialog}
      {addPenguinBox !== null && (
        <AddPenguinDialog
          token={token}
          chipBox={addPenguinBox}
          defaultChipBy={userName.split(/\s+/).map(s => s[0] || '').join('').toUpperCase()}
          allPenguins={allPenguins}
          onClose={() => setAddPenguinBox(null)}
          onAdded={async (pengNum) => {
            const fromBox = addPenguinBox;
            setAddPenguinBox(null);
            await triggerSync();
            refreshStats();
            setPreviousBox(fromBox);
            setSelectedBox(null);
            setSelectedBird(pengNum);
          }}
        />
      )}
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
