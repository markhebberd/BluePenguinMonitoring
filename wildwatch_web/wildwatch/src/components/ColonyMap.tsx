import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet';
import { useEffect } from 'react';
import L from 'leaflet';
import type { BoxTag } from '../types';
import 'leaflet/dist/leaflet.css';

// Fix default marker icon
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';

delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

interface ColonyMapProps {
  boxTags: Record<string, BoxTag>;
  selectedBox: string | null;
  onBoxSelect: (boxId: string) => void;
}

/** Fit the map to every box in the colony, so outliers (e.g. a box a few hundred
 *  metres from the cluster) are always framed rather than left off-screen. Refits only
 *  when the marker envelope changes (colony switch or a box moves), so a user's manual
 *  pan/zoom within the same colony isn't yanked back. No maxZoom cap — a tight cluster
 *  is allowed to zoom right in. */
function FitToBounds({ positions, dep }: { positions: [number, number][]; dep: string }) {
  const map = useMap();
  useEffect(() => {
    if (positions.length === 1) { map.setView(positions[0], 19); return; }
    map.fitBounds(L.latLngBounds(positions), { padding: [40, 40] });
  }, [dep]);
  return null;
}

export function ColonyMap({ boxTags, selectedBox, onBoxSelect }: ColonyMapProps) {
  const entries = Object.entries(boxTags).filter(
    ([, tag]) => tag.Latitude !== 0 && tag.Longitude !== 0
  );

  if (entries.length === 0) return <div className="map-empty">No GPS data available</div>;

  const positions = entries.map(([, t]) => [t.Latitude, t.Longitude] as [number, number]);
  // Initial center (fallback before FitToBounds runs on first paint).
  const avgLat = positions.reduce((s, p) => s + p[0], 0) / positions.length;
  const avgLon = positions.reduce((s, p) => s + p[1], 0) / positions.length;
  // Envelope signature — refit when the spread changes (colony switch or a box moves).
  const lats = positions.map(p => p[0]);
  const lons = positions.map(p => p[1]);
  const boundsKey = `${Math.min(...lats).toFixed(5)},${Math.min(...lons).toFixed(5)},${Math.max(...lats).toFixed(5)},${Math.max(...lons).toFixed(5)}`;

  const makeIcon = (boxId: string, isSelected: boolean) => L.divIcon({
    className: '',
    html: `<div style="
      background:${isSelected ? '#1a5276' : '#fff'};
      color:${isSelected ? '#fff' : '#1a5276'};
      border:2px solid #1a5276;
      border-radius:50%;
      width:${boxId.length > 2 ? '28' : '24'}px;
      height:${boxId.length > 2 ? '28' : '24'}px;
      display:flex;
      align-items:center;
      justify-content:center;
      font-size:${boxId.length > 2 ? '8' : '10'}px;
      font-weight:700;
      box-shadow:0 1px 3px rgba(0,0,0,.3);
    ">${boxId}</div>`,
    iconSize: [boxId.length > 2 ? 28 : 24, boxId.length > 2 ? 28 : 24],
    iconAnchor: [boxId.length > 2 ? 14 : 12, boxId.length > 2 ? 14 : 12],
    popupAnchor: [0, -14],
  });

  return (
    <div className="map-container">
      <MapContainer center={[avgLat, avgLon]} zoom={17} style={{ height: '100%', width: '100%' }}>
        <FitToBounds positions={positions} dep={boundsKey} />
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          maxZoom={22}
          maxNativeZoom={19}
        />
        {entries.map(([boxId, tag]) => (
          <Marker
            key={boxId}
            position={[tag.Latitude, tag.Longitude]}
            icon={makeIcon(boxId, boxId === selectedBox)}
            eventHandlers={{ click: () => onBoxSelect(boxId) }}
          >
            <Popup>
              <strong>Box {boxId}</strong>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}
