import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ContentRequestHandler,
  type ContentRequestService
} from '../content/request-handler.ts';
import type {
  FillRunResult,
  PageSegment,
  TranslationEntry
} from '../shared/translation-types.ts';

function makeSegment(): PageSegment {
  return {
    domId: 'phrase-1',
    sourceRaw: 'Source',
    sourceNormalized: 'Source',
    occurrenceIndex: 1,
    targetRaw: '',
    isEmptyTarget: true,
    placeholderTokens: [],
    platform: 'phrase'
  };
}

function makeFillResult(): FillRunResult {
  return {
    preview: {
      totalSegments: 0,
      matched: 0,
      alreadyTranslated: 0,
      placeholderErrors: 0,
      readyToFill: 0,
      skipped: 0,
      items: [],
      generatedAt: '2026-07-15T00:00:00.000Z'
    },
    filledCount: 0,
    filledDomIds: [],
    stoppedByAutoStop: false,
    autoStopAfterFilledCount: null
  };
}

function createHarness() {
  const segments = [makeSegment()];
  const fillResult = makeFillResult();
  let scanCall: Parameters<ContentRequestService['scanSegments']> | undefined;
  let fillCall: Parameters<ContentRequestService['fillAll']> | undefined;
  let stopCalls = 0;
  const service: ContentRequestService = {
    async scanSegments(...args) {
      scanCall = args;
      return segments;
    },
    async fillAll(...args) {
      fillCall = args;
      return fillResult;
    },
    stopCurrentRun() {
      stopCalls += 1;
    }
  };

  return {
    handler: new ContentRequestHandler(service),
    segments,
    fillResult,
    getScanCall: () => scanCall,
    getFillCall: () => fillCall,
    getStopCalls: () => stopCalls
  };
}

test('ContentRequestHandler forwards scan limits and direction', async () => {
  const harness = createHarness();

  const response = await harness.handler.handle({
    type: 'CONTENT_SCAN',
    payload: {
      runId: 'scan-1',
      maxPasses: 12,
      maxSegments: 34,
      scanFromTop: true
    }
  });

  assert.deepEqual(harness.getScanCall(), [
    'scan-1',
    { maxPasses: 12, maxSegments: 34, scanFromTop: true }
  ]);
  assert.deepEqual(response, { ok: true, data: harness.segments });
});

test('ContentRequestHandler normalizes fill options and starts at the marker', async () => {
  const harness = createHarness();
  const entry: TranslationEntry = {
    rowIndex: 2,
    sourceRaw: 'Source',
    sourceNormalized: 'Source',
    targetRaw: 'Target',
    occurrenceIndex: 1
  };

  const response = await harness.handler.handle({
    type: 'CONTENT_FILL',
    payload: {
      runId: 'fill-1',
      entries: [entry],
      fillOptions: {
        autoStopAfterFilledCount: 2.9,
        validatePlaceholders: false
      },
      plannedFillCount: 7,
      maxPasses: 56,
      maxSegments: 78,
      scanFromTop: true
    }
  });

  assert.deepEqual(harness.getFillCall(), [
    'fill-1',
    [entry],
    { autoStopAfterFilledCount: 2, validatePlaceholders: false },
    7,
    {
      maxPasses: 56,
      maxSegments: 78,
      scanFromTop: true,
      startFromMarker: true
    }
  ]);
  assert.deepEqual(response, { ok: true, data: harness.fillResult });
});

test('ContentRequestHandler routes stop without starting another run', async () => {
  const harness = createHarness();

  const response = await harness.handler.handle({ type: 'CONTENT_STOP' });

  assert.equal(harness.getStopCalls(), 1);
  assert.equal(harness.getScanCall(), undefined);
  assert.equal(harness.getFillCall(), undefined);
  assert.deepEqual(response, { ok: true, data: null });
});
