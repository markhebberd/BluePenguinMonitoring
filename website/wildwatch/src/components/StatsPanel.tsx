import type { BoxTag } from '../types';

interface Stats {
  total_boxes: number;
  season_observations: number;
  season_penguins: number;
  season_start: string;
  status_counts: Record<string, number>;
  total_eggs: number;
  total_chicks: number;
}

interface StatsPanelProps {
  boxTags: Record<string, BoxTag>;
  selectedBox: string | null;
  stats: Stats | null;
}

const STATUS_LABELS: Record<string, string> = {
  BR: 'Breeding', CON: 'Confident', POT: 'Potential', UNL: 'Unlikely', ABN: 'Abandoned', DCM: 'DCM',
};

export function StatsPanel({ boxTags, selectedBox, stats }: StatsPanelProps) {
  const selected = selectedBox ? boxTags[selectedBox] : null;
  if (!stats) return null;

  const statusCards = Object.entries(stats.status_counts || {})
    .filter(([, count]) => count > 0)
    .filter(([code]) => code !== 'NO')
    .map(([code, count]) => ({ code, count, label: STATUS_LABELS[code] || code }));

  return (
    <div className="stats-panel">
      <h3>Colony Stats (since 1 Apr)</h3>
      <div className="stats-grid">
        <div className="stat">
          <span className="stat-value">{stats.season_observations}</span>
          <span className="stat-label">Box observations</span>
        </div>
        <div className="stat">
          <span className="stat-value">{stats.season_penguins}</span>
          <span className="stat-label">Penguins scanned</span>
        </div>
        {statusCards.map(({ code, count, label }) => (
          <div key={code} className="stat">
            <span className="stat-value">{count}</span>
            <span className="stat-label">{label}</span>
          </div>
        ))}
        {stats.total_eggs > 0 && (
          <div className="stat">
            <span className="stat-value">{stats.total_eggs}</span>
            <span className="stat-label">Eggs</span>
          </div>
        )}
        {stats.total_chicks > 0 && (
          <div className="stat">
            <span className="stat-value">{stats.total_chicks}</span>
            <span className="stat-label">Chicks</span>
          </div>
        )}
      </div>

      {selected && (
        <div className="selected-box-detail">
          <h4>Box {selectedBox}</h4>
          <table>
            <tbody>
              <tr><td>Tag</td><td>{selected.TagNumber}</td></tr>
              <tr><td>Scanned</td><td>{new Date(selected.ScanTimeUTC).toLocaleString('en-NZ')}</td></tr>
              <tr><td>Latitude</td><td>{selected.Latitude.toFixed(6)}</td></tr>
              <tr><td>Longitude</td><td>{selected.Longitude.toFixed(6)}</td></tr>
              <tr><td>Accuracy</td><td>{selected.Accuracy > 0 ? `${selected.Accuracy.toFixed(1)}m` : 'N/A'}</td></tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
