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

  const selectedIcon = new L.Icon({
    iconUrl: markerIcon,
    iconRetinaUrl: markerIcon2x,
    shadowUrl: markerShadow,
    iconSize: [35, 51],
    iconAnchor: [17, 51],
    popupAnchor: [1, -34],
    shadowSize: [51, 51],
    className: 'marker-selected',
  });

  return (
    <div className="map-container">
      <MapContainer center={[avgLat, avgLon]} zoom={17} style={{ height: '100%', width: '100%' }}>
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {entries.map(([boxId, tag]) => (
          <Marker
            key={boxId}
            position={[tag.Latitude, tag.Longitude]}
            icon={boxId === selectedBox ? selectedIcon : new L.Icon.Default()}
            eventHandlers={{ click: () => onBoxSelect(boxId) }}
          >
            <Popup>
              <strong>Box {boxId}</strong>
              <br />
              Tag: {tag.TagNumber.slice(-8)}
              <br />
              Accuracy: {tag.Accuracy > 0 ? `${tag.Accuracy.toFixed(1)}m` : 'N/A'}
              <br />
              Scanned: {new Date(tag.ScanTimeUTC).toLocaleDateString()}
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  );
}
