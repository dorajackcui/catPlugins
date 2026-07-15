import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeSegment } from '../content/dom.ts';
import { validateMemoqFillTarget } from '../platforms/memoq/fill-validation.ts';

function createSegment(): RuntimeSegment {
  return {
    domId: '42',
    rowNumber: '42',
    sourceRaw: 'Source text',
    sourceNormalized: 'Source text',
    occurrenceIndex: 0,
    targetRaw: '',
    isEmptyTarget: true,
    placeholderTokens: [],
    targetElement: {} as HTMLElement,
    platform: 'memoq'
  };
}

test('validateMemoqFillTarget accepts normalized source text and an empty target', () => {
  const target = {} as HTMLElement;

  assert.deepEqual(
    validateMemoqFillTarget(createSegment(), target, {
      readSourceText: () => '  Source   text  ',
      readTargetText: (currentTarget) => {
        assert.equal(currentTarget, target);
        return ' \n ';
      }
    }),
    {
      ok: true,
      sourceBefore: '  Source   text  ',
      targetBefore: ' \n '
    }
  );
});

test('validateMemoqFillTarget reports a missing row while retaining target context', () => {
  assert.deepEqual(
    validateMemoqFillTarget(createSegment(), {} as HTMLElement, {
      readSourceText: () => null,
      readTargetText: () => 'Recycled target'
    }),
    {
      ok: false,
      failureCode: 'ROW_NOT_FOUND',
      sourceBefore: '',
      targetBefore: 'Recycled target'
    }
  );
});

test('validateMemoqFillTarget checks source mismatch before target occupancy', () => {
  assert.deepEqual(
    validateMemoqFillTarget(createSegment(), {} as HTMLElement, {
      readSourceText: () => 'Changed source',
      readTargetText: () => 'Existing target'
    }),
    {
      ok: false,
      failureCode: 'SOURCE_MISMATCH',
      sourceBefore: 'Changed source',
      targetBefore: 'Existing target'
    }
  );
});

test('validateMemoqFillTarget rejects a non-empty target after source validation', () => {
  assert.deepEqual(
    validateMemoqFillTarget(createSegment(), {} as HTMLElement, {
      readSourceText: () => 'Source text',
      readTargetText: () => 'Existing target'
    }),
    {
      ok: false,
      failureCode: 'TARGET_NOT_EMPTY',
      sourceBefore: 'Source text',
      targetBefore: 'Existing target'
    }
  );
});
