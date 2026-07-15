import { runtimeSendMessage } from './shared/chrome-api.ts';
import { ContentScriptDomHelpers } from './content/dom.ts';
import { normalizeFillOptions } from './domain/fill-options.ts';
import { FillRunner } from './content/fill-runner.ts';
import { createPlatformRuntime } from './platforms/runtime.ts';
import {
  bindStartMarkerListeners,
  clearStartMarker,
  readFreshStartMarker
} from './content/start-marker-dom.ts';
import {
  DEFAULT_SEGMENT_SCAN_MAX_PASSES,
  DEFAULT_SEGMENT_SCAN_MAX_SEGMENTS,
  normalizeSegmentScanLimit,
  SegmentScanner
} from './content/segment-scanner.ts';
import {
  replaceRuntimeMessageListener,
  type RuntimeMessageListener
} from './content/runtime-listener.ts';
import type {
  ApiResponse,
  BackgroundRequest,
  ContentRequest
} from './shared/message-types.ts';
import type {
  FillOptions,
  FillRunResult,
  PageSegment,
  TranslationEntry
} from './shared/translation-types.ts';
import { delay } from './shared/utils.ts';

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

  private readonly fillRunner = new FillRunner({
    scanner: this.segmentScanner,
    runtime: platformRuntime,
    reportProgress: reportRunProgress,
    assertNotStopped: () => this.assertNotStopped(),
    waitWithStopChecks: (delayMs) => this.waitWithStopChecks(delayMs),
    delay,
    logInfo: (label, payload) => console.info(CONTENT_DEBUG_PREFIX, label, payload),
    logWarn: (label, payload) => console.warn(CONTENT_DEBUG_PREFIX, label, payload),
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
    return this.fillRunner.run(
      runId,
      entries,
      fillOptions,
      plannedFillCount,
      options
    );
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
