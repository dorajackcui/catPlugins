import type { RuntimeSegment } from './types.ts';
import { normalizeFillOptions } from '../domain/fill-options.ts';
import { describeFillStopReason, shouldStopAfterFillFailure } from '../domain/fill-failure.ts';
import { BULK_FILL_PAUSE_MS, shouldPauseBulkFillForPlatform } from '../domain/fill-throttle.ts';
import {
  applyFilledToPreview,
  classifySegment,
  createEntryLookup,
  summarizePreview
} from '../domain/matcher.ts';
import { describeMemoqFillDiagnostic } from '../domain/memoq-fill-diagnostics.ts';
import {
  shouldRejectNonEmptyTarget,
  type MemoqFillExecutionContext
} from '../platforms/runtime.ts';
import type { FillOutcome } from '../shared/fill-outcome-types.ts';
import type {
  FillOptions,
  FillRunResult,
  PreviewItem,
  TranslationEntry
} from '../shared/translation-types.ts';
import type { FillSegmentProcessorPort } from './fill-runner-contracts.ts';
import { shouldRescanAfterSegmentFill } from './scan-dedupe.ts';
import type { SegmentScanCallback, SegmentScanContext } from './segment-scanner.ts';

const DEFAULT_INTER_FILL_DELAY_MS = 180;
const MEMOQ_INTER_FILL_DELAY_MS = 320;

export interface FillSegmentProcessorOptions {
  runId: string;
  entries: TranslationEntry[];
  fillOptions: FillOptions;
  plannedFillCount: number | null;
}

/**
 * Owns the state machine for each scanned segment in a fill run. The runner
 * controls lifecycle and traversal while this class owns classification,
 * write safety, progress, throttling, and scan flow decisions.
 */
export class FillSegmentProcessor {
  private readonly entryLookup;
  private readonly normalizedFillOptions: FillOptions;
  private readonly previewItems: PreviewItem[] = [];
  private readonly filledDomIds: string[] = [];
  private stoppedByAutoStop = false;
  private stopReason: string | undefined;
  private memoqFillSequence = 0;

  readonly autoStopAfterFilledCount: number | null;

  constructor(
    private readonly options: FillSegmentProcessorOptions,
    private readonly port: FillSegmentProcessorPort
  ) {
    this.entryLookup = createEntryLookup(options.entries);
    this.normalizedFillOptions = normalizeFillOptions(options.fillOptions);
    this.autoStopAfterFilledCount = normalizeAutoStopAfterFilledCount(
      this.normalizedFillOptions.autoStopAfterFilledCount
    );
  }

  readonly process: SegmentScanCallback = async (
    segment,
    scanContext
  ) => {
    const item = classifySegment(
      this.entryLookup,
      segment,
      this.normalizedFillOptions
    );
    this.previewItems.push(item);
    const scannedCount = this.previewItems.length;

    if (scannedCount === 1 || scannedCount % 10 === 0) {
      await this.port.reportProgress(this.options.runId, {
        scannedCount,
        filledCount: this.filledDomIds.length,
        plannedFillCount: this.options.plannedFillCount
      });
    }

    if (item.status !== 'ready' || !item.translation) {
      this.logMemoqMatchRejection(segment, item);
      return;
    }

    const memoqContext = this.createMemoqContext(segment, scanContext);
    if (memoqContext) {
      this.port.logInfo('memoQ fill:attempt', {
        ...memoqContext,
        rowNumber: segment.rowNumber,
        domId: segment.domId,
        excelRowIndex: item.excelRowIndex,
        source: segment.sourceRaw,
        targetBeforeScan: segment.targetRaw,
        expectedTranslation: item.translation
      });
    }

    const outcome = await this.fillSegment(
      segment,
      item.translation,
      memoqContext
    );
    let shouldRescanVisibleSnapshot = false;
    if (outcome.filled) {
      this.filledDomIds.push(outcome.domId);
      if (
        this.autoStopAfterFilledCount !== null &&
        this.filledDomIds.length >= this.autoStopAfterFilledCount
      ) {
        this.stoppedByAutoStop = true;
        return 'stop';
      }

      if (
        shouldPauseBulkFillForPlatform(
          segment.platform,
          this.options.plannedFillCount,
          this.filledDomIds.length
        )
      ) {
        await this.port.reportProgress(this.options.runId, {
          scannedCount,
          filledCount: this.filledDomIds.length,
          plannedFillCount: this.options.plannedFillCount,
          message: 'Cooling down for 20 seconds...'
        });
        await this.port.waitWithStopChecks(BULK_FILL_PAUSE_MS);
      }

      await this.port.reportProgress(this.options.runId, {
        scannedCount,
        filledCount: this.filledDomIds.length,
        plannedFillCount: this.options.plannedFillCount
      });

      shouldRescanVisibleSnapshot = shouldRescanAfterSegmentFill(
        segment,
        outcome
      );
    } else if (shouldStopAfterFillFailure(segment.platform)) {
      this.stopReason =
        segment.platform === 'memoq'
          ? this.describeMemoqStopReason(segment, outcome)
          : describeFillStopReason(segment, outcome);
      await this.port.reportProgress(this.options.runId, {
        scannedCount,
        filledCount: this.filledDomIds.length,
        plannedFillCount: this.options.plannedFillCount,
        message: this.stopReason
      });
      return 'stop';
    }

    this.port.assertNotStopped();
    await this.port.delay(this.getInterFillDelayMs(segment));
    if (shouldRescanVisibleSnapshot) {
      return 'rescan';
    }
  };

  createResult(): FillRunResult {
    const preFillPreview = summarizePreview(this.previewItems);

    return {
      preview: applyFilledToPreview(preFillPreview, this.filledDomIds),
      filledCount: this.filledDomIds.length,
      filledDomIds: [...this.filledDomIds],
      stoppedByAutoStop: this.stoppedByAutoStop,
      autoStopAfterFilledCount: this.autoStopAfterFilledCount,
      stopReason: this.stopReason
    };
  }

  private logMemoqMatchRejection(segment: RuntimeSegment, item: PreviewItem): void {
    if (
      segment.platform !== 'memoq' ||
      !item.reason?.includes('source does not match')
    ) {
      return;
    }

    this.port.logWarn('memoQ fill:match-rejected', {
      runId: this.options.runId,
      rowNumber: segment.rowNumber,
      domId: segment.domId,
      source: segment.sourceRaw,
      reason: item.reason
    });
  }

  private createMemoqContext(
    segment: RuntimeSegment,
    scanContext: SegmentScanContext
  ): MemoqFillExecutionContext | undefined {
    if (segment.platform !== 'memoq') {
      return undefined;
    }

    return {
      runId: this.options.runId,
      sequence: ++this.memoqFillSequence,
      scanPass: scanContext.scanPass,
      scrollTop: scanContext.scrollTop,
      scrollMode: scanContext.scrollMode
    };
  }

  private async fillSegment(
    segment: RuntimeSegment,
    value: string,
    memoqContext?: MemoqFillExecutionContext
  ): Promise<FillOutcome> {
    this.port.assertNotStopped();
    if (segment.platform === 'memoq') {
      return this.port.runtime.fillSegment(segment, value, memoqContext);
    }

    const currentValue = this.port.runtime.getEditableValue(segment);
    if (shouldRejectNonEmptyTarget(segment.platform, currentValue)) {
      return {
        domId: segment.domId,
        filled: false,
        reason: 'Target is no longer empty.'
      };
    }

    return this.port.runtime.fillSegment(segment, value);
  }

  private describeMemoqStopReason(
    segment: RuntimeSegment,
    outcome: FillOutcome
  ): string {
    if (outcome.diagnostic?.outcome === 'failure') {
      return describeMemoqFillDiagnostic(outcome.diagnostic);
    }

    const rowLabel = segment.rowNumber
      ? `row ${segment.rowNumber}`
      : `segment ${segment.domId}`;
    const sourcePreview =
      segment.sourceRaw.length > 80
        ? `${segment.sourceRaw.slice(0, 77)}...`
        : segment.sourceRaw;
    const reason = outcome.reason ?? 'memoQ fill could not be confirmed.';

    return `Stopped at memoQ ${rowLabel}: ${reason} Source="${sourcePreview}"`;
  }

  private getInterFillDelayMs(segment: RuntimeSegment): number {
    return segment.platform === 'memoq'
      ? MEMOQ_INTER_FILL_DELAY_MS
      : DEFAULT_INTER_FILL_DELAY_MS;
  }
}

export function normalizeAutoStopAfterFilledCount(
  value: number | null | undefined
): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return null;
  }

  return Math.floor(value);
}
