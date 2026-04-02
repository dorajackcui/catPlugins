import type { FillOptions } from './types.ts';

export const DEFAULT_FILL_OPTIONS: FillOptions = {
  autoStopAfterFilledCount: null
};

export function normalizeFillOptions(fillOptions?: FillOptions | null): FillOptions {
  const autoStopAfterFilledCount = fillOptions?.autoStopAfterFilledCount;

  if (
    typeof autoStopAfterFilledCount !== 'number' ||
    !Number.isFinite(autoStopAfterFilledCount) ||
    autoStopAfterFilledCount < 1
  ) {
    return DEFAULT_FILL_OPTIONS;
  }

  return {
    autoStopAfterFilledCount: Math.floor(autoStopAfterFilledCount)
  };
}
