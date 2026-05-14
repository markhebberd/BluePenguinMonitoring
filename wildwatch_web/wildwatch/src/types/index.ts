export interface ScanRecord {
  BirdId: string;
  Timestamp: string;
  Latitude: number;
  Longitude: number;
  Accuracy: number;
}

export interface BoxData {
  ScannedIds: ScanRecord[];
  Adults: number;
  Eggs: number;
  Chicks: number;
  GateStatus: string | null;
  Notes: string;
  whenDataCollectedUtc: string;
  BreedingChance: string | null;
}

export interface MonitorDetails {
  IsDeleted: boolean;
  DeletionReason: string | null;
  LastSaved: string;
  filename: string;
  BoxData: Record<string, BoxData>;
}

export interface BoxTag {
  BoxID: string;
  TagNumber: string;
  ScanTimeUTC: string;
  Latitude: number;
  Longitude: number;
  Accuracy: number;
}

export interface BoxTagsResponse {
  success: boolean;
  data: Record<string, BoxTag>;
  count: number;
}

export interface BoxTimelineEntry {
  date: string;
  monitorName: string;
  adults: number;
  eggs: number;
  chicks: number;
  breedingChance: string | null;
  gateStatus: string | null;
  notes: string;
  scannedBirds: string[];
}
