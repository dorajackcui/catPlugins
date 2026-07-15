import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeSegment } from '../content/dom.ts';
import {
  FillRunner,
  type FillRunProgress,
  type FillRunnerPort,
  type FillRunnerRuntime,
  type FillRunnerScanner
} from '../content/fill-runner.ts';
import type { MemoqFillExecutionContext } from '../platforms/runtime.ts';
import type {
  FillOutcome,
  TranslationEntry
} from '../types.ts';

type CallbackResult = 'stop' | 'rescan' | 'continue';

function makeSegment(
  platform: RuntimeSegment['platform'],
  domId: string,
  sourceRaw: string,
  targetRaw = ''
): RuntimeSegment {
  return {
    domId,
    sourceRaw,
    sourceNormalized: sourceRaw,
    occurrenceIndex: 1,
    targetRaw,
    isEmptyTarget: targetRaw === '',
    placeholderTokens: [],
    targetElement: {} as HTMLElement,
    platform
  };
}

function makeEntries(segments: RuntimeSegment[]): TranslationEntry[] {
  return segments.map((segment, index) => ({
    rowIndex: index + 2,
    sourceRaw: segment.sourceRaw,
    sourceNormalized: segment.sourceNormalized,
    targetRaw: `Translation ${index + 1}`,
    occurrenceIndex: segment.occurrenceIndex
  }));
}

function createHarness(options: {
  segments: RuntimeSegment[];
  currentValues?: Record<string, string>;
  outcomes?: Record<string, FillOutcome>;
  memoqActive?: boolean;
  prepareError?: Error;
}) {
  const events: string[] = [];
  const callbackResults: CallbackResult[] = [];
  const fillCalls: Array<{
    domId: string;
    value: string;
    context?: MemoqFillExecutionContext;
  }> = [];
  const editableReads: string[] = [];
  const progressReports: Array<{ runId: string; progress: FillRunProgress }> = [];
  const delays: number[] = [];
  const stopAwareWaits: number[] = [];
  const infoLogs: Array<{ label: string; payload: Record<string, unknown> }> = [];
  const warningLogs: Array<{ label: string; payload: Record<string, unknown> }> = [];
  const errorLogs: Array<{ label: string; payload: Record<string, unknown> }> = [];
  let assertNotStoppedCalls = 0;
  let scannerOptions: Parameters<FillRunnerScanner['collect']>[1];

  const scanner: FillRunnerScanner = {
    async collect(onSegment, nextScannerOptions) {
      scannerOptions = nextScannerOptions;
      for (const [index, segment] of options.segments.entries()) {
        events.push(`scan:${segment.domId}`);
        const result = await onSegment?.(segment, {
          scanPass: index + 1,
          scrollTop: 100 + index,
          scrollMode: index % 2 === 0 ? 'native' : 'synthetic'
        });
        callbackResults.push(result ?? 'continue');
        if (result === 'stop') {
          break;
        }
      }
      return options.segments;
    }
  };

  const runtime: FillRunnerRuntime = {
    isMemoqActive: () => options.memoqActive === true,
    async prepareMemoqTrustedInput() {
      events.push('prepare');
      if (options.prepareError) {
        throw options.prepareError;
      }
    },
    getEditableValue(segment) {
      editableReads.push(segment.domId);
      return options.currentValues?.[segment.domId] ?? '';
    },
    async fillSegment(segment, value, context) {
      events.push(`fill:${segment.domId}`);
      fillCalls.push({ domId: segment.domId, value, context });
      return (
        options.outcomes?.[segment.domId] ?? {
          domId: segment.domId,
          filled: true
        }
      );
    }
  };

  const port: FillRunnerPort = {
    scanner,
    runtime,
    async reportProgress(runId, progress) {
      progressReports.push({ runId, progress });
    },
    assertNotStopped() {
      assertNotStoppedCalls += 1;
    },
    async waitWithStopChecks(delayMs) {
      stopAwareWaits.push(delayMs);
    },
    async delay(delayMs) {
      delays.push(delayMs);
    },
    logInfo(label, payload) {
      infoLogs.push({ label, payload });
    },
    logWarn(label, payload) {
      warningLogs.push({ label, payload });
    },
    logError(label, payload) {
      errorLogs.push({ label, payload });
    }
  };

  return {
    runner: new FillRunner(port),
    events,
    callbackResults,
    fillCalls,
    editableReads,
    progressReports,
    delays,
    stopAwareWaits,
    infoLogs,
    warningLogs,
    errorLogs,
    getAssertNotStoppedCalls: () => assertNotStoppedCalls,
    getScannerOptions: () => scannerOptions
  };
}

test('FillRunner preserves memoQ preparation, platform routing, and fill timing', async () => {
  const segments = [
    makeSegment('memoq', 'memoq-1', 'MemoQ source'),
    makeSegment('gientrans', 'gientrans-1', 'GientTrans source', 'Existing target'),
    makeSegment('phrase', 'phrase-1', 'Phrase source')
  ];
  const harness = createHarness({
    segments,
    memoqActive: true,
    currentValues: {
      'gientrans-1': 'Existing target'
    }
  });

  const result = await harness.runner.run(
    'run-1',
    makeEntries(segments),
    { autoStopAfterFilledCount: null, validatePlaceholders: false },
    3,
    {
      maxPasses: 7.8,
      maxSegments: 9.2,
      scanFromTop: true,
      startFromMarker: true
    }
  );

  assert.deepEqual(harness.events, [
    'prepare',
    'scan:memoq-1',
    'fill:memoq-1',
    'scan:gientrans-1',
    'fill:gientrans-1',
    'scan:phrase-1',
    'fill:phrase-1'
  ]);
  assert.deepEqual(harness.editableReads, ['gientrans-1', 'phrase-1']);
  assert.deepEqual(
    harness.fillCalls.map(({ domId, value }) => ({ domId, value })),
    [
      { domId: 'memoq-1', value: 'Translation 1' },
      { domId: 'gientrans-1', value: 'Translation 2' },
      { domId: 'phrase-1', value: 'Translation 3' }
    ]
  );
  assert.deepEqual(harness.fillCalls[0]?.context, {
    runId: 'run-1',
    sequence: 1,
    scanPass: 1,
    scrollTop: 100,
    scrollMode: 'native'
  });
  assert.equal(harness.fillCalls[1]?.context, undefined);
  assert.equal(harness.fillCalls[2]?.context, undefined);
  assert.deepEqual(harness.callbackResults, ['rescan', 'continue', 'rescan']);
  assert.deepEqual(harness.delays, [320, 180, 180]);
  assert.deepEqual(harness.getScannerOptions(), {
    maxPasses: 7,
    maxSegments: 9,
    restoreScrollPosition: false,
    scanFromTop: true,
    startFromMarker: true
  });
  assert.deepEqual(result.filledDomIds, ['memoq-1', 'gientrans-1', 'phrase-1']);
  assert.equal(result.filledCount, 3);
  assert.equal(result.preview.totalSegments, 3);
  assert.equal(result.stopReason, undefined);
  assert.equal(harness.infoLogs[0]?.label, 'memoQ fill run:start');
  assert.equal(harness.infoLogs.at(-1)?.label, 'memoQ fill run:complete');
  assert.equal(harness.getAssertNotStoppedCalls(), 6);
});

test('FillRunner stops Phrase when a target becomes non-empty before writing', async () => {
  const segment = makeSegment('phrase', 'phrase-1', 'Phrase source');
  const harness = createHarness({
    segments: [segment],
    currentValues: {
      'phrase-1': 'Changed after scan'
    }
  });

  const result = await harness.runner.run(
    'run-phrase',
    makeEntries([segment]),
    { autoStopAfterFilledCount: null, validatePlaceholders: false },
    1
  );

  assert.deepEqual(harness.fillCalls, []);
  assert.deepEqual(harness.callbackResults, ['stop']);
  assert.deepEqual(harness.delays, []);
  assert.equal(result.filledCount, 0);
  assert.equal(
    result.stopReason,
    'Stopped at Phrase segment phrase-1: Target is no longer empty. Source="Phrase source"'
  );
  assert.equal(
    harness.progressReports.at(-1)?.progress.message,
    result.stopReason
  );
});

test('FillRunner keeps GientTrans failures non-fatal and continues scanning', async () => {
  const segments = [
    makeSegment('gientrans', 'gientrans-1', 'First source'),
    makeSegment('gientrans', 'gientrans-2', 'Second source')
  ];
  const harness = createHarness({
    segments,
    outcomes: {
      'gientrans-1': {
        domId: 'gientrans-1',
        filled: false,
        reason: 'First write failed.'
      }
    }
  });

  const result = await harness.runner.run(
    'run-gientrans',
    makeEntries(segments),
    { autoStopAfterFilledCount: null, validatePlaceholders: false },
    2
  );

  assert.deepEqual(
    harness.fillCalls.map(({ domId }) => domId),
    ['gientrans-1', 'gientrans-2']
  );
  assert.deepEqual(harness.callbackResults, ['continue', 'continue']);
  assert.deepEqual(harness.delays, [180, 180]);
  assert.deepEqual(result.filledDomIds, ['gientrans-2']);
  assert.equal(result.stopReason, undefined);
});

test('FillRunner auto-stops at the normalized successful-fill limit', async () => {
  const segments = [
    makeSegment('phrase', 'phrase-1', 'First source'),
    makeSegment('phrase', 'phrase-2', 'Second source'),
    makeSegment('phrase', 'phrase-3', 'Third source')
  ];
  const harness = createHarness({ segments });

  const result = await harness.runner.run(
    'run-auto-stop',
    makeEntries(segments),
    { autoStopAfterFilledCount: 2.9, validatePlaceholders: false },
    3
  );

  assert.deepEqual(
    harness.fillCalls.map(({ domId }) => domId),
    ['phrase-1', 'phrase-2']
  );
  assert.deepEqual(harness.callbackResults, ['rescan', 'stop']);
  assert.deepEqual(harness.delays, [180]);
  assert.equal(result.stoppedByAutoStop, true);
  assert.equal(result.autoStopAfterFilledCount, 2);
  assert.equal(result.filledCount, 2);
  assert.equal(result.preview.totalSegments, 2);
});

test('FillRunner keeps the 200-fill stop-aware cooldown for large non-Phrase runs', async () => {
  const segments = Array.from({ length: 200 }, (_, index) =>
    makeSegment('gientrans', `gientrans-${index + 1}`, `Source ${index + 1}`)
  );
  const harness = createHarness({ segments });

  const result = await harness.runner.run(
    'run-cooldown',
    makeEntries(segments),
    { autoStopAfterFilledCount: null, validatePlaceholders: false },
    301
  );

  assert.equal(result.filledCount, 200);
  assert.deepEqual(harness.stopAwareWaits, [20_000]);
  assert.equal(
    harness.progressReports.some(
      ({ progress }) => progress.message === 'Cooling down for 20 seconds...'
    ),
    true
  );
  assert.equal(harness.delays.length, 200);
  assert.equal(harness.delays.every((delayMs) => delayMs === 180), true);
});

test('FillRunner reports memoQ prepare failures before scanning', async () => {
  const segment = makeSegment('memoq', 'memoq-1', 'MemoQ source');
  const harness = createHarness({
    segments: [segment],
    memoqActive: true,
    prepareError: new Error('Debugger attach failed.')
  });
  let runError: unknown;

  try {
    await harness.runner.run(
      'run-prepare-failure',
      makeEntries([segment]),
      { autoStopAfterFilledCount: null, validatePlaceholders: false },
      1
    );
  } catch (error) {
    runError = error;
  }

  assert.equal(
    runError instanceof Error ? runError.message : null,
    'Debugger attach failed.'
  );
  assert.deepEqual(harness.events, ['prepare']);
  assert.equal(harness.errorLogs[0]?.label, 'memoQ debugger:prepare-failure');
  assert.equal(
    harness.errorLogs[0]?.payload.error,
    'Debugger attach failed.'
  );
});
