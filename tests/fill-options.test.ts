import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeFillOptions } from '../fill-options.ts';

test('normalizeFillOptions defaults to placeholder validation enabled', () => {
  assert.deepEqual(normalizeFillOptions(undefined), {
    autoStopAfterFilledCount: null,
    validatePlaceholders: true
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
