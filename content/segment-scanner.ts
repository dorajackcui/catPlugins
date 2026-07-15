import type { RuntimeSegment, ScrollContext } from './dom.ts';
import {
  hasRepeatedSyntheticSignature,
  isRecentSyntheticDuplicate,
  shouldStopScanBeforeNextScroll
} from './scan-dedupe.ts';
import {
  filterSegmentsFromPendingStartMarker,
  hasUnresolvedStartMarker,
  type StartMarker
} from './start-marker.ts';

export const DEFAULT_SEGMENT_SCAN_MAX_SEGMENTS = 500;
export const DEFAULT_SEGMENT_SCAN_MAX_PASSES = 160;

const DEFAULT_SCAN_DELAY_MS = 260;
const MEMOQ_SCAN_DELAY_MS = 120;
const MEMOQ_SYNTHETIC_SCAN_DELAY_MS = 160;
const DEFAULT_SCROLL_SETTLE_DELAY_MS = 80;
const MEMOQ_SCROLL_SETTLE_DELAY_MS = 35;
const SCROLL_RATIO = 0.85;

export interface SegmentScanContext {
  scanPass: number;
  scrollTop: number;
  scrollMode: 'native' | 'synthetic';
}

export type SegmentScanCallback = (
  segment: RuntimeSegment,
  context: SegmentScanContext
) => Promise<'stop' | 'rescan' | void> | 'stop' | 'rescan' | void;

export interface SegmentScanOptions {
  maxPasses?: number;
  maxSegments?: number;
  restoreScrollPosition?: boolean;
  scanFromTop?: boolean;
  startFromMarker?: boolean;
}

export interface SegmentScannerPort {
  findScrollContext(): ScrollContext;
  collectVisibleSegments(scrollContext: ScrollContext): RuntimeSegment[];
  isMemoqActive(): boolean;
  assertNotStopped(): void;
  delay(delayMs: number): Promise<void>;
  readFreshStartMarker(): StartMarker | null;
  clearStartMarker(): void;
  now(): number;
  logInfo(label: string, payload: Record<string, unknown>): void;
  logError(label: string, payload: Record<string, unknown>): void;
}

/**
 * Drives platform-neutral segment discovery across native and synthetic
 * scrolling surfaces. Platform adapters only provide visible snapshots and
 * the scanner owns traversal, deduplication, and callback flow control.
 */
export class SegmentScanner {
  constructor(private readonly port: SegmentScannerPort) {}

  async collect(
    onSegment?: SegmentScanCallback,
    options: SegmentScanOptions = {}
  ): Promise<RuntimeSegment[]> {
    const scrollContext = this.port.findScrollContext();
    const maxPasses = options.maxPasses ?? DEFAULT_SEGMENT_SCAN_MAX_PASSES;
    const maxSegments = options.maxSegments ?? DEFAULT_SEGMENT_SCAN_MAX_SEGMENTS;
    const shouldRestoreScrollPosition = options.restoreScrollPosition ?? true;
    const scanDelayMs = this.getScanDelayMs(scrollContext);
    const scrollSettleDelayMs = this.getScrollSettleDelayMs(scrollContext);
    const seenIds = new Set<string>();
    const startMarker = options.startFromMarker
      ? this.port.readFreshStartMarker()
      : null;
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

    if (options.startFromMarker && !startMarker) {
      this.port.logInfo('fill:start-marker', {
        marker: 'none'
      });
    }

    try {
      if (options.scanFromTop) {
        scrollContext.scrollToTop();
        await this.port.delay(scrollSettleDelayMs);
      }

      let noNewSegmentsPasses = 0;
      let noMovementPasses = 0;

      for (let pass = 0; pass < maxPasses && segments.length < maxSegments; pass += 1) {
        this.port.assertNotStopped();
        await this.port.delay(scanDelayMs);
        this.port.assertNotStopped();

        const countBefore = segments.length;
        let visibleSegments = this.port.collectVisibleSegments(scrollContext);
        if (shouldApplyStartMarker && startMarker) {
          const markerFilter = filterSegmentsFromPendingStartMarker(
            visibleSegments,
            startMarker
          );
          const startIndex = markerFilter.startIndex;
          visibleSegments = markerFilter.segments;
          this.debugStartMarker(
            startMarker,
            startIndex,
            countBefore,
            visibleSegments
          );
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
          repeatedSyntheticSignaturePasses = shouldSkipSyntheticPass
            ? repeatedSyntheticSignaturePasses + 1
            : 0;
          previousSyntheticSignature = syntheticSignature;
        }

        for (const segment of visibleSegments) {
          this.port.assertNotStopped();
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
            const callbackResult = await onSegment(segment, {
              scanPass: pass + 1,
              scrollTop: scrollContext.getTop(),
              scrollMode: scrollContext.mode ?? 'native'
            });
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

        await this.port.delay(scrollSettleDelayMs);
        this.port.assertNotStopped();

        const scrollTopAfter = scrollContext.getTop();
        noMovementPasses =
          Math.abs(scrollTopAfter - scrollTopBefore) < 2
            ? noMovementPasses + 1
            : 0;

        if (noMovementPasses >= 5 && noNewSegmentsPasses >= 3) {
          break;
        }
      }

      if (hasUnresolvedStartMarker(startMarker, shouldApplyStartMarker)) {
        const message = startMarker?.domId
          ? `Could not find the selected start row ${startMarker.domId}. Click the desired editor row and run Fill again.`
          : 'Could not find the selected start row. Click the desired editor row and run Fill again.';
        this.port.logError('fill:start-marker-missing', {
          markerDomId: startMarker?.domId ?? null,
          markerAgeMs: startMarker?.setAt
            ? this.port.now() - startMarker.setAt
            : null,
          scannedCount: segments.length,
          scrollTop: scrollContext.getTop(),
          scrollMode: scrollContext.mode ?? 'native'
        });
        this.port.clearStartMarker();
        throw new Error(message);
      }

      return segments;
    } finally {
      if (shouldRestoreScrollPosition) {
        scrollContext.restore();
      }
    }
  }

  private getScanDelayMs(scrollContext: ScrollContext): number {
    if (!this.port.isMemoqActive()) {
      return DEFAULT_SCAN_DELAY_MS;
    }

    return scrollContext.mode === 'synthetic'
      ? MEMOQ_SYNTHETIC_SCAN_DELAY_MS
      : MEMOQ_SCAN_DELAY_MS;
  }

  private getScrollSettleDelayMs(scrollContext: ScrollContext): number {
    if (!this.port.isMemoqActive()) {
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
    this.port.logInfo('fill:start-marker', {
      markerDomId: marker.domId ?? null,
      markerAgeMs: marker.setAt ? this.port.now() - marker.setAt : null,
      matchedStartIndex: startIndex,
      skippedVisibleSegments: startIndex ?? 0,
      scannedBeforeMarker: countBefore,
      firstVisibleAfterMarker: visibleSegments[0]?.domId ?? null,
      firstVisibleAfterMarkerRow: visibleSegments[0]?.rowNumber ?? null
    });
  }
}

export function normalizeSegmentScanLimit(
  value: number | null | undefined,
  fallback: number
): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    return fallback;
  }

  return Math.floor(value);
}
