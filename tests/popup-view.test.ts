import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePopupFillOptions } from '../popup/view.ts';

test('parsePopupFillOptions disables validation and preserves integer rules', () => {
  assert.deepEqual(parsePopupFillOptions(''), {
    autoStopAfterFilledCount: null,
    validatePlaceholders: false,
    enableMemoqMarkerFill: false
  });
  assert.deepEqual(parsePopupFillOptions(' 12.9 ', true), {
    autoStopAfterFilledCount: 12,
    validatePlaceholders: false,
    enableMemoqMarkerFill: true
  });

  let parseError: unknown;
  try {
    parsePopupFillOptions('0');
  } catch (error) {
    parseError = error;
  }
  assert.equal(
    parseError instanceof Error ? parseError.message : null,
    'Auto stop count must be a positive number.'
  );
});
