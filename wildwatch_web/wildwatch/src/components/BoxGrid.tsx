import { useEffect, useRef, useState } from 'react';
import type { BoxTag } from '../types';

const STATUS_COLORS: Record<string,string> = {
  NO:'#E0E0E0', UNL:'#FFF9C4', POT:'#FFF176', CON:'#FFD54F',
  BR:'#66BB6A', I:'#A5D6A7', G:'#4CAF50', PG:'#2E7D32',
  MOULT:'#42A5F5', ABN:'#F44336', DCM:'#BCAAA4', '':'#F5F5F5',
};

interface BoxInfo { s: string; a: number; e: number; c: number; }

interface BoxGridProps {
  boxTags: Record<string, BoxTag>;
  selectedBox: string | null;
  onBoxSelect: (boxId: string) => void;
  boxInfo?: Record<string, BoxInfo>;
  scrollToBox?: string | null;
  boxNames?: string[];
}

export function BoxGrid({ boxTags, selectedBox, onBoxSelect, boxInfo, scrollToBox, boxNames }: BoxGridProps) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [flashBox, setFlashBox] = useState<string|null>(null);
  // Sidebar mode (a box is open) can collapse to a single narrow column via the title.
  const sidebar = selectedBox !== null;
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (scrollToBox && gridRef.current) {
      const el = gridRef.current.querySelector(`[data-box="${scrollToBox}"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setFlashBox(scrollToBox);
        const timer = setTimeout(() => setFlashBox(null), 1500);
        return () => clearTimeout(timer);
      }
    }
  }, [scrollToBox]);
  // Show all of the colony's boxes — tagged, observed, and any defined-but-empty ones.
  const allIds = new Set([...Object.keys(boxTags), ...Object.keys(boxInfo || {}), ...(boxNames || [])]);
  const sorted = Array.from(allIds).sort((a, b) => {
    const na = parseInt(a), nb = parseInt(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a.localeCompare(b);
  });

  return (
    <div className={`box-grid${sidebar && collapsed ? ' collapsed' : ''}`}>
      <h3 className={sidebar ? 'clickable' : undefined} onClick={sidebar ? () => setCollapsed(c => !c) : undefined}>
        {sidebar && collapsed ? 'Nests' : `Nest Boxes (${sorted.length})`}{sidebar ? (collapsed ? ' ▸' : ' ▾') : ''}
      </h3>
      <div className="grid" ref={gridRef}>
        {sorted.map(boxId => {
          const info = boxInfo?.[boxId];
          const status = info?.s || '';
          const bg = STATUS_COLORS[status] || STATUS_COLORS[''];
          const adults = info?.a || 0;
          const eggs = info?.e || 0;
          const chicks = info?.c || 0;
          const lightBg = ['NO','UNL','POT','CON','I','','BR'].includes(status);
          const darkText = !lightBg;

          return (
            <a
              key={boxId}
              data-box={boxId}
              className={`box-card ${boxId === selectedBox ? 'selected' : ''} ${boxId === flashBox ? 'flash-highlight' : ''}`}
              style={{ backgroundColor: sidebar ? `${bg}80` : bg, color: darkText ? '#fff' : undefined }}
              href={`/box/${boxId}`}
              onClick={e => { if (e.ctrlKey || e.metaKey) return; e.preventDefault(); onBoxSelect(boxId); }}
            >
              <div className="box-number">{boxId}</div>
              {(adults > 0 || eggs > 0 || chicks > 0) && (
                <div className="box-icons">
                  {'\uD83D\uDC27'.repeat(Math.min(adults, 4))}
                  {'\uD83E\uDD5A'.repeat(Math.min(eggs, 4))}
                  {'\uD83D\uDC23'.repeat(Math.min(chicks, 4))}
                </div>
              )}
            </a>
          );
        })}
      </div>
    </div>
  );
}
