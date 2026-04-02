import { applyFilledToPreview, classifySegment, createEntryLookup, summarizePreview } from './matcher.ts';
import { ContentScriptDomHelpers } from './content-script-dom.ts';
import type { RuntimeSegment, ScrollContext } from './content-script-dom.ts';
import { normalizeFillOptions } from './fill-options.ts';
import { MemoqAdapter } from './memoq-adapter.ts';
import { PhraseAdapter } from './phrase-adapter.ts';
import { hasRepeatedSyntheticSignature, isRecentSyntheticDuplicate } from './scan-dedupe.ts';
import type {
  ApiResponse,
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
const SCAN_DELAY_MS = 260;
const INTER_FILL_DELAY_MS = 180;
const SCROLL_RATIO = 0.85;

const helpers = new ContentScriptDomHelpers();
const memoqAdapter = new MemoqAdapter(helpers);
const phraseAdapter = new PhraseAdapter(helpers);
const STOP_ERROR_MESSAGE = 'Operation stopped by user.';

class PlatformDomAdapter {
  async scanSegments(): Promise<PageSegment[]> {
    this.resetStopState();
    const runtimeSegments = await this.collectSegments(undefined, {
      restoreScrollPosition: true
    });
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
    entries: TranslationEntry[],
    fillOptions: FillOptions
  ): Promise<FillRunResult> {
    this.resetStopState();
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
        const item = classifySegment(entryLookup, segment);
        previewItems.push(item);

        if (item.status !== 'ready' || !item.translation) {
          return;
        }

        const outcome = await this.fillSegment(segment, item.translation);
        if (outcome.filled) {
          filledDomIds.push(outcome.domId);
          if (
            autoStopAfterFilledCount !== null &&
            filledDomIds.length >= autoStopAfterFilledCount
          ) {
            stoppedByAutoStop = true;
            return 'stop';
          }
        }

        this.assertNotStopped();
        await delay(INTER_FILL_DELAY_MS);
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
      stoppedByAutoStop,
      autoStopAfterFilledCount
    };
  }

  private async fillSegment(segment: RuntimeSegment, value: string): Promise<FillOutcome> {
    this.assertNotStopped();
    const currentValue = this.getEditableValue(segment);
    if (normalizeText(currentValue)) {
      return {
        domId: segment.domId,
        filled: false,
        reason: 'Target is no longer empty.'
      };
    }

    if (segment.platform === 'memoq') {
      return memoqAdapter.fillSegment(segment, value);
    }

    return phraseAdapter.fillSegment(segment, value);
  }

  private getEditableValue(segment: RuntimeSegment): string {
    if (segment.platform === 'memoq') {
      return memoqAdapter.getEditableValue(segment.targetElement as HTMLElement);
    }

    return phraseAdapter.getEditableValue(segment.targetElement);
  }

  private async collectSegments(
    onSegment?: (segment: RuntimeSegment) => Promise<'stop' | void> | 'stop' | void,
    options?: {
      restoreScrollPosition?: boolean;
    }
  ): Promise<RuntimeSegment[]> {
    const scrollContext = this.findScrollContext();
    const shouldRestoreScrollPosition = options?.restoreScrollPosition ?? true;
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
        await delay(SCAN_DELAY_MS);
        this.assertNotStopped();

        const countBefore = segments.length;
        const visibleSegments = this.collectVisibleSegments(scrollContext);
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
          }
        }

        if (stopRequestedByCallback || segments.length >= MAX_SEGMENTS) {
          break;
        }

        const discoveredCount = segments.length - countBefore;
        noNewSegmentsPasses = discoveredCount === 0 ? noNewSegmentsPasses + 1 : 0;

        const scrollTopBefore = scrollContext.getTop();
        const isAtBottom = scrollContext.isAtBottom();
        const scrollStep = Math.max(scrollContext.getHeight() * SCROLL_RATIO, 240);

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

        await delay(80);
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

  private collectVisibleSegments(scrollContext: ScrollContext): RuntimeSegment[] {
    const memoqSegments = memoqAdapter.collectVisibleSegments(scrollContext);
    if (memoqSegments.length > 0) {
      return memoqSegments;
    }

    return phraseAdapter.collectVisibleSegments(scrollContext);
  }

  private findScrollContext(): ScrollContext {
    return (
      memoqAdapter.findScrollContext() ??
      phraseAdapter.findScrollContext() ??
      helpers.toWindowScrollContext()
    );
  }
}

const adapter = new PlatformDomAdapter();

async function handleRequest(request: ContentRequest): Promise<ApiResponse<unknown>> {
  switch (request.type) {
    case 'CONTENT_SCAN': {
      const segments = await adapter.scanSegments();
      return { ok: true, data: segments };
    }

    case 'CONTENT_FILL': {
      const result = await adapter.fillAll(
        request.payload.entries,
        normalizeFillOptions(request.payload?.fillOptions)
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
