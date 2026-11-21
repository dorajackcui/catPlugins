import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeFillOptions } from '../domain/fill-options.ts';

test('normalizeFillOptions defaults to placeholder validation disabled', () => {
  assert.deepEqual(normalizeFillOptions(undefined), {
    autoStopAfterFilledCount: null,
    validatePlaceholders: false
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
      validatePlaceholders: false
    }
  );
});

test('legacy memoQ settings preserve the stop count and use automatic tag handling', () => {
  for (const oldSwitch of [true, false]) {
    const stored = { autoStopAfterFilledCount: 12, validatePlaceholders: true, enableMemoqMarkerFill: oldSwitch };
    assert.deepEqual(normalizeFillOptions(stored), { autoStopAfterFilledCount: 12, validatePlaceholders: true });
  }
});
