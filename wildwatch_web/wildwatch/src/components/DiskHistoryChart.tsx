import { useEffect, useState, useMemo } from 'react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
} from 'recharts';

type Range = 'day' | 'week' | 'month' | 'year';

const RANGES: { key: Range; label: string }[] = [
  { key: 'year', label: '1 year' },
  { key: 'month', label: '1 month' },
  { key: 'week', label: '7 days' },
  { key: 'day', label: '1 day' },
];

const toGb = (mb: number) => mb / 1024;
const fmtGb = (mb: number) => `${toGb(mb).toFixed(1)} GB`;

// --- Linear descent detection ---
// Finds the longest recent segment where the data is dropping roughly linearly.
// Works backwards from the most recent point, expanding the window while R² > threshold.

interface LinearSegment {
  startIdx: number;
  endIdx: number;
  slope: number;       // MB per millisecond (raw) or MB per day-index (daily)
  intercept: number;
  r2: number;
  zeroTime: number;    // timestamp (raw) or day-index (daily) where extrapolation hits 0
  slopeMbPerMin: number;
  durationMin: number;
}

function linReg(xs: number[], ys: number[]) {
  const n = xs.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; syy += ys[i] * ys[i];
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const ssTot = syy - sy * sy / n;
  const ssRes = ys.reduce((s, y, i) => s + (y - (slope * xs[i] + intercept)) ** 2, 0);
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  return { slope, intercept, r2 };
}

function detectLinearDescent(
  points: any[],
  valueOf: (p: any) => number,
  timeOf: (p: any) => number, // ms timestamp for raw, day-index for daily
  minPoints = 4,
  r2Threshold = 0.95,
): LinearSegment | null {
  if (points.length < minPoints) return null;

  // First, find where the steep descent begins by walking backwards from the end.
  // Each consecutive pair must be dropping at a meaningful rate. Stop when we hit
  // a flat or rising segment.
  const end = points.length - 1;
  const endVal = valueOf(points[end]);
  const endT = timeOf(points[end]);

  // Compute the average drop rate over the last minPoints to set a threshold.
  // A point-to-point segment counts as "descending" if it drops at least 25%
  // of the average rate of the steepest minPoints window.
  let steepestRate = 0;
  if (points.length >= minPoints) {
    const tailDrop = valueOf(points[end - minPoints + 1]) - endVal;
    const tailSpan = endT - timeOf(points[end - minPoints + 1]);
    if (tailSpan > 0 && tailDrop > 0) steepestRate = tailDrop / tailSpan;
  }
  if (steepestRate <= 0) return null; // no descent in the tail

  const minRate = steepestRate * 0.25; // each segment must drop at ≥25% of tail rate

  // Walk backwards, requiring each step to be descending at minRate
  let descentStart = end;
  for (let i = end; i > 0; i--) {
    const drop = valueOf(points[i - 1]) - valueOf(points[i]);
    const dt = timeOf(points[i]) - timeOf(points[i - 1]);
    if (dt <= 0) break;
    const rate = drop / dt;
    if (rate < minRate) break; // this segment isn't dropping fast enough
    descentStart = i - 1;
  }

  const n = end - descentStart + 1;
  if (n < minPoints) return null;

  // Now fit a line to only the steep segment and check R²
  const xs: number[] = [], ys: number[] = [];
  for (let i = descentStart; i <= end; i++) {
    xs.push(timeOf(points[i]));
    ys.push(valueOf(points[i]));
  }
  const reg = linReg(xs, ys);
  if (!reg || reg.slope >= 0) return null;
  if (reg.r2 < r2Threshold) return null;

  const spanMs = timeOf(points[end]) - timeOf(points[descentStart]);
  const slopeMbPerMin = reg.slope * 60000;
  const durationMin = spanMs / 60000;
  const zeroTime = -reg.intercept / reg.slope;

  return {
    startIdx: descentStart,
    endIdx: end,
    slope: reg.slope,
    intercept: reg.intercept,
    r2: reg.r2,
    zeroTime,
    slopeMbPerMin,
    durationMin,
  };
}

function fmtTime(t: number) {
  return new Date(t).toLocaleTimeString('en-NZ', {
    timeZone: 'Pacific/Auckland', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function fmtDay(d: string) {
  // d is 'YYYY-MM-DD' (NZ local). Show as e.g. "14 Jun".
  const [, m, day] = d.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${parseInt(day, 10)} ${months[parseInt(m, 10) - 1]}`;
}

function fmtDateShort(t: number) {
  return new Date(t).toLocaleDateString('en-NZ', {
    timeZone: 'Pacific/Auckland', day: 'numeric', month: 'short',
  });
}

function fmtDateTime(t: number) {
  return new Date(t).toLocaleString('en-NZ', {
    timeZone: 'Pacific/Auckland', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

export function DiskHistoryChart({ token }: { token: string }) {
  const [range, setRange] = useState<Range>('day');
  const [data, setData] = useState<{ range: Range; daily: boolean; points: any[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/disk_history.php?range=${range}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        if (d.error) { setError(d.error); setData(null); }
        else setData({ range: d.range || range, daily: !!d.daily, points: d.points || [] });
      })
      .catch(e => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token, range]);

  const points = data?.points ?? [];
  const isDaily = data?.daily ?? false;
  // dRange tracks the dataset actually loaded (avoids a flicker if range changed mid-fetch).
  const dRange: Range = data?.range ?? range;
  // The value we plot: raw free space for day/week, the daily LOW for month/year.
  const valueOf = (p: any) => (isDaily ? p.min_mb : p.free_mb);
  const lowest = points.length ? Math.min(...points.map(valueOf)) : null;
  const lowestPoint = lowest != null ? points.find(p => valueOf(p) === lowest) : null;

  // --- Linear descent detection ---
  const timeOf = (p: any) => (isDaily ? 0 : p.t); // daily ranges don't use this path
  const descent = useMemo(() => {
    if (isDaily || points.length < 4) return null;
    return detectLinearDescent(points, valueOf, timeOf);
  }, [points, isDaily]);

  // Build chart data with an extra key for the highlighted descent segment and extrapolation
  const chartData = useMemo(() => {
    if (!descent) return points.map((p: any) => ({ ...p }));

    const enriched = points.map((p: any, i: number) => {
      const row: any = { ...p };
      if (i >= descent.startIdx && i <= descent.endIdx) {
        row.descent_mb = valueOf(p);
      }
      return row;
    });

    // Add extrapolation points: from the last real point to where the line hits zero.
    // The last descent point also gets extrap_mb so the dashed line connects seamlessly.
    const lastReal = points[descent.endIdx];
    const lastT = lastReal.t;
    if (descent.zeroTime > lastT) {
      enriched[descent.endIdx].extrap_mb = valueOf(lastReal);
      const steps = 2;
      for (let s = 1; s <= steps; s++) {
        const t = lastT + (descent.zeroTime - lastT) * (s / steps);
        const val = Math.max(0, descent.slope * t + descent.intercept);
        enriched.push({ t, extrap_mb: val });
      }
    }

    return enriched;
  }, [points, descent, isDaily]);

  // Axis ticks: daily ranges key off the 'YYYY-MM-DD' string; raw ranges off a
  // timestamp — show clock time for a single day, dates across a week.
  const xTick = isDaily
    ? (v: any) => fmtDay(String(v))
    : dRange === 'day' ? (v: any) => fmtTime(Number(v)) : (v: any) => fmtDateShort(Number(v));
  const tipLabel = isDaily
    ? (v: any) => fmtDay(String(v))
    : dRange === 'day' ? (v: any) => fmtTime(Number(v)) : (v: any) => fmtDateTime(Number(v));
  const lowestPrefix = isDaily ? 'Lowest daily free space' : dRange === 'day' ? 'Lowest in last 24h' : 'Lowest in last 7 days';
  const lowestWhen = (p: any) => isDaily ? ` on ${fmtDay(p.d)}` : dRange === 'day' ? ` at ${fmtTime(p.t)}` : ` at ${fmtDateTime(p.t)}`;

  return (
    <div className="admin-section">
      <h3>Server free space over time</h3>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
        {RANGES.map(r => (
          <button
            key={r.key}
            className="edit-btn"
            style={range === r.key ? { background: '#2196F3', color: '#fff', borderColor: '#2196F3' } : undefined}
            onClick={() => setRange(r.key)}
          >{r.label}</button>
        ))}
      </div>

      {loading && <p className="muted">Loading...</p>}
      {error && <p style={{ color: '#F44336' }}>Error: {error}</p>}
      {!loading && !error && points.length === 0 && (
        <p className="muted">No samples recorded yet. Data is collected every 15 minutes.</p>
      )}

      {!loading && !error && points.length > 0 && (
        <>
          {lowest != null && (
            <p className="muted" style={{ marginTop: 0 }}>
              {lowestPrefix}: <strong>{fmtGb(lowest)}</strong>
              {lowestPoint && lowestWhen(lowestPoint)}
            </p>
          )}
          {descent && (
            <div style={{ background: '#FFF3E0', border: '1px solid #FF9800', borderRadius: 6, padding: '8px 12px', marginBottom: 8, fontSize: 13 }}>
              <strong style={{ color: '#E65100' }}>⚠ Linear descent detected</strong>
              <div style={{ marginTop: 4, lineHeight: 1.6 }}>
                Dropping at <strong>{Math.abs(descent.slopeMbPerMin).toFixed(1)} MB/min</strong>
                {' '}({Math.abs(descent.slopeMbPerMin * 60 / 1024).toFixed(2)} GB/hr)
                {' '}over the last <strong>{descent.durationMin < 120 ? `${Math.round(descent.durationMin)} min` : `${(descent.durationMin / 60).toFixed(1)} hrs`}</strong>
                {' '}(R² = {descent.r2.toFixed(3)})
                <br />
                Hits zero at{' '}
                <strong style={{ color: '#D32F2F' }}>
                  {dRange === 'day' ? fmtTime(descent.zeroTime) : fmtDateTime(descent.zeroTime)}
                </strong>
                {' '}if this rate continues
              </div>
            </div>
          )}
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={chartData} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e8ecef" />
              <XAxis
                dataKey={isDaily ? 'd' : 't'}
                tickFormatter={xTick}
                type={isDaily ? 'category' : 'number'}
                domain={isDaily ? undefined : ['dataMin', 'dataMax']}
                scale={isDaily ? 'auto' : 'time'}
                minTickGap={28}
                tick={{ fontSize: 11 }}
              />
              <YAxis
                tickFormatter={(mb: number) => `${toGb(mb).toFixed(0)}`}
                domain={[0, 'auto']}
                width={36}
                tick={{ fontSize: 11 }}
                label={{ value: 'GB free', angle: -90, position: 'insideLeft', style: { fontSize: 11, fill: '#888' } }}
              />
              <Tooltip
                labelFormatter={tipLabel}
                formatter={(value: any, name: any) => {
                  const label = name === 'descent_mb' ? 'Descent' : name === 'extrap_mb' ? 'Projected' : name;
                  return [fmtGb(Number(value)), label];
                }}
                contentStyle={{ fontSize: 12 }}
              />
              {lowest != null && !descent && (
                <ReferenceLine y={lowest} stroke="#F44336" strokeDasharray="4 4" />
              )}
              {descent && (
                <ReferenceLine y={0} stroke="#D32F2F" strokeDasharray="4 4" />
              )}
              {isDaily ? (
                <Line type="monotone" dataKey="min_mb" name="Daily low" stroke="#2196F3" dot={{ r: 2 }} strokeWidth={2} isAnimationActive={false} />
              ) : (
                <Line type="monotone" dataKey="free_mb" name="Free" stroke="#2196F3" dot={false} strokeWidth={2} isAnimationActive={false} connectNulls={false} />
              )}
              {descent && (
                <>
                  <Line type="monotone" dataKey="descent_mb" name="Descent" stroke="#FF5722" dot={{ r: 2, fill: '#FF5722' }} strokeWidth={3} isAnimationActive={false} connectNulls={false} />
                  <Line type="linear" dataKey="extrap_mb" name="Projected" stroke="#D32F2F" dot={false} strokeWidth={2} strokeDasharray="6 4" isAnimationActive={false} connectNulls />
                </>
              )}
            </LineChart>
          </ResponsiveContainer>
          {isDaily && (
            <p className="muted" style={{ fontSize: 11 }}>
              Line shows each day's lowest free space. Hover a point for the day's range.
            </p>
          )}
        </>
      )}
    </div>
  );
}

export default DiskHistoryChart;
