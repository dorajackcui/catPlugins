export const BULK_FILL_PAUSE_THRESHOLD = 300;
export const BULK_FILL_PAUSE_EVERY = 200;
export const BULK_FILL_PAUSE_MS = 20_000;

export function normalizePlannedFillCount(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return null;
  }

  return Math.floor(value);
}

export function shouldPauseBulkFill(
  plannedFillCount: number | null | undefined,
  filledCount: number
): boolean {
  const normalizedPlannedFillCount = normalizePlannedFillCount(plannedFillCount);

  if (
    normalizedPlannedFillCount === null ||
    normalizedPlannedFillCount <= BULK_FILL_PAUSE_THRESHOLD
  ) {
    return false;
  }

  return filledCount > 0 && filledCount % BULK_FILL_PAUSE_EVERY === 0;
}

export function shouldPauseBulkFillForPlatform(
  platform: string | undefined,
  plannedFillCount: number | null | undefined,
  filledCount: number
): boolean {
  if (platform === 'phrase') {
    return false;
  }

  return shouldPauseBulkFill(plannedFillCount, filledCount);
}
