import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
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

export function ColonyMap({ boxTags, selectedBox, onBoxSelect }: ColonyMapProps) {
  const entries = Object.entries(boxTags).filter(
    ([, tag]) => tag.Latitude !== 0 && tag.Longitude !== 0
  );

  if (entries.length === 0) return <div className="map-empty">No GPS data available</div>;

  // Calculate center from all points
  const avgLat = entries.reduce((sum, [, t]) => sum + t.Latitude, 0) / entries.length;
  const avgLon = entries.reduce((sum, [, t]) => sum + t.Longitude, 0) / entries.length;

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
