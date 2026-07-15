import { runtimeSendMessage } from './chrome-api.ts';
import { applyFilledToPreview, classifySegment, createEntryLookup, summarizePreview } from './matcher.ts';
import { ContentScriptDomHelpers } from './content-script-dom.ts';
import type { RuntimeSegment, ScrollContext } from './content-script-dom.ts';
import { normalizeFillOptions } from './fill-options.ts';
import { describeFillStopReason, shouldStopAfterFillFailure } from './fill-failure.ts';
import { BULK_FILL_PAUSE_MS, shouldPauseBulkFillForPlatform } from './fill-throttle.ts';
import { GientTransAdapter } from './platforms/gientrans/adapter.ts';
import { describeMemoqFillDiagnostic } from './platforms/memoq/fill-diagnostics.ts';
import { MemoqAdapter } from './platforms/memoq/adapter.ts';
import {
  findMemoqStartTargetCell,
  readMemoqStartMarkerDomId
} from './platforms/memoq/dom-profile.ts';
import { PhraseAdapter } from './platforms/phrase/adapter.ts';
import {
  hasRepeatedSyntheticSignature,
  isRecentSyntheticDuplicate,
  shouldRescanAfterSegmentFill,
  shouldStopScanBeforeNextScroll
} from './scan-dedupe.ts';
import {
  filterSegmentsFromPendingStartMarker,
  type StartMarker
} from './start-marker.ts';
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
import { delay, normalizeText } from './utils.ts';

declare global {
  interface Window {
    __phraseBulkFillMessageListener?: RuntimeMessageListener<
      ContentRequest,
      ApiResponse<unknown>
    >;
    __phraseBulkFillStartMarker?: StartMarker;
    __phraseBulkFillStartMarkerBound?: boolean;
    __phraseBulkFillStopRequested?: boolean;
  }
}

const CONTENT_DEBUG_PREFIX = '[Phrase Bulk Fill]';
const DEFAULT_MAX_SEGMENTS = 500;
const DEFAULT_MAX_PASSES = 160;
const DEFAULT_SCAN_DELAY_MS = 260;
const MEMOQ_SCAN_DELAY_MS = 120;
const MEMOQ_SYNTHETIC_SCAN_DELAY_MS = 160;
const DEFAULT_INTER_FILL_DELAY_MS = 180;
const MEMOQ_INTER_FILL_DELAY_MS = 320;
const DEFAULT_SCROLL_SETTLE_DELAY_MS = 80;
const MEMOQ_SCROLL_SETTLE_DELAY_MS = 35;
const SCROLL_RATIO = 0.85;
const START_MARKER_MAX_AGE_MS = 30 * 60 * 1000;
const GIENTRANS_START_TARGET_SELECTOR = 'td.target-cell pre.edit__input[editortype="target"]';
const GIENTRANS_START_TARGET_CELL_SELECTOR = 'td.target-cell';
const PHRASE_START_TARGET_SELECTOR = '.twe_target';

const helpers = new ContentScriptDomHelpers();
const memoqAdapter = new MemoqAdapter(helpers);
const gientransAdapter = new GientTransAdapter(helpers);
const phraseAdapter = new PhraseAdapter(helpers);
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
    const runtimeSegments = await this.collectSegments(
      async () => {
        scannedCount += 1;
        if (scannedCount === 1 || scannedCount % 10 === 0) {
          await reportRunProgress(runId, { scannedCount });
        }
      },
      {
        maxPasses: normalizePositiveInteger(options?.maxPasses, DEFAULT_MAX_PASSES),
        maxSegments: normalizePositiveInteger(options?.maxSegments, DEFAULT_MAX_SEGMENTS),
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
    if (memoqAdapter.isActive()) {
      await memoqAdapter.prepareTrustedInput();
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

    console.info(CONTENT_DEBUG_PREFIX, 'fill:start', {
      autoStopAfterFilledCount,
      plannedFillCount,
      maxPasses: options?.maxPasses ?? DEFAULT_MAX_PASSES,
      maxSegments: options?.maxSegments ?? DEFAULT_MAX_SEGMENTS,
      scanFromTop: options?.scanFromTop === true,
      startFromMarker: options?.startFromMarker === true
    });

    await this.collectSegments(
      async (segment) => {
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
          return;
        }

        const outcome = await this.fillSegment(segment, item.translation);
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
        maxPasses: normalizePositiveInteger(options?.maxPasses, DEFAULT_MAX_PASSES),
        maxSegments: normalizePositiveInteger(options?.maxSegments, DEFAULT_MAX_SEGMENTS),
        restoreScrollPosition: false,
        scanFromTop: options?.scanFromTop === true,
        startFromMarker: options?.startFromMarker === true
      }
    );

    const preFillPreview = summarizePreview(previewItems);
    return {
      preview: applyFilledToPreview(preFillPreview, filledDomIds),
      filledCount: filledDomIds.length,
      filledDomIds,
      stoppedByAutoStop,
      autoStopAfterFilledCount,
      stopReason
    };
  }

  private async fillSegment(segment: RuntimeSegment, value: string): Promise<FillOutcome> {
    this.assertNotStopped();
    const currentValue = this.getEditableValue(segment);
    if (segment.platform !== 'gientrans' && normalizeText(currentValue)) {
      return {
        domId: segment.domId,
        filled: false,
        reason: 'Target is no longer empty.'
      };
    }

    if (segment.platform === 'memoq') {
      return memoqAdapter.fillSegment(segment, value);
    }

    if (segment.platform === 'gientrans') {
      return gientransAdapter.fillSegment(segment, value);
    }

    return phraseAdapter.fillSegment(segment, value);
  }

  private getEditableValue(segment: RuntimeSegment): string {
    if (segment.platform === 'memoq') {
      return memoqAdapter.getCurrentEditableValue(segment);
    }

    if (segment.platform === 'gientrans') {
      return gientransAdapter.getEditableValue(segment.targetElement as HTMLElement);
    }

    return phraseAdapter.getEditableValue(segment.targetElement);
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

  private async collectSegments(
    onSegment?: (
      segment: RuntimeSegment
    ) => Promise<'stop' | 'rescan' | void> | 'stop' | 'rescan' | void,
    options?: {
      maxPasses?: number;
      maxSegments?: number;
      restoreScrollPosition?: boolean;
      scanFromTop?: boolean;
      startFromMarker?: boolean;
    }
  ): Promise<RuntimeSegment[]> {
    const scrollContext = this.findScrollContext();
    const maxPasses = options?.maxPasses ?? DEFAULT_MAX_PASSES;
    const maxSegments = options?.maxSegments ?? DEFAULT_MAX_SEGMENTS;
    const shouldRestoreScrollPosition = options?.restoreScrollPosition ?? true;
    const scanDelayMs = this.getScanDelayMs(scrollContext);
    const scrollSettleDelayMs = this.getScrollSettleDelayMs(scrollContext);
    const seenIds = new Set<string>();
    const startMarker = options?.startFromMarker ? readFreshStartMarker() : null;
    const recentSyntheticFingerprints = new WeakMap<
      Element,
      { fingerprint: string; pass: number }
    >();
    const occurrenceCounter = new Map<string, number>();
    const segments: RuntimeSegment[] = [];
    let previousSyntheticSignature = '';
    let repeatedSyntheticSignaturePasses = 0;
    let stopRequestedByCallback = false;
    let rescanRequestedByCallback = false;
    let shouldApplyStartMarker = startMarker !== null;

    if (options?.startFromMarker && !startMarker) {
      console.info(CONTENT_DEBUG_PREFIX, 'fill:start-marker', {
        marker: 'none'
      });
    }

    try {
      if (options?.scanFromTop) {
        scrollContext.scrollToTop();
        await delay(scrollSettleDelayMs);
      }

      let noNewSegmentsPasses = 0;
      let noMovementPasses = 0;

      for (let pass = 0; pass < maxPasses && segments.length < maxSegments; pass += 1) {
        this.assertNotStopped();
        await delay(scanDelayMs);
        this.assertNotStopped();

        const countBefore = segments.length;
        let visibleSegments = this.collectVisibleSegments(scrollContext);
        if (shouldApplyStartMarker && startMarker) {
          const markerFilter = filterSegmentsFromPendingStartMarker(
            visibleSegments,
            startMarker
          );
          const startIndex = markerFilter.startIndex;
          visibleSegments = markerFilter.segments;
          this.debugStartMarker(startMarker, startIndex, countBefore, visibleSegments);
          shouldApplyStartMarker = markerFilter.shouldKeepStartMarker;
        }
        let shouldSkipSyntheticPass = false;
        if (scrollContext.mode === 'synthetic') {
          const syntheticSignature = visibleSegments
            .map((segment) => `${segment.sourceNormalized}=>${segment.targetRaw}`)
            .join('|');
          shouldSkipSyntheticPass = hasRepeatedSyntheticSignature(
            previousSyntheticSignature,
            syntheticSignature
          );
          repeatedSyntheticSignaturePasses =
            shouldSkipSyntheticPass
              ? repeatedSyntheticSignaturePasses + 1
              : 0;
          previousSyntheticSignature = syntheticSignature;
        }

        for (const segment of visibleSegments) {
          this.assertNotStopped();
          if (
            scrollContext.mode === 'synthetic' &&
            shouldSkipSyntheticPass
          ) {
            continue;
          }

          if (
            scrollContext.mode === 'synthetic' &&
            segment.scanElement &&
            segment.scanFingerprint
          ) {
            const previousSyntheticSegment = recentSyntheticFingerprints.get(
              segment.scanElement
            );
            recentSyntheticFingerprints.set(segment.scanElement, {
              fingerprint: segment.scanFingerprint,
              pass
            });

            if (
              isRecentSyntheticDuplicate(
                previousSyntheticSegment,
                segment.scanFingerprint,
                pass
              )
            ) {
              continue;
            }
          }

          if (seenIds.has(segment.domId)) {
            continue;
          }

          seenIds.add(segment.domId);
          const nextOccurrence =
            (occurrenceCounter.get(segment.sourceNormalized) ?? 0) + 1;
          occurrenceCounter.set(segment.sourceNormalized, nextOccurrence);
          segment.occurrenceIndex = nextOccurrence;
          segments.push(segment);

          if (onSegment) {
            const callbackResult = await onSegment(segment);
            if (callbackResult === 'stop') {
              stopRequestedByCallback = true;
              break;
            }
            if (callbackResult === 'rescan') {
              rescanRequestedByCallback = true;
              break;
            }
          }
        }

        if (stopRequestedByCallback || segments.length >= maxSegments) {
          break;
        }

        if (rescanRequestedByCallback) {
          rescanRequestedByCallback = false;
          previousSyntheticSignature = '';
          repeatedSyntheticSignaturePasses = 0;
          noNewSegmentsPasses = 0;
          continue;
        }

        const discoveredCount = segments.length - countBefore;
        noNewSegmentsPasses = discoveredCount === 0 ? noNewSegmentsPasses + 1 : 0;

        const scrollTopBefore = scrollContext.getTop();
        const isAtBottom = scrollContext.isAtBottom();
        const scrollStep = Math.max(scrollContext.getHeight() * SCROLL_RATIO, 240);

        if (
          shouldStopScanBeforeNextScroll({
            scrollMode: scrollContext.mode,
            isAtBottom,
            noNewSegmentsPasses,
            repeatedSyntheticSignaturePasses
          })
        ) {
          break;
        }

        scrollContext.scrollBy(scrollStep);

        await delay(scrollSettleDelayMs);
        this.assertNotStopped();

        const scrollTopAfter = scrollContext.getTop();
        noMovementPasses =
          Math.abs(scrollTopAfter - scrollTopBefore) < 2
            ? noMovementPasses + 1
            : 0;

        if (noMovementPasses >= 5 && noNewSegmentsPasses >= 3) {
          break;
        }
      }

      return segments;
    } finally {
      if (shouldRestoreScrollPosition) {
        scrollContext.restore();
      }
    }
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

  private collectVisibleSegments(scrollContext: ScrollContext): RuntimeSegment[] {
    const memoqSegments = memoqAdapter.collectVisibleSegments(scrollContext);
    if (memoqSegments.length > 0) {
      return memoqSegments;
    }

    const gientransSegments = gientransAdapter.collectVisibleSegments(scrollContext);
    if (gientransSegments.length > 0) {
      return gientransSegments;
    }

    return phraseAdapter.collectVisibleSegments(scrollContext);
  }

  private findScrollContext(): ScrollContext {
    return (
      memoqAdapter.findScrollContext() ??
      gientransAdapter.findScrollContext() ??
      phraseAdapter.findScrollContext() ??
      helpers.toWindowScrollContext()
    );
  }

  private getInterFillDelayMs(segment: RuntimeSegment): number {
    return segment.platform === 'memoq'
      ? MEMOQ_INTER_FILL_DELAY_MS
      : DEFAULT_INTER_FILL_DELAY_MS;
  }

  private getScanDelayMs(scrollContext: ScrollContext): number {
    if (!memoqAdapter.isActive()) {
      return DEFAULT_SCAN_DELAY_MS;
    }

    return scrollContext.mode === 'synthetic'
      ? MEMOQ_SYNTHETIC_SCAN_DELAY_MS
      : MEMOQ_SCAN_DELAY_MS;
  }

  private getScrollSettleDelayMs(scrollContext: ScrollContext): number {
    if (!memoqAdapter.isActive()) {
      return DEFAULT_SCROLL_SETTLE_DELAY_MS;
    }

    return scrollContext.mode === 'synthetic'
      ? DEFAULT_SCROLL_SETTLE_DELAY_MS
      : MEMOQ_SCROLL_SETTLE_DELAY_MS;
  }

  private debugStartMarker(
    marker: StartMarker,
    startIndex: number | null,
    countBefore: number,
    visibleSegments: RuntimeSegment[]
  ): void {
    console.info(CONTENT_DEBUG_PREFIX, 'fill:start-marker', {
      markerDomId: marker.domId ?? null,
      markerAgeMs: marker.setAt ? Date.now() - marker.setAt : null,
      matchedStartIndex: startIndex,
      skippedVisibleSegments: startIndex ?? 0,
      scannedBeforeMarker: countBefore,
      firstVisibleAfterMarker: visibleSegments[0]?.domId ?? null,
      firstVisibleAfterMarkerRow: visibleSegments[0]?.rowNumber ?? null
    });
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

function normalizePositiveInteger(value: number | null | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return fallback;
  }

  return Math.floor(value);
}

function bindStartMarkerListeners(): void {
  if (window.__phraseBulkFillStartMarkerBound) {
    return;
  }

  for (const eventType of ['pointerdown', 'mousedown', 'focusin']) {
    document.addEventListener(eventType, rememberStartMarkerFromEvent, true);
  }

  window.__phraseBulkFillStartMarkerBound = true;
}

function rememberStartMarkerFromEvent(event: Event): void {
  if (!(event.target instanceof Element)) {
    return;
  }

  const targetElement = resolveStartMarkerTargetElement(event.target);
  if (!targetElement) {
    if (isEditorSurfaceElement(event.target)) {
      window.__phraseBulkFillStartMarker = undefined;
    }
    return;
  }

  window.__phraseBulkFillStartMarker = createStartMarker(targetElement);
}

function readFreshStartMarker(): StartMarker | null {
  const marker = window.__phraseBulkFillStartMarker;
  if (marker) {
    if (!marker.setAt || Date.now() - marker.setAt <= START_MARKER_MAX_AGE_MS) {
      return marker;
    }

    window.__phraseBulkFillStartMarker = undefined;
  }

  const activeElement = document.activeElement;
  if (!(activeElement instanceof Element)) {
    return null;
  }

  const targetElement = resolveStartMarkerTargetElement(activeElement);
  if (!targetElement) {
    return null;
  }

  const activeMarker = createStartMarker(targetElement);
  window.__phraseBulkFillStartMarker = activeMarker;
  return activeMarker;
}

function createStartMarker(targetElement: Element): StartMarker {
  return {
    targetElement,
    domId: readLikelyTargetDomId(targetElement),
    setAt: Date.now()
  };
}

function resolveStartMarkerTargetElement(element: Element): Element | null {
  const gientransTarget = element.closest<HTMLElement>(GIENTRANS_START_TARGET_SELECTOR);
  if (gientransTarget) {
    return gientransTarget;
  }

  const gientransTargetCell = element.closest<HTMLElement>(GIENTRANS_START_TARGET_CELL_SELECTOR);
  const gientransCellTarget = gientransTargetCell?.querySelector<HTMLElement>(
    GIENTRANS_START_TARGET_SELECTOR
  );
  if (gientransCellTarget) {
    return gientransCellTarget;
  }

  const phraseTarget = element.closest<HTMLElement>(PHRASE_START_TARGET_SELECTOR);
  if (phraseTarget) {
    return phraseTarget;
  }

  const memoqTarget = findMemoqStartTargetCell(document, element);
  if (memoqTarget) {
    return memoqTarget;
  }

  return null;
}

function readLikelyTargetDomId(targetElement: Element): string | null {
  const memoqRowId = readMemoqStartMarkerDomId(document, targetElement);
  if (memoqRowId) {
    return memoqRowId;
  }

  const gientransTarget =
    targetElement.matches(GIENTRANS_START_TARGET_SELECTOR)
      ? targetElement
      : targetElement.querySelector(GIENTRANS_START_TARGET_SELECTOR);
  const gientransSegmentId = gientransTarget?.getAttribute('segid');
  if (gientransSegmentId) {
    return gientransSegmentId;
  }

  const phraseRow = targetElement.closest<HTMLElement>(
    '.segment-row[role="row"], .segment-row, .twe_segment'
  );
  return firstNonEmptyAttribute(phraseRow, ['id', 'data-position', 'data-row']) ??
    firstNonEmptyAttribute(targetElement, ['id', 'data-position', 'data-row']);
}

function firstNonEmptyAttribute(
  element: Element | null | undefined,
  names: string[]
): string | null {
  if (!element) {
    return null;
  }

  for (const name of names) {
    const value = element.getAttribute(name);
    if (value) {
      return value;
    }
  }

  return null;
}

function isEditorSurfaceElement(element: Element): boolean {
  return Boolean(
    element.closest(
      '#o-editor.online-editor, .editor__table, .segment-row, .twe_segment'
    ) || findMemoqStartTargetCell(document, element)
  );
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
