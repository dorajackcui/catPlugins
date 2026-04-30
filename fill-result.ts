import type { FillRunResult } from './types.ts';

type FillResultSummary = Pick<
  FillRunResult,
  'filledCount' | 'failedCount' | 'stoppedByAutoStop' | 'autoStopAfterFilledCount'
>;

export function formatFillCompletionMessage(result: FillResultSummary): string {
  if (result.stoppedByAutoStop && result.autoStopAfterFilledCount !== null) {
    if (result.failedCount > 0) {
      return `Filled ${result.filledCount} segment(s), failed ${result.failedCount} segment(s), and auto-stopped at ${result.autoStopAfterFilledCount}.`;
    }

    return `Filled ${result.filledCount} segment(s) and auto-stopped at ${result.autoStopAfterFilledCount}.`;
  }

  if (result.failedCount > 0) {
    return `Filled ${result.filledCount} segment(s), failed ${result.failedCount} segment(s).`;
  }

  return `Filled ${result.filledCount} segment(s).`;
}
