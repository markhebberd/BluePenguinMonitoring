import { useEffect, useState } from 'react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
} from 'recharts';

type Range = 'day' | 'week' | 'month' | 'year';

type DayPoint = { t: number; free_mb: number };
type DailyPoint = { d: string; min_mb: number; max_mb: number; avg_mb: number };

const RANGES: { key: Range; label: string }[] = [
  { key: 'day', label: '1 day' },
  { key: 'week', label: '7 days' },
  { key: 'month', label: '1 month' },
  { key: 'year', label: '1 year' },
];

const toGb = (mb: number) => mb / 1024;
const fmtGb = (mb: number) => `${toGb(mb).toFixed(1)} GB`;

function fmtTime(t: number) {
  return new Date(t).toLocaleTimeString('en-NZ', {
    timeZone: 'Pacific/Auckland', hour: '2-digit', minute: '2-digit',
  });
}

function fmtDay(d: string) {
  // d is 'YYYY-MM-DD' (NZ local). Show as e.g. "14 Jun".
  const [, m, day] = d.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${parseInt(day, 10)} ${months[parseInt(m, 10) - 1]}`;
}

export function DiskHistoryChart({ token }: { token: string }) {
  const [range, setRange] = useState<Range>('day');
  const [data, setData] = useState<{ daily: boolean; points: any[] } | null>(null);
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
        else setData({ daily: !!d.daily, points: d.points || [] });
      })
      .catch(e => { if (!cancelled) setError(String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token, range]);

  const points = data?.points ?? [];
  const isDaily = data?.daily ?? false;
  // The value we plot: raw free space for "day", the daily LOW for longer ranges.
  const valueOf = (p: any) => (isDaily ? p.min_mb : p.free_mb);
  const lowest = points.length ? Math.min(...points.map(valueOf)) : null;
  const lowestPoint = lowest != null ? points.find(p => valueOf(p) === lowest) : null;

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
              {isDaily ? 'Lowest daily free space' : 'Lowest in last 24h'}: <strong>{fmtGb(lowest)}</strong>
              {lowestPoint && (isDaily ? ` on ${fmtDay(lowestPoint.d)}` : ` at ${fmtTime(lowestPoint.t)}`)}
            </p>
          )}
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={points} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e8ecef" />
              <XAxis
                dataKey={isDaily ? 'd' : 't'}
                tickFormatter={isDaily ? fmtDay : fmtTime}
                type={isDaily ? 'category' : 'number'}
                domain={isDaily ? undefined : ['dataMin', 'dataMax']}
                scale={isDaily ? 'auto' : 'time'}
                minTickGap={28}
                tick={{ fontSize: 11 }}
              />
              <YAxis
                tickFormatter={(mb: number) => `${toGb(mb).toFixed(0)}`}
                domain={['auto', 'auto']}
                width={36}
                tick={{ fontSize: 11 }}
                label={{ value: 'GB free', angle: -90, position: 'insideLeft', style: { fontSize: 11, fill: '#888' } }}
              />
              <Tooltip
                labelFormatter={(v: any) => (isDaily ? fmtDay(String(v)) : fmtTime(Number(v)))}
                formatter={(value: any, name: string) => [fmtGb(Number(value)), name]}
                contentStyle={{ fontSize: 12 }}
              />
              {lowest != null && (
                <ReferenceLine y={lowest} stroke="#F44336" strokeDasharray="4 4" />
              )}
              {isDaily ? (
                <Line type="monotone" dataKey="min_mb" name="Daily low" stroke="#2196F3" dot={{ r: 2 }} strokeWidth={2} isAnimationActive={false} />
              ) : (
                <Line type="monotone" dataKey="free_mb" name="Free" stroke="#2196F3" dot={false} strokeWidth={2} isAnimationActive={false} />
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
