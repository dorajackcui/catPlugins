import { FillRunner } from './fill-runner.ts';
import type {
  FillRunOptions,
  FillRunProgress,
  FillRunnerRuntime
} from './fill-runner-contracts.ts';
import {
  DEFAULT_SEGMENT_SCAN_MAX_PASSES,
  DEFAULT_SEGMENT_SCAN_MAX_SEGMENTS,
  normalizeSegmentScanLimit,
  SegmentScanner
} from './segment-scanner.ts';
import type { StartMarker } from './start-marker.ts';
import type { RuntimeSegment, ScrollContext } from './types.ts';
import type {
  FillOptions,
  FillRunResult,
  PageSegment,
  TranslationEntry
} from '../shared/translation-types.ts';
import { RUN_STOP_ERROR_MESSAGE } from '../domain/run-stop.ts';

export { RUN_STOP_ERROR_MESSAGE as STOP_ERROR_MESSAGE } from '../domain/run-stop.ts';

export interface ContentScanOptions {
  maxPasses?: number;
  maxSegments?: number;
  scanFromTop?: boolean;
}

export type ContentFillOptions = FillRunOptions;

export interface ContentRunRuntime extends FillRunnerRuntime {
  findScrollContext(): ScrollContext;
  collectVisibleSegments(scrollContext: ScrollContext): RuntimeSegment[];
}

export interface ContentRunServicePort {
  runtime: ContentRunRuntime;
  reportProgress(runId: string, progress: FillRunProgress): Promise<void>;
  isStopRequested(): boolean;
  setStopRequested(value: boolean): void;
  delay(delayMs: number): Promise<void>;
  readFreshStartMarker(): StartMarker | null;
  clearStartMarker(): void;
  now(): number;
  logInfo(label: string, payload: Record<string, unknown>): void;
  logWarn(label: string, payload: Record<string, unknown>): void;
  logError(label: string, payload: Record<string, unknown>): void;
}

/**
 * Coordinates scan and fill runs inside the editor page. Browser globals and
 * platform DOM implementations enter through the port so the run lifecycle
 * remains independently testable.
 */
export class ContentRunService {
  private readonly segmentScanner: SegmentScanner;
  private readonly fillRunner: FillRunner;

  constructor(private readonly port: ContentRunServicePort) {
    this.segmentScanner = new SegmentScanner({
      findScrollContext: () => this.port.runtime.findScrollContext(),
      collectVisibleSegments: (scrollContext) =>
        this.port.runtime.collectVisibleSegments(scrollContext),
      isMemoqActive: () => this.port.runtime.isMemoqActive(),
      assertNotStopped: () => this.assertNotStopped(),
      delay: (delayMs) => this.port.delay(delayMs),
      readFreshStartMarker: () => this.port.readFreshStartMarker(),
      clearStartMarker: () => this.port.clearStartMarker(),
      now: () => this.port.now(),
      logInfo: (label, payload) => this.port.logInfo(label, payload),
      logError: (label, payload) => this.port.logError(label, payload)
    });
    this.fillRunner = new FillRunner({
      scanner: this.segmentScanner,
      runtime: this.port.runtime,
      reportProgress: (runId, progress) =>
        this.port.reportProgress(runId, progress),
      assertNotStopped: () => this.assertNotStopped(),
      waitWithStopChecks: (delayMs) => this.waitWithStopChecks(delayMs),
      delay: (delayMs) => this.port.delay(delayMs),
      logInfo: (label, payload) => this.port.logInfo(label, payload),
      logWarn: (label, payload) => this.port.logWarn(label, payload),
      logError: (label, payload) => this.port.logError(label, payload)
    });
  }

  async scanSegments(
    runId: string,
    options: ContentScanOptions = {}
  ): Promise<PageSegment[]> {
    this.resetStopState();
    let scannedCount = 0;
    const runtimeSegments = await this.segmentScanner.collect(
      async () => {
        scannedCount += 1;
        if (scannedCount === 1 || scannedCount % 10 === 0) {
          await this.port.reportProgress(runId, { scannedCount });
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
        restoreScrollPosition: true,
        scanFromTop: options.scanFromTop === true
      }
    );
    await this.port.reportProgress(runId, {
      scannedCount: runtimeSegments.length
    });
    return runtimeSegments.map(toPageSegment);
  }

  fillAll(
    runId: string,
    entries: TranslationEntry[],
    fillOptions: FillOptions,
    plannedFillCount: number | null,
    options: ContentFillOptions = {}
  ): Promise<FillRunResult> {
    this.resetStopState();
    return this.fillRunner.run(
      runId,
      entries,
      fillOptions,
      plannedFillCount,
      options
    );
  }

  stopCurrentRun(): void {
    this.port.setStopRequested(true);
  }

  private resetStopState(): void {
    this.port.setStopRequested(false);
  }

  private assertNotStopped(): void {
    if (this.port.isStopRequested()) {
      throw new Error(RUN_STOP_ERROR_MESSAGE);
    }
  }

  private async waitWithStopChecks(delayMs: number): Promise<void> {
    let remainingMs = Math.max(0, delayMs);

    while (remainingMs > 0) {
      this.assertNotStopped();
      const nextDelayMs = Math.min(remainingMs, 250);
      await this.port.delay(nextDelayMs);
      remainingMs -= nextDelayMs;
    }

    this.assertNotStopped();
  }
}

function toPageSegment(segment: RuntimeSegment): PageSegment {
  const {
    targetElement: _targetElement,
    scanElement: _scanElement,
    scanFingerprint: _scanFingerprint,
    phraseUsesTagMarkup: _phraseUsesTagMarkup,
    ...pageSegment
  } = segment;

  return pageSegment;
}
