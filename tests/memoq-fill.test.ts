import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TARGET_NO_LONGER_EMPTY_REASON,
  runMemoqCursorFill
} from '../memoq-fill.ts';

interface FakeSegment {
  id: string;
}

interface FakePreviewItem {
  domId: string;
  occurrenceIndex: number;
  status: 'ready' | 'alreadyTranslated';
  translation: string | null;
}

function makeSegment(domId: string, sourceNormalized: string) {
  return {
    segment: { id: domId },
    domId,
    sourceRaw: sourceNormalized,
    sourceNormalized,
    targetRaw: '',
    isEmptyTarget: true,
    placeholderTokens: []
  };
}

test('runMemoqCursorFill assigns occurrences in cursor order across repeated sources', async () => {
  const segments = [
    makeSegment('row-1', 'Hello'),
    makeSegment('row-2', 'Hello'),
    makeSegment('row-3', 'World')
  ];
  let nextIndex = 1;

  const result = await runMemoqCursorFill<FakeSegment, FakePreviewItem>({
    initialSegment: segments[0],
    classify: (segment) => ({
      domId: segment.domId,
      occurrenceIndex: segment.occurrenceIndex,
      status: 'ready',
      translation: `T:${segment.sourceNormalized}:${segment.occurrenceIndex}`
    }),
    shouldFill: () => true,
    getTranslation: (item) => item.translation,
    advance: async () => {
      const nextSegment = segments[nextIndex] ?? null;
      nextIndex += 1;
      return {
        segment: nextSegment,
        reachedEnd: nextSegment === null
      };
    },
    fillSegment: async (segment) => ({
      domId: segment.domId,
      filled: true
    }),
    autoStopAfterFilledCount: null
  });

  assert.deepEqual(
    result.items.map((item) => [item.domId, item.occurrenceIndex]),
    [
      ['row-1', 1],
      ['row-2', 2],
      ['row-3', 1]
    ]
  );
  assert.deepEqual(result.filledDomIds, ['row-1', 'row-2', 'row-3']);
});

test('runMemoqCursorFill retries a failed row once and keeps moving forward', async () => {
  const segments = [
    makeSegment('row-1', 'Alpha'),
    makeSegment('row-2', 'Beta'),
    makeSegment('row-3', 'Gamma')
  ];
  let nextIndex = 1;
  const attempts: string[] = [];

  const result = await runMemoqCursorFill<FakeSegment, FakePreviewItem>({
    initialSegment: segments[0],
    classify: (segment) => ({
      domId: segment.domId,
      occurrenceIndex: segment.occurrenceIndex,
      status: 'ready',
      translation: `T:${segment.sourceNormalized}`
    }),
    shouldFill: () => true,
    getTranslation: (item) => item.translation,
    advance: async () => {
      const nextSegment = segments[nextIndex] ?? null;
      nextIndex += 1;
      return {
        segment: nextSegment,
        reachedEnd: nextSegment === null
      };
    },
    fillSegment: async (segment, _translation, attemptNumber) => {
      attempts.push(`${segment.domId}:${attemptNumber}`);
      if (segment.domId === 'row-2' && attemptNumber === 1) {
        return {
          domId: segment.domId,
          filled: false,
          reason: 'memoQ editor accepted the value, but the target cell did not commit the update.'
        };
      }

      return {
        domId: segment.domId,
        filled: true
      };
    },
    autoStopAfterFilledCount: null
  });

  assert.deepEqual(result.filledDomIds, ['row-1', 'row-2', 'row-3']);
  assert.equal(result.failures.length, 0);
  assert.deepEqual(attempts, ['row-1:1', 'row-2:1', 'row-2:2', 'row-3:1']);
});

test('runMemoqCursorFill records hard failures and skips rows that are no longer empty', async () => {
  const segments = [
    makeSegment('row-1', 'Alpha'),
    makeSegment('row-2', 'Beta'),
    makeSegment('row-3', 'Gamma'),
    makeSegment('row-4', 'Delta')
  ];
  let nextIndex = 1;
  const attempts: string[] = [];

  const result = await runMemoqCursorFill<FakeSegment, FakePreviewItem>({
    initialSegment: segments[0],
    classify: (segment) => ({
      domId: segment.domId,
      occurrenceIndex: segment.occurrenceIndex,
      status: 'ready',
      translation: `T:${segment.sourceNormalized}`
    }),
    shouldFill: () => true,
    getTranslation: (item) => item.translation,
    advance: async () => {
      const nextSegment = segments[nextIndex] ?? null;
      nextIndex += 1;
      return {
        segment: nextSegment,
        reachedEnd: nextSegment === null
      };
    },
    fillSegment: async (segment, _translation, attemptNumber) => {
      attempts.push(`${segment.domId}:${attemptNumber}`);
      if (segment.domId === 'row-2') {
        return {
          domId: segment.domId,
          filled: false,
          reason: 'memoQ editor did not reflect the requested value.'
        };
      }

      if (segment.domId === 'row-3') {
        return {
          domId: segment.domId,
          filled: false,
          reason: TARGET_NO_LONGER_EMPTY_REASON
        };
      }

      return {
        domId: segment.domId,
        filled: true
      };
    },
    autoStopAfterFilledCount: null
  });

  assert.deepEqual(result.filledDomIds, ['row-1', 'row-4']);
  assert.deepEqual(result.failures, [
    {
      domId: 'row-2',
      sourceRaw: 'Beta',
      reason: 'memoQ editor did not reflect the requested value.'
    }
  ]);
  assert.deepEqual(attempts, [
    'row-1:1',
    'row-2:1',
    'row-2:2',
    'row-3:1',
    'row-4:1'
  ]);
});
