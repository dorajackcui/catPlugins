import type { FillOptions } from '../shared/translation-types.ts';

export const DEFAULT_FILL_OPTIONS: FillOptions = {
  autoStopAfterFilledCount: null,
  validatePlaceholders: false,
  enableMemoqMarkerFill: false
};

export function normalizeFillOptions(fillOptions?: FillOptions | null): FillOptions {
  const autoStopAfterFilledCount = fillOptions?.autoStopAfterFilledCount;
  const validatePlaceholders = fillOptions?.validatePlaceholders === true;
  const enableMemoqMarkerFill = fillOptions?.enableMemoqMarkerFill === true;

  if (
    typeof autoStopAfterFilledCount !== 'number' ||
    !Number.isFinite(autoStopAfterFilledCount) ||
    autoStopAfterFilledCount < 1
  ) {
    return {
      ...DEFAULT_FILL_OPTIONS,
      validatePlaceholders,
      enableMemoqMarkerFill
    };
  }

  return {
    autoStopAfterFilledCount: Math.floor(autoStopAfterFilledCount),
    validatePlaceholders,
    enableMemoqMarkerFill
  };
}
