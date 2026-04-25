import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchBoxTags, fetchBoxDetail, fetchOverview, fetchBirdDetail, fetchAllPenguins } from './api/boxtags';
import { getSeasonStart, getSeasonLabel } from './config';
import { ColonyMap } from './components/ColonyMap';
import { BoxGrid } from './components/BoxGrid';
import { StatsPanel } from './components/StatsPanel';
import type { BoxTag } from './types';
import './App.css';

interface Scan { tag_number:string; sex:string|null; life_stage:string|null; chip_date:string|null; chipped_as_adult:number|null; }
interface Observation {
  observation_time_utc:string; monitor_filename:string;
  adults:number; eggs:number; chicks:number;
  breeding_status:string|null; gate_status:string|null; notes:string;
  scans: Scan[];
}
interface BoxDetailData {
  location: { location_name:string; rfid_tag_number:string|null; } | null;
  observations: Observation[];
}

const STATUS_COLORS: Record<string,string> = {
  UNL:'#FDD835', POT:'#FF9800', CON:'#E53935', BR:'#4CAF50',
  ABN:'#9E9E9E', DCM:'#795548', NO:'#E0E0E0', '':'#F5F5F5',
};

const STATUS_NAMES: Record<string,string> = {
  BR:'Breeding', CON:'Confident', POT:'Potential', UNL:'Unlikely',
  ABN:'Abandoned', DCM:'DCM',
};

function BreedingStatusBar({ observations }: { observations: Observation[] }) {
  // Timeline covers last 12 months
  const now = new Date();
  const start = new Date(now);
  start.setFullYear(start.getFullYear() - 1);
  const totalMs = now.getTime() - start.getTime();

  // Sort observations oldest first
  const sorted = [...observations].sort(
    (a, b) => new Date(a.observation_time_utc).getTime() - new Date(b.observation_time_utc).getTime()
  );

  // Build status changes: only explicit non-empty status values count.
  // A null/blank breeding_status means "no change" - previous status persists.
  interface StatusChange { time: number; status: string; }
  const changes: StatusChange[] = [];
  let runningStatus = '';

  for (const obs of sorted) {
    const s = obs.breeding_status;
    if (s && s !== runningStatus) {
      runningStatus = s;
      changes.push({ time: new Date(obs.observation_time_utc).getTime(), status: s });
    }
  }

  // Build segments from changes
  const segments: { startPct: number; endPct: number; status: string }[] = [];
  for (let i = 0; i < changes.length; i++) {
    const segStart = Math.max(changes[i].time, start.getTime());
    const segEnd = (i + 1 < changes.length) ? changes[i + 1].time : now.getTime();
    if (segEnd <= start.getTime()) continue; // entirely before window
    const startPct = ((segStart - start.getTime()) / totalMs) * 100;
    const endPct = Math.min(100, ((segEnd - start.getTime()) / totalMs) * 100);
    segments.push({ startPct, endPct, status: changes[i].status });
  }

  // Month labels
  const months: { label: string; pct: number }[] = [];
  for (let m = 0; m < 12; m++) {
    const d = new Date(start);
    d.setMonth(d.getMonth() + m);
    d.setDate(1);
    if (d.getTime() >= start.getTime() && d.getTime() <= now.getTime()) {
      const pct = ((d.getTime() - start.getTime()) / totalMs) * 100;
      months.push({ label: d.toLocaleDateString('en-NZ', { month: 'short' }), pct });
    }
  }

  // Observation markers (dots on the bar)
  const markers = sorted
    .filter(o => new Date(o.observation_time_utc).getTime() >= start.getTime())
    .map(o => {
      const pct = ((new Date(o.observation_time_utc).getTime() - start.getTime()) / totalMs) * 100;
      return { pct, status: o.breeding_status || '' };
    });

  return (
    <div className="status-bar-wrap">
      <div className="status-bar-labels">
        {months.map((m, i) => (
          <span key={i} className="month-label" style={{ left: `${m.pct}%` }}>{m.label}</span>
        ))}
      </div>
      <div className="status-bar">
        {segments.map((seg, i) => (
          <div
            key={i}
            className="status-segment"
            style={{
              left: `${seg.startPct}%`,
              width: `${seg.endPct - seg.startPct}%`,
              backgroundColor: STATUS_COLORS[seg.status] || STATUS_COLORS[''],
            }}
            title={`${STATUS_NAMES[seg.status] || 'No status'}`}
          />
        ))}
        {markers.map((m, i) => (
          <div key={i} className="status-marker" style={{ left: `${m.pct}%` }} title="Monitoring visit" />
        ))}
      </div>
      <div className="status-bar-legend">
        {Object.entries(STATUS_NAMES).map(([k, v]) => (
          <span key={k}><i style={{ background: STATUS_COLORS[k] }} />{v}</span>
        ))}
      </div>
    </div>
  );
}

function calcChipAge(chipDate: string | null): { years: number; months: number } | null {
  if (!chipDate) return null;
  const chip = new Date(chipDate);
  if (isNaN(chip.getTime())) return null;
  const now = new Date();
  let years = now.getFullYear() - chip.getFullYear();
  let months = now.getMonth() - chip.getMonth();
  if (months < 0) { years--; months += 12; }
  return { years, months };
}

function fmtChipAge(chipDate: string | null, chippedAsAdult: boolean): string | null {
  const age = calcChipAge(chipDate);
  if (!age) return null;
  const parts = [];
  if (age.years > 0) parts.push(`${age.years}yr`);
  if (age.months > 0 || age.years === 0) parts.push(`${age.months}mo`);
  const timeStr = parts.join(' ');
  if (chippedAsAdult) return `chipped ${timeStr} ago`;
  return `${timeStr} old`;
}

function PenguinBadge({ scan, onClick }: { scan: Scan; onClick: () => void }) {
  const sex = (scan.sex || '').toUpperCase();
  const sexIcon = sex === 'F' ? '\u2640' : sex === 'M' ? '\u2642' : '';
  const isChick = scan.life_stage === 'Chick' || (scan.chipped_as_adult === 0 && scan.chip_date);
  const sexClass = isChick && !sex ? 'chick' : sex === 'F' ? 'f' : sex === 'M' ? 'm' : '';
  const ageStr = fmtChipAge(scan.chip_date, !!scan.chipped_as_adult);

  return (
    <span className={`scan clickable ${sexClass}`} onClick={onClick}>
      {sexIcon && <span className="sex-icon">{sexIcon}</span>}
      {scan.tag_number.slice(-8)}
      {ageStr && <span className="age-info">{ageStr}</span>}
    </span>
  );
}

function AllScannedBirds({ observations, onBirdClick }: { observations: Observation[]; onBirdClick: (tag:string)=>void }) {
  // Group birds by season
  const seasonBirds = new Map<string, Map<string, Scan & { lastSeen: string }>>();

  for (const obs of observations) {
    const obsDate = new Date(obs.observation_time_utc);
    const label = getSeasonLabel(obsDate);
    if (!seasonBirds.has(label)) seasonBirds.set(label, new Map());
    const birdMap = seasonBirds.get(label)!;

    for (const scan of obs.scans) {
      const key = scan.tag_number.slice(-8);
      const existing = birdMap.get(key);
      if (!existing || obs.observation_time_utc > existing.lastSeen) {
        birdMap.set(key, { ...scan, lastSeen: obs.observation_time_utc });
      }
    }
  }

  // Sort seasons newest first
  const seasons = Array.from(seasonBirds.entries())
    .sort((a, b) => b[0].localeCompare(a[0]));

  if (seasons.every(([, m]) => m.size === 0)) return null;

  return (
    <div className="all-birds">
      {seasons.map(([label, birdMap]) => {
        const birds = Array.from(birdMap.values()).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
        if (birds.length === 0) return null;
        return (
          <div key={label} className="season-birds">
            <div className="muted">{label}: {birds.length} bird{birds.length !== 1 ? 's' : ''}</div>
            <div className="bird-row">
              {birds.map(b => (
                <PenguinBadge key={b.tag_number.slice(-8)} scan={b} onClick={() => onBirdClick(b.tag_number)} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ObsCard({ obs, onBirdClick, highlight }: { obs: Observation; onBirdClick?: (tag:string)=>void; highlight?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlight && ref.current) {
      ref.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [highlight]);
  return (
    <div ref={ref} className={`obs-card ${highlight ? 'highlighted' : ''}`}>
      <div className="obs-top">
        <b>{fmtDateTime(obs.observation_time_utc)}</b>
        <span className="muted small">{obs.monitor_filename}</span>
      </div>
      <div className="obs-nums">
        {obs.adults > 0 && <span>{'\uD83D\uDC27'.repeat(Math.min(obs.adults, 6))}</span>}
        {obs.eggs > 0 && <span>{'\uD83E\uDD5A'.repeat(Math.min(obs.eggs, 6))}</span>}
        {obs.chicks > 0 && <span>{'\uD83D\uDC23'.repeat(Math.min(obs.chicks, 6))}</span>}
        {obs.breeding_status && <span className="badge" style={{background:STATUS_COLORS[obs.breeding_status]||'#ccc'}}>{obs.breeding_status}</span>}
        {obs.gate_status && <span className="gate">{obs.gate_status}</span>}
      </div>
      {obs.notes && <div className="obs-notes">{obs.notes}</div>}
      {obs.scans.length>0 && (
        <div className="scans">
          {obs.scans.map((s,j) => (
            <PenguinBadge key={j} scan={s} onClick={() => onBirdClick?.(s.tag_number)} />
          ))}
        </div>
      )}
    </div>
  );
}

function BirdPage({ data, onBirdClick, onBoxClick, onSightingClick }: { data: any; onBirdClick: (tag:string)=>void; onBoxClick: (box:string)=>void; onSightingClick: (box:string, date:string)=>void }) {
  const p = data.penguin;
  const scans: any[] = data.scans || [];
  const biometrics: any[] = data.biometrics || [];
  const partners: any[] = data.partners || [];
  const breedingStats: any[] = data.breeding_stats || [];

  const sexColor = (p.sex||'').toUpperCase() === 'F' ? '#FFE4E1' : (p.sex||'').toUpperCase() === 'M' ? '#E6F3FF' : '#f5f5f5';
  const isAdult = !!p.chipped_as_adult || (p.chip_as||'').toLowerCase() === 'adult';
  const ageStr = fmtChipAge(p.chip_date, isAdult);
  const boxes = Array.from(new Set(scans.map((s: any) => s.box_name)));

  return (
    <div className="bird-detail">
      <div className="bird-header" style={{ borderLeftColor: sexColor === '#f5f5f5' ? '#2196F3' : sexColor }}>
        <h2>Penguin {p.tag_number.slice(-8)}</h2>
        <div className="bird-meta">
          {p.sex && <span className="bird-badge" style={{ background: sexColor }}>{p.sex === 'F' ? 'Female' : p.sex === 'M' ? 'Male' : p.sex}</span>}
          {p.life_stage && <span className="bird-badge">{p.life_stage}</span>}
          {ageStr && <span className="bird-badge">{ageStr}</span>}
          {p.chip_date && <span className="muted">Chipped: {p.chip_date}</span>}
          {p.vid_for_scanner && <span className="muted">VID: {p.vid_for_scanner}</span>}
        </div>
        <div className="muted">Full tag: {p.tag_number}</div>
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
                {bs.max_eggs > 0 && <span>{'\uD83E\uDD5A'.repeat(Math.min(bs.max_eggs,4))} max</span>}
                {bs.max_chicks > 0 && <span>{'\uD83D\uDC23'.repeat(Math.min(bs.max_chicks,4))} max</span>}
                {bs.statuses.map((s:string) => <span key={s} className="badge" style={{background:STATUS_COLORS[s]||'#ccc'}}>{s}</span>)}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Locations */}
      <div className="bird-section">
        <h3>Seen in {boxes.length} box{boxes.length !== 1 ? 'es' : ''}</h3>
        <div className="bird-row">
          {boxes.map((b: string) => (
            <span key={b} className="bird-chip clickable" onClick={() => onBoxClick(b)}>Box {b}</span>
          ))}
        </div>
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

      {/* Biometrics */}
      {biometrics.length > 0 && (
        <div className="bird-section">
          <h3>Biometric data</h3>
          {biometrics.map((b: any, i: number) => (
            <div key={i} className="obs-card">
              <b>{b.observation_date}</b>
              {b.weight && <span> Weight: {b.weight}g</span>}
              {b.left_flipper_length && <span> Flipper L: {b.left_flipper_length}mm</span>}
              {b.right_flipper_length && <span> Flipper R: {b.right_flipper_length}mm</span>}
              {b.body_length && <span> Body: {b.body_length}mm</span>}
              {b.notes && <div className="obs-notes">{b.notes}</div>}
            </div>
          ))}
        </div>
      )}

      {/* Partners */}
      {partners.length > 0 && (
        <div className="bird-section">
          <h3>Partners ({partners.length})</h3>
          <p className="muted">Birds scanned in the same box at the same time</p>
          {partners.map((pt: any) => (
            <div key={pt.tag} className="partner-card">
              <div className="partner-head">
                <span className={`bird-chip clickable ${(pt.sex||'').toUpperCase()==='F'?'f':(pt.sex||'').toUpperCase()==='M'?'m':''}`}
                      onClick={() => onBirdClick(pt.tag)}>
                  {pt.tag}{pt.sex ? ` ${pt.sex}` : ''}
                </span>
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
    ? penguins.filter(p => p.tag_number.includes(search))
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
            const sex = (p.sex || '').toUpperCase();
            const cls = p.life_stage === 'Chick' ? 'chick' : sex === 'F' ? 'f' : sex === 'M' ? 'm' : '';
            const age = fmtChipAge(p.chip_date, !!p.chipped_as_adult);
            return (
              <div key={p.tag_number} className={`penguin-result clickable ${cls}`} onClick={() => { onBirdClick(p.tag_number); onSearchChange(''); }}>
                <span className="pr-tag">
                  {sex === 'F' ? '\u2640 ' : sex === 'M' ? '\u2642 ' : ''}{p.tag_number}
                </span>
                <span className="pr-meta">
                  {age && <span className="pr-age">{age}</span>}
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

function App() {
  const [boxTags, setBoxTags] = useState<Record<string, BoxTag>>({});
  const [stats, setStats] = useState<any>(null);
  const [selectedBox, setSelectedBox] = useState<string|null>(null);
  const [boxDetail, setBoxDetail] = useState<BoxDetailData|null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedBird, setSelectedBird] = useState<string|null>(null);
  const [birdData, setBirdData] = useState<any>(null);
  const [birdLoading, setBirdLoading] = useState(false);
  const [highlightObs, setHighlightObs] = useState<string|null>(null);
  const [allPenguins, setAllPenguins] = useState<any[]>([]);
  const [penguinSearch, setPenguinSearch] = useState('');

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
      // Auto-open most recently scanned bird in this box
      const allScans: {tag:string; time:string}[] = [];
      for (const obs of (d.observations || [])) {
        for (const s of (obs.scans || [])) {
          allScans.push({ tag: s.tag_number.slice(-8), time: obs.observation_time_utc });
        }
      }
      if (allScans.length > 0) {
        allScans.sort((a,b) => b.time.localeCompare(a.time));
        setSelectedBird(allScans[0].tag);
      } else {
        setSelectedBird(null);
      }
    });
  }, [selectedBox]);

  useEffect(() => {
    if (!selectedBird) { setBirdData(null); return; }
    setBirdLoading(true);
    fetchBirdDetail(selectedBird).then(d => { setBirdData(d); setBirdLoading(false); });
  }, [selectedBird]);

  const openBird = (tag: string) => {
    setSelectedBird(tag.slice(-8));
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

  // Bird page - replaces everything (only when no box is selected)
  if (selectedBird && !selectedBox) {
    return (
      <div className="app">
        <header>
          <h1 className="logo clickable" onClick={() => { setSelectedBox(null); setSelectedBird(null); }}>WildWatch</h1>
          <span className="sub">Tarakohe Penguin Colony</span>
        </header>
        <div className="bird-page">
          <button className="back-btn" onClick={closeBird}>&larr; Back</button>
          {birdLoading ? <p className="muted">Loading bird data...</p> : birdData?.penguin ? (
            <BirdPage data={birdData} onBirdClick={openBird}
              onBoxClick={(box: string) => { closeBird(); setSelectedBox(box); }}
              onSightingClick={(box: string, date: string) => { closeBird(); setSelectedBox(box); setHighlightObs(date); }} />
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
          <BoxGrid boxTags={boxTags} selectedBox={selectedBox} onBoxSelect={setSelectedBox} boxInfo={stats?.box_info} />
        </div>

        {/* Box detail */}
        {selectedBox && (
        <div className="detail-area">
          {/* Header + status bar full width */}
          <div className="detail-full">
            <div className="detail-head">
              <h2>Box {selectedBox}</h2>
              <button onClick={() => setSelectedBox(null)}>&times;</button>
            </div>
            {detailLoading ? <p className="muted">Loading...</p> : boxDetail ? (
              <>
                {boxDetail.location?.rfid_tag_number && <div className="tag-info">Tag: {boxDetail.location.rfid_tag_number.slice(-8)}</div>}
                <BreedingStatusBar observations={boxDetail.observations} />
                <AllScannedBirds observations={boxDetail.observations} onBirdClick={openBird} />
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
                  const label = getSeasonLabel(new Date(obs.observation_time_utc));
                  if (!prevSeasons.has(label)) prevSeasons.set(label, []);
                  prevSeasons.get(label)!.push(obs);
                }
                const sortedPrev = Array.from(prevSeasons.entries()).sort((a, b) => b[0].localeCompare(a[0]));

                return (<>
                  <h3 className="season-heading">{thisLabel} ({thisSeason.length})</h3>
                  {thisSeason.length === 0 && <p className="muted">No observations this season</p>}
                  {thisSeason.map((obs,i) => <ObsCard key={`t${i}`} obs={obs} onBirdClick={openBird} highlight={highlightObs !== null && obs.observation_time_utc === highlightObs} />)}
                  {sortedPrev.map(([label, obs]) => (
                    <div key={label}>
                      <div className="season-divider"><hr/><span>{label} ({obs.length})</span><hr/></div>
                      {obs.map((o,i) => <ObsCard key={`${label}${i}`} obs={o} onBirdClick={openBird} highlight={highlightObs !== null && o.observation_time_utc === highlightObs} />)}
                    </div>
                  ))}
                </>);
              })()}
            </div>
            <div className="detail-bird">
              {birdData?.penguin ? (
                <BirdPage data={birdData} onBirdClick={openBird}
                  onBoxClick={(box: string) => { setSelectedBird(null); setSelectedBox(box); }}
                  onSightingClick={(box: string, date: string) => { setSelectedBird(null); setSelectedBox(box); setHighlightObs(date); }} />
              ) : birdLoading ? <p className="muted">Loading bird...</p> : <p className="muted">Select a bird</p>}
            </div>
          </div>
          )}
        </div>
        )}
      </div>
    </div>
  );
}

function fmtDateTime(d:string) { return new Date(d).toLocaleDateString('en-NZ',{day:'numeric',month:'short',year:'numeric'}); }

export default App;
