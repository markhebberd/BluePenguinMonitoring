import { useEffect, useState } from 'react';
import { fetchBoxDetail } from '../api/boxtags';

interface Scan {
  scan_time_utc: string;
  tag_number: string;
  sex: string | null;
  life_stage: string | null;
  vid_for_scanner: string | null;
}

interface Observation {
  observation_id: number;
  observation_time_utc: string;
  monitor_filename: string;
  adults: number;
  eggs: number;
  chicks: number;
  breeding_status: string | null;
  gate_status: string | null;
  notes: string;
  observer_name: string;
  scans: Scan[];
}

interface LocationInfo {
  location_name: string;
  rfid_tag_number: string | null;
  rfid_latitude: number | null;
  rfid_longitude: number | null;
  rfid_accuracy: number | null;
}

interface BoxDetailProps {
  boxName: string;
  onClose: () => void;
}

export function BoxDetail({ boxName, onClose }: BoxDetailProps) {
  const [observations, setObservations] = useState<Observation[]>([]);
  const [location, setLocation] = useState<LocationInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetchBoxDetail(boxName)
      .then((data) => {
        setObservations(data.observations || []);
        setLocation(data.location || null);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [boxName]);

  if (loading) return <div className="box-detail loading-small">Loading box {boxName}...</div>;

  const formatDate = (d: string) => {
    const date = new Date(d);
    return date.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const getSexColor = (sex: string | null) => {
    if (sex?.toUpperCase() === 'F') return '#FFE4E1';
    if (sex?.toUpperCase() === 'M') return '#E6F3FF';
    return '#F5F5F5';
  };

  return (
    <div className="box-detail">
      <div className="box-detail-header">
        <h3>Box {boxName}</h3>
        <button className="close-btn" onClick={onClose}>&times;</button>
      </div>

      {location?.rfid_tag_number && (
        <div className="box-tag-info">
          Tag: {location.rfid_tag_number.slice(-8)}
          {location.rfid_latitude ? ` | ${location.rfid_latitude.toFixed(5)}, ${location.rfid_longitude?.toFixed(5)}` : ''}
        </div>
      )}

      <div className="observations-count">{observations.length} monitoring visits</div>

      <div className="observations-list">
        {observations.map((obs) => (
          <div key={obs.observation_id} className="observation-card">
            <div className="obs-header">
              <span className="obs-date">{formatDate(obs.observation_time_utc)}</span>
              <span className="obs-filename">{obs.monitor_filename}</span>
            </div>

            <div className="obs-data-row">
              <span className="obs-stat">
                <span className="emoji">&#x1F427;</span> {obs.adults}
              </span>
              <span className="obs-stat">
                <span className="emoji">&#x1F95A;</span> {obs.eggs}
              </span>
              <span className="obs-stat">
                <span className="emoji">&#x1F423;</span> {obs.chicks}
              </span>
              {obs.breeding_status && (
                <span className={`obs-status status-${obs.breeding_status}`}>
                  {obs.breeding_status}
                </span>
              )}
              {obs.gate_status && (
                <span className="obs-gate">{obs.gate_status}</span>
              )}
            </div>

            {obs.notes && <div className="obs-notes">{obs.notes}</div>}

            {obs.scans.length > 0 && (
              <div className="obs-scans">
                {obs.scans.map((scan, i) => (
                  <span
                    key={i}
                    className="scan-badge"
                    style={{ backgroundColor: getSexColor(scan.sex) }}
                    title={`${scan.tag_number} | ${scan.sex || '?'} | ${scan.life_stage || '?'}${scan.vid_for_scanner ? ' | VID:' + scan.vid_for_scanner : ''}`}
                  >
                    {scan.tag_number.slice(-8)}
                    {scan.sex ? ` ${scan.sex}` : ''}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
