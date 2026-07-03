import { useSyncExternalStore } from 'react';
import { subscribe, getStoreVersion, queryBoxDetailSync, queryBirdDetailSync, queryDay, queryAllPenguins, getDateStats, computeEggArrival, computeDistinctAdults, computePeakAdults, computeChickReturn, computeMissedScans, computeAdultCountMismatches } from './localdb';

export function useDbVersion(): number {
  return useSyncExternalStore(subscribe, getStoreVersion);
}

// Cached query results — stable references until storeVersion changes
const cache = new Map<string, { version: number; result: any }>();

function cached<T>(key: string, fn: () => T): T {
  const v = getStoreVersion();
  const c = cache.get(key);
  if (c && c.version === v) return c.result;
  const result = fn();
  cache.set(key, { version: v, result });
  return result;
}

export function useAllPenguins(): any[] {
  return useSyncExternalStore(subscribe, () => cached('allPenguins', queryAllPenguins));
}

export function useDateStats(): Map<string, any> {
  return useSyncExternalStore(subscribe, () => cached('dateStats', getDateStats));
}

export function useEggArrival(): any[] {
  return useSyncExternalStore(subscribe, () => cached('eggArrival', computeEggArrival));
}

export function useDistinctAdults(): any[] {
  return useSyncExternalStore(subscribe, () => cached('distinctAdults', computeDistinctAdults));
}

export function usePeakAdults(): any[] {
  return useSyncExternalStore(subscribe, () => cached('peakAdults', computePeakAdults));
}

export function useMissedScans(): any[] {
  return useSyncExternalStore(subscribe, () => cached('missedScans', computeMissedScans));
}

export function useAdultCountMismatches(): { total: number; rows: any[] } {
  return useSyncExternalStore(subscribe, () => cached('adultCountMismatches', computeAdultCountMismatches));
}

export function useChickReturn(): any {
  return useSyncExternalStore(subscribe, () => cached('chickReturn', computeChickReturn));
}

export function useBoxDetail(boxName: string | null): any {
  return useSyncExternalStore(subscribe, () => {
    if (!boxName) return null;
    return cached(`box:${boxName}`, () => queryBoxDetailSync(boxName));
  });
}

export function useBirdDetail(pengNum: string | null): any {
  return useSyncExternalStore(subscribe, () => {
    if (!pengNum) return null;
    return cached(`bird:${pengNum}`, () => queryBirdDetailSync(pengNum));
  });
}

export function useDayData(date: string | null): any {
  return useSyncExternalStore(subscribe, () => {
    if (!date) return null;
    return cached(`day:${date}`, () => queryDay(date));
  });
}
