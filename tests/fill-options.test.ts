import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeFillOptions } from '../domain/fill-options.ts';

test('normalizeFillOptions defaults to placeholder validation enabled', () => {
  assert.deepEqual(normalizeFillOptions(undefined), {
    autoStopAfterFilledCount: null,
    validatePlaceholders: true,
    enableMemoqMarkerFill: false
  });
});

test('normalizeFillOptions preserves disabled placeholder validation', () => {
  assert.deepEqual(
    normalizeFillOptions({
      autoStopAfterFilledCount: 3,
      validatePlaceholders: false
    }),
    {
      autoStopAfterFilledCount: 3,
      validatePlaceholders: false,
      enableMemoqMarkerFill: false
    }
  );
});

test('normalizeFillOptions preserves explicitly enabled memoQ marker fill', () => {
  assert.deepEqual(
    normalizeFillOptions({
      autoStopAfterFilledCount: null,
      validatePlaceholders: true,
      enableMemoqMarkerFill: true
    }),
    {
      autoStopAfterFilledCount: null,
      validatePlaceholders: true,
      enableMemoqMarkerFill: true
    }
  );
});
