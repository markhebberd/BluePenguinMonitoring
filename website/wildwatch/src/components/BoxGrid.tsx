import type { BoxTag } from '../types';

const STATUS_COLORS: Record<string,string> = {
  UNL:'#FDD835', POT:'#FF9800', CON:'#E53935', BR:'#4CAF50',
  ABN:'#9E9E9E', DCM:'#795548', NO:'#E0E0E0', '':'#F5F5F5',
};

interface BoxInfo { s: string; a: number; e: number; c: number; }

interface BoxGridProps {
  boxTags: Record<string, BoxTag>;
  selectedBox: string | null;
  onBoxSelect: (boxId: string) => void;
  boxInfo?: Record<string, BoxInfo>;
}

export function BoxGrid({ boxTags, selectedBox, onBoxSelect, boxInfo }: BoxGridProps) {
  // Show all boxes from both tags and observations
  const allIds = new Set([...Object.keys(boxTags), ...Object.keys(boxInfo || {})]);
  const sorted = Array.from(allIds).sort((a, b) => {
    const na = parseInt(a), nb = parseInt(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a.localeCompare(b);
  });

  return (
    <div className="box-grid">
      <h3>Nest Boxes ({sorted.length})</h3>
      <div className="grid">
        {sorted.map(boxId => {
          const info = boxInfo?.[boxId];
          const status = info?.s || '';
          const bg = STATUS_COLORS[status] || STATUS_COLORS[''];
          const adults = info?.a || 0;
          const eggs = info?.e || 0;
          const chicks = info?.c || 0;
          const darkText = status === 'CON' || status === 'DCM';

          return (
            <div
              key={boxId}
              className={`box-card ${boxId === selectedBox ? 'selected' : ''}`}
              style={{ backgroundColor: bg, color: darkText ? '#fff' : undefined }}
              onClick={() => onBoxSelect(boxId)}
            >
              <div className="box-number">{boxId}</div>
              {(adults > 0 || eggs > 0 || chicks > 0) && (
                <div className="box-icons">
                  {'\uD83D\uDC27'.repeat(Math.min(adults, 4))}
                  {'\uD83E\uDD5A'.repeat(Math.min(eggs, 4))}
                  {'\uD83D\uDC23'.repeat(Math.min(chicks, 4))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
