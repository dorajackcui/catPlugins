import type { RuntimeSegment } from './types.ts';
import { normalizeFillOptions } from '../domain/fill-options.ts';
import { describeFillStopReason, shouldStopAfterFillFailure } from '../domain/fill-failure.ts';
import { BULK_FILL_PAUSE_MS, shouldPauseBulkFillForPlatform } from '../domain/fill-throttle.ts';
import { applyFilledToPreview, classifySegment, createEntryLookup, summarizePreview } from '../domain/matcher.ts';
import { describeMemoqFillDiagnostic } from '../platforms/memoq/fill-diagnostics.ts';
import {
  shouldRejectNonEmptyTarget,
  type MemoqFillExecutionContext
} from '../platforms/runtime.ts';
import { shouldRescanAfterSegmentFill } from './scan-dedupe.ts';
import {
  DEFAULT_SEGMENT_SCAN_MAX_PASSES,
  DEFAULT_SEGMENT_SCAN_MAX_SEGMENTS,
  normalizeSegmentScanLimit,
  type SegmentScanCallback,
  type SegmentScanOptions
} from './segment-scanner.ts';
import type {
  FillOptions,
  FillOutcome,
  FillRunResult,
  PreviewItem,
  ReportRunProgressRequest,
  TranslationEntry
} from '../shared/types.ts';

const DEFAULT_INTER_FILL_DELAY_MS = 180;
const MEMOQ_INTER_FILL_DELAY_MS = 320;

export interface FillRunOptions {
  maxPasses?: number;
  maxSegments?: number;
  scanFromTop?: boolean;
  startFromMarker?: boolean;
}

export interface FillRunnerScanner {
  collect(
    onSegment?: SegmentScanCallback,
    options?: SegmentScanOptions
  ): Promise<RuntimeSegment[]>;
}

export interface FillRunnerRuntime {
  isMemoqActive(): boolean;
  prepareMemoqTrustedInput(): Promise<void>;
  getEditableValue(segment: RuntimeSegment): string;
  fillSegment(
    segment: RuntimeSegment,
    value: string,
    memoqContext?: MemoqFillExecutionContext
  ): Promise<FillOutcome>;
}

export type FillRunProgress = Omit<ReportRunProgressRequest['payload'], 'runId'>;

export interface FillRunnerPort {
  scanner: FillRunnerScanner;
  runtime: FillRunnerRuntime;
  reportProgress(runId: string, progress: FillRunProgress): Promise<void>;
  assertNotStopped(): void;
  waitWithStopChecks(delayMs: number): Promise<void>;
  delay(delayMs: number): Promise<void>;
  logInfo(label: string, payload: Record<string, unknown>): void;
  logWarn(label: string, payload: Record<string, unknown>): void;
  logError(label: string, payload: Record<string, unknown>): void;
}

/**
 * Coordinates a complete fill run while platform adapters retain ownership of
 * DOM discovery and editor-specific writes.
 */
export class FillRunner {
  constructor(private readonly port: FillRunnerPort) {}

  async run(
    runId: string,
    entries: TranslationEntry[],
    fillOptions: FillOptions,
    plannedFillCount: number | null,
    options: FillRunOptions = {}
  ): Promise<FillRunResult> {
    // Attach the debugger before the first snapshot is collected: the fresh
    // attachment's infobar resizes the page and re-lays out memoQ's grid, so
    // it must happen before any element or coordinate is captured. Also lets
    // one attachment survive the whole run instead of toggling per segment.
    const memoqActive = this.port.runtime.isMemoqActive();
    if (memoqActive) {
      try {
        await this.port.runtime.prepareMemoqTrustedInput();
      } catch (error) {
        this.port.logError('memoQ debugger:prepare-failure', {
          runId,
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
      this.port.logInfo('memoQ fill run:start', {
        runId,
        entryCount: entries.length,
        plannedFillCount,
        fillOptions,
        scanFromTop: options.scanFromTop === true,
        startFromMarker: options.startFromMarker === true
      });
    }

    const entryLookup = createEntryLookup(entries);
    const previewItems: PreviewItem[] = [];
    const filledDomIds: string[] = [];
    const normalizedFillOptions = normalizeFillOptions(fillOptions);
    const autoStopAfterFilledCount = normalizeAutoStopAfterFilledCount(
      normalizedFillOptions.autoStopAfterFilledCount
    );
    let stoppedByAutoStop = false;
    let stopReason: string | undefined;
    let memoqFillSequence = 0;

    this.port.logInfo('fill:start', {
      autoStopAfterFilledCount,
      plannedFillCount,
      maxPasses: options.maxPasses ?? DEFAULT_SEGMENT_SCAN_MAX_PASSES,
      maxSegments: options.maxSegments ?? DEFAULT_SEGMENT_SCAN_MAX_SEGMENTS,
      scanFromTop: options.scanFromTop === true,
      startFromMarker: options.startFromMarker === true
    });

    await this.port.scanner.collect(
      async (segment, scanContext) => {
        const item = classifySegment(entryLookup, segment, normalizedFillOptions);
        previewItems.push(item);
        const scannedCount = previewItems.length;

        if (scannedCount === 1 || scannedCount % 10 === 0) {
          await this.port.reportProgress(runId, {
            scannedCount,
            filledCount: filledDomIds.length,
            plannedFillCount
          });
        }

        if (item.status !== 'ready' || !item.translation) {
          if (
            segment.platform === 'memoq' &&
            item.reason?.includes('source does not match')
          ) {
            this.port.logWarn('memoQ fill:match-rejected', {
              runId,
              rowNumber: segment.rowNumber,
              domId: segment.domId,
              source: segment.sourceRaw,
              reason: item.reason
            });
          }
          return;
        }

        const memoqContext: MemoqFillExecutionContext | undefined =
          segment.platform === 'memoq'
            ? {
                runId,
                sequence: ++memoqFillSequence,
                scanPass: scanContext.scanPass,
                scrollTop: scanContext.scrollTop,
                scrollMode: scanContext.scrollMode
              }
            : undefined;
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
          filledDomIds.push(outcome.domId);
          if (
            autoStopAfterFilledCount !== null &&
            filledDomIds.length >= autoStopAfterFilledCount
          ) {
            stoppedByAutoStop = true;
            return 'stop';
          }

          if (
            shouldPauseBulkFillForPlatform(
              segment.platform,
              plannedFillCount,
              filledDomIds.length
            )
          ) {
            await this.port.reportProgress(runId, {
              scannedCount,
              filledCount: filledDomIds.length,
              plannedFillCount,
              message: 'Cooling down for 20 seconds...'
            });
            await this.port.waitWithStopChecks(BULK_FILL_PAUSE_MS);
          }

          await this.port.reportProgress(runId, {
            scannedCount,
            filledCount: filledDomIds.length,
            plannedFillCount
          });

          shouldRescanVisibleSnapshot = shouldRescanAfterSegmentFill(
            segment,
            outcome
          );
        } else if (shouldStopAfterFillFailure(segment.platform)) {
          stopReason =
            segment.platform === 'memoq'
              ? this.describeMemoqStopReason(segment, outcome)
              : describeFillStopReason(segment, outcome);
          await this.port.reportProgress(runId, {
            scannedCount,
            filledCount: filledDomIds.length,
            plannedFillCount,
            message: stopReason
          });
          return 'stop';
        }

        this.port.assertNotStopped();
        await this.port.delay(this.getInterFillDelayMs(segment));
        if (shouldRescanVisibleSnapshot) {
          return 'rescan';
        }
      },
      {
        maxPasses: normalizeSegmentScanLimit(
          options.maxPasses,
          DEFAULT_SEGMENT_SCAN_MAX_PASSES
        ),
        maxSegments: normalizeSegmentScanLimit(
          options.maxSegments,
          DEFAULT_SEGMENT_SCAN_MAX_SEGMENTS
        ),
        restoreScrollPosition: false,
        scanFromTop: options.scanFromTop === true,
        startFromMarker: options.startFromMarker === true
      }
    );

    const preFillPreview = summarizePreview(previewItems);
    const result: FillRunResult = {
      preview: applyFilledToPreview(preFillPreview, filledDomIds),
      filledCount: filledDomIds.length,
      filledDomIds,
      stoppedByAutoStop,
      autoStopAfterFilledCount,
      stopReason
    };
    if (memoqActive) {
      this.port.logInfo('memoQ fill run:complete', {
        runId,
        filledCount: result.filledCount,
        scannedCount: result.preview.totalSegments,
        stoppedByAutoStop: result.stoppedByAutoStop,
        stopReason: result.stopReason ?? null
      });
    }
    return result;
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
