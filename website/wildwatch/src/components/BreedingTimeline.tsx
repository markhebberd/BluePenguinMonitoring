import { useMemo } from 'react';

interface MonitorSession {
  date: string;
  filename: string;
  boxes: Record<string, {
    adults: number;
    eggs: number;
    chicks: number;
    breeding_status: string | null;
    gate_status: string | null;
    notes: string;
  }>;
}

interface BreedingTimelineProps {
  monitors: MonitorSession[];
  onBoxSelect: (boxName: string) => void;
  selectedBox: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  'BR': '#4CAF50',
  'CON': '#8BC34A',
  'POT': '#FF9800',
  'UNL': '#9E9E9E',
  'NO': '#BDBDBD',
  'ABN': '#F44336',
  'DCM': '#795548',
  '': '#E0E0E0',
};

const STATUS_LABELS: Record<string, string> = {
  'BR': 'Breeding',
  'CON': 'Confident',
  'POT': 'Potential',
  'UNL': 'Unlikely',
  'NO': 'No data',
  'ABN': 'Abandoned',
  'DCM': 'DCM',
};

function getStatusColor(status: string | null): string {
  return STATUS_COLORS[status || ''] || STATUS_COLORS[''];
}

export function BreedingTimeline({ monitors, onBoxSelect, selectedBox }: BreedingTimelineProps) {
  // Filter to monitors from April 1st onwards, sorted by date
  const filteredMonitors = useMemo(() => {
    return monitors
      .filter(m => m.date >= '2025-04-01')
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [monitors]);

  // Get all unique box names across all monitors, sorted numerically
  const allBoxNames = useMemo(() => {
    const names = new Set<string>();
    filteredMonitors.forEach(m => {
      Object.keys(m.boxes).forEach(n => names.add(n));
    });
    return Array.from(names).sort((a, b) => {
      const na = parseInt(a), nb = parseInt(b);
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a.localeCompare(b);
    });
  }, [filteredMonitors]);

  if (filteredMonitors.length === 0) {
    return <div className="timeline-empty">No monitoring data available</div>;
  }

  // Format date for column header
  const formatDate = (d: string) => {
    const date = new Date(d);
    return `${date.getDate()}/${date.getMonth() + 1}`;
  };

  const cellWidth = 36;
  const labelWidth = 60;
  const headerHeight = 50;
  const rowHeight = 24;

  return (
    <div className="breeding-timeline">
      <h3>Breeding Status Timeline</h3>

      {/* Legend */}
      <div className="timeline-legend">
        {Object.entries(STATUS_LABELS).map(([code, label]) => (
          <span key={code} className="legend-item">
            <span className="legend-swatch" style={{ backgroundColor: STATUS_COLORS[code] }} />
            {label}
          </span>
        ))}
        <span className="legend-item">
          <span className="legend-swatch egg-swatch" />
          Eggs
        </span>
        <span className="legend-item">
          <span className="legend-swatch chick-swatch" />
          Chicks
        </span>
      </div>

      <div className="timeline-scroll">
        <div className="timeline-table" style={{ minWidth: labelWidth + filteredMonitors.length * cellWidth }}>
          {/* Header row with dates */}
          <div className="timeline-header" style={{ height: headerHeight }}>
            <div className="timeline-label-cell" style={{ width: labelWidth }}>Box</div>
            {filteredMonitors.map((m, i) => (
              <div
                key={i}
                className="timeline-date-cell"
                style={{ width: cellWidth }}
                title={`${m.date} - ${m.filename}`}
              >
                <span className="date-text">{formatDate(m.date)}</span>
              </div>
            ))}
          </div>

          {/* Data rows - one per box */}
          {allBoxNames.map(boxName => (
            <div
              key={boxName}
              className={`timeline-row ${boxName === selectedBox ? 'selected' : ''}`}
              onClick={() => onBoxSelect(boxName)}
              style={{ height: rowHeight }}
            >
              <div className="timeline-label-cell" style={{ width: labelWidth }}>
                {boxName}
              </div>
              {filteredMonitors.map((m, i) => {
                const box = m.boxes[boxName];
                if (!box) {
                  return <div key={i} className="timeline-cell empty" style={{ width: cellWidth }} />;
                }

                const hasEggs = box.eggs > 0;
                const hasChicks = box.chicks > 0;
                const status = box.breeding_status || '';

                return (
                  <div
                    key={i}
                    className="timeline-cell"
                    style={{
                      width: cellWidth,
                      backgroundColor: getStatusColor(status),
                    }}
                    title={`Box ${boxName} - ${m.date}\n${box.adults}A ${box.eggs}E ${box.chicks}C\n${status || 'no status'}${box.notes ? '\n' + box.notes : ''}`}
                  >
                    {hasEggs && <span className="cell-egg">{box.eggs}</span>}
                    {hasChicks && <span className="cell-chick">{box.chicks}</span>}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
