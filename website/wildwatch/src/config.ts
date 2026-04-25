/**
 * Breeding season configuration.
 * A season runs from SEASON_START_MONTH/SEASON_START_DAY to the day before the next season.
 * Change these values to adjust the season boundary.
 */
export const SEASON_START_MONTH = 4; // April (1-indexed)
export const SEASON_START_DAY = 1;

/**
 * Get the start date of the season that contains the given date.
 */
export function getSeasonStart(date: Date = new Date()): Date {
  const year = date.getMonth() + 1 >= SEASON_START_MONTH ? date.getFullYear() : date.getFullYear() - 1;
  return new Date(year, SEASON_START_MONTH - 1, SEASON_START_DAY);
}

/**
 * Get the season label for a given date, e.g. "2025/26"
 */
export function getSeasonLabel(date: Date = new Date()): string {
  const start = getSeasonStart(date);
  const y = start.getFullYear();
  return `${y}/${(y + 1).toString().slice(-2)}`;
}

/**
 * Get the ISO string for the start of the season containing the given date.
 */
export function getSeasonStartISO(date: Date = new Date()): string {
  return getSeasonStart(date).toISOString();
}
