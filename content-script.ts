import { applyFilledToPreview, classifySegment, createEntryLookup, summarizePreview } from './matcher.ts';
import { ContentScriptDomHelpers } from './content-script-dom.ts';
import type { RuntimeSegment, ScrollContext } from './content-script-dom.ts';
import { MemoqAdapter } from './memoq-adapter.ts';
import { PhraseAdapter } from './phrase-adapter.ts';
import { hasRepeatedSyntheticSignature, isRecentSyntheticDuplicate } from './scan-dedupe.ts';
import type {
  ApiResponse,
  ContentRequest,
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
  }
}

const MAX_SEGMENTS = 500;
const MAX_PASSES = 160;
const SCAN_DELAY_MS = 260;
const SCROLL_RATIO = 0.85;

const helpers = new ContentScriptDomHelpers();
const memoqAdapter = new MemoqAdapter(helpers);
const phraseAdapter = new PhraseAdapter(helpers);

class PlatformDomAdapter {
  async scanSegments(): Promise<PageSegment[]> {
    const runtimeSegments = await this.collectSegments();
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

  async fillAll(entries: TranslationEntry[]): Promise<FillRunResult> {
    const entryLookup = createEntryLookup(entries);
    const previewItems: PreviewItem[] = [];
    const filledDomIds: string[] = [];

    await this.collectSegments(async (segment) => {
      const item = classifySegment(entryLookup, segment);
      previewItems.push(item);

      if (item.status !== 'ready' || !item.translation) {
        return;
      }

      const outcome = await this.fillSegment(segment, item.translation);
      if (outcome.filled) {
        filledDomIds.push(outcome.domId);
      }
    });

    const preFillPreview = summarizePreview(previewItems);
    return {
      preview: applyFilledToPreview(preFillPreview, filledDomIds),
      filledCount: filledDomIds.length,
      filledDomIds
    };
  }

  private async fillSegment(segment: RuntimeSegment, value: string): Promise<FillOutcome> {
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
    onSegment?: (segment: RuntimeSegment) => Promise<void> | void
  ): Promise<RuntimeSegment[]> {
    const scrollContext = this.findScrollContext();
    const seenIds = new Set<string>();
    const recentSyntheticFingerprints = new WeakMap<
      Element,
      { fingerprint: string; pass: number }
    >();
    const occurrenceCounter = new Map<string, number>();
    const segments: RuntimeSegment[] = [];
    let previousSyntheticSignature = '';
    let repeatedSyntheticSignaturePasses = 0;

    try {
      let noNewSegmentsPasses = 0;
      let noMovementPasses = 0;

      for (let pass = 0; pass < MAX_PASSES && segments.length < MAX_SEGMENTS; pass += 1) {
        await delay(SCAN_DELAY_MS);

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
            await onSegment(segment);
          }
        }

        if (segments.length >= MAX_SEGMENTS) {
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
      scrollContext.restore();
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
      const result = await adapter.fillAll(request.payload.entries);
      return { ok: true, data: result };
    }

    default: {
      return { ok: false, error: 'Unsupported content-script request.' };
    }
  }
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
