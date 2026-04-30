import { runtimeSendMessage } from './chrome-api.ts';
import { applyFilledToPreview, classifySegment, createEntryLookup, summarizePreview } from './matcher.ts';
import { ContentScriptDomHelpers } from './content-script-dom.ts';
import type { RuntimeSegment, ScrollContext } from './content-script-dom.ts';
import { resolvePagePlatform } from './editor-platform.ts';
import { normalizeFillOptions } from './fill-options.ts';
import { BULK_FILL_PAUSE_MS, shouldPauseBulkFill } from './fill-throttle.ts';
import {
  type MemoqCursorSegment,
  type MemoqCursorVisitedSegment,
  TARGET_NO_LONGER_EMPTY_REASON,
  runMemoqCursorFill
} from './memoq-fill.ts';
import { MemoqAdapter } from './memoq-adapter.ts';
import {
  buildMemoqFailureSummary,
  logMemoqDiagnostic,
  NOOP_MEMOQ_DIAGNOSTICS
} from './memoq-debug.ts';
import type {
  MemoqDiagnosticLevel,
  MemoqDiagnosticStage,
  MemoqDiagnostics
} from './memoq-debug.ts';
import { PhraseAdapter } from './phrase-adapter.ts';
import { hasRepeatedSyntheticSignature, isRecentSyntheticDuplicate } from './scan-dedupe.ts';
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
    __phraseBulkFillListenerBound?: boolean;
    __phraseBulkFillStopRequested?: boolean;
  }
}

const MAX_SEGMENTS = 500;
const MAX_PASSES = 160;
const DEFAULT_SCAN_DELAY_MS = 260;
const MEMOQ_SCAN_DELAY_MS = 120;
const MEMOQ_SYNTHETIC_SCAN_DELAY_MS = 160;
const DEFAULT_INTER_FILL_DELAY_MS = 180;
const MEMOQ_INTER_FILL_DELAY_MS = 40;
const DEFAULT_SCROLL_SETTLE_DELAY_MS = 80;
const MEMOQ_SCROLL_SETTLE_DELAY_MS = 35;
const SCROLL_RATIO = 0.85;

const helpers = new ContentScriptDomHelpers();
const memoqAdapter = new MemoqAdapter(helpers);
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

class MemoqRunDiagnostics implements MemoqDiagnostics {
  private lastSummary = '';

  constructor(private readonly runId: string) {}

  info(stage: MemoqDiagnosticStage, message: string, details?: Record<string, unknown>): void {
    this.log('info', stage, message, details);
  }

  warn(stage: MemoqDiagnosticStage, message: string, details?: Record<string, unknown>): void {
    this.log('warn', stage, message, details);
  }

  error(stage: MemoqDiagnosticStage, message: string, details?: Record<string, unknown>): void {
    this.log('error', stage, message, details);
  }

  summary(stage: MemoqDiagnosticStage, message: string): void {
    const summary = buildMemoqFailureSummary(stage, message);
    if (summary === this.lastSummary) {
      return;
    }

    this.lastSummary = summary;
    void reportRunProgress(this.runId, {
      message: summary
    });
  }

  private log(
    level: MemoqDiagnosticLevel,
    stage: MemoqDiagnosticStage,
    message: string,
    details?: Record<string, unknown>
  ): void {
    logMemoqDiagnostic(
      {
        scope: 'content',
        runId: this.runId
      },
      stage,
      message,
      details,
      level
    );
  }
}

class PlatformDomAdapter {
  async scanSegments(runId: string): Promise<PageSegment[]> {
    this.resetStopState();
    const platform = this.detectPlatform();
    const diagnostics = this.createDiagnostics(platform, runId);

    this.logPlatform(platform, diagnostics);

    const runtimeSegments =
      platform === 'memoq'
        ? await this.scanMemoqSegments(runId, diagnostics)
        : await this.scanPhraseSegments(runId);

    this.assertMemoqSegmentsFound(platform, runtimeSegments, diagnostics);
    await reportRunProgress(runId, { scannedCount: runtimeSegments.length });

    return runtimeSegments.map(
      ({
        targetElement: _targetElement,
        platform: _platform,
        scanElement: _scanElement,
        scanFingerprint: _scanFingerprint,
        ...segment
      }) => segment
    );
  }

  async fillAll(
    runId: string,
    entries: TranslationEntry[],
    fillOptions: FillOptions,
    plannedFillCount: number | null
  ): Promise<FillRunResult> {
    this.resetStopState();
    const platform = this.detectPlatform();
    const diagnostics = this.createDiagnostics(platform, runId);

    this.logPlatform(platform, diagnostics);

    return platform === 'memoq'
      ? this.fillMemoqSegments(
          runId,
          entries,
          fillOptions,
          plannedFillCount,
          diagnostics
        )
      : this.fillPhraseSegments(
          runId,
          entries,
          fillOptions,
          plannedFillCount,
          diagnostics
        );
  }

  private async fillSegment(
    segment: RuntimeSegment,
    value: string,
    diagnostics: MemoqDiagnostics
  ): Promise<FillOutcome> {
    this.assertNotStopped();
    const currentValue = this.getEditableValue(segment);
    if (normalizeText(currentValue)) {
      return {
        domId: segment.domId,
        filled: false,
        reason: TARGET_NO_LONGER_EMPTY_REASON
      };
    }

    if (segment.platform === 'memoq') {
      return memoqAdapter.fillSegment(segment, value, diagnostics);
    }

    return phraseAdapter.fillSegment(segment, value);
  }

  private getEditableValue(segment: RuntimeSegment): string {
    if (segment.platform === 'memoq') {
      return memoqAdapter.getEditableValue(segment.targetElement as HTMLElement);
    }

    return phraseAdapter.getEditableValue(segment.targetElement);
  }

  private toMemoqCursorSegment(
    segment: RuntimeSegment
  ): MemoqCursorSegment<RuntimeSegment> {
    return {
      segment,
      domId: segment.domId,
      sourceRaw: segment.sourceRaw,
      sourceNormalized: segment.sourceNormalized,
      targetRaw: segment.targetRaw,
      isEmptyTarget: segment.isEmptyTarget,
      placeholderTokens: [...segment.placeholderTokens]
    };
  }

  private toRuntimeSegment(
    segment: MemoqCursorVisitedSegment<RuntimeSegment>
  ): RuntimeSegment {
    return {
      ...segment.segment,
      domId: segment.domId,
      sourceRaw: segment.sourceRaw,
      sourceNormalized: segment.sourceNormalized,
      occurrenceIndex: segment.occurrenceIndex,
      targetRaw: segment.targetRaw,
      isEmptyTarget: segment.isEmptyTarget,
      placeholderTokens: [...segment.placeholderTokens]
    };
  }

  private async scanPhraseSegments(runId: string): Promise<RuntimeSegment[]> {
    let scannedCount = 0;

    return this.collectSegments(
      async () => {
        scannedCount += 1;
        if (scannedCount === 1 || scannedCount % 10 === 0) {
          await reportRunProgress(runId, { scannedCount });
        }
      },
      {
        restoreScrollPosition: true
      }
    );
  }

  private async scanMemoqSegments(
    runId: string,
    diagnostics: MemoqDiagnostics
  ): Promise<RuntimeSegment[]> {
    return this.collectMemoqSegments(
      diagnostics,
      async (batchSegments, metadata) => {
        if (
          metadata.totalSegments === batchSegments.length ||
          metadata.totalSegments % 10 === 0
        ) {
          await reportRunProgress(runId, {
            scannedCount: metadata.totalSegments
          });
        }
      },
      {
        restoreScrollPosition: true
      }
    );
  }

  private async fillPhraseSegments(
    runId: string,
    entries: TranslationEntry[],
    fillOptions: FillOptions,
    plannedFillCount: number | null,
    diagnostics: MemoqDiagnostics
  ): Promise<FillRunResult> {
    const entryLookup = createEntryLookup(entries);
    const previewItems: PreviewItem[] = [];
    const filledDomIds: string[] = [];
    const normalizedFillOptions = normalizeFillOptions(fillOptions);
    const autoStopAfterFilledCount = normalizeAutoStopAfterFilledCount(
      normalizedFillOptions.autoStopAfterFilledCount
    );
    let stoppedByAutoStop = false;

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

        const outcome = await this.fillSegment(segment, item.translation, diagnostics);
        if (outcome.filled) {
          filledDomIds.push(outcome.domId);
          if (
            autoStopAfterFilledCount !== null &&
            filledDomIds.length >= autoStopAfterFilledCount
          ) {
            stoppedByAutoStop = true;
            return 'stop';
          }

          if (shouldPauseBulkFill(plannedFillCount, filledDomIds.length)) {
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
        }

        this.assertNotStopped();
        await delay(this.getInterFillDelayMs(segment));
      },
      {
        restoreScrollPosition: false
      }
    );

    const preFillPreview = summarizePreview(previewItems);
    return {
      preview: applyFilledToPreview(preFillPreview, filledDomIds),
      filledCount: filledDomIds.length,
      filledDomIds,
      failedCount: 0,
      failures: [],
      stoppedByAutoStop,
      autoStopAfterFilledCount
    };
  }

  private async fillMemoqSegments(
    runId: string,
    entries: TranslationEntry[],
    fillOptions: FillOptions,
    plannedFillCount: number | null,
    diagnostics: MemoqDiagnostics
  ): Promise<FillRunResult> {
    const entryLookup = createEntryLookup(entries);
    const normalizedFillOptions = normalizeFillOptions(fillOptions);
    const autoStopAfterFilledCount = normalizeAutoStopAfterFilledCount(
      normalizedFillOptions.autoStopAfterFilledCount
    );
    let scannedCount = 0;
    const scrollContext = this.findScrollContext('memoq', diagnostics);
    let currentViewport = memoqAdapter.captureMemoqFillViewport(scrollContext, diagnostics);
    if (currentViewport.rows.length === 0) {
      const reason = 'memoQ fill could not capture any visible rows.';
      diagnostics.error('navigate', reason, {
        activeElement:
          document.activeElement instanceof Element
            ? document.activeElement.tagName.toLowerCase()
            : '(none)'
      });
      diagnostics.summary('navigate', reason);
      throw new Error(`${reason} Check the page console for memoQ diagnostics.`);
    }

    const fillStart = memoqAdapter.resolveMemoqFillStart(currentViewport, diagnostics);
    if (!fillStart) {
      const reason =
        'Could not uniquely resolve the current memoQ starting row. Select the starting segment and try again.';
      diagnostics.error('navigate', reason, {
        activeElement:
          document.activeElement instanceof Element
            ? document.activeElement.tagName.toLowerCase()
            : '(none)'
      });
      diagnostics.summary('navigate', reason);
      throw new Error(`${reason} Check the page console for memoQ diagnostics.`);
    }
    let currentCursorState = fillStart.cursorState;

    const cursorResult = await runMemoqCursorFill({
      initialSegment: this.toMemoqCursorSegment(fillStart.segment),
      classify: (segment) =>
        classifySegment(
          entryLookup,
          this.toRuntimeSegment(segment),
          normalizedFillOptions
        ),
      shouldFill: (item) => item.status === 'ready' && Boolean(item.translation),
      getTranslation: (item) => item.translation ?? null,
      advance: async () => {
        this.assertNotStopped();
        const next = await memoqAdapter.advanceMemoqFillCursor(
          currentCursorState,
          currentViewport,
          scrollContext,
          diagnostics
        );
        currentViewport = next.viewport;
        if (next.cursorState) {
          currentCursorState = next.cursorState;
        }
        return {
          reachedEnd: next.reachedEnd,
          segment: next.segment ? this.toMemoqCursorSegment(next.segment) : null
        };
      },
      fillSegment: async (segment, translation, attemptNumber) => {
        this.assertNotStopped();
        if (attemptNumber > 1) {
          diagnostics.info('write', 'Retrying memoQ fill after a failed attempt.', {
            domId: segment.domId,
            attemptNumber
          });
        }

        const runtimeSegment = this.toRuntimeSegment(segment);
        const outcome = await this.fillSegment(runtimeSegment, translation, diagnostics);

        if (outcome.filled) {
          currentViewport = memoqAdapter.updateMemoqFillViewportRow(
            currentViewport,
            currentCursorState,
            translation
          );
          currentCursorState = {
            ...currentCursorState,
            rowFingerprint:
              currentViewport.rows[currentCursorState.viewportIndex]?.rowFingerprint ??
              currentCursorState.rowFingerprint
          };
          return outcome;
        }

        if (outcome.reason === TARGET_NO_LONGER_EMPTY_REASON) {
          currentViewport = memoqAdapter.updateMemoqFillViewportRow(
            currentViewport,
            currentCursorState,
            this.getEditableValue(runtimeSegment)
          );
          currentCursorState = {
            ...currentCursorState,
            rowFingerprint:
              currentViewport.rows[currentCursorState.viewportIndex]?.rowFingerprint ??
              currentCursorState.rowFingerprint
          };
        }

        return outcome;
      },
      autoStopAfterFilledCount,
      onVisited: async (event) => {
        scannedCount = event.processedCount;
        if (event.processedCount === 1 || event.processedCount % 10 === 0) {
          await reportRunProgress(runId, {
            scannedCount: event.processedCount,
            filledCount: event.filledCount,
            plannedFillCount
          });
        }
      },
      onAttemptFailure: async (event) => {
        diagnostics.warn(
          'write',
          event.willRetry
            ? 'memoQ fill attempt failed; retrying the same segment.'
            : 'memoQ fill attempt failed; continuing to the next segment.',
          {
            domId: event.segment.domId,
            attemptNumber: event.attemptNumber,
            maxAttempts: event.maxAttempts,
            reason: event.outcome.reason ?? 'Unknown memoQ fill failure.'
          }
        );
      },
      onFilled: async (event) => {
        if (event.stoppedByAutoStop) {
          return;
        }

        if (shouldPauseBulkFill(plannedFillCount, event.filledCount)) {
          await reportRunProgress(runId, {
            scannedCount,
            filledCount: event.filledCount,
            plannedFillCount,
            message: 'Cooling down for 20 seconds...'
          });
          await this.waitWithStopChecks(BULK_FILL_PAUSE_MS);
        }

        await reportRunProgress(runId, {
          scannedCount,
          filledCount: event.filledCount,
          plannedFillCount
        });
      },
      onSettled: async (event) => {
        if (event.stoppedByAutoStop) {
          return;
        }

        await this.waitWithStopChecks(this.getInterFillDelayMs(this.toRuntimeSegment(event.segment)));
      }
    });

    const preFillPreview = summarizePreview(cursorResult.items);
    return {
      preview: applyFilledToPreview(preFillPreview, cursorResult.filledDomIds),
      filledCount: cursorResult.filledDomIds.length,
      filledDomIds: cursorResult.filledDomIds,
      failedCount: cursorResult.failures.length,
      failures: cursorResult.failures,
      stoppedByAutoStop: cursorResult.stoppedByAutoStop,
      autoStopAfterFilledCount
    };
  }

  private async collectSegments(
    onSegment?: (segment: RuntimeSegment) => Promise<'stop' | void> | 'stop' | void,
    options?: {
      restoreScrollPosition?: boolean;
    }
  ): Promise<RuntimeSegment[]> {
    const scrollContext = phraseAdapter.findScrollContext() ?? helpers.toWindowScrollContext();
    const shouldRestoreScrollPosition = options?.restoreScrollPosition ?? true;
    const scanDelayMs = DEFAULT_SCAN_DELAY_MS;
    const scrollSettleDelayMs = DEFAULT_SCROLL_SETTLE_DELAY_MS;
    const seenIds = new Set<string>();
    const recentSyntheticFingerprints = new WeakMap<
      Element,
      { fingerprint: string; pass: number }
    >();
    const occurrenceCounter = new Map<string, number>();
    const segments: RuntimeSegment[] = [];
    let previousSyntheticSignature = '';
    let repeatedSyntheticSignaturePasses = 0;
    let stopRequestedByCallback = false;

    try {
      let noNewSegmentsPasses = 0;
      let noMovementPasses = 0;

      for (let pass = 0; pass < MAX_PASSES && segments.length < MAX_SEGMENTS; pass += 1) {
        this.assertNotStopped();
        await delay(scanDelayMs);
        this.assertNotStopped();

        const countBefore = segments.length;
        const visibleSegments = phraseAdapter.collectVisibleSegments(scrollContext);
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
          if (scrollContext.mode === 'synthetic' && shouldSkipSyntheticPass) {
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
          }
        }

        const discoveredCount = segments.length - countBefore;
        noNewSegmentsPasses = discoveredCount === 0 ? noNewSegmentsPasses + 1 : 0;

        const scrollTopBefore = scrollContext.getTop();
        const isAtBottom = scrollContext.isAtBottom();
        const scrollStep = Math.max(scrollContext.getHeight() * SCROLL_RATIO, 240);

        if (stopRequestedByCallback) {
          break;
        }

        if (segments.length >= MAX_SEGMENTS) {
          break;
        }

        if (isAtBottom && noNewSegmentsPasses >= 3) {
          break;
        }

        if (
          scrollContext.mode === 'synthetic' &&
          (noNewSegmentsPasses >= 4 || repeatedSyntheticSignaturePasses >= 2)
        ) {
          break;
        }

        if (!isAtBottom) {
          scrollContext.scrollBy(scrollStep);
        } else {
          scrollContext.scrollBy(Math.max(scrollStep / 2, 120));
        }

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

  private async collectMemoqSegments(
    diagnostics: MemoqDiagnostics,
    onBatch?: (
      segments: RuntimeSegment[],
      metadata: {
        totalSegments: number;
        pass: number;
      }
    ) => Promise<'stop' | void> | 'stop' | void,
    options?: {
      restoreScrollPosition?: boolean;
    }
  ): Promise<RuntimeSegment[]> {
    const scrollContext = this.findScrollContext('memoq', diagnostics);
    const shouldRestoreScrollPosition = options?.restoreScrollPosition ?? true;
    const scanDelayMs = this.getScanDelayMs('memoq', scrollContext);
    const scrollSettleDelayMs = this.getScrollSettleDelayMs('memoq', scrollContext);
    const seenIds = new Set<string>();
    const recentSyntheticFingerprints = new WeakMap<
      Element,
      { fingerprint: string; pass: number }
    >();
    const occurrenceCounter = new Map<string, number>();
    const segments: RuntimeSegment[] = [];
    let previousSyntheticSignature = '';
    let repeatedSyntheticSignaturePasses = 0;
    let stopRequestedByCallback = false;

    try {
      let noNewSegmentsPasses = 0;
      let noMovementPasses = 0;

      for (let pass = 0; pass < MAX_PASSES && segments.length < MAX_SEGMENTS; pass += 1) {
        this.assertNotStopped();
        await delay(scanDelayMs);
        this.assertNotStopped();

        diagnostics.info('scan', 'Starting memoQ scan pass.', {
          pass: pass + 1,
          knownSegments: segments.length,
          scrollMode: scrollContext.mode ?? 'native'
        });

        const countBefore = segments.length;
        const visibleSegments = memoqAdapter.collectVisibleSegments(scrollContext, diagnostics);
        let shouldSkipSyntheticPass = false;
        if (scrollContext.mode === 'synthetic') {
          const syntheticSignature = visibleSegments
            .map((segment) => `${segment.domId}=>${segment.scanFingerprint ?? ''}`)
            .join('|');
          shouldSkipSyntheticPass = hasRepeatedSyntheticSignature(
            previousSyntheticSignature,
            syntheticSignature
          );
          repeatedSyntheticSignaturePasses = shouldSkipSyntheticPass
            ? repeatedSyntheticSignaturePasses + 1
            : 0;
          previousSyntheticSignature = syntheticSignature;
        }

        const eligibleSegments: RuntimeSegment[] = [];
        for (const segment of visibleSegments) {
          this.assertNotStopped();
          if (scrollContext.mode === 'synthetic' && shouldSkipSyntheticPass) {
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

          eligibleSegments.push(segment);
        }

        const discoveredBatch: RuntimeSegment[] = [];
        for (const segment of eligibleSegments) {
          if (seenIds.has(segment.domId)) {
            continue;
          }

          seenIds.add(segment.domId);
          const nextOccurrence =
            (occurrenceCounter.get(segment.sourceNormalized) ?? 0) + 1;
          occurrenceCounter.set(segment.sourceNormalized, nextOccurrence);
          segment.occurrenceIndex = nextOccurrence;
          discoveredBatch.push(segment);
        }
        segments.push(...discoveredBatch);

        if (discoveredBatch.length > 0 && onBatch) {
          const callbackResult = await onBatch(discoveredBatch, {
            totalSegments: segments.length,
            pass: pass + 1
          });
          if (callbackResult === 'stop') {
            stopRequestedByCallback = true;
          }
        }

        const discoveredCount = segments.length - countBefore;
        noNewSegmentsPasses = discoveredCount === 0 ? noNewSegmentsPasses + 1 : 0;

        const scrollTopBefore = scrollContext.getTop();
        const isAtBottom = scrollContext.isAtBottom();
        const scrollStep = Math.max(scrollContext.getHeight() * SCROLL_RATIO, 240);

        diagnostics.info('scan', 'Finished memoQ scan pass.', {
          pass: pass + 1,
          visibleSegments: visibleSegments.length,
          discoveredCount,
          totalSegments: segments.length,
          shouldSkipSyntheticPass,
          repeatedSyntheticSignaturePasses,
          noNewSegmentsPasses,
          isAtBottom
        });

        if (stopRequestedByCallback) {
          diagnostics.info('scan', 'Stopping memoQ scan because the callback requested it.', {
            pass: pass + 1,
            totalSegments: segments.length
          });
          break;
        }

        if (segments.length >= MAX_SEGMENTS) {
          diagnostics.warn('scan', 'Stopping memoQ scan after hitting the segment limit.', {
            maxSegments: MAX_SEGMENTS
          });
          break;
        }

        if (isAtBottom && noNewSegmentsPasses >= 3) {
          diagnostics.info('scan', 'Stopping memoQ scan at the bottom after repeated empty passes.', {
            pass: pass + 1,
            noNewSegmentsPasses
          });
          break;
        }

        if (
          scrollContext.mode === 'synthetic' &&
          (noNewSegmentsPasses >= 4 || repeatedSyntheticSignaturePasses >= 2)
        ) {
          diagnostics.warn(
            'scan',
            'Stopping memoQ synthetic scan after repeated duplicate passes.',
            {
              pass: pass + 1,
              noNewSegmentsPasses,
              repeatedSyntheticSignaturePasses
            }
          );
          break;
        }

        if (!isAtBottom) {
          scrollContext.scrollBy(scrollStep);
        } else {
          scrollContext.scrollBy(Math.max(scrollStep / 2, 120));
        }

        await delay(scrollSettleDelayMs);
        this.assertNotStopped();

        const scrollTopAfter = scrollContext.getTop();
        noMovementPasses =
          Math.abs(scrollTopAfter - scrollTopBefore) < 2
            ? noMovementPasses + 1
            : 0;

        if (noMovementPasses >= 5 && noNewSegmentsPasses >= 3) {
          diagnostics.warn('scan', 'Stopping memoQ scan after repeated passes without movement.', {
            pass: pass + 1,
            noMovementPasses,
            noNewSegmentsPasses,
            scrollTopBefore,
            scrollTopAfter
          });
          break;
        }
      }

      diagnostics.info('scan', 'Completed memoQ scan run.', {
        totalSegments: segments.length
      });

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

  private findScrollContext(
    platform: 'memoq' | 'phrase',
    diagnostics: MemoqDiagnostics
  ): ScrollContext {
    if (platform === 'memoq') {
      const scrollContext = memoqAdapter.findScrollContext(diagnostics);
      if (scrollContext) {
        return scrollContext;
      }

      diagnostics.warn('scroll-context', 'Falling back to the window scroll context for memoQ.', {
        url: window.location.href
      });
      return helpers.toWindowScrollContext();
    }

    return phraseAdapter.findScrollContext() ?? helpers.toWindowScrollContext();
  }

  private getInterFillDelayMs(segment: RuntimeSegment): number {
    return segment.platform === 'memoq'
      ? MEMOQ_INTER_FILL_DELAY_MS
      : DEFAULT_INTER_FILL_DELAY_MS;
  }

  private getScanDelayMs(platform: 'memoq' | 'phrase', scrollContext: ScrollContext): number {
    if (platform !== 'memoq') {
      return DEFAULT_SCAN_DELAY_MS;
    }

    return scrollContext.mode === 'synthetic'
      ? MEMOQ_SYNTHETIC_SCAN_DELAY_MS
      : MEMOQ_SCAN_DELAY_MS;
  }

  private getScrollSettleDelayMs(
    platform: 'memoq' | 'phrase',
    scrollContext: ScrollContext
  ): number {
    if (platform !== 'memoq') {
      return DEFAULT_SCROLL_SETTLE_DELAY_MS;
    }

    return scrollContext.mode === 'synthetic'
      ? DEFAULT_SCROLL_SETTLE_DELAY_MS
      : MEMOQ_SCROLL_SETTLE_DELAY_MS;
  }

  private detectPlatform(): 'memoq' | 'phrase' {
    return resolvePagePlatform(window.location.href, memoqAdapter.isActive());
  }

  private createDiagnostics(
    platform: 'memoq' | 'phrase',
    runId: string
  ): MemoqDiagnostics {
    return platform === 'memoq' ? new MemoqRunDiagnostics(runId) : NOOP_MEMOQ_DIAGNOSTICS;
  }

  private logPlatform(platform: 'memoq' | 'phrase', diagnostics: MemoqDiagnostics): void {
    if (platform !== 'memoq') {
      return;
    }

    diagnostics.info('platform', 'Resolved memoQ as the active editor platform.', {
      url: window.location.href,
      hasEditorCells: memoqAdapter.isActive()
    });
  }

  private assertMemoqSegmentsFound(
    platform: 'memoq' | 'phrase',
    runtimeSegments: RuntimeSegment[],
    diagnostics: MemoqDiagnostics
  ): void {
    if (platform !== 'memoq' || runtimeSegments.length > 0) {
      return;
    }

    const reason = memoqAdapter.buildScanFailureReason();
    diagnostics.error('scan', reason, {
      ...memoqAdapter.getLastScanObservation()
    });
    diagnostics.summary('scan', reason);
    throw new Error(`${reason} Check the page console for memoQ diagnostics.`);
  }
}

const adapter = new PlatformDomAdapter();

async function handleRequest(request: ContentRequest): Promise<ApiResponse<unknown>> {
  switch (request.type) {
    case 'CONTENT_SCAN': {
      const segments = await adapter.scanSegments(request.payload.runId);
      return { ok: true, data: segments };
    }

    case 'CONTENT_FILL': {
      const result = await adapter.fillAll(
        request.payload.runId,
        request.payload.entries,
        normalizeFillOptions(request.payload?.fillOptions),
        request.payload?.plannedFillCount ?? null
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

if (!window.__phraseBulkFillListenerBound) {
  chrome.runtime.onMessage.addListener(
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

  window.__phraseBulkFillListenerBound = true;
}
