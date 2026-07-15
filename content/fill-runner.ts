import type {
  FillOptions,
  FillRunResult,
  TranslationEntry
} from '../shared/translation-types.ts';
import { FillSegmentProcessor } from './fill-segment-processor.ts';
import type {
  FillRunOptions,
  FillRunnerPort
} from './fill-runner-contracts.ts';
import {
  DEFAULT_SEGMENT_SCAN_MAX_PASSES,
  DEFAULT_SEGMENT_SCAN_MAX_SEGMENTS,
  normalizeSegmentScanLimit
} from './segment-scanner.ts';

export type {
  FillRunOptions,
  FillRunProgress,
  FillRunnerPort,
  FillRunnerRuntime,
  FillRunnerScanner,
  FillSegmentProcessorPort
} from './fill-runner-contracts.ts';
export { normalizeAutoStopAfterFilledCount } from './fill-segment-processor.ts';

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
    const memoqActive = await this.prepareMemoqRun(
      runId,
      entries,
      fillOptions,
      plannedFillCount,
      options
    );
    const processor = new FillSegmentProcessor({
      runId,
      entries,
      fillOptions,
      plannedFillCount
    }, this.port);

    this.port.logInfo('fill:start', {
      autoStopAfterFilledCount: processor.autoStopAfterFilledCount,
      plannedFillCount,
      maxPasses: options.maxPasses ?? DEFAULT_SEGMENT_SCAN_MAX_PASSES,
      maxSegments: options.maxSegments ?? DEFAULT_SEGMENT_SCAN_MAX_SEGMENTS,
      scanFromTop: options.scanFromTop === true,
      startFromMarker: options.startFromMarker === true
    });

    await this.port.scanner.collect(processor.process, {
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
    });

    const result = processor.createResult();
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

  private async prepareMemoqRun(
    runId: string,
    entries: TranslationEntry[],
    fillOptions: FillOptions,
    plannedFillCount: number | null,
    options: FillRunOptions
  ): Promise<boolean> {
    // Attach before the first snapshot. A fresh debugger attachment resizes
    // memoQ's grid, so no element or coordinate may be captured beforehand.
    const memoqActive = this.port.runtime.isMemoqActive();
    if (!memoqActive) {
      return false;
    }

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

    return true;
  }
}
