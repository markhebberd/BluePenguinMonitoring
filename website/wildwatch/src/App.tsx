import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchBoxTags, fetchBoxDetail, fetchOverview, fetchBirdDetail, fetchAllPenguins, updateRecord, createRecord, deleteRecord, fetchHistory } from './api/boxtags';
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
  chipped_here?: ChippedHere[];
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

  // Calculate egg laid date using C# logic exactly:
  // Start from the most recent monitor with eggs/chicks, walk backwards to find
  // the last monitor where eggs+chicks==0. Probable laid date = midpoint.
  let probableLaidTime: number | null = null;
  const reversed = [...allSorted].reverse(); // newest first, like C#
  // Find most recent monitor with eggs or chicks
  const mostRecent = reversed.find(o => o.eggs + o.chicks > 0);
  if (mostRecent) {
    let whenOffspringFound = parseDate(mostRecent.observation_time_utc).getTime();
    // Walk backwards through older monitors
    const olderThanRecent = allSorted.filter(o =>
      parseDate(o.observation_time_utc).getTime() < whenOffspringFound
    ).reverse(); // newest older first

    for (const older of olderThanRecent) {
      if (older.breeding_status === 'ABN' && older.eggs + older.chicks > 0) {
        break; // Abandoned - no date calculation
      }
      if (older.eggs + older.chicks === 0) {
        if (older.breeding_status === 'ABN') break;
        // Found the empty monitor before eggs appeared
        let adjustedFound = whenOffspringFound;
        if (mostRecent.eggs > 1) adjustedFound -= 2 * 86400000; // 2 days earlier for multiple eggs
        const whenNotFound = parseDate(older.observation_time_utc).getTime();
        const uncertainty = (adjustedFound - whenNotFound) / 2;
        probableLaidTime = whenNotFound + Math.ceil(uncertainty / 86400000) * 86400000;
        break;
      }
      // This older monitor also has eggs/chicks - keep walking back
      whenOffspringFound = parseDate(older.observation_time_utc).getTime();
    }
  }

  // Breeding milestones from laid date (matching C#: Hatch=38d, PG=52d, Chip=80d, Fledge=87d)
  const DAY = 86400000;
  void (probableLaidTime ? probableLaidTime + 38 * DAY : null); // guardTime/hatch at 38d - observer-set G covers this
  const pgTime2 = probableLaidTime ? probableLaidTime + 52 * DAY : null;
  void (probableLaidTime ? probableLaidTime + 80 * DAY : null); // chipTime - 80d, within PG phase
  const fledgeTime = probableLaidTime ? probableLaidTime + 87 * DAY : null;

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



function penguinSexClass(sex: string|null|undefined, chipDate?: string|null, chippedAsAdult?: number|null, observationDate?: string): string {
  const s = (sex || '').toUpperCase();
  const isChick = !chippedAsAdult && chipDate && ((observationDate ? new Date(observationDate).getTime() : Date.now()) - new Date(chipDate).getTime()) < 90 * 86400000;
  return isChick && !s ? 'chick' : s === 'F' ? 'f' : s === 'M' ? 'm' : '';
}

function penguinSexIcon(sex: string|null|undefined, chipDate?: string|null, chippedAsAdult?: number|null, observationDate?: string): string {
  const s = (sex || '').toUpperCase();
  const isChick = !chippedAsAdult && chipDate && ((observationDate ? new Date(observationDate).getTime() : Date.now()) - new Date(chipDate).getTime()) < 90 * 86400000;
  return isChick && !s ? '\uD83D\uDC23' : s === 'F' ? '\u2640' : s === 'M' ? '\u2642' : '';
}

function PenguinMini({ scan, onClick, observationDate }: { scan: Scan | ChippedHere | any; onClick: () => void; observationDate?: string }) {
  const sex = (scan.sex || '').toUpperCase();
  const cls = penguinSexClass(sex, scan.chip_date, scan.chipped_as_adult, observationDate);
  const icon = penguinSexIcon(sex, scan.chip_date, scan.chipped_as_adult, observationDate);
  const num = scan.peng_num ? `#${scan.peng_num}` : '';
  const chip = scan.pit_id ? scan.pit_id.slice(-8) : '';
  // Chipped as chick: yellow bar. If no observation date and chick is now >3 months old, show as unproven adult (gray + yellow bar)
  const wasChippedAsChick = !scan.chipped_as_adult;
  const isChickNow = wasChippedAsChick && scan.chip_date && ((observationDate ? new Date(observationDate).getTime() : Date.now()) - new Date(scan.chip_date).getTime()) < 90 * 86400000;
  const unprovenAdult = wasChippedAsChick && !isChickNow && !sex;
  const chipCls = wasChippedAsChick ? 'chipped-chick' : '';
  const grayCls = unprovenAdult && !observationDate ? 'unproven' : '';
  const sizeCode = scan.chick_size_code || '';
  return (
    <span className={`scan clickable ${cls} ${chipCls} ${grayCls}`} onClick={onClick}>
      {num}{num && icon ? ' ' : ''}{icon && <span className="sex-icon">{icon}</span>}{sizeCode ? ` ${sizeCode} ` : (num || icon) && chip ? ' ' : ''}{chip}
    </span>
  );
}

function AllScannedBirds({ observations, onBirdClick, chippedHere }: { observations: Observation[]; onBirdClick: (tag:string)=>void; chippedHere?: ChippedHere[] }) {
  // Group birds by season, track co-sightings during incubation/guard
  const seasonBirds = new Map<string, Map<string, Scan & { lastSeen: string; igCount: number; scanCount: number }>>();
  const seasonPairs = new Map<string, Map<string, number>>(); // "maleTag|femaleTag" -> count during I/G

  for (const obs of observations) {
    const obsDate = parseDate(obs.observation_time_utc);
    const label = getSeasonLabel(obsDate);
    if (!seasonBirds.has(label)) seasonBirds.set(label, new Map());
    if (!seasonPairs.has(label)) seasonPairs.set(label, new Map());
    const birdMap = seasonBirds.get(label)!;
    const pairMap = seasonPairs.get(label)!;

    const isIG = obs.eggs > 0 || obs.chicks > 0;

    for (const scan of obs.scans) {
      const key = scan.pit_id.slice(-8);
      const existing = birdMap.get(key);
      if (!existing) {
        birdMap.set(key, { ...scan, lastSeen: obs.observation_time_utc, igCount: isIG ? 1 : 0, scanCount: 1 });
      } else {
        existing.scanCount++;
        if (isIG) existing.igCount++;
        if (obs.observation_time_utc > existing.lastSeen) {
          existing.lastSeen = obs.observation_time_utc;
          existing.sex = scan.sex;
          existing.life_stage = scan.life_stage;
        }
      }
    }

    // Track M+F pairs during I/G phases
    if (isIG && obs.scans.length >= 2) {
      const males = obs.scans.filter(s => (s.sex || '').toUpperCase() === 'M');
      const females = obs.scans.filter(s => (s.sex || '').toUpperCase() === 'F');
      for (const m of males) {
        for (const f of females) {
          const pairKey = m.pit_id.slice(-8) + '|' + f.pit_id.slice(-8);
          pairMap.set(pairKey, (pairMap.get(pairKey) || 0) + 1);
        }
      }
    }
  }

  // Merge chipped_here birds into season maps (they were present at chip time)
  for (const c of (chippedHere || [])) {
    if (!c.chip_date || !c.pit_id) continue;
    const chipDate = parseDate(c.chip_date);
    const label = getSeasonLabel(chipDate);
    if (!seasonBirds.has(label)) seasonBirds.set(label, new Map());
    const birdMap = seasonBirds.get(label)!;
    const key = c.pit_id.slice(-8);
    if (!birdMap.has(key)) {
      birdMap.set(key, { ...c as any, pit_id: c.pit_id, peng_num: c.peng_num, lastSeen: c.chip_date, igCount: 0, scanCount: 0 });
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

        // Find breeding pair: M+F with most I/G co-sightings
        // If no I/G data, fall back to most common M+F pair by total co-sightings
        const pairMap = seasonPairs.get(label) || new Map();
        let breedingMale = '';
        let breedingFemale = '';
        let maxPairCount = 0;
        for (const [key, count] of pairMap.entries()) {
          if (count > maxPairCount) {
            maxPairCount = count;
            [breedingMale, breedingFemale] = key.split('|');
          }
        }

        // Only show breeding pair if there were actual eggs or chicks (I/G observations)
        if (maxPairCount === 0) {
          breedingMale = '';
          breedingFemale = '';
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

function ObsCard({ obs, onBirdClick, highlight, scrollTo, token, canEdit, allPenguins }: { obs: Observation; onBirdClick?: (tag:string)=>void; highlight?: boolean; scrollTo?: boolean; token?: string; canEdit?: boolean; allPenguins?: any[] }) {
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
    const result = await updateRecord(token || '', 'observations', obsId, {[field]: val});
    if (result?.changed) setLocalObs((o: any) => ({...o, [field]: val}));
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
        <span><b>{fmtDateTime(obs.observation_time_utc)}</b> <span className="muted small">{obs.monitor_filename}</span></span>
        <span className="obs-top-right">
          {editCount > 0 && obsId && <span className="edit-badge clickable" onClick={() => setShowHistory(!showHistory)}>{editCount === 1 ? 'edited' : `${editCount} edits`}</span>}
          {canEdit && obsId && !editing && <button className="edit-btn" onClick={() => setEditing(true)}>Edit</button>}
          {editing && <><button className="edit-btn" onClick={() => setEditing(false)}>Cancel</button><button className="edit-btn done-btn" onClick={() => setEditing(false)}>Done</button></>}
        </span>
      </div>
      {!editing ? (
        <>
          <div className="obs-nums">
            {localObs.adults > 0 && <span>{'\uD83D\uDC27'.repeat(Math.min(localObs.adults, 6))}</span>}
            {localObs.eggs > 0 && <span>{'\uD83E\uDD5A'.repeat(Math.min(localObs.eggs, 6))}</span>}
            {localObs.chicks > 0 && <span>{'\uD83D\uDC23'.repeat(Math.min(localObs.chicks, 6))}</span>}
            {localObs.breeding_status && <span className="badge" style={{background:STATUS_COLORS[localObs.breeding_status]||'#ccc'}}>{localObs.breeding_status}</span>}
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
          <EditableField value={localObs.breeding_status || ''} type="select" options={['','BR','CON','POT','UNL','NO','DCM','ABN']} onSave={trackEdit('breeding_status')} canEdit={true} />
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
          {obs.scans.map((s,j) => (
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

function BirdPage({ data, onBirdClick, onBoxClick, onSightingClick, onNavigateToBird, token, canEdit }: { data: any; onBirdClick: (tag:string)=>void; onBoxClick: (box:string)=>void; onSightingClick: (box:string, date:string)=>void; onNavigateToBird?: (num:string)=>void; token?: string; canEdit?: boolean }) {
  const p = data.penguin;
  const scans: any[] = data.scans || [];
  const biometrics: any[] = data.biometrics || [];
  const partners: any[] = data.partners || [];
  const breedingStats: any[] = data.breeding_stats || [];

  const chips: any[] = p.chips || [];
  const activeChip = chips.find((c: any) => c.is_active == 1) || chips[0];

  // Boxes: from scans + chip boxes, deduplicated
  const scanBoxes = scans.map((s: any) => s.box_name);
  const chipBoxes = chips.map((c: any) => c.chip_box).filter(Boolean);
  const boxes = Array.from(new Set([...chipBoxes, ...scanBoxes]));
  const [showHistory, setShowHistory] = useState<{table:string;id:number}|null>(null);
  const [hasHistory, setHasHistory] = useState(false);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (token && p.peng_num) {
      fetchHistory(token, 'penguins', p.peng_num).then(d => setHasHistory(Array.isArray(d) && d.length > 0));
    }
  }, [token, p.peng_num]);
  const savePenguin = (field: string) => (val: any) => updateRecord(token || '', 'penguins', p.peng_num, {[field]: val});
  const saveChip = (pitId: string, field: string) => (val: any) => updateRecord(token || '', 'penguin_chips', pitId, {[field]: val});
  const saveBio = (bioId: number, field: string) => (val: any) => updateRecord(token || '', 'penguin_biometric_data', bioId, {[field]: val});


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
            <tr><td className="muted">Initial Chip Date</td><td>{chips.length > 0 ? chips[0].chip_date || <span className="muted">-</span> : <span className="muted">-</span>}</td></tr>
            <tr><td className="muted">Chick Size Code</td><td>{!editing ? (p.chick_size_code || <span className="muted">-</span>) : <EditableField value={p.chick_size_code} onSave={savePenguin('chick_size_code')} placeholder="-" canEdit={true} />}</td></tr>
            <tr><td className="muted">VID</td><td>{!editing ? (p.vid_for_scanner || <span className="muted">-</span>) : <EditableField value={p.vid_for_scanner} onSave={savePenguin('vid_for_scanner')} placeholder="-" canEdit={true} />}</td></tr>
            <tr><td className="muted">Notes</td><td>{!editing ? (p.kommentar || <span className="muted">-</span>) : <EditableField value={p.kommentar} onSave={savePenguin('kommentar')} placeholder="-" canEdit={true} />}</td></tr>
            {chips.map((c: any, i: number) => {
              const re = 'Re'.repeat(i);
              const prefix = i === 0 ? '' : re.toLowerCase();
              return (<Fragment key={`chip${i}`}>
              <tr><td className="muted">{prefix ? `${re}chip ` : ''}PIT ID</td><td>{c.pit_id}{!c.is_active && <span className="bird-badge" style={{background:'#FFCDD2', marginLeft:4}}>Retired</span>}</td></tr>
              <tr><td className="muted">{prefix ? `${re}chip ` : 'Chip '}Date</td><td>{!editing ? (c.chip_date || <span className="muted">-</span>) : <EditableField value={c.chip_date} type="date" onSave={saveChip(c.pit_id, 'chip_date')} placeholder="date" canEdit={true} />}</td></tr>
              <tr><td className="muted">{prefix ? `${re}chip ` : 'Chip '}Box</td><td>{!editing ? (c.chip_box ? <span className="clickable" onClick={() => onBoxClick(c.chip_box)}>{c.chip_box}</span> : <span className="muted">-</span>) : <EditableField value={c.chip_box} onSave={saveChip(c.pit_id, 'chip_box')} placeholder="box" canEdit={true} />}</td></tr>
              <tr><td className="muted">{prefix ? `${re}chipped ` : 'Chipped '}By</td><td>{!editing ? (c.chip_by || <span className="muted">-</span>) : <EditableField value={c.chip_by} onSave={saveChip(c.pit_id, 'chip_by')} placeholder="who" canEdit={true} />}</td></tr>
            </Fragment>);
            })}
            <tr><td className="muted">Last Known Life Stage</td><td>{!editing ? (p.life_stage || <span className="muted">-</span>) : <EditableField value={p.life_stage} type="select" options={['Adult','Chick','Returnee','Dead']} onSave={savePenguin('life_stage')} canEdit={true} />}</td></tr>
            {biometrics.map((b: any, i: number) => (<Fragment key={`bio${i}`}>
              <tr><td className="muted" colSpan={2} style={{fontWeight:600, paddingTop:8}}>Biometrics {b.observation_date || ''}</td></tr>
              <tr><td className="muted">Date</td><td>{!editing ? (b.observation_date || <span className="muted">-</span>) : <EditableField value={b.observation_date} type="date" onSave={saveBio(b.biometric_id, 'observation_date')} canEdit={true} />}</td></tr>
              <tr><td className="muted">Weight</td><td>{!editing ? (b.weight ? `${parseFloat(b.weight).toFixed(0)}g` : <span className="muted">-</span>) : <><EditableField value={b.weight ? parseFloat(b.weight).toFixed(0) : ''} type="number" onSave={saveBio(b.biometric_id, 'weight')} placeholder="weight" canEdit={true} /><span>g</span></>}</td></tr>
              <tr><td className="muted">Flipper Length</td><td>{!editing ? (b.right_flipper_length ? `${parseFloat(b.right_flipper_length).toFixed(0)}mm` : <span className="muted">-</span>) : <><EditableField value={b.right_flipper_length ? parseFloat(b.right_flipper_length).toFixed(0) : ''} type="number" onSave={saveBio(b.biometric_id, 'right_flipper_length')} placeholder="mm" canEdit={true} /><span>mm</span></>}</td></tr>
              <tr><td className="muted">Moulting</td><td>{b.is_moulting ? 'Yes' : <span className="muted">No</span>}</td></tr>
              <tr><td className="muted">Underweight</td><td>{b.condition_underweight ? 'Yes' : <span className="muted">No</span>}</td></tr>
              <tr><td className="muted">Ticks</td><td>{b.condition_ticks ? 'Yes' : <span className="muted">No</span>}</td></tr>
              <tr><td className="muted">Dead</td><td>{b.condition_dead ? 'Yes' : <span className="muted">No</span>}</td></tr>
              <tr><td className="muted">Dog Attacked</td><td>{b.condition_dog_attacked ? 'Yes' : <span className="muted">No</span>}</td></tr>
              <tr><td className="muted">Attacked</td><td>{b.condition_attacked ? 'Yes' : <span className="muted">No</span>}</td></tr>
              <tr><td className="muted">Aggressive</td><td>{b.disposition_aggressive ? 'Yes' : <span className="muted">No</span>}</td></tr>
              <tr><td className="muted">Passive</td><td>{b.disposition_passive ? 'Yes' : <span className="muted">No</span>}</td></tr>
              {b.notes && <tr><td className="muted">Notes</td><td>{b.notes}</td></tr>}
            </Fragment>))}
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
                {bs.statuses.map((s:string) => <span key={s} className="badge" style={{background:STATUS_COLORS[s]||'#ccc'}}>{s}</span>)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Locations with sightings */}
      <div className="bird-section">
        <h3>Seen in {boxes.length} box{boxes.length !== 1 ? 'es' : ''}</h3>
        {boxes.map((b: string) => {
          // Collect sightings for this box: from scans + chip date
          const boxScans = scans.filter((s: any) => s.box_name === b);
          const chippedHere = chips.find((c: any) => c.chip_box === b);
          // Deduplicate by date
          const sightings = new Map<string, { date: string; seenWith: any[] }>();
          if (chippedHere) {
            sightings.set(chippedHere.chip_date, { date: chippedHere.chip_date, seenWith: [] });
          }
          for (const s of boxScans) {
            const date = s.observation_time_utc.slice(0, 10);
            if (!sightings.has(date)) {
              sightings.set(date, { date: s.observation_time_utc, seenWith: s.seen_with || [] });
            } else if ((s.seen_with || []).length > (sightings.get(date)!.seenWith.length)) {
              sightings.get(date)!.seenWith = s.seen_with;
            }
          }
          const sorted = Array.from(sightings.values()).sort((a, b) => b.date.localeCompare(a.date));
          return (
            <div key={b} className="obs-card" style={{marginBottom:6}}>
              <div className="obs-top"><b className="clickable" onClick={() => onBoxClick(b)}>Box {b}</b> <span className="muted">{sorted.length} visit{sorted.length !== 1 ? 's' : ''}</span></div>
              {sorted.slice(0, 5).map((sg, i) => (
                <div key={i} className="obs-nums" style={{fontSize:11}}>
                  <span>{fmtDateTime(sg.date)}</span>
                  {sg.seenWith.map((sw: any) => (
                    <PenguinMini key={sw.peng_num} scan={sw} onClick={() => onBirdClick(sw.peng_num)} observationDate={sg.date} />
                  ))}
                </div>
              ))}
              {sorted.length > 5 && <div className="muted small">+{sorted.length - 5} more</div>}
            </div>
          );
        })}
      </div>

      {/* Scan history */}
      <div className="bird-section">
        <h3>Scan history ({scans.length})</h3>
        {scans.map((s: any, i: number) => (
          <div key={i} className="obs-card">
            <div className="obs-top">
              <b>{fmtDateTime(s.observation_time_utc)}</b>
              <span className="bird-chip clickable" onClick={() => onBoxClick(s.box_name)}>Box {s.box_name}</span>
            </div>
            <div className="obs-nums">
              {s.adults > 0 && <span>{'\uD83D\uDC27'.repeat(Math.min(s.adults, 6))}</span>}
              {s.eggs > 0 && <span>{'\uD83E\uDD5A'.repeat(Math.min(s.eggs, 6))}</span>}
              {s.chicks > 0 && <span>{'\uD83D\uDC23'.repeat(Math.min(s.chicks, 6))}</span>}
              {s.breeding_status && <span className="badge" style={{background:STATUS_COLORS[s.breeding_status]||'#ccc'}}>{s.breeding_status}</span>}
              {s.gate_status && <span className="gate">{s.gate_status}</span>}
            </div>
            {s.notes && <div className="obs-notes">{s.notes}</div>}
            <div className="muted small">{s.monitor_filename}</div>
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
                  <div key={i} className="partner-row clickable" onClick={() => onSightingClick(s.box, s.date)}>
                    <span>{fmtDateTime(s.date)}</span>
                    <span className="bird-chip">Box {s.box}</span>
                  </div>
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
  const filtered = search.length > 0
    ? penguins.filter(p => (p.pit_id && p.pit_id.includes(search)) || (p.peng_num && p.peng_num === search))
    : [];

  return (
    <div className="penguin-search">
      <input
        type="text"
        placeholder="Search penguin by ID number..."
        value={search}
        onChange={e => onSearchChange(e.target.value.replace(/[^0-9A-Za-z]/g, ''))}
        className="penguin-search-input"
      />
      {filtered.length > 0 && (
        <div className="penguin-results">
          {filtered.slice(0, 20).map((p: any) => {
            const cls = penguinSexClass(p.sex, p.chip_date, p.chipped_as_adult);
            return (
              <div key={p.pit_id} className={`penguin-result clickable ${cls}`} onClick={() => { onBirdClick(p.peng_num || p.pit_id); onSearchChange(''); }}>
                <span className="pr-tag">
                  <PenguinMini scan={p} onClick={() => { onBirdClick(p.peng_num || p.pit_id); onSearchChange(''); }} />
                </span>
                <span className="pr-meta">
                  {p.partner_count > 0 && <span className="pr-stat">{p.partner_count} partner{p.partner_count>1?'s':''}</span>}
                  {p.total_chicks_raised > 0 && <span className="pr-stat">{p.total_chicks_raised} chick{p.total_chicks_raised>1?'s':''} raised</span>}
                  <span className="pr-stat">{p.total_scans} scan{p.total_scans>1?'s':''}</span>
                </span>
              </div>
            );
          })}
          {filtered.length > 20 && <div className="muted" style={{padding:'4px 8px'}}>+{filtered.length - 20} more</div>}
        </div>
      )}
      {search.length > 0 && filtered.length === 0 && (
        <div className="penguin-results"><div className="muted" style={{padding:'8px'}}>No penguins match "{search}"</div></div>
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
          if (d2.token) onLogin(d2.token, d2.name, d2.observer_id, d2.role);
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
          if (data.token) onLogin(data.token, data.name, data.observer_id, data.role);
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
        <h1>WildWatch</h1>
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
    ? allPenguins.filter((p: any) => (p.pit_id.includes(birdSearch) || (p.peng_num && p.peng_num === birdSearch)) && !p.pit_id.startsWith('LA900025') && !p.pit_id.startsWith('9130')).slice(0, 10)
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
          observation_time_utc: parsedDate + ' 12:00:00',
          adults, eggs, chicks,
          breeding_status: breedingStatus || null,
          gate_status: gateStatus || null,
          notes,
          monitor_filename: 'web-entry'
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
            scan_time_utc: parsedDate + ' 12:00:00'
          })
        });
      }

      setMessage(`Saved: Box ${box}, ${parsedDate}, ${scannedBirds.length} birds`);
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
              {Array.from({length: getSeasonStart().getFullYear() - 2000 - 22}, (_, i) => 23 + i).map(y => <option key={y} value={2000+y}>{y}</option>)}
            </select>
          </div>
          <div className="entry-field">
            <label>Box</label>
            <input type="text" value={box} onChange={e => setBox(e.target.value)} placeholder="e.g. 34" />
          </div>
        </div>
      </div>

      {/* Date mappings - always visible */}
      <div className="entry-context">
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:'6px'}}>
          <span style={{fontSize:'13px', fontWeight:600, color:'#1a5276'}}>Date table (season {String(season).slice(-2)})</span>
          <button type="button" style={{padding:'4px 12px', background:'#1a5276', color:'#fff', border:'none', borderRadius:'4px', fontSize:'12px', cursor:'pointer'}} onClick={() => { setDateEditorText(dateMappings.map(m => {
                const d = m.actual_date;
                return `${m.date_number} ${parseInt(d.slice(8))}/${parseInt(d.slice(5,7))}/${d.slice(2,4)}`;
              }).join('\n')); setShowDateEditor(true); }}>
            {dateMappings.length > 0 ? 'Edit dates' : 'Set up dates'}
          </button>
        </div>
        {dateMappings.length > 0 ? (
          <div style={{display:'flex', flexWrap:'wrap', gap:'3px'}}>
            {dateMappings.map(m => (
              <span key={m.date_number} style={{background:'#e8ecef', padding:'3px 8px', borderRadius:'4px', fontSize:'12px', cursor:'pointer'}} onClick={() => setDateInput(String(m.date_number))}>
                <b>{m.date_number}</b> = {m.actual_date.slice(8)+'/'+m.actual_date.slice(5,7)+'/'+m.actual_date.slice(2,4)}
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

      <div className="entry-split">
      {/* LEFT: graph + existing data */}
      <div className="entry-left">
      {/* Breeding status bar */}
      {box && allBoxObs.length > 0 && (
        <div className="entry-context">
          <BreedingStatusBar observations={allBoxObs} />
        </div>
      )}

      {/* Existing observations for this box+season */}
      {box && existingObs.length > 0 && (
        <div className="entry-existing">
          <h3>{existingObs.length} existing observation{existingObs.length !== 1 ? 's' : ''} for Box {box} ({season})</h3>
          {existingObs.map((o: any, i: number) => (
            <div key={i} className="entry-existing-row">
              <span>{fmtDateNZ(o.observation_time_utc)}</span>
              <span>{'\uD83D\uDC27'.repeat(o.adults)}{'\uD83E\uDD5A'.repeat(o.eggs)}{'\uD83D\uDC23'.repeat(o.chicks)}</span>
              {o.breeding_status && <span className="badge" style={{background:STATUS_COLORS[o.breeding_status]||'#ccc'}}>{o.breeding_status}</span>}
              {o.gate_status && <span className="gate">{o.gate_status}</span>}
              {(o.scans || []).map((s: any, j: number) => (
                <PenguinMini key={j} scan={s} onClick={() => {}} observationDate={o.observation_time_utc} />
              ))}
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
          {parsedDate && <span className="date-preview">{parsedDate}{dateMappings.find(m => m.actual_date === parsedDate) ? ` (#${dateMappings.find(m => m.actual_date === parsedDate)!.date_number})` : ''}</span>}
          {dateInput && !parsedDate && <span className="date-preview date-invalid">Invalid{dateMappings.length > 0 ? ` (dates 1-${dateMappings.length} available)` : ' - no date table'}</span>}
        </div>

        <div className="entry-row">
          <label>Add penguins</label>
          <input type="text" value={birdSearch} onChange={e => setBirdSearch(e.target.value.replace(/[^0-9A-Za-z]/g,''))} onKeyDown={handleSearchKey} placeholder="Search by ID" />
          {/* Quick add - penguins seen this season */}
          {box && existingObs.length > 0 && (() => {
            const seenBirds = new Map<string, { sex: string|null }>();
            for (const o of existingObs) {
              for (const s of (o.scans || [])) {
                const tag = s.pit_id.slice(-8);
                if (!seenBirds.has(tag)) seenBirds.set(tag, { sex: s.sex });
              }
            }
            return seenBirds.size > 0 ? (
              <div className="bird-row" style={{marginTop:'6px'}}>
                {Array.from(seenBirds.entries()).map(([tag, info]) => {
                  const cls = penguinSexClass(info.sex);
                  const icon = penguinSexIcon(info.sex);
                  const already = scannedBirds.includes(tag);
                  return <span key={tag} className={`bird-chip clickable ${cls} ${already ? 'added' : ''}`}
                    onClick={() => { if (!already) addBird(tag); }}>
                    {icon ? `${icon} ` : ''}{tag}{already ? ' \u2713' : ''}
                  </span>;
                })}
              </div>
            ) : null;
          })()}
          {filteredBirds.length > 0 && (
            <div className="penguin-results">
              {filteredBirds.map((p: any, idx: number) => (
                <div key={p.pit_id} className={`penguin-result clickable ${penguinSexClass(p.sex, p.chip_date, p.chipped_as_adult)} ${idx === searchIdx ? 'focused' : ''}`}
                  onClick={() => addBird(p.pit_id)}>
                  <PenguinMini scan={p} onClick={() => addBird(p.pit_id)} />
                </div>
              ))}
            </div>
          )}
        </div>

        {scannedBirds.length > 0 && (
          <div className="entry-birds">
            {scannedBirds.map(b => {
              const bird = allPenguins.find((p: any) => p.pit_id.slice(-8) === b || p.pit_id === b);
              return <span key={b} className="scan-removable">
                {bird ? <PenguinMini scan={bird} onClick={() => removeBird(b)} /> : <span className="scan" onClick={() => removeBird(b)}>{b}</span>}
                <button className="remove-scan" onClick={() => removeBird(b)}>&times;</button>
              </span>;
            })}
          </div>
        )}

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

        {message && <div className={message.startsWith('Error') || message.startsWith('Failed') ? 'login-error' : 'entry-success'}>{message}</div>}

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

function parseUrl(): { box?: string; bird?: string; enter?: boolean } {
  const path = window.location.pathname;
  const boxMatch = path.match(/^\/box\/(.+)/);
  const birdMatch = path.match(/^\/bird\/(.+)/);
  return { box: boxMatch?.[1], bird: birdMatch?.[1], enter: path === '/enter' };
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
      if (d.success) { setMsg('Password changed'); setCurrent(''); setNewPass(''); }
      else setMsg(d.error || 'Failed');
    } catch { setMsg('Connection failed'); }
    setSaving(false);
  };

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
          {msg && <div className={msg === 'Password changed' ? 'entry-success' : 'login-error'}>{msg}</div>}
          <button type="submit" disabled={saving}>{saving ? 'Saving...' : 'Change password'}</button>
        </form>
        <button className="toggle-auth" onClick={onClose}>Cancel</button>
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
  const [detailLoading, setDetailLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedBird, setSelectedBird] = useState<string|null>(initial.bird || null);
  const [birdData, setBirdData] = useState<any>(null);
  const [birdLoading, setBirdLoading] = useState(false);
  const [highlightObs, setHighlightObs] = useState<string|null>(null);
  const [scrollToObs, setScrollToObs] = useState<string|null>(null);
  const [allPenguins, setAllPenguins] = useState<any[]>([]);
  const [penguinSearch, setPenguinSearch] = useState('');
  const [showEntry, setShowEntry] = useState(initial.enter || false);
  const [scrollToBox, setScrollToBox] = useState<string|null>(null);
  const [previousBox, setPreviousBox] = useState<string|null>(null);

  // Sync state to URL
  useEffect(() => {
    let path = '/';
    if (showEntry) path = '/enter';
    else if (selectedBox) path = `/box/${selectedBox}`;
    else if (selectedBird) path = `/bird/${selectedBird}`;
    if (window.location.pathname !== path) {
      window.history.pushState(null, '', path);
    }
  }, [selectedBox, selectedBird, showEntry]);

  // Handle browser back/forward
  useEffect(() => {
    const onPopState = () => {
      const { box, bird, enter } = parseUrl();
      setSelectedBox(box || null);
      setSelectedBird(bird || null);
      setShowEntry(enter || false);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    Promise.all([fetchBoxTags(), fetchOverview(), fetchAllPenguins()])
      .then(([tags, ov, pgs]) => { setBoxTags(tags); setStats(ov); setAllPenguins(pgs); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedBox) { setBoxDetail(null); setHighlightObs(null); return; }
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
        // No scans at all — try chipped_here
        if (d.chipped_here?.length > 0) {
          setSelectedBird(d.chipped_here[0].peng_num);
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

  // Data entry page
  if (showEntry) {
    return (
      <div className="app">
        <header>
          <h1 className="logo clickable" onClick={() => { setShowEntry(false); }}>WildWatch</h1>
          <span className="sub">Tarakohe Penguin Colony</span>
          <span className="header-user">{userName}
            <button className="logout-btn" onClick={() => setShowChangePassword(true)}>Password</button>
            <button className="logout-btn" onClick={onLogout}>Logout</button>
          </span>
        </header>
        <DataEntryPage token={token} allPenguins={allPenguins} onBack={() => setShowEntry(false)} />
        {passwordDialog}
      </div>
    );
  }

  // Bird page - replaces everything (only when no box is selected)
  if (selectedBird && !selectedBox) {
    return (
      <div className="app">
        <header>
          <h1 className="logo clickable" onClick={() => { setSelectedBox(null); setSelectedBird(null); }}>WildWatch</h1>
          <span className="sub">Tarakohe Penguin Colony</span>
        </header>
        <div className="bird-page">
          <div className="page-header">
            <button className="page-back" onClick={() => { closeBird(); if (previousBox) { setSelectedBox(previousBox); setPreviousBox(null); } }}>&larr; {previousBox ? `Box ${previousBox}` : 'Overview'}</button>
            <div className="bird-nav">
              <button className="bird-nav-btn" disabled={!selectedBird || parseInt(selectedBird) <= 1} onClick={() => setSelectedBird(String(parseInt(selectedBird!) - 1))}>&lsaquo; Prev</button>
              <PenguinSearch penguins={allPenguins} search={penguinSearch} onSearchChange={setPenguinSearch} onBirdClick={(num) => { setSelectedBird(num); setPenguinSearch(''); }} />
              <button className="bird-nav-btn" disabled={!selectedBird || parseInt(selectedBird) >= allPenguins.length} onClick={() => setSelectedBird(String(parseInt(selectedBird!) + 1))}>Next &rsaquo;</button>
            </div>
          </div>
          {birdLoading ? <p className="muted">Loading bird data...</p> : birdData?.penguin ? (
            <BirdPage data={birdData} onBirdClick={openBird} token={token} canEdit={userRole !== 'viewer'}
              onBoxClick={(box: string) => { closeBird(); setSelectedBox(box); }}
              onSightingClick={(box: string, date: string) => { closeBird(); setSelectedBox(box); setHighlightObs(date); setScrollToObs(date); }} />
          ) : <p className="muted">Bird not found</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header>
        <h1 className="logo clickable" onClick={() => { setSelectedBox(null); setSelectedBird(null); }}>WildWatch</h1>
        <span className="sub">Tarakohe Penguin Colony</span>
        {stats && <span className="hstats">{stats.total_boxes} boxes &middot; {stats.season_observations} obs &middot; {stats.season_penguins} penguins this season</span>}
        <span className="header-user">
          <button className="logout-btn" onClick={() => setShowEntry(true)}>Enter data</button>
          {userName}
          <button className="logout-btn" onClick={() => setShowChangePassword(true)}>Password</button>
          <button className="logout-btn" onClick={onLogout}>Logout</button>
        </span>
      </header>

      {!selectedBox && (
        <>
          <div className="top-row">
            <ColonyMap boxTags={boxTags} selectedBox={selectedBox} onBoxSelect={setSelectedBox} />
            <StatsPanel boxTags={boxTags} selectedBox={selectedBox} stats={stats} />
          </div>
          <div className="search-section">
            <PenguinSearch penguins={allPenguins} search={penguinSearch} onSearchChange={setPenguinSearch} onBirdClick={openBird} />
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
              <button className="page-back" onClick={() => { setScrollToBox(selectedBox); setSelectedBox(null); }}>&larr; Overview</button>
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
                <AllScannedBirds observations={boxDetail.observations} onBirdClick={openBird} chippedHere={boxDetail.chipped_here} />
                {(boxDetail.chipped_here?.length ?? 0) > 0 && (
                  <div className="chipped-here">
                    <div className="muted">Chipped in this box: {boxDetail.chipped_here!.length}</div>
                    <div className="bird-row">
                      {boxDetail.chipped_here!.map((c: ChippedHere) => (
                        <span key={c.pit_id} className="bird-with-count">
                          <PenguinMini scan={{pit_id: c.pit_id, peng_num: c.peng_num, sex: c.sex, life_stage: c.life_stage, chip_date: c.chip_date, chipped_as_adult: c.chipped_as_adult, chick_size_code: c.chick_size_code}} onClick={() => openBird(c.peng_num)} observationDate={c.chip_date} />
                          <span className="scan-count">{c.chip_date?.slice(0,4)}{c.chip_by ? ` ${c.chip_by}` : ''}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : null}
          </div>

          {/* Bottom split: observations left, bird right */}
          {!detailLoading && boxDetail && (
          <div className="detail-split">
            <div className="detail-obs">
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

                return (<>
                  <h3 className="season-heading">{thisLabel} ({thisSeason.length})</h3>
                  {thisSeason.length === 0 && <p className="muted">No observations this season</p>}
                  {thisSeason.map((obs,i) => <ObsCard key={`t${i}`} obs={obs} onBirdClick={openBird} highlight={highlightObs !== null && obs.observation_time_utc === highlightObs} scrollTo={scrollToObs !== null && obs.observation_time_utc === scrollToObs} token={token} canEdit={userRole !== 'viewer'} allPenguins={allPenguins} />)}
                  {sortedPrev.map(([label, obs]) => (
                    <div key={label}>
                      <div className="season-divider"><hr/><span>{label} ({obs.length})</span><hr/></div>
                      {obs.map((o,i) => <ObsCard key={`${label}${i}`} obs={o} onBirdClick={openBird} highlight={highlightObs !== null && o.observation_time_utc === highlightObs} scrollTo={scrollToObs !== null && o.observation_time_utc === scrollToObs} token={token} canEdit={userRole !== 'viewer'} allPenguins={allPenguins} />)}
                    </div>
                  ))}
                </>);
              })()}
            </div>
            <div className="detail-bird">
              {birdData?.penguin ? (
                <BirdPage data={birdData} onBirdClick={openBird} token={token} canEdit={userRole !== 'viewer'}
                  onBoxClick={(box: string) => { setSelectedBird(null); setSelectedBox(box); }}
                  onSightingClick={(box: string, date: string) => { setSelectedBird(null); setSelectedBox(box); setHighlightObs(date); setScrollToObs(date); }}
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
function fmtDateTime(d:string) {
  return parseDate(d).toLocaleDateString('en-NZ',{day:'numeric',month:'short',year:'numeric',timeZone:'Pacific/Auckland'});
}
function fmtDateNZ(d:string) {
  return parseDate(d).toLocaleDateString('en-NZ',{day:'2-digit',month:'2-digit',year:'2-digit',timeZone:'Pacific/Auckland'});
}

export default App;
