import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeSegment, ScrollContext } from '../content-script-dom.ts';
import {
  normalizeSegmentScanLimit,
  SegmentScanner,
  type SegmentScanContext,
  type SegmentScannerPort
} from '../segment-scanner.ts';
import type { StartMarker } from '../start-marker.ts';

class FakeScrollContext implements ScrollContext {
  readonly scrollDeltas: number[] = [];
  scrollToTopCalls = 0;
  restoreCalls = 0;
  private top: number;

  constructor(
    readonly initialTop: number,
    readonly mode: 'native' | 'synthetic',
    private readonly height: number,
    private readonly bottomCheck: () => boolean
  ) {
    this.top = initialTop;
  }

  getTop(): number {
    return this.top;
  }

  getHeight(): number {
    return this.height;
  }

  scrollBy(delta: number): void {
    this.scrollDeltas.push(delta);
    this.top += delta;
  }

  scrollToTop(): void {
    this.scrollToTopCalls += 1;
    this.top = 0;
  }

  isAtBottom(): boolean {
    return this.bottomCheck();
  }

  restore(): void {
    this.restoreCalls += 1;
    this.top = this.initialTop;
  }
}

function makeSegment(
  domId: string,
  sourceNormalized = 'same source',
  targetRaw = ''
): RuntimeSegment {
  return {
    domId,
    sourceRaw: sourceNormalized,
    sourceNormalized,
    occurrenceIndex: 0,
    targetRaw,
    isEmptyTarget: targetRaw === '',
    placeholderTokens: [],
    targetElement: {} as HTMLElement,
    platform: 'phrase'
  };
}

function createHarness(options: {
  snapshots: RuntimeSegment[][];
  mode?: 'native' | 'synthetic';
  isMemoqActive?: boolean;
  initialTop?: number;
  height?: number;
  isAtBottom?: (collectionCount: number) => boolean;
  marker?: StartMarker | null;
}) {
  let collectionCount = 0;
  let clearMarkerCalls = 0;
  const delays: number[] = [];
  const infoLogs: Array<{ label: string; payload: Record<string, unknown> }> = [];
  const errorLogs: Array<{ label: string; payload: Record<string, unknown> }> = [];
  const scrollContext = new FakeScrollContext(
    options.initialTop ?? 0,
    options.mode ?? 'native',
    options.height ?? 100,
    () => options.isAtBottom?.(collectionCount) ?? true
  );

  const port: SegmentScannerPort = {
    findScrollContext: () => scrollContext,
    collectVisibleSegments: () => {
      const snapshot =
        options.snapshots[
          Math.min(collectionCount, Math.max(0, options.snapshots.length - 1))
        ] ?? [];
      collectionCount += 1;
      return snapshot;
    },
    isMemoqActive: () => options.isMemoqActive ?? false,
    assertNotStopped: () => undefined,
    delay: async (delayMs) => {
      delays.push(delayMs);
    },
    readFreshStartMarker: () => options.marker ?? null,
    clearStartMarker: () => {
      clearMarkerCalls += 1;
    },
    now: () => 1000,
    logInfo: (label, payload) => {
      infoLogs.push({ label, payload });
    },
    logError: (label, payload) => {
      errorLogs.push({ label, payload });
    }
  };

  return {
    scanner: new SegmentScanner(port),
    scrollContext,
    delays,
    infoLogs,
    errorLogs,
    get collectionCount() {
      return collectionCount;
    },
    get clearMarkerCalls() {
      return clearMarkerCalls;
    }
  };
}

test('SegmentScanner scans from the top, assigns occurrences, and restores scrolling', async () => {
  const first = makeSegment('a');
  const second = makeSegment('b');
  const harness = createHarness({
    snapshots: [[first, second]],
    initialTop: 50
  });
  const contexts: SegmentScanContext[] = [];

  const segments = await harness.scanner.collect(
    (_segment, context) => {
      contexts.push(context);
    },
    { scanFromTop: true }
  );

  assert.deepEqual(segments.map((segment) => segment.domId), ['a', 'b']);
  assert.deepEqual(segments.map((segment) => segment.occurrenceIndex), [1, 2]);
  assert.deepEqual(contexts, [
    { scanPass: 1, scrollTop: 0, scrollMode: 'native' },
    { scanPass: 1, scrollTop: 0, scrollMode: 'native' }
  ]);
  assert.deepEqual(harness.delays, [80, 260]);
  assert.equal(harness.scrollContext.scrollToTopCalls, 1);
  assert.equal(harness.scrollContext.restoreCalls, 1);
  assert.equal(harness.scrollContext.getTop(), 50);
});

test('SegmentScanner rescans the current snapshot before scrolling', async () => {
  const first = makeSegment('a');
  const second = makeSegment('b');
  const harness = createHarness({
    snapshots: [
      [first, second],
      [first, second]
    ]
  });
  const visited: string[] = [];

  const segments = await harness.scanner.collect(
    (segment) => {
      visited.push(segment.domId);
      return segment.domId === 'a' ? 'rescan' : undefined;
    },
    { restoreScrollPosition: false }
  );

  assert.deepEqual(visited, ['a', 'b']);
  assert.deepEqual(segments.map((segment) => segment.domId), ['a', 'b']);
  assert.equal(harness.collectionCount, 2);
  assert.deepEqual(harness.scrollContext.scrollDeltas, []);
  assert.equal(harness.scrollContext.restoreCalls, 0);
});

test('SegmentScanner stops immediately when the segment callback requests it', async () => {
  const harness = createHarness({
    snapshots: [[makeSegment('a'), makeSegment('b')]],
    isAtBottom: () => false
  });

  const segments = await harness.scanner.collect(() => 'stop');

  assert.deepEqual(segments.map((segment) => segment.domId), ['a']);
  assert.equal(harness.collectionCount, 1);
  assert.deepEqual(harness.scrollContext.scrollDeltas, []);
  assert.equal(harness.scrollContext.restoreCalls, 1);
});

test('SegmentScanner advances native scrolling with the existing timing policy', async () => {
  const harness = createHarness({
    snapshots: [[makeSegment('a')], [makeSegment('b', 'other source')]],
    isAtBottom: (collectionCount) => collectionCount >= 2
  });
  const contexts: SegmentScanContext[] = [];

  const segments = await harness.scanner.collect((_segment, context) => {
    contexts.push(context);
  });

  assert.deepEqual(segments.map((segment) => segment.domId), ['a', 'b']);
  assert.deepEqual(harness.scrollContext.scrollDeltas, [240]);
  assert.deepEqual(harness.delays, [260, 80, 260]);
  assert.deepEqual(contexts.map((context) => context.scrollTop), [0, 240]);
});

test('SegmentScanner preserves memoQ native scan and settle delays', async () => {
  const harness = createHarness({
    snapshots: [[makeSegment('a')], [makeSegment('b', 'other source')]],
    isMemoqActive: true,
    isAtBottom: (collectionCount) => collectionCount >= 2
  });

  await harness.scanner.collect();

  assert.deepEqual(harness.delays, [120, 35, 120]);
});

test('SegmentScanner starts at the selected marker within a visible snapshot', async () => {
  const harness = createHarness({
    snapshots: [[makeSegment('a'), makeSegment('b'), makeSegment('c')]],
    marker: { domId: 'b', setAt: 900 }
  });

  const segments = await harness.scanner.collect(undefined, {
    startFromMarker: true
  });

  assert.deepEqual(segments.map((segment) => segment.domId), ['b', 'c']);
  assert.equal(harness.clearMarkerCalls, 0);
  assert.equal(harness.infoLogs[0]?.label, 'fill:start-marker');
  assert.deepEqual(harness.infoLogs[0]?.payload, {
    markerDomId: 'b',
    markerAgeMs: 100,
    matchedStartIndex: 1,
    skippedVisibleSegments: 1,
    scannedBeforeMarker: 0,
    firstVisibleAfterMarker: 'b',
    firstVisibleAfterMarkerRow: null
  });
});

test('SegmentScanner clears and reports an unresolved start marker', async () => {
  const harness = createHarness({
    snapshots: [[makeSegment('a')]],
    marker: { domId: 'missing', setAt: 900 }
  });
  let scanError: unknown;

  try {
    await harness.scanner.collect(undefined, { startFromMarker: true });
  } catch (error) {
    scanError = error;
  }

  assert.equal(
    scanError instanceof Error ? scanError.message : null,
    'Could not find the selected start row missing. Click the desired editor row and run Fill again.'
  );
  assert.equal(harness.clearMarkerCalls, 1);
  assert.equal(harness.scrollContext.restoreCalls, 1);
  assert.equal(harness.errorLogs[0]?.label, 'fill:start-marker-missing');
  assert.deepEqual(harness.errorLogs[0]?.payload, {
    markerDomId: 'missing',
    markerAgeMs: 100,
    scannedCount: 0,
    scrollTop: 0,
    scrollMode: 'native'
  });
});

test('SegmentScanner stops synthetic traversal after repeated snapshots', async () => {
  const segment = makeSegment('a');
  const harness = createHarness({
    snapshots: [[segment], [segment], [segment]],
    mode: 'synthetic',
    isMemoqActive: true,
    isAtBottom: () => false
  });

  const segments = await harness.scanner.collect(undefined, { maxPasses: 10 });

  assert.deepEqual(segments.map((item) => item.domId), ['a']);
  assert.equal(harness.collectionCount, 3);
  assert.deepEqual(harness.scrollContext.scrollDeltas, [240, 240]);
  assert.deepEqual(harness.delays, [160, 80, 160, 80, 160]);
});

test('normalizeSegmentScanLimit preserves the existing positive-integer rules', () => {
  assert.equal(normalizeSegmentScanLimit(undefined, 160), 160);
  assert.equal(normalizeSegmentScanLimit(0.5, 160), 160);
  assert.equal(normalizeSegmentScanLimit(3.9, 160), 3);
  assert.equal(normalizeSegmentScanLimit(Number.NaN, 160), 160);
});
