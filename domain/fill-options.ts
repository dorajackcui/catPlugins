import type { FillOptions } from '../shared/types.ts';

export const DEFAULT_FILL_OPTIONS: FillOptions = {
  autoStopAfterFilledCount: null,
  validatePlaceholders: true
};

export function normalizeFillOptions(fillOptions?: FillOptions | null): FillOptions {
  const autoStopAfterFilledCount = fillOptions?.autoStopAfterFilledCount;
  const validatePlaceholders = fillOptions?.validatePlaceholders !== false;

  if (
    typeof autoStopAfterFilledCount !== 'number' ||
    !Number.isFinite(autoStopAfterFilledCount) ||
    autoStopAfterFilledCount < 1
  ) {
    return {
      ...DEFAULT_FILL_OPTIONS,
      validatePlaceholders
    };
  }

  return {
    autoStopAfterFilledCount: Math.floor(autoStopAfterFilledCount),
    validatePlaceholders
  };
}
