import type { FillFailure, FillOutcome } from './types.ts';

export const MEMOQ_FILL_RETRY_ATTEMPTS = 2;
export const TARGET_NO_LONGER_EMPTY_REASON = 'Target is no longer empty.';

export interface MemoqCursorSegment<TSegment> {
  segment: TSegment;
  domId: string;
  sourceRaw: string;
  sourceNormalized: string;
  targetRaw: string;
  isEmptyTarget: boolean;
  placeholderTokens: string[];
}

export interface MemoqCursorVisitedSegment<TSegment>
  extends MemoqCursorSegment<TSegment> {
  occurrenceIndex: number;
}

export interface MemoqCursorAdvanceResult<TSegment> {
  segment: MemoqCursorSegment<TSegment> | null;
  reachedEnd: boolean;
}

export interface MemoqCursorVisitEvent<TSegment, TItem> {
  item: TItem;
  segment: MemoqCursorVisitedSegment<TSegment>;
  processedCount: number;
  filledCount: number;
}

export interface MemoqCursorFillAttemptFailureEvent<TSegment, TItem> {
  item: TItem;
  segment: MemoqCursorVisitedSegment<TSegment>;
  outcome: FillOutcome;
  attemptNumber: number;
  maxAttempts: number;
  willRetry: boolean;
}

export interface MemoqCursorFillSuccessEvent<TSegment, TItem> {
  item: TItem;
  segment: MemoqCursorVisitedSegment<TSegment>;
  outcome: FillOutcome;
  filledCount: number;
  stoppedByAutoStop: boolean;
}

export interface MemoqCursorFillSettledEvent<TSegment, TItem> {
  item: TItem;
  segment: MemoqCursorVisitedSegment<TSegment>;
  outcome: FillOutcome;
  attemptCount: number;
  failure: FillFailure | null;
  stoppedByAutoStop: boolean;
}

export interface MemoqCursorFillResult<TItem> {
  items: TItem[];
  filledDomIds: string[];
  failures: FillFailure[];
  stoppedByAutoStop: boolean;
}

export async function runMemoqCursorFill<TSegment, TItem>(options: {
  initialSegment: MemoqCursorSegment<TSegment>;
  classify: (segment: MemoqCursorVisitedSegment<TSegment>) => TItem;
  shouldFill: (item: TItem) => boolean;
  getTranslation: (item: TItem) => string | null;
  advance: (
    segment: MemoqCursorVisitedSegment<TSegment>
  ) => Promise<MemoqCursorAdvanceResult<TSegment>>;
  fillSegment: (
    segment: MemoqCursorVisitedSegment<TSegment>,
    translation: string,
    attemptNumber: number
  ) => Promise<FillOutcome>;
  autoStopAfterFilledCount: number | null;
  maxAttemptsPerSegment?: number;
  onVisited?: (
    event: MemoqCursorVisitEvent<TSegment, TItem>
  ) => Promise<void> | void;
  onAttemptFailure?: (
    event: MemoqCursorFillAttemptFailureEvent<TSegment, TItem>
  ) => Promise<void> | void;
  onFilled?: (
    event: MemoqCursorFillSuccessEvent<TSegment, TItem>
  ) => Promise<void> | void;
  onSettled?: (
    event: MemoqCursorFillSettledEvent<TSegment, TItem>
  ) => Promise<void> | void;
}): Promise<MemoqCursorFillResult<TItem>> {
  const filledDomIds: string[] = [];
  const failures: FillFailure[] = [];
  const items: TItem[] = [];
  const occurrenceCounter = new Map<string, number>();
  const maxAttempts = Math.max(
    1,
    Math.floor(options.maxAttemptsPerSegment ?? MEMOQ_FILL_RETRY_ATTEMPTS)
  );

  let currentSegment: MemoqCursorSegment<TSegment> | null = options.initialSegment;

  while (currentSegment) {
    const occurrenceIndex =
      (occurrenceCounter.get(currentSegment.sourceNormalized) ?? 0) + 1;
    occurrenceCounter.set(currentSegment.sourceNormalized, occurrenceIndex);

    const visitedSegment: MemoqCursorVisitedSegment<TSegment> = {
      ...currentSegment,
      occurrenceIndex
    };
    const item = options.classify(visitedSegment);
    items.push(item);

    await options.onVisited?.({
      item,
      segment: visitedSegment,
      processedCount: items.length,
      filledCount: filledDomIds.length
    });

    if (options.shouldFill(item)) {
      const translation = options.getTranslation(item);
      if (translation) {
        let attemptCount = 0;
        let finalOutcome: FillOutcome = {
          domId: visitedSegment.domId,
          filled: false,
          reason: 'Unknown memoQ fill failure.'
        };
        let failure: FillFailure | null = null;
        let stoppedByAutoStop = false;

        for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber += 1) {
          attemptCount = attemptNumber;
          finalOutcome = await options.fillSegment(
            visitedSegment,
            translation,
            attemptNumber
          );

          if (finalOutcome.filled) {
            filledDomIds.push(finalOutcome.domId);
            stoppedByAutoStop =
              options.autoStopAfterFilledCount !== null &&
              filledDomIds.length >= options.autoStopAfterFilledCount;
            await options.onFilled?.({
              item,
              segment: visitedSegment,
              outcome: finalOutcome,
              filledCount: filledDomIds.length,
              stoppedByAutoStop
            });
            break;
          }

          if (finalOutcome.reason === TARGET_NO_LONGER_EMPTY_REASON) {
            break;
          }

          const willRetry = attemptNumber < maxAttempts;
          await options.onAttemptFailure?.({
            item,
            segment: visitedSegment,
            outcome: finalOutcome,
            attemptNumber,
            maxAttempts,
            willRetry
          });

          if (!willRetry) {
            failure = {
              domId: finalOutcome.domId,
              sourceRaw: visitedSegment.sourceRaw,
              reason: finalOutcome.reason ?? 'Unknown memoQ fill failure.'
            };
            failures.push(failure);
          }
        }

        await options.onSettled?.({
          item,
          segment: visitedSegment,
          outcome: finalOutcome,
          attemptCount,
          failure,
          stoppedByAutoStop
        });

        if (stoppedByAutoStop) {
          return {
            items,
            filledDomIds,
            failures,
            stoppedByAutoStop: true
          };
        }
      }
    }

    const next = await options.advance(visitedSegment);
    if (next.reachedEnd || !next.segment) {
      break;
    }

    currentSegment = next.segment;
  }

  return {
    items,
    filledDomIds,
    failures,
    stoppedByAutoStop: false
  };
}
