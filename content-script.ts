import { runtimeSendMessage } from './chrome-api.ts';
import { applyFilledToPreview, classifySegment, createEntryLookup, summarizePreview } from './matcher.ts';
import { ContentScriptDomHelpers } from './content-script-dom.ts';
import type { RuntimeSegment } from './content-script-dom.ts';
import { normalizeFillOptions } from './fill-options.ts';
import { describeFillStopReason, shouldStopAfterFillFailure } from './fill-failure.ts';
import { BULK_FILL_PAUSE_MS, shouldPauseBulkFillForPlatform } from './fill-throttle.ts';
import { describeMemoqFillDiagnostic } from './platforms/memoq/fill-diagnostics.ts';
import {
  createPlatformRuntime,
  shouldRejectNonEmptyTarget,
  type MemoqFillExecutionContext
} from './platforms/runtime.ts';
import { shouldRescanAfterSegmentFill } from './scan-dedupe.ts';
import {
  bindStartMarkerListeners,
  clearStartMarker,
  readFreshStartMarker
} from './start-marker-dom.ts';
import {
  DEFAULT_SEGMENT_SCAN_MAX_PASSES,
  DEFAULT_SEGMENT_SCAN_MAX_SEGMENTS,
  normalizeSegmentScanLimit,
  SegmentScanner
} from './segment-scanner.ts';
import {
  replaceRuntimeMessageListener,
  type RuntimeMessageListener
} from './runtime-listener.ts';
import type {
  ApiResponse,
  BackgroundRequest,
  ContentRequest,
  FillOptions,
  FillOutcome,
  FillRunResult,
  PageSegment,
  PreviewItem,
  TranslationEntry
} from './types.ts';
import { delay } from './utils.ts';

declare global {
  interface Window {
    __phraseBulkFillMessageListener?: RuntimeMessageListener<
      ContentRequest,
      ApiResponse<unknown>
    >;
    __phraseBulkFillStopRequested?: boolean;
  }
}

const CONTENT_DEBUG_PREFIX = '[Phrase Bulk Fill]';
const DEFAULT_INTER_FILL_DELAY_MS = 180;
const MEMOQ_INTER_FILL_DELAY_MS = 320;

const helpers = new ContentScriptDomHelpers();
const platformRuntime = createPlatformRuntime(helpers);
const STOP_ERROR_MESSAGE = 'Operation stopped by user.';

async function reportRunProgress(
  runId: string,
  progress: Omit<Extract<BackgroundRequest, { type: 'REPORT_RUN_PROGRESS' }>['payload'], 'runId'>
): Promise<void> {
  try {
    await runtimeSendMessage<BackgroundRequest, ApiResponse<null>>({
      type: 'REPORT_RUN_PROGRESS',
      payload: {
        ...progress,
        runId
      }
    });
  } catch {
    // Ignore transient background messaging issues to keep the run alive.
  }
}

class PlatformDomAdapter {
  private readonly segmentScanner = new SegmentScanner({
    findScrollContext: () => platformRuntime.findScrollContext(),
    collectVisibleSegments: (scrollContext) =>
      platformRuntime.collectVisibleSegments(scrollContext),
    isMemoqActive: () => platformRuntime.isMemoqActive(),
    assertNotStopped: () => this.assertNotStopped(),
    delay,
    readFreshStartMarker,
    clearStartMarker,
    now: () => Date.now(),
    logInfo: (label, payload) => console.info(CONTENT_DEBUG_PREFIX, label, payload),
    logError: (label, payload) => console.error(CONTENT_DEBUG_PREFIX, label, payload)
  });

  async scanSegments(
    runId: string,
    options?: {
      maxPasses?: number;
      maxSegments?: number;
      scanFromTop?: boolean;
    }
  ): Promise<PageSegment[]> {
    this.resetStopState();
    let scannedCount = 0;
    const runtimeSegments = await this.segmentScanner.collect(
      async () => {
        scannedCount += 1;
        if (scannedCount === 1 || scannedCount % 10 === 0) {
          await reportRunProgress(runId, { scannedCount });
        }
      },
      {
        maxPasses: normalizeSegmentScanLimit(
          options?.maxPasses,
          DEFAULT_SEGMENT_SCAN_MAX_PASSES
        ),
        maxSegments: normalizeSegmentScanLimit(
          options?.maxSegments,
          DEFAULT_SEGMENT_SCAN_MAX_SEGMENTS
        ),
        restoreScrollPosition: true,
        scanFromTop: options?.scanFromTop === true
      }
    );
    await reportRunProgress(runId, { scannedCount: runtimeSegments.length });
    return runtimeSegments.map(
      ({
        targetElement: _targetElement,
        scanElement: _scanElement,
        scanFingerprint: _scanFingerprint,
        phraseUsesTagMarkup: _phraseUsesTagMarkup,
        ...segment
      }) => segment
    );
  }

  async fillAll(
    runId: string,
    entries: TranslationEntry[],
    fillOptions: FillOptions,
    plannedFillCount: number | null,
    options?: {
      maxPasses?: number;
      maxSegments?: number;
      scanFromTop?: boolean;
      startFromMarker?: boolean;
    }
  ): Promise<FillRunResult> {
    this.resetStopState();
    // Attach the debugger before the first snapshot is collected: the fresh
    // attachment's infobar resizes the page and re-lays out memoQ's grid, so
    // it must happen before any element or coordinate is captured. Also lets
    // one attachment survive the whole run instead of toggling per segment.
    const memoqActive = platformRuntime.isMemoqActive();
    if (memoqActive) {
      try {
        await platformRuntime.prepareMemoqTrustedInput();
      } catch (error) {
        console.error(CONTENT_DEBUG_PREFIX, 'memoQ debugger:prepare-failure', {
          runId,
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      }
      console.info(CONTENT_DEBUG_PREFIX, 'memoQ fill run:start', {
        runId,
        entryCount: entries.length,
        plannedFillCount,
        fillOptions,
        scanFromTop: options?.scanFromTop === true,
        startFromMarker: options?.startFromMarker === true
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

    console.info(CONTENT_DEBUG_PREFIX, 'fill:start', {
      autoStopAfterFilledCount,
      plannedFillCount,
      maxPasses: options?.maxPasses ?? DEFAULT_SEGMENT_SCAN_MAX_PASSES,
      maxSegments: options?.maxSegments ?? DEFAULT_SEGMENT_SCAN_MAX_SEGMENTS,
      scanFromTop: options?.scanFromTop === true,
      startFromMarker: options?.startFromMarker === true
    });

    await this.segmentScanner.collect(
      async (segment, scanContext) => {
        const item = classifySegment(entryLookup, segment, normalizedFillOptions);
        previewItems.push(item);
        const scannedCount = previewItems.length;

        if (scannedCount === 1 || scannedCount % 10 === 0) {
          await reportRunProgress(runId, {
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
            console.warn(CONTENT_DEBUG_PREFIX, 'memoQ fill:match-rejected', {
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
          console.info(CONTENT_DEBUG_PREFIX, 'memoQ fill:attempt', {
            ...memoqContext,
            rowNumber: segment.rowNumber,
            domId: segment.domId,
            excelRowIndex: item.excelRowIndex,
            source: segment.sourceRaw,
            targetBeforeScan: segment.targetRaw,
            expectedTranslation: item.translation
          });
        }
        const outcome = await this.fillSegment(segment, item.translation, memoqContext);
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
            await reportRunProgress(runId, {
              scannedCount,
              filledCount: filledDomIds.length,
              plannedFillCount,
              message: 'Cooling down for 20 seconds...'
            });
            await this.waitWithStopChecks(BULK_FILL_PAUSE_MS);
          }

          await reportRunProgress(runId, {
            scannedCount,
            filledCount: filledDomIds.length,
            plannedFillCount
          });

          shouldRescanVisibleSnapshot = shouldRescanAfterSegmentFill(segment, outcome);
        } else if (shouldStopAfterFillFailure(segment.platform)) {
          stopReason =
            segment.platform === 'memoq'
              ? this.describeMemoqStopReason(segment, outcome)
              : describeFillStopReason(segment, outcome);
          await reportRunProgress(runId, {
            scannedCount,
            filledCount: filledDomIds.length,
            plannedFillCount,
            message: stopReason
          });
          return 'stop';
        }

        this.assertNotStopped();
        await delay(this.getInterFillDelayMs(segment));
        if (shouldRescanVisibleSnapshot) {
          return 'rescan';
        }
      },
      {
        maxPasses: normalizeSegmentScanLimit(
          options?.maxPasses,
          DEFAULT_SEGMENT_SCAN_MAX_PASSES
        ),
        maxSegments: normalizeSegmentScanLimit(
          options?.maxSegments,
          DEFAULT_SEGMENT_SCAN_MAX_SEGMENTS
        ),
        restoreScrollPosition: false,
        scanFromTop: options?.scanFromTop === true,
        startFromMarker: options?.startFromMarker === true
      }
    );

    const preFillPreview = summarizePreview(previewItems);
    const result = {
      preview: applyFilledToPreview(preFillPreview, filledDomIds),
      filledCount: filledDomIds.length,
      filledDomIds,
      stoppedByAutoStop,
      autoStopAfterFilledCount,
      stopReason
    };
    if (memoqActive) {
      console.info(CONTENT_DEBUG_PREFIX, 'memoQ fill run:complete', {
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
    this.assertNotStopped();
    if (segment.platform === 'memoq') {
      return platformRuntime.fillSegment(segment, value, memoqContext);
    }

    const currentValue = platformRuntime.getEditableValue(segment);
    if (shouldRejectNonEmptyTarget(segment.platform, currentValue)) {
      return {
        domId: segment.domId,
        filled: false,
        reason: 'Target is no longer empty.'
      };
    }

    return platformRuntime.fillSegment(segment, value);
  }

  private describeMemoqStopReason(segment: RuntimeSegment, outcome: FillOutcome): string {
    if (outcome.diagnostic?.outcome === 'failure') {
      return describeMemoqFillDiagnostic(outcome.diagnostic);
    }

    const rowLabel = segment.rowNumber ? `row ${segment.rowNumber}` : `segment ${segment.domId}`;
    const sourcePreview =
      segment.sourceRaw.length > 80
        ? `${segment.sourceRaw.slice(0, 77)}...`
        : segment.sourceRaw;
    const reason = outcome.reason ?? 'memoQ fill could not be confirmed.';

    return `Stopped at memoQ ${rowLabel}: ${reason} Source="${sourcePreview}"`;
  }

  stopCurrentRun(): void {
    window.__phraseBulkFillStopRequested = true;
  }

  private resetStopState(): void {
    window.__phraseBulkFillStopRequested = false;
  }

  private assertNotStopped(): void {
    if (window.__phraseBulkFillStopRequested) {
      throw new Error(STOP_ERROR_MESSAGE);
    }
  }

  private async waitWithStopChecks(ms: number): Promise<void> {
    let remainingMs = Math.max(0, ms);

    while (remainingMs > 0) {
      this.assertNotStopped();
      const nextDelayMs = Math.min(remainingMs, 250);
      await delay(nextDelayMs);
      remainingMs -= nextDelayMs;
    }

    this.assertNotStopped();
  }

  private getInterFillDelayMs(segment: RuntimeSegment): number {
    return segment.platform === 'memoq'
      ? MEMOQ_INTER_FILL_DELAY_MS
      : DEFAULT_INTER_FILL_DELAY_MS;
  }
}

const adapter = new PlatformDomAdapter();

async function handleRequest(request: ContentRequest): Promise<ApiResponse<unknown>> {
  switch (request.type) {
    case 'CONTENT_SCAN': {
      const segments = await adapter.scanSegments(request.payload.runId, {
        maxPasses: request.payload.maxPasses,
        maxSegments: request.payload.maxSegments,
        scanFromTop: request.payload.scanFromTop
      });
      return { ok: true, data: segments };
    }

    case 'CONTENT_FILL': {
      const result = await adapter.fillAll(
        request.payload.runId,
        request.payload.entries,
        normalizeFillOptions(request.payload?.fillOptions),
        request.payload?.plannedFillCount ?? null,
        {
          maxPasses: request.payload.maxPasses,
          maxSegments: request.payload.maxSegments,
          scanFromTop: request.payload.scanFromTop,
          startFromMarker: true
        }
      );
      return { ok: true, data: result };
    }

    case 'CONTENT_STOP': {
      adapter.stopCurrentRun();
      return { ok: true, data: null };
    }

    default: {
      return { ok: false, error: 'Unsupported content-script request.' };
    }
  }
}

function normalizeAutoStopAfterFilledCount(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return null;
  }

  return Math.floor(value);
}

bindStartMarkerListeners();

replaceRuntimeMessageListener(
  chrome.runtime.onMessage,
  {
    get current() {
      return window.__phraseBulkFillMessageListener;
    },
    set current(listener) {
      window.__phraseBulkFillMessageListener = listener;
    }
  },
  (
    request: ContentRequest,
    _sender: unknown,
    sendResponse: (response: ApiResponse<unknown>) => void
  ) => {
    void (async () => {
      try {
        sendResponse(await handleRequest(request));
      } catch (error) {
        sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : 'Unknown content-script error.'
        });
      }
    })();

    return true;
  }
);
