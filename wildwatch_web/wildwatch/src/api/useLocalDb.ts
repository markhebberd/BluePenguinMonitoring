import { useSyncExternalStore } from 'react';
import { subscribe, getStoreVersion, computeBoxInfo, queryBoxDetailSync, queryBirdDetailSync, queryDay, queryAllPenguins, getDateStats, computeEggArrival, computeFirstEgg, computeDistinctAdults, computePeakAdults, computeChickReturn, computeMissedScans, computeMissingNoScans, computeBirdTwoBoxes, computeScanBeforeChip, computeDeadScanned, computeImprobableCounts, computeFutureObservations, computeRetiredTagScans, computeChicksNoScan, computeDuplicateObservations, computeDuplicateScans, computeSameGenderConflicts, computeChickSizeMismatch, computeMissingChipMeasures } from './localdb';

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

export function useMissingChipMeasures(): any[] {
  return useSyncExternalStore(subscribe, () => cached('missingChipMeasures', computeMissingChipMeasures));
}

export function useBoxInfo(): Record<string, { s: string; a: number; e: number; c: number }> {
  return useSyncExternalStore(subscribe, () => cached('boxInfo', computeBoxInfo));
}

export function useDateStats(): Map<string, any> {
  return useSyncExternalStore(subscribe, () => cached('dateStats', getDateStats));
}

export function useEggArrival(): any[] {
  return useSyncExternalStore(subscribe, () => cached('eggArrival', computeEggArrival));
}

export function useFirstEgg(): any[] {
  return useSyncExternalStore(subscribe, () => cached('firstEgg', computeFirstEgg));
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

export function useMissingNoScans(): { total: number; rows: any[] } {
  return useSyncExternalStore(subscribe, () => cached('missingNoScans', computeMissingNoScans));
}

export function useChickReturn(): any {
  return useSyncExternalStore(subscribe, () => cached('chickReturn', computeChickReturn));
}

export function useBirdTwoBoxes(): any[] { return useSyncExternalStore(subscribe, () => cached('birdTwoBoxes', computeBirdTwoBoxes)); }
export function useScanBeforeChip(): any[] { return useSyncExternalStore(subscribe, () => cached('scanBeforeChip', computeScanBeforeChip)); }
export function useDeadScanned(): any[] { return useSyncExternalStore(subscribe, () => cached('deadScanned', computeDeadScanned)); }
export function useImprobableCounts(): any[] { return useSyncExternalStore(subscribe, () => cached('improbableCounts', computeImprobableCounts)); }
export function useFutureObservations(): any[] { return useSyncExternalStore(subscribe, () => cached('futureObservations', computeFutureObservations)); }
export function useRetiredTagScans(): any[] { return useSyncExternalStore(subscribe, () => cached('retiredTagScans', computeRetiredTagScans)); }
export function useChicksNoScan(): any[] { return useSyncExternalStore(subscribe, () => cached('chicksNoScan', computeChicksNoScan)); }
export function useDuplicateObservations(): any[] { return useSyncExternalStore(subscribe, () => cached('duplicateObservations', computeDuplicateObservations)); }
export function useDuplicateScans(): any[] { return useSyncExternalStore(subscribe, () => cached('duplicateScans', computeDuplicateScans)); }
export function useSameGenderConflicts(): any[] { return useSyncExternalStore(subscribe, () => cached('sameGenderConflicts', computeSameGenderConflicts)); }
export function useChickSizeMismatch(): any[] { return useSyncExternalStore(subscribe, () => cached('chickSizeMismatch', computeChickSizeMismatch)); }

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
