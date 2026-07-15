import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ContentRunService,
  STOP_ERROR_MESSAGE,
  type ContentRunServicePort
} from '../content/run-service.ts';
import type { RuntimeSegment, ScrollContext } from '../content/types.ts';

function makeSegment(): RuntimeSegment {
  return {
    domId: 'phrase-1',
    sourceRaw: 'Source',
    sourceNormalized: 'Source',
    occurrenceIndex: 99,
    targetRaw: '',
    isEmptyTarget: true,
    placeholderTokens: [],
    targetElement: {} as HTMLElement,
    platform: 'phrase',
    phraseUsesTagMarkup: true,
    scanElement: {} as Element,
    scanFingerprint: 'runtime-only'
  };
}

function createHarness(options: { stopDuringDelay?: boolean } = {}) {
  const segment = makeSegment();
  const progress: Array<{
    runId: string;
    scannedCount?: number;
  }> = [];
  let stopRequested = true;
  let restoreCalls = 0;
  const scrollContext: ScrollContext = {
    initialTop: 0,
    mode: 'native',
    getTop: () => 0,
    getHeight: () => 600,
    scrollBy() {},
    scrollToTop() {},
    isAtBottom: () => true,
    restore() {
      restoreCalls += 1;
    }
  };
  const port: ContentRunServicePort = {
    runtime: {
      isMemoqActive: () => false,
      async prepareMemoqTrustedInput() {},
      findScrollContext: () => scrollContext,
      collectVisibleSegments: () => [segment],
      getEditableValue: () => '',
      async fillSegment(nextSegment) {
        return { domId: nextSegment.domId, filled: true };
      }
    },
    async reportProgress(runId, report) {
      progress.push({ runId, scannedCount: report.scannedCount });
    },
    isStopRequested: () => stopRequested,
    setStopRequested: (value) => {
      stopRequested = value;
    },
    async delay() {
      if (options.stopDuringDelay) {
        stopRequested = true;
      }
    },
    readFreshStartMarker: () => null,
    clearStartMarker() {},
    now: () => 0,
    logInfo() {},
    logWarn() {},
    logError() {}
  };

  return {
    service: new ContentRunService(port),
    progress,
    isStopRequested: () => stopRequested,
    getRestoreCalls: () => restoreCalls
  };
}

test('ContentRunService resets stop state and returns serializable scan data', async () => {
  const harness = createHarness();
  harness.service.stopCurrentRun();
  assert.equal(harness.isStopRequested(), true);

  const segments = await harness.service.scanSegments('scan-1');

  assert.equal(harness.isStopRequested(), false);
  assert.equal(segments.length, 1);
  assert.equal(segments[0]?.occurrenceIndex, 1);
  assert.equal('targetElement' in (segments[0] ?? {}), false);
  assert.equal('scanElement' in (segments[0] ?? {}), false);
  assert.equal('scanFingerprint' in (segments[0] ?? {}), false);
  assert.equal('phraseUsesTagMarkup' in (segments[0] ?? {}), false);
  assert.deepEqual(harness.progress, [
    { runId: 'scan-1', scannedCount: 1 },
    { runId: 'scan-1', scannedCount: 1 }
  ]);
  assert.equal(harness.getRestoreCalls(), 1);
});

test('ContentRunService aborts when stop is requested during a scan delay', async () => {
  const harness = createHarness({ stopDuringDelay: true });
  let scanError: unknown;

  try {
    await harness.service.scanSegments('scan-stop');
  } catch (error) {
    scanError = error;
  }

  assert.equal(
    scanError instanceof Error ? scanError.message : null,
    STOP_ERROR_MESSAGE
  );
  assert.equal(harness.getRestoreCalls(), 1);
  assert.deepEqual(harness.progress, []);
});
